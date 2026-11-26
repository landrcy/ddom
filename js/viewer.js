/* DDOM — Interactive 60fps Zoomable Photomosaic Viewer
   Features:
   - Silky radial wave assembly animation when building a new Maggie photo
   - Butter-smooth wheel, trackpad pinch, drag pan, double-click zoom, touch pinch-zoom
   - Zoom-adaptive color harmony (accurate portrait at 100%, pure untinted photos when zoomed in)
   - Lazy HD tile sharpening when zoomed deep into individual Maggie tiles
   - Hold-to-Compare smooth crossfade to the crisp original Maggie photo
   - Printable high-resolution poster PNG export */
window.DDOM = window.DDOM || {};

(function () {
  'use strict';

  var RM = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function easeOutCubic(t) {
    var u = 1 - t;
    return 1 - u * u * u;
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function createViewer(canvas, callbacks) {
    var ctx = canvas.getContext('2d', { alpha: true });
    var cb = callbacks || {};

    var state = {
      mosaic: null,
      dpr: 1,
      vw: 0,
      vh: 0,
      /* World space: mosaic rectangle sits at (0, 0) .. (worldW, worldH) where each tile = 100 units */
      tileUnit: 100,
      worldW: 4800,
      worldH: 4800,
      /* Camera: world coordinate at viewport center + zoom (screen px per world unit) */
      camX: 2400,
      camY: 2400,
      zoom: 0.12,
      fitZoom: 0.12,
      minZoom: 0.05,
      maxZoom: 3.2,
      /* Visual controls */
      harmony: 0.22,
      peekTarget: 0,
      peekAlpha: 0,
      /* Interaction */
      hoverCell: -1,
      mouseX: 0,
      mouseY: 0,
      /* Animation */
      anim: null,         /* Radial assembly animation { t0, dur, delays, ox, oy } */
      tween: null,        /* Camera fly-to tween */
      dirty: true,
      rafId: 0,
      /* Lazy HD tile cache for deep zoom (photoId -> Image) */
      hdCache: new Map(),
      hdPending: new Set()
    };

    /* Pre-baked offscreen mosaic buffer for ultra-smooth 60fps panning when idle */
    var bakedCanvas = document.createElement('canvas');
    var bakedCtx = bakedCanvas.getContext('2d');
    var bakedReady = false;

    function resize() {
      state.dpr = Math.min(window.devicePixelRatio || 1, 2);
      state.vw = window.innerWidth;
      state.vh = window.innerHeight;
      canvas.width = Math.round(state.vw * state.dpr);
      canvas.height = Math.round(state.vh * state.dpr);
      computeFitBounds(false);
      state.dirty = true;
    }

    function computeFitBounds(resetCam) {
      if (!state.mosaic) return;
      state.worldW = state.mosaic.cols * state.tileUnit;
      state.worldH = state.mosaic.rows * state.tileUnit;

      var topPad = state.vw < 780 ? 74 : 84;
      var botPad = state.vw < 780 ? 112 : 94;
      var sidePad = state.vw < 780 ? 20 : 48;
      var availW = Math.max(160, state.vw - sidePad * 2);
      var availH = Math.max(160, state.vh - topPad - botPad);

      state.fitZoom = Math.min(availW / state.worldW, availH / state.worldH);
      state.minZoom = state.fitZoom * 0.72;
      /* Allow zooming until a single tile fills ~42% of the smaller viewport edge */
      state.maxZoom = Math.max(state.fitZoom * 18, (Math.min(state.vw, state.vh) * 0.48) / state.tileUnit);

      if (resetCam) {
        state.camX = state.worldW * 0.5;
        state.camY = state.worldH * 0.5 + ((topPad - botPad) * 0.5) / state.fitZoom * -0.35;
        state.zoom = state.fitZoom;
        notifyZoom();
      } else {
        state.zoom = clamp(state.zoom, state.minZoom, state.maxZoom);
      }
    }

    function bakeBaseMosaic() {
      var m = state.mosaic;
      if (!m) return;
      /* Bake at ~2200px max side so zoomed-out & mid-zoom rendering is buttery 60fps */
      var maxSide = 2200;
      var tileDraw = Math.max(16, Math.min(48, Math.floor(maxSide / Math.max(m.cols, m.rows))));
      bakedCanvas.width = m.cols * tileDraw;
      bakedCanvas.height = m.rows * tileDraw;
      bakedCtx.imageSmoothingEnabled = true;
      bakedCtx.imageSmoothingQuality = 'high';

      var grid = m.grid;
      var photos = m.photos;
      var atlases = m.atlases;
      var atlasMeta = m.atlasMeta;

      for (var r = 0; r < m.rows; r++) {
        var rowOff = r * m.cols;
        var dy = r * tileDraw;
        for (var c = 0; c < m.cols; c++) {
          var tid = grid[rowOff + c];
          var ph = photos[tid];
          if (!ph) continue;
          var aIdx = ph.a || 0;
          var aImg = atlases[aIdx];
          var am = atlasMeta[aIdx];
          if (!aImg || !am) continue;
          var tp = am.tilePx;
          bakedCtx.drawImage(aImg, ph.ax * tp, ph.ay * tp, tp, tp, c * tileDraw, dy, tileDraw, tileDraw);
        }
      }
      bakedReady = true;
    }

    function setMosaic(mosaic, animate) {
      state.mosaic = mosaic;
      state.hoverCell = -1;
      state.tween = null;
      bakedReady = false;
      bakeBaseMosaic();
      computeFitBounds(true);

      /* Kick off HD original image load in the background for Compare Peek */
      if (mosaic.targetPhoto && mosaic.targetPhoto.fullUrl && !mosaic.highResTargetImg) {
        var hi = new Image();
        hi.onload = function () {
          if (state.mosaic === mosaic) {
            mosaic.highResTargetImg = hi;
            state.dirty = true;
          }
        };
        hi.src = mosaic.targetPhoto.fullUrl;
      }

      if (animate && !RM) {
        var total = mosaic.cols * mosaic.rows;
        var delays = new Float32Array(total);
        var ox = new Float32Array(total);
        var oy = new Float32Array(total);
        var cx = (mosaic.cols - 1) * 0.5;
        var cy = (mosaic.rows - 1) * 0.5;
        var maxDist = Math.hypot(cx, cy) || 1;
        for (var r = 0; r < mosaic.rows; r++) {
          for (var c = 0; c < mosaic.cols; c++) {
            var idx = r * mosaic.cols + c;
            var dist = Math.hypot(c - cx, r - cy) / maxDist;
            /* Radial wave from center with gentle organic jitter */
            var h = Math.sin(idx * 12.9898 + 78.233) * 43758.5453;
            var rnd = h - Math.floor(h);
            delays[idx] = dist * 0.42 + rnd * 0.16;
            var ang = Math.atan2(r - cy, c - cx) + (rnd - 0.5) * 0.9;
            var throwDist = 75 + rnd * 150;
            ox[idx] = Math.cos(ang) * throwDist;
            oy[idx] = Math.sin(ang) * throwDist;
          }
        }
        state.anim = {
          t0: performance.now(),
          tileDur: 0.44,
          totalDur: 1.06,
          delays: delays,
          ox: ox,
          oy: oy
        };
      } else {
        state.anim = null;
      }
      state.dirty = true;
      ensureLoop();
    }

    function worldToScreen(wx, wy) {
      return [
        (wx - state.camX) * state.zoom + state.vw * 0.5,
        (wy - state.camY) * state.zoom + state.vh * 0.5
      ];
    }

    function screenToWorld(sx, sy) {
      return [
        state.camX + (sx - state.vw * 0.5) / state.zoom,
        state.camY + (sy - state.vh * 0.5) / state.zoom
      ];
    }

    function clampCamera() {
      var marginX = state.worldW * 0.35;
      var marginY = state.worldH * 0.35;
      state.camX = clamp(state.camX, -marginX, state.worldW + marginX);
      state.camY = clamp(state.camY, -marginY, state.worldH + marginY);
    }

    function notifyZoom() {
      if (cb.onZoomChange) {
        var rel = Math.round((state.zoom / Math.max(0.0001, state.fitZoom)) * 100);
        cb.onZoomChange(rel);
      }
    }

    function zoomAt(sx, sy, factor) {
      if (!state.mosaic) return;
      state.tween = null;
      var before = screenToWorld(sx, sy);
      var nextZoom = clamp(state.zoom * factor, state.minZoom, state.maxZoom);
      if (Math.abs(nextZoom - state.zoom) < 1e-6) return;
      state.zoom = nextZoom;
      state.camX = before[0] - (sx - state.vw * 0.5) / state.zoom;
      state.camY = before[1] - (sy - state.vh * 0.5) / state.zoom;
      clampCamera();
      notifyZoom();
      state.dirty = true;
      ensureLoop();
    }

    function flyTo(tx, ty, tz, ms) {
      if (!state.mosaic) return;
      var targetZ = clamp(tz, state.minZoom, state.maxZoom);
      if (RM || ms <= 10) {
        state.camX = tx;
        state.camY = ty;
        state.zoom = targetZ;
        clampCamera();
        notifyZoom();
        state.dirty = true;
        ensureLoop();
        return;
      }
      state.tween = {
        t0: performance.now(),
        ms: ms || 650,
        x0: state.camX,
        y0: state.camY,
        z0: state.zoom,
        x1: tx,
        y1: ty,
        z1: targetZ
      };
      state.dirty = true;
      ensureLoop();
    }

    function resetView(animate) {
      if (!state.mosaic) return;
      var topPad = state.vw < 780 ? 74 : 84;
      var botPad = state.vw < 780 ? 112 : 94;
      var cy = state.worldH * 0.5 + ((topPad - botPad) * 0.5) / state.fitZoom * -0.35;
      flyTo(state.worldW * 0.5, cy, state.fitZoom, animate === false ? 0 : 520);
    }

    function flyToCell(cellIdx) {
      var m = state.mosaic;
      if (!m || cellIdx < 0 || cellIdx >= m.cols * m.rows) return;
      var col = cellIdx % m.cols;
      var row = Math.floor(cellIdx / m.cols);
      var wx = (col + 0.5) * state.tileUnit;
      var wy = (row + 0.5) * state.tileUnit;
      var targetZ = clamp((Math.min(state.vw, state.vh) * 0.24) / state.tileUnit, state.fitZoom * 3.5, state.maxZoom);
      flyTo(wx, wy, targetZ, 780);
    }

    function hitCell(sx, sy) {
      var m = state.mosaic;
      if (!m) return -1;
      var w = screenToWorld(sx, sy);
      var col = Math.floor(w[0] / state.tileUnit);
      var row = Math.floor(w[1] / state.tileUnit);
      if (col < 0 || row < 0 || col >= m.cols || row >= m.rows) return -1;
      return row * m.cols + col;
    }

    function requestHdTile(ph) {
      if (!ph || !ph.hdThumbUrl || state.hdCache.has(ph.id) || state.hdPending.has(ph.id)) return;
      if (state.hdPending.size >= 10) return;
      state.hdPending.add(ph.id);
      var im = new Image();
      im.onload = function () {
        state.hdPending.delete(ph.id);
        if (state.hdCache.size > 160) {
          var firstKey = state.hdCache.keys().next().value;
          state.hdCache.delete(firstKey);
        }
        state.hdCache.set(ph.id, im);
        state.dirty = true;
        ensureLoop();
      };
      im.onerror = function () {
        state.hdPending.delete(ph.id);
      };
      im.src = ph.hdThumbUrl;
    }

    function drawFrame(now) {
      state.rafId = 0;
      var m = state.mosaic;
      if (!m) return;

      var keepRunning = false;

      /* Update camera tween */
      if (state.tween) {
        var tw = state.tween;
        var k = clamp((now - tw.t0) / tw.ms, 0, 1);
        var e = easeInOutCubic(k);
        state.camX = tw.x0 + (tw.x1 - tw.x0) * e;
        state.camY = tw.y0 + (tw.y1 - tw.y0) * e;
        state.zoom = Math.exp(Math.log(tw.z0) + (Math.log(tw.z1) - Math.log(tw.z0)) * e);
        notifyZoom();
        if (k >= 1) {
          state.tween = null;
        } else {
          keepRunning = true;
        }
        state.dirty = true;
      }

      /* Smooth peek crossfade */
      if (Math.abs(state.peekTarget - state.peekAlpha) > 0.004) {
        state.peekAlpha += (state.peekTarget - state.peekAlpha) * 0.22;
        if (Math.abs(state.peekTarget - state.peekAlpha) <= 0.004) {
          state.peekAlpha = state.peekTarget;
        } else {
          keepRunning = true;
        }
        state.dirty = true;
      }

      /* Check assembly animation */
      var animT = -1;
      if (state.anim) {
        animT = (now - state.anim.t0) / 1000;
        if (animT >= state.anim.totalDur) {
          state.anim = null;
          animT = -1;
        } else {
          keepRunning = true;
        }
        state.dirty = true;
      }

      if (!state.dirty) return;
      state.dirty = false;

      var dpr = state.dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, state.vw, state.vh);

      var tl = worldToScreen(0, 0);
      var br = worldToScreen(state.worldW, state.worldH);
      var mwPx = br[0] - tl[0];
      var mhPx = br[1] - tl[1];
      var tileScreenPx = state.tileUnit * state.zoom;

      /* Gallery matted frame behind the mosaic */
      var mat = Math.max(8, Math.min(22, mwPx * 0.024));
      ctx.save();
      ctx.shadowColor = 'rgba(38, 25, 14, 0.16)';
      ctx.shadowBlur = 42;
      ctx.shadowOffsetY = 16;
      ctx.fillStyle = '#fdfaf5';
      ctx.fillRect(tl[0] - mat, tl[1] - mat, mwPx + mat * 2, mhPx + mat * 2);
      ctx.restore();

      ctx.strokeStyle = 'rgba(58, 40, 26, 0.12)';
      ctx.lineWidth = 1;
      ctx.strokeRect(tl[0] - mat + 0.5, tl[1] - mat + 0.5, mwPx + mat * 2 - 1, mhPx + mat * 2 - 1);

      /* Inner warm dark backplate so animated gaps look intentional */
      ctx.fillStyle = '#1f1813';
      ctx.fillRect(tl[0], tl[1], mwPx, mhPx);

      /* Visible cell bounds */
      var visC0 = clamp(Math.floor((0 - tl[0]) / tileScreenPx) - 1, 0, m.cols - 1);
      var visC1 = clamp(Math.ceil((state.vw - tl[0]) / tileScreenPx) + 1, 0, m.cols - 1);
      var visR0 = clamp(Math.floor((0 - tl[1]) / tileScreenPx) - 1, 0, m.rows - 1);
      var visR1 = clamp(Math.ceil((state.vh - tl[1]) / tileScreenPx) + 1, 0, m.rows - 1);

      var atlases = m.atlases;
      var atlasMeta = m.atlasMeta;
      var photos = m.photos;
      var grid = m.grid;

      if (state.anim) {
        /* Silky radial wave assembly animation */
        var an = state.anim;
        ctx.save();
        ctx.beginPath();
        ctx.rect(tl[0] - mat, tl[1] - mat, mwPx + mat * 2, mhPx + mat * 2);
        ctx.clip();

        for (var r = visR0; r <= visR1; r++) {
          var rowOff = r * m.cols;
          for (var c = visC0; c <= visC1; c++) {
            var idx = rowOff + c;
            var p = clamp((animT - an.delays[idx]) / an.tileDur, 0, 1);
            if (p <= 0) continue;
            var ep = easeOutCubic(p);
            var tid = grid[idx];
            var ph = photos[tid];
            if (!ph) continue;
            var aIdx = ph.a || 0;
            var aImg = atlases[aIdx];
            var am = atlasMeta[aIdx];
            if (!aImg || !am) continue;

            var tp = am.tilePx;
            var cx2 = tl[0] + (c + 0.5) * tileScreenPx + an.ox[idx] * (1 - ep) * state.zoom;
            var cy2 = tl[1] + (r + 0.5) * tileScreenPx + an.oy[idx] * (1 - ep) * state.zoom;
            var sc = 0.32 + 0.68 * ep;
            var sz = tileScreenPx * sc;
            ctx.globalAlpha = Math.min(1, p * 1.45);
            ctx.drawImage(aImg, ph.ax * tp, ph.ay * tp, tp, tp, cx2 - sz * 0.5, cy2 - sz * 0.5, sz + 0.4, sz + 0.4);
          }
        }
        ctx.restore();
        ctx.globalAlpha = 1;
      } else if (bakedReady && tileScreenPx < 44) {
        /* Ultra-fast crisp overview & mid-zoom from baked buffer */
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bakedCanvas, tl[0], tl[1], mwPx, mhPx);
      } else {
        /* Crisp per-tile rendering + HD upgrade when zoomed deep into individual Maggie photos */
        var gap = tileScreenPx > 54 ? Math.min(2.5, (tileScreenPx - 54) * 0.04) : 0;
        var wantHd = tileScreenPx >= 96;

        for (var r2 = visR0; r2 <= visR1; r2++) {
          var rowOff2 = r2 * m.cols;
          var dy = tl[1] + r2 * tileScreenPx;
          for (var c2 = visC0; c2 <= visC1; c2++) {
            var idx2 = rowOff2 + c2;
            var tid2 = grid[idx2];
            var ph2 = photos[tid2];
            if (!ph2) continue;
            var dx = tl[0] + c2 * tileScreenPx;

            var hd = wantHd ? state.hdCache.get(ph2.id) : null;
            if (hd) {
              ctx.drawImage(hd, dx + gap * 0.5, dy + gap * 0.5, tileScreenPx - gap + 0.35, tileScreenPx - gap + 0.35);
            } else {
              var aIdx2 = ph2.a || 0;
              var aImg2 = atlases[aIdx2];
              var am2 = atlasMeta[aIdx2];
              if (aImg2 && am2) {
                var tp2 = am2.tilePx;
                ctx.drawImage(
                  aImg2,
                  ph2.ax * tp2, ph2.ay * tp2, tp2, tp2,
                  dx + gap * 0.5, dy + gap * 0.5,
                  tileScreenPx - gap + 0.35, tileScreenPx - gap + 0.35
                );
              }
              if (wantHd) requestHdTile(ph2);
            }
          }
        }
      }

      /* Zoom-adaptive color harmony glaze: makes the overall portrait razor-accurate at 100%,
         then gracefully dissolves to 0% as you zoom in past 2.2x so close-up photos stay 100% pure! */
      var relZoom = state.zoom / Math.max(0.0001, state.fitZoom);
      var zoomFade = clamp(1 - (relZoom - 1.3) / 1.9, 0, 1);
      var animFade = state.anim ? clamp((animT - 0.35) / 0.55, 0, 1) : 1;
      var glaze = state.harmony * zoomFade * animFade;
      var refImg = m.highResTargetImg || m.refCanvas;

      if (glaze > 0.005 && refImg) {
        ctx.save();
        ctx.globalAlpha = glaze;
        ctx.drawImage(refImg, tl[0], tl[1], mwPx, mhPx);
        ctx.restore();
      }

      /* Hold-to-Compare original Maggie photo crossfade */
      if (state.peekAlpha > 0.005 && refImg) {
        ctx.save();
        ctx.globalAlpha = state.peekAlpha;
        ctx.drawImage(refImg, tl[0], tl[1], mwPx, mhPx);
        ctx.restore();
      }

      /* Subtle hairline frame on hovered tile */
      if (state.hoverCell >= 0 && !state.anim && state.peekAlpha < 0.25) {
        var hc = state.hoverCell % m.cols;
        var hr = Math.floor(state.hoverCell / m.cols);
        var hx = tl[0] + hc * tileScreenPx;
        var hy = tl[1] + hr * tileScreenPx;
        ctx.save();
        ctx.strokeStyle = '#fffaf4';
        ctx.lineWidth = Math.max(1.5, Math.min(3, tileScreenPx * 0.04));
        ctx.shadowColor = 'rgba(0,0,0,0.45)';
        ctx.shadowBlur = 8;
        ctx.strokeRect(hx + 1, hy + 1, Math.max(2, tileScreenPx - 2), Math.max(2, tileScreenPx - 2));
        ctx.restore();
      }

      if (keepRunning) {
        state.rafId = requestAnimationFrame(drawFrame);
      }
    }

    function ensureLoop() {
      if (!state.rafId) {
        state.rafId = requestAnimationFrame(drawFrame);
      }
    }

    /* Export printable high-resolution Poster PNG (~3000px) */
    function exportPosterPng(filename) {
      var m = state.mosaic;
      if (!m) return;
      var maxSide = 3000;
      var tileOut = Math.max(36, Math.min(84, Math.floor(maxSide / Math.max(m.cols, m.rows))));
      var pad = Math.round(tileOut * 1.4);
      var outW = m.cols * tileOut + pad * 2;
      var outH = m.rows * tileOut + pad * 2;

      var oc = document.createElement('canvas');
      oc.width = outW;
      oc.height = outH;
      var og = oc.getContext('2d');
      og.fillStyle = '#f6f1e9';
      og.fillRect(0, 0, outW, outH);
      og.imageSmoothingEnabled = true;
      og.imageSmoothingQuality = 'high';

      for (var r = 0; r < m.rows; r++) {
        var rowOff = r * m.cols;
        for (var c = 0; c < m.cols; c++) {
          var ph = m.photos[m.grid[rowOff + c]];
          if (!ph) continue;
          var aIdx = ph.a || 0;
          var aImg = m.atlases[aIdx];
          var am = m.atlasMeta[aIdx];
          if (!aImg || !am) continue;
          var tp = am.tilePx;
          og.drawImage(aImg, ph.ax * tp, ph.ay * tp, tp, tp, pad + c * tileOut, pad + r * tileOut, tileOut, tileOut);
        }
      }

      if (state.harmony > 0.01 && m.refCanvas) {
        og.save();
        og.globalAlpha = state.harmony * 0.85;
        og.drawImage(m.refCanvas, pad, pad, m.cols * tileOut, m.rows * tileOut);
        og.restore();
      }

      var link = document.createElement('a');
      link.download = filename || 'daily-dose-of-maggie-mosaic.png';
      link.href = oc.toDataURL('image/png');
      link.click();
    }

    /* ---------- Pointer / Wheel / Touch Interaction ---------- */
    var pointers = new Map();
    var dragMoved = 0;
    var lastPinchDist = 0;

    canvas.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      dragMoved = 0;
      state.tween = null;
      if (pointers.size === 2) {
        var arr = Array.from(pointers.values());
        lastPinchDist = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
      }
      canvas.classList.add('dragging');
    });

    canvas.addEventListener('pointermove', function (e) {
      state.mouseX = e.clientX;
      state.mouseY = e.clientY;

      if (!pointers.has(e.pointerId)) {
        var cell = hitCell(e.clientX, e.clientY);
        if (cell !== state.hoverCell) {
          state.hoverCell = cell;
          canvas.classList.toggle('tile-hover', cell >= 0);
          state.dirty = true;
          ensureLoop();
        }
        if (cb.onHoverCell) cb.onHoverCell(cell, e.clientX, e.clientY);
        return;
      }

      var prev = pointers.get(e.pointerId);
      var dx = e.clientX - prev.x;
      var dy = e.clientY - prev.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      dragMoved += Math.abs(dx) + Math.abs(dy);

      if (pointers.size === 2) {
        var pts = Array.from(pointers.values());
        var dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        var midX = (pts[0].x + pts[1].x) * 0.5;
        var midY = (pts[0].y + pts[1].y) * 0.5;
        if (lastPinchDist > 1) {
          zoomAt(midX, midY, dist / lastPinchDist);
        }
        lastPinchDist = dist;
      } else if (pointers.size === 1) {
        state.camX -= dx / state.zoom;
        state.camY -= dy / state.zoom;
        clampCamera();
        state.dirty = true;
        ensureLoop();
      }
    });

    function endPointer(e, isCancel) {
      var wasSingle = pointers.size === 1;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) lastPinchDist = 0;
      if (pointers.size === 0) canvas.classList.remove('dragging');

      if (!isCancel && wasSingle && dragMoved < 7) {
        var cell = hitCell(e.clientX, e.clientY);
        if (cell >= 0 && cb.onClickCell) {
          cb.onClickCell(cell);
        }
      }
    }

    canvas.addEventListener('pointerup', function (e) { endPointer(e, false); });
    canvas.addEventListener('pointercancel', function (e) { endPointer(e, true); });
    canvas.addEventListener('pointerleave', function () {
      if (state.hoverCell !== -1) {
        state.hoverCell = -1;
        canvas.classList.remove('tile-hover');
        state.dirty = true;
        ensureLoop();
      }
      if (cb.onHoverCell) cb.onHoverCell(-1, 0, 0);
    });

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var delta = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaY;
      var factor = Math.exp(-delta * 0.0018);
      zoomAt(e.clientX, e.clientY, factor);
    }, { passive: false });

    canvas.addEventListener('dblclick', function (e) {
      var rel = state.zoom / Math.max(0.0001, state.fitZoom);
      if (rel > 3.5) {
        resetView(true);
      } else {
        var w = screenToWorld(e.clientX, e.clientY);
        flyTo(w[0], w[1], state.zoom * 2.6, 420);
      }
    });

    window.addEventListener('resize', resize);
    resize();

    return {
      setMosaic: setMosaic,
      getMosaic: function () { return state.mosaic; },
      zoomIn: function () { zoomAt(state.vw * 0.5, state.vh * 0.5, 1.45); },
      zoomOut: function () { zoomAt(state.vw * 0.5, state.vh * 0.5, 1 / 1.45); },
      resetView: resetView,
      flyToCell: flyToCell,
      setHarmony: function (v) {
        state.harmony = clamp(v, 0, 0.55);
        state.dirty = true;
        ensureLoop();
      },
      setPeek: function (on) {
        state.peekTarget = on ? 1 : 0;
        state.dirty = true;
        ensureLoop();
      },
      exportPosterPng: exportPosterPng
    };
  }

  window.DDOM.createViewer = createViewer;
})();
