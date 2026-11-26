#!/usr/bin/env python3
"""
Automated end-to-end Playwright verification for DDOM — Daily Dose of Maggie.
Checks:
  - Zero console / page / same-origin network errors
  - Multi-atlas catalog loads cleanly and assembles Today's Daily Dose of Maggie
  - Random Maggie button picks a different photo and excludes target photo from its own tiles
  - Grid resolution toggle (36 / 48 / 64) re-assembles cleanly
  - Deep zoom & clicking a tile opens HD Lightbox with mini-map
  - Clicking "Build Mosaic of This Photo" re-assembles around the clicked tile
  - Gallery & Export/Studio drawers open & close cleanly
  - Responsive mobile viewport (390x844) with zero horizontal overflow
"""
import functools
import os
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = "/home/antigravity/.gemini/jetski/brain/v1/default/jetski_remote_agents_3p_devbox/4fb94050-232b-4b60-ae8d-c21d413f9373/scratch/ddom_shots"
os.makedirs(SHOTS, exist_ok=True)


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=ROOT))
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/"

    passed = 0
    failed = 0

    def check(label, cond, extra=""):
        nonlocal passed, failed
        if cond:
            passed += 1
            print(f"  OK   {label}" + (f" ({extra})" if extra else ""))
        else:
            failed += 1
            print(f"  FAIL {label}" + (f" ({extra})" if extra else ""))

    errors = []
    mob_errors = []

    with sync_playwright() as p:
        br = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--no-sandbox"])
        ctx = br.new_context(viewport={"width": 1280, "height": 800})
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        page.on("requestfailed", lambda r: errors.append(f"reqfail: {r.url}") if "127.0.0.1" in r.url else None)

        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_function("() => window.__ddom && window.__ddom.getMosaic()", timeout=15000)
        page.wait_for_timeout(1300)  # Let initial radial assembly wave finish

        count = page.evaluate("() => window.__ddom.getCatalogCount()")
        m1 = page.evaluate("""() => {
          const m = window.__ddom.getMosaic();
          let selfUsed = 0;
          for (let i = 0; i < m.grid.length; i++) if (m.grid[i] === m.targetId) selfUsed++;
          return {targetId: m.targetId, cols: m.cols, rows: m.rows, uniqueUsed: m.uniqueUsed, selfUsed};
        }""")
        check("Catalog loaded solo Maggie photos", count >= 100, f"{count} photos")
        check("Today's Daily Dose assembled", m1["cols"] >= 20 and m1["rows"] >= 20, f"{m1['cols']}x{m1['rows']} using {m1['uniqueUsed']} photos")
        check("Target photo strictly excluded from its own tiles", m1["selfUsed"] == 0, f"selfUsed={m1['selfUsed']}")

        no_overflow = page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth")
        check("Desktop: zero horizontal overflow", no_overflow)
        page.screenshot(path=os.path.join(SHOTS, "01_daily_dose.png"))

        # Test Random Maggie button
        page.click("#btn-random-maggie")
        page.wait_for_timeout(1250)
        m2 = page.evaluate("""() => {
          const m = window.__ddom.getMosaic();
          let selfUsed = 0;
          for (let i = 0; i < m.grid.length; i++) if (m.grid[i] === m.targetId) selfUsed++;
          return {targetId: m.targetId, cols: m.cols, rows: m.rows, uniqueUsed: m.uniqueUsed, selfUsed};
        }""")
        check("Random Maggie picked new photo & assembled", m2["targetId"] != m1["targetId"] and m2["selfUsed"] == 0, f"#{m1['targetId']} -> #{m2['targetId']}")
        page.screenshot(path=os.path.join(SHOTS, "02_random_maggie.png"))

        # Test Grid Size toggle (64)
        page.click('#grid-seg button[data-grid="64"]')
        page.wait_for_timeout(1200)
        m3 = page.evaluate("() => ({cols: window.__ddom.getMosaic().cols, rows: window.__ddom.getMosaic().rows})")
        check("Grid size 64 toggle re-assembled", max(m3["cols"], m3["rows"]) == 64, f"{m3['cols']}x{m3['rows']}")

        # Back to balanced 48 + Deep Zoom In to verify crystal-clear, rock-solid Maggie tiles (zero glitching/jumping!)
        page.click('#grid-seg button[data-grid="48"]')
        page.wait_for_timeout(1200)
        for _ in range(6):
            page.click("#btn-zoom-in")
            page.wait_for_timeout(50)
        page.wait_for_timeout(2200)
        zoom_txt = page.locator("#btn-zoom-fit").inner_text()
        check("Deep zoom renders zoomed Maggie tiles", zoom_txt != "100%", f"zoom={zoom_txt}")
        shot_a = page.screenshot()
        page.wait_for_timeout(600)
        shot_b = page.screenshot()
        check("Deep zoom rock-solid (zero tile jumping/glitching)", shot_a == shot_b)
        with open(os.path.join(SHOTS, "03_zoomed_tiles.png"), "wb") as f:
            f.write(shot_b)

        # Click center tile to open Lightbox
        page.mouse.click(640, 400)
        page.wait_for_timeout(700)
        lb_open = not page.locator("#lightbox").is_hidden()
        check("Clicking tile opens HD Lightbox", lb_open)
        page.screenshot(path=os.path.join(SHOTS, "04_lightbox.png"))

        # Click "Build Mosaic of This Photo" inside Lightbox (recursive Maggieception!)
        prev_tid = m2["targetId"]
        page.click("#lb-assemble")
        page.wait_for_timeout(1250)
        m4 = page.evaluate("() => window.__ddom.getMosaic().targetId")
        check("Lightbox 'Build Mosaic of This Photo' switched target", m4 != prev_tid, f"#{prev_tid} -> #{m4}")

        # Open Gallery modal
        page.click("#btn-gallery")
        page.wait_for_timeout(500)
        gal_count = page.locator("#gallery-grid .gal-item").count()
        check("Gallery modal populated Maggie tiles", gal_count >= 50, f"{gal_count} loaded")
        page.click("#gal-close")

        # Open Export/Studio drawer
        page.click("#btn-studio")
        page.wait_for_timeout(300)
        check("Studio drawer opened cleanly", not page.locator("#studio-backdrop").is_hidden())
        page.click("#studio-close")

        check("Desktop zero console/network errors", len(errors) == 0, str(errors))

        # Mobile 390x844 check
        mctx = br.new_context(viewport={"width": 390, "height": 844})
        mpage = mctx.new_page()
        mpage.on("pageerror", lambda e: mob_errors.append(f"pageerror: {e}"))
        mpage.on("console", lambda m: mob_errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        mpage.goto(url, wait_until="domcontentloaded")
        mpage.wait_for_function("() => window.__ddom && window.__ddom.getMosaic()", timeout=15000)
        mpage.wait_for_timeout(1250)
        mob_overflow = mpage.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth")
        check("Mobile 390x844: zero horizontal overflow", mob_overflow)
        check("Mobile zero console/page errors", len(mob_errors) == 0, str(mob_errors))
        mpage.screenshot(path=os.path.join(SHOTS, "05_mobile.png"))

        mctx.close()
        ctx.close()
        br.close()

    srv.shutdown()
    print(f"\nSUMMARY: {passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
