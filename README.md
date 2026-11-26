# DDOM — Daily Dose of Maggie

An interactive, zoomable photo mosaic dedicated to Maggie.

Press **Random Maggie** (or explore **Today's Dose**) to watch hundreds of other photos of Maggie color-match and assemble into one giant portrait — then zoom all the way in to inspect any individual photo, view it in full resolution, or click **Build Mosaic of This Photo** to re-assemble the entire portrait around that photo.

## Two Mosaic Modes
- **Pure Maggie**: Uses only untouched solo Maggie photos (full original center-square framing, zero extra cropping, zero human faces).
- **Perfected**: Unlocks color-perfected Maggie crops — cropping up to 50% of an image while always keeping Maggie clearly framed — plus verified face-free cropped Maggie photos. More than doubles the tonal & directional sub-quadrant tile palette so the portrait locks onto natural color & contours with half the default tint.

## Features
- **Today's Daily Dose of Maggie**: Deterministic daily featured Maggie photo assembled live from all the other Maggie photos.
- **Instant Dynamic Random Assembly**: Press **Random Maggie** (or `R`) to pick a new Maggie photo and watch the tiles assemble in a staggered radial wave using 2×2 sub-quadrant perceptual color matching (Redmean weighted RGB) and photo-level spatial anti-repetition spacing.
- **Rock-Solid Smooth Pan & Zoom**: Zoom-adaptive color harmony (`0%–40%` slider) fades to `0%` pure untinted photos when zoomed in, with crop-exact lazy HD tile sharpening and visible-tile cache protection.
- **Interactive Grid Density**: Switch live between `36`, `48` (recommended default), and `64` tiles along the longer edge.
- **Lightbox & Recursive Assembly**: Click any tile to inspect the full-resolution photo, see where it lives on the portrait mini-map, or re-assemble the mosaic around that photo.
- **Hold to Compare & Poster Export**: Hold **Original** (or `Space`) to compare against the original photo, and download crisp ~3000px printable PNG posters from **Export / Studio**.

## Running Locally
Serve the repository directory over HTTP (e.g. `python3 -m http.server 8000`) and open `index.html`.
- Automated verification: `python3 tests/verify.py`
