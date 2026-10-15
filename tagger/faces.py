"""Find named people in the library with Amazon Rekognition face search.

    python -m tagger.faces            # index new/changed images, then match people
    python -m tagger.faces --rematch  # re-run matching only (e.g. after adding reference photos)

How it works:
- Each library image is scanned once; its faces go into a private Rekognition collection, keyed by Drive id.
  The images.faces_md5 column records which version of the file was scanned.
- Reference photos in tagger/people/ (listed under `people` in config.yaml) say who is who.
- Every library face that matches a reference face at FACE_MATCH_THRESHOLD or above gets that person's
  name in images.people. People shown on an image can be removed in the gallery like any tag.

Settings (GitHub Actions secrets): AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, optional AWS_REGION
(default ap-southeast-2, Sydney), plus the Drive and Supabase settings the tagger uses.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import yaml

HERE = Path(__file__).parent
COLLECTION = "pluck-library"
FACE_MATCH_THRESHOLD = 90  # percent; higher = fewer false matches, more misses
MAX_IMAGES_PER_RUN = 1500


def _env(name: str, default: str | None = None) -> str:
    return (os.environ.get(name) or default or "").strip()


def _jpeg(pixels, long_edge=1600) -> bytes:
    from .images import to_jpeg

    data = to_jpeg(pixels, long_edge, 88)
    while len(data) > 5_000_000 and long_edge > 600:  # Rekognition's 5 MB limit
        long_edge -= 400
        data = to_jpeg(pixels, long_edge, 85)
    return data


def _slug(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.\-]", "_", name.lower())


class Faces:
    def __init__(self, region: str):
        import boto3
        from botocore.config import Config

        self.rk = boto3.client("rekognition", region_name=region, config=Config(retries={"max_attempts": 8, "mode": "adaptive"}))

    def ensure_collection(self) -> None:
        try:
            self.rk.create_collection(CollectionId=COLLECTION)
            print(f"Created face collection '{COLLECTION}'.")
        except self.rk.exceptions.ResourceAlreadyExistsException:
            pass

    def all_faces(self) -> list[dict]:
        faces, token = [], None
        while True:
            kw = {"CollectionId": COLLECTION, "MaxResults": 4096}
            if token:
                kw["NextToken"] = token
            r = self.rk.list_faces(**kw)
            faces += r.get("Faces", [])
            token = r.get("NextToken")
            if not token:
                return faces

    def delete(self, face_ids: list[str]) -> None:
        for i in range(0, len(face_ids), 4096):
            self.rk.delete_faces(CollectionId=COLLECTION, FaceIds=face_ids[i : i + 4096])

    def index(self, jpeg: bytes, external_id: str, max_faces: int = 100) -> int:
        r = self.rk.index_faces(
            CollectionId=COLLECTION,
            Image={"Bytes": jpeg},
            ExternalImageId=external_id,
            MaxFaces=max_faces,
            QualityFilter="AUTO",
            DetectionAttributes=[],
        )
        return len(r.get("FaceRecords", []))

    def matches(self, face_id: str) -> set[str]:
        r = self.rk.search_faces(
            CollectionId=COLLECTION, FaceId=face_id, FaceMatchThreshold=FACE_MATCH_THRESHOLD, MaxFaces=4096
        )
        return {m["Face"]["ExternalImageId"] for m in r.get("FaceMatches", []) if not m["Face"].get("ExternalImageId", "").startswith("ref_")}


def _rows(store) -> dict[str, dict]:
    rows, offset = {}, 0
    while True:
        r = store.s.get(
            f"{store.url}/rest/v1/images",
            params={"select": "id,md5,faces_md5,people,removed", "order": "id", "limit": 1000, "offset": offset},
            timeout=60,
        )
        if r.status_code >= 400 and ("faces_md5" in r.text or "people" in r.text):
            print(
                "::error title=Face search needs two new columns::In Supabase SQL Editor run: "
                "alter table images add column if not exists people text[] not null default '{}'; "
                "alter table images add column if not exists faces_md5 text;"
            )
            sys.exit(1)
        store._check(r)
        batch = r.json()
        rows.update({row["id"]: row for row in batch})
        if len(batch) < 1000:
            return rows
        offset += 1000


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rematch", action="store_true", help="skip indexing; just re-run people matching")
    args = ap.parse_args()

    if not (_env("AWS_ACCESS_KEY_ID") and _env("AWS_SECRET_ACCESS_KEY")):
        print("Face search isn't set up (no AWS keys). Skipping.")
        return
    os.environ["AWS_ACCESS_KEY_ID"] = _env("AWS_ACCESS_KEY_ID")
    os.environ["AWS_SECRET_ACCESS_KEY"] = _env("AWS_SECRET_ACCESS_KEY")

    from .__main__ import env
    from .drive import MAX_DOWNLOAD_BYTES, Drive
    from .images import open_rgb
    from .store import Store

    config = yaml.safe_load((HERE / "config.yaml").read_text())
    people = config.get("people") or []
    if not people:
        print("No people listed in config.yaml. Skipping.")
        return

    faces = Faces(_env("AWS_REGION", "ap-southeast-2"))
    faces.ensure_collection()
    store = Store(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"))
    rows = _rows(store)
    existing = faces.all_faces()
    by_external: dict[str, list[str]] = {}
    for f in existing:
        by_external.setdefault(f.get("ExternalImageId", ""), []).append(f["FaceId"])

    # 1. Reference photos.
    refs_changed = False
    ref_faces: dict[str, list[str]] = {}
    wanted_refs = set()
    for person in people:
        for i, photo in enumerate(person.get("photos", []), 1):
            ext = f"ref_{_slug(person['name'])}_{i}_{_slug(Path(photo).stem)}"
            wanted_refs.add(ext)
            if ext not in by_external:
                n = faces.index(_jpeg(open_rgb((HERE / photo).read_bytes())), ext, max_faces=1)
                if not n:
                    print(f"::warning title=No face found::Reference photo {photo} for {person['name']} has no usable face.")
                    continue
                by_external[ext] = [f["FaceId"] for f in faces.all_faces() if f.get("ExternalImageId") == ext]
                refs_changed = True
            ref_faces.setdefault(person["name"], []).extend(by_external[ext])
    stale = [fid for ext, ids in by_external.items() if ext.startswith("ref_") and ext not in wanted_refs for fid in ids]
    if stale:
        faces.delete(stale)
        refs_changed = True

    # 2. Scan new or changed library images.
    indexed = 0
    if not args.rematch:
        drive = Drive(env("GOOGLE_SERVICE_ACCOUNT_JSON"))
        folder_ids = [f.strip() for f in env("DRIVE_FOLDER_IDS").split(",") if f.strip()]
        images = {i.id: i for i in drive.walk_images(folder_ids, kinds=("image/", "video/"))}  # videos: poster frame
        todo = [i for i in images.values() if (rows.get(i.id) or {}).get("faces_md5") != (i.md5 or "x")]
        todo = todo[: int(_env("MAX_IMAGES_PER_RUN") or MAX_IMAGES_PER_RUN)]
        print(f"Scanning faces in {len(todo)} new or changed images…", flush=True)

        def scan(img):
            try:
                old = by_external.get(img.id)
                if old:
                    faces.delete(old)
                try:
                    pixels = open_rgb(drive.preview(img, 1600))
                except Exception:
                    pixels = open_rgb(drive.download(img))  # no Drive preview (e.g. big TIFF)
                n = faces.index(_jpeg(pixels), img.id)
                store.update(img.id, {"faces_md5": img.md5 or "x"})
                return n, None
            except Exception as e:
                return 0, f"{img.folder_path}/{img.name}: {type(e).__name__}: {e}"

        failures = []
        with ThreadPoolExecutor(max_workers=4) as pool:
            for n_done, fut in enumerate(as_completed([pool.submit(scan, i) for i in todo]), 1):
                n, err = fut.result()
                indexed += 1
                if err:
                    failures.append(err)
                if n_done % 100 == 0:
                    print(f"  {n_done}/{len(todo)} scanned", flush=True)
        if failures:
            print(f"::warning title=Face scan failed on {len(failures)} images::" + "%0A".join(failures[:10]))

    # 3. Match people, only when something changed (each search is billed).
    if not (indexed or refs_changed or args.rematch):
        print("No new images or reference photos; people unchanged.")
        return
    found: dict[str, set[str]] = {}
    for name, face_ids in ref_faces.items():
        hits: set[str] = set()
        for fid in face_ids:
            hits |= faces.matches(fid)
        found[name] = hits
    changed = 0
    for image_id, row in rows.items():
        want = sorted(name for name, ids in found.items() if image_id in ids)
        if sorted(row.get("people") or []) != want:
            store.update(image_id, {"people": want})
            changed += 1
    summary = ", ".join(f"{name} in {len(ids)} images" for name, ids in found.items())
    print(f"::notice title=People found::{summary}. Updated {changed} images.")


if __name__ == "__main__":
    main()
