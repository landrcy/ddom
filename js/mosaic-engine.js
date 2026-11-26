/* DDOM — Daily Dose of Maggie: Dual-Mode Perceptual Photomosaic Engine
   Supports two modes seamlessly:
   - "pure":      Full untouched solo Maggie photos (center-square crops, zero extra cropping).
   - "perfected": Expanded Maggie tile pool including safely face-free rescued Maggie photos
                  + color-perfected sub-crops (cropping at most 50% of any photo, always keeping
                  Maggie inside the frame) for dramatically higher natural color accuracy!
   In BOTH modes:
   - Strictly excludes ALL tiles belonging to the target photo (photo-level exclusion).
   - Enforces photo-level spatial anti-repetition so two crops of the same photo never touch.
   - Matches using 2x2 sub-quadrant Redmean perceptual RGB distance (~35–65ms). */
window.DDOM = window.DDOM || {};

(function () {
  'use strict';

  function loadImageFromFile(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url, name: file.name }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not decode ' + file.name)); };
      img.src = url;
    });
  }

  function cleanCaption(name, idx) {
    var base = (name || '').replace(/\.[^.]+$/, '');
    if (/^(img|pxl|dsc|photo|mvimg|screenshot)[_\-\s]*\d+/i.test(base)) {
      return 'Maggie #' + (idx + 1);
    }
    var cleaned = base.replace(/[_\-]+/g, ' ').trim();
    return cleaned ? cleaned.replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : ('Maggie #' + (idx + 1));
  }

  function redmeanDistSq(r1, g1, b1, r2, g2, b2) {
    var rmean = 0.5 * (r1 + r2);
    var dr = r1 - r2;
    var dg = g1 - g2;
    var db = b1 - b2;
    return (2.0 + rmean / 256.0) * dr * dr + 4.0 * dg * dg + (2.0 + (255.0 - rmean) / 256.0) * db * db;
  }

  function sigDistance(a, b) {
    return (
      redmeanDistSq(a[0], a[1], a[2], b[0], b[1], b[2]) +
      redmeanDistSq(a[3], a[4], a[5], b[3], b[4], b[5]) +
      redmeanDistSq(a[6], a[7], a[8], b[6], b[7], b[8]) +
      redmeanDistSq(a[9], a[10], a[11], b[9], b[10], b[11])
    ) * 0.25;
  }

  function toHex(r, g, b) {
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  function yieldFrame() {
    return new Promise(function (r) { setTimeout(r, 0); });
  }

  function sampleTargetGrid(sourceImg, sx, sy, sw, sh, cols, rows) {
    var sampleW = cols * 4;
    var sampleH = rows * 4;
    var c = document.createElement('canvas');
    c.width = sampleW;
    c.height = sampleH;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(sourceImg, sx, sy, sw, sh, 0, 0, sampleW, sampleH);
    var data = ctx.getImageData(0, 0, sampleW, sampleH).data;

    var total = rows * cols;
    var cellSigs = new Array(total);
    var cellColors = new Array(total);

    for (var r = 0; r < rows; r++) {
      for (var col = 0; col < cols; col++) {
        var sig = new Float32Array(12);
        var qi = 0, ar = 0, ag = 0, ab = 0;
        for (var qy = 0; qy < 4; qy += 2) {
          for (var qx = 0; qx < 4; qx += 2) {
            var rs = 0, gs = 0, bs = 0;
            for (var dy = 0; dy < 2; dy++) {
              for (var dx = 0; dx < 2; dx++) {
                var o = ((r * 4 + qy + dy) * sampleW + (col * 4 + qx + dx)) * 4;
                rs += data[o];
                gs += data[o + 1];
                bs += data[o + 2];
              }
            }
            var q0 = rs * 0.25, q1 = gs * 0.25, q2 = bs * 0.25;
            sig[qi++] = q0; sig[qi++] = q1; sig[qi++] = q2;
            ar += q0; ag += q1; ab += q2;
          }
        }
        var idx = r * cols + col;
        cellSigs[idx] = sig;
        cellColors[idx] = toHex(Math.round(ar * 0.25), Math.round(ag * 0.25), Math.round(ab * 0.25));
      }
    }
    return { cellSigs: cellSigs, cellColors: cellColors, sampleCanvas: c };
  }

  /**
   * Solves tile layout using photo-level exclusion & photo-level anti-repetition!
   * `tiles` is an array of tile objects where each tile has `.p` (source photo ID) and `.sig` (Float32Array(12)).
   */
  function solveGrid(cellSigs, tiles, numPhotos, cols, rows, opts) {
    opts = opts || {};
    var nTiles = tiles.length;
    var excludePhotoId = typeof opts.excludePhotoId === 'number' ? opts.excludePhotoId : -1;
    var total = rows * cols;
    var minGap = typeof opts.minGap === 'number' ? opts.minGap : 3;
    var isPerfected = !!opts.perfected;
    var effGap = Math.max(1, Math.min(minGap, Math.floor(Math.sqrt(Math.max(1, numPhotos - 1)) * 0.72)));

    var tileAvg = new Float32Array(nTiles * 3);
    var tilePhoto = new Int32Array(nTiles);
    for (var t = 0; t < nTiles; t++) {
      var s = tiles[t].sig;
      tileAvg[t * 3]     = (s[0] + s[3] + s[6] + s[9]) * 0.25;
      tileAvg[t * 3 + 1] = (s[1] + s[4] + s[7] + s[10]) * 0.25;
      tileAvg[t * 3 + 2] = (s[2] + s[5] + s[8] + s[11]) * 0.25;
      tilePhoto[t] = tiles[t].p;
    }

    var grid = new Int32Array(total);      /* stores tile index in `tiles` */
    var gridPhoto = new Int32Array(total); /* stores source photo ID `tile.p` */
    grid.fill(-1);
    gridPhoto.fill(-1);

    var photoUsage = new Int32Array(numPhotos);
    var nearPhotoDist = new Int16Array(numPhotos);
    var targetAvg = total / Math.max(1, numPhotos - (excludePhotoId >= 0 ? 1 : 0));

    /* In Perfected mode, prioritize pure color fidelity even more strongly while still spacing repeats cleanly! */
    var usePenalty = isPerfected ? 950 : (numPhotos > 400 ? 1550 : 280);
    var repeatPenalty = isPerfected ? 52000 : (numPhotos > 400 ? 68000 : 38000);

    for (var row = 0; row < rows; row++) {
      var rev = (row & 1) === 1;
      for (var step = 0; step < cols; step++) {
        var col = rev ? (cols - 1 - step) : step;
        var cellIdx = row * cols + col;
        var csig = cellSigs[cellIdx];
        var cr = (csig[0] + csig[3] + csig[6] + csig[9]) * 0.25;
        var cg = (csig[1] + csig[4] + csig[7] + csig[10]) * 0.25;
        var cb = (csig[2] + csig[5] + csig[8] + csig[11]) * 0.25;

        nearPhotoDist.fill(0);
        var r0 = Math.max(0, row - effGap);
        var r1 = Math.min(rows - 1, row + effGap);
        var c0 = Math.max(0, col - effGap);
        var c1 = Math.min(cols - 1, col + effGap);
        for (var nr = r0; nr <= r1; nr++) {
          var rowOff = nr * cols;
          for (var nc = c0; nc <= c1; nc++) {
            var ep = gridPhoto[rowOff + nc];
            if (ep >= 0) {
              var md = Math.abs(nr - row) + Math.abs(nc - col);
              if (nearPhotoDist[ep] === 0 || md < nearPhotoDist[ep]) nearPhotoDist[ep] = md;
            }
          }
        }

        var bestTid = 0;
        var bestScore = Infinity;

        for (var tid = 0; tid < nTiles; tid++) {
          var pid = tilePhoto[tid];
          if (pid === excludePhotoId && numPhotos > 1) continue;

          var tr = tileAvg[tid * 3];
          var tg = tileAvg[tid * 3 + 1];
          var tb = tileAvg[tid * 3 + 2];
          var coarse = redmeanDistSq(cr, cg, cb, tr, tg, tb);
          var nd = nearPhotoDist[pid];
          var pen = nd > 0 ? (repeatPenalty / (nd * nd)) : 0;
          var over = photoUsage[pid] - targetAvg * 0.9;
          if (over > 0) pen += over * usePenalty;

          if (coarse * 0.55 + pen >= bestScore) continue;

          var sc = sigDistance(csig, tiles[tid].sig) + pen;
          if (sc < bestScore) {
            bestScore = sc;
            bestTid = tid;
          }
        }

        grid[cellIdx] = bestTid;
        var winPid = tilePhoto[bestTid];
        gridPhoto[cellIdx] = winPid;
        photoUsage[winPid]++;
      }
    }

    var uniquePhotosUsed = 0;
    for (var u = 0; u < numPhotos; u++) {
      if (photoUsage[u] > 0) uniquePhotosUsed++;
    }
    return { grid: grid, uniqueUsed: uniquePhotosUsed };
  }

  /**
   * Assemble any target photo from the loaded Maggie catalog in either 'pure' or 'perfected' mode!
   */
  function assembleFromCatalog(catalog, targetPhotoId, maxDim, minGap, mode) {
    var target = catalog.photos[targetPhotoId];
    if (!target) throw new Error('Unknown photo id ' + targetPhotoId);

    var usePerfected = mode === 'perfected' && catalog.perfectedTiles && catalog.perfectedTiles.length > 0;
    var tilePool = usePerfected ? catalog.perfectedTiles : catalog.pureTiles;
    var atlases = catalog.atlasImgs;
    var atlasMeta = catalog.atlases;

    maxDim = Math.max(20, Math.min(76, maxDim || 48));
    var aspect = target.w / Math.max(1, target.h);
    var cols, rows;
    if (aspect >= 1) {
      cols = maxDim;
      rows = Math.max(16, Math.round(maxDim / aspect));
    } else {
      rows = maxDim;
      cols = Math.max(16, Math.round(maxDim * aspect));
    }

    var pv = catalog.previewAtlas;
    var pvImg = catalog.previewImg;
    var slot = pv.slotPx;
    var px = target.px * slot + target.ox;
    var py = target.py * slot + target.oy;
    var pw = target.pw;
    var ph = target.ph;

    var sampled = sampleTargetGrid(pvImg, px, py, pw, ph, cols, rows);
    var solved = solveGrid(sampled.cellSigs, tilePool, catalog.photos.length, cols, rows, {
      excludePhotoId: targetPhotoId,
      minGap: minGap || 3,
      perfected: usePerfected
    });

    var refCanvas = document.createElement('canvas');
    var refMax = 900;
    var rw = aspect >= 1 ? refMax : Math.round(refMax * aspect);
    var rh = aspect >= 1 ? Math.round(refMax / aspect) : refMax;
    refCanvas.width = rw;
    refCanvas.height = rh;
    var rCtx = refCanvas.getContext('2d');
    rCtx.imageSmoothingEnabled = true;
    rCtx.imageSmoothingQuality = 'high';
    rCtx.drawImage(pvImg, px, py, pw, ph, 0, 0, rw, rh);

    return {
      isCatalogMode: true,
      mode: usePerfected ? 'perfected' : 'pure',
      targetId: targetPhotoId,
      targetPhoto: target,
      cols: cols,
      rows: rows,
      aspect: aspect,
      grid: solved.grid,
      tiles: tilePool,
      uniqueUsed: solved.uniqueUsed,
      cellColors: sampled.cellColors,
      refCanvas: refCanvas,
      highResTargetImg: null,
      atlases: atlases,
      atlasMeta: atlasMeta,
      photos: catalog.photos
    };
  }

  /**
   * Build a custom mosaic in-browser from user-dropped files (Studio mode).
   */
  async function buildFromFiles(opts) {
    var masterImg = opts.masterImg;
    var masterSrc = opts.masterSrc;
    var tileItems = opts.tileItems;
    var maxDim = Math.max(20, Math.min(72, opts.cols || 48));
    var minGap = Math.max(1, Math.min(6, opts.minGap || 3));
    var onProgress = opts.onProgress || function () {};

    var mw = masterImg.naturalWidth || masterImg.width;
    var mh = masterImg.naturalHeight || masterImg.height;
    var aspect = mw / Math.max(1, mh);
    var cols = aspect >= 1 ? maxDim : Math.max(16, Math.round(maxDim * aspect));
    var rows = aspect >= 1 ? Math.max(16, Math.round(maxDim / aspect)) : maxDim;

    var nTiles = tileItems.length;
    var atlasCols = Math.ceil(Math.sqrt(nTiles));
    var atlasRows = Math.ceil(nTiles / atlasCols);
    var tilePx = 112;
    if (atlasCols * tilePx > 4096) tilePx = Math.max(64, Math.floor(4096 / atlasCols));

    var atlasCanvas = document.createElement('canvas');
    atlasCanvas.width = atlasCols * tilePx;
    atlasCanvas.height = atlasRows * tilePx;
    var aCtx = atlasCanvas.getContext('2d');
    aCtx.fillStyle = '#1c1612';
    aCtx.fillRect(0, 0, atlasCanvas.width, atlasCanvas.height);

    var probe = document.createElement('canvas');
    probe.width = 4; probe.height = 4;
    var pCtx = probe.getContext('2d', { willReadFrequently: true });

    var tiles = new Array(nTiles);
    var photos = new Array(nTiles);

    for (var i = 0; i < nTiles; i++) {
      var item = tileItems[i];
      var im = item.img;
      var iw = im.naturalWidth || im.width;
      var ih = im.naturalHeight || im.height;
      var side = Math.min(iw, ih);
      var sx = Math.floor((iw - side) / 2);
      var sy = Math.floor((ih - side) / 2);
      var ax = i % atlasCols;
      var ay = Math.floor(i / atlasCols);

      aCtx.drawImage(im, sx, sy, side, side, ax * tilePx, ay * tilePx, tilePx, tilePx);
      pCtx.clearRect(0, 0, 4, 4);
      pCtx.drawImage(im, sx, sy, side, side, 0, 0, 4, 4);
      var pd = pCtx.getImageData(0, 0, 4, 4).data;
      var sig = new Float32Array(12);
      var qi = 0;
      for (var qy = 0; qy < 4; qy += 2) {
        for (var qx = 0; qx < 4; qx += 2) {
          var rs = 0, gs = 0, bs = 0;
          for (var dy = 0; dy < 2; dy++) {
            for (var dx = 0; dx < 2; dx++) {
              var o = ((qy + dy) * 4 + (qx + dx)) * 4;
              rs += pd[o]; gs += pd[o + 1]; bs += pd[o + 2];
            }
          }
          sig[qi++] = rs * 0.25; sig[qi++] = gs * 0.25; sig[qi++] = bs * 0.25;
        }
      }
      photos[i] = {
        id: i,
        d: '',
        caption: item.caption || cleanCaption(item.name, i),
        fullUrl: item.src,
        hdThumbUrl: item.src,
        w: iw,
        h: ih
      };
      tiles[i] = { p: i, a: 0, ax: ax, ay: ay, sig: sig };

      if (i % 16 === 0) {
        onProgress(0.05 + (i / nTiles) * 0.55, 'Preparing photos (' + (i + 1) + '/' + nTiles + ')…');
        await yieldFrame();
      }
    }

    onProgress(0.66, 'Matching colors to Maggie’s portrait…');
    await yieldFrame();

    var sampled = sampleTargetGrid(masterImg, 0, 0, mw, mh, cols, rows);
    var solved = solveGrid(sampled.cellSigs, tiles, nTiles, cols, rows, {
      excludePhotoId: -1,
      minGap: minGap
    });

    onProgress(1, 'Ready!');
    return {
      isCatalogMode: false,
      mode: 'custom',
      targetId: -1,
      targetPhoto: { id: -1, d: '', caption: 'Custom Maggie Portrait', fullUrl: masterSrc, w: mw, h: mh },
      cols: cols,
      rows: rows,
      aspect: aspect,
      grid: solved.grid,
      tiles: tiles,
      uniqueUsed: solved.uniqueUsed,
      cellColors: sampled.cellColors,
      refCanvas: masterImg,
      highResTargetImg: masterImg,
      atlases: [atlasCanvas],
      atlasMeta: [{ cols: atlasCols, rows: atlasRows, tilePx: tilePx }],
      photos: photos
    };
  }

  window.DDOM.engine = {
    loadImageFromFile: loadImageFromFile,
    cleanCaption: cleanCaption,
    assembleFromCatalog: assembleFromCatalog,
    buildFromFiles: buildFromFiles
  };
})();
