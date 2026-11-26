#!/usr/bin/env python3
"""
DDOM — Daily Dose of Maggie: Dual-Mode Multi-Atlas Catalog Compiler (v3)
========================================================================
Builds two complementary Maggie mosaic pools inside data/:
  1. Pure Maggie  (pureTiles):      All verified solo untouched Maggie photos (center-square crops).
  2. Perfected    (perfectedTiles): Pure tiles + safely rescued face-free Maggie photos +
                                    color-perfected sub-crops that crop at most 50% of any photo
                                    (kept_area >= 50%) while always keeping Maggie clearly framed!

Atlases are shared cleanly with zero duplication:
  - data/atlas_0.jpg          : All Pure Maggie tiles (loaded immediately on page boot)
  - data/atlas_1.jpg, _2.jpg  : Extra Perfected tiles (rescued + <=50% Maggie sub-crops)
  - data/rescued/r_XXXX.jpg   : Pre-cropped face-free rescued Maggie photos (original URLs NEVER stored!)
  - data/previews.jpg         : Compact 72x72 aspect-preserving miniatures for target sampling
  - data/photos.json          : Version 3 compact metadata + 2x2 sub-quadrant RGB signatures + exact crop rects
"""
import argparse
import json
import math
import os
import shutil
import urllib.request
from datetime import datetime, timezone
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
RESCUED_DIR = os.path.join(DATA_DIR, "rescued")


def center_square_rect(w: int, h: int) -> tuple[int, int, int]:
    side = min(w, h)
    return (w - side) // 2, (h - side) // 2, side


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


def avg_rgb(sig: list[int]) -> tuple[float, float, float]:
    return (
        (sig[0] + sig[3] + sig[6] + sig[9]) * 0.25,
        (sig[1] + sig[4] + sig[7] + sig[10]) * 0.25,
        (sig[2] + sig[5] + sig[8] + sig[11]) * 0.25,
    )


def sig_dist(a: list[int], b: list[int]) -> float:
    tot = 0.0
    for q in range(0, 12, 3):
        rm = 0.5 * (a[q] + b[q])
        dr = a[q] - b[q]
        dg = a[q + 1] - b[q + 1]
        db = a[q + 2] - b[q + 2]
        tot += (2.0 + rm / 256.0) * dr * dr + 4.0 * dg * dg + (2.0 + (255.0 - rm) / 256.0) * db * db
    return math.sqrt(tot * 0.25 / 8.0)


def maggie_in_crop(box: list[float], x: int, y: int, s: int) -> tuple[bool, float]:
    bx1, by1, bx2, by2 = box[0], box[1], box[2], box[3]
    bw = max(1.0, bx2 - bx1)
    bh = max(1.0, by2 - by1)
    ba = bw * bh

    ix1, iy1 = max(bx1, x), max(by1, y)
    ix2, iy2 = min(bx2, x + s), min(by2, y + s)
    if ix2 <= ix1 or iy2 <= iy1:
        return False, 0.0
    ia = (ix2 - ix1) * (iy2 - iy1)
    cov = ia / ba

    # Keep Maggie's head (upper 25%) AND center (50%) safely inside the tile frame!
    mcx = 0.5 * (bx1 + bx2)
    mcy_head = by1 + 0.25 * bh
    mcy_mid = by1 + 0.52 * bh
    head_ok = (
        (x + s * 0.05 <= mcx <= x + s * 0.95)
        and (y + s * 0.03 <= mcy_head <= y + s * 0.88)
        and (y + s * 0.05 <= mcy_mid <= y + s * 0.96)
    )
    if not head_ok:
        return False, cov

    crop_fill = ia / float(s * s)
    ok = (cov >= 0.78) or (cov >= 0.64 and crop_fill >= 0.44)
    return ok, cov


def generate_extra_crops(im: Image.Image, box, base_sig: list[int], max_extra: int = 3):
    """
    Generate up to `max_extra` color-diverse square sub-crops of `im` that:
      - Strictly keep >= 50% of the original photo's area (<= 50% cropped!)
      - Strictly keep Maggie clearly framed inside the crop
      - Maximize 2x2 sub-quadrant color & gamut diversity vs the center crop and siblings.
    Returns list of tuples: ((x, y, side), sig)
    """
    w, h = im.size
    orig_area = float(w * h)
    min_side = min(w, h)
    cx0, cy0, _ = center_square_rect(w, h)
    chosen_sigs = [base_sig]
    cands = []

    if box is None:
        # No YOLO box (usually extreme close-ups of Maggie): conservative >= 55% kept area
        # and >= 88% of central 44% core kept inside!
        s_lo = max(int(math.ceil(math.sqrt(0.55 * orig_area))), int(round(min_side * 0.80)))
        if s_lo <= min_side:
            core = (w * 0.28, h * 0.28, w * 0.72, h * 0.72)
            core_a = (core[2] - core[0]) * (core[3] - core[1])
            for s in sorted({s_lo, min_side}):
                if s * s < 0.50 * orig_area:
                    continue
                xs = sorted({0, (w - s) // 2, w - s})
                ys = sorted({0, (h - s) // 2, h - s})
                for x in xs:
                    for y in ys:
                        if x == cx0 and y == cy0 and s == min_side:
                            continue
                        ix1, iy1 = max(core[0], x), max(core[1], y)
                        ix2, iy2 = min(core[2], x + s), min(core[3], y + s)
                        if ix2 <= ix1 or iy2 <= iy1:
                            continue
                        if ((ix2 - ix1) * (iy2 - iy1)) / core_a < 0.88:
                            continue
                        sq = im.crop((x, y, x + s, y + s))
                        cands.append(((x, y, s), quad_sig_12(sq)))
    else:
        s_lo = int(math.ceil(math.sqrt(0.502 * orig_area)))
        sides = sorted({s for s in (s_lo, int(round((s_lo + min_side) * 0.5)), min_side) if s <= min_side})
        for s in sides:
            if s * s < 0.50 * orig_area:
                continue
            nx = 5 if (w - s) > 20 else (3 if (w - s) > 4 else 1)
            ny = 5 if (h - s) > 20 else (3 if (h - s) > 4 else 1)
            xs = [0] if nx == 1 else sorted({int(round(i * (w - s) / (nx - 1))) for i in range(nx)})
            ys = [0] if ny == 1 else sorted({int(round(j * (h - s) / (ny - 1))) for j in range(ny)})
            mcx = max(0, min(w - s, int(round(0.5 * (box[0] + box[2]) - s * 0.5))))
            mcy = max(0, min(h - s, int(round(0.5 * (box[1] + box[3]) - s * 0.5))))
            xs = sorted(set(xs + [mcx]))
            ys = sorted(set(ys + [mcy]))
            for x in xs:
                for y in ys:
                    if x == cx0 and y == cy0 and s == min_side:
                        continue
                    ok, _ = maggie_in_crop(box, x, y, s)
                    if not ok:
                        continue
                    sq = im.crop((x, y, x + s, y + s))
                    cands.append(((x, y, s), quad_sig_12(sq)))

    picked = []
    for _ in range(max_extra):
        best = None
        best_score = 0.0
        for rect, sig in cands:
            min_d = min(sig_dist(sig, cs) for cs in chosen_sigs)
            if min_d < 19.0:
                continue
            r, g, b = avg_rgb(sig)
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            sat = max(r, g, b) - min(r, g, b)
            gamut_bonus = (
                max(0.0, 95.0 - lum) * 0.20
                + max(0.0, lum - 172.0) * 0.16
                + max(0.0, sat - 34.0) * 0.22
            )
            sc = min_d + gamut_bonus
            if sc > best_score:
                best_score = sc
                best = (rect, sig)
        if best is None:
            break
        picked.append(best)
        chosen_sigs.append(best[1])
    return picked


def download_rescued_hd(orig_idx: int, url: str, cache_dir: str) -> str:
    os.makedirs(cache_dir, exist_ok=True)
    out = os.path.join(cache_dir, f"{orig_idx:04d}.jpg")
    if os.path.isfile(out) and os.path.getsize(out) > 2000:
        return out
    req = urllib.request.Request(
        f"{url}=w900-no",
        headers={"User-Agent": "Mozilla/5.0"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = resp.read()
    with open(out, "wb") as f:
        f.write(data)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", default="/tmp/maggie_album_index.json")
    ap.add_argument("--filter", default="/tmp/maggie_filter_v3.json")
    ap.add_argument("--scan", default="/tmp/maggie_perfected_scan.json")
    ap.add_argument("--previews-dir", required=True)
    ap.add_argument("--rescued-cache-dir", required=True)
    ap.add_argument("--exclude-ids", default="471,572,727,269,880,1265,1360,1397")
    ap.add_argument("--exclude-rescued", default="103,166,174,252,811,868,913,1428")
    ap.add_argument("--tile-px", type=int, default=96)
    ap.add_argument("--slot-px", type=int, default=72)
    ap.add_argument("--sample-sheet", default="")
    args = ap.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.isdir(RESCUED_DIR):
        shutil.rmtree(RESCUED_DIR)
    os.makedirs(RESCUED_DIR, exist_ok=True)

    # Remove stale atlas/catalog files
    for fn in os.listdir(DATA_DIR):
        p = os.path.join(DATA_DIR, fn)
        if os.path.isfile(p) and (fn.startswith("atlas") or fn in ("mosaic.json", "master-thumb.jpg", "previews.jpg", "photos.json")):
            os.remove(p)

    album = json.load(open(args.index, "r", encoding="utf-8"))
    filt = json.load(open(args.filter, "r", encoding="utf-8"))
    scan = json.load(open(args.scan, "r", encoding="utf-8"))
    boxes = {int(k): v for k, v in scan.get("maggie_boxes", {}).items()}

    excl_pure = {int(x) for x in args.exclude_ids.split(",") if x.strip().isdigit()}
    excl_resc = {int(x) for x in args.exclude_rescued.split(",") if x.strip().isdigit()}

    pure_ids = sorted(i for i in filt["strict_kept"] if i not in excl_pure)

    # 1. Load valid Pure Maggie images
    pure_valid = []
    for idx in pure_ids:
        p = os.path.join(args.previews_dir, f"{idx:04d}.jpg")
        if not os.path.isfile(p):
            continue
        try:
            im = Image.open(p).convert("RGB")
        except Exception:
            continue
        tiny = im.resize((8, 8), Image.Resampling.BOX).tobytes()
        vals = [0.299 * tiny[k] + 0.587 * tiny[k + 1] + 0.114 * tiny[k + 2] for k in range(0, len(tiny), 3)]
        mean_v = sum(vals) / len(vals)
        var_v = sum((v - mean_v) ** 2 for v in vals) / len(vals)
        if var_v < 18.0:
            continue
        pure_valid.append((idx, album[idx], im))

    # 2. Prepare verified strict <=50% rescued Maggie photos (downloaded at w900-no & pre-cropped locally!)
    rescued_valid = []
    for r in scan.get("rescued", []):
        idx = int(r["idx"])
        if idx in excl_resc or idx in excl_pure:
            continue
        x1, y1, x2, y2 = r["crop"]
        ow, oh = float(r["w"]), float(r["h"])
        rw, rh = x2 - x1, y2 - y1
        max_sq = min(rw, rh)
        # STRICT 50% RULE: even the final square tile MUST keep >= 50% of the original photo's area!
        if (max_sq * max_sq) < 0.50 * (ow * oh):
            continue
        meta = album[idx]
        hd_path = download_rescued_hd(idx, meta["url"], args.rescued_cache_dir)
        hd_im = Image.open(hd_path).convert("RGB")
        hw, hh = hd_im.size
        cx1 = max(0, min(hw - 1, int(round((x1 / ow) * hw))))
        cy1 = max(0, min(hh - 1, int(round((y1 / oh) * hh))))
        cx2 = max(cx1 + 2, min(hw, int(round((x2 / ow) * hw))))
        cy2 = max(cy1 + 2, min(hh, int(round((y2 / oh) * hh))))
        cropped_hd = hd_im.crop((cx1, cy1, cx2, cy2))
        rel_src = f"data/rescued/r_{idx:04d}.jpg"
        out_resc_path = os.path.join(ROOT, rel_src)
        cropped_hd.save(out_resc_path, "JPEG", quality=88, optimize=True)
        rescued_valid.append((idx, meta, cropped_hd, rel_src, r))

    pure_count = len(pure_valid)
    resc_count = len(rescued_valid)
    total_photos = pure_count + resc_count
    print(f"Pure Maggie photos: {pure_count}")
    print(f"Verified strict-50% rescued Maggie photos: {resc_count} (total: {total_photos})")

    tile_px = args.tile_px
    atlas_cols = 24
    per_atlas = atlas_cols * atlas_cols  # 576 tiles per atlas

    # 3. Pack atlas_0.jpg with ALL Pure Maggie center-square tiles (pure_count <= 576)
    assert pure_count <= per_atlas, f"Expected <= {per_atlas} pure tiles per first atlas, got {pure_count}"
    a0_rows = math.ceil(pure_count / atlas_cols)
    atlas_0 = Image.new("RGB", (atlas_cols * tile_px, a0_rows * tile_px), (28, 22, 18))

    # Preview atlas for ALL photos (pure + rescued)
    slot_px = args.slot_px
    pv_cols = math.ceil(math.sqrt(total_photos))
    pv_rows = math.ceil(total_photos / pv_cols)
    pv_atlas = Image.new("RGB", (pv_cols * slot_px, pv_rows * slot_px), (28, 22, 18))

    photos_out = []
    pure_tiles_out = []
    extra_perf_specs = []  # tuples of (photo_id, thumb_img, cr_norm_or_None, sig, debug_info)

    for k, (orig_idx, meta, im) in enumerate(pure_valid):
        iw, ih = im.size
        ax = k % atlas_cols
        ay = k // atlas_cols

        cx0, cy0, side = center_square_rect(iw, ih)
        sq = im.crop((cx0, cy0, cx0 + side, cy0 + side))
        thumb = sq.resize((tile_px, tile_px), Image.Resampling.LANCZOS)
        atlas_0.paste(thumb, (ax * tile_px, ay * tile_px))
        sig = quad_sig_12(thumb)

        # Preview miniature
        scale = min(slot_px / iw, slot_px / ih)
        pw = max(12, min(slot_px, int(round(iw * scale))))
        ph = max(12, min(slot_px, int(round(ih * scale))))
        ox = (slot_px - pw) // 2
        oy = (slot_px - ph) // 2
        px_col = k % pv_cols
        py_row = k // pv_cols
        pv_atlas.paste(im.resize((pw, ph), Image.Resampling.LANCZOS), (px_col * slot_px + ox, py_row * slot_px + oy))

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
            "pure": 1,
            "a": 0,
            "ax": ax,
            "ay": ay,
            "px": px_col,
            "py": py_row,
            "ox": ox,
            "oy": oy,
            "pw": pw,
            "ph": ph,
        })
        pure_tiles_out.append({
            "p": k,
            "a": 0,
            "ax": ax,
            "ay": ay,
            "s": sig,
        })

        # Generate up to 3 color-perfected <=50%-cropped Maggie sub-crops for Perfected mode!
        extras = generate_extra_crops(im, boxes.get(orig_idx), sig, max_extra=3)
        for (rx, ry, rs), esig in extras:
            ethumb = im.crop((rx, ry, rx + rs, ry + rs)).resize((tile_px, tile_px), Image.Resampling.LANCZOS)
            cr = [
                round(rx / iw, 4),
                round(ry / ih, 4),
                round(rs / iw, 4),
                round(rs / ih, 4),
            ]
            # Recompute signature directly from the resized tile so it matches atlas pixel-for-pixel
            esig2 = quad_sig_12(ethumb)
            kept_pct = int(round(100.0 * (rs * rs) / (iw * ih)))
            extra_perf_specs.append((k, ethumb, cr, esig2, (orig_idx, kept_pct, boxes.get(orig_idx) is not None)))

    # 4. Append rescued Maggie photos (indices pure_count .. total_photos-1) & their Perfected tiles
    rescued_tile_indices = []
    for r_i, (orig_idx, meta, rim, rel_src, rinfo) in enumerate(rescued_valid):
        pid = pure_count + r_i
        rw, rh = rim.size
        cx0, cy0, side = center_square_rect(rw, rh)
        sq = rim.crop((cx0, cy0, cx0 + side, cy0 + side))
        thumb = sq.resize((tile_px, tile_px), Image.Resampling.LANCZOS)
        sig = quad_sig_12(thumb)

        # Preview miniature
        scale = min(slot_px / rw, slot_px / rh)
        pw = max(12, min(slot_px, int(round(rw * scale))))
        ph = max(12, min(slot_px, int(round(rh * scale))))
        ox = (slot_px - pw) // 2
        oy = (slot_px - ph) // 2
        px_col = pid % pv_cols
        py_row = pid // pv_cols
        pv_atlas.paste(rim.resize((pw, ph), Image.Resampling.LANCZOS), (px_col * slot_px + ox, py_row * slot_px + oy))

        ts = meta.get("ts")
        d_str = ""
        if ts:
            try:
                d_str = datetime.fromtimestamp(ts / 1000.0, timezone.utc).strftime("%Y-%m-%d")
            except Exception:
                pass

        # NOTE: NO "u" field stored for rescued photos — ONLY the verified face-free local JPEG `src`!
        photos_out.append({
            "orig": orig_idx,
            "d": d_str,
            "w": rw,
            "h": rh,
            "src": rel_src,
            "pure": 0,
            "a": 1,  # updated below once packed
            "ax": 0,
            "ay": 0,
            "px": px_col,
            "py": py_row,
            "ox": ox,
            "oy": oy,
            "pw": pw,
            "ph": ph,
        })
        rescued_tile_indices.append((pid, len(extra_perf_specs)))
        extra_perf_specs.append((pid, thumb, None, sig, (orig_idx, int(round(100 * rinfo["area"])), True)))

    # 5. Pack extra Perfected tiles into atlas_1.jpg, atlas_2.jpg ...
    n_extra = len(extra_perf_specs)
    n_extra_atlases = math.ceil(n_extra / per_atlas) if n_extra > 0 else 0
    atlas_imgs = [atlas_0]
    atlas_meta = [{
        "src": "data/atlas_0.jpg",
        "cols": atlas_cols,
        "rows": a0_rows,
        "tilePx": tile_px,
        "tier": "pure",
    }]

    for ei in range(n_extra_atlases):
        cnt = min(per_atlas, n_extra - ei * per_atlas)
        arows = math.ceil(cnt / atlas_cols)
        atlas_imgs.append(Image.new("RGB", (atlas_cols * tile_px, arows * tile_px), (28, 22, 18)))
        atlas_meta.append({
            "src": f"data/atlas_{ei + 1}.jpg",
            "cols": atlas_cols,
            "rows": arows,
            "tilePx": tile_px,
            "tier": "perfected",
        })

    # Perfected pool = ALL pure tiles + ALL extra rescued & sub-crop tiles!
    perfected_tiles_out = [dict(t) for t in pure_tiles_out]

    resc_pos_lookup = {spec_idx: pid for pid, spec_idx in rescued_tile_indices}
    for s_idx, (pid, thumb, cr, sig, _) in enumerate(extra_perf_specs):
        a_idx = 1 + (s_idx // per_atlas)
        local_i = s_idx % per_atlas
        ax = local_i % atlas_cols
        ay = local_i // atlas_cols
        atlas_imgs[a_idx].paste(thumb, (ax * tile_px, ay * tile_px))

        tile_obj = {
            "p": pid,
            "a": a_idx,
            "ax": ax,
            "ay": ay,
            "s": sig,
        }
        if cr is not None:
            tile_obj["cr"] = cr
        perfected_tiles_out.append(tile_obj)

        if s_idx in resc_pos_lookup:
            photos_out[pid]["a"] = a_idx
            photos_out[pid]["ax"] = ax
            photos_out[pid]["ay"] = ay

    # Optional visual sample contact sheet of newly generated Perfected sub-crops
    if args.sample_sheet:
        yolo_subs = [(thumb, dbg) for (_, thumb, cr, _, dbg) in extra_perf_specs if cr is not None and dbg[2]]
        cols_s, rows_s, sz = 10, 4, 120
        sheet = Image.new("RGB", (cols_s * sz, rows_s * sz), (24, 20, 16))
        step = max(1, len(yolo_subs) // (cols_s * rows_s))
        picks = yolo_subs[::step][:cols_s * rows_s]
        for k, (th, (oid, kpct, _)) in enumerate(picks):
            sq_s = th.resize((sz, sz), Image.Resampling.LANCZOS)
            dr = ImageDraw.Draw(sq_s)
            dr.rectangle([0, 0, 74, 15], fill=(20, 16, 12))
            dr.text((3, 2), f"#{oid} {kpct}%", fill=(246, 241, 233))
            sheet.paste(sq_s, ((k % cols_s) * sz, (k // cols_s) * sz))
        sheet.save(args.sample_sheet, "JPEG", quality=88)
        print(f"  Saved sample sheet: {args.sample_sheet}")

    # 6. Save all atlases + previews
    total_kb = 0.0
    for ai, aim in enumerate(atlas_imgs):
        out_p = os.path.join(DATA_DIR, f"atlas_{ai}.jpg")
        aim.save(out_p, "JPEG", quality=84 if ai == 0 else 82, optimize=True)
        kb = os.path.getsize(out_p) / 1024.0
        total_kb += kb
        print(f"  atlas_{ai}.jpg ({atlas_meta[ai]['tier']}): {aim.size} ({kb:.1f} KB)")

    pv_path = os.path.join(DATA_DIR, "previews.jpg")
    pv_atlas.save(pv_path, "JPEG", quality=82, optimize=True)
    pv_kb = os.path.getsize(pv_path) / 1024.0
    total_kb += pv_kb
    print(f"  previews.jpg: {pv_atlas.size} ({pv_kb:.1f} KB)")

    resc_kb = sum(os.path.getsize(os.path.join(RESCUED_DIR, fn)) for fn in os.listdir(RESCUED_DIR)) / 1024.0
    total_kb += resc_kb
    print(f"  rescued/ ({resc_count} JPEGs): {resc_kb:.1f} KB")

    # 7. Pick ~180 strong Pure Maggie close-ups for featuredIds (Today's Dose works in BOTH modes!)
    scored = []
    for k, (_, _, im) in enumerate(pure_valid):
        w, h = im.size
        asp = w / max(1, h)
        if asp < 0.65 or asp > 1.55:
            continue
        g8 = im.resize((8, 8), Image.Resampling.BOX).tobytes()
        center_lums, edge_lums = [], []
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
        score = std_l * 1.1 + max(0.0, c_mean - e_mean) * 0.8 + center_warm * 3.5
        if mean_l < 55 or mean_l > 215:
            score -= 50
        scored.append((score, k))
    scored.sort(reverse=True)
    featured_ids = [k for _, k in scored[:min(180, len(scored))]]

    payload = {
        "version": 3,
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": total_photos,
        "pureCount": pure_count,
        "rescuedCount": resc_count,
        "featuredIds": featured_ids,
        "atlases": atlas_meta,
        "previewAtlas": {
            "src": "data/previews.jpg",
            "cols": pv_cols,
            "rows": pv_rows,
            "slotPx": slot_px,
        },
        "photos": photos_out,
        "pureTiles": pure_tiles_out,
        "perfectedTiles": perfected_tiles_out,
    }
    json_path = os.path.join(DATA_DIR, "photos.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    j_kb = os.path.getsize(json_path) / 1024.0
    total_kb += j_kb
    print(f"  photos.json: {j_kb:.1f} KB")
    print(f"Pure tiles: {len(pure_tiles_out)} | Perfected tiles: {len(perfected_tiles_out)}")
    print(f"TOTAL data/ pack size: {total_kb / 1024.0:.2f} MB")


if __name__ == "__main__":
    main()
