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
PDF = "application/pdf"
RECIPE_DOCS = (GDOC, DOCX, PDF)
SHORTCUT = "application/vnd.google-apps.shortcut"
VERSION = "r5"  # bump to make every folder re-read

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
        if f["mimeType"] == PDF:
            from pypdf import PdfReader

            raw = drive.api.files().get_media(fileId=f["id"], supportsAllDrives=True).execute(num_retries=3)
            return "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(raw)).pages[:6])
        if f["mimeType"] == DOCX:
            raw = drive.api.files().get_media(fileId=f["id"], supportsAllDrives=True).execute(num_retries=3)
            xml = zipfile.ZipFile(io.BytesIO(raw)).read("word/document.xml").decode("utf-8", "ignore")
            xml = re.sub(r"</w:p>", "\n", xml)
            return re.sub(r"<[^>]+>", "", xml)
    except Exception as e:
        return f"(couldn't read document: {type(e).__name__})"
    return ""


# Sub-folders with names like these only split up one recipe's files.
PART_NAME = re.compile(
    r"^(recipe )?(photos?|pics?|pictures?|images?|imgs?|reels?|videos?|vids?|clips?|footage|raw|edited|edits?|finals?|stills?|"
    r"b ?roll|stor(y|ies)|thumbnails?|cards?|recipe cards?|assets|graphics?|social|ig|instagram|tiktok|exports?|selects?|"
    r"drafts?|originals?|hi ?res|low ?res|web|print|jpe?gs?|pngs?|mp4s?|movs?|horizontal|vertical|square|portrait|landscape|"
    r"\d+x\d+|\d+ ?[x:] ?\d+)$"
)


def _part_name(name: str) -> bool:
    n = re.sub(r"[^a-z0-9: ]+", " ", name.lower())
    n = re.sub(r"\b(v\d+|\d{1,2})\b", " ", n)  # "Photos 2", "Reel v1"
    return bool(PART_NAME.match(re.sub(r"\s+", " ", n).strip()))


def _classify(folders: list[dict]) -> None:
    """Decide recipe / group / part from the folder structure (deepest folders first).

    - A recipe doc (Google Doc or Word file) marks a recipe. Sub-folders under it that have no recipe doc
      of their own (e.g. "Photos", "Reel", "Recipe Card") are its parts.
    - A folder whose sub-folders hold recipes with docs is a group (collection or creator), even if it has a doc of its own.
    - No doc anywhere: two or more dish folders inside make a group; otherwise it's a recipe (photos/videos only),
      unless its own name says it's just "Photos", "Reel" and so on.
    """
    by_id = {f["id"]: f for f in folders}
    for f in folders:
        f["is_part_name"] = _part_name(f["path"].rsplit("/", 1)[-1])
        # A recipe doc is a Google Doc, Word file or PDF, unless it sits in a "Recipe Card"/"Photos"-style sub-folder.
        f["doc_here"] = not f["is_part_name"] and any(k["mimeType"] in RECIPE_DOCS for k in f["files"])
        f["media_here"] = sum(k["mimeType"].startswith(("image/", "video/")) for k in f["files"])
    for f in sorted(folders, key=lambda x: -x["depth"]):
        kids = [by_id[s["id"]] for s in f["subs"] if s["id"] in by_id]
        f["media_tree"] = f["media_here"] + sum(k["media_tree"] for k in kids)
        # Children that are recipes or groups in their own right (not just "Photos"-style parts).
        content_kids = [k for k in kids if k["kind"] in ("recipe", "group")]
        doc_kids = [k for k in content_kids if k["doc_tree"]]
        f["doc_tree"] = f["doc_here"] or bool(doc_kids)
        if doc_kids:
            f["kind"] = "group"            # holds other recipes (with their own docs)
        elif f["doc_here"]:
            f["kind"] = "recipe"           # its own doc; sub-folders are just its files
        elif len(content_kids) >= 2:
            f["kind"] = "group"            # e.g. "Recipe Images" with a folder per dish
        elif content_kids:
            f["kind"] = "recipe"           # one dish folder inside: treat as the same recipe
        elif f["media_tree"]:
            f["kind"] = "part" if f["is_part_name"] and f["depth"] > 1 else "recipe"
        else:
            f["kind"] = "part"  # empty
        if f["kind"] == "recipe":
            for k in kids:
                _mark_parts(k, by_id)
        elif f["kind"] == "group":
            # Inside a group every folder with content is a recipe, even one named "Photos" or "Recipe Videos".
            for k in kids:
                if k["kind"] == "part" and k["media_tree"]:
                    k["kind"] = "recipe"
                    for s in k["subs"]:
                        if s["id"] in by_id:
                            _mark_parts(by_id[s["id"]], by_id)


def _mark_parts(f: dict, by_id: dict) -> None:
    f["kind"] = "part"
    for s in f["subs"]:
        if s["id"] in by_id:
            _mark_parts(by_id[s["id"]], by_id)


def _children(drive, folder_id: str) -> list[dict]:
    out, token = [], None
    while True:
        r = drive.api.files().list(
            q=f"'{folder_id}' in parents and trashed = false",
            fields="nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, webViewLink)",
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
    folders, stack = [], [(ROOT_ID, root_path, None, 0, None)]
    while stack:
        fid, path, parent, depth, created = stack.pop()
        kids = _children(drive, fid)
        subs = [k for k in kids if k["mimeType"] == FOLDER]
        files = [k for k in kids if k["mimeType"] != FOLDER and not k["name"].startswith(".")]
        folders.append({"id": fid, "path": path, "parent": parent, "depth": depth, "subs": subs, "files": files, "created": created})
        for s in subs:
            stack.append((s["id"], f"{path}/{s['name']}", fid, depth + 1, s.get("createdTime")))
    print(f"Found {len(folders) - 1} folders.", flush=True)
    _classify(folders)

    client = anthropic.Anthropic(api_key=env("ANTHROPIC_API_KEY"), max_retries=4)
    prompt = _prompt(flavours)
    tokens = [0, 0]

    def sig_of(f) -> str:
        bits = [VERSION, f["path"], f["kind"]] + sorted(f"{k['name']}|{k.get('modifiedTime', '')}" for k in f["files"]) + sorted(s["name"] for s in f["subs"])
        return hashlib.sha1("\n".join(bits).encode()).hexdigest()

    def one(f):
        sig = sig_of(f)
        if known.get(f["id"]) == sig:
            return None
        docs = sorted([k for k in f["files"] if k["mimeType"] in RECIPE_DOCS], key=lambda k: RECIPE_DOCS.index(k["mimeType"]))
        media = [k for k in f["files"] if k["mimeType"].startswith(("image/", "video/"))]
        # Every other file (Docs, PDFs, Word, Sheets, Slides, anything) is listed on the recipe.
        others = [{"id": k["id"], "name": k["name"], "mime": k["mimeType"], "url": k.get("webViewLink")}
                  for k in f["files"] if not k["mimeType"].startswith(("image/", "video/")) and k["mimeType"] != SHORTCUT]
        row = {
            "id": f["id"], "parent_id": f["parent"], "depth": f["depth"], "name": f["path"].rsplit("/", 1)[-1],
            "folder_path": f["path"], "sig": sig, "doc_id": docs[0]["id"] if docs else None,
            "doc_url": docs[0].get("webViewLink") if docs else None, "media_here": len(media),
            "drive_created_at": f["created"], "files": others,
        }
        if f["depth"] == 0:
            row.update(kind="collection", title="Loose files", name="Loose files")
            return row
        if f["kind"] == "part":  # a sub-folder like "Photos" or "Reel": no AI needed
            row.update(kind="part", title=row["name"])
            return row
        text = "\n\n".join(_doc_text(drive, d)[:6000] for d in docs[:2])
        listing = "\n".join(f"- {k['name']}" for k in f["files"][:60])
        subs = ", ".join(s["name"] for s in f["subs"][:40]) or "(none)"
        decided = ("This folder is ONE RECIPE (its sub-folders just hold its photos, videos and cards). Use kind \"recipe\"."
                   if f["kind"] == "recipe" else
                   "This folder GROUPS several recipes. Use kind \"creator\" if it's a person, influencer or partner, otherwise \"collection\".")
        msg = (f"{decided}\n\nFolder path: {f['path']}\nSub-folders: {subs}\nFiles ({len(f['files'])}):\n{listing or '(none)'}\n\n"
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
            row.update(kind=f["kind"], title=row["name"], sig=None)
            return row
        lst = lambda k: [str(x).strip() for x in (out.get(k) or []) if str(x).strip()][:12]
        # The folder structure decides recipe vs group; the AI only picks creator vs collection for groups.
        kind = "recipe" if f["kind"] == "recipe" else ("creator" if out.get("kind") == "creator" else "collection")
        row.update(
            kind=kind, title=(out.get("title") or row["name"]).strip(),
            creator=(out.get("creator") or "").strip() or None, summary=(out.get("summary") or "").strip() or None,
            flavours=lst("flavours"), proteins=lst("proteins"), meal=lst("meal"), diet=lst("diet"),
            ingredients=lst("ingredients"), method=lst("method"), season=lst("season"),
            prep_minutes=int(out.get("prep_minutes") or 0) or None, servings=(out.get("servings") or "").strip() or None,
        )
        return row

    with ThreadPoolExecutor(max_workers=6) as pool:
        rows = [r for r in pool.map(one, folders) if r]
    # Every row needs the same keys for a bulk upsert.
    blank = {"kind": None, "title": None, "creator": None, "summary": None, "prep_minutes": None, "servings": None,
             **{k: [] for k in ("flavours", "proteins", "meal", "diet", "ingredients", "method", "season")}}
    rows = [{**blank, **r} for r in rows]
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
