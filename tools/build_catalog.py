#!/usr/bin/env python3
"""
DDOM — Daily Dose of Maggie: Combined Dual-Album Dual-Mode Catalog Compiler (v4)
================================================================================
Combines Album 1 + Album 2 verified Maggie archives, removes exact & burst/near duplicates
(always keeping the sharper shot), ranks the Top 60 "Best & Clearest" Maggie portraits by
optical sharpness/clarity/framing, and compiles two mosaic pools:
  1. Pure Maggie  (pureTiles):      All verified solo untouched Maggie photos (center-square crops).
  2. Perfected    (perfectedTiles): Pure tiles + verified strict-<=50% face-free & person-free
                                    rescued Maggie photos + color-perfected <=50% Maggie sub-crops.

Atlases are tiered cleanly with zero duplication:
  - data/atlas_0..N.jpg (tier="pure")      : Pure Maggie tiles (loaded immediately on boot)
  - data/atlas_M..K.jpg (tier="perfected") : Extra Perfected tiles (warmed quietly in background)
  - data/rescued/r_*.jpg                   : Pre-cropped face-free rescued JPEGs (original URLs NEVER stored!)
  - data/previews.jpg                      : Aspect-preserving target-sampling atlas
  - data/photos.json                       : Version 4 metadata + bestIds + 2x2 RGB signatures + exact cr rects
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


def dhash_and_vec(im: Image.Image) -> tuple[int, list[int]]:
    g = im.convert("L").resize((9, 8), Image.Resampling.BILINEAR)
    px = list(g.tobytes())
    bits = 0
    for y in range(8):
        row = y * 9
        for x in range(8):
            bits = (bits << 1) | (1 if px[row + x] > px[row + x + 1] else 0)
    vec = list(im.resize((4, 4), Image.Resampling.BOX).tobytes())
    return bits, vec


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def vec_mae(a: list[int], b: list[int]) -> float:
    return sum(abs(x - y) for x, y in zip(a, b)) / float(len(a))


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


def generate_extra_crops(im: Image.Image, box, base_sig: list[int], max_extra: int = 2):
    """
    Generate up to `max_extra` color-diverse square sub-crops of `im` strictly keeping:
      - >= 50% of the original photo's area (<= 50% cropped)
      - Maggie clearly framed inside the crop
      - High 2x2 sub-quadrant color & gamut diversity vs the center square and siblings.
    """
    w, h = im.size
    orig_area = float(w * h)
    min_side = min(w, h)
    cx0, cy0, _ = center_square_rect(w, h)
    chosen_sigs = [base_sig]
    cands = []

    if box is None:
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
            if min_d < 21.0:
                continue
            r, g, b = avg_rgb(sig)
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            sat = max(r, g, b) - min(r, g, b)
            gamut_bonus = (
                max(0.0, 95.0 - lum) * 0.22
                + max(0.0, lum - 172.0) * 0.18
                + max(0.0, sat - 34.0) * 0.24
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


def compute_clarity_score(meta: dict, im: Image.Image, cm: dict | None, box) -> float:
    """
    Rank photos for the "Best & Clearest" gallery showcase:
      - High optical sharpness (Tenengrad gradient energy + Laplacian variance)
      - High native resolution (>= 1000px short edge, non-video still)
      - Clean balanced exposure & contrast (not murky/dark, not washed-out)
      - Clear, well-proportioned Maggie framing (YOLOv4 dog detection in sweet spot)
    """
    ow = meta.get("w") or im.size[0]
    oh = meta.get("h") or im.size[1]
    min_dim = min(ow, oh)
    asp = ow / max(1.0, float(oh))

    score = 0.0
    # 1. Optical sharpness & lighting clarity from OpenCV metrics
    if cm:
        tenen = min(14000.0, float(cm.get("tenen", 0.0)))
        lap = min(1400.0, float(cm.get("lap", 0.0)))
        lum = float(cm.get("lum", 120.0))
        std = float(cm.get("std", 45.0))
        score += math.sqrt(max(0.0, tenen)) * 0.95 + math.sqrt(max(0.0, lap)) * 1.15
        # Reward well-lit balanced exposure (95..185) and crisp tonal contrast (38..78)
        if 90 <= lum <= 188:
            score += 24.0
        elif lum < 68 or lum > 212:
            score -= 35.0
        if 36 <= std <= 82:
            score += 18.0
        elif std < 24:
            score -= 30.0
    else:
        score += 30.0

    # 2. Resolution & still-photo preference (avoid low-res video stills / extreme strips)
    if min_dim >= 1400:
        score += 26.0
    elif min_dim >= 900:
        score += 16.0
    elif min_dim < 550:
        score -= 35.0
    if meta.get("vid"):
        score -= 22.0
    if asp < 0.58 or asp > 1.78:
        score -= 25.0

    # 3. Clear Maggie subject framing from YOLOv4
    if box is not None:
        iw, ih = im.size
        bw = max(1.0, box[2] - box[0])
        bh = max(1.0, box[3] - box[1])
        area_frac = (bw * bh) / float(max(1, iw * ih))
        conf = float(box[4]) if len(box) > 4 else 0.4
        cid = int(box[5]) if len(box) > 5 else 16
        if cid == 16:  # true dog class
            score += conf * 48.0
        else:
            score += conf * 22.0
        # Sweet-spot portrait framing: Maggie occupies 14%..78% of the photo & centered nicely
        if 0.14 <= area_frac <= 0.78:
            score += 24.0
        elif area_frac < 0.06:
            score -= 18.0
        cx_rel = abs(0.5 * (box[0] + box[2]) / max(1, iw) - 0.5)
        cy_rel = abs(0.5 * (box[1] + box[3]) / max(1, ih) - 0.5)
        if cx_rel < 0.22 and cy_rel < 0.22:
            score += 14.0
    else:
        score -= 15.0

    return round(score, 2)


def download_rescued_hd(tag: str, url: str, cache_dir: str) -> str:
    os.makedirs(cache_dir, exist_ok=True)
    out = os.path.join(cache_dir, f"{tag}.jpg")
    if os.path.isfile(out) and os.path.getsize(out) > 2000:
        return out
    req = urllib.request.Request(f"{url}=w900-no", headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = resp.read()
    with open(out, "wb") as f:
        f.write(data)
    return out


def parse_id_set(s: str) -> set[int]:
    return {int(x) for x in s.split(",") if x.strip().isdigit()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index1", default="/tmp/maggie_album_index.json")
    ap.add_argument("--filter1", default="/tmp/maggie_filter_v3.json")
    ap.add_argument("--scan1", default="/tmp/maggie_perfected_scan.json")
    ap.add_argument("--previews1", required=True)
    ap.add_argument("--index2", default="/tmp/maggie_album2_index.json")
    ap.add_argument("--scan2", default="/tmp/maggie_album2_scan.json")
    ap.add_argument("--previews2", required=True)
    ap.add_argument("--rescued-cache-dir", required=True)
    ap.add_argument("--exclude-a1", default="243,269,471,572,727,880,1207,1265,1360,1397,1454")
    ap.add_argument("--exclude-a1-rescued", default="103,166,174,252,811,868,913,1428")
    ap.add_argument("--exclude-a2", default="371,372,381,425,457,472,493,526,579,585,631,740,741,804,869,1106,1307,1308,1331,1598,1674,1675,1796,1797,1896,1897,1901,1943,2037")
    ap.add_argument("--exclude-a2-rescued", default="776,1751")
    ap.add_argument("--tile-px", type=int, default=80)
    ap.add_argument("--slot-px", type=int, default=64)
    ap.add_argument("--max-extra-crops", type=int, default=2)
    ap.add_argument("--best-sheet", default="")
    args = ap.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.isdir(RESCUED_DIR):
        shutil.rmtree(RESCUED_DIR)
    os.makedirs(RESCUED_DIR, exist_ok=True)

    for fn in os.listdir(DATA_DIR):
        p = os.path.join(DATA_DIR, fn)
        if os.path.isfile(p) and (fn.startswith("atlas") or fn in ("mosaic.json", "master-thumb.jpg", "previews.jpg", "photos.json")):
            os.remove(p)

    alb1 = json.load(open(args.index1, "r", encoding="utf-8"))
    filt1 = json.load(open(args.filter1, "r", encoding="utf-8"))
    scan1 = json.load(open(args.scan1, "r", encoding="utf-8"))
    boxes1 = {int(k): v for k, v in scan1.get("maggie_boxes", {}).items()}

    alb2 = json.load(open(args.index2, "r", encoding="utf-8"))
    scan2 = json.load(open(args.scan2, "r", encoding="utf-8"))
    a1_clarity = {int(k): v for k, v in scan2.get("a1_clarity", {}).items()}
    a2_meta = {int(k): v for k, v in scan2.get("a2_meta", {}).items()}

    excl_a1 = parse_id_set(args.exclude_a1)
    excl_a1_resc = parse_id_set(args.exclude_a1_rescued)
    excl_a2 = parse_id_set(args.exclude_a2)
    excl_a2_resc = parse_id_set(args.exclude_a2_rescued)

    # 1. Gather all clean solo candidates from Album 1 + Album 2
    raw_candidates = []
    for idx in sorted(i for i in filt1["strict_kept"] if i not in excl_a1):
        p = os.path.join(args.previews1, f"{idx:04d}.jpg")
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
        cm = a1_clarity.get(idx)
        box = boxes1.get(idx)
        clarity = compute_clarity_score(alb1[idx], im, cm, box)
        dh, vec = dhash_and_vec(im)
        raw_candidates.append({
            "src_alb": 1,
            "orig": idx,
            "meta": alb1[idx],
            "im": im,
            "box": box,
            "cm": cm,
            "clarity": clarity,
            "dh": dh,
            "vec": vec,
            "ts": alb1[idx].get("ts") or 0,
        })

    for idx in sorted(i for i in scan2.get("a2_kept", []) if i not in excl_a2):
        p = os.path.join(args.previews2, f"{idx:04d}.jpg")
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
        m2 = a2_meta.get(idx, {})
        cm = m2.get("cm")
        box = m2.get("dog")
        clarity = compute_clarity_score(alb2[idx], im, cm, box)
        dh, vec = dhash_and_vec(im)
        raw_candidates.append({
            "src_alb": 2,
            "orig": idx,
            "meta": alb2[idx],
            "im": im,
            "box": box,
            "cm": cm,
            "clarity": clarity,
            "dh": dh,
            "vec": vec,
            "ts": alb2[idx].get("ts") or 0,
        })

    # 2. Global exact + burst/near-duplicate deduplication (always keeping the SHARPER photo!)
    # Process highest-clarity photos first so whenever two burst photos collide, the clearest shot wins!
    ordered_by_clarity = sorted(raw_candidates, key=lambda c: c["clarity"], reverse=True)
    dedup_pure = []
    dups_removed = 0
    for cand in ordered_by_clarity:
        is_dup = False
        c_dh, c_vec, c_ts = cand["dh"], cand["vec"], cand["ts"]
        for kept in dedup_pure:
            hd = hamming(c_dh, kept["dh"])
            if hd <= 7 and vec_mae(c_vec, kept["vec"]) < 12.5:
                is_dup = True
                break
            if c_ts and kept["ts"] and abs(c_ts - kept["ts"]) <= 6000 and hd <= 13 and vec_mae(c_vec, kept["vec"]) < 18.0:
                is_dup = True
                break
        if is_dup:
            dups_removed += 1
            continue
        dedup_pure.append(cand)

    # Sort back into a neat chronological / album order for consistent archive browsing
    dedup_pure.sort(key=lambda c: (c["ts"] or 0, c["src_alb"], c["orig"]), reverse=True)
    print(f"Combined pure candidates: {len(raw_candidates)} -> after burst/near-dup dedup: {len(dedup_pure)} (removed {dups_removed} duplicates)")

    # 3. Verified strict-50% rescued Maggie photos from Album 1 + Album 2
    rescued_valid = []
    for r in scan1.get("rescued", []):
        idx = int(r["idx"])
        if idx in excl_a1_resc or idx in excl_a1:
            continue
        x1, y1, x2, y2 = r["crop"]
        ow, oh = float(r["w"]), float(r["h"])
        max_sq = min(x2 - x1, y2 - y1)
        if (max_sq * max_sq) < 0.50 * (ow * oh):
            continue
        meta = alb1[idx]
        hd_path = download_rescued_hd(f"a1_{idx:04d}", meta["url"], args.rescued_cache_dir)
        hd_im = Image.open(hd_path).convert("RGB")
        hw, hh = hd_im.size
        cx1 = max(0, min(hw - 1, int(round((x1 / ow) * hw))))
        cy1 = max(0, min(hh - 1, int(round((y1 / oh) * hh))))
        cx2 = max(cx1 + 2, min(hw, int(round((x2 / ow) * hw))))
        cy2 = max(cy1 + 2, min(hh, int(round((y2 / oh) * hh))))
        cropped_hd = hd_im.crop((cx1, cy1, cx2, cy2))
        rel_src = f"data/rescued/r1_{idx:04d}.jpg"
        cropped_hd.save(os.path.join(ROOT, rel_src), "JPEG", quality=86, optimize=True)
        rescued_valid.append((1, idx, meta, cropped_hd, rel_src, r))

    for r in scan2.get("a2_rescued", []):
        idx = int(r["idx"])
        if idx in excl_a2_resc or idx in excl_a2:
            continue
        x1, y1, x2, y2 = r["crop"]
        ow, oh = float(r["w"]), float(r["h"])
        max_sq = min(x2 - x1, y2 - y1)
        if (max_sq * max_sq) < 0.50 * (ow * oh):
            continue
        meta = alb2[idx]
        hd_path = download_rescued_hd(f"a2_{idx:04d}", meta["url"], args.rescued_cache_dir)
        hd_im = Image.open(hd_path).convert("RGB")
        hw, hh = hd_im.size
        cx1 = max(0, min(hw - 1, int(round((x1 / ow) * hw))))
        cy1 = max(0, min(hh - 1, int(round((y1 / oh) * hh))))
        cx2 = max(cx1 + 2, min(hw, int(round((x2 / ow) * hw))))
        cy2 = max(cy1 + 2, min(hh, int(round((y2 / oh) * hh))))
        cropped_hd = hd_im.crop((cx1, cy1, cx2, cy2))
        # Deduplicate rescued crop against pure set too
        rdh, rvec = dhash_and_vec(cropped_hd)
        if any(hamming(rdh, k["dh"]) <= 7 and vec_mae(rvec, k["vec"]) < 13.0 for k in dedup_pure):
            continue
        rel_src = f"data/rescued/r2_{idx:04d}.jpg"
        cropped_hd.save(os.path.join(ROOT, rel_src), "JPEG", quality=86, optimize=True)
        rescued_valid.append((2, idx, meta, cropped_hd, rel_src, r))

    pure_count = len(dedup_pure)
    resc_count = len(rescued_valid)
    total_photos = pure_count + resc_count
    print(f"Pure Maggie photos: {pure_count} | Verified strict-50% rescued: {resc_count} | Total photos: {total_photos}")

    # 4. Pack Pure Maggie atlases (tier="pure", 28x28 = 784 tiles per 2240x2240 atlas at 80px!)
    tile_px = args.tile_px
    atlas_cols = 28 if tile_px <= 80 else 24
    per_atlas = atlas_cols * atlas_cols
    n_pure_atlases = math.ceil(pure_count / per_atlas)

    atlas_imgs = []
    atlas_meta = []
    for ai in range(n_pure_atlases):
        cnt = min(per_atlas, pure_count - ai * per_atlas)
        arows = math.ceil(cnt / atlas_cols)
        atlas_imgs.append(Image.new("RGB", (atlas_cols * tile_px, arows * tile_px), (28, 22, 18)))
        atlas_meta.append({
            "src": f"data/atlas_{ai}.jpg",
            "cols": atlas_cols,
            "rows": arows,
            "tilePx": tile_px,
            "tier": "pure",
        })

    # Preview atlas for ALL photos
    slot_px = args.slot_px
    pv_cols = math.ceil(math.sqrt(total_photos))
    pv_rows = math.ceil(total_photos / pv_cols)
    pv_atlas = Image.new("RGB", (pv_cols * slot_px, pv_rows * slot_px), (28, 22, 18))

    photos_out = []
    pure_tiles_out = []
    extra_perf_specs = []

    for k, cand in enumerate(dedup_pure):
        im = cand["im"]
        meta = cand["meta"]
        iw, ih = im.size
        a_idx = k // per_atlas
        local_i = k % per_atlas
        ax = local_i % atlas_cols
        ay = local_i // atlas_cols

        cx0, cy0, side = center_square_rect(iw, ih)
        sq = im.crop((cx0, cy0, cx0 + side, cy0 + side))
        thumb = sq.resize((tile_px, tile_px), Image.Resampling.LANCZOS)
        atlas_imgs[a_idx].paste(thumb, (ax * tile_px, ay * tile_px))
        sig = quad_sig_12(thumb)

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
            "orig": cand["orig"],
            "alb": cand["src_alb"],
            "d": d_str,
            "w": meta.get("w") or iw,
            "h": meta.get("h") or ih,
            "u": meta["url"],
            "pure": 1,
            "q": cand["clarity"],
            "a": a_idx,
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
            "a": a_idx,
            "ax": ax,
            "ay": ay,
            "s": sig,
        })

        extras = generate_extra_crops(im, cand["box"], sig, max_extra=args.max_extra_crops)
        for (rx, ry, rs), _ in extras:
            ethumb = im.crop((rx, ry, rx + rs, ry + rs)).resize((tile_px, tile_px), Image.Resampling.LANCZOS)
            cr = [round(rx / iw, 4), round(ry / ih, 4), round(rs / iw, 4), round(rs / ih, 4)]
            extra_perf_specs.append((k, ethumb, cr, quad_sig_12(ethumb)))

    # 5. Append rescued photos & their Perfected tiles
    rescued_tile_indices = []
    for r_i, (src_alb, orig_idx, meta, rim, rel_src, rinfo) in enumerate(rescued_valid):
        pid = pure_count + r_i
        rw, rh = rim.size
        cx0, cy0, side = center_square_rect(rw, rh)
        sq = rim.crop((cx0, cy0, cx0 + side, cy0 + side))
        thumb = sq.resize((tile_px, tile_px), Image.Resampling.LANCZOS)
        sig = quad_sig_12(thumb)

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

        photos_out.append({
            "orig": orig_idx,
            "alb": src_alb,
            "d": d_str,
            "w": rw,
            "h": rh,
            "src": rel_src,
            "pure": 0,
            "q": 40.0,
            "a": n_pure_atlases,
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
        extra_perf_specs.append((pid, thumb, None, sig))

    # 6. Pack extra Perfected tiles into tier="perfected" atlases
    n_extra = len(extra_perf_specs)
    n_extra_atlases = math.ceil(n_extra / per_atlas) if n_extra > 0 else 0
    for ei in range(n_extra_atlases):
        cnt = min(per_atlas, n_extra - ei * per_atlas)
        arows = math.ceil(cnt / atlas_cols)
        ai = n_pure_atlases + ei
        atlas_imgs.append(Image.new("RGB", (atlas_cols * tile_px, arows * tile_px), (28, 22, 18)))
        atlas_meta.append({
            "src": f"data/atlas_{ai}.jpg",
            "cols": atlas_cols,
            "rows": arows,
            "tilePx": tile_px,
            "tier": "perfected",
        })

    perfected_tiles_out = [dict(t) for t in pure_tiles_out]
    resc_pos_lookup = {spec_idx: pid for pid, spec_idx in rescued_tile_indices}

    for s_idx, (pid, thumb, cr, sig) in enumerate(extra_perf_specs):
        a_idx = n_pure_atlases + (s_idx // per_atlas)
        local_i = s_idx % per_atlas
        ax = local_i % atlas_cols
        ay = local_i // atlas_cols
        atlas_imgs[a_idx].paste(thumb, (ax * tile_px, ay * tile_px))

        tile_obj = {"p": pid, "a": a_idx, "ax": ax, "ay": ay, "s": sig}
        if cr is not None:
            tile_obj["cr"] = cr
        perfected_tiles_out.append(tile_obj)

        if s_idx in resc_pos_lookup:
            photos_out[pid]["a"] = a_idx
            photos_out[pid]["ax"] = ax
            photos_out[pid]["ay"] = ay

    # 7. Select Top 60 "Best & Clearest" shots (time-spaced so they show 60 diverse crystal-clear Maggie moments!)
    ranked_pure = sorted(range(pure_count), key=lambda k: dedup_pure[k]["clarity"], reverse=True)
    best_ids = []
    best_times = []
    for k in ranked_pure:
        ts = dedup_pure[k]["ts"]
        if ts and any(abs(ts - bt) < 20 * 60 * 1000 for bt in best_times):
            continue
        best_ids.append(k)
        if ts:
            best_times.append(ts)
        if len(best_ids) >= 60:
            break

    # Featured pool for Daily Dose: top ~200 clear well-balanced portraits
    featured_ids = ranked_pure[:min(200, len(ranked_pure))]

    if args.best_sheet and best_ids:
        cols_s, rows_s, sz = 10, 6, 128
        sheet = Image.new("RGB", (cols_s * sz, rows_s * sz), (24, 20, 16))
        for i, k in enumerate(best_ids[:cols_s * rows_s]):
            im = dedup_pure[k]["im"]
            w, h = im.size
            s = min(w, h)
            sq_s = im.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2)).resize((sz, sz), Image.Resampling.LANCZOS)
            dr = ImageDraw.Draw(sq_s)
            dr.rectangle([0, 0, 82, 16], fill=(20, 16, 12))
            dr.text((3, 2), f"#{i+1} A{dedup_pure[k]['src_alb']}#{dedup_pure[k]['orig']}", fill=(246, 241, 233))
            sheet.paste(sq_s, ((i % cols_s) * sz, (i // cols_s) * sz))
        sheet.save(args.best_sheet, "JPEG", quality=88)
        print(f"  Saved Best & Clearest sheet: {args.best_sheet}")

    # 8. Write all atlases, previews & photos.json (v4)
    total_kb = 0.0
    for ai, aim in enumerate(atlas_imgs):
        out_p = os.path.join(DATA_DIR, f"atlas_{ai}.jpg")
        aim.save(out_p, "JPEG", quality=83 if atlas_meta[ai]["tier"] == "pure" else 80, optimize=True)
        kb = os.path.getsize(out_p) / 1024.0
        total_kb += kb
        print(f"  atlas_{ai}.jpg ({atlas_meta[ai]['tier']}): {aim.size} ({kb:.1f} KB)")

    pv_path = os.path.join(DATA_DIR, "previews.jpg")
    pv_atlas.save(pv_path, "JPEG", quality=80, optimize=True)
    pv_kb = os.path.getsize(pv_path) / 1024.0
    total_kb += pv_kb
    print(f"  previews.jpg: {pv_atlas.size} ({pv_kb:.1f} KB)")

    resc_kb = sum(os.path.getsize(os.path.join(RESCUED_DIR, fn)) for fn in os.listdir(RESCUED_DIR)) / 1024.0 if os.listdir(RESCUED_DIR) else 0.0
    total_kb += resc_kb
    print(f"  rescued/ ({resc_count} JPEGs): {resc_kb:.1f} KB")

    payload = {
        "version": 4,
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": total_photos,
        "pureCount": pure_count,
        "rescuedCount": resc_count,
        "bestIds": best_ids,
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
    print(f"Pure tiles: {len(pure_tiles_out)} | Perfected tiles: {len(perfected_tiles_out)} | Best & Clearest: {len(best_ids)}")
    print(f"TOTAL data/ pack size: {total_kb / 1024.0:.2f} MB")


if __name__ == "__main__":
    main()
