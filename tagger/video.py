"""Pull still frames from Drive videos without downloading the whole file.

ffmpeg reads the video straight from Drive over HTTP and seeks to each point, so only the
bytes around each frame are fetched, even for multi-gigabyte files.
"""
from __future__ import annotations

import io
import os
import re
import subprocess
import tempfile

from google.auth.transport.requests import Request
from PIL import Image

FRAMES = 6
COLS, ROWS = 3, 2
CELL_W = 640  # sheet is 1920 px wide


def _ffmpeg() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def _source(drive, img) -> tuple[str, str]:
    creds = drive.creds
    if not creds.valid:
        creds.refresh(Request())
    url = f"https://www.googleapis.com/drive/v3/files/{img.id}?alt=media&supportsAllDrives=true"
    return url, f"Authorization: Bearer {creds.token}\r\n"


def _duration(url: str, headers: str) -> float:
    out = subprocess.run(
        [_ffmpeg(), "-hide_banner", *(["-headers", headers] if headers else []), "-i", url],
        capture_output=True, text=True, timeout=120,
    ).stderr
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.?\d*)", out)
    if not m:
        raise RuntimeError("Couldn't read the video's length")
    h, mi, s = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(s)


def _frame(url: str, headers: str, at: float) -> Image.Image:
    r = subprocess.run(
        [_ffmpeg(), "-hide_banner", "-loglevel", "warning", *(["-headers", headers] if headers else []),
         "-ss", f"{at:.2f}", "-i", url, "-frames:v", "1", "-vf", f"scale={CELL_W}:-2",
         "-f", "image2pipe", "-vcodec", "png", "pipe:1"],
        capture_output=True, timeout=180,
    )
    if r.returncode or not r.stdout:
        raise RuntimeError(f"Couldn't grab a frame at {at:.0f}s: {r.stderr.decode()[-200:]}")
    return Image.open(io.BytesIO(r.stdout)).convert("RGB")


MAX_FALLBACK_BYTES = 3_000_000_000  # download a video in full only if streaming fails and it's under 3 GB
stream_errors: list[str] = []      # first few streaming failures, for the run summary


def _download(drive, img) -> str:
    fd, path = tempfile.mkstemp(suffix=os.path.splitext(img.name)[1] or ".mp4")
    url = f"https://www.googleapis.com/drive/v3/files/{img.id}?alt=media&supportsAllDrives=true"
    with os.fdopen(fd, "wb") as f, drive.session.get(url, stream=True, timeout=600) as r:
        r.raise_for_status()
        for chunk in r.iter_content(8 * 1024 * 1024):
            f.write(chunk)
    return path


def frames_sheet(drive, img) -> tuple[Image.Image, Image.Image]:
    """Returns (3x2 sheet of 6 frames in order, the middle frame for a thumbnail)."""
    url, headers = _source(drive, img)
    try:
        return _sheet(img, url, headers)
    except RuntimeError as e:
        if len(stream_errors) < 3:
            stream_errors.append(f"{img.name}: {e}")
        if img.size and img.size > MAX_FALLBACK_BYTES:
            raise
    path = _download(drive, img)
    try:
        return _sheet(img, path, "")
    finally:
        os.remove(path)


def _sheet(img, url: str, headers: str) -> tuple[Image.Image, Image.Image]:
    length = (img.duration_ms or 0) / 1000 or _duration(url, headers)
    times = [length * (i + 0.5) / FRAMES for i in range(FRAMES)]
    frames = []
    for t in times:
        try:
            frames.append(_frame(url, headers, t))
        except RuntimeError:
            if frames:  # a damaged spot: reuse the last good frame rather than fail the video
                frames.append(frames[-1])
            else:
                raise
    cell_h = max(f.height for f in frames)
    sheet = Image.new("RGB", (CELL_W * COLS, cell_h * ROWS), "black")
    for i, f in enumerate(frames):
        x, y = (i % COLS) * CELL_W, (i // COLS) * cell_h
        sheet.paste(f, (x + (CELL_W - f.width) // 2, y + (cell_h - f.height) // 2))
    return sheet, frames[len(frames) // 2]
