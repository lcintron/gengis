/* GenGIS - export the map as a picture or a PDF (Project → Export image or PDF…)
 * - the map, its layers and the GenGIS logo, without the map's controls (as presentation mode, less its scale); the base map's
 *   credits are always drawn small in a corner (its providers require them)
 * - PNG, JPEG (a quality) or PDF (a page size, orientation and margins; the map as a JPEG inside)
 * - 1x to 4x the screen's pixels; above 1x the base map is loaded a zoom level or two deeper, at the same scale, so
 *   its detail is real (labels and lines keep their size)
 * The map is captured with html-to-image (vendor/, MIT), loaded on first use; the PDF is written here.
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = MB.escapeHtml;
  const MAX_PIXELS = 16777216; // the largest canvas every browser (iOS included) can draw: about 16.7 MP
  const PAPERS = { fit: null, letter: [612, 792], legal: [612, 1008], tabloid: [792, 1224], a4: [595.28, 841.89], a3: [841.89, 1190.55] }; // points
  const PAPER_NAMES = { fit: 'Fit to the map', letter: 'Letter (8.5 × 11 in)', legal: 'Legal (8.5 × 14 in)', tabloid: 'Tabloid (11 × 17 in)', a4: 'A4 (210 × 297 mm)', a3: 'A3 (297 × 420 mm)' };
  const MARGINS = { none: 0, narrow: 18, normal: 36 }; // points (0, ¼ and ½ inch)
  const DEFAULTS = { format: 'png', scale: 2, quality: 0.9, paper: 'fit', orient: 'auto', margin: 'none', logo: true };

  const conf = () => (MB.settings.exportMap = Object.assign({}, DEFAULTS, MB.settings.exportMap));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const timeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

  /* ---------- the PDF: one page, the map as a JPEG ---------- */
  function pdfString(s) { // UTF-16 hex: any title survives
    let hex = 'FEFF';
    for (const ch of String(s)) { const c = ch.codePointAt(0); if (c > 0xffff) { const v = c - 0x10000; hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0'); } else hex += c.toString(16).padStart(4, '0'); }
    return '<' + hex.toUpperCase() + '>';
  }
  function buildPdf(jpeg, iw, ih, page, box, title) {
    const enc = new TextEncoder(), parts = [], offsets = [];
    let len = 0;
    const push = b => { const u = typeof b === 'string' ? enc.encode(b) : b; parts.push(u); len += u.length; };
    const n = v => (+v.toFixed(2)).toString();
    const obj = (i, body) => { offsets[i] = len; push(i + ' 0 obj\n'); body(); push('\nendobj\n'); };
    push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // %PDF-1.4, binary marker
    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
    obj(3, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(page.w)} ${n(page.h)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
    obj(4, () => { push(`<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`); push(jpeg); push('\nendstream'); });
    const draw = `q ${n(box.w)} 0 0 ${n(box.h)} ${n(box.x)} ${n(box.y)} cm /Im0 Do Q`;
    obj(5, () => push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
    const d = new Date(), stamp = d.getUTCFullYear() + [d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map(v => String(v).padStart(2, '0')).join('') + 'Z';
    obj(6, () => push(`<< /Producer (GenGIS) /Title ${pdfString(title)} /CreationDate (D:${stamp}) >>`));
    const xref = len;
    push('xref\n0 7\n0000000000 65535 f \n' + [1, 2, 3, 4, 5, 6].map(i => String(offsets[i]).padStart(10, '0') + ' 00000 n \n').join('') +
      `trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: 'application/pdf' });
  }
  // The page (points) and where the map lies on it: the paper in its orientation, the map fitted inside the margins.
  function pageLayout(cssW, cssH, c) {
    const m = MARGINS[c.margin] || 0, aspect = cssW / cssH;
    let w, h;
    if (!PAPERS[c.paper]) { w = cssW * 0.75 + 2 * m; h = cssH * 0.75 + 2 * m; } // the map at its size on screen (96 dpi)
    else {
      [w, h] = PAPERS[c.paper];
      const land = c.orient === 'landscape' || (c.orient === 'auto' && aspect > 1);
      if (land) [w, h] = [h, w];
    }
    const bw = w - 2 * m, bh = h - 2 * m, fw = Math.min(bw, bh * aspect), fh = fw / aspect;
    return { page: { w, h }, box: { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh } };
  }

  /* ---------- capturing the map ---------- */
  function loadScript(src, ready) {
    if (ready()) return Promise.resolve();
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = () => (ready() ? res() : rej(new Error('Could not load the exporter'))); s.onerror = () => rej(new Error('Could not load the exporter')); document.head.appendChild(s); });
  }
  const loadImage = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image')); i.src = src; });

  // The base map a zoom level or two deeper (smaller tiles, same scale), for an export above 1x: null when it cannot
  // be (a WMS map, or no deeper level).
  function deeperBase(scale) {
    const base = MB.baseLayer;
    if (!base || !(base instanceof L.TileLayer) || base instanceof L.TileLayer.WMS || scale <= 1) return null;
    const o = base.options, size = o.tileSize || 256, zoom = Math.round(MB.map.getZoom());
    const max = o.maxNativeZoom || o.maxZoom || 19;
    let k = Math.min(Math.floor(Math.log2(scale + 0.01)), max - (zoom + (o.zoomOffset || 0)));
    if (!(k >= 1)) return null;
    return L.tileLayer(base._url, Object.assign({}, o, { tileSize: size / 2 ** k, zoomOffset: (o.zoomOffset || 0) + k, keepBuffer: 0, pane: 'tilePane' }));
  }
  function whenLoaded(layer, ms) {
    return new Promise(res => { let done = false; const end = () => { if (!done) { done = true; res(); } }; layer.once('load', end); setTimeout(end, ms); });
  }
  // The base map's credits, as plain text (they may be links).
  function credits() {
    const a = MB.map.attributionControl, t = document.createElement('div');
    const parts = a && a._attributions ? Object.keys(a._attributions).filter(k => a._attributions[k]) : [];
    return parts.map(h => { t.innerHTML = h; return t.textContent.trim(); }).filter(Boolean).join(' · ');
  }

  // The selection as it is, and a function that brings it back (its handles stay out of the picture meanwhile).
  function keepSelection() {
    const grp = MB.selectedGroup(), multi = grp ? [] : Array.from(MB.multi), one = MB.selected;
    MB.deselect();
    const alive = l => l && l.mb && MB.map.hasLayer(l);
    return () => {
      if (grp && MB.getLayer(grp)) MB.selectGroup(grp);
      else if (multi.length > 1) multi.filter(alive).forEach(l => MB.toggleMulti(l));
      else if (alive(one)) MB.selectFeature(one);
    };
  }

  // The map as a canvas, and whether the sharper base map made it in.
  async function render(c, status) {
    const map = MB.map, el = map.getContainer(), size = map.getSize(), s = c.scale;
    status('Preparing…');
    await loadScript('vendor/html-to-image/html-to-image.js', () => !!window.htmlToImage);
    map.closePopup();
    const restore = keepSelection();
    // The sharper base map loads behind the one on screen (which stays: nothing changes for the eye) and replaces it
    // in the picture only when all its tiles came (offline, a slow or a shallow server: the map as it is).
    const deeper = deeperBase(s), base = MB.baseLayer;
    let sharp = false;
    try {
      if (deeper) {
        status('Loading sharper map tiles…');
        let failed = 0;
        deeper.on('tileerror', () => failed++); // (Leaflet counts a failed tile as loaded)
        deeper.addTo(map); deeper.bringToBack();
        await whenLoaded(deeper, 20000);
        const tiles = Object.values(deeper._tiles);
        sharp = !failed && tiles.length > 0 && tiles.every(t => t.loaded);
      }
      const shown = sharp ? deeper : base; // its loaded tiles past Leaflet's fade-in
      if (shown && shown._tiles) Object.values(shown._tiles).forEach(t => { if (t.loaded) L.DomUtil.setOpacity(t.el, 1); });
      status('Drawing the map…');
      const left = deeper && (sharp ? base : deeper).getContainer(); // the base map not in the picture
      const skip = n => n === left || (n.classList && (n.classList.contains('leaflet-control-container') || n.classList.contains('leaflet-popup-pane') || n.classList.contains('mb-handle')));
      const canvas = await timeout(window.htmlToImage.toCanvas(el, {
        pixelRatio: s, width: size.x, height: size.y, skipFonts: true, cacheBust: false,
        backgroundColor: getComputedStyle(el).backgroundColor || '#0b1118',
        filter: n => !skip(n),
        imagePlaceholder: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
      }), 90000, 'Drawing the map took too long. Try a lower resolution.');
      const ctx = canvas.getContext('2d');
      if (c.logo) { // as presentation mode shows it: top left
        try { const logo = await loadImage('icons/logo-on-dark.svg'); const h = 40 * s, w = h * (logo.naturalWidth / logo.naturalHeight || 1); ctx.drawImage(logo, 12 * s, 12 * s, w, h); } catch (e) { /* no logo */ }
      }
      const text = credits();
      if (text) { // bottom right, small, on a dark band
        ctx.font = `${10.5 * s}px system-ui, sans-serif`;
        const pad = 4 * s, tw = Math.min(ctx.measureText(text).width, canvas.width - 2 * pad), th = 15 * s;
        ctx.fillStyle = 'rgba(11,17,24,.6)'; ctx.fillRect(canvas.width - tw - 2 * pad, canvas.height - th, tw + 2 * pad, th);
        ctx.fillStyle = '#e6ebf2'; ctx.textBaseline = 'middle'; ctx.fillText(text, canvas.width - tw - pad, canvas.height - th / 2, tw);
      }
      return { canvas, blurry: !!deeper && !sharp };
    } finally {
      if (deeper) map.removeLayer(deeper);
      restore();
    }
  }

  const fileName = ext => ((MB.state.projectName || 'map').replace(/[^\w\- ]+/g, '_').trim() || 'map') + '.' + ext;
  const toBlob = (canvas, type, q) => new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('The image could not be written'))), type, q));

  /* ---------- the dialog ---------- */
  MB.exportMap = {
    dlg: null, busy: false,

    maxScale() { const z = MB.map.getSize(); return [4, 3, 2, 1].find(s => z.x * z.y * s * s <= MAX_PIXELS) || 1; },

    build() {
      const dlg = this.dlg = document.createElement('div');
      dlg.id = 'exportDialog'; dlg.className = 'modal hidden';
      dlg.innerHTML = `<div class="modal-box export-box" role="dialog" aria-modal="true" aria-labelledby="exportTitle">
        <button type="button" class="modal-x" data-act="close" aria-label="Close" title="Close">✕</button>
        <h2 id="exportTitle">Export the map</h2>
        <p class="note">The map, its layers and the GenGIS logo, without the map's controls.</p>
        <div class="export-fields"></div>
        <div class="export-actions"><span class="export-status" role="status" aria-live="polite"></span><button type="button" class="btn" data-act="close">Cancel</button><button type="button" class="btn primary" data-act="export">Export</button></div>
      </div>`;
      document.body.appendChild(dlg);
      MB.ui.wireDialog(dlg, { canClose: () => !this.busy }); // ✕, Cancel, Esc, the backdrop: not while exporting
      dlg.addEventListener('click', e => { if (!this.busy && e.target.closest('[data-act="export"]')) this.run(); });
    },

    open() {
      if (!this.dlg) this.build();
      const c = conf();
      if (c.scale > this.maxScale()) c.scale = this.maxScale();
      this.render();
      this.status('');
      MB.ui.openDialog(this.dlg);
    },

    render() {
      const c = conf(), box = this.dlg.querySelector('.export-fields'), size = MB.map.getSize(), max = this.maxScale();
      const seg = (label, key, opts) => `<div class="seg" role="radiogroup" aria-label="${esc(label)}">${opts.map(([v, t, dis]) => `<button type="button" role="radio" aria-checked="${c[key] === v}" data-k="${key}" data-v="${v}"${c[key] === v ? ' class="active"' : ''}${dis ? ' disabled' : ''}>${esc(t)}</button>`).join('')}</div>`;
      const pdf = c.format === 'pdf', jpeg = c.format !== 'png';
      box.innerHTML = `<div class="field"><span class="field-label">Format</span>${seg('Format', 'format', [['png', 'PNG image'], ['jpeg', 'JPEG image'], ['pdf', 'PDF']])}</div>
        <div class="field"><span class="field-label">Resolution</span>${seg('Resolution', 'scale', [1, 2, 3, 4].map(s => [s, s + '×', s > max]))}
          <p class="field-hint">${(size.x * c.scale).toLocaleString()} × ${(size.y * c.scale).toLocaleString()} px${max < 4 ? ' · larger is beyond what browsers can draw' : ''}</p></div>
        ${jpeg ? `<div class="field"><label class="field-label" for="exportQuality">Quality</label><div class="row"><input type="range" id="exportQuality" title="Quality" min="0.5" max="1" step="0.05" value="${c.quality}"><span class="val">${Math.round(c.quality * 100)}%</span></div>
          <p class="field-hint">Lower makes a smaller file.</p></div>` : ''}
        ${pdf ? `<div class="field"><label class="field-label" for="exportPaper">Paper</label><select id="exportPaper">${Object.keys(PAPERS).map(k => `<option value="${k}"${c.paper === k ? ' selected' : ''}>${PAPER_NAMES[k]}</option>`).join('')}</select></div>
          ${c.paper !== 'fit' ? `<div class="field"><span class="field-label">Orientation</span>${seg('Orientation', 'orient', [['auto', 'Auto'], ['portrait', 'Portrait'], ['landscape', 'Landscape']])}</div>` : ''}
          <div class="field"><span class="field-label">Margins</span>${seg('Margins', 'margin', [['none', 'None'], ['narrow', 'Narrow'], ['normal', 'Normal']])}</div>` : ''}
        <div class="field"><label class="check"><input type="checkbox" id="exportLogo"${c.logo ? ' checked' : ''}> GenGIS logo</label>
          <p class="field-hint">The base map's credits are always included: its providers require them.</p></div>`;
      box.querySelectorAll('[data-k]').forEach(b => b.addEventListener('click', () => {
        const k = b.dataset.k; c[k] = k === 'scale' ? +b.dataset.v : b.dataset.v;
        MB.saveSettings(); this.render();
        const again = box.querySelector(`[data-k="${k}"][data-v="${b.dataset.v}"]`); if (again) again.focus();
      }));
      const q = box.querySelector('#exportQuality');
      if (q) q.addEventListener('input', () => { c.quality = +q.value; q.parentNode.querySelector('.val').textContent = Math.round(c.quality * 100) + '%'; MB.saveSettings(); });
      const p = box.querySelector('#exportPaper');
      if (p) p.addEventListener('change', () => { c.paper = p.value; MB.saveSettings(); this.render(); });
      box.querySelector('#exportLogo').addEventListener('change', e => { c.logo = e.target.checked; MB.saveSettings(); });
      MB.ui.radios(box); // arrow keys move along each choice, Tab steps over it
    },

    status(t, err) {
      const el = this.dlg.querySelector('.export-status');
      el.textContent = t || ''; el.classList.toggle('err', !!err);
    },

    async run() {
      if (this.busy) return;
      const c = conf(), z = MB.map.getSize();
      if (!z.x || !z.y) { this.status('The map is not on screen: nothing to export.', true); return; }
      c.scale = Math.min(c.scale, this.maxScale());
      this.busy = true;
      this.dlg.querySelectorAll('button, input, select').forEach(x => { x.dataset.wasDisabled = x.disabled ? '1' : ''; x.disabled = true; });
      try {
        const { canvas, blurry } = await render(c, t => this.status(t));
        this.status(c.format === 'pdf' ? 'Writing the PDF…' : 'Writing the image…');
        let blob;
        if (c.format === 'png') blob = await toBlob(canvas, 'image/png');
        else {
          const jpeg = await toBlob(canvas, 'image/jpeg', c.quality);
          if (c.format === 'jpeg') blob = jpeg;
          else {
            const z = MB.map.getSize(), lay = pageLayout(z.x, z.y, c);
            blob = buildPdf(new Uint8Array(await jpeg.arrayBuffer()), canvas.width, canvas.height, lay.page, lay.box, MB.state.projectName || 'Map');
          }
        }
        MB.download(fileName(c.format === 'jpeg' ? 'jpg' : c.format), blob);
        this.status(`Saved: ${(blob.size / 1048576).toFixed(1)} MB` + (blurry ? ' · the sharper map tiles did not load: the map is at screen detail' : ''));
        MB.toast('Exported ' + fileName(c.format === 'jpeg' ? 'jpg' : c.format));
      } catch (e) {
        console.error(e);
        this.status('Export failed: ' + (e && e.message ? e.message : e instanceof Event ? 'a picture on the map could not be read' : 'unknown error'), true); // (an image's error event)
      } finally {
        this.busy = false;
        this.dlg.querySelectorAll('button, input, select').forEach(x => { x.disabled = x.dataset.wasDisabled === '1'; });
        if (!this.dlg.classList.contains('hidden')) this.dlg.querySelector('[data-act="export"]').focus(); // the keyboard back where it was
      }
    }
  };
  MB.exportMap.buildPdf = buildPdf; // for tests
  MB.exportMap.pageLayout = pageLayout;
})(window.MB);
