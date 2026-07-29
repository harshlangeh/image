/* ============================================================
   Pixora Studio — all processing happens locally in the browser.
   Pipeline: decode (any format) → crop → canvas-fit → encode → download
   ============================================================ */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  var HISTORY_KEY = 'pixora.history.v1';
  var MAX_HISTORY = 30;
  var MAX_SIDE = 8192; // decode safety cap (per side)

  var state = {
    fileName: null,     // original name without extension
    fileType: null,     // original mime
    fileSize: 0,        // original bytes
    source: null,       // full-res decoded HTMLCanvasElement
    cropper: null,
    unit: 'px',
    dpi: 96,
    aspect: NaN,        // NaN = free
    align: 'c',
    exifObj: null,      // piexif dump of the original JPEG (if any)
    metaEntries: [],    // rows shown in the accordion
    animated: false,    // GIF flattened notice
    outBlob: null,      // last encoded output
    outMime: 'image/png',
    syncing: false,     // guard against crop input feedback loops
    encodeToken: 0
  };

  /* ============================ helpers ============================ */

  function formatBytes(n) {
    if (n == null || isNaN(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || 2800);
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function extForMime(mime) {
    return mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  }

  // px-per-unit for the current unit / DPI. Percent depends on axis.
  function unitScale(axis) {
    var img = state.source;
    switch (state.unit) {
      case '%': return img ? (axis === 'x' ? img.width : img.height) / 100 : 1;
      case 'in': return state.dpi;
      case 'cm': return state.dpi / 2.54;
      case 'mm': return state.dpi / 25.4;
      default: return 1;
    }
  }
  function pxToUnit(v, axis) {
    var s = unitScale(axis);
    var out = v / s;
    return Math.round(out * 1000) / 1000;
  }
  function unitToPx(v, axis) { return v * unitScale(axis); }

  function parseRatio(str) {
    var m = /^([\d.]+)\s*[:/x]\s*([\d.]+)$/.exec(String(str).trim());
    if (!m) return NaN;
    var w = parseFloat(m[1]), h = parseFloat(m[2]);
    if (!w || !h) return NaN;
    return w / h;
  }

  /* ============================ decoding ============================ */

  function looksHeic(file) {
    var t = (file.type || '').toLowerCase();
    var n = (file.name || '').toLowerCase();
    return t.indexOf('heic') !== -1 || t.indexOf('heif') !== -1 ||
      /\.(heic|heif)$/.test(n);
  }
  function looksSvg(file) {
    return (file.type || '').indexOf('svg') !== -1 || /\.svg$/i.test(file.name || '');
  }

  function setDecodeStatus(msg) {
    var el = $('#decodeStatus');
    if (!msg) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = '<span class="spin"></span><span></span>';
    el.lastElementChild.textContent = msg;
  }

  function blobToImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not decode image')); };
      img.src = url;
    });
  }

  function drawToCanvas(img, w, h) {
    var c = document.createElement('canvas');
    var scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { canvas: c, scaled: scale < 1 };
  }

  function decodeFile(file) {
    if (looksHeic(file)) {
      setDecodeStatus('Converting HEIC (iPhone format)… this runs entirely on your device.');
      return heic2any({ blob: file, toType: 'image/png' }).then(function (res) {
        var blob = Array.isArray(res) ? res[0] : res;
        return blobToImage(blob).then(function (r) {
          var out = drawToCanvas(r.img, r.img.naturalWidth, r.img.naturalHeight);
          URL.revokeObjectURL(r.url);
          return out;
        });
      });
    }
    if (looksSvg(file)) {
      setDecodeStatus('Rasterising SVG…');
      return blobToImage(file).then(function (r) {
        // SVGs without intrinsic size rasterise at a generous default.
        var w = r.img.naturalWidth || 1024;
        var h = r.img.naturalHeight || 1024;
        var target = 1600; // upscale small vectors so crops stay sharp
        var k = Math.max(1, target / Math.max(w, h));
        var out = drawToCanvas(r.img, w * k, h * k);
        URL.revokeObjectURL(r.url);
        return out;
      });
    }
    setDecodeStatus('Decoding image…');
    return blobToImage(file).then(function (r) {
      var out = drawToCanvas(r.img, r.img.naturalWidth, r.img.naturalHeight);
      URL.revokeObjectURL(r.url);
      return out;
    });
  }

  function handleFile(file) {
    if (!file) return;
    var isImage = /^image\//.test(file.type || '') || /\.(heic|heif|svg|avif)$/i.test(file.name || '');
    if (!isImage) { toast('⚠️ "' + file.name + '" does not look like an image.'); return; }

    state.fileName = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
    state.fileType = file.type || 'unknown';
    state.fileSize = file.size || 0;
    state.animated = /gif$/i.test(file.type) || /\.gif$/i.test(file.name || '');
    state.exifObj = null;

    decodeFile(file).then(function (res) {
      setDecodeStatus(null);
      state.source = res.canvas;
      if (res.scaled) toast('ℹ️ Very large image was scaled down to ' + MAX_SIDE + 'px max side for editing.');
      if (state.animated) toast('ℹ️ GIF loaded — animation is flattened to the first frame for editing.');

      var chip = $('#srcFormatChip');
      chip.hidden = false;
      chip.textContent = (file.type || file.name.split('.').pop() || '?').replace('image/', '').toUpperCase() +
        ' · ' + formatBytes(state.fileSize);

      $('#fileNameInput').value = state.fileName + '-edited';
      readMetadata(file);
      initCropper();
      loadHistoryUI();
    }).catch(function (err) {
      setDecodeStatus(null);
      console.error(err);
      toast('❌ Could not open this file: ' + (err && err.message ? err.message : 'unknown error'));
    });
  }

  /* ============================ cropper ============================ */

  function initCropper() {
    var img = $('#cropperImage');
    $('#editorEmpty').hidden = true;
    $('#cropperWrap').hidden = false;
    $('#editorStatus').hidden = false;

    if (state.cropper) { state.cropper.destroy(); state.cropper = null; }

    state.source.toBlob(function (blob) {
      if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
      var url = URL.createObjectURL(blob);
      img.dataset.url = url;
      img.src = url;
      state.cropper = new Cropper(img, {
        viewMode: 1,
        autoCropArea: 0.92,
        aspectRatio: state.aspect,
        responsive: true,
        checkOrientation: false,
        background: false,
        crop: debounce(function () {
          syncInputsFromCropper();
          scheduleEncode();
        }, 120)
      });
      $('#stDims').innerHTML = 'Image: <strong>' + state.source.width + ' × ' + state.source.height + ' px</strong>';
      $('#stNote').textContent = state.animated ? 'GIF flattened to first frame' : '';
      scheduleEncode();
    }, 'image/png');
  }

  function syncInputsFromCropper() {
    if (!state.cropper || state.syncing) return;
    var d = state.cropper.getData(true);
    state.syncing = true;
    $('#cropW').value = pxToUnit(d.width, 'x');
    $('#cropH').value = pxToUnit(d.height, 'y');
    $('#cropX').value = pxToUnit(d.x, 'x');
    $('#cropY').value = pxToUnit(d.y, 'y');
    state.syncing = false;
    $('#stCrop').innerHTML = 'Crop: <strong>' + Math.round(d.width) + ' × ' + Math.round(d.height) + ' px</strong>';
    updateCanvasNote();
  }

  function syncCropperFromInputs() {
    if (!state.cropper || state.syncing) return;
    state.syncing = true;
    var d = state.cropper.getData(true);
    var w = parseFloat($('#cropW').value);
    var h = parseFloat($('#cropH').value);
    var x = parseFloat($('#cropX').value);
    var y = parseFloat($('#cropY').value);
    state.cropper.setData({
      width: isNaN(w) ? d.width : unitToPx(w, 'x'),
      height: isNaN(h) ? d.height : unitToPx(h, 'y'),
      x: isNaN(x) ? d.x : unitToPx(x, 'x'),
      y: isNaN(y) ? d.y : unitToPx(y, 'y')
    });
    state.syncing = false;
    scheduleEncode();
  }

  function updateUnitEchoes() {
    $$('.unit-echo').forEach(function (el) { el.textContent = state.unit; });
  }

  /* ============================ output pipeline ============================ */

  function alignFactors() {
    var map = {
      nw: [0, 0], n: [0.5, 0], ne: [1, 0],
      w: [0, 0.5], c: [0.5, 0.5], e: [1, 0.5],
      sw: [0, 1], s: [0.5, 1], se: [1, 1]
    };
    return map[state.align] || [0.5, 0.5];
  }

  function canvasTargetRatio() {
    var sel = $('#canvasRatio').value;
    if (sel === 'custom') {
      var w = parseFloat($('#canvasRatioW').value);
      var h = parseFloat($('#canvasRatioH').value);
      return (w > 0 && h > 0) ? w / h : NaN;
    }
    return parseRatio(sel);
  }

  function exactSize() {
    if (!$('#exactEnable').checked) return null;
    var w = parseInt($('#outWInput').value, 10);
    var h = parseInt($('#outHInput').value, 10);
    return (w > 0 && h > 0) ? { w: w, h: h } : null;
  }

  // Scale a canvas to exact dimensions (multi-step halving keeps downscales sharp)
  function scaleCanvasTo(src, w, h) {
    var cur = src;
    while (cur.width / 2 >= w && cur.height / 2 >= h) {
      var half = document.createElement('canvas');
      half.width = Math.max(w, Math.round(cur.width / 2));
      half.height = Math.max(h, Math.round(cur.height / 2));
      var hctx = half.getContext('2d');
      hctx.imageSmoothingQuality = 'high';
      hctx.drawImage(cur, 0, 0, half.width, half.height);
      cur = half;
    }
    var out = document.createElement('canvas');
    out.width = w; out.height = h;
    var ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, w, h);
    return out;
  }

  // Crop stage → optional canvas-fit stage → optional exact resize. Returns the final canvas.
  function buildOutputCanvas(outMime) {
    var staged = buildFittedCanvas(outMime);
    if (!staged) return null;
    var ex = exactSize();
    if (ex && (staged.width !== ex.w || staged.height !== ex.h)) return scaleCanvasTo(staged, ex.w, ex.h);
    return staged;
  }

  function buildFittedCanvas(outMime) {
    if (!state.cropper) return null;
    var cropped = state.cropper.getCroppedCanvas({ imageSmoothingQuality: 'high' });
    if (!cropped || !cropped.width || !cropped.height) return null;
    if (!$('#canvasEnable').checked) return cropped;

    var ratio = canvasTargetRatio();
    if (!ratio || isNaN(ratio)) return cropped;

    var mode = document.querySelector('input[name="canvasMode"]:checked').value;
    var cw = cropped.width, ch = cropped.height;
    var tw, th;
    if (mode === 'extend') {
      // grow the canvas until the ratio fits, never cutting pixels
      if (cw / ch > ratio) { tw = cw; th = Math.round(cw / ratio); }
      else { th = ch; tw = Math.round(ch * ratio); }
    } else {
      // shrink the canvas to the ratio, trimming overflow
      if (cw / ch > ratio) { th = ch; tw = Math.round(ch * ratio); }
      else { tw = cw; th = Math.round(cw * ratio); }
    }
    tw = Math.max(1, tw); th = Math.max(1, th);

    var out = document.createElement('canvas');
    out.width = tw; out.height = th;
    var ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';

    var bg = $('#canvasBg').value;
    if (bg === 'custom') bg = $('#canvasBgColor').value;
    var jpeg = outMime === 'image/jpeg';

    if (bg === 'blur') {
      // cover-fill with a blurred copy of the image itself
      var k = Math.max(tw / cw, th / ch) * 1.1;
      ctx.filter = 'blur(' + Math.max(12, Math.round(Math.max(tw, th) / 40)) + 'px)';
      ctx.drawImage(cropped, (tw - cw * k) / 2, (th - ch * k) / 2, cw * k, ch * k);
      ctx.filter = 'none';
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(0, 0, tw, th);
    } else if (bg !== 'transparent') {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, tw, th);
    } else if (jpeg) {
      // JPEG has no alpha channel — transparent areas become white
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, tw, th);
    }

    var f = alignFactors();
    ctx.drawImage(cropped, Math.round((tw - cw) * f[0]), Math.round((th - ch) * f[1]));
    return out;
  }

  function currentQuality() {
    var mode = document.querySelector('input[name="qualityMode"]:checked').value;
    if (mode === 'lossless') return 1.0;
    return Math.min(1, Math.max(0.01, parseInt($('#qualityInput').value, 10) / 100 || 0.8));
  }

  function encodeCanvas(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      // JPEG + metadata goes through a data URL so piexif can splice EXIF in.
      var exifBytes = (mime === 'image/jpeg' && $('#keepMeta').checked) ? buildExifBytes() : null;
      if (exifBytes) {
        try {
          var dataUrl = canvas.toDataURL('image/jpeg', quality);
          var withExif = piexif.insert(exifBytes, dataUrl);
          resolve(dataURLtoBlob(withExif));
          return;
        } catch (e) {
          console.warn('EXIF insert failed, exporting without metadata', e);
        }
      }
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('Encoding failed for ' + mime));
      }, mime, quality);
    });
  }

  function dataURLtoBlob(dataUrl) {
    var parts = dataUrl.split(',');
    var mime = /:(.*?);/.exec(parts[0])[1];
    var bin = atob(parts[1]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  // Highest quality whose encoded size fits under targetBytes (binary search).
  function encodeToTarget(canvas, mime, targetBytes) {
    var lo = 0.02, hi = 1, best = null, bestQ = null;
    function step(i) {
      var q = (lo + hi) / 2;
      return encodeCanvas(canvas, mime, q).then(function (blob) {
        if (blob.size <= targetBytes) { best = blob; bestQ = q; lo = q; }
        else hi = q;
        return i >= 7 ? null : step(i + 1);
      });
    }
    return step(0).then(function () {
      if (best) return { blob: best, q: bestQ };
      // even the lowest quality overshoots — return it so the user sees how far off it is
      return encodeCanvas(canvas, mime, 0.02).then(function (blob) {
        return { blob: blob, q: 0.02, over: true };
      });
    });
  }

  var scheduleEncode = debounce(function () {
    if (!state.cropper || !state.source) return;
    var token = ++state.encodeToken;
    var mime = document.querySelector('input[name="outFormat"]:checked').value;
    var quality = currentQuality();
    var canvas = buildOutputCanvas(mime);
    if (!canvas) return;

    var dlSize = $('#dlSize');
    dlSize.classList.add('busy');
    dlSize.textContent = '…';

    var mode = document.querySelector('input[name="qualityMode"]:checked').value;
    var targetKB = Math.max(1, parseInt($('#targetKB').value, 10) || 50);
    var encoded;
    if (mode === 'target' && mime !== 'image/png') {
      encoded = encodeToTarget(canvas, mime, targetKB * 1024).then(function (r) {
        if (token === state.encodeToken) {
          $('#targetNote').textContent = r.over
            ? '⚠️ Even the lowest quality is ' + formatBytes(r.blob.size) + ' — reduce the output dimensions to fit under ' + targetKB + ' KB.'
            : '✅ ' + formatBytes(r.blob.size) + ' at quality ' + Math.round(r.q * 100) + '% — under the ' + targetKB + ' KB limit.';
        }
        return r.blob;
      });
    } else {
      if (mode === 'target') {
        $('#targetNote').textContent = 'PNG size can’t be targeted (it’s lossless) — switch the format to JPG or WebP.';
      }
      encoded = encodeCanvas(canvas, mime, quality);
    }

    encoded.then(function (blob) {
      if (token !== state.encodeToken) return; // superseded
      state.outBlob = blob;
      state.outMime = mime;

      var btn = $('#downloadBtn');
      btn.disabled = false;
      $('#dlLabel').textContent = 'Download ' + extForMime(mime).toUpperCase();
      dlSize.classList.remove('busy');
      dlSize.textContent = formatBytes(blob.size);

      $('#sizeCompare').hidden = false;
      $('#szOrig').textContent = formatBytes(state.fileSize);
      $('#szOut').textContent = formatBytes(blob.size);
      var badge = $('#szBadge');
      if (state.fileSize > 0) {
        var pct = ((blob.size - state.fileSize) / state.fileSize) * 100;
        badge.textContent = (pct <= 0 ? '−' : '+') + Math.abs(pct).toFixed(0) + '%';
        badge.classList.toggle('worse', pct > 0);
      } else {
        badge.textContent = '—';
      }

      var wrap = $('#outPreviewWrap');
      wrap.hidden = false;
      var prev = $('#outPreview');
      if (prev.dataset.url) URL.revokeObjectURL(prev.dataset.url);
      var url = URL.createObjectURL(blob);
      prev.dataset.url = url;
      prev.src = url;
      $('#outDims').textContent = canvas.width + ' × ' + canvas.height + ' px';
    }).catch(function (err) {
      if (token !== state.encodeToken) return;
      console.error(err);
      dlSize.classList.remove('busy');
      dlSize.textContent = '—';
      toast('❌ ' + err.message + (mime === 'image/webp' ? ' (your browser may not encode WebP)' : ''));
    });
  }, 280);

  function updateCanvasNote() {
    var note = $('#canvasResultNote');
    if (!$('#canvasEnable').checked || !state.cropper) { note.textContent = ''; return; }
    var ratio = canvasTargetRatio();
    if (!ratio || isNaN(ratio)) { note.textContent = ''; return; }
    var d = state.cropper.getData(true);
    var cw = Math.round(d.width), ch = Math.round(d.height), tw, th;
    var mode = document.querySelector('input[name="canvasMode"]:checked').value;
    if (mode === 'extend') {
      if (cw / ch > ratio) { tw = cw; th = Math.round(cw / ratio); }
      else { th = ch; tw = Math.round(ch * ratio); }
    } else {
      if (cw / ch > ratio) { th = ch; tw = Math.round(ch * ratio); }
      else { tw = cw; th = Math.round(cw * ratio); }
    }
    note.textContent = 'Final canvas: ' + tw + ' × ' + th + ' px';
  }

  /* ============================ metadata ============================ */

  var META_GROUPS = { '0th': 'Image (IFD0)', 'Exif': 'Camera (Exif)', 'GPS': 'GPS location', 'Interop': 'Interoperability', '1st': 'Thumbnail (IFD1)' };

  function readMetadata(file) {
    state.metaEntries = [];
    state.exifObj = null;

    var fileGroup = [
      { key: 'File name', value: file.name, readonly: true },
      { key: 'MIME type', value: file.type || 'unknown', readonly: true },
      { key: 'File size', value: formatBytes(file.size), readonly: true },
      { key: 'Last modified', value: file.lastModified ? new Date(file.lastModified).toLocaleString() : '—', readonly: true },
      { key: 'Dimensions', value: state.source.width + ' × ' + state.source.height + ' px', readonly: true }
    ];

    var isJpeg = /jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name || '');

    var readerDone = Promise.resolve();
    if (isJpeg) {
      readerDone = file.arrayBuffer().then(function (buf) {
        var bin = '';
        var bytes = new Uint8Array(buf);
        var CHUNK = 0x8000;
        for (var i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        try { state.exifObj = piexif.load(bin); } catch (e) { state.exifObj = null; }
      });
    }

    // exifr reads EXIF out of JPEG, HEIC, PNG, TIFF, AVIF… — used for display
    // of everything piexif can't parse (XMP, ICC, IPTC included).
    var exifrDone = window.exifr
      ? exifr.parse(file, { tiff: true, exif: true, gps: true, xmp: true, icc: true, iptc: true, jfif: true, ihdr: true, mergeOutput: false })
        .catch(function () { return null; })
      : Promise.resolve(null);

    Promise.all([readerDone, exifrDone]).then(function (results) {
      var groups = [{ name: 'File', rows: fileGroup }];

      if (state.exifObj) {
        // Editable rows straight from the JPEG's EXIF via piexif
        Object.keys(META_GROUPS).forEach(function (ifd) {
          var tags = state.exifObj[ifd];
          if (!tags || typeof tags !== 'object') return;
          var rows = [];
          Object.keys(tags).forEach(function (tagId) {
            var name = (piexif.TAGS[ifd] && piexif.TAGS[ifd][tagId]) ? piexif.TAGS[ifd][tagId].name : 'Tag ' + tagId;
            rows.push({
              key: name,
              value: metaValueToString(tags[tagId]),
              ifd: ifd,
              tag: parseInt(tagId, 10),
              original: tags[tagId]
            });
          });
          if (rows.length) groups.push({ name: META_GROUPS[ifd], rows: rows });
        });
      }

      var parsed = results[1];
      if (parsed) {
        Object.keys(parsed).forEach(function (seg) {
          if (state.exifObj && (seg === 'ifd0' || seg === 'exif' || seg === 'gps' || seg === 'ifd1' || seg === 'interop')) return; // already shown editable
          var data = parsed[seg];
          if (!data || typeof data !== 'object') return;
          var rows = Object.keys(data).map(function (k) {
            return { key: k, value: metaValueToString(data[k]), readonly: true };
          }).filter(function (r) { return r.value !== ''; });
          if (rows.length) groups.push({ name: segLabel(seg), rows: rows });
        });
      }

      // If nothing editable came out of the file, offer blank EXIF fields the
      // user can fill in — they get written on JPG export.
      var hasEditable = groups.some(function (g) {
        return g.rows.some(function (r) { return !r.readonly; });
      });
      if (!hasEditable) groups.push(editableSeedGroup());

      renderMetaAccordion(groups);
    });
  }

  function segLabel(seg) {
    var map = { ifd0: 'Image (IFD0)', ifd1: 'Thumbnail (IFD1)', exif: 'Camera (Exif)', gps: 'GPS location', interop: 'Interoperability', xmp: 'XMP', icc: 'ICC colour profile', iptc: 'IPTC', jfif: 'JFIF', ihdr: 'PNG header' };
    return map[seg] || seg.toUpperCase();
  }

  // Fresh, editable EXIF fields for images that carry none.
  function editableSeedGroup() {
    if (!state.exifObj) state.exifObj = { '0th': {}, 'Exif': {}, 'GPS': {}, 'Interop': {}, '1st': {}, thumbnail: null };
    var seeds = [
      ['0th', piexif.ImageIFD.ImageDescription, 'ImageDescription'],
      ['0th', piexif.ImageIFD.Artist, 'Artist'],
      ['0th', piexif.ImageIFD.Copyright, 'Copyright'],
      ['0th', piexif.ImageIFD.Software, 'Software'],
      ['0th', piexif.ImageIFD.Make, 'Make'],
      ['0th', piexif.ImageIFD.Model, 'Model'],
      ['0th', piexif.ImageIFD.DateTime, 'DateTime'],
      ['Exif', piexif.ExifIFD.DateTimeOriginal, 'DateTimeOriginal'],
      ['Exif', piexif.ExifIFD.UserComment, 'UserComment']
    ];
    var rows = seeds.map(function (s) {
      var existing = state.exifObj[s[0]][s[1]];
      return { key: s[2], value: existing != null ? metaValueToString(existing) : '', ifd: s[0], tag: s[1], original: existing != null ? existing : '' };
    });
    return { name: 'Add metadata (written on JPG export)', rows: rows };
  }

  function metaValueToString(v) {
    if (v == null) return '';
    if (v instanceof Uint8Array || v instanceof Uint16Array) {
      return v.length > 24 ? '[' + v.length + ' bytes]' : Array.prototype.join.call(v, ',');
    }
    if (Array.isArray(v)) {
      if (v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number') return v[0] + '/' + v[1]; // rational
      try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
    return String(v);
  }

  // Parse the edited text back into the shape piexif stored originally.
  function stringToMetaValue(str, original) {
    str = String(str);
    if (typeof original === 'number') {
      var n = parseFloat(str);
      return isNaN(n) ? original : n;
    }
    if (Array.isArray(original)) {
      if (original.length === 2 && typeof original[0] === 'number') {
        var m = /^\s*(-?\d+)\s*\/\s*(-?\d+)\s*$/.exec(str);
        if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
      }
      try {
        var arr = JSON.parse(str);
        if (Array.isArray(arr)) return arr;
      } catch (e) { /* fall through to string */ }
    }
    return str;
  }

  function renderMetaAccordion(groups) {
    var box = $('#metaAccordion');
    box.innerHTML = '';
    groups.forEach(function (g, gi) {
      var det = document.createElement('details');
      if (gi === 0) det.open = true;
      var sum = document.createElement('summary');
      sum.textContent = g.name + ' ';
      var count = document.createElement('span');
      count.className = 'meta-count';
      count.textContent = g.rows.length;
      sum.appendChild(count);
      det.appendChild(sum);

      var rowsEl = document.createElement('div');
      rowsEl.className = 'meta-rows';
      g.rows.forEach(function (row) {
        var r = document.createElement('div');
        r.className = 'meta-row';
        var key = document.createElement('span');
        key.className = 'meta-key';
        key.textContent = row.key;
        var input = document.createElement('input');
        input.type = 'text';
        input.value = row.value;
        input.spellcheck = false;
        if (row.readonly) {
          input.readOnly = true;
          input.title = 'Informational — not editable';
        } else {
          input.title = 'Edit — written into the file on JPG export';
          input.addEventListener('input', function () {
            input.classList.add('edited');
            if (state.exifObj) {
              if (input.value === '') delete state.exifObj[row.ifd][row.tag];
              else state.exifObj[row.ifd][row.tag] = stringToMetaValue(input.value, row.original);
            }
            scheduleEncode();
          });
        }
        r.appendChild(key);
        r.appendChild(input);
        rowsEl.appendChild(r);
      });
      det.appendChild(rowsEl);
      box.appendChild(det);
    });
  }

  function buildExifBytes() {
    if (!state.exifObj) return null;
    try {
      // thumbnail rewrite often breaks after resize; drop it
      var copy = { '0th': state.exifObj['0th'], 'Exif': state.exifObj['Exif'], 'GPS': state.exifObj['GPS'], 'Interop': state.exifObj['Interop'] || {}, '1st': {}, thumbnail: null };
      var has = ['0th', 'Exif', 'GPS'].some(function (k) { return Object.keys(copy[k] || {}).length; });
      if (!has) return null;
      return piexif.dump(copy);
    } catch (e) {
      console.warn('piexif dump failed', e);
      return null;
    }
  }

  /* ============================ history ============================ */

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
    catch (e) { return []; }
  }
  function saveHistory(list) {
    while (list.length) {
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); return; }
      catch (e) { list.pop(); } // quota — drop oldest-stored data until it fits
    }
    try { localStorage.removeItem(HISTORY_KEY); } catch (e) { /* ignore */ }
  }

  function thumbnailDataUrl() {
    var c = document.createElement('canvas');
    var src = state.source;
    var k = 140 / Math.max(src.width, src.height);
    c.width = Math.max(1, Math.round(src.width * k));
    c.height = Math.max(1, Math.round(src.height * k));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
  }

  function pushHistory(entry) {
    var list = loadHistory();
    list.unshift(entry);
    if (list.length > MAX_HISTORY) list.length = MAX_HISTORY;
    saveHistory(list);
    loadHistoryUI();
  }

  function loadHistoryUI() {
    var list = loadHistory();
    var box = $('#historyList');
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<p class="muted">Your exported images will show up here.</p>';
      return;
    }
    list.forEach(function (h) {
      var item = document.createElement('div');
      item.className = 'hist-item';

      var img = document.createElement('img');
      img.className = 'hist-thumb';
      img.alt = h.name;
      img.src = h.thumb || '';
      item.appendChild(img);

      var body = document.createElement('div');
      body.className = 'hist-body';
      var name = document.createElement('div');
      name.className = 'hist-name';
      name.textContent = h.name;
      name.title = h.name;
      var info = document.createElement('div');
      info.className = 'hist-info';
      info.textContent = h.format.toUpperCase() + ' · ' + formatBytes(h.size) + ' · ' + h.dims;
      var when = document.createElement('div');
      when.className = 'hist-info';
      when.textContent = new Date(h.date).toLocaleString();
      body.appendChild(name); body.appendChild(info); body.appendChild(when);

      var actions = document.createElement('div');
      actions.className = 'hist-actions';
      if (h.data) {
        var dl = document.createElement('button');
        dl.type = 'button';
        dl.textContent = '⬇️ Save';
        dl.addEventListener('click', function () {
          var a = document.createElement('a');
          a.href = h.data;
          a.download = h.name;
          a.click();
        });
        actions.appendChild(dl);
      }
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'danger';
      del.textContent = '🗑️';
      del.title = 'Remove from history';
      del.addEventListener('click', function () {
        saveHistory(loadHistory().filter(function (x) { return x.id !== h.id; }));
        loadHistoryUI();
      });
      actions.appendChild(del);
      body.appendChild(actions);
      item.appendChild(body);
      box.appendChild(item);
    });
  }

  /* ============================ download ============================ */

  function doDownload() {
    if (!state.outBlob) return;
    var name = ($('#fileNameInput').value.trim() || state.fileName || 'image') + '.' + extForMime(state.outMime);
    var url = URL.createObjectURL(state.outBlob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);

    var entry = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      name: name,
      date: Date.now(),
      format: extForMime(state.outMime),
      size: state.outBlob.size,
      origSize: state.fileSize,
      dims: $('#outDims').textContent,
      thumb: thumbnailDataUrl(),
      quality: (function () {
        var mode = document.querySelector('input[name="qualityMode"]:checked').value;
        if (mode === 'lossless') return 'max';
        if (mode === 'target') return '≤' + ($('#targetKB').value || 50) + 'KB';
        return $('#qualityInput').value + '%';
      })()
    };
    // keep the actual file re-downloadable when it's small enough for localStorage
    if (state.outBlob.size < 250 * 1024) {
      var fr = new FileReader();
      fr.onload = function () {
        entry.data = fr.result;
        pushHistory(entry);
      };
      fr.onerror = function () { pushHistory(entry); };
      fr.readAsDataURL(state.outBlob);
    } else {
      pushHistory(entry);
    }
    toast('✅ Downloaded ' + name + ' (' + formatBytes(state.outBlob.size) + ')');
  }

  /* ============================ wiring ============================ */

  function setAspect(ratio) {
    state.aspect = ratio;
    if (state.cropper) state.cropper.setAspectRatio(isNaN(ratio) ? NaN : ratio);
    scheduleEncode();
  }

  function bindUpload() {
    var dz = $('#dropzone');
    var input = $('#fileInput');

    dz.addEventListener('click', function () { input.click(); });
    dz.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    $('#browseBtn').addEventListener('click', function (e) { e.stopPropagation(); input.click(); });
    $('#newImageBtn').addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { if (input.files[0]) handleFile(input.files[0]); input.value = ''; });

    // paste — both the document listener and an explicit button (Clipboard API)
    document.addEventListener('paste', function (e) {
      if (e.target && /^(input|textarea)$/i.test(e.target.tagName) && e.target.type !== 'file') {
        // let text pastes into fields behave normally unless they carry a file
        if (!(e.clipboardData && e.clipboardData.files && e.clipboardData.files.length)) return;
      }
      var files = e.clipboardData && e.clipboardData.files;
      if (files && files.length) {
        e.preventDefault();
        handleFile(files[0]);
        return;
      }
      var items = e.clipboardData && e.clipboardData.items;
      if (items) {
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
            e.preventDefault();
            handleFile(items[i].getAsFile());
            return;
          }
        }
      }
    });

    $('#pasteBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      if (!navigator.clipboard || !navigator.clipboard.read) {
        toast('Press Ctrl+V anywhere on the page to paste an image.');
        return;
      }
      navigator.clipboard.read().then(function (items) {
        for (var i = 0; i < items.length; i++) {
          var types = items[i].types.filter(function (t) { return /^image\//.test(t); });
          if (types.length) {
            return items[i].getType(types[0]).then(function (blob) {
              handleFile(new File([blob], 'pasted-image.' + extForMime(blob.type), { type: blob.type }));
            });
          }
        }
        toast('No image found on the clipboard — copy one first, then press Paste.');
      }).catch(function () {
        toast('Clipboard blocked by the browser — press Ctrl+V instead.');
      });
    });

    $('#urlBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      var url = prompt('Paste an image URL (the server must allow cross-origin access):');
      if (!url) return;
      setDecodeStatus('Fetching image from URL…');
      fetch(url, { mode: 'cors' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      }).then(function (blob) {
        var name = (url.split('/').pop() || 'image').split('?')[0] || 'image';
        handleFile(new File([blob], name, { type: blob.type }));
      }).catch(function (err) {
        setDecodeStatus(null);
        toast('❌ Could not fetch that URL (' + err.message + '). The site may block cross-origin requests — download the file and drop it here instead.');
      });
    });

    // drag & drop — dropzone highlight + full-window overlay
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragging'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragging'); });
    });

    var overlay = $('#dropOverlay');
    var dragDepth = 0;
    window.addEventListener('dragenter', function (e) {
      if (e.dataTransfer && Array.prototype.some.call(e.dataTransfer.types || [], function (t) { return t === 'Files'; })) {
        dragDepth++;
        overlay.hidden = false;
      }
    });
    window.addEventListener('dragleave', function () {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) overlay.hidden = true;
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      overlay.hidden = true;
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    // Ctrl/Cmd+O opens the picker; Ctrl/Cmd+S downloads
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); input.click(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && state.outBlob) { e.preventDefault(); doDownload(); }
    });
  }

  function bindCrop() {
    $$('#ratioGrid .ratio-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        $$('#ratioGrid .ratio-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        setAspect(btn.dataset.ratio === 'free' ? NaN : parseRatio(btn.dataset.ratio));
      });
    });
    $('#applyCustomRatio').addEventListener('click', function () {
      var w = parseFloat($('#customRatioW').value);
      var h = parseFloat($('#customRatioH').value);
      if (!(w > 0 && h > 0)) { toast('Enter both parts of the ratio, e.g. 5 : 4'); return; }
      $$('#ratioGrid .ratio-btn').forEach(function (b) { b.classList.remove('active'); });
      setAspect(w / h);
    });

    $('#unitSelect').addEventListener('change', function () {
      state.unit = this.value;
      updateUnitEchoes();
      syncInputsFromCropper();
    });
    $('#dpiInput').addEventListener('input', function () {
      var v = parseInt(this.value, 10);
      if (v > 0) { state.dpi = v; syncInputsFromCropper(); }
    });

    ['cropW', 'cropH', 'cropX', 'cropY'].forEach(function (id) {
      $('#' + id).addEventListener('change', syncCropperFromInputs);
    });

    $('#selectAllCrop').addEventListener('click', function () {
      if (!state.cropper) return;
      var d = state.cropper.getImageData();
      state.cropper.setData({ x: 0, y: 0, width: d.naturalWidth, height: d.naturalHeight });
    });
    $('#centerCrop').addEventListener('click', function () {
      if (!state.cropper) return;
      var img = state.cropper.getImageData();
      var d = state.cropper.getData(true);
      state.cropper.setData({ x: (img.naturalWidth - d.width) / 2, y: (img.naturalHeight - d.height) / 2, width: d.width, height: d.height });
    });

    $('#rotL').addEventListener('click', function () { if (state.cropper) state.cropper.rotate(-90); });
    $('#rotR').addEventListener('click', function () { if (state.cropper) state.cropper.rotate(90); });
    $('#flipH').addEventListener('click', function () { if (state.cropper) state.cropper.scaleX(-state.cropper.getData().scaleX || -1); });
    $('#flipV').addEventListener('click', function () { if (state.cropper) state.cropper.scaleY(-state.cropper.getData().scaleY || -1); });
    $('#zoomIn').addEventListener('click', function () { if (state.cropper) state.cropper.zoom(0.1); });
    $('#zoomOut').addEventListener('click', function () { if (state.cropper) state.cropper.zoom(-0.1); });
    $('#resetCrop').addEventListener('click', function () { if (state.cropper) state.cropper.reset(); });
  }

  function bindCanvas() {
    $('#canvasEnable').addEventListener('change', function () {
      $('#canvasControls').classList.toggle('on', this.checked);
      updateCanvasNote();
      scheduleEncode();
    });
    $('#canvasRatio').addEventListener('change', function () {
      $('#canvasCustomWrap').hidden = this.value !== 'custom';
      updateCanvasNote();
      scheduleEncode();
    });
    ['canvasRatioW', 'canvasRatioH'].forEach(function (id) {
      $('#' + id).addEventListener('input', debounce(function () { updateCanvasNote(); scheduleEncode(); }, 250));
    });
    $$('input[name="canvasMode"]').forEach(function (r) {
      r.addEventListener('change', function () { updateCanvasNote(); scheduleEncode(); });
    });
    $('#canvasBg').addEventListener('change', function () {
      $('#canvasBgColorWrap').hidden = this.value !== 'custom';
      scheduleEncode();
    });
    $('#canvasBgColor').addEventListener('input', debounce(scheduleEncode, 200));
    $$('#alignGrid button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        $$('#alignGrid button').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        state.align = btn.dataset.al;
        scheduleEncode();
      });
    });
  }

  function bindExport() {
    $$('input[name="outFormat"]').forEach(function (r) {
      r.addEventListener('change', function () {
        var isPng = r.value === 'image/png';
        $('#qualityNote').textContent = isPng
          ? 'PNG is always lossless — the quality slider applies to JPG and WebP.'
          : 'Lower % = smaller file. 75–85% is usually indistinguishable from the original.';
        scheduleEncode();
      });
    });
    function refreshQualityBlocks() {
      var mode = document.querySelector('input[name="qualityMode"]:checked').value;
      $('#qualityBlock').hidden = mode === 'target';
      $('#qualityBlock').classList.toggle('on', mode === 'compress');
      $('#targetBlock').hidden = mode !== 'target';
      $('#targetBlock').classList.toggle('on', mode === 'target');
    }
    $$('input[name="qualityMode"]').forEach(function (r) {
      r.addEventListener('change', function () { refreshQualityBlocks(); scheduleEncode(); });
    });
    $('#targetKB').addEventListener('input', debounce(scheduleEncode, 300));

    // Exact output size — lock the crop ratio to match so nothing distorts
    function applyExactSize() {
      var ex = exactSize();
      $('#exactNote').hidden = !$('#exactEnable').checked;
      if (ex) {
        $$('#ratioGrid .ratio-btn').forEach(function (b) { b.classList.remove('active'); });
        setAspect(ex.w / ex.h);
      } else {
        scheduleEncode();
      }
    }
    $('#exactEnable').addEventListener('change', applyExactSize);
    $('#outWInput').addEventListener('input', debounce(applyExactSize, 300));
    $('#outHInput').addEventListener('input', debounce(applyExactSize, 300));

    var slider = $('#qualitySlider');
    var num = $('#qualityInput');
    slider.addEventListener('input', function () { num.value = slider.value; scheduleEncode(); });
    num.addEventListener('input', function () {
      var v = Math.min(100, Math.max(1, parseInt(num.value, 10) || 80));
      slider.value = v;
      scheduleEncode();
    });
    num.addEventListener('change', function () { num.value = slider.value; });

    $('#keepMeta').addEventListener('change', scheduleEncode);
    $('#downloadBtn').addEventListener('click', doDownload);

    $('#stripMetaBtn').addEventListener('click', function () {
      if (!state.source) { toast('Upload an image first.'); return; }
      state.exifObj = { '0th': {}, 'Exif': {}, 'GPS': {}, 'Interop': {}, '1st': {}, thumbnail: null };
      $$('#metaAccordion .meta-row input:not(:read-only)').forEach(function (i) { i.value = ''; i.classList.add('edited'); });
      toast('🧹 All editable metadata cleared — the exported file will carry none.');
      scheduleEncode();
    });
  }

  function bindHistory() {
    $('#clearHistoryBtn').addEventListener('click', function () {
      if (!loadHistory().length) return;
      if (confirm('Clear the whole local history? This cannot be undone.')) {
        localStorage.removeItem(HISTORY_KEY);
        loadHistoryUI();
      }
    });
  }

  /* ============================ boot ============================ */

  bindUpload();
  bindCrop();
  bindCanvas();
  bindExport();
  bindHistory();
  updateUnitEchoes();
  loadHistoryUI();
})();
