"""Talks to Supabase's REST and Storage APIs with the service-role key."""
from __future__ import annotations

import requests

BUCKET = "thumbs"


class Store:
    def __init__(self, url: str, service_key: str):
        self.url = url.rstrip("/")
        self.s = requests.Session()
        if service_key.startswith("sb_"):
            # New-style secret key (sb_secret_…): Supabase reads it from the apikey header alone.
            self.s.headers.update({"apikey": service_key})
        else:
            # Legacy service_role JWT.
            self.s.headers.update({"apikey": service_key, "Authorization": f"Bearer {service_key}"})

    def _check(self, r: requests.Response) -> requests.Response:
        if r.status_code >= 400:
            raise RuntimeError(f"Supabase {r.request.method} {r.url} failed ({r.status_code}): {r.text[:500]}")
        return r

    def existing(self) -> dict[str, dict]:
        """id -> current row state for every image already known."""
        rows: dict[str, dict] = {}
        offset, page = 0, 1000
        while True:
            r = self._check(
                self.s.get(
                    f"{self.url}/rest/v1/images",
                    params={
                        "select": "id,md5,drive_modified_at,tagged_at,tag_model,thumb_path,tag_attempts",
                        "order": "id",
                        "limit": page,
                        "offset": offset,
                    },
                    timeout=60,
                )
            )
            batch = r.json()
            rows.update({row["id"]: row for row in batch})
            if len(batch) < page:
                return rows
            offset += page

    def upsert(self, rows: list[dict]) -> None:
        for i in range(0, len(rows), 500):
            self._check(
                self.s.post(
                    f"{self.url}/rest/v1/images",
                    params={"on_conflict": "id"},
                    json=rows[i : i + 500],
                    headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
                    timeout=120,
                )
            )

    def update(self, image_id: str, fields: dict) -> None:
        self._check(
            self.s.patch(
                f"{self.url}/rest/v1/images",
                params={"id": f"eq.{image_id}"},
                json=fields,
                headers={"Prefer": "return=minimal"},
                timeout=60,
            )
        )

    def mark_removed_before(self, iso_time: str) -> None:
        """Anything the indexer didn't see in this run is no longer in the covered folders."""
        self._check(
            self.s.patch(
                f"{self.url}/rest/v1/images",
                params={"last_seen_at": f"lt.{iso_time}", "removed": "eq.false"},
                json={"removed": True},
                headers={"Prefer": "return=minimal"},
                timeout=60,
            )
        )

    def upload_thumb(self, path: str, jpeg: bytes) -> None:
        self._check(
            self.s.post(
                f"{self.url}/storage/v1/object/{BUCKET}/{path}",
                data=jpeg,
                headers={"Content-Type": "image/jpeg", "x-upsert": "true", "Cache-Control": "max-age=31536000"},
                timeout=120,
            )
        )
