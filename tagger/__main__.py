"""Pluck Image Library tagger.

    python -m tagger --count     # how many images there are and how many need tagging (no AI calls)
    python -m tagger --compare 50  # Sonnet vs Haiku on 50 random images (no gallery changes)
    python -m tagger             # index Drive, tag new/changed images, upload thumbnails

Settings come from environment variables (GitHub Actions secrets):
    GOOGLE_SERVICE_ACCOUNT_JSON   contents of the service account key file
    DRIVE_FOLDER_IDS              comma-separated folder or Shared Drive ids to cover
    SUPABASE_URL                  e.g. https://abcd.supabase.co
    SUPABASE_SERVICE_ROLE_KEY     Supabase "service_role" secret key
    ANTHROPIC_API_KEY             Anthropic Console API key
    TAG_MODEL                     optional, default claude-sonnet-5-5
    MAX_IMAGES_PER_RUN            optional, default 400 (caps time and cost per run)
    RETAG_ALL                     optional, "true" re-tags every image (after changing config.yaml)
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import yaml

from .drive import MAX_DOWNLOAD_BYTES, Drive, DriveImage
from .images import open_rgb, to_jpeg
from .store import Store

THUMB_EDGE, THUMB_QUALITY = 800, 80  # what the gallery shows
TAG_EDGE, TAG_QUALITY = 1280, 85  # what the model sees
MAX_ATTEMPTS = 3


def env(name: str, default: str | None = None) -> str:
    value = (os.environ.get(name) or default or "").strip()  # pasted secrets often carry a stray newline
    if not value:
        print(f"::error title=Missing setting::{name}. Add it as a GitHub Actions secret (see README).")
        sys.exit(1)
    return value


def needs_tagging(img: DriveImage, row: dict | None, retag_all: bool, version: int = 1) -> bool:
    if row is None:
        return True  # never seen before
    if retag_all or (img.md5 and row.get("md5") and img.md5 != row["md5"]):
        return True  # asked to re-tag, or the file's content changed
    if row.get("tagged_at") and not str(row.get("tag_model") or "").endswith(f"|v{version}"):
        return True  # tagged under older rules (config.yaml version changed)
    if row.get("tagged_at") is None:
        return (row.get("tag_attempts") or 0) < MAX_ATTEMPTS  # earlier attempts failed
    return False


def fetch_pixels(drive: Drive, img: DriveImage):
    if img.size and img.size > MAX_DOWNLOAD_BYTES:
        return open_rgb(drive.preview(img))
    try:
        return open_rgb(drive.download(img))
    except Exception:
        return open_rgb(drive.preview(img))  # RAW, PSD, SVG and other formats Pillow can't read


def process(img: DriveImage, drive: Drive, store: Store, tagger, model: str, attempts: int, version: int) -> str:
    try:
        pixels = fetch_pixels(drive, img)
        thumb_path = f"{img.id}-{(img.md5 or 'x')[:8]}.jpg"
        store.upload_thumb(thumb_path, to_jpeg(pixels, THUMB_EDGE, THUMB_QUALITY))
        result = tagger.tag(to_jpeg(pixels, TAG_EDGE, TAG_QUALITY))
        store.update(
            img.id,
            {
                **result,
                "thumb_path": thumb_path,
                "width": img.width or pixels.width,
                "height": img.height or pixels.height,
                "tagged_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "tag_model": f"{model}|v{version}",
                "tag_error": None,
                "tag_attempts": 0,
            },
        )
        return f"tagged  {img.folder_path}/{img.name}: {', '.join(result['tags']) or '(no tags)'}"
    except Exception as e:  # keep going; record the problem on the row
        store.update(img.id, {"tag_error": str(e)[:500], "tag_attempts": attempts + 1, "tagged_at": None})
        return f"FAILED  {img.folder_path}/{img.name}: {e}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", action="store_true", help="count images only; no tagging or uploads")
    ap.add_argument("--compare", type=int, metavar="N", help="tag N random images with Sonnet and Haiku and compare")
    args = ap.parse_args()

    drive = Drive(env("GOOGLE_SERVICE_ACCOUNT_JSON"))
    folder_ids = [f.strip() for f in env("DRIVE_FOLDER_IDS").split(",") if f.strip()]
    retag_all = os.environ.get("RETAG_ALL", "").lower() == "true"

    run_started = dt.datetime.now(dt.timezone.utc).isoformat()
    print(f"Reading Drive folders: {', '.join(drive.folder_name(f) for f in folder_ids)}")
    images = list(drive.walk_images(folder_ids))
    if args.count:  # Drive only: works before Supabase is set up
        total_mb = sum(i.size for i in images) / 1e6
        folders = len({i.folder_path for i in images})
        print(f"Found {len(images)} images ({total_mb:,.0f} MB) across {folders} folders.")
        return
    if args.compare:
        from .compare import run as compare

        compare(drive, images, args.compare, env("ANTHROPIC_API_KEY"), fetch_pixels)
        return

    store = Store(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"))
    known = store.existing()
    version = int(yaml.safe_load((Path(__file__).parent / "config.yaml").read_text()).get("version") or 1)
    todo = [img for img in images if needs_tagging(img, known.get(img.id), retag_all, version)]
    total_mb = sum(i.size for i in images) / 1e6
    print(f"Found {len(images)} images ({total_mb:,.0f} MB). New or changed, needing tags: {len(todo)}.")

    # 1. Record every image's Drive details (cheap, no AI).
    store.upsert(
        [
            {
                "id": i.id,
                "name": i.name,
                "folder_path": i.folder_path,
                "mime_type": i.mime_type,
                "drive_url": i.url,
                "md5": i.md5,
                "drive_created_at": i.created,
                "drive_modified_at": i.modified,
                "added_by": i.added_by,
                "last_seen_at": run_started,
                "removed": False,
            }
            for i in images
        ]
    )
    store.mark_removed_before(run_started)

    # 2. Tag new and changed images, newest first, up to the per-run cap.
    from .tagging import Tagger

    model = os.environ.get("TAG_MODEL") or "claude-sonnet-5-5"
    cap = int(os.environ.get("MAX_IMAGES_PER_RUN") or 400)
    todo.sort(key=lambda i: i.created or "", reverse=True)
    batch = todo[:cap]
    if not batch:
        print("Nothing new to tag.")
        return

    config = yaml.safe_load((Path(__file__).parent / "config.yaml").read_text())
    tagger = Tagger(env("ANTHROPIC_API_KEY"), model, config)
    started, failures = time.time(), 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [
            pool.submit(
                process, img, drive, store, tagger, model, (known.get(img.id) or {}).get("tag_attempts") or 0, version
            )
            for img in batch
        ]
        for n, fut in enumerate(as_completed(futures), 1):
            line = fut.result()
            failures += line.startswith("FAILED")
            print(f"[{n}/{len(batch)}] {line}", flush=True)

    left = len(todo) - len(batch)
    print(
        f"Done in {time.time() - started:,.0f}s: {len(batch) - failures} tagged, {failures} failed"
        + (f", {left} left for the next run." if left else ".")
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # surface the reason on the run's summary page
        import traceback

        traceback.print_exc()
        where = traceback.extract_tb(e.__traceback__)[-1]
        print(f"::error title=Tagger stopped::{type(e).__name__}: {e} (at {where.filename.split('/')[-1]}:{where.lineno})")
        sys.exit(1)
