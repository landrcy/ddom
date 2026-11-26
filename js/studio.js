/* DDOM — Export & Custom Studio Slide-Over Drawer */
window.DDOM = window.DDOM || {};

(function () {
  'use strict';

  function initStudio(app) {
    var backdrop = document.getElementById('studio-backdrop');
    var btnClose = document.getElementById('studio-close');
    var btnExport = document.getElementById('btn-export-png');
    var btnBuild = document.getElementById('btn-build-live');

    var dzMaster = document.getElementById('dz-master');
    var inMaster = document.getElementById('input-master');
    var masterPrevWrap = document.getElementById('master-preview-wrap');
    var masterPrevImg = document.getElementById('master-preview-img');
    var masterCopy = document.getElementById('master-dz-copy');

    var dzTiles = document.getElementById('dz-tiles');
    var inTiles = document.getElementById('input-tiles');
    var btnPickFolder = document.getElementById('btn-pick-folder');
    var inFolder = document.getElementById('input-tiles-folder');
    var tileCountBadge = document.getElementById('studio-tile-count');

    var colsSlider = document.getElementById('studio-cols');
    var colsVal = document.getElementById('studio-cols-val');
    var gapSlider = document.getElementById('studio-gap');
    var gapVal = document.getElementById('studio-gap-val');

    var progWrap = document.getElementById('studio-progress');
    var progFill = document.getElementById('studio-progress-fill');
    var progText = document.getElementById('studio-progress-text');

    var customMasterFile = null;
    var customTileFiles = [];
    var busy = false;

    function open() {
      backdrop.hidden = false;
      updateCounts();
    }

    function close() {
      if (busy) return;
      backdrop.hidden = true;
    }

    function updateCounts() {
      var cat = app.getCatalog();
      var style = app.getMosaicStyle ? app.getMosaicStyle() : 'pure';
      if (customTileFiles.length > 0) {
        tileCountBadge.textContent = customTileFiles.length + ' custom photos selected';
      } else if (cat) {
        if (style === 'perfected' && cat.perfectedTiles) {
          tileCountBadge.textContent = 'Using Maggie’s ' + cat.perfectedTiles.length.toLocaleString() + ' Perfected crops';
        } else {
          tileCountBadge.textContent = 'Using Maggie’s ' + (cat.pureCount || cat.photos.length).toLocaleString() + ' Pure photos';
        }
      }
    }

    function setMasterFile(file) {
      if (!file || !file.type.startsWith('image/')) return;
      customMasterFile = file;
      var url = URL.createObjectURL(file);
      masterPrevImg.src = url;
      masterPrevWrap.hidden = false;
      masterCopy.innerHTML = '<strong>' + file.name + '</strong><span>Ready to assemble</span>';
    }

    function addTileFiles(fileList) {
      var arr = [];
      for (var i = 0; i < fileList.length; i++) {
        var f = fileList[i];
        if (f && f.type && f.type.startsWith('image/')) arr.push(f);
      }
      if (!arr.length) return;
      customTileFiles = arr;
      updateCounts();
    }

    function wireDropzone(el, onFiles) {
      el.addEventListener('dragover', function (e) {
        e.preventDefault();
        el.classList.add('drag-over');
      });
      el.addEventListener('dragleave', function () {
        el.classList.remove('drag-over');
      });
      el.addEventListener('drop', function (e) {
        e.preventDefault();
        el.classList.remove('drag-over');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          onFiles(e.dataTransfer.files);
        }
      });
    }

    wireDropzone(dzMaster, function (files) { setMasterFile(files[0]); });
    wireDropzone(dzTiles, function (files) { addTileFiles(files); });

    inMaster.addEventListener('change', function () {
      if (inMaster.files && inMaster.files[0]) setMasterFile(inMaster.files[0]);
    });
    inTiles.addEventListener('change', function () {
      if (inTiles.files && inTiles.files.length) addTileFiles(inTiles.files);
    });
    btnPickFolder.addEventListener('click', function () { inFolder.click(); });
    inFolder.addEventListener('change', function () {
      if (inFolder.files && inFolder.files.length) addTileFiles(inFolder.files);
    });

    colsSlider.addEventListener('input', function () {
      colsVal.textContent = colsSlider.value + ' tiles';
    });
    gapSlider.addEventListener('input', function () {
      gapVal.textContent = gapSlider.value + ' cells';
    });

    btnExport.addEventListener('click', function () {
      var m = app.viewer.getMosaic();
      var stamp = (m && m.targetPhoto && m.targetPhoto.d) ? ('-' + m.targetPhoto.d) : '';
      app.viewer.exportPosterPng('daily-dose-of-maggie' + stamp + '.png');
    });

    btnBuild.addEventListener('click', async function () {
      if (busy) return;
      var cols = parseInt(colsSlider.value, 10) || 48;
      var gap = parseInt(gapSlider.value, 10) || 3;
      var cat = app.getCatalog();

      if (!customMasterFile && customTileFiles.length === 0) {
        /* Just rebuild current Maggie portrait with the chosen resolution & spacing! */
        app.setGridDetail(cols, gap);
        close();
        return;
      }

      busy = true;
      btnBuild.disabled = true;
      progWrap.hidden = false;
      progFill.style.width = '5%';
      progText.textContent = 'Reading photos…';

      try {
        var masterLoaded;
        if (customMasterFile) {
          masterLoaded = await window.DDOM.engine.loadImageFromFile(customMasterFile);
        } else {
          var cur = app.viewer.getMosaic();
          masterLoaded = { img: cur.refCanvas, url: cur.targetPhoto.fullUrl || '' };
        }

        var mosaic;
        if (customTileFiles.length >= 2) {
          var tileItems = [];
          for (var i = 0; i < customTileFiles.length; i++) {
            try {
              var loaded = await window.DDOM.engine.loadImageFromFile(customTileFiles[i]);
              tileItems.push({ img: loaded.img, src: loaded.url, name: loaded.name });
            } catch (err) {}
            if (i % 12 === 0) {
              progFill.style.width = Math.round(5 + (i / customTileFiles.length) * 35) + '%';
              progText.textContent = 'Loading custom photos (' + (i + 1) + '/' + customTileFiles.length + ')…';
            }
          }
          var curSettings = app.getSettings ? app.getSettings() : {};
          mosaic = await window.DDOM.engine.buildFromFiles({
            masterImg: masterLoaded.img,
            masterSrc: masterLoaded.url,
            tileItems: tileItems,
            cols: cols,
            minGap: gap,
            noReuse: !!curSettings.noReuse,
            allowRotate: !!curSettings.allowRotate,
            onProgress: function (p, msg) {
              progFill.style.width = Math.round(40 + p * 60) + '%';
              progText.textContent = msg;
            }
          });
        } else if (cat) {
          /* Build user's custom target photo using Maggie's archive in the active Pure/Perfected mode! */
          var activeStyle = app.getMosaicStyle ? app.getMosaicStyle() : 'pure';
          var activeSettings = app.getSettings ? app.getSettings() : {};
          if (app.ensureModeAtlases) await app.ensureModeAtlases(activeStyle);
          progFill.style.width = '55%';
          progText.textContent = 'Assembling your photo out of Maggie’s archive…';
          var mw = masterLoaded.img.naturalWidth || masterLoaded.img.width;
          var mh = masterLoaded.img.naturalHeight || masterLoaded.img.height;

          var tmpCat = Object.assign({}, cat, {
            photos: cat.photos.concat([{
              id: cat.photos.length,
              d: '',
              caption: customMasterFile ? customMasterFile.name.replace(/\.[^.]+$/, '') : 'Custom Photo',
              fullUrl: masterLoaded.url,
              w: mw,
              h: mh,
              px: 0, py: 0, ox: 0, oy: 0, pw: mw, ph: mh
            }]),
            previewAtlas: { slotPx: Math.max(mw, mh) },
            previewImg: masterLoaded.img
          });
          mosaic = window.DDOM.engine.assembleFromCatalog(tmpCat, cat.photos.length, cols, gap, activeStyle, activeSettings);
          mosaic.photos = cat.photos;
          mosaic.isCatalogMode = false;
          mosaic.highResTargetImg = masterLoaded.img;
        }

        if (mosaic) {
          app.applyCustomMosaic(mosaic);
          progFill.style.width = '100%';
          progText.textContent = 'Done!';
          setTimeout(function () {
            busy = false;
            btnBuild.disabled = false;
            progWrap.hidden = true;
            close();
          }, 220);
          return;
        }
      } catch (e) {
        progText.textContent = 'Error: ' + (e.message || e);
      }
      busy = false;
      btnBuild.disabled = false;
    });

    btnClose.addEventListener('click', close);
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) close();
    });

    return { open: open, close: close, isOpen: function () { return !backdrop.hidden; } };
  }

  window.DDOM.initStudio = initStudio;
})();
