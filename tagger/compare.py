"""Tag a random sample with two models and report where they disagree. Writes nothing to the gallery.

    python -m tagger --compare 50
"""
from __future__ import annotations

import base64
import html
import os
import random
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import yaml

from .images import to_jpeg

# USD per million tokens: input, cache read, cache write (5 min), output.
PRICES = {
    "claude-sonnet-5-5": (2.00, 0.10, 2.50, 10.00),
    "claude-haiku-5-5": (0.10, 0.01, 0.125, 0.50),
}
MODELS = ["claude-sonnet-5-5", "claude-haiku-5-5"]
FOCUS = ["pluck shaker", "sachet", "food", "people"]  # the tags people search for most


def cost(model: str, usage: dict) -> float:
    p_in, p_read, p_write, p_out = PRICES[model]
    return (
        usage["input"] * p_in + usage["cache_read"] * p_read + usage["cache_write"] * p_write + usage["output"] * p_out
    ) / 1e6


def label(model: str) -> str:
    return "Sonnet" if "sonnet" in model else "Haiku"


def run(drive, images, n: int, api_key: str, fetch_pixels) -> None:
    from .tagging import Tagger

    config = yaml.safe_load((Path(__file__).parent / "config.yaml").read_text())
    taggers = {m: Tagger(api_key, m, config) for m in MODELS}
    sample = random.Random(42).sample(images, min(n, len(images)))
    print(f"Comparing {label(MODELS[0])} and {label(MODELS[1])} on {len(sample)} random images…", flush=True)

    def one(img):
        try:
            pixels = fetch_pixels(drive, img)
            jpeg = to_jpeg(pixels, 1280, 85)
            results = {m: t.tag(jpeg) for m, t in taggers.items()}
            return img, to_jpeg(pixels, 360, 70), results, None
        except Exception as e:
            return img, None, {}, f"{type(e).__name__}: {e}"

    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(one, sample))

    ok = [r for r in rows if not r[3]]
    a, b = MODELS

    def differs(res):
        ta, tb = set(res[a]["tags"]), set(res[b]["tags"])
        return ta != tb or set(res[a]["flavours"]) != set(res[b]["flavours"]) or res[a]["packaging"] != res[b]["packaging"]

    disagreements = [r for r in ok if differs(r[2])]
    lines = [
        f"## Sonnet vs Haiku on {len(ok)} of your images",
        "",
        f"**They agreed completely on {len(ok) - len(disagreements)} of {len(ok)} images.**",
        "",
        "| Tag | Sonnet found | Haiku found | Disagreed on |",
        "|---|---|---|---|",
    ]
    for tag in FOCUS:
        sa = sum(tag in r[2][a]["tags"] for r in ok)
        sb = sum(tag in r[2][b]["tags"] for r in ok)
        dis = sum((tag in r[2][a]["tags"]) != (tag in r[2][b]["tags"]) for r in ok)
        lines.append(f"| {tag} | {sa} | {sb} | {dis} |")
    flav = sum(set(r[2][a]["flavours"]) != set(r[2][b]["flavours"]) for r in ok)
    pack = sum(r[2][a]["packaging"] != r[2][b]["packaging"] for r in ok)
    lines += [
        f"| flavour | | | {flav} |",
        f"| packaging (old/new) | | | {pack} |",
        "",
        "| Model | Cost of this test | Estimated full library (1 image ≈ this rate) |",
        "|---|---|---|",
    ]
    for m, t in taggers.items():
        c = cost(m, t.usage)
        per = c / max(len(ok), 1)
        lines.append(f"| {label(m)} | ${c:.2f} | ${per * len(images):.2f} for {len(images)} images |")
    if len(rows) > len(ok):
        from collections import Counter

        import re

        reasons = Counter(re.sub(r"req_\w+", "req_…", r[3])[:300] for r in rows if r[3])
        lines += ["", f"{len(rows) - len(ok)} images failed. Reasons:", ""]
        for reason, n in reasons.most_common(5):
            lines.append(f"- {n}× `{reason}`")
            print(f"::warning title=Tagging failed ({n} images)::{reason}", flush=True)
    lines += ["", "Download **comparison-report** below to see every disagreement with its picture."]

    summary = "\n".join(lines)
    print(summary)
    print("::notice title=Comparison result::" + summary.replace("\n", "%0A"), flush=True)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(summary + "\n")

    Path("comparison-report.html").write_text(_report(disagreements, ok, a, b))
    print("Wrote comparison-report.html")


def _chips(res: dict, other: dict) -> str:
    out = []
    for t in res["tags"]:
        cls = "same" if t in other["tags"] else "only"
        out.append(f'<span class="{cls}">{html.escape(t)}</span>')
    meta = []
    if res["flavours"]:
        meta.append("flavour: " + ", ".join(res["flavours"]))
    if res["packaging"]:
        meta.append(f"packaging: {res['packaging']}")
    return " ".join(out) + (f'<div class="meta">{html.escape(" · ".join(meta))}</div>' if meta else "")


def _report(disagreements, ok, a, b) -> str:
    cards = []
    for img, thumb, res, _ in disagreements:
        src = "data:image/jpeg;base64," + base64.b64encode(thumb).decode()
        cards.append(
            f"""<article><a href="{html.escape(img.url)}" target="_blank"><img src="{src}" alt=""></a>
<div><h3>{html.escape(img.folder_path)}/{html.escape(img.name)}</h3>
<p><b>Sonnet</b> {_chips(res[a], res[b])}</p>
<p><b>Haiku</b> {_chips(res[b], res[a])}</p></div></article>"""
        )
    body = "\n".join(cards) or "<p>No disagreements.</p>"
    return f"""<!doctype html><meta charset="utf-8"><title>Sonnet vs Haiku</title>
<style>
body{{font:15px/1.5 -apple-system,Segoe UI,Arial,sans-serif;margin:0;padding:24px max(16px,4vw);background:#f4efe2;color:#17302d}}
h1{{margin:0 0 4px}} .lead{{color:#5d6d68;margin:0 0 24px}}
article{{display:grid;grid-template-columns:200px 1fr;gap:16px;background:#fbf8f0;border-radius:12px;padding:12px;margin-bottom:12px}}
article img{{width:200px;height:200px;object-fit:cover;border-radius:8px}}
h3{{margin:0 0 8px;font-size:13px;color:#5d6d68;word-break:break-all}}
p{{margin:6px 0}} b{{display:inline-block;width:64px}}
span{{display:inline-block;border-radius:999px;padding:1px 10px;margin:2px;font-size:13px;background:#e9e1cc}}
span.only{{background:#d9452b;color:#fff}} .meta{{font-size:12px;color:#5d6d68;margin-left:68px}}
@media(max-width:520px){{article{{grid-template-columns:1fr}}article img{{width:100%}}}}
</style>
<h1>Where Sonnet and Haiku disagreed</h1>
<p class="lead">{len(disagreements)} of {len(ok)} sampled images. Red tags were found by only one model. Click a picture to open it in Drive.</p>
{body}"""
