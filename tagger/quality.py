"""Quality test: score the same random images with Sonnet and Haiku and build a side-by-side report.

    python -m tagger --quality-test 50

Nothing is saved to the gallery. Writes quality-report.html and a summary.
"""
from __future__ import annotations

import base64
import html
import os
import random
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic

from .images import to_jpeg

MODELS = ["claude-sonnet-5-5", "claude-haiku-5-5"]
PRICES = {"claude-sonnet-5-5": (2.00, 10.00), "claude-haiku-5-5": (0.10, 0.50)}  # USD per M input/output tokens

PROMPT = """You review images for a food brand's marketing library (Pluck, a superfood seasoning).
Judge whether this image is good enough to use in an ad, flyer, website or social post.
Judge it by the standard for its kind:
- studio/product shot or render: crisp, well lit, clean background, product clearly shown
- lifestyle/food photo: appetising, good composition and light, natural colour, nothing distracting
- people: flattering moment, eyes open, natural or happy expression, in focus
- phone/UGC shot: more leeway for casual style, but still not blurry, dark or awkward
- graphic/flyer/logo: clean and legible
Common faults: blur or soft focus, closed eyes, unflattering or grumpy expression, bad crop or tilted horizon,
dull/desaturated or off colour, too dark or blown out, cluttered or messy background, odd moment, low resolution.

Score 1-5: 5 = hero quality, use anywhere; 4 = good, usable; 3 = okay, usable with care; 2 = weak; 1 = unusable.
Answer by calling the record_quality tool."""

TOOL = {
    "name": "record_quality",
    "description": "Record the quality verdict for the image.",
    "input_schema": {
        "type": "object",
        "properties": {
            "kind": {"type": "string", "description": "What kind of image this is, in a few words."},
            "score": {"type": "integer", "minimum": 1, "maximum": 5},
            "reasons": {"type": "array", "items": {"type": "string"}, "description": "Up to 3 short reasons, faults first."},
        },
        "required": ["kind", "score", "reasons"],
    },
}


class Scorer:
    def __init__(self, api_key: str, model: str):
        self.client = anthropic.Anthropic(api_key=api_key, max_retries=4)
        self.model = model
        self.tokens = [0, 0]
        self.lock = threading.Lock()

    def score(self, jpeg: bytes) -> dict:
        for _ in range(2):
            msg = self.client.messages.create(
                model=self.model, max_tokens=400, tools=[TOOL], tool_choice={"type": "auto"},
                messages=[{"role": "user", "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(jpeg).decode()}},
                    {"type": "text", "text": PROMPT},
                ]}],
            )
            with self.lock:
                self.tokens[0] += msg.usage.input_tokens
                self.tokens[1] += msg.usage.output_tokens
            for b in msg.content:
                if b.type == "tool_use":
                    r = b.input
                    return {"kind": str(r.get("kind", "")), "score": int(r.get("score", 0)), "reasons": list(r.get("reasons", []))[:3]}
        raise RuntimeError("no verdict")

    def cost(self) -> float:
        p_in, p_out = PRICES[self.model]
        return (self.tokens[0] * p_in + self.tokens[1] * p_out) / 1e6


def run(drive, images, n: int, api_key: str, fetch_pixels) -> None:
    scorers = {m: Scorer(api_key, m) for m in MODELS}
    sample = random.Random(7).sample(images, min(n, len(images)))
    print(f"Scoring {len(sample)} images with {', '.join(MODELS)}…", flush=True)

    def one(img):
        try:
            pixels = fetch_pixels(drive, img)
            jpeg = to_jpeg(pixels, 1280, 85)
            return img, to_jpeg(pixels, 520, 78), {m: s.score(jpeg) for m, s in scorers.items()}, None
        except Exception as e:
            return img, None, {}, f"{type(e).__name__}: {e}"

    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = [r for r in pool.map(one, sample)]
    ok = [r for r in rows if not r[3]]
    a, b = MODELS
    same = sum(r[2][a]["score"] == r[2][b]["score"] for r in ok)
    close = sum(abs(r[2][a]["score"] - r[2][b]["score"]) <= 1 for r in ok)
    weak = lambda m: sum(r[2][m]["score"] <= 2 for r in ok)
    hidden_disagree = sum((r[2][a]["score"] <= 2) != (r[2][b]["score"] <= 2) for r in ok)
    per_image = {m: s.cost() / max(len(ok), 1) for m, s in scorers.items()}
    summary = [
        f"{len(ok)} images scored by both models.",
        f"Same score: {same} · within 1 point: {close} · disagree on 'hide as weak (1-2)': {hidden_disagree}",
        f"Sonnet would hide {weak(a)} · Haiku would hide {weak(b)}",
        f"Cost of this test: Sonnet ${scorers[a].cost():.2f}, Haiku ${scorers[b].cost():.2f}. "
        f"For 1,925 images: Sonnet ~${per_image[a] * 1925:.0f}, Haiku ~${per_image[b] * 1925:.2f}",
    ]
    print("\n".join(summary))
    print("::notice title=Quality test::" + "%0A".join(summary), flush=True)
    Path("quality-report.html").write_text(_report(ok, a, b, summary))
    print("Wrote quality-report.html")


def _verdict(v: dict) -> str:
    cls = "good" if v["score"] >= 4 else "mid" if v["score"] == 3 else "weak"
    reasons = "".join(f"<li>{html.escape(r)}</li>" for r in v["reasons"])
    return f'<div class="v"><span class="s {cls}">{v["score"]}</span><span class="k">{html.escape(v["kind"])}</span><ul>{reasons}</ul></div>'


def _report(rows, a, b, summary) -> str:
    rows = sorted(rows, key=lambda r: (-abs(r[2][a]["score"] - r[2][b]["score"]), r[2][a]["score"]))
    cards = []
    for img, thumb, res, _ in rows:
        src = "data:image/jpeg;base64," + base64.b64encode(thumb).decode()
        diff = abs(res[a]["score"] - res[b]["score"])
        cards.append(f"""<article class="{'disagree' if diff >= 2 else ''}">
<img src="{src}" alt="" loading="lazy">
<div class="info"><h3>{html.escape(img.name)}</h3><p class="path">{html.escape(img.folder_path)}</p>
<div class="pair"><div><b>Sonnet</b>{_verdict(res[a])}</div><div><b>Haiku</b>{_verdict(res[b])}</div></div></div></article>""")
    sums = "".join(f"<li>{html.escape(s)}</li>" for s in summary)
    return f"""<title>Image Quality Test</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{{--bg:#f4efe2;--card:#fbf8f0;--ink:#17302d;--muted:#5d6d68;--line:#ddd4bf;--good:#2f7a4f;--mid:#b07d16;--weak:#c4402a}}
@media (prefers-color-scheme: dark){{:root:not([data-theme="light"]){{--bg:#101c1a;--card:#172624;--ink:#ede6d3;--muted:#9fb0aa;--line:#2a3d3a;--good:#5fbf86;--mid:#e2b24a;--weak:#ef6a4f;color-scheme:dark}}}}
:root[data-theme="dark"]{{--bg:#101c1a;--card:#172624;--ink:#ede6d3;--muted:#9fb0aa;--line:#2a3d3a;--good:#5fbf86;--mid:#e2b24a;--weak:#ef6a4f;color-scheme:dark}}
body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,"Segoe UI",Arial,sans-serif;
padding-block:28px 60px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}}
main{{max-width:1100px;margin:0 auto;display:grid;gap:18px}}
h1{{margin:0;font-size:28px}} .lead{{margin:0;color:var(--muted)}}
.sum{{margin:0;padding:14px 18px 14px 32px;background:var(--card);border:1px solid var(--line);border-radius:12px}}
article{{display:grid;grid-template-columns:260px minmax(0,1fr);gap:16px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}}
article.disagree{{border-color:var(--weak)}}
article img{{width:100%;max-width:100%;border-radius:8px;object-fit:cover;aspect-ratio:1}}
h3{{margin:0;font-size:14px;overflow-wrap:anywhere}} .path{{margin:2px 0 10px;color:var(--muted);font-size:12px;overflow-wrap:anywhere}}
.pair{{display:grid;grid-template-columns:1fr 1fr;gap:14px}} .pair b{{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}}
.v{{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;align-items:center}}
.s{{width:34px;height:34px;border-radius:999px;display:grid;place-items:center;font-weight:700;color:#fff}}
.s.good{{background:var(--good)}} .s.mid{{background:var(--mid)}} .s.weak{{background:var(--weak)}}
.k{{font-size:13px;color:var(--muted)}} .v ul{{grid-column:1/-1;margin:4px 0 0;padding-left:18px;font-size:13px}}
@media (max-width:640px){{article{{grid-template-columns:1fr}} .pair{{grid-template-columns:1fr}}}}
</style>
<main>
<h1>Image quality test: Sonnet vs Haiku</h1>
<p class="lead">Each image scored 1–5 for "would we use this in an ad or flyer". Biggest disagreements first (red border = 2+ points apart). Green 4–5 · amber 3 · red 1–2 (would be hidden).</p>
<ul class="sum">{sums}</ul>
{''.join(cards)}
</main>"""
