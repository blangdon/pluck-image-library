"""Sort videos by their poster frame: is a person the focus, or is it a POV food/cooking shot?

    python -m tagger.video_categories

Runs once per video (cheap model, one small image each). The answer is stored as a tag:
"focus: person", "focus: pov food" or "focus: other". Whether the person is James comes from
face search (tagger/faces.py), not from this step. The gallery combines the two into the
James / UGC / Cooking / Other groups.
"""
from __future__ import annotations

import base64
import json
import os
from concurrent.futures import ThreadPoolExecutor

import anthropic

FOCUS_TAGS = {"person": "focus: person", "pov_food": "focus: pov food", "other": "focus: other"}
MODEL = os.environ.get("VIDEO_CATEGORY_MODEL") or "claude-haiku-5-5"

PROMPT = """This is the first frame (poster) of a short video from a food brand's content library.
Choose its main focus:
- "person": a person is the main subject, e.g. talking to camera, interview, presenter, someone eating or holding a product on camera.
- "pov_food": a point-of-view shot of food or cooking, e.g. hands, a pan, a plate, a chopping board or ingredients, with no person as the focus.
- "other": anything else (graphics, title cards, landscapes, products alone, crowds, black frames).
Answer by calling the record_focus tool."""

TOOL = {
    "name": "record_focus",
    "description": "Record the main focus of the video frame.",
    "input_schema": {
        "type": "object",
        "properties": {"focus": {"type": "string", "enum": list(FOCUS_TAGS)}},
        "required": ["focus"],
    },
}


def classify(client, jpeg: bytes) -> str:
    msg = client.messages.create(
        model=MODEL,
        max_tokens=100,
        tools=[TOOL],
        tool_choice={"type": "auto"},
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(jpeg).decode()}},
            {"type": "text", "text": PROMPT},
        ]}],
    )
    for b in msg.content:
        if b.type == "tool_use" and b.input.get("focus") in FOCUS_TAGS:
            return b.input["focus"]
    text = "".join(getattr(b, "text", "") for b in msg.content)
    for key in FOCUS_TAGS:
        if key in text:
            return key
    try:
        return json.loads(text[text.find("{"): text.rfind("}") + 1]).get("focus", "other")
    except Exception:
        return "other"


def main() -> None:
    from .__main__ import env
    from .store import BUCKET, Store

    store = Store(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"))
    r = store._check(store.s.get(
        f"{store.url}/rest/v1/images",
        params={"select": "id,name,thumb_path,tags", "mime_type": "like.video/*", "removed": "eq.false",
                "thumb_path": "not.is.null", "limit": 5000},
        timeout=60,
    ))
    todo = [v for v in r.json() if not set(v.get("tags") or []) & set(FOCUS_TAGS.values())]
    print(f"Sorting {len(todo)} videos by their poster frame ({MODEL})…", flush=True)
    if not todo:
        return
    client = anthropic.Anthropic(api_key=env("ANTHROPIC_API_KEY"), max_retries=4)

    def one(v):
        try:
            thumb = store._check(store.s.get(f"{store.url}/storage/v1/object/{BUCKET}/{v['thumb_path']}", timeout=60)).content
            focus = classify(client, thumb)
            tags = [t for t in (v.get("tags") or []) if t not in FOCUS_TAGS.values()] + [FOCUS_TAGS[focus]]
            store.update(v["id"], {"tags": tags})
            return focus
        except Exception as e:
            print(f"  failed {v['name']}: {e}", flush=True)
            return "failed"

    from collections import Counter

    with ThreadPoolExecutor(max_workers=6) as pool:
        counts = Counter(pool.map(one, todo))
    print(f"::notice title=Videos sorted::{dict(counts)}", flush=True)


if __name__ == "__main__":
    main()
