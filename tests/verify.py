#!/usr/bin/env python3
"""
Automated end-to-end Playwright verification for DDOM — Daily Dose of Maggie (Dual-Mode v3).
Checks:
  - Zero console / page / same-origin network errors
  - Multi-atlas v3 catalog loads cleanly in Pure Maggie mode (500+ untouched solo photos)
  - Photo-level target exclusion holds strictly in BOTH Pure Maggie and Perfected modes
  - Switching to Perfected mode activates 1,200+ strict <=50% Maggie crops & lowers avg color error
  - Deep zoom in Perfected mode (with custom tile.cr crops & HD sharpening) is rock-solid (shot_a == shot_b)
  - Clicking a tile opens HD Lightbox & recursive "Build Mosaic of This Photo" works
  - Switching back to Pure Maggie, Random Maggie, Grid 64 toggle, Gallery & Studio all work cleanly
  - Responsive mobile viewport (390x844) with centered mode switch, zero overlap & zero overflow
"""
import functools
import os
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = "/home/antigravity/.gemini/jetski/brain/v1/default/jetski_remote_agents_3p_devbox/4fb94050-232b-4b60-ae8d-c21d413f9373/scratch/ddom_v3_shots"
os.makedirs(SHOTS, exist_ok=True)


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def mosaic_summary(page):
    return page.evaluate("""() => {
      const m = window.__ddom.getMosaic();
      let selfUsed = 0;
      let croppedTilesUsed = 0;
      for (let i = 0; i < m.grid.length; i++) {
        const t = m.tiles[m.grid[i]];
        if (t.p === m.targetId) selfUsed++;
        if (t.cr) croppedTilesUsed++;
      }
      return {
        mode: m.mode,
        targetId: m.targetId,
        cols: m.cols,
        rows: m.rows,
        tilePool: m.tiles.length,
        uniqueUsed: m.uniqueUsed,
        selfUsed,
        croppedTilesUsed,
        avgErr: window.__ddom.getAvgColorError(),
        tintVal: parseInt(document.getElementById('harmony-slider').value, 10)
      };
    }""")


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

        pure_cnt = page.evaluate("() => window.__ddom.getPureTileCount()")
        perf_cnt = page.evaluate("() => window.__ddom.getPerfectedTileCount()")
        m_pure = mosaic_summary(page)

        check("Catalog loaded Pure & Perfected tile pools", pure_cnt >= 500 and perf_cnt > pure_cnt * 2,
              f"pure={pure_cnt}, perfected={perf_cnt}")
        check("Booted in Pure Maggie mode on Today's Dose",
              m_pure["mode"] == "pure" and m_pure["cols"] >= 20 and m_pure["rows"] >= 20,
              f"{m_pure['cols']}x{m_pure['rows']} using {m_pure['uniqueUsed']} photos, err={m_pure['avgErr']:.2f}")
        check("Pure Maggie: target photo excluded & zero cropped tiles",
              m_pure["selfUsed"] == 0 and m_pure["croppedTilesUsed"] == 0,
              f"self={m_pure['selfUsed']}, cropped={m_pure['croppedTilesUsed']}")

        no_overflow = page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth")
        check("Desktop: zero horizontal overflow", no_overflow)
        page.screenshot(path=os.path.join(SHOTS, "01_pure_daily.png"))

        # Switch to Perfected mode via visible toggle button!
        page.click('#mode-switch button[data-mode="perfected"]')
        page.wait_for_function("() => window.__ddom.getMosaic().mode === 'perfected'", timeout=10000)
        page.wait_for_timeout(1350)
        m_perf = mosaic_summary(page)

        check("Perfected mode activated on same Daily Dose portrait",
              m_perf["mode"] == "perfected" and m_perf["targetId"] == m_pure["targetId"],
              f"tilePool={m_perf['tilePool']}, croppedUsed={m_perf['croppedTilesUsed']}, tint={m_perf['tintVal']}%")
        check("Perfected mode: photo-level target exclusion holds across all crops",
              m_perf["selfUsed"] == 0, f"selfUsed={m_perf['selfUsed']}")
        check("Perfected mode: genuinely improves color accuracy over Pure Maggie",
              m_perf["avgErr"] < m_pure["avgErr"],
              f"pureErr={m_pure['avgErr']:.2f} -> perfErr={m_perf['avgErr']:.2f}")
        check("Perfected mode: uses <=50% color-perfected sub-crops & lowers default tint",
              m_perf["croppedTilesUsed"] > 100 and m_perf["tintVal"] == 10,
              f"croppedUsed={m_perf['croppedTilesUsed']}, tint={m_perf['tintVal']}%")
        page.screenshot(path=os.path.join(SHOTS, "02_perfected_daily.png"))

        # Deep zoom in Perfected mode (verify custom tile.cr crops render rock-solid with zero jumping!)
        for _ in range(6):
            page.click("#btn-zoom-in")
            page.wait_for_timeout(50)
        page.wait_for_timeout(2400)
        zoom_txt = page.locator("#btn-zoom-fit").inner_text()
        check("Perfected deep zoom renders zoomed Maggie crops", zoom_txt != "100%", f"zoom={zoom_txt}")
        shot_a = page.screenshot()
        page.wait_for_timeout(650)
        shot_b = page.screenshot()
        check("Perfected deep zoom rock-solid (zero tile jumping/glitching)", shot_a == shot_b)
        with open(os.path.join(SHOTS, "03_perfected_zoomed.png"), "wb") as f:
            f.write(shot_b)

        # Click center tile in Perfected mode to open Lightbox
        page.mouse.click(640, 400)
        page.wait_for_timeout(700)
        lb_open = not page.locator("#lightbox").is_hidden()
        check("Clicking Perfected tile opens HD Lightbox", lb_open)
        page.screenshot(path=os.path.join(SHOTS, "04_lightbox.png"))

        # Click "Build Mosaic of This Photo" inside Lightbox
        prev_tid = m_perf["targetId"]
        page.click("#lb-assemble")
        page.wait_for_timeout(1250)
        m_lb = mosaic_summary(page)
        check("Lightbox 'Build Mosaic of This Photo' switched target in Perfected mode",
              m_lb["targetId"] != prev_tid and m_lb["mode"] == "perfected" and m_lb["selfUsed"] == 0,
              f"#{prev_tid} -> #{m_lb['targetId']}")

        # Switch back to Pure Maggie + Random Maggie + Grid 64
        page.click('#mode-switch button[data-mode="pure"]')
        page.wait_for_function("() => window.__ddom.getMosaic().mode === 'pure'", timeout=10000)
        page.wait_for_timeout(1200)
        m_back = mosaic_summary(page)
        check("Switching back to Pure Maggie restores pure pool & 20% default tint",
              m_back["mode"] == "pure" and m_back["croppedTilesUsed"] == 0 and m_back["tintVal"] == 20,
              f"tint={m_back['tintVal']}%")

        page.click("#btn-random-maggie")
        page.wait_for_timeout(1200)
        m_rand = mosaic_summary(page)
        check("Random Maggie picked new pure photo & excluded self",
              m_rand["targetId"] != m_back["targetId"] and m_rand["selfUsed"] == 0,
              f"#{m_back['targetId']} -> #{m_rand['targetId']}")

        page.click('#grid-seg button[data-grid="64"]')
        page.wait_for_timeout(1200)
        m_64 = mosaic_summary(page)
        check("Grid size 64 toggle re-assembled cleanly", max(m_64["cols"], m_64["rows"]) == 64,
              f"{m_64['cols']}x{m_64['rows']}")

        # Gallery & Studio drawers
        page.click("#btn-gallery")
        page.wait_for_timeout(500)
        gal_count = page.locator("#gallery-grid .gal-item").count()
        check("Gallery modal populated Maggie tiles", gal_count >= 50, f"{gal_count} loaded")
        page.click("#gal-close")

        page.click("#btn-studio")
        page.wait_for_timeout(300)
        check("Studio drawer opened cleanly", not page.locator("#studio-backdrop").is_hidden())
        page.click("#studio-close")

        check("Desktop zero console/network errors", len(errors) == 0, str(errors))

        # Mobile 390x844 check (including Perfected mode switch!)
        mctx = br.new_context(viewport={"width": 390, "height": 844})
        mpage = mctx.new_page()
        mpage.on("pageerror", lambda e: mob_errors.append(f"pageerror: {e}"))
        mpage.on("console", lambda m: mob_errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        mpage.goto(url, wait_until="domcontentloaded")
        mpage.wait_for_function("() => window.__ddom && window.__ddom.getMosaic()", timeout=15000)
        mpage.wait_for_timeout(1200)
        mpage.click('#mode-switch button[data-mode="perfected"]')
        mpage.wait_for_function("() => window.__ddom.getMosaic().mode === 'perfected'", timeout=10000)
        mpage.wait_for_timeout(1250)

        mob_overflow = mpage.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth")
        mode_rect = mpage.evaluate("""() => {
          const r = document.getElementById('mode-switch').getBoundingClientRect();
          const b = document.getElementById('topbar').getBoundingClientRect();
          return { top: r.top, left: r.left, right: r.right, topbarBottom: b.bottom };
        }""")
        check("Mobile 390x844: zero horizontal overflow & mode pill visible on-screen",
              mob_overflow and mode_rect["left"] >= 0 and mode_rect["right"] <= 390,
              f"modeRect={mode_rect}")
        check("Mobile zero console/page errors", len(mob_errors) == 0, str(mob_errors))
        mpage.screenshot(path=os.path.join(SHOTS, "05_mobile_perfected.png"))

        mctx.close()
        ctx.close()
        br.close()

    srv.shutdown()
    print(f"\nSUMMARY: {passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
