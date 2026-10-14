"""Image decoding and resizing."""
from __future__ import annotations

import io

from PIL import Image, ImageOps

try:  # iPhone photos (HEIC/HEIF)
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:  # pragma: no cover
    pass

Image.MAX_IMAGE_PIXELS = 200_000_000  # big camera files are fine; still guards against bombs


def open_rgb(data: bytes) -> Image.Image:
    """Decode any Pillow-readable image, fix phone rotation, flatten transparency onto white."""
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[-1])
        return bg
    return im.convert("RGB")


def to_jpeg(im: Image.Image, long_edge: int, quality: int) -> bytes:
    im = im.copy()
    im.thumbnail((long_edge, long_edge), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, "JPEG", quality=quality, optimize=True, progressive=True)
    return out.getvalue()
