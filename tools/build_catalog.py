#!/usr/bin/env python3
"""
DDOM — Daily Dose of Maggie: Compact Multi-Atlas Catalog Compiler
=================================================================
Takes the filtered Maggie album index + downloaded 320px previews and compiles:
  - data/atlas_0.jpg, data/atlas_1.jpg ... (96x96 crisp square tile atlases, <= 2304px)
  - data/previews.jpg                      (72x72 aspect-preserving target-sampling atlas)
  - data/photos.json                       (compact metadata + 2x2 sub-quadrant RGB signatures + HD URLs)

Zero CORS issues for instant live browser assembly & poster export, while clicking any tile
opens the full-resolution original straight from Google Photos CDN!
"""
import argparse
import json
import math
import os
from datetime import datetime, timezone
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")


def center_square(im: Image.Image) -> Image.Image:
    w, h = im.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return im.crop((left, top, left + side, top + side))


def quad_sig_12(im: Image.Image) -> list[int]:
    small = im.resize((4, 4), Image.Resampling.BOX)
    raw = small.tobytes()
    out = []
    for qy in (0, 2):
        for qx in (0, 2):
            rs = gs = bs = 0
            for dy in (0, 1):
                for dx in (0, 1):
                    off = ((qy + dy) * 4 + (qx + dx)) * 3
                    rs += raw[off]
                    gs += raw[off + 1]
                    bs += raw[off + 2]
            out.extend([int(round(rs / 4.0)), int(round(gs / 4.0)), int(round(bs / 4.0))])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", default="/tmp/maggie_album_index.json")
    ap.add_argument("--filter", default="/tmp/maggie_filter_v2.json")
    ap.add_argument("--previews-dir", required=True)
    ap.add_argument("--include-borderline", action="store_true")
    ap.add_argument("--exclude-ids", default="", help="Comma-separated album indices to exclude")
    ap.add_argument("--tile-px", type=int, default=96)
    ap.add_argument("--slot-px", type=int, default=72)
    args = ap.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    # Remove stale atlas/mosaic artifacts from earlier builds
    for fn in os.listdir(DATA_DIR):
        p = os.path.join(DATA_DIR, fn)
        if os.path.isfile(p) and (fn.startswith("atlas") or fn in ("mosaic.json", "master-thumb.jpg", "previews.jpg", "photos.json")):
            os.remove(p)

    album = json.load(open(args.index, "r", encoding="utf-8"))
    filt = json.load(open(args.filter, "r", encoding="utf-8"))

    ids = list(filt["strict_kept"])
    if args.include_borderline:
        ids.extend([x[0] for x in filt.get("borderline", [])])
    if args.exclude_ids.strip():
        excl = {int(x) for x in args.exclude_ids.split(",") if x.strip().isdigit()}
        ids = [i for i in ids if i not in excl]
    ids.sort()

    # Load valid images and skip any corrupt / pitch-black / pure-white solid frames
    valid = []
    for idx in ids:
        p = os.path.join(args.previews_dir, f"{idx:04d}.jpg")
        if not os.path.isfile(p):
            continue
        try:
            im = Image.open(p).convert("RGB")
        except Exception:
            continue
        # Basic variance check so blank black/white frames don't pollute mosaic
        tiny = im.resize((8, 8), Image.Resampling.BOX).tobytes()
        vals = [0.299 * tiny[k] + 0.587 * tiny[k + 1] + 0.114 * tiny[k + 2] for k in range(0, len(tiny), 3)]
        mean_v = sum(vals) / len(vals)
        var_v = sum((v - mean_v) ** 2 for v in vals) / len(vals)
        if var_v < 18.0:
            continue
        valid.append((idx, album[idx], im))

    n = len(valid)
    print(f"Packing {n} verified solo Maggie photos...")

    # 1. Pack crisp square tile atlases (max 24x24 = 576 tiles per 2304x2304 atlas)
    tile_px = args.tile_px
    atlas_cols = 24
    per_atlas = atlas_cols * atlas_cols
    n_atlases = math.ceil(n / per_atlas)
    atlas_imgs = []
    atlas_meta = []
    for ai in range(n_atlases):
        count = min(per_atlas, n - ai * per_atlas)
        arows = math.ceil(count / atlas_cols)
        atlas_imgs.append(Image.new("RGB", (atlas_cols * tile_px, arows * tile_px), (28, 22, 18)))
        atlas_meta.append({
            "src": f"data/atlas_{ai}.jpg",
            "cols": atlas_cols,
            "rows": arows,
            "tilePx": tile_px,
        })

    # 2. Pack single compact aspect-preserving preview atlas (slot_px x slot_px per photo)
    slot_px = args.slot_px
    pv_cols = math.ceil(math.sqrt(n))
    pv_rows = math.ceil(n / pv_cols)
    pv_atlas = Image.new("RGB", (pv_cols * slot_px, pv_rows * slot_px), (28, 22, 18))

    photos_out = []
    for k, (orig_idx, meta, im) in enumerate(valid):
        # Square tile into atlas
        ai = k // per_atlas
        local_i = k % per_atlas
        ax = local_i % atlas_cols
        ay = local_i // atlas_cols

        sq = center_square(im)
        thumb = sq.resize((tile_px, tile_px), Image.Resampling.LANCZOS)
        atlas_imgs[ai].paste(thumb, (ax * tile_px, ay * tile_px))
        sig = quad_sig_12(thumb)

        # Aspect-preserving miniature into preview atlas
        iw, ih = im.size
        scale = min(slot_px / iw, slot_px / ih)
        pw = max(12, min(slot_px, int(round(iw * scale))))
        ph = max(12, min(slot_px, int(round(ih * scale))))
        ox = (slot_px - pw) // 2
        oy = (slot_px - ph) // 2
        px_col = k % pv_cols
        py_row = k // pv_cols
        pv_im = im.resize((pw, ph), Image.Resampling.LANCZOS)
        pv_atlas.paste(pv_im, (px_col * slot_px + ox, py_row * slot_px + oy))

        ts = meta.get("ts")
        d_str = ""
        if ts:
            try:
                d_str = datetime.fromtimestamp(ts / 1000.0, timezone.utc).strftime("%Y-%m-%d")
            except Exception:
                pass

        photos_out.append({
            "orig": orig_idx,
            "d": d_str,
            "w": meta.get("w") or iw,
            "h": meta.get("h") or ih,
            "u": meta["url"],
            "a": ai,
            "ax": ax,
            "ay": ay,
            "px": px_col,
            "py": py_row,
            "ox": ox,
            "oy": oy,
            "pw": pw,
            "ph": ph,
            "s": sig,
        })

    total_kb = 0.0
    for ai, aim in enumerate(atlas_imgs):
        out_p = os.path.join(DATA_DIR, f"atlas_{ai}.jpg")
        aim.save(out_p, "JPEG", quality=84, optimize=True)
        kb = os.path.getsize(out_p) / 1024.0
        total_kb += kb
        print(f"  atlas_{ai}.jpg: {aim.size} ({kb:.1f} KB)")

    pv_path = os.path.join(DATA_DIR, "previews.jpg")
    pv_atlas.save(pv_path, "JPEG", quality=82, optimize=True)
    pv_kb = os.path.getsize(pv_path) / 1024.0
    total_kb += pv_kb
    print(f"  previews.jpg: {pv_atlas.size} ({pv_kb:.1f} KB)")

    # Pick ~180 strong close-up/high-contrast Maggie portraits for featuredIds (Today's Dose)
    scored = []
    for k, (_, _, im) in enumerate(valid):
        w, h = im.size
        asp = w / max(1, h)
        if asp < 0.65 or asp > 1.55:
            continue
        # Check center 50% warmth/brightness (Maggie's cream/white coat) vs outer border contrast
        g8 = im.resize((8, 8), Image.Resampling.BOX).tobytes()
        center_lums = []
        edge_lums = []
        center_warm = 0
        for yy in range(8):
            for xx in range(8):
                o = (yy * 8 + xx) * 3
                r, g, b = g8[o], g8[o + 1], g8[o + 2]
                lum = 0.299 * r + 0.587 * g + 0.114 * b
                if 2 <= xx <= 5 and 2 <= yy <= 5:
                    center_lums.append(lum)
                    if r >= b - 8 and lum > 115:
                        center_warm += 1
                else:
                    edge_lums.append(lum)
        all_lums = center_lums + edge_lums
        mean_l = sum(all_lums) / len(all_lums)
        std_l = math.sqrt(sum((v - mean_l) ** 2 for v in all_lums) / len(all_lums))
        c_mean = sum(center_lums) / len(center_lums)
        e_mean = sum(edge_lums) / len(edge_lums)
        # Reward good contrast + bright cream Maggie subject in center against varied background
        score = std_l * 1.1 + max(0.0, c_mean - e_mean) * 0.8 + center_warm * 3.5
        if mean_l < 55 or mean_l > 215:
            score -= 50
        scored.append((score, k))
    scored.sort(reverse=True)
    featured_ids = [k for _, k in scored[:min(180, len(scored))]]

    payload = {
        "version": 2,
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(photos_out),
        "featuredIds": featured_ids,
        "atlases": atlas_meta,
        "previewAtlas": {
            "src": "data/previews.jpg",
            "cols": pv_cols,
            "rows": pv_rows,
            "slotPx": slot_px,
        },
        "photos": photos_out,
    }
    json_path = os.path.join(DATA_DIR, "photos.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    j_kb = os.path.getsize(json_path) / 1024.0
    total_kb += j_kb
    print(f"  photos.json: {j_kb:.1f} KB")
    print(f"TOTAL data/ pack size: {total_kb / 1024.0:.2f} MB for {len(photos_out)} Maggie photos!")


if __name__ == "__main__":
    main()
