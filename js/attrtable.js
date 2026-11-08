/* GenGIS - attributes: the fields of a layer's objects, and the attribute table that edits them
 * - a project object can carry attributes (mb.attrs: { field: value }) as an imported feature does; they are saved
 *   with it, travel in GeoJSON, and are edited in Properties or in its layer's attribute table. A layer keeps the
 *   fields added to it with no value yet (layer.fields), so they show for every object
 * - the attribute table: one row per object or feature, one column per field; search, sort, edit a value in place,
 *   add, rename and delete fields, a row's button zooms to it. Large layers in pages of 100 rows.
 *   It works on an adapter, so imported layers (fileimports.js) and the project's layers share it:
 *   { title, fields() -> [{ key, label, fixed }], rows() -> [row], get(row, key), set(row, key, value),
 *     addField(key) -> error text or '', renameField(from, to) -> error text or '', deleteField(key), zoom(row) }
 * API: MB.attrs.typed(text, was), fieldsOf(layerId), set(feature, key, value), tableFor(layerId);
 *   MB.attrTable.open(adapter), refresh()
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = s => (MB.escapeHtml ? MB.escapeHtml(s) : String(s));
  const PAGE = 100;
  const NAME = '\u0000name'; // the Name column of a project layer (an object's name, not an attribute)
  const show = v => (v == null ? '' : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));
  const badKey = k => (!k ? 'Give the field a name' : k.length > 64 ? 'A field name is at most 64 characters' : '');

  // What a typed value is: a number where it reads as one (and the field held numbers, or nothing yet; leading zeros
  // stay text: "007"), true/false in a field of those, otherwise text; nothing for an empty box.
  function typed(text, was) {
    const t = String(text == null ? '' : text).trim();
    if (t === '') return null;
    if (typeof was === 'boolean' && /^(true|false)$/i.test(t)) return /^true$/i.test(t);
    if ((typeof was === 'number' || was == null) && /^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(t)) return +t;
    return t;
  }

  /* ---------- the project's objects ---------- */
  const objectsOf = layerId => Object.keys(MB.featureLayers || {}).map(id => MB.featureLayers[id]).filter(f => f.mb && f.mb.layerId === layerId);
  // A layer's fields: those it keeps, then those its objects have, in the order first met.
  function fieldsOf(layerId) {
    const lay = MB.getLayer && MB.getLayer(layerId), keys = new Set((lay && lay.fields) || []);
    objectsOf(layerId).forEach(f => Object.keys((f.mb && f.mb.attrs) || {}).forEach(k => keys.add(k)));
    return Array.from(keys);
  }
  function set(f, key, value) {
    const m = f.mb;
    if (value == null || value === '') { if (m.attrs) delete m.attrs[key]; }
    else (m.attrs = m.attrs || {})[key] = value;
    if (m.attrs && !Object.keys(m.attrs).length) delete m.attrs;
  }
  function tableFor(layerId) {
    const lay = () => MB.getLayer(layerId);
    const commit = what => { MB.commit(what); MB.emit('features'); };
    return {
      title: () => (lay() ? lay().name : 'Layer') + ': attributes',
      fields: () => [{ key: NAME, label: 'Object name', fixed: true }].concat(fieldsOf(layerId).map(k => ({ key: k, label: k }))),
      rows: () => objectsOf(layerId),
      get: (f, k) => (k === NAME ? f.mb.name || '' : ((f.mb.attrs || {})[k])),
      set(f, k, v) {
        if (k === NAME) { f.mb.name = v == null ? '' : String(v); if (MB.ui && MB.ui.bindNameTip) MB.ui.bindNameTip(f); commit('rename'); if (MB.ui) MB.ui.renderLayersSoon && MB.ui.renderLayersSoon(); }
        else { set(f, k, v); commit('attribute'); }
        if (MB.selected === f && MB.ui) MB.ui.renderProps();
      },
      addField(k) {
        const l = lay(), why = badKey(k) || (fieldsOf(layerId).includes(k) ? 'There is a field of that name already' : '');
        if (why || !l) return why;
        l.fields = (l.fields || []).concat(k);
        commit('add field');
        return '';
      },
      renameField(from, to) {
        const l = lay(), why = badKey(to) || (to !== from && fieldsOf(layerId).includes(to) ? 'There is a field of that name already' : '');
        if (why || !l) return why;
        if (to === from) return '';
        objectsOf(layerId).forEach(f => { const a = f.mb.attrs; if (a && from in a) { const v = a[from]; delete a[from]; a[to] = v; } });
        if (l.fields) l.fields = l.fields.map(k => (k === from ? to : k));
        commit('rename field');
        return '';
      },
      deleteField(k) {
        const l = lay();
        objectsOf(layerId).forEach(f => set(f, k, null));
        if (l && l.fields) { l.fields = l.fields.filter(x => x !== k); if (!l.fields.length) delete l.fields; }
        commit('delete field');
      },
      zoom(f) { if (MB.zoomToFeature) MB.zoomToFeature(f); if (MB.selectFeature) MB.selectFeature(f); },
      rowLabel: f => f.mb.name || (MB.typeLabels && MB.typeLabels[f.mb.type]) || 'Object'
    };
  }

  /* ---------- the table ---------- */
  const T = { dlg: null, ad: null, q: '', sort: null, dir: 1, page: 0, list: [], renaming: null };

  function dialog() {
    if (T.dlg) return T.dlg;
    const d = T.dlg = document.createElement('div');
    d.id = 'attrDialog';
    d.className = 'modal hidden';
    d.innerHTML = `<div class="modal-box attr-box" role="dialog" aria-modal="true" aria-labelledby="attrTitle">
      <button type="button" class="modal-x" data-act="close" aria-label="Close" title="Close">✕</button>
      <h2 id="attrTitle">Attributes</h2>
      <div class="attr-tools">
        <input type="text" inputmode="search" enterkeyhint="search" id="attrSearch" placeholder="Search values" spellcheck="false" aria-label="Search values">
        <form class="attr-add" id="attrAddForm"><input type="text" id="attrNewField" placeholder="New field" spellcheck="false" aria-label="New field name"><button type="submit" class="btn small with-icon">${MB.ICON.plus}Add field</button></form>
      </div>
      <div class="attr-scroll" id="attrScroll"><table class="attr-table"><thead id="attrHead"></thead><tbody id="attrBody"></tbody></table></div>
      <div class="attr-foot"><span class="note" id="attrCount" role="status" aria-live="polite"></span><span class="grow"></span>
        <button type="button" class="icon-btn mini" data-at="prev" title="Previous page" aria-label="Previous page">${MB.ICON.up.replace('M6 15l6-6 6 6', 'M15 6l-6 6 6 6')}</button><span class="note" id="attrPage"></span><button type="button" class="icon-btn mini" data-at="next" title="Next page" aria-label="Next page">${MB.ICON.up.replace('M6 15l6-6 6 6', 'M9 6l6 6-6 6')}</button></div>
    </div>`;
    document.body.appendChild(d);
    MB.ui.wireDialog(d);
    const search = d.querySelector('#attrSearch');
    search.addEventListener('input', MB.debounce(() => { T.q = search.value.trim().toLowerCase(); T.page = 0; build(); }, 200));
    d.querySelector('#attrAddForm').addEventListener('submit', e => {
      e.preventDefault();
      const inp = d.querySelector('#attrNewField'), why = T.ad.addField(inp.value.trim());
      if (why) { MB.toast(why); inp.focus(); return; }
      inp.value = '';
      build();
      const sc = d.querySelector('#attrScroll'); sc.scrollLeft = sc.scrollWidth;
    });
    d.querySelector('.attr-foot').addEventListener('click', e => {
      const b = e.target.closest('[data-at]');
      if (!b) return;
      const pages = Math.max(1, Math.ceil(T.list.length / PAGE));
      T.page = Math.max(0, Math.min(pages - 1, T.page + (b.dataset.at === 'next' ? 1 : -1)));
      paint();
      d.querySelector('#attrScroll').scrollTop = 0;
    });
    const head = d.querySelector('#attrHead'), body = d.querySelector('#attrBody');
    head.addEventListener('click', e => {
      const sortBtn = e.target.closest('[data-sort]'), menuBtn = e.target.closest('[data-col]');
      if (sortBtn) { const k = sortBtn.dataset.sort; if (T.sort === k) T.dir = -T.dir; else { T.sort = k; T.dir = 1; } build(); return; }
      if (menuBtn) colMenu(menuBtn.dataset.col, menuBtn);
    });
    head.addEventListener('keydown', e => {
      const inp = e.target.closest('input[data-rename]');
      if (!inp) return;
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); inp.value = inp.dataset.rename; inp.blur(); }
    });
    head.addEventListener('focusout', e => {
      const inp = e.target.closest('input[data-rename]');
      if (!inp || T.renaming == null) return;
      const from = inp.dataset.rename, to = inp.value.trim();
      T.renaming = null;
      const why = T.ad.renameField(from, to);
      if (why) MB.toast(why); else if (T.sort === from) T.sort = to;
      build();
    });
    body.addEventListener('change', e => {
      const inp = e.target.closest('input[data-k]');
      if (!inp) return;
      const row = T.list[+inp.closest('tr').dataset.i];
      if (!row) return;
      const k = inp.dataset.k, v = k === NAME ? inp.value : typed(inp.value, T.ad.get(row, k));
      T.ad.set(row, k, v);
      inp.value = show(T.ad.get(row, k));
      inp.title = inp.value;
    });
    body.addEventListener('keydown', e => {
      const inp = e.target.closest('input[data-k]');
      if (!inp || e.key !== 'Enter') return;
      e.preventDefault(); // Enter: the cell below, as a spreadsheet
      const tr = inp.closest('tr').nextElementSibling, next = tr && tr.querySelector(`input[data-k="${CSS.escape(inp.dataset.k)}"]`);
      if (next) next.focus(); else inp.blur();
    });
    body.addEventListener('click', e => {
      const b = e.target.closest('[data-zoom]');
      if (!b) return;
      const row = T.list[+b.closest('tr').dataset.i];
      if (row) { MB.ui.closeDialog(d); T.ad.zoom(row); }
    });
    return d;
  }

  function colMenu(key, btn) {
    const r = btn.getBoundingClientRect(), f = T.ad.fields().find(x => x.key === key);
    if (!f) return;
    MB.contextMenu.show(r.left, r.bottom + 2, [
      { label: 'Sort ascending', action: () => { T.sort = key; T.dir = 1; build(); } },
      { label: 'Sort descending', action: () => { T.sort = key; T.dir = -1; build(); } },
      { sep: true },
      { label: 'Rename field', disabled: f.fixed, action: () => { T.renaming = key; paintHead(); const inp = T.dlg.querySelector('input[data-rename]'); if (inp) { inp.focus(); inp.select(); } } },
      { label: 'Delete field', danger: true, disabled: f.fixed, action: () => { if (confirm(`Delete the field "${key}" and its values from every row?`)) { T.ad.deleteField(key); if (T.sort === key) T.sort = null; build(); } } }
    ]);
  }

  // The rows matching the search, sorted; then the page drawn.
  function build() {
    const ad = T.ad, fields = ad.fields().map(f => f.key);
    let list = ad.rows();
    if (T.q) list = list.filter(r => fields.some(k => show(ad.get(r, k)).toLowerCase().includes(T.q)));
    if (T.sort) {
      const k = T.sort, d = T.dir;
      list = list.slice().sort((a, b) => {
        const x = ad.get(a, k), y = ad.get(b, k);
        if (x == null || x === '') return y == null || y === '' ? 0 : 1; // empty last, either way
        if (y == null || y === '') return -1;
        return (typeof x === 'number' && typeof y === 'number' ? x - y : show(x).localeCompare(show(y), undefined, { numeric: true, sensitivity: 'base' })) * d;
      });
    }
    T.list = list;
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    if (T.page >= pages) T.page = pages - 1;
    paint();
  }
  function paintHead() {
    const fields = T.ad.fields();
    T.dlg.querySelector('#attrHead').innerHTML = `<tr><th class="attr-n" scope="col"><span class="sr-only">Zoom to</span></th>${fields.map(f => {
      const arrow = T.sort === f.key ? (T.dir > 0 ? ' ▲' : ' ▼') : '';
      const label = T.renaming === f.key ? `<input type="text" class="attr-rename" data-rename="${esc(f.key)}" value="${esc(f.key)}" aria-label="New name for ${esc(f.key)}" spellcheck="false">`
        : `<button type="button" class="attr-sort" data-sort="${esc(f.key)}" title="Sort by ${esc(f.label)}"${T.sort === f.key ? ` aria-sort="${T.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${esc(f.label)}${arrow}</button>`;
      return `<th scope="col"><div class="attr-th">${label}${MB.iconBtn('more', 'Field options', `data-col="${esc(f.key)}" aria-haspopup="menu"`, '', 'Options for ' + f.label)}</div></th>`;
    }).join('')}</tr>`;
  }
  function paint() {
    const ad = T.ad, fields = ad.fields(), d = T.dlg;
    paintHead();
    const from = T.page * PAGE, rows = T.list.slice(from, from + PAGE);
    d.querySelector('#attrBody').innerHTML = rows.map((r, i) => `<tr data-i="${from + i}"><td class="attr-n">${MB.iconBtn('goto', 'Zoom to', 'data-zoom', '', 'Zoom to ' + (ad.rowLabel ? ad.rowLabel(r) : 'row ' + (from + i + 1)))}</td>${fields.map(f => {
      const v = show(ad.get(r, f.key));
      return `<td><input type="text" class="attr-cell" data-k="${esc(f.key)}" value="${esc(v)}" title="${esc(v)}" aria-label="${esc(f.label)}, row ${from + i + 1}" spellcheck="false"></td>`;
    }).join('')}</tr>`).join('') || `<tr><td colspan="${fields.length + 1}" class="note">${T.q ? 'No row matches.' : 'No rows.'}</td></tr>`;
    const total = ad.rows().length, pages = Math.max(1, Math.ceil(T.list.length / PAGE));
    d.querySelector('#attrCount').textContent = (T.q ? `${T.list.length.toLocaleString()} of ${total.toLocaleString()}` : total.toLocaleString()) + ` row${total === 1 ? '' : 's'} · ${(fields.length - fields.filter(f => f.fixed).length)} field${fields.length === 1 ? '' : 's'}`;
    d.querySelector('#attrPage').textContent = pages > 1 ? `${T.page + 1} / ${pages}` : '';
    d.querySelectorAll('.attr-foot [data-at]').forEach(b => { b.hidden = pages < 2; b.disabled = (b.dataset.at === 'prev' ? T.page === 0 : T.page >= pages - 1); });
  }

  MB.attrTable = {
    open(adapter) {
      const d = dialog();
      Object.assign(T, { ad: adapter, q: '', sort: null, dir: 1, page: 0, renaming: null });
      d.querySelector('#attrSearch').value = '';
      d.querySelector('#attrNewField').value = '';
      d.querySelector('#attrTitle').textContent = typeof adapter.title === 'function' ? adapter.title() : adapter.title;
      build();
      MB.ui.openDialog(d);
    },
    // Redrawn when the rows changed elsewhere (an undo, a feature removed), if it is open.
    refresh() { if (T.dlg && !T.dlg.classList.contains('hidden') && T.ad) build(); },
    isOpen: () => !!(T.dlg && !T.dlg.classList.contains('hidden'))
  };
  MB.attrs = { typed, fieldsOf, set, tableFor, NAME };
})(window.MB);
