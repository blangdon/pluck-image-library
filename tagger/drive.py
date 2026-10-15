"""Read-only access to Google Drive through a service account."""
from __future__ import annotations

import io
import json
import re
import threading
from dataclasses import dataclass
from typing import Iterator

from google.auth.transport.requests import AuthorizedSession
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
FOLDER = "application/vnd.google-apps.folder"
FIELDS = (
    "nextPageToken, files(id, name, mimeType, md5Checksum, size, createdTime, modifiedTime, "
    "webViewLink, thumbnailLink, imageMediaMetadata(width, height), lastModifyingUser(displayName))"
)
MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024  # bigger files use Drive's own preview image instead


@dataclass
class DriveImage:
    id: str
    name: str
    folder_path: str
    mime_type: str
    md5: str | None
    size: int
    created: str
    modified: str
    url: str
    thumbnail_link: str | None
    width: int | None
    height: int | None
    added_by: str | None


class Drive:
    def __init__(self, service_account_json: str):
        info = json.loads(service_account_json)
        self.creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
        self._local = threading.local()  # the Drive client isn't thread-safe; one per worker thread

    @property
    def api(self):
        if not hasattr(self._local, "api"):
            self._local.api = build("drive", "v3", credentials=self.creds, cache_discovery=False)
        return self._local.api

    @property
    def session(self) -> AuthorizedSession:
        if not hasattr(self._local, "session"):
            self._local.session = AuthorizedSession(self.creds)
        return self._local.session

    def folder_name(self, folder_id: str) -> str:
        if folder_id.startswith("0A"):  # a Shared Drive: use its real name, not "Drive"
            try:
                return self.api.drives().get(driveId=folder_id, fields="name").execute()["name"]
            except Exception:
                pass
        meta = self.api.files().get(fileId=folder_id, fields="name", supportsAllDrives=True).execute()
        return meta["name"]

    def _children(self, folder_id: str) -> Iterator[dict]:
        token = None
        while True:
            resp = (
                self.api.files()
                .list(
                    q=f"'{folder_id}' in parents and trashed = false",
                    fields=FIELDS,
                    pageSize=1000,
                    pageToken=token,
                    supportsAllDrives=True,
                    includeItemsFromAllDrives=True,
                    corpora="allDrives",
                )
                .execute()
            )
            yield from resp.get("files", [])
            token = resp.get("nextPageToken")
            if not token:
                return

    def walk_images(self, root_ids: list[str]) -> Iterator[DriveImage]:
        """Every image under the given folders (recursively). Shortcuts are skipped."""
        seen_folders: set[str] = set()
        stack = [(fid, self.folder_name(fid)) for fid in root_ids]
        while stack:
            folder_id, path = stack.pop()
            if folder_id in seen_folders:
                continue
            seen_folders.add(folder_id)
            for f in self._children(folder_id):
                mime = f.get("mimeType", "")
                if mime == FOLDER:
                    stack.append((f["id"], f"{path}/{f['name']}"))
                elif mime.startswith("image/"):
                    meta = f.get("imageMediaMetadata") or {}
                    yield DriveImage(
                        id=f["id"],
                        name=f["name"],
                        folder_path=path,
                        mime_type=mime,
                        md5=f.get("md5Checksum"),
                        size=int(f.get("size") or 0),
                        created=f.get("createdTime"),
                        modified=f.get("modifiedTime"),
                        url=f.get("webViewLink") or f"https://drive.google.com/file/d/{f['id']}/view",
                        thumbnail_link=f.get("thumbnailLink"),
                        width=meta.get("width"),
                        height=meta.get("height"),
                        added_by=(f.get("lastModifyingUser") or {}).get("displayName"),
                    )

    def download(self, img: DriveImage) -> bytes:
        buf = io.BytesIO()
        req = self.api.files().get_media(fileId=img.id, supportsAllDrives=True)
        dl = MediaIoBaseDownload(buf, req, chunksize=8 * 1024 * 1024)
        done = False
        while not done:
            _, done = dl.next_chunk()
        return buf.getvalue()

    def preview(self, img: DriveImage, size: int = 1600) -> bytes:
        """Drive's own rendered preview. Works for formats Pillow can't read (RAW, PSD, SVG...)."""
        if not img.thumbnail_link:
            raise RuntimeError("Drive has no preview for this file")
        url = re.sub(r"=s\d+$", f"=s{size}", img.thumbnail_link)
        r = self.session.get(url, timeout=60)
        r.raise_for_status()
        return r.content
