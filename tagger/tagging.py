"""Ask Claude what's in an image, constrained to the tag list in config.yaml."""
from __future__ import annotations

import base64
import json
import threading
from pathlib import Path

import anthropic

from .images import open_rgb, to_jpeg

HERE = Path(__file__).parent

SYSTEM = """You tag photos and graphics for Pluck, a company that makes superfood seasoning from beef organs.
Your tags power a searchable image library, so be accurate: tag only what is actually visible.
Pluck products come as shakers (cylindrical cans with a shaker lid) and stand-up pouches/sachets.
There are two label generations:
- new: cream/coloured label with a cow inside a circle, "PLUCK" in large letters, flavour name below
- old: illustrated bull or a plain dark label with the PLUCK dots logo
Reference photos of the products come first, followed by the image to tag."""

INSTRUCTIONS = """Tag the image above. Rules:
- Use only tags from the list. Include a tag when it applies, with confidence high, medium or low.
- "pluck shaker" and "sachet" must be Pluck products; other brands' containers don't count.
- Read flavour names off any visible Pluck label. Leave flavours empty if none can be read.
- packaging: which Pluck label generation is shown ("new", "old", "mixed"), or "none" if no Pluck product.
- is_render: true for 3D renders and mockups, false for real photos.
- description: one plain sentence describing the image, as a person would search for it.
Answer only by calling the record_tags tool."""


class Tagger:
    def __init__(self, api_key: str, model: str, config: dict):
        self.client = anthropic.Anthropic(api_key=api_key, max_retries=4)
        self.model = model
        self.tag_names = [t["name"] for t in config["tags"]]
        self.flavours = {f.lower(): f for f in config["flavours"]}
        self.tool = self._tool(config)
        self.reference_blocks = self._references(config.get("reference_images", []))
        self.usage = {"input": 0, "cache_read": 0, "cache_write": 0, "output": 0}
        self._lock = threading.Lock()

    def _tool(self, config: dict) -> dict:
        tag_help = "; ".join(f"{t['name']}: {t['hint']}" for t in config["tags"])
        return {
            "name": "record_tags",
            "description": "Record the tags for the image being reviewed.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "description": {"type": "string"},
                    "tags": {
                        "type": "array",
                        "description": f"Tags that apply. Meanings: {tag_help}",
                        "items": {
                            "type": "object",
                            "properties": {
                                "tag": {"type": "string", "enum": self.tag_names},
                                "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                            },
                            "required": ["tag", "confidence"],
                        },
                    },
                    "flavours": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Flavours read off Pluck labels. Known: " + ", ".join(config["flavours"]),
                    },
                    "packaging": {"type": "string", "enum": ["new", "old", "mixed", "none"]},
                    "is_render": {"type": "boolean"},
                },
                "required": ["description", "tags", "flavours", "packaging", "is_render"],
            },
        }

    def _references(self, refs: list[dict]) -> list[dict]:
        blocks: list[dict] = []
        for ref in refs:
            path = HERE / "reference" / ref["file"]
            jpeg = to_jpeg(open_rgb(path.read_bytes()), 800, 85)
            blocks.append({"type": "text", "text": f"Reference: {ref['caption']}"})
            blocks.append(_image_block(jpeg))
        if blocks:
            # Cache the reference block so every image after the first reuses it cheaply.
            blocks[-1]["cache_control"] = {"type": "ephemeral"}
        return blocks

    def tag(self, jpeg: bytes) -> dict:
        content = [
            *self.reference_blocks,
            {"type": "text", "text": "Image to tag:"},
            _image_block(jpeg),
            {"type": "text", "text": INSTRUCTIONS},
        ]
        msg = self.client.messages.create(
            model=self.model,
            max_tokens=1000,
            system=SYSTEM,
            tools=[self.tool],
            tool_choice={"type": "auto"},  # newer models don't accept a forced tool; the prompt asks for it
            messages=[{"role": "user", "content": content}],
        )
        with self._lock:
            u = msg.usage
            self.usage["input"] += u.input_tokens
            self.usage["cache_read"] += getattr(u, "cache_read_input_tokens", 0) or 0
            self.usage["cache_write"] += getattr(u, "cache_creation_input_tokens", 0) or 0
            self.usage["output"] += u.output_tokens
        result = next((b.input for b in msg.content if b.type == "tool_use"), None)
        if result is None:  # fall back to JSON written as text
            text = "".join(getattr(b, "text", "") for b in msg.content)
            start, end = text.find("{"), text.rfind("}")
            if start == -1 or end <= start:
                raise RuntimeError(f"Model didn't return tags: {text[:200]}")
            result = json.loads(text[start : end + 1])
        return self.clean(result)

    def clean(self, raw: dict) -> dict:
        """Normalise the model's answer into database columns."""
        confidence: dict[str, str] = {}
        for item in raw.get("tags", []):
            name, conf = item.get("tag"), item.get("confidence", "low")
            if name in self.tag_names:
                confidence[name] = conf
        tags = [t for t in self.tag_names if confidence.get(t) in ("high", "medium")]

        flavours: list[str] = []
        for f in raw.get("flavours", []):
            name = self.flavours.get(str(f).strip().lower(), str(f).strip().title())
            if name and name not in flavours:
                flavours.append(name)

        packaging = raw.get("packaging")
        return {
            "description": (raw.get("description") or "").strip()[:500],
            "tags": tags,
            "tag_confidence": confidence,
            "flavours": flavours,
            "packaging": None if packaging in (None, "none") else packaging,
            "is_render": bool(raw.get("is_render")),
        }


def _image_block(jpeg: bytes) -> dict:
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(jpeg).decode()},
    }
