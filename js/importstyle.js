/* GenGIS - an imported layer's look (fileimports.js): its popup, its labels on the map and its symbols
 * Rules on the layer's fields, as desktop GIS has them (QGIS, ArcGIS), not settings on each feature:
 * - popup: a title field, and the fields shown (in an order, under a display name of their own); Properties lists them
 *   the same way, every field there, editable
 * - labels: a field, or a text with {FIELD} names in it; their color, size and background as the project's own name
 *   labels; from a zoom level; labels that would overlap one already placed are left out (zoom in for more)
 * - symbols: the file's own styles (KML, simplestyle GeoJSON), one symbol, one per category of a field, or classes
 *   of a number field on a color ramp; points as a dot or an icon (the icon picker's), lines and outlines in a width,
 *   areas filled at an opacity
 * - the Layer settings dialog edits them, the map following as they change
 *
 * look = { title, fields: [{ key, alias, show }],
 *          label: { show, field, text, size, color, bg, minZoom },
 *          symbol: { mode: 'file' | 'single' | 'category' | 'graduated', color, icon, size, width, fill,
 *                    field, cats: [{ value, color, icon }], other, classes, method: 'equal' | 'quantile', ramp, breaks } }
 * API: MB.importStyle.defaults(features, color), schemaOf(features), syncFields(look, keys), titleOf(look, p),
 *   popupRows(look, p), labelText(look, p), categories(features, field), breaksOf(values, n, method),
 *   rampColors(name, n), fillCats(look, features), fillBreaks(look, features), symbolOf(look, feature),
 *   numericFields(look, features), open(id) (the dialog), labels.update() / labels.soon()
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = s => (MB.escapeHtml ? MB.escapeHtml(s) : String(s));
  const CAT_COLORS = ['#ff8a3d', '#3fd0f0', '#c792ff', '#8fd14f', '#ff5c8a', '#f7c12b', '#4f8cff', '#2fd6a0', '#ff6b4a', '#a8b4ff', '#e2e6ea', '#b5854b'];
  const OTHER = '#8d9aad';
  const MAX_CATS = 40;     // values listed in "By category"; the rest are Other
  const MAX_LABELS = 400;  // labels placed at once
  const RAMPS = {
    heat: { name: 'Yellow to red', stops: ['#ffe680', '#fdae61', '#f46d43', '#d73027', '#8b0a26'] },
    blues: { name: 'Blues', stops: ['#d6ecff', '#7fbfef', '#3b8bd9', '#1858a8', '#0b2d6b'] },
    greens: { name: 'Greens', stops: ['#e5f5d0', '#a6db8a', '#5bb85c', '#2a8a3e', '#0d5226'] },
    viridis: { name: 'Viridis', stops: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'] },
    diverge: { name: 'Blue to red', stops: ['#2c7bb6', '#7fc4e6', '#e2e6ea', '#fdae61', '#d7191c'] }
  };
  const AUTO_TITLE = ['name', 'NAME', 'Name', 'title', 'TITLE', 'Title', 'label', 'LABEL'];

  const filled = v => v != null && v !== '';
  const fmt = v => (v == null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(+v.toFixed(6))) : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
  const catKey = v => (filled(v) ? String(v) : '');
  const kindOf = g => (/Point/.test(g.type) ? 'point' : /LineString/.test(g.type) ? 'line' : 'polygon');

  // Every field of the features, in the order they first appear (at most 300).
  function schemaOf(features) {
    const keys = new Set();
    for (const f of features) { for (const k of Object.keys(f.properties || {})) keys.add(k); if (keys.size >= 300) break; }
    return Array.from(keys);
  }
  // The popup's fields after the schema changed: those still there keep their place and settings, new ones go last.
  function syncFields(look, keys) {
    const was = new Map((look.fields || []).map(f => [f.key, f]));
    const kept = (look.fields || []).filter(f => keys.includes(f.key));
    keys.forEach(k => { if (!was.has(k)) kept.push({ key: k, alias: '', show: true }); });
    look.fields = kept;
    return look;
  }
  function defaults(features, color) {
    const own = features.some(f => f.mbStyle);
    const points = features.some(f => kindOf(f.geometry) === 'point');
    return syncFields({
      title: '', fields: [],
      label: { show: false, field: '', text: '', size: 12, color: '#ffffff', bg: true, minZoom: 0 },
      symbol: { mode: own ? 'file' : 'single', color: color || '#ff8a3d', icon: '', size: points ? 22 : 22, width: 2, fill: 0.25,
        field: '', cats: [], other: OTHER, classes: 5, method: 'equal', ramp: 'heat', breaks: [] }
    }, schemaOf(features));
  }

  function titleOf(look, p) {
    p = p || {};
    if (look && look.title) return fmt(p[look.title]);
    for (const k of AUTO_TITLE) if (filled(p[k])) return fmt(p[k]);
    return '';
  }
  function popupRows(look, p) {
    p = p || {};
    return (look.fields || []).filter(f => f.show !== false && filled(p[f.key])).slice(0, 40).map(f => [f.alias || f.key, fmt(p[f.key])]);
  }
  function labelText(look, p) {
    const lb = look.label || {};
    p = p || {};
    if (lb.text && lb.text.trim()) return lb.text.replace(/\{([^{}]+)\}/g, (m, k) => fmt(p[k.trim()])).replace(/\s+/g, ' ').trim();
    return lb.field ? fmt(p[lb.field]).trim() : titleOf(look, p);
  }

  // A field's values with how many features have each, the commonest first ('' for none).
  function categories(features, field) {
    const n = new Map();
    for (const f of features) { const k = catKey((f.properties || {})[field]); n.set(k, (n.get(k) || 0) + 1); }
    return Array.from(n, ([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
  }
  // Class limits (n + 1 numbers) for values: equal intervals, or quantiles (about as many features in each class).
  function breaksOf(values, n, method) {
    const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return [];
    const lo = v[0], hi = v[v.length - 1];
    if (lo === hi) return [lo, hi];
    const out = [lo];
    for (let i = 1; i < n; i++) out.push(method === 'quantile' ? v[Math.min(v.length - 1, Math.floor(i * v.length / n))] : lo + (hi - lo) * i / n);
    out.push(hi);
    return out.filter((x, i) => i === 0 || x > out[i - 1]);
  }
  const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const toHex = rgb => '#' + rgb.map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
  function rampColors(name, n) {
    const stops = (RAMPS[name] || RAMPS.heat).stops.map(hex);
    if (n <= 1) return [toHex(stops[stops.length - 1])];
    return Array.from({ length: n }, (_, i) => {
      const t = i / (n - 1) * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
      return toHex(stops[k].map((a, j) => a + (stops[k + 1][j] - a) * f));
    });
  }
  const numValue = v => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && isFinite(+v) ? +v : NaN);
  // The fields whose filled values are (nearly all) numbers.
  function numericFields(look, features) {
    const sample = features.slice(0, 2000);
    return (look.fields || []).map(f => f.key).filter(k => {
      let num = 0, any = 0;
      for (const f of sample) { const v = (f.properties || {})[k]; if (!filled(v)) continue; any++; if (Number.isFinite(numValue(v))) num++; }
      return any && num / any >= 0.95;
    });
  }
  // The category list for the symbol's field: the commonest values, those already set keeping their colors and icons.
  function fillCats(look, features) {
    const s = look.symbol, was = new Map((s.cats || []).map(c => [c.value, c]));
    const list = s.field ? categories(features, s.field) : [];
    s.cats = list.slice(0, MAX_CATS).map((c, i) => Object.assign({ value: c.value, color: CAT_COLORS[i % CAT_COLORS.length], icon: '' }, was.get(c.value) || {}, { count: c.count }));
    s.more = Math.max(0, list.length - MAX_CATS);
    return look;
  }
  function fillBreaks(look, features) {
    const s = look.symbol;
    s.breaks = s.field ? breaksOf(features.map(f => numValue((f.properties || {})[s.field])), s.classes || 5, s.method) : [];
    return look;
  }
  // A feature's symbol: { color, icon, own } (own: the file's style, in "file" mode).
  function symbolOf(look, f) {
    const s = look.symbol, p = f.properties || {};
    if (s.mode === 'category') {
      const c = (s.cats || []).find(x => x.value === catKey(p[s.field]));
      return c ? { color: c.color, icon: c.icon || s.icon } : { color: s.other || OTHER, icon: s.icon };
    }
    if (s.mode === 'graduated') {
      const v = numValue(p[s.field]), b = s.breaks || [];
      if (!Number.isFinite(v) || b.length < 2) return { color: s.other || OTHER, icon: s.icon };
      const colors = rampColors(s.ramp, b.length - 1);
      let i = 0;
      while (i < b.length - 2 && v > b[i + 1]) i++;
      return { color: colors[i], icon: s.icon };
    }
    return { color: s.color, icon: s.icon, own: s.mode === 'file' ? f.mbStyle : null };
  }
  // The legend: [{ color, icon, text }] for the layer's row.
  function legend(look) {
    const s = look.symbol;
    if (s.mode === 'category') {
      const items = (s.cats || []).map(c => ({ color: c.color, icon: c.icon || s.icon, text: c.value === '' ? '(empty)' : c.value }));
      if (s.more || items.length > 8) items.splice(8, items.length, { color: s.other || OTHER, icon: s.icon, text: 'Other' });
      return items;
    }
    if (s.mode === 'graduated') {
      const b = s.breaks || [], colors = rampColors(s.ramp, Math.max(1, b.length - 1));
      return b.slice(0, -1).map((x, i) => ({ color: colors[i], icon: s.icon, text: fmt(+x.toPrecision(4)) + ' – ' + fmt(+b[i + 1].toPrecision(4)) }));
    }
    return [];
  }

  /* ---------- labels on the map ----------
   * Placed after each move, in the view only, the top layer first; one that would overlap a label already placed is
   * left out. Under the popups, above the data and the project's objects. */
  const labels = {
    group: null, timer: null,
    soon() { clearTimeout(this.timer); this.timer = setTimeout(() => this.update(), 80); },
    init() {
      if (!MB.map || this.group) return;
      const pane = MB.map.createPane('mb-import-labels');
      pane.style.zIndex = 640;
      pane.style.pointerEvents = 'none';
      this.group = L.layerGroup().addTo(MB.map);
      MB.map.on('moveend zoomend resize', () => this.soon());
    },
    update() {
      if (!MB.map || !MB.imports) return;
      this.init();
      this.group.clearLayers();
      const map = MB.map, zoom = map.getZoom(), view = map.getBounds().pad(0.05), placed = [];
      const free = r => !placed.some(q => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h);
      for (const rec of MB.imports.drawn().reverse()) {
        const look = rec.meta.look, lb = look.label;
        if (!lb.show || zoom < (+lb.minZoom || 0)) continue;
        const size = +lb.size || 12;
        rec.group.eachLayer(l => {
          if (placed.length >= MAX_LABELS || !l.feature) return;
          const text = labelText(look, l.feature.properties);
          if (!text) return;
          let at = l._mbAnchor;
          if (!at) {
            try { at = l.getLatLng ? l.getLatLng() : l.getCenter ? l.getCenter() : l.getBounds().getCenter(); } catch (e) { return; }
            l._mbAnchor = at;
          }
          if (!view.contains(at)) return;
          const pt = map.latLngToContainerPoint(at), point = !!(l.getLatLng || (l.eachLayer && !l.getBounds));
          const lift = point ? (l.options.icon ? (look.symbol.size || 22) / 2 : 7) + 2 : 0;
          const w = Math.min(320, text.length * size * 0.58 + 12), h = size * 1.35 + 6;
          const r = { x: pt.x - w / 2, y: point ? pt.y - lift - h : pt.y - h / 2, w, h };
          if (!free(r)) return;
          placed.push(r);
          const css = `left:0;top:${-lift}px;transform:translate(-50%,${point ? 'calc(-100% - 2px)' : '-50%'});font-size:${size}px;color:${esc(lb.color || '#ffffff')};` +
            (lb.bg === false ? 'background:transparent;border-color:transparent;text-shadow:0 0 3px #000,0 0 2px #000,0 0 1px #000;' : '');
          this.group.addLayer(L.marker(at, { pane: 'mb-import-labels', interactive: false, keyboard: false, pmIgnore: true,
            icon: L.divIcon({ className: 'mb-name-label-wrap', html: `<span class="mb-name-label" style="${css}">${esc(text)}</span>`, iconSize: [0, 0] }) }));
        });
      }
    }
  };

  /* ---------- the Layer settings dialog ---------- */
  const ui = { dlg: null, id: null, tab: 'popup' };
  const ICON_NONE = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>';
  function iconPreview(name, color) {
    const svg = name && MB.icons ? MB.icons.svg(name, color, true) : '';
    return svg ? svg.replace(/width="26" height="26"/, 'width="20" height="20"') : `<span style="color:${esc(color)}">${ICON_NONE}</span>`;
  }

  function dialog() {
    if (ui.dlg) return ui.dlg;
    const d = ui.dlg = document.createElement('div');
    d.id = 'impLookDialog';
    d.className = 'modal hidden';
    d.innerHTML = `<div class="modal-box look-box" role="dialog" aria-modal="true" aria-labelledby="impLookTitle">
      <button type="button" class="modal-x" data-act="close" aria-label="Close" title="Close">✕</button>
      <h2 id="impLookTitle">Layer settings</h2>
      <div class="seg look-tabs" role="tablist"><button type="button" role="tab" data-tab="popup">Popup</button><button type="button" role="tab" data-tab="labels">Labels</button><button type="button" role="tab" data-tab="symbols">Symbols</button></div>
      <div class="look-body" id="impLookBody"></div></div>`;
    document.body.appendChild(d);
    MB.ui.wireDialog(d);
    d.querySelector('.look-tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) { ui.tab = b.dataset.tab; render(); } });
    const body = d.querySelector('#impLookBody');
    body.addEventListener('input', e => onEdit(e, false));
    body.addEventListener('change', e => onEdit(e, true));
    body.addEventListener('click', onClick);
    return d;
  }
  const rec = () => MB.imports && MB.imports.record(ui.id);

  function open(id) {
    ui.id = id;
    const r = rec();
    if (!r) return;
    const d = dialog();
    d.querySelector('#impLookTitle').textContent = r.meta.name + ': layer settings';
    MB.ui.openDialog(d);
    Promise.resolve(MB.imports.load(r)).then(() => (MB.icons ? MB.icons.load().catch(() => {}) : null)).then(render);
  }

  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const fieldOpts = (look, cur, none, keys) => (none ? opt('', none, cur) : '') + (keys || look.fields.map(f => f.key)).map(k => opt(k, (look.fields.find(f => f.key === k) || {}).alias || k, cur)).join('');

  function render() {
    const r = rec();
    if (!r || !ui.dlg || ui.dlg.classList.contains('hidden')) return;
    const look = r.meta.look, body = ui.dlg.querySelector('#impLookBody');
    ui.dlg.querySelectorAll('.look-tabs [data-tab]').forEach(b => { const on = b.dataset.tab === ui.tab; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
    const act = document.activeElement && body.contains(document.activeElement) ? document.activeElement : null; // focus stays on the control (in its row)
    const fl = act && act.dataset.l, fk = act && act.closest('[data-k]') ? act.closest('[data-k]').dataset.k : null;
    if (ui.tab === 'popup') body.innerHTML = popupTab(look);
    else if (ui.tab === 'labels') body.innerHTML = labelsTab(look);
    else body.innerHTML = symbolsTab(look, r);
    if (fl) {
      const scope = fk != null ? body.querySelector(`[data-k="${CSS.escape(fk)}"]`) : body;
      const el = scope && (Array.from(scope.querySelectorAll(`[data-l="${fl}"]`)).find(x => !x.disabled) || scope.querySelector('[data-l]:not([disabled])'));
      if (el) el.focus();
    }
  }

  function popupTab(look) {
    const rows = look.fields.map((f, i) => `<div class="look-field" data-k="${esc(f.key)}">
        <input type="checkbox" data-l="f.show"${f.show !== false ? ' checked' : ''} aria-label="Show ${esc(f.key)}">
        <input type="text" data-l="f.alias" value="${esc(f.alias || '')}" placeholder="${esc(f.key)}" aria-label="Display name of ${esc(f.key)}" spellcheck="false">
        ${MB.iconBtn('up', 'Move up', `data-l="f.up"${i ? '' : ' disabled'}`, '', 'Move ' + f.key + ' up')}${MB.iconBtn('down', 'Move down', `data-l="f.down"${i < look.fields.length - 1 ? '' : ' disabled'}`, '', 'Move ' + f.key + ' down')}
      </div>`).join('');
    return `<div class="row"><label for="lookTitle">Title</label><select id="lookTitle" data-l="title">${fieldOpts(look, look.title, 'Automatic (a name field)')}</select></div>
      <p class="note">The title heads the popup and names the feature. Below: the fields shown in the popup, in this order, each under the name you give it (empty: its own).</p>
      ${look.fields.length ? `<div class="look-fields">${rows}</div><div class="btn-row"><button type="button" class="btn small" data-l="all">Show all</button><button type="button" class="btn small" data-l="none">Hide all</button></div>` : '<p class="note">This layer has no fields: add some in its attribute table.</p>'}`;
  }

  function labelsTab(look) {
    const lb = look.label;
    return `<label class="check"><input type="checkbox" data-l="label.show"${lb.show ? ' checked' : ''}> Show labels on the map</label>
      <div class="row"><label for="lookLabelField">Field</label><select id="lookLabelField" data-l="label.field">${fieldOpts(look, lb.field, 'The title')}</select></div>
      <div class="row"><label for="lookLabelText">Or text</label><input type="text" id="lookLabelText" data-l="label.text" value="${esc(lb.text || '')}" placeholder="{NAME} ({TYPE})" spellcheck="false"></div>
      <p class="note">Field names in braces are replaced by the feature's values; empty: the field above.</p>
      <div class="row"><label>Text color</label><input type="color" data-l="label.color" value="${esc(lb.color || '#ffffff')}"><span class="grow"></span></div>
      <div class="row"><label>Text size</label><input type="range" data-l="label.size" min="9" max="24" step="1" value="${+lb.size || 12}"><span class="val">${+lb.size || 12}px</span></div>
      <label class="check"><input type="checkbox" data-l="label.bg"${lb.bg !== false ? ' checked' : ''}> Label background</label>
      <div class="row"><label for="lookLabelZoom">Show from ${MB.zoomIcon || 'zoom'}</label><input type="number" id="lookLabelZoom" class="narrow" data-l="label.minZoom" min="0" max="22" step="1" value="${+lb.minZoom || 0}"><span class="note">0: at every zoom</span></div>
      <p class="note">Labels that would overlap are left out: zoom in to see more.</p>`;
  }

  function symbolsTab(look, r) {
    const s = look.symbol, types = r.meta.types || '', points = /point/.test(types), shapes = /line|polygon/.test(types), areas = /polygon/.test(types);
    const own = r.fc && r.fc.features.some(f => f.mbStyle);
    const modes = [own || s.mode === 'file' ? ['file', 'File styles'] : null, ['single', 'Single'], ['category', 'By category'], ['graduated', 'Graduated']].filter(Boolean);
    let html = `<div class="seg look-modes" role="radiogroup" aria-label="Symbols">${modes.map(([v, t]) => `<button type="button" role="radio" data-l="mode" data-v="${v}" aria-checked="${s.mode === v}"${s.mode === v ? ' class="active"' : ''}>${t}</button>`).join('')}</div>`;
    const iconRow = (icon, color, which, label) => points ? `<div class="row"><label>${label || 'Icon'}</label><button type="button" class="btn small look-icon" data-l="icon" data-which="${which}" title="Choose an icon">${iconPreview(icon, color)}<span>${icon ? esc(icon) : 'Dot'}</span></button>${icon ? `<button type="button" class="link" data-l="icon-clear" data-which="${which}">Dot</button>` : ''}</div>` : '';
    if (s.mode === 'file' || s.mode === 'single') {
      html += `<div class="row"><label>Color</label><input type="color" data-l="symbol.color" value="${esc(s.color)}"><span class="note">${s.mode === 'file' ? 'for features without their own' : ''}</span></div>`;
      html += iconRow(s.icon, s.color, 'all');
    } else if (s.mode === 'category') {
      html += `<div class="row"><label for="lookCatField">Field</label><select id="lookCatField" data-l="symbol.field">${fieldOpts(look, s.field, '— choose —')}</select></div>`;
      if (s.field) {
        html += `<div class="look-cats">${(s.cats || []).map((c, i) => `<div class="look-cat" data-k="${i}"><input type="color" data-l="cat.color" value="${esc(c.color)}" aria-label="Color of ${esc(c.value || '(empty)')}">${points ? `<button type="button" class="icon-btn mini look-icon-mini" data-l="icon" data-which="${i}" title="Icon for ${esc(c.value || '(empty)')}">${iconPreview(c.icon || s.icon, c.color)}</button>` : ''}<span class="look-cat-v" title="${esc(c.value)}">${esc(c.value === '' ? '(empty)' : c.value)}</span><span class="dim">${(c.count || 0).toLocaleString()}</span></div>`).join('')}
          <div class="look-cat" data-k="other"><input type="color" data-l="symbol.other" value="${esc(s.other || OTHER)}" aria-label="Color of the other values"><span class="look-cat-v">Other${s.more ? ` (${s.more} more value${s.more > 1 ? 's' : ''})` : ''}</span></div></div>`;
        html += iconRow(s.icon, s.other || OTHER, 'all', 'Default icon');
      }
    } else {
      const nums = numericFields(look, r.fc ? r.fc.features : []);
      html += `<div class="row"><label for="lookGradField">Field</label><select id="lookGradField" data-l="symbol.field">${fieldOpts(look, nums.includes(s.field) ? s.field : '', nums.length ? '— choose —' : 'No number fields', nums)}</select></div>
        <div class="row"><label>Classes</label><select data-l="symbol.classes">${[3, 4, 5, 6, 7].map(n => opt(String(n), String(n), String(s.classes || 5))).join('')}</select><select data-l="symbol.method" aria-label="Class method">${opt('equal', 'Equal intervals', s.method)}${opt('quantile', 'Quantiles', s.method)}</select></div>
        <div class="row"><label>Colors</label><select data-l="symbol.ramp">${Object.keys(RAMPS).map(k => opt(k, RAMPS[k].name, s.ramp)).join('')}</select></div>`;
      if (s.field) html += `<div class="look-cats">${legend(look).map(it => `<div class="look-cat"><i class="trk-sw" style="background:${esc(it.color)}"></i><span class="look-cat-v">${esc(it.text)}</span></div>`).join('')}</div>`;
      html += iconRow(s.icon, s.other || OTHER, 'all');
    }
    if (points) html += `<div class="row"><label>Point size</label><input type="range" data-l="symbol.size" min="10" max="48" step="1" value="${s.size || 22}"><span class="val">${s.size || 22}px</span></div>`;
    if (shapes) html += `<div class="row"><label>Line width</label><input type="range" data-l="symbol.width" min="0" max="8" step="0.5" value="${s.width == null ? 2 : s.width}"><span class="val">${s.width == null ? 2 : s.width}px</span></div>`;
    if (areas) html += `<div class="row"><label>Fill</label><input type="range" data-l="symbol.fill" min="0" max="1" step="0.05" value="${s.fill == null ? 0.25 : s.fill}"><span class="val">${Math.round((s.fill == null ? 0.25 : s.fill) * 100)}%</span></div>`;
    if (s.mode === 'file') html += '<p class="note">Width and fill apply to features without a style of their own.</p>';
    return html;
  }

  // An edit in the dialog: into the look, the map following (a slider at once, typed text when it is done).
  let applyTimer = null;
  function apply(r, rebuildDialog) {
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => MB.imports.setLook(r.meta.id, r.meta.look), 120);
    if (rebuildDialog) render();
  }
  function onEdit(e, done) {
    const el = e.target, l = el.dataset.l, r = rec();
    if (!l || !r) return;
    const look = r.meta.look, s = look.symbol, row = el.closest('[data-k]');
    const v = el.type === 'checkbox' ? el.checked : el.type === 'range' || el.type === 'number' ? +el.value : el.value;
    if (el.type === 'range') { const val = el.parentNode.querySelector('.val'); if (val) val.textContent = l === 'symbol.fill' ? Math.round(v * 100) + '%' : v + 'px'; }
    if (!done && el.type !== 'range' && el.type !== 'color') return; // text: when it is done
    if (l === 'f.show' || l === 'f.alias') { const f = look.fields.find(x => x.key === row.dataset.k); if (f) f[l.slice(2)] = l === 'f.alias' ? String(v).trim() : v; apply(r); return; }
    if (l === 'cat.color') { const c = s.cats[+row.dataset.k]; if (c) c.color = v; apply(r); return; }
    if (l === 'title') { look.title = v; apply(r); return; }
    const [obj, key] = l.split('.');
    if (obj === 'label') { look.label[key] = key === 'minZoom' ? Math.max(0, Math.min(22, Math.round(v) || 0)) : v; apply(r); return; }
    if (obj === 'symbol') {
      s[key] = key === 'classes' ? +v : v;
      const features = r.fc ? r.fc.features : [];
      if (s.mode === 'category' && key === 'field') fillCats(look, features);
      if (s.mode === 'graduated' && ['field', 'classes', 'method'].includes(key)) fillBreaks(look, features);
      apply(r, ['field', 'classes', 'method', 'ramp'].includes(key));
    }
  }
  function onClick(e) {
    const b = e.target.closest('[data-l]');
    const r = rec();
    if (!b || !r || b.tagName === 'INPUT' || b.tagName === 'SELECT') return;
    const look = r.meta.look, s = look.symbol, l = b.dataset.l, features = r.fc ? r.fc.features : [];
    if (l === 'mode') {
      s.mode = b.dataset.v;
      if (s.mode === 'category' && s.field) fillCats(look, features);
      if (s.mode === 'graduated') { if (!numericFields(look, features).includes(s.field)) s.field = ''; fillBreaks(look, features); }
      apply(r, true);
    } else if (l === 'f.up' || l === 'f.down') {
      const i = look.fields.findIndex(f => f.key === b.closest('[data-k]').dataset.k), j = i + (l === 'f.up' ? -1 : 1);
      if (i < 0 || j < 0 || j >= look.fields.length) return;
      [look.fields[i], look.fields[j]] = [look.fields[j], look.fields[i]];
      apply(r, true);
    } else if (l === 'all' || l === 'none') { look.fields.forEach(f => { f.show = l === 'all'; }); apply(r, true); }
    else if (l === 'icon-clear') { s.icon = ''; apply(r, true); }
    else if (l === 'icon' && MB.icons) {
      const which = b.dataset.which, cat = which === 'all' ? null : s.cats[+which];
      MB.icons.pick({ color: cat ? cat.color : s.color }).then(res => {
        if (!res) return;
        if (cat) { cat.icon = res.name; cat.color = res.color; } else { s.icon = res.name; if (s.mode === 'single' || s.mode === 'file') s.color = res.color; }
        apply(r, true);
      });
    }
  }

  MB.importStyle = { defaults, schemaOf, syncFields, titleOf, popupRows, labelText, categories, breaksOf, rampColors, numericFields,
    fillCats, fillBreaks, symbolOf, legend, labels, open, RAMPS, fmt, kindOf, render: () => render() };
})(window.MB);
