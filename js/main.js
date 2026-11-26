/* DDOM — Daily Dose of Maggie: Main Controller
   Loads the precomputed compact Maggie multi-atlas catalog (data/photos.json),
   automatically assembles Today's Daily Dose of Maggie out of all the OTHER Maggie photos,
   powers the "Random Maggie" button, recursive "Build Mosaic of This Photo" Lightbox,
   Gallery archive, keyboard shortcuts, and smooth zoom/pan controls. */
(function () {
  'use strict';

  var DDOM = window.DDOM;
  var canvas = document.getElementById('mosaic-canvas');
  var loaderEl = document.getElementById('stage-loader');
  var loaderText = document.getElementById('loader-text');
  var statsEl = document.getElementById('mosaic-stats');
  var hoverPill = document.getElementById('hover-pill');

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
  var gridSize = 48;
  var antiRepeat = 3;
  var currentTargetId = 0;
  var currentMode = 'daily'; /* 'daily' | 'random' | 'picked' | 'custom' */
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

  function getDailyPhotoId(cat) {
    var pool = (cat.featuredIds && cat.featuredIds.length) ? cat.featuredIds : null;
    var h = hashString('ddom-maggie-' + todayKey());
    if (pool) return pool[h % pool.length];
    return h % cat.photos.length;
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
    return ph.fullUrl || '';
  }

  function photoSquareThumbUrl(ph, size) {
    if (!ph) return '';
    if (ph.u) return ph.u + '=w' + (size || 240) + '-h' + (size || 240) + '-c-no';
    return ph.fullUrl || '';
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
      var ph = m.photos[tid];
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
      openLightbox(tid, cellIdx);
    }
  });

  function updateHudForMosaic(m, mode) {
    var totalTiles = m.cols * m.rows;
    var dateTxt = m.targetPhoto && m.targetPhoto.d ? formatDatePretty(m.targetPhoto.d) : (m.targetPhoto ? m.targetPhoto.caption : 'Maggie');
    statsEl.textContent =
      m.cols + '×' + m.rows + ' (' + totalTiles.toLocaleString() + ' tiles) · ' +
      m.uniqueUsed.toLocaleString() + ' other Maggie photos';

    dailyCard.classList.remove('hidden-card');
    if (mode === 'daily') {
      dailyEyebrow.textContent = "Today's Dose · " + formatDatePretty(todayKey());
    } else if (mode === 'random') {
      dailyEyebrow.textContent = 'Random Maggie #' + (m.targetId + 1);
    } else if (mode === 'picked') {
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

  function assemblePhoto(photoId, mode, animate) {
    if (!catalog) return;
    currentTargetId = photoId;
    currentMode = mode || 'random';

    var m = DDOM.engine.assembleFromCatalog(catalog, photoId, gridSize, antiRepeat);
    viewer.setMosaic(m, animate !== false);
    updateHudForMosaic(m, currentMode);
  }

  function pickRandomPhoto() {
    if (!catalog || catalog.photos.length < 2) return;
    var n = catalog.photos.length;
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
    lbKicker.textContent = 'Maggie Photo #' + (ph.id + 1) + ' of ' + m.photos.length.toLocaleString();
    lbTitle.textContent = ph.d ? formatDatePretty(ph.d) : (ph.caption || ('Maggie #' + (ph.id + 1)));

    if (lbState.cellIdx >= 0) {
      var col = lbState.cellIdx % m.cols;
      var row = Math.floor(lbState.cellIdx / m.cols);
      lbSub.textContent = 'Tile at Row ' + (row + 1) + ', Column ' + (col + 1) + ' of ' + m.cols + '×' + m.rows;
      lbLocator.hidden = false;
      lbLocate.hidden = false;
      lbMinimapImg.src = m.refCanvas && m.refCanvas.toDataURL ? m.refCanvas.toDataURL('image/jpeg', 0.72) : (m.targetPhoto.fullUrl || '');
      lbMinimapPin.style.left = (((col + 0.5) / m.cols) * 100).toFixed(2) + '%';
      lbMinimapPin.style.top = (((row + 0.5) / m.rows) * 100).toFixed(2) + '%';
    } else {
      lbSub.textContent = (ph.w && ph.h) ? (ph.w + ' × ' + ph.h + ' original') : 'Maggie’s Archive';
      lbLocator.hidden = true;
      lbLocate.hidden = true;
    }

    lbAssemble.hidden = !catalog || photoId < 0 || photoId >= catalog.photos.length;
    lbOpenHd.href = photoFullUrl(ph, 2400);
    lbBackdrop.hidden = false;
  }

  function closeLightbox() {
    lbBackdrop.hidden = true;
  }

  function stepLightbox(dir) {
    var m = viewer.getMosaic();
    if (!m || !m.photos.length) return;
    var nextId = (lbState.photoId + dir + m.photos.length) % m.photos.length;
    var foundCell = -1;
    for (var i = 0; i < m.grid.length; i++) {
      if (m.grid[i] === nextId) { foundCell = i; break; }
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
    var frag = document.createDocumentFragment();
    var end = Math.min(catalog.photos.length, galleryRendered + GALLERY_PAGE);
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
    galFoot.hidden = galleryRendered >= catalog.photos.length;
  }

  function openGallery() {
    if (!catalog) return;
    galSub.textContent = catalog.photos.length.toLocaleString() + ' photos of Maggie — click any photo to view full size or assemble a mosaic from it.';
    if (galleryRendered === 0) appendGalleryBatch();
    galBackdrop.hidden = false;
  }

  btnGalMore.addEventListener('click', appendGalleryBatch);
  galClose.addEventListener('click', function () { galBackdrop.hidden = true; });
  galBackdrop.addEventListener('click', function (e) { if (e.target === galBackdrop) galBackdrop.hidden = true; });

  /* ---------- Wire Topbar & Dock Controls ---------- */
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
    if (catalog && currentMode !== 'custom') {
      assemblePhoto(currentTargetId, currentMode, true);
    }
  });

  harmonySlider.addEventListener('input', function () {
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
    setGridDetail: function (cols, gap) {
      gridSize = cols;
      antiRepeat = gap;
      gridSeg.querySelectorAll('.seg-btn').forEach(function (el) {
        el.classList.toggle('active', parseInt(el.dataset.grid, 10) === gridSize);
      });
      if (catalog && currentMode !== 'custom') {
        assemblePhoto(currentTargetId, currentMode, true);
      }
    },
    applyCustomMosaic: function (m) {
      currentMode = 'custom';
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

  /* ---------- Bootstrap Catalog & Assemble Today's Dose of Maggie ---------- */
  async function boot() {
    try {
      loaderText.textContent = 'Loading Maggie’s photo archive…';
      var res = await fetch('data/photos.json');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();

      loaderText.textContent = 'Loading ' + data.photos.length.toLocaleString() + ' Maggie tiles…';
      var imgPromises = data.atlases.map(function (a) { return loadImg(a.src); });
      imgPromises.push(loadImg(data.previewAtlas.src));
      var loadedImgs = await Promise.all(imgPromises);

      var atlasImgs = loadedImgs.slice(0, data.atlases.length);
      var previewImg = loadedImgs[loadedImgs.length - 1];

      /* Hydrate compact 12-float quadrant signatures & HD URLs */
      var tileSigs = new Array(data.photos.length);
      for (var i = 0; i < data.photos.length; i++) {
        var ph = data.photos[i];
        ph.id = i;
        ph.fullUrl = ph.u ? (ph.u + '=w1600-no') : (ph.src || '');
        ph.hdThumbUrl = ph.u ? (ph.u + '=w320-h320-c-no') : (ph.src || '');
        var s = ph.s;
        var f = new Float32Array(12);
        for (var k = 0; k < 12; k++) f[k] = s[k];
        tileSigs[i] = f;
      }

      catalog = {
        photos: data.photos,
        featuredIds: data.featuredIds || null,
        atlases: data.atlases,
        atlasImgs: atlasImgs,
        previewAtlas: data.previewAtlas,
        previewImg: previewImg,
        tileSigs: tileSigs
      };

      /* Support optional ?photo=N or ?random query param for sharing/testing */
      var qs = new URLSearchParams(location.search);
      var startId = getDailyPhotoId(catalog);
      var startMode = 'daily';
      if (qs.has('photo')) {
        var pid = parseInt(qs.get('photo'), 10);
        if (!isNaN(pid) && pid >= 0 && pid < catalog.photos.length) {
          startId = pid;
          startMode = 'picked';
        }
      } else if (qs.has('random')) {
        startId = Math.floor(Math.random() * catalog.photos.length);
        startMode = 'random';
      }

      loaderText.textContent = 'Assembling Today’s Dose of Maggie…';
      assemblePhoto(startId, startMode, true);
      loaderEl.classList.add('done');

      /* Expose tiny debug handle for automated verification */
      window.__ddom = {
        getCatalogCount: function () { return catalog ? catalog.photos.length : 0; },
        getMosaic: function () { return viewer.getMosaic(); },
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
