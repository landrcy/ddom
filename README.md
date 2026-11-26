# DDOM — Daily Dose of Maggie

An interactive, zoomable photo mosaic dedicated to Maggie.

Press **Random Maggie** (or explore **Today's Dose**) to watch hundreds of other photos of Maggie color-match and assemble into one giant portrait — then zoom all the way in to inspect any individual photo, view it in full resolution, or click **Build Mosaic of This Photo** to re-assemble the entire portrait around that photo.

## Two Mosaic Modes
- **Pure Maggie**: Uses only untouched solo Maggie photos (full original center-square framing, zero extra cropping, deduplicated across albums).
- **Perfected**: Unlocks color-perfected Maggie crops — cropping up to 50% of an image while always keeping Maggie clearly framed — plus verified face-free cropped Maggie photos. Expands the tonal & directional sub-quadrant tile palette so the portrait locks onto natural color & contours with half the default tint.

## Mosaic Settings & Controls
- **Don't reuse images**: Strict 1-to-1 unique mode where every Maggie photo appears at most once (with salience-first cell ordering and automatic grid sizing when needed).
- **Allow image rotation**: Lets tiles rotate `90°`, `180°`, or `270°` to align edges and shadows 4× tighter without adding download size.
- **Extended Grid Densities**: Switch live between `24`, `36`, `48`, `64`, `80`, and `96` tiles along the longer edge (or fine-tune `16–112` in Studio).
- **Full-Image Gallery & Best & Clearest Showcase**: Browse every Maggie photo in full natural proportions (no square cropping) with a dedicated **Best & Clearest** section ranked by optical sharpness, clarity, and framing.
- **Rock-Solid Smooth Pan & Zoom**: Zoom-adaptive color harmony (`0%–40%` slider) fades to `0%` pure untinted photos when zoomed in, with crop-exact & rotation-exact lazy HD tile sharpening.
- **Hold to Compare & Poster Export**: Hold **Original** (or `Space`) to compare against the original photo, and download crisp ~3600px printable PNG posters from **Export / Studio**.

## Running Locally
Serve the repository directory over HTTP (e.g. `python3 -m http.server 8000`) and open `index.html`.
- Automated verification: `python3 tests/verify.py`
