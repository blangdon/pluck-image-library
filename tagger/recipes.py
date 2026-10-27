"""Index the "Recipes/Use Cases" folder as recipes, creators and collections for the /recipes explorer.

    python -m tagger.recipes

Every folder under the root becomes one row in the `recipe_sets` table. The AI (cheap model) reads the
folder's name, its recipe document (Google Doc or .docx) and the names of the files in it, and decides:
- kind: recipe / creator / collection / part (a sub-folder such as "raw" or "edited" that belongs to its parent)
- for recipes: title, creator, Pluck flavours, proteins, meal types, diet, key ingredients, times, a one-line summary.
Photos and videos come from the main library (they're already indexed): the page matches them by folder path.
Folders are only re-read when their name, documents or files change.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic
import yaml

HERE = Path(__file__).parent
ROOT_ID = os.environ.get("RECIPES_FOLDER_ID") or "1IezCt0uQ_urE5kP02N5BbKGaweuE8eDt"
MODEL = os.environ.get("RECIPES_MODEL") or "claude-haiku-5-5"
FOLDER = "application/vnd.google-apps.folder"
GDOC = "application/vnd.google-apps.document"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
VERSION = "r1"  # bump to make every folder re-read

TOOL = {
    "name": "record_folder",
    "description": "Record what this folder is and, for recipes, the recipe details.",
    "input_schema": {
        "type": "object",
        "properties": {
            "kind": {"type": "string", "enum": ["recipe", "creator", "collection", "part"]},
            "title": {"type": "string", "description": "Clean display title (recipe name, creator name or collection name)."},
            "creator": {"type": "string", "description": "Who made the recipe or content (person or brand), if known. Empty if unknown."},
            "summary": {"type": "string", "description": "One short sentence a marketer would find useful."},
            "flavours": {"type": "array", "items": {"type": "string"}, "description": "Pluck flavours used."},
            "proteins": {"type": "array", "items": {"type": "string"}, "description": "Main proteins, e.g. beef, chicken, organ meat, eggs, fish, pork, turkey, lamb, none."},
            "meal": {"type": "array", "items": {"type": "string"}, "description": "breakfast, lunch, dinner, snack, side, dip/sauce, dessert, drink, kids."},
            "diet": {"type": "array", "items": {"type": "string"}, "description": "e.g. carnivore, keto, paleo, gluten-free, grain-free, dairy-free, vegetarian."},
            "ingredients": {"type": "array", "items": {"type": "string"}, "description": "Up to 8 key ingredients, short names."},
            "method": {"type": "array", "items": {"type": "string"}, "description": "Cooking method or gear, e.g. slow cooker, Instant Pot, grill, oven, no-cook."},
            "season": {"type": "array", "items": {"type": "string"}, "description": "Season or occasion if obvious: summer, fall, holiday, Thanksgiving, game day, school lunch."},
            "prep_minutes": {"type": "integer", "description": "Total time in minutes if stated, else 0."},
            "servings": {"type": "string"},
        },
        "required": ["kind", "title"],
    },
}


def _prompt(flavours: list[str]) -> str:
    return f"""You're organising a food brand's content folder (Pluck, a superfood seasoning) so the marketing team
can find recipes and content for ads and social posts.

You'll get one Drive folder: its path, its sub-folders, file names and (if any) the text of the recipe document in it.
Decide what the folder is:
- "recipe": one dish or use case (usually has a recipe doc and/or photos/videos of one dish).
- "creator": a person, influencer or partner whose content is grouped inside (often a name or @handle).
- "collection": a group of several recipes or assets (e.g. "Recipe Cards", "School Lunches", a guide or contest).
- "part": a sub-folder that only splits up its parent's files (e.g. "raw", "edited", "photos", "final", "stills").

For recipes, fill in every field you can from the document, the folder name and file names. "ENK" in a name
is a content partner tag; don't put it in the title. Pluck flavours are: {", ".join(flavours)}.
Older names: "Spicy Mild" and "Spicy" are older flavours; keep them as written. "Pure" means "Pure Organs".
Use lowercase for proteins, meal, diet, method and season. Answer by calling record_folder."""


def _doc_text(drive, f: dict) -> str:
    try:
        if f["mimeType"] == GDOC:
            data = drive.api.files().export(fileId=f["id"], mimeType="text/plain").execute(num_retries=3)
            return data.decode("utf-8", "ignore") if isinstance(data, bytes) else str(data)
        if f["mimeType"] == DOCX:
            raw = drive.api.files().get_media(fileId=f["id"], supportsAllDrives=True).execute(num_retries=3)
            xml = zipfile.ZipFile(io.BytesIO(raw)).read("word/document.xml").decode("utf-8", "ignore")
            xml = re.sub(r"</w:p>", "\n", xml)
            return re.sub(r"<[^>]+>", "", xml)
    except Exception as e:
        return f"(couldn't read document: {type(e).__name__})"
    return ""


def _children(drive, folder_id: str) -> list[dict]:
    out, token = [], None
    while True:
        r = drive.api.files().list(
            q=f"'{folder_id}' in parents and trashed = false",
            fields="nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink)",
            pageSize=1000, pageToken=token, supportsAllDrives=True, includeItemsFromAllDrives=True,
        ).execute(num_retries=5)
        out += r.get("files", [])
        token = r.get("nextPageToken")
        if not token:
            return out


def _path_of(drive, folder_id: str) -> str:
    """Same path format as the main library's folder_path: '<Shared Drive name>/a/b/c'."""
    parts = []
    fid = folder_id
    while True:
        if fid.startswith("0A"):  # the Shared Drive itself
            parts.append(drive.folder_name(fid))
            break
        meta = drive.api.files().get(fileId=fid, fields="id, name, parents", supportsAllDrives=True).execute(num_retries=5)
        parts.append(meta["name"])
        parents = meta.get("parents") or []
        if not parents:
            break
        fid = parents[0]
    return "/".join(reversed(parts))


def main() -> None:
    from .__main__ import env
    from .drive import Drive
    from .store import Store

    config = yaml.safe_load((HERE / "config.yaml").read_text())
    flavours = list(config.get("flavours") or [])
    drive = Drive(env("GOOGLE_SERVICE_ACCOUNT_JSON"))
    store = Store(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"))

    r = store.s.get(f"{store.url}/rest/v1/recipe_sets", params={"select": "id,sig", "limit": 5000}, timeout=60)
    if r.status_code >= 400:
        print("::error title=Recipes table missing::Run supabase/recipes.sql in the Supabase SQL Editor first.")
        raise SystemExit(1)
    known = {row["id"]: row["sig"] for row in r.json()}

    root_path = _path_of(drive, ROOT_ID)
    print(f"Reading {root_path}…", flush=True)

    # Walk the tree: one entry per folder (the root's loose files become a "Loose files" collection).
    folders, stack = [], [(ROOT_ID, root_path, None, 0)]
    while stack:
        fid, path, parent, depth = stack.pop()
        kids = _children(drive, fid)
        subs = [k for k in kids if k["mimeType"] == FOLDER]
        files = [k for k in kids if k["mimeType"] != FOLDER and not k["name"].startswith(".")]
        folders.append({"id": fid, "path": path, "parent": parent, "depth": depth, "subs": subs, "files": files})
        for s in subs:
            stack.append((s["id"], f"{path}/{s['name']}", fid, depth + 1))
    print(f"Found {len(folders) - 1} folders.", flush=True)

    client = anthropic.Anthropic(api_key=env("ANTHROPIC_API_KEY"), max_retries=4)
    prompt = _prompt(flavours)
    tokens = [0, 0]

    def sig_of(f) -> str:
        bits = [VERSION, f["path"]] + sorted(f"{k['name']}|{k.get('modifiedTime', '')}" for k in f["files"]) + sorted(s["name"] for s in f["subs"])
        return hashlib.sha1("\n".join(bits).encode()).hexdigest()

    def one(f):
        sig = sig_of(f)
        if known.get(f["id"]) == sig:
            return None
        docs = [k for k in f["files"] if k["mimeType"] in (GDOC, DOCX)]
        media = [k for k in f["files"] if k["mimeType"].startswith(("image/", "video/"))]
        row = {
            "id": f["id"], "parent_id": f["parent"], "depth": f["depth"], "name": f["path"].rsplit("/", 1)[-1],
            "folder_path": f["path"], "sig": sig, "doc_id": docs[0]["id"] if docs else None,
            "doc_url": docs[0].get("webViewLink") if docs else None, "media_here": len(media),
        }
        if f["depth"] == 0:
            row.update(kind="collection", title="Loose files", name="Loose files")
            return row
        text = "\n\n".join(_doc_text(drive, d)[:6000] for d in docs[:2])
        listing = "\n".join(f"- {k['name']}" for k in f["files"][:60])
        subs = ", ".join(s["name"] for s in f["subs"][:40]) or "(none)"
        msg = (f"Folder path: {f['path']}\nSub-folders: {subs}\nFiles ({len(f['files'])}):\n{listing or '(none)'}\n\n"
               f"Recipe document text:\n{text or '(no document)'}")
        try:
            res = client.messages.create(
                model=MODEL, max_tokens=900, tools=[TOOL], tool_choice={"type": "auto"},
                system=prompt, messages=[{"role": "user", "content": msg}],
            )
            tokens[0] += res.usage.input_tokens
            tokens[1] += res.usage.output_tokens
            out = next((b.input for b in res.content if b.type == "tool_use"), None)
            if out is None:
                t = "".join(getattr(b, "text", "") for b in res.content)
                out = json.loads(t[t.find("{"): t.rfind("}") + 1])
        except Exception as e:
            print(f"  failed {f['path']}: {e}", flush=True)
            row.update(kind="collection", title=row["name"], sig=None)
            return row
        lst = lambda k: [str(x).strip() for x in (out.get(k) or []) if str(x).strip()][:12]
        row.update(
            kind=out.get("kind") or "collection", title=(out.get("title") or row["name"]).strip(),
            creator=(out.get("creator") or "").strip() or None, summary=(out.get("summary") or "").strip() or None,
            flavours=lst("flavours"), proteins=lst("proteins"), meal=lst("meal"), diet=lst("diet"),
            ingredients=lst("ingredients"), method=lst("method"), season=lst("season"),
            prep_minutes=int(out.get("prep_minutes") or 0) or None, servings=(out.get("servings") or "").strip() or None,
        )
        return row

    with ThreadPoolExecutor(max_workers=6) as pool:
        rows = [r for r in pool.map(one, folders) if r]
    for i in range(0, len(rows), 200):
        store._check(store.s.post(
            f"{store.url}/rest/v1/recipe_sets", params={"on_conflict": "id"}, json=rows[i: i + 200],
            headers={"Prefer": "resolution=merge-duplicates,return=minimal"}, timeout=120,
        ))
    gone = [fid for fid in known if fid not in {f["id"] for f in folders}]
    for fid in gone:
        store._check(store.s.delete(f"{store.url}/rest/v1/recipe_sets", params={"id": f"eq.{fid}"}, timeout=60))
    from collections import Counter

    kinds = Counter(r["kind"] for r in rows)
    cost = (tokens[0] * 0.10 + tokens[1] * 0.50) / 1e6
    print(f"::notice title=Recipes indexed::{len(rows)} folders read ({dict(kinds)}), {len(gone)} removed, "
          f"{len(folders) - len(rows)} unchanged. AI cost ${cost:.2f}.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        import traceback

        tb = traceback.format_exc().strip().splitlines()
        print("::error title=Recipe reader failed::" + "%0A".join([f"{type(e).__name__}: {e}"] + tb[-6:]), flush=True)
        raise SystemExit(1)
