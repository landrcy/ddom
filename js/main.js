/* DDOM — Daily Dose of Maggie: Dual-Mode Main Controller
   Loads the precomputed compact Maggie multi-atlas catalog (data/photos.json v3),
   supports two distinct modes:
     - "pure":      Full untouched solo Maggie photos (zero extra cropping)
     - "perfected": Expanded Maggie tile pool cropping up to 50% (always keeping Maggie
                    in frame) + verified face-free rescued Maggie photos for sharper accuracy
   Powers Today's Daily Dose, Random Maggie, recursive Lightbox, Gallery, and Studio. */
(function () {
  'use strict';

  var DDOM = window.DDOM;
  var canvas = document.getElementById('mosaic-canvas');
  var loaderEl = document.getElementById('stage-loader');
  var loaderText = document.getElementById('loader-text');
  var statsEl = document.getElementById('mosaic-stats');
  var hoverPill = document.getElementById('hover-pill');

  var modeSwitch = document.getElementById('mode-switch');
  var btnRandom = document.getElementById('btn-random-maggie');
  var btnDaily = document.getElementById('btn-daily-dose');
  var btnGallery = document.getElementById('btn-gallery');
  var btnStudio = document.getElementById('btn-studio');
  var brandReset = document.getElementById('reset-view-brand');

  var btnZoomOut = document.getElementById('btn-zoom-out');
  var btnZoomIn = document.getElementById('btn-zoom-in');
  var btnZoomFit = document.getElementById('btn-zoom-fit');
  var gridSeg = document.getElementById('grid-seg');
  var harmonySlider = document.getElementById('harmony-slider');
  var btnPeek = document.getElementById('btn-peek');

  var dailyCard = document.getElementById('daily-card');
  var dailyThumb = document.getElementById('daily-thumb');
  var dailyEyebrow = document.getElementById('daily-eyebrow');
  var dailyCaption = document.getElementById('daily-caption');
  var dailyOpenThumb = document.getElementById('daily-open-thumb');
  var dailyOpenLink = document.getElementById('daily-open-link');
  var dailyReplayLink = document.getElementById('daily-reassemble-link');
  var dailyDismiss = document.getElementById('daily-dismiss');

  var lbBackdrop = document.getElementById('lightbox');
  var lbClose = document.getElementById('lb-close');
  var lbPrev = document.getElementById('lb-prev');
  var lbNext = document.getElementById('lb-next');
  var lbImg = document.getElementById('lb-img');
  var lbKicker = document.getElementById('lb-kicker');
  var lbTitle = document.getElementById('lb-title');
  var lbSub = document.getElementById('lb-sub');
  var lbLocator = document.getElementById('lb-locator');
  var lbMinimapImg = document.getElementById('lb-minimap-img');
  var lbMinimapPin = document.getElementById('lb-minimap-pin');
  var lbAssemble = document.getElementById('lb-assemble');
  var lbLocate = document.getElementById('lb-locate');
  var lbOpenHd = document.getElementById('lb-open-hd');

  var galBackdrop = document.getElementById('gallery-modal');
  var galClose = document.getElementById('gal-close');
  var galGrid = document.getElementById('gallery-grid');
  var galSub = document.getElementById('gal-sub');
  var galFoot = document.getElementById('gallery-foot');
  var btnGalMore = document.getElementById('btn-gallery-more');

  var catalog = null;
  var atlasPromises = [];
  var mosaicStyle = 'pure'; /* 'pure' | 'perfected' */
  var userTouchedHarmony = false;
  var gridSize = 48;
  var antiRepeat = 3;
  var currentTargetId = 0;
  var currentSource = 'daily'; /* 'daily' | 'random' | 'picked' | 'custom' */
  var recentHistory = [];
  var lbState = { photoId: -1, cellIdx: -1 };
  var galleryRendered = 0;
  var GALLERY_PAGE = 96;

  function loadImg(src) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error('Failed to load ' + src)); };
      im.src = src;
    });
  }

  function ensureAtlas(idx) {
    if (!catalog) return Promise.resolve(null);
    if (catalog.atlasImgs[idx]) return Promise.resolve(catalog.atlasImgs[idx]);
    if (!atlasPromises[idx]) {
      atlasPromises[idx] = loadImg(catalog.atlases[idx].src).then(function (im) {
        catalog.atlasImgs[idx] = im;
        return im;
      });
    }
    return atlasPromises[idx];
  }

  function ensureModeAtlases(style) {
    if (!catalog) return Promise.resolve();
    var needed = [];
    for (var i = 0; i < catalog.atlases.length; i++) {
      if (style === 'perfected' || catalog.atlases[i].tier !== 'perfected') {
        needed.push(ensureAtlas(i));
      }
    }
    return Promise.all(needed);
  }

  /* Deterministic hash from today's local date (YYYY-MM-DD) for Daily Dose of Maggie */
  function todayKey() {
    var now = new Date();
    var y = now.getFullYear();
    var m = String(now.getMonth() + 1).padStart(2, '0');
    var d = String(now.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function hashString(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function getActivePhotoCount() {
    if (!catalog) return 0;
    return mosaicStyle === 'perfected' ? catalog.photos.length : catalog.pureCount;
  }

  function getDailyPhotoId(cat) {
    var pool = (cat.featuredIds && cat.featuredIds.length) ? cat.featuredIds : null;
    var h = hashString('ddom-maggie-' + todayKey());
    if (pool) return pool[h % pool.length];
    return h % cat.pureCount;
  }

  function formatDatePretty(iso) {
    if (!iso) return 'Maggie';
    var parts = iso.split('-');
    if (parts.length !== 3) return iso;
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var mi = parseInt(parts[1], 10) - 1;
    var day = parseInt(parts[2], 10);
    return (months[mi] || parts[1]) + ' ' + day + ', ' + parts[0];
  }

  function photoFullUrl(ph, size) {
    if (!ph) return '';
    if (ph.u) return ph.u + '=w' + (size || 1600) + '-no';
    return ph.src || ph.fullUrl || '';
  }

  function photoSquareThumbUrl(ph, size) {
    if (!ph) return '';
    if (ph.u) return ph.u + '=w' + (size || 240) + '-h' + (size || 240) + '-c-no';
    return ph.src || ph.fullUrl || '';
  }

  /* Extract a crisp dataURL thumbnail from the local atlas so UI cards never stall */
  function atlasThumbDataUrl(ph) {
    if (!catalog || !ph || typeof ph.a !== 'number') return photoSquareThumbUrl(ph, 200);
    var aImg = catalog.atlasImgs[ph.a];
    var am = catalog.atlases[ph.a];
    if (!aImg || !am) return photoSquareThumbUrl(ph, 200);
    var c = document.createElement('canvas');
    c.width = am.tilePx;
    c.height = am.tilePx;
    c.getContext('2d').drawImage(aImg, ph.ax * am.tilePx, ph.ay * am.tilePx, am.tilePx, am.tilePx, 0, 0, am.tilePx, am.tilePx);
    return c.toDataURL('image/jpeg', 0.85);
  }

  function syncModeButtons() {
    if (!modeSwitch) return;
    modeSwitch.querySelectorAll('.mode-btn').forEach(function (btn) {
      var active = btn.dataset.mode === mosaicStyle;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function applyDefaultHarmonyForMode(style) {
    if (userTouchedHarmony) return;
    var val = style === 'perfected' ? 10 : 20;
    harmonySlider.value = String(val);
    viewer.setHarmony(val / 100);
  }

  var viewer = DDOM.createViewer(canvas, {
    onZoomChange: function (pct) {
      btnZoomFit.textContent = pct + '%';
    },
    onHoverCell: function (cellIdx, sx, sy) {
      var m = viewer.getMosaic();
      if (cellIdx < 0 || !m) {
        hoverPill.classList.remove('visible');
        return;
      }
      var tid = m.grid[cellIdx];
      var tiles = m.tiles || m.photos;
      var tile = tiles[tid];
      var pid = tile && typeof tile.p === 'number' ? tile.p : tid;
      var ph = m.photos[pid];
      if (!ph) {
        hoverPill.classList.remove('visible');
        return;
      }
      var label = ph.d ? ('Maggie · ' + formatDatePretty(ph.d)) : (ph.caption || ('Maggie #' + (ph.id + 1)));
      hoverPill.textContent = label + ' · Click to inspect';
      hoverPill.style.left = Math.round(sx) + 'px';
      hoverPill.style.top = Math.round(sy) + 'px';
      hoverPill.classList.add('visible');
    },
    onClickCell: function (cellIdx) {
      var m = viewer.getMosaic();
      if (!m) return;
      var tid = m.grid[cellIdx];
      var tiles = m.tiles || m.photos;
      var tile = tiles[tid];
      var pid = tile && typeof tile.p === 'number' ? tile.p : tid;
      openLightbox(pid, cellIdx);
    }
  });

  function updateHudForMosaic(m, sourceKind) {
    var dateTxt = m.targetPhoto && m.targetPhoto.d ? formatDatePretty(m.targetPhoto.d) : (m.targetPhoto ? m.targetPhoto.caption : 'Maggie');
    if (m.mode === 'perfected') {
      statsEl.textContent =
        'Perfected · ' + m.cols + '×' + m.rows + ' · ' +
        m.uniqueUsed.toLocaleString() + ' Maggie photos (' +
        m.tiles.length.toLocaleString() + ' crops)';
    } else if (m.mode === 'custom') {
      statsEl.textContent =
        'Custom · ' + m.cols + '×' + m.rows + ' · ' +
        m.uniqueUsed.toLocaleString() + ' photos';
    } else {
      statsEl.textContent =
        'Pure · ' + m.cols + '×' + m.rows + ' · ' +
        m.uniqueUsed.toLocaleString() + ' untouched Maggie photos';
    }

    dailyCard.classList.remove('hidden-card');
    if (sourceKind === 'daily') {
      dailyEyebrow.textContent = "Today's Dose · " + formatDatePretty(todayKey());
    } else if (sourceKind === 'random') {
      dailyEyebrow.textContent = 'Random Maggie #' + (m.targetId + 1);
    } else if (sourceKind === 'picked') {
      dailyEyebrow.textContent = 'Maggie #' + (m.targetId + 1);
    } else {
      dailyEyebrow.textContent = 'Custom Mosaic';
    }
    dailyCaption.textContent = dateTxt;
    if (m.targetId >= 0 && catalog && catalog.photos[m.targetId]) {
      dailyThumb.src = atlasThumbDataUrl(catalog.photos[m.targetId]);
    } else if (m.targetPhoto && m.targetPhoto.fullUrl) {
      dailyThumb.src = m.targetPhoto.fullUrl;
    }
  }

  function assemblePhoto(photoId, sourceKind, animate) {
    if (!catalog) return;
    /* Keep Pure Maggie strictly within untouched solo photos */
    if (mosaicStyle === 'pure' && photoId >= catalog.pureCount) {
      photoId = getDailyPhotoId(catalog);
    }
    currentTargetId = photoId;
    currentSource = sourceKind || 'random';

    var m = DDOM.engine.assembleFromCatalog(catalog, photoId, gridSize, antiRepeat, mosaicStyle);
    viewer.setMosaic(m, animate !== false);
    updateHudForMosaic(m, currentSource);
  }

  async function setMosaicStyle(nextStyle, animate) {
    nextStyle = nextStyle === 'perfected' ? 'perfected' : 'pure';
    if (nextStyle === mosaicStyle && viewer.getMosaic()) return;
    mosaicStyle = nextStyle;
    syncModeButtons();
    applyDefaultHarmonyForMode(mosaicStyle);

    /* Reset gallery DOM so it shows the active mode's photo set next time it opens */
    galleryRendered = 0;
    galGrid.innerHTML = '';

    if (!catalog) return;
    var needsFetch = false;
    for (var i = 0; i < catalog.atlases.length; i++) {
      if (mosaicStyle === 'perfected' && !catalog.atlasImgs[i]) needsFetch = true;
    }
    if (needsFetch) {
      loaderText.textContent = 'Loading Perfected Maggie crops…';
      loaderEl.classList.remove('done');
    }
    await ensureModeAtlases(mosaicStyle);
    if (needsFetch) {
      loaderEl.classList.add('done');
    }

    if (currentSource !== 'custom') {
      var targetId = currentTargetId;
      if (mosaicStyle === 'pure' && targetId >= catalog.pureCount) {
        targetId = getDailyPhotoId(catalog);
        currentSource = 'daily';
      }
      assemblePhoto(targetId, currentSource, animate !== false);
    }
  }

  function pickRandomPhoto() {
    if (!catalog) return;
    var n = getActivePhotoCount();
    if (n < 2) return;
    var id = currentTargetId;
    var tries = 0;
    while ((id === currentTargetId || recentHistory.indexOf(id) >= 0) && tries < 40) {
      id = Math.floor(Math.random() * n);
      tries++;
    }
    recentHistory.push(id);
    if (recentHistory.length > Math.min(40, Math.floor(n * 0.5))) {
      recentHistory.shift();
    }
    assemblePhoto(id, 'random', true);
  }

  /* ---------- Lightbox ---------- */
  function openLightbox(photoId, cellIdx) {
    var m = viewer.getMosaic();
    if (!m) return;
    var ph = m.photos[photoId] || (catalog && catalog.photos[photoId]);
    if (!ph) return;

    lbState.photoId = photoId;
    lbState.cellIdx = typeof cellIdx === 'number' ? cellIdx : -1;

    lbImg.src = photoFullUrl(ph, 1600);
    lbImg.alt = ph.d ? ('Maggie on ' + formatDatePretty(ph.d)) : (ph.caption || 'Maggie');

    var poolTotal = m.isCatalogMode ? getActivePhotoCount() : m.photos.length;
    var kickerExtra = ph.pure === false ? ' · Cropped to Maggie' : '';
    lbKicker.textContent = 'Maggie Photo #' + (ph.id + 1) + ' of ' + poolTotal.toLocaleString() + kickerExtra;
    lbTitle.textContent = ph.d ? formatDatePretty(ph.d) : (ph.caption || ('Maggie #' + (ph.id + 1)));

    if (lbState.cellIdx >= 0) {
      var col = lbState.cellIdx % m.cols;
      var row = Math.floor(lbState.cellIdx / m.cols);
      var tileObj = (m.tiles || m.photos)[m.grid[lbState.cellIdx]];
      var cropNote = (m.mode === 'perfected' && tileObj && tileObj.cr) ? ' · Perfected ≤50% crop' : '';
      lbSub.textContent = 'Tile at Row ' + (row + 1) + ', Column ' + (col + 1) + ' of ' + m.cols + '×' + m.rows + cropNote;
      lbLocator.hidden = false;
      lbLocate.hidden = false;
      lbMinimapImg.src = m.refCanvas && m.refCanvas.toDataURL ? m.refCanvas.toDataURL('image/jpeg', 0.72) : (m.targetPhoto.fullUrl || '');
      lbMinimapPin.style.left = (((col + 0.5) / m.cols) * 100).toFixed(2) + '%';
      lbMinimapPin.style.top = (((row + 0.5) / m.rows) * 100).toFixed(2) + '%';
    } else {
      lbSub.textContent = (ph.w && ph.h) ? (ph.w + ' × ' + ph.h + (ph.pure === false ? ' cropped Maggie frame' : ' original')) : 'Maggie’s Archive';
      lbLocator.hidden = true;
      lbLocate.hidden = true;
    }

    lbAssemble.hidden = !catalog || photoId < 0 || photoId >= getActivePhotoCount();
    lbOpenHd.href = photoFullUrl(ph, 2400);
    lbBackdrop.hidden = false;
  }

  function closeLightbox() {
    lbBackdrop.hidden = true;
  }

  function stepLightbox(dir) {
    var m = viewer.getMosaic();
    if (!m || !m.photos.length) return;
    var count = m.isCatalogMode ? getActivePhotoCount() : m.photos.length;
    var nextId = (lbState.photoId + dir + count) % count;
    var tiles = m.tiles || m.photos;
    var foundCell = -1;
    for (var i = 0; i < m.grid.length; i++) {
      var t = tiles[m.grid[i]];
      var pid = t && typeof t.p === 'number' ? t.p : m.grid[i];
      if (pid === nextId) { foundCell = i; break; }
    }
    openLightbox(nextId, foundCell);
  }

  lbClose.addEventListener('click', closeLightbox);
  lbBackdrop.addEventListener('click', function (e) { if (e.target === lbBackdrop) closeLightbox(); });
  lbPrev.addEventListener('click', function () { stepLightbox(-1); });
  lbNext.addEventListener('click', function () { stepLightbox(1); });
  lbLocate.addEventListener('click', function () {
    var cell = lbState.cellIdx;
    closeLightbox();
    if (cell >= 0) viewer.flyToCell(cell);
  });
  lbAssemble.addEventListener('click', function () {
    var pid = lbState.photoId;
    closeLightbox();
    if (pid >= 0 && catalog) {
      assemblePhoto(pid, 'picked', true);
    }
  });

  /* ---------- Gallery Archive Modal ---------- */
  function appendGalleryBatch() {
    if (!catalog) return;
    var limit = getActivePhotoCount();
    var frag = document.createDocumentFragment();
    var end = Math.min(limit, galleryRendered + GALLERY_PAGE);
    for (var i = galleryRendered; i < end; i++) {
      (function (ph) {
        var card = document.createElement('button');
        card.type = 'button';
        card.className = 'gal-item';
        var img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = photoSquareThumbUrl(ph, 220);
        img.alt = ph.d ? ('Maggie ' + formatDatePretty(ph.d)) : ('Maggie #' + (ph.id + 1));
        var cap = document.createElement('span');
        cap.className = 'gal-cap';
        cap.textContent = ph.d ? formatDatePretty(ph.d) : ('Maggie #' + (ph.id + 1));
        card.appendChild(img);
        card.appendChild(cap);
        card.addEventListener('click', function () {
          galBackdrop.hidden = true;
          openLightbox(ph.id, -1);
        });
        frag.appendChild(card);
      })(catalog.photos[i]);
    }
    galGrid.appendChild(frag);
    galleryRendered = end;
    galFoot.hidden = galleryRendered >= limit;
  }

  function openGallery() {
    if (!catalog) return;
    var limit = getActivePhotoCount();
    if (mosaicStyle === 'perfected') {
      galSub.textContent = limit.toLocaleString() + ' Maggie photos (' + catalog.perfectedTiles.length.toLocaleString() + ' Perfected crops) — click any photo to inspect or assemble.';
    } else {
      galSub.textContent = limit.toLocaleString() + ' untouched solo photos of Maggie — click any photo to view full size or assemble a mosaic from it.';
    }
    if (galleryRendered === 0) appendGalleryBatch();
    galBackdrop.hidden = false;
  }

  btnGalMore.addEventListener('click', appendGalleryBatch);
  galClose.addEventListener('click', function () { galBackdrop.hidden = true; });
  galBackdrop.addEventListener('click', function (e) { if (e.target === galBackdrop) galBackdrop.hidden = true; });

  /* ---------- Wire Topbar & Dock Controls ---------- */
  if (modeSwitch) {
    modeSwitch.addEventListener('click', function (e) {
      var btn = e.target.closest('.mode-btn');
      if (!btn || !btn.dataset.mode) return;
      setMosaicStyle(btn.dataset.mode, true);
    });
  }

  btnRandom.addEventListener('click', pickRandomPhoto);
  btnDaily.addEventListener('click', function () {
    if (!catalog) return;
    assemblePhoto(getDailyPhotoId(catalog), 'daily', true);
  });
  btnGallery.addEventListener('click', openGallery);
  brandReset.addEventListener('click', function (e) {
    e.preventDefault();
    viewer.resetView(true);
  });

  btnZoomIn.addEventListener('click', function () { viewer.zoomIn(); });
  btnZoomOut.addEventListener('click', function () { viewer.zoomOut(); });
  btnZoomFit.addEventListener('click', function () { viewer.resetView(true); });

  gridSeg.addEventListener('click', function (e) {
    var b = e.target.closest('[data-grid]');
    if (!b) return;
    var next = parseInt(b.dataset.grid, 10);
    if (!next || next === gridSize) return;
    gridSize = next;
    gridSeg.querySelectorAll('.seg-btn').forEach(function (el) {
      el.classList.toggle('active', parseInt(el.dataset.grid, 10) === gridSize);
    });
    if (catalog && currentSource !== 'custom') {
      assemblePhoto(currentTargetId, currentSource, true);
    }
  });

  harmonySlider.addEventListener('input', function () {
    userTouchedHarmony = true;
    viewer.setHarmony(parseInt(harmonySlider.value, 10) / 100);
  });
  viewer.setHarmony(parseInt(harmonySlider.value, 10) / 100);

  function startPeek() { btnPeek.classList.add('active'); viewer.setPeek(true); }
  function stopPeek() { btnPeek.classList.remove('active'); viewer.setPeek(false); }
  btnPeek.addEventListener('pointerdown', startPeek);
  btnPeek.addEventListener('pointerup', stopPeek);
  btnPeek.addEventListener('pointerleave', stopPeek);
  btnPeek.addEventListener('pointercancel', stopPeek);

  function openCurrentOriginal() {
    var m = viewer.getMosaic();
    if (!m) return;
    if (m.targetId >= 0) openLightbox(m.targetId, -1);
  }
  dailyOpenThumb.addEventListener('click', openCurrentOriginal);
  dailyOpenLink.addEventListener('click', openCurrentOriginal);
  dailyReplayLink.addEventListener('click', function () {
    var m = viewer.getMosaic();
    if (m) viewer.setMosaic(m, true);
  });
  dailyDismiss.addEventListener('click', function () {
    dailyCard.classList.add('hidden-card');
  });

  /* Studio hook */
  var studio = DDOM.initStudio({
    viewer: viewer,
    getCatalog: function () { return catalog; },
    getMosaicStyle: function () { return mosaicStyle; },
    ensureModeAtlases: ensureModeAtlases,
    setGridDetail: function (cols, gap) {
      gridSize = cols;
      antiRepeat = gap;
      gridSeg.querySelectorAll('.seg-btn').forEach(function (el) {
        el.classList.toggle('active', parseInt(el.dataset.grid, 10) === gridSize);
      });
      if (catalog && currentSource !== 'custom') {
        assemblePhoto(currentTargetId, currentSource, true);
      }
    },
    applyCustomMosaic: function (m) {
      currentSource = 'custom';
      currentTargetId = -1;
      viewer.setMosaic(m, true);
      updateHudForMosaic(m, 'custom');
    }
  });
  btnStudio.addEventListener('click', function () { studio.open(); });

  /* Keyboard shortcuts */
  window.addEventListener('keydown', function (e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (!lbBackdrop.hidden) {
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') stepLightbox(-1);
      else if (e.key === 'ArrowRight') stepLightbox(1);
      return;
    }
    if (!galBackdrop.hidden) {
      if (e.key === 'Escape') galBackdrop.hidden = true;
      return;
    }
    if (studio.isOpen()) {
      if (e.key === 'Escape') studio.close();
      return;
    }
    if (e.key === ' ' && !e.repeat) {
      e.preventDefault();
      startPeek();
    } else if (e.key === 'r' || e.key === 'R') {
      pickRandomPhoto();
    } else if (e.key === '+' || e.key === '=') {
      viewer.zoomIn();
    } else if (e.key === '-' || e.key === '_') {
      viewer.zoomOut();
    } else if (e.key === '0') {
      viewer.resetView(true);
    }
  });

  window.addEventListener('keyup', function (e) {
    if (e.key === ' ') stopPeek();
  });

  function hydrateTileList(rawList) {
    var out = new Array(rawList.length);
    for (var i = 0; i < rawList.length; i++) {
      var t = rawList[i];
      var s = t.s;
      var f = new Float32Array(12);
      for (var k = 0; k < 12; k++) f[k] = s[k];
      out[i] = {
        p: t.p,
        a: t.a,
        ax: t.ax,
        ay: t.ay,
        cr: t.cr || null,
        sig: f
      };
    }
    return out;
  }

  /* Compute average tile-to-cell RGB error for quantitative Pure vs Perfected verification */
  function computeCurrentMosaicError() {
    var m = viewer.getMosaic();
    if (!m || !m.cellColors || !m.grid || !m.tiles) return null;
    var tot = 0;
    for (var i = 0; i < m.grid.length; i++) {
      var hex = m.cellColors[i];
      var r1 = parseInt(hex.slice(1, 3), 16);
      var g1 = parseInt(hex.slice(3, 5), 16);
      var b1 = parseInt(hex.slice(5, 7), 16);
      var s = m.tiles[m.grid[i]].sig;
      var r2 = (s[0] + s[3] + s[6] + s[9]) * 0.25;
      var g2 = (s[1] + s[4] + s[7] + s[10]) * 0.25;
      var b2 = (s[2] + s[5] + s[8] + s[11]) * 0.25;
      tot += Math.hypot(r1 - r2, g1 - g2, b1 - b2);
    }
    return tot / Math.max(1, m.grid.length);
  }

  /* ---------- Bootstrap Catalog & Assemble Today's Dose of Maggie ---------- */
  async function boot() {
    try {
      var qs = new URLSearchParams(location.search);
      if (qs.get('mode') === 'perfected') {
        mosaicStyle = 'perfected';
      }
      syncModeButtons();
      applyDefaultHarmonyForMode(mosaicStyle);

      loaderText.textContent = 'Loading Maggie’s photo archive…';
      var res = await fetch('data/photos.json?v=3');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();

      var pureCount = data.pureCount || data.photos.length;
      for (var i = 0; i < data.photos.length; i++) {
        var ph = data.photos[i];
        ph.id = i;
        ph.pure = ph.pure !== 0;
        ph.fullUrl = ph.u ? (ph.u + '=w1600-no') : (ph.src || '');
        ph.hdThumbUrl = ph.u ? (ph.u + '=w380-no') : (ph.src || '');
      }

      var pureTiles = hydrateTileList(data.pureTiles || []);
      var perfectedTiles = hydrateTileList(data.perfectedTiles || data.pureTiles || []);

      catalog = {
        photos: data.photos,
        pureCount: pureCount,
        rescuedCount: data.rescuedCount || 0,
        featuredIds: data.featuredIds || null,
        atlases: data.atlases,
        atlasImgs: new Array(data.atlases.length),
        previewAtlas: data.previewAtlas,
        previewImg: null,
        pureTiles: pureTiles,
        perfectedTiles: perfectedTiles
      };
      atlasPromises = new Array(data.atlases.length);

      loaderText.textContent = mosaicStyle === 'perfected'
        ? ('Loading ' + perfectedTiles.length.toLocaleString() + ' Perfected Maggie tiles…')
        : ('Loading ' + pureTiles.length.toLocaleString() + ' Pure Maggie tiles…');

      var pvPromise = loadImg(data.previewAtlas.src).then(function (im) {
        catalog.previewImg = im;
      });
      await Promise.all([ensureModeAtlases(mosaicStyle), pvPromise]);

      /* Quietly warm the Perfected atlases in the background so switching modes is instant */
      if (mosaicStyle === 'pure') {
        setTimeout(function () { ensureModeAtlases('perfected').catch(function () {}); }, 600);
      }

      var startId = getDailyPhotoId(catalog);
      var startSource = 'daily';
      if (qs.has('photo')) {
        var pid = parseInt(qs.get('photo'), 10);
        if (!isNaN(pid) && pid >= 0 && pid < getActivePhotoCount()) {
          startId = pid;
          startSource = 'picked';
        }
      } else if (qs.has('random')) {
        startId = Math.floor(Math.random() * getActivePhotoCount());
        startSource = 'random';
      }

      loaderText.textContent = 'Assembling Today’s Dose of Maggie…';
      assemblePhoto(startId, startSource, true);
      loaderEl.classList.add('done');

      /* Expose tiny debug handle for automated verification */
      window.__ddom = {
        getCatalogCount: function () { return catalog ? catalog.photos.length : 0; },
        getPureCount: function () { return catalog ? catalog.pureCount : 0; },
        getPureTileCount: function () { return catalog ? catalog.pureTiles.length : 0; },
        getPerfectedTileCount: function () { return catalog ? catalog.perfectedTiles.length : 0; },
        getMode: function () { return mosaicStyle; },
        setMode: function (m) { return setMosaicStyle(m, false); },
        getMosaic: function () { return viewer.getMosaic(); },
        getAvgColorError: computeCurrentMosaicError,
        pickRandom: pickRandomPhoto,
        assemble: assemblePhoto,
        zoomIn: function () { viewer.zoomIn(); },
        resetView: function () { viewer.resetView(false); },
        openLightbox: openLightbox
      };
    } catch (err) {
      loaderText.textContent = 'Could not load Maggie’s mosaic: ' + (err.message || err);
    }
  }

  boot();
})();
