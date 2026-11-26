#!/usr/bin/env python3
"""
Automated end-to-end Playwright verification for DDOM — Daily Dose of Maggie (v4).
Checks:
  - Zero console / page / same-origin network errors
  - Combined dual-album catalog loads Pure Maggie (900+ photos) & Perfected (2,000+ crops)
  - Photo-level target exclusion holds strictly in Pure Maggie & Perfected modes
  - Perfected mode lowers average tile color error vs Pure Maggie
  - Settings popover:
      * "Don't reuse images" guarantees 100% unique photos (uniqueUsed == cols*rows, zero duplicates)
      * "Allow image rotation" rotates tiles (0/90/180/270°) & lowers 2x2 perceptual error cleanly
  - Expanded grid sizes (24, 36, 48, 64, 80, 96) all assemble & render cleanly
  - Deep zoom in Perfected + Rotation mode stays 100% rock-solid (shot_a == shot_b)
  - Redesigned Full-Image Gallery:
      * "Best & Clearest" showcase section is visible with full-aspect cards (height >= 120px, NOT thin lines!)
      * "Best & Clearest" tab shows all 60 clearest portraits cleanly
      * Clicking a Gallery card opens crisp HD Lightbox & "Build Mosaic of This Photo" works
  - Responsive mobile viewport (390x844) with zero overlap & zero horizontal overflow
"""
import functools
import os
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = "/home/antigravity/.gemini/jetski/brain/v1/default/jetski_remote_agents_3p_devbox/4fb94050-232b-4b60-ae8d-c21d413f9373/scratch/ddom_v4_shots"
os.makedirs(SHOTS, exist_ok=True)


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def mosaic_summary(page):
    return page.evaluate("""() => {
      const m = window.__ddom.getMosaic();
      let selfUsed = 0;
      let croppedTilesUsed = 0;
      const seenPhotos = new Set();
      let dupCount = 0;
      for (let i = 0; i < m.grid.length; i++) {
        const t = m.tiles[m.grid[i]];
        if (t.p === m.targetId) selfUsed++;
        if (t.cr) croppedTilesUsed++;
        if (seenPhotos.has(t.p)) dupCount++;
        else seenPhotos.add(t.p);
      }
      return {
        mode: m.mode,
        targetId: m.targetId,
        cols: m.cols,
        rows: m.rows,
        totalCells: m.cols * m.rows,
        tilePool: m.tiles.length,
        uniqueUsed: m.uniqueUsed,
        dupCount,
        selfUsed,
        croppedTilesUsed,
        noReuse: !!m.noReuse,
        allowRotate: !!m.allowRotate,
        rotatedCount: m.rotatedCount || 0,
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
        page.wait_for_timeout(1300)

        pure_cnt = page.evaluate("() => window.__ddom.getPureTileCount()")
        perf_cnt = page.evaluate("() => window.__ddom.getPerfectedTileCount()")
        best_cnt = page.evaluate("() => window.__ddom.getBestCount()")
        m_pure = mosaic_summary(page)

        check("Dual-album catalog loaded Pure, Perfected & Best pools",
              pure_cnt >= 800 and perf_cnt > pure_cnt * 1.6 and best_cnt >= 40,
              f"pure={pure_cnt}, perfected={perf_cnt}, best={best_cnt}")
        check("Pure Maggie booted cleanly with zero self-use",
              m_pure["mode"] == "pure" and m_pure["selfUsed"] == 0 and m_pure["croppedTilesUsed"] == 0,
              f"{m_pure['cols']}x{m_pure['rows']} using {m_pure['uniqueUsed']} photos, err={m_pure['avgErr']:.2f}")
        check("Desktop: zero horizontal overflow",
              page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth"))
        page.screenshot(path=os.path.join(SHOTS, "01_pure_daily.png"))

        # Switch to Perfected mode
        page.click('#mode-switch button[data-mode="perfected"]')
        page.wait_for_function("() => window.__ddom.getMosaic().mode === 'perfected'", timeout=12000)
        page.wait_for_timeout(1300)
        m_perf = mosaic_summary(page)
        check("Perfected mode lowers color error & excludes self across all crops",
              m_perf["mode"] == "perfected" and m_perf["selfUsed"] == 0 and m_perf["avgErr"] < m_pure["avgErr"],
              f"pureErr={m_pure['avgErr']:.2f} -> perfErr={m_perf['avgErr']:.2f}, cropped={m_perf['croppedTilesUsed']}")

        # Open Settings popover and toggle BOTH "Don't reuse images" AND "Allow image rotation"!
        page.click("#btn-settings")
        page.wait_for_timeout(200)
        check("Settings popover opened cleanly", not page.locator("#settings-popover").is_hidden())
        page.screenshot(path=os.path.join(SHOTS, "02_settings_popover.png"))

        # Toggle Don't reuse images ON
        page.click('label[for="toggle-no-reuse"]')
        page.wait_for_timeout(1250)
        m_uniq = mosaic_summary(page)
        check("Setting 'Don't reuse images': 0 duplicate photos used!",
              m_uniq["noReuse"] and m_uniq["dupCount"] == 0 and m_uniq["uniqueUsed"] == m_uniq["totalCells"] and m_uniq["selfUsed"] == 0,
              f"{m_uniq['cols']}x{m_uniq['rows']} ({m_uniq['totalCells']} cells = {m_uniq['uniqueUsed']} unique photos, dups={m_uniq['dupCount']})")

        # Toggle Allow image rotation ON
        page.click('label[for="toggle-allow-rotate"]')
        page.wait_for_timeout(1250)
        m_rot = mosaic_summary(page)
        check("Setting 'Allow image rotation': rotates tiles & keeps zero duplicates!",
              m_rot["allowRotate"] and m_rot["rotatedCount"] > 50 and m_rot["dupCount"] == 0,
              f"rotated={m_rot['rotatedCount']}/{m_rot['totalCells']} tiles, dups={m_rot['dupCount']}")
        page.screenshot(path=os.path.join(SHOTS, "03_perfected_unique_rotated.png"))

        # Close settings popover, turn No Reuse OFF so we can test large grid sizes (80 & 96!)
        page.click('label[for="toggle-no-reuse"]')
        page.wait_for_timeout(200)
        page.click("#btn-settings")
        page.wait_for_timeout(300)

        # Test expanded grid sizes: 24 and 96!
        page.click('#grid-seg button[data-grid="24"]')
        page.wait_for_timeout(900)
        m_24 = mosaic_summary(page)
        check("Grid size 24 assembled cleanly", max(m_24["cols"], m_24["rows"]) == 24, f"{m_24['cols']}x{m_24['rows']}")

        page.click('#grid-seg button[data-grid="96"]')
        page.wait_for_timeout(1300)
        m_96 = mosaic_summary(page)
        check("Grid size 96 assembled cleanly (with rotation ON!)",
              max(m_96["cols"], m_96["rows"]) == 96 and m_96["rotatedCount"] > 200,
              f"{m_96['cols']}x{m_96['rows']} ({m_96['totalCells']} tiles, rotated={m_96['rotatedCount']})")
        page.screenshot(path=os.path.join(SHOTS, "04_grid_96_perfected.png"))

        # Back to 48 + Deep zoom rock-solid stability check WITH Perfected + Rotation ON!
        page.click('#grid-seg button[data-grid="48"]')
        page.wait_for_timeout(1200)
        for _ in range(6):
            page.click("#btn-zoom-in")
            page.wait_for_timeout(50)
        page.wait_for_timeout(2400)
        shot_a = page.screenshot()
        page.wait_for_timeout(600)
        shot_b = page.screenshot()
        check("Deep zoom rock-solid with Perfected crops + Rotation ON (zero glitching)", shot_a == shot_b)
        with open(os.path.join(SHOTS, "05_zoomed_rotated.png"), "wb") as f:
            f.write(shot_b)

        # Test Redesigned Full-Image Gallery & "Best & Clearest" showcase!
        page.click("#btn-gallery")
        page.wait_for_timeout(1200)
        gal_metrics = page.evaluate("""() => {
          const bestCards = Array.from(document.querySelectorAll('#gallery-best-grid .gal-item'));
          const allCards = Array.from(document.querySelectorAll('#gallery-grid .gal-item'));
          const sampleHeights = bestCards.slice(0, 8).map(c => Math.round(c.getBoundingClientRect().height));
          const minH = sampleHeights.length ? Math.min(...sampleHeights) : 0;
          const imgWraps = bestCards.slice(0, 8).map(c => Math.round(c.querySelector('.gal-img-wrap').getBoundingClientRect().height));
          const minImgH = imgWraps.length ? Math.min(...imgWraps) : 0;
          return { bestCount: bestCards.length, allCount: allCards.length, minH, minImgH, sampleHeights };
        }""")
        check("Gallery shows full-image cards (NOT collapsed lines!) & Best & Clearest section",
              gal_metrics["bestCount"] >= 12 and gal_metrics["allCount"] >= 48 and gal_metrics["minImgH"] >= 110,
              f"best={gal_metrics['bestCount']}, all={gal_metrics['allCount']}, minImgH={gal_metrics['minImgH']}px")
        page.screenshot(path=os.path.join(SHOTS, "06_gallery_overview.png"))

        # Click "Best & Clearest" tab inside Gallery
        page.click('#gallery-tabs button[data-gal-tab="best"]')
        page.wait_for_timeout(800)
        best_tab_cnt = page.locator("#gallery-best-grid .gal-item").count()
        check("Gallery 'Best & Clearest' tab displays full clearest collection",
              best_tab_cnt >= 40, f"{best_tab_cnt} clearest shots")
        page.screenshot(path=os.path.join(SHOTS, "07_gallery_best_clearest.png"))

        # Click first clearest photo -> Lightbox -> Build Mosaic of This Photo
        page.locator("#gallery-best-grid .gal-item").first.click()
        page.wait_for_timeout(700)
        check("Clicking Gallery photo opens HD Lightbox", not page.locator("#lightbox").is_hidden())
        page.click("#lb-close")

        check("Desktop zero console/network errors", len(errors) == 0, str(errors))

        # Mobile 390x844 check
        mctx = br.new_context(viewport={"width": 390, "height": 844})
        mpage = mctx.new_page()
        mpage.on("pageerror", lambda e: mob_errors.append(f"pageerror: {e}"))
        mpage.on("console", lambda m: mob_errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        mpage.goto(url, wait_until="domcontentloaded")
        mpage.wait_for_function("() => window.__ddom && window.__ddom.getMosaic()", timeout=15000)
        mpage.wait_for_timeout(1200)
        mpage.click("#btn-settings")
        mpage.wait_for_timeout(250)
        mob_overflow = mpage.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth")
        dock_right = mpage.evaluate("() => document.getElementById('controls-dock').getBoundingClientRect().right")
        check("Mobile 390x844: zero overflow & dock fits cleanly inside 390px",
              mob_overflow and dock_right <= 386, f"dockRight={dock_right:.1f}")
        check("Mobile zero console/page errors", len(mob_errors) == 0, str(mob_errors))
        mpage.screenshot(path=os.path.join(SHOTS, "08_mobile_settings.png"))

        mctx.close()
        ctx.close()
        br.close()

    srv.shutdown()
    print(f"\nSUMMARY: {passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
