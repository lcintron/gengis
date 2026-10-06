/* GenGIS - UI: top bar, toolbar, side panels, keyboard shortcuts */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = MB.escapeHtml;

  const toolHints = {
    select: '',
    move: 'Click an object, then drag it to move it. Use Select to edit vertices.',
    marker: 'Click the map to place a marker.',
    text: 'Click the map to place a text label, type your text, then click elsewhere.',
    line: 'Click to add points. Double-click (or click the last point) to finish. Click the first point to close it into a polygon.',
    polygon: 'Click to add vertices. Click the first vertex or double-click to finish.',
    rectangle: 'Click one corner, then click the opposite corner.',
    circle: 'Click the center, then click to set the radius.',
    svg: 'Click the map to place the SVG. Choose a different SVG in the SVG panel.',
    'measure-distance': 'Click points to measure. Double-click or Enter to finish (saved to the active layer), Esc to cancel.',
    'measure-area': 'Click at least 3 points. Double-click or Enter to finish (saved to the active layer), Esc to cancel.'
  };

  MB.ui = {};

  /* ================= top bar ================= */

  function initTopbar() {
    const nameInput = $('#projectName');
    nameInput.addEventListener('change', () => {
      MB.state.projectName = nameInput.value.trim() || 'Untitled map';
      nameInput.value = MB.state.projectName;
      document.title = MB.state.projectName + ' - GenGIS';
      MB.commit('rename project');
    });
    const showName = () => { nameInput.value = MB.state.projectName; document.title = MB.state.projectName + ' - GenGIS'; };
    MB.on('project', showName);
    showName(); // the autosaved project was loaded before this bar was set up: its 'project' event came too early

    $$('#unitsSeg button').forEach(b => b.addEventListener('click', () => MB.setUnits(b.dataset.units)));
    MB.on('units', u => {
      $$('[data-units]').forEach(b => b.classList.toggle('active', b.dataset.units === u));
      MB.ui.setupScale();
      MB.refreshAllTooltips();
      MB.ui.renderProps();
      if (MB.ui.renderSettings) MB.ui.renderSettings();
      if (MB.measure && MB.measure.active && MB.measure.pts.length) MB.measure._redraw(MB.measure.pts[MB.measure.pts.length - 1]);
    });

    const bm = $('#basemapSelect');
    const fillBasemaps = () => {
      bm.innerHTML = '';
      const g1 = document.createElement('optgroup'); g1.label = 'Built-in';
      Object.keys(MB.basemaps).forEach(k => {
        const d = MB.basemaps[k];
        const o = document.createElement('option'); o.value = k;
        o.textContent = d.name + (d.keyGroup && !MB.builtinKey(d.keyGroup) ? ' (needs key)' : '');
        g1.appendChild(o);
      });
      bm.appendChild(g1);
      const custom = (MB.settings && MB.settings.providers) || [];
      if (custom.length) {
        const g2 = document.createElement('optgroup'); g2.label = 'Configured providers';
        custom.forEach(p => { const o = document.createElement('option'); o.value = 'custom:' + p.id; o.textContent = p.name + (p.url.includes('{key}') && !p.key ? ' (needs key)' : ''); g2.appendChild(o); });
        bm.appendChild(g2);
      }
      bm.value = MB.state.basemap;
    };
    fillBasemaps();
    MB.on('providers', fillBasemaps);
    bm.addEventListener('change', () => MB.setBasemap(bm.value));
    MB.on('basemap', k => { bm.value = k; });

    $('#undoBtn').addEventListener('click', () => MB.undo());
    $('#redoBtn').addEventListener('click', () => MB.redo());
    MB.on('history', () => { $('#undoBtn').disabled = !MB.canUndo(); $('#redoBtn').disabled = !MB.canRedo(); });

    const menu = $('#menu');
    $('#menuBtn').addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('hidden'); });
    document.addEventListener('click', e => {
      if (!e.target.closest('.menu-wrap')) menu.classList.add('hidden');
      if (!e.target.closest('.search-wrap')) $('#searchResults').classList.add('hidden');
    });
    menu.addEventListener('click', e => {
      const act = e.target.closest('button') && e.target.closest('button').dataset.act;
      if (!act) return;
      menu.classList.add('hidden');
      MB.ui.menuAction(act);
    });

    // Phones: the units, the base map and the project menu (presenter mode included) move behind the menu button,
    // so the top bar is a single row that never scrolls: a scrolling row clipped the Project dropdown and let the
    // base map list run over the units.
    const more = $('#moreMenu'), moreBtn = $('#moreBtn'), units = $('#unitsSeg'), right = $('.topbar-right');
    const phone = window.matchMedia('(max-width: 640px)');
    const closeMore = () => { more.classList.add('hidden'); moreBtn.setAttribute('aria-expanded', 'false'); };
    const place = () => {
      if (phone.matches) {
        $('[data-slot="units"]', more).appendChild(units);
        $('[data-slot="basemap"]', more).appendChild(bm);
      } else {
        right.insertBefore(units, $('#undoBtn'));
        right.insertBefore(bm, $('#undoBtn'));
        closeMore();
      }
    };
    moreBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!more.classList.contains('hidden')) { closeMore(); return; }
      // the project menu's items as they are now (Install shows only once the browser offers it)
      const items = $('.more-items', more);
      items.innerHTML = '';
      Array.from(menu.children).forEach(c => items.appendChild(c.cloneNode(true)));
      more.classList.remove('hidden');
      moreBtn.setAttribute('aria-expanded', 'true');
    });
    more.addEventListener('click', e => {
      const b = e.target.closest('.more-items button');
      if (b && b.dataset.act) { closeMore(); MB.ui.menuAction(b.dataset.act); }
    });
    document.addEventListener('click', e => { if (!e.target.closest('#moreMenu, #moreBtn')) closeMore(); });
    if (phone.addEventListener) phone.addEventListener('change', place); else phone.addListener(place);
    place();

    $('#fileOpen').addEventListener('change', e => {
      const f = e.target.files[0];
      if (f) MB.openFile(f);
      e.target.value = '';
    });

    $('#sheetClose').addEventListener('click', () => { $('#sidebar').classList.add('collapsed'); setTimeout(() => MB.map.invalidateSize(), 50); });
    $('#sidebarToggle').addEventListener('click', () => {
      $('#sidebar').classList.toggle('collapsed');
      setTimeout(() => MB.map.invalidateSize(), 50);
    });

    // About dialog
    const av = $('#aboutVersion'); if (av) av.textContent = MB.APP.version;
    const sv = $('#splash .ver'); if (sv) sv.textContent = 'Version ' + MB.APP.version;
    $('#aboutDialog').addEventListener('click', e => {
      if (e.target.id === 'aboutDialog' || e.target.dataset.act === 'close') $('#aboutDialog').classList.add('hidden');
    });
  }

  MB.ui.menuAction = function (act) {
    switch (act) {
      case 'new': // nothing is lost: the open project stays in Recent projects (asked first when it could not be saved there)
        MB.projects.newMap();
        break;
      case 'open': if (MB.desktopFiles.available) MB.desktopFiles.open(); else $('#fileOpen').click(); break;
      case 'saveas': MB.desktopFiles.saveAs(); break;
      case 'recent': MB.projects.openDialog(); break;
      case 'save': MB.saveToFile(); break;
      case 'geojson': MB.exportGeoJSON(); break;
      case 'install': if (MB.installPrompt) { MB.installPrompt.prompt(); MB.installPrompt = null; $('#installBtn').classList.add('hidden'); } break;
      case 'about': $('#aboutDialog').classList.remove('hidden'); break;
      case 'present': MB.presenter.enter(); break;
      case 'apis': MB.settingsDialog.open(); break;
    }
  };

  /* ================= search ================= */

  function initSearch() {
    const input = $('#searchInput'), results = $('#searchResults');
    let items = [], activeIdx = -1;

    function render() {
      results.innerHTML = '';
      if (!items.length) {
        results.innerHTML = '<div class="result-item empty">No results</div>';
      }
      items.forEach((r, i) => {
        const d = document.createElement('div');
        d.className = 'result-item' + (i === activeIdx ? ' active' : '');
        d.innerHTML = `<div>${esc(r.label)}</div>${r.type ? `<div class="type">${esc(r.type)}</div>` : ''}`;
        d.addEventListener('click', () => choose(r));
        results.appendChild(d);
      });
      results.classList.remove('hidden');
    }
    function choose(r) {
      results.classList.add('hidden');
      MB.search.goTo(r);
    }
    async function run() {
      const q = input.value.trim();
      if (!q) return;
      results.innerHTML = '<div class="result-item empty">Searching…</div>';
      results.classList.remove('hidden');
      try {
        items = await MB.busy.track('search', 'search results', MB.search.resolve(q));
        activeIdx = -1;
        if (items.length === 1 && items[0].type === 'coordinates') { choose(items[0]); return; }
        render();
      } catch (e) {
        items = [];
        results.innerHTML = `<div class="result-item empty">Search failed: ${esc(e.message)}</div>`;
      }
    }
    $('#searchBtn').addEventListener('click', run);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        if (activeIdx >= 0 && items[activeIdx] && !results.classList.contains('hidden')) choose(items[activeIdx]);
        else run();
        e.preventDefault();
      } else if (e.key === 'Escape') { results.classList.add('hidden'); input.blur(); }
      else if (e.key === 'ArrowDown' && items.length) { activeIdx = (activeIdx + 1) % items.length; render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp' && items.length) { activeIdx = (activeIdx - 1 + items.length) % items.length; render(); e.preventDefault(); }
    });
    input.addEventListener('focus', () => { if (items.length) results.classList.remove('hidden'); });
  }

  /* ================= toolbar ================= */

  function initToolbar() {
    $$('#toolbar button[data-tool]').forEach(b => b.addEventListener('click', () => MB.tools.set(b.dataset.tool)));
    MB.on('tool', name => {
      $$('#toolbar button[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === name));
      const hint = $('#toolHint');
      let text = toolHints[name] || '';
      if (name === 'svg' && MB.svgPlace.svgId && MB.state.svgLibrary[MB.svgPlace.svgId]) {
        text = 'Click the map to place "' + MB.state.svgLibrary[MB.svgPlace.svgId].name + '". Choose a different SVG in the SVG panel.';
      }
      hint.textContent = text;
      hint.classList.toggle('hidden', !text);
      if (name === 'svg') MB.ui.showTab('svg');
      MB.ui.renderSvgPanel();
    });
  }

  /* ================= tabs ================= */

  // Properties is a section of the Layers tab now: showing it opens that tab with the section expanded.
  MB.ui.showTab = function (name) {
    if (name === 'props') { MB.ui.setPropsOpen(true); name = 'layers'; }
    $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
    if (name === 'data' && MB.data) MB.data.renderPanel();
    if ($('#sidebar').classList.contains('collapsed')) { $('#sidebar').classList.remove('collapsed'); setTimeout(() => MB.map.invalidateSize(), 50); }
  };
  function initTabs() {
    // the tabs only: the phone sheet's close button shares the row, and showing a tab reopens the panel
    $$('.tabs button[data-tab]').forEach(b => b.addEventListener('click', () => MB.ui.showTab(b.dataset.tab)));
    let open = true;
    try { open = localStorage.getItem('gengis.propsOpen') !== '0'; } catch (e) { /* storage unavailable */ }
    MB.ui.setPropsOpen(open, true);
    $('#propsToggle').addEventListener('click', () => MB.ui.setPropsOpen($('#propsSection').classList.contains('closed')));
  }

  // Expand or collapse the Properties section (remembered on this device).
  MB.ui.setPropsOpen = function (open, quiet) {
    const sec = $('#propsSection');
    if (!sec) return;
    sec.classList.toggle('closed', !open);
    $('#propsToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!quiet) { try { localStorage.setItem('gengis.propsOpen', open ? '1' : '0'); } catch (e) { /* storage unavailable */ } }
  };

  // Select an object from a click in the layer list and show its properties. The list stays where it is (the selection
  // handler's reveal would scroll it to the first selected row); only the clicked row is kept in view.
  let quietSelect = false;
  function selectFromList(f, multi) {
    quietSelect = true;
    try { if (multi) MB.toggleMulti(f); else MB.selectFeature(f); } finally { quietSelect = false; }
    MB.ui.setPropsOpen(true);
    revealRow(f);
  }

  // Scroll the layer list to an object's row (or the first selected one), if it is out of view.
  function revealRow(f) {
    const row = f && f.mb ? $(`#layerScroll .obj-item[data-fid="${CSS.escape(f.mb.id)}"]`) : $('#layerScroll .obj-item.selected');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
  // An object picked on the map: its properties and its row, opening its layer if collapsed. Also when the selection
  // did not change (it was already selected) or when the pick was a shift-click into a multiple selection.
  MB.ui.revealFeature = function (f) {
    if (!f || !f.mb) return;
    if (MB.ui.collapsed.delete(f.mb.layerId)) MB.ui.renderLayers();
    MB.ui.showTab('props');
    revealRow(f);
  };

  /* ================= layers panel ================= */

  const icons = {
    eye: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M3 3l18 18M10 10a3 3 0 0 0 4 4M6.5 6.7C3.8 8.4 2 12 2 12s3.5 6 10 6c1.6 0 3-.3 4.2-.9M9.5 6.2C10.3 6.1 11.1 6 12 6c6.5 0 10 6 10 6s-.9 1.5-2.5 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="5" y="10" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    unlock: '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="5" y="10" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 10V7a4 4 0 0 1 7.5-2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    up: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 14l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 10l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 20l4-1 11-11-3-3L5 16z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
  };

  MB.ui.collapsed = MB.ui.collapsed || new Set();

  function objectLabel(f) {
    const m = f.mb;
    return m.name || (m.type === 'text' ? (f.pm && f.pm.textArea ? f.pm.getText() : m.text) : '') || MB.typeLabels[m.type];
  }

  function objectRow(f, i, n, layerHidden, layerLocked) {
    const m = f.mb;
    const hidden = m.visible === false, locked = !!m.locked;
    const sw = m.type === 'svg' ? 'transparent' : (m.type === 'text' ? m.style.textColor : m.style.color);
    return `<div class="obj-item${MB.selected === f || (MB.multi && MB.multi.has(f)) ? ' selected' : ''}${hidden || layerHidden ? ' obj-hidden' : ''}" data-fid="${m.id}" title="${esc(MB.typeLabels[m.type])} · click: select and show properties · double-click name: rename">
      <span class="swatch" style="background:${sw}"></span>
      <span class="fname" data-act="rename">${esc(objectLabel(f))}</span>
      <button class="icon-btn mini${hidden ? '' : ' on'}" data-act="vis" title="${hidden ? 'Show' : 'Hide'} object">${hidden ? icons.eyeOff : icons.eye}</button>
      <button class="icon-btn mini${locked || layerLocked ? ' on' : ''}" data-act="lock" title="${locked ? 'Unlock' : 'Lock'} object${layerLocked ? ' (layer is locked)' : ''}">${locked || layerLocked ? icons.lock : icons.unlock}</button>
      <button class="icon-btn mini" data-act="up" title="Bring forward" ${i === 0 ? 'disabled' : ''}>${icons.up}</button>
      <button class="icon-btn mini" data-act="down" title="Send backward" ${i === n - 1 ? 'disabled' : ''}>${icons.down}</button>
      <button class="icon-btn mini danger" data-act="del" title="Delete object" ${locked ? 'disabled' : ''}>${icons.trash}</button>
    </div>`;
  }

  MB.ui.renderLayers = function () {
    const panel = $('#layerScroll');
    const scrollTop = panel.scrollTop;
    const layers = MB.state.layers.slice().reverse(); // top first
    const active = MB.activeLayer();
    let html = `<div class="panel-head"><h3>Layers</h3><button class="btn small" data-act="add-layer">+ Add layer</button></div>
      <div class="layer-tree">`;
    layers.forEach((l, idx) => {
      const isActive = active && active.id === l.id;
      const feats = MB.layerFeatures(l.id).reverse(); // top-most first
      const collapsed = MB.ui.collapsed.has(l.id);
      html += `<div class="layer-node${isActive ? ' active' : ''}${l.visible ? '' : ' hidden-layer'}" data-id="${l.id}">
        <div class="layer-item" title="Click: draw here · double-click name: rename · buttons apply to all objects">
          <button class="chev${collapsed ? ' closed' : ''}" data-act="toggle" title="${collapsed ? 'Expand' : 'Collapse'}">&#9662;</button>
          <span class="active-dot"></span>
          <span class="layer-name" data-act="rename">${esc(l.name)}</span>
          <button class="icon-btn mini" data-act="rename-btn" title="Rename layer">${icons.edit}</button>
          <span class="count">${feats.length}</span>
          <button class="icon-btn mini${l.visible ? ' on' : ''}" data-act="vis" title="${l.visible ? 'Hide' : 'Show'} layer (all objects)">${l.visible ? icons.eye : icons.eyeOff}</button>
          <button class="icon-btn mini${l.locked ? ' on' : ''}" data-act="lock" title="${l.locked ? 'Unlock' : 'Lock'} layer (all objects)">${l.locked ? icons.lock : icons.unlock}</button>
          <button class="icon-btn mini" data-act="up" title="Move layer up" ${idx === 0 ? 'disabled' : ''}>${icons.up}</button>
          <button class="icon-btn mini" data-act="down" title="Move layer down" ${idx === layers.length - 1 ? 'disabled' : ''}>${icons.down}</button>
          <button class="icon-btn mini danger" data-act="del" title="Delete layer and its objects">${icons.trash}</button>
        </div>
        ${collapsed ? '' : `<div class="obj-list">${feats.length ? feats.map((f, i) => objectRow(f, i, feats.length, !l.visible, l.locked)).join('') : '<div class="obj-empty">No objects yet</div>'}</div>`}
      </div>`;
    });
    html += '</div>';
    panel.innerHTML = html;
    panel.scrollTop = scrollTop;

    $('[data-act="add-layer"]', panel).addEventListener('click', () => { MB.createLayer(); MB.commit('add layer'); });

    $$('.layer-item', panel).forEach(item => {
      const id = item.closest('.layer-node').dataset.id;
      item.addEventListener('click', e => {
        const actEl = e.target.closest('[data-act]');
        const act = actEl && actEl.dataset.act;
        if (act === 'toggle') { if (MB.ui.collapsed.has(id)) MB.ui.collapsed.delete(id); else MB.ui.collapsed.add(id); MB.ui.renderLayers(); return; }
        if (act === 'rename-btn') { startRename(item, id); return; }
        if (act === 'vis') { MB.setLayerVisible(id, !MB.getLayer(id).visible); MB.commit('layer visibility'); }
        else if (act === 'lock') { MB.setLayerLocked(id, !MB.getLayer(id).locked); MB.commit('layer lock'); }
        else if (act === 'up') { MB.moveLayer(id, +1); MB.commit('reorder layers'); }
        else if (act === 'down') { MB.moveLayer(id, -1); MB.commit('reorder layers'); }
        else if (act === 'del') {
          const n = MB.layerFeatureCount(id);
          if (!n || confirm(`Delete layer "${MB.getLayer(id).name}" and its ${n} object(s)?`)) { MB.removeLayer(id); MB.commit('delete layer'); }
        }
        else { MB.setActiveLayer(id); MB.tools.refreshDraw(); }
      });
      $('.layer-name', item).addEventListener('dblclick', e => { e.stopPropagation(); startRename(item, id); });
    });

    $$('.obj-item', panel).forEach(item => {
      const fid = item.dataset.fid;
      item.addEventListener('click', e => {
        const f = MB.featureLayers[fid];
        if (!f) return;
        const actEl = e.target.closest('[data-act]');
        const act = actEl && actEl.tagName === 'BUTTON' && actEl.dataset.act;
        if (act === 'vis') MB.setFeatureVisible(fid, f.mb.visible === false);
        else if (act === 'lock') MB.setFeatureLocked(fid, !f.mb.locked);
        else if (act === 'up') MB.moveFeature(fid, +1);
        else if (act === 'down') MB.moveFeature(fid, -1);
        else if (act === 'del') MB.removeFeature(fid);
        else {
          if (MB.tools.current !== 'select' && MB.tools.current !== 'move') MB.tools.set('select');
          if (e.shiftKey) { selectFromList(f, true); return; }
          selectFromList(f);
          const c = MB.featureCenter(f);
          if (c && !MB.map.getBounds().contains(c)) MB.zoomToFeature(f);
        }
      });
      $('.fname', item).addEventListener('dblclick', e => { e.stopPropagation(); startObjectRename(item, fid); });
    });
  };

  function startObjectRename(item, fid) {
    const f = MB.featureLayers[fid];
    if (!f) return;
    const span = $('.fname', item);
    const cur = f.mb.name || '';
    span.innerHTML = `<input type="text" value="${esc(cur)}" placeholder="${esc(objectLabel(f))}">`;
    const inp = span.querySelector('input');
    inp.focus(); inp.select();
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      const v = inp.value.trim();
      if (v !== cur) { f.mb.name = v; MB.ui.bindNameTip(f); MB.commit('rename'); if (MB.selected === f) MB.emit('selection', f); }
      MB.ui.renderLayers();
    };
    inp.addEventListener('blur', finish);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = cur; inp.blur(); } e.stopPropagation(); });
    inp.addEventListener('click', e => e.stopPropagation());
  }

  function startRename(item, id) {
    const span = $('.layer-name', item);
    const cur = MB.getLayer(id).name;
    span.innerHTML = `<input type="text" value="${esc(cur)}">`;
    const inp = span.querySelector('input');
    inp.focus(); inp.select();
    const done = () => { const v = inp.value.trim(); if (v && v !== cur) { MB.renameLayer(id, v); MB.commit('rename layer'); } else MB.ui.renderLayers(); };
    inp.addEventListener('blur', done);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = cur; inp.blur(); } e.stopPropagation(); });
    inp.addEventListener('click', e => e.stopPropagation());
  }

  /* ================= style form ================= */

  function styleForm(sections, getStyle, onChange) {
    const st = Object.assign({}, MB.defaultStyle, getStyle()); // defaults fill in fields older objects lack
    let html = '';
    if (sections.includes('stroke')) {
      html += `<div class="section"><h3>${sections.includes('markerOnly') ? 'Marker' : 'Border / line'}</h3>
        <div class="row"><label>Color</label><input type="color" data-k="color" value="${st.color}"><span class="grow"></span></div>`;
      if (!sections.includes('markerOnly')) {
        html += `<div class="row"><label>Width</label><input type="range" data-k="weight" min="0.5" max="16" step="0.5" value="${st.weight}"><span class="val" data-val="weight">${st.weight}px</span></div>
        <div class="row"><label>Opacity</label><input type="range" data-k="opacity" min="0" max="1" step="0.05" value="${st.opacity}"><span class="val" data-val="opacity">${Math.round(st.opacity * 100)}%</span></div>
        <div class="row"><label>Line style</label><select data-k="dash">${Object.keys(MB.dashStyles).map(k => `<option value="${k}"${st.dash === k ? ' selected' : ''}>${MB.dashStyles[k]}</option>`).join('')}</select></div>`;
      }
      html += '</div>';
    }
    if (sections.includes('fill')) {
      html += `<div class="section"><h3>Fill</h3>
        <label class="check"><input type="checkbox" data-k="fill"${st.fill ? ' checked' : ''}> Fill shape</label>
        <div class="row"><label>Color</label><input type="color" data-k="fillColor" value="${st.fillColor}"><input type="range" data-k="fillOpacity" min="0" max="1" step="0.05" value="${st.fillOpacity}"><span class="val" data-val="fillOpacity">${Math.round(st.fillOpacity * 100)}%</span></div>
      </div>`;
    }
    if (sections.includes('text')) {
      const tog = (k, label, title) => `<button type="button" class="tog${st[k] ? ' on' : ''}" data-toggle="${k}" title="${title}">${label}</button>`;
      const seg = (k, opts) => `<div class="seg small" data-set="${k}">${opts.map(o => `<button type="button" data-v="${o[0]}"${(st[k] || '') === o[0] ? ' class="active"' : ''} title="${o[2] || o[1]}">${o[1]}</button>`).join('')}</div>`;
      html += `<div class="section"><h3>Text</h3>
        <div class="row"><label>Color</label><input type="color" data-k="textColor" value="${st.textColor}"><input type="range" data-k="textSize" min="8" max="64" step="1" value="${st.textSize}"><span class="val" data-val="textSize">${st.textSize}px</span></div>
        <div class="row"><label>Format</label><div class="tog-group">${tog('textBold', '<b>B</b>', 'Bold')}${tog('textItalic', '<i>I</i>', 'Italic')}${tog('textUnderline', '<u>U</u>', 'Underline')}${tog('textStrike', '<s>S</s>', 'Strikethrough')}</div></div>
        <div class="row"><label>Align</label>${seg('textAlign', [['left', '&#8676;', 'Left'], ['center', '&#8801;', 'Center'], ['right', '&#8677;', 'Right']])}</div>
        <div class="row" title="Which side of the text sits on its map point"><label>Anchor H</label>${seg('textHAnchor', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']])}</div>
        <div class="row" title="Which side of the text sits on its map point"><label>Anchor V</label>${seg('textVAnchor', [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']])}</div>
        <div class="row"><label>Background</label><input type="checkbox" data-k="textBgOn"${st.textBgOn ? ' checked' : ''} title="Show background"><input type="color" data-k="textBg" value="${st.textBg}"><span class="grow"></span></div>
      </div>`;
    }
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    $$('[data-k]', wrap).forEach(inp => {
      const k = inp.dataset.k;
      const handler = () => {
        let v;
        if (inp.type === 'checkbox') v = inp.checked;
        else if (inp.type === 'range' || inp.type === 'number') v = +inp.value;
        else v = inp.value;
        const valEl = $(`[data-val="${k}"]`, wrap);
        if (valEl) valEl.textContent = (k === 'weight' || k === 'textSize') ? v + 'px' : Math.round(v * 100) + '%';
        const patch = {}; patch[k] = v;
        onChange(patch);
      };
      inp.addEventListener('input', handler);
      if (inp.type === 'checkbox' || inp.tagName === 'SELECT') inp.addEventListener('change', handler);
    });
    $$('[data-toggle]', wrap).forEach(btn => btn.addEventListener('click', () => {
      const k = btn.dataset.toggle, v = !getStyle()[k];
      btn.classList.toggle('on', v);
      const patch = {}; patch[k] = v; onChange(patch);
    }));
    $$('[data-set]', wrap).forEach(group => group.addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      $$('button', group).forEach(x => x.classList.toggle('active', x === b));
      const patch = {}; patch[group.dataset.set] = b.dataset.v; onChange(patch);
    }));
    return wrap;
  }

  /* ================= properties panel ================= */

  function renderMulti(panel) {
    const list = Array.from(MB.multi);
    const lines = list.filter(l => l.mb.type === 'line' || l.mb.type === 'measure-line');
    panel.innerHTML = `<div class="panel-head"><h3>${list.length} objects selected</h3><button class="btn small ghost" data-act="clear">Clear</button></div>
      <div class="feature-list" style="max-height:180px">${list.map(l => `<div class="feature-item"><span class="swatch" style="background:${l.mb.type === 'svg' ? 'transparent' : l.mb.style.color}"></span><span class="fname">${esc(l.mb.name || MB.typeLabels[l.mb.type])}</span><span class="ftype">${MB.typeLabels[l.mb.type]}</span></div>`).join('')}</div>
      <div class="section" style="margin-top:12px"><h3>Lines (${lines.length})</h3>
        <div class="btn-row"><button class="btn small primary" data-act="join"${lines.length < 1 ? ' disabled' : ''}>Join lines</button><button class="btn small" data-act="poly"${lines.length < 1 ? ' disabled' : ''}>Polygon from lines (keep lines)</button></div>
        <p class="note">Ends must touch. A closed chain becomes a polygon.</p>
      </div>
      <div class="section"><h3>All selected</h3>
        <div class="row"><label>Move to layer</label><select id="multiLayer"><option value="">— choose —</option>${MB.state.layers.slice().reverse().map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></div>
        <div class="btn-row"><button class="btn small danger" data-act="delete">Delete ${list.length} objects</button></div>
      </div>`;
    $$('[data-act]', panel).forEach(btn => btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      if (act === 'clear') MB.deselect();
      else if (act === 'join') MB.joinLines(MB.multi);
      else if (act === 'poly') MB.joinLines(MB.multi, { keepLines: true });
      else if (act === 'delete') MB.deleteMulti();
    }));
    $('#multiLayer', panel).addEventListener('change', e => { if (e.target.value) MB.moveMultiToLayer(e.target.value); });
  }

  MB.ui.renderProps = function () {
    const panel = $('#propsBody');
    const f = MB.selected;
    panel.innerHTML = '';
    $('#propsSub').textContent = MB.multi && MB.multi.size > 1 ? MB.multi.size + ' objects' : (f ? (f.mb.name || MB.typeLabels[f.mb.type]) : 'new shapes');
    if (MB.multi && MB.multi.size > 1) { renderMulti(panel); return; }
    if (!f) {
      panel.innerHTML = `<div class="panel-head"><h3>New shapes</h3><span class="badge" title="Select an object to edit its own style">defaults</span></div>
        <label class="check" title="Each new line, shape, marker and measurement takes the next color of the palette; pick a color below to use that one instead"><input type="checkbox" id="setAutoColor"${MB.state.autoColor !== false ? ' checked' : ''}> A different color for each new object</label>`;
      const previews = () => { MB.tools.refreshDraw(); if (MB.measure.active) MB.measure.restyleTemp(); }; // what the next object will look like
      $('#setAutoColor', panel).addEventListener('change', e => { MB.state.autoColor = e.target.checked; previews(); MB.autosave(); });
      // A chosen color is a pinned color: variation goes off, for shapes and measurements alike.
      const pin = patch => {
        if (('color' in patch || 'fillColor' in patch) && MB.state.autoColor !== false) {
          MB.state.autoColor = false;
          $('#setAutoColor', panel).checked = false;
          MB.toast('New objects now use this color; tick "A different color for each new object" to vary them again', 3500);
        }
      };
      panel.appendChild(styleForm(['stroke', 'fill', 'text'], () => MB.currentStyle, patch => {
        Object.assign(MB.currentStyle, patch);
        pin(patch);
        previews();
        MB.autosave(); // the defaults are saved with the project
      }));
      const mh = document.createElement('div');
      mh.innerHTML = '<hr><div class="panel-head" style="margin-top:12px"><h3>New measurements</h3><span class="badge">defaults</span></div>';
      panel.appendChild(mh);
      panel.appendChild(styleForm(['stroke', 'fill'], () => MB.measureStyle, patch => {
        Object.assign(MB.measureStyle, patch);
        pin(patch);
        previews();
        MB.autosave();
      }));
      const reset = document.createElement('div');
      reset.className = 'btn-row';
      reset.innerHTML = '<button class="btn small ghost">Reset to defaults</button>';
      reset.querySelector('button').addEventListener('click', () => { MB.currentStyle = MB.deepClone(MB.defaultStyle); MB.measureStyle = MB.deepClone(MB.defaultMeasureStyle); MB.state.autoColor = true; previews(); MB.ui.renderProps(); MB.autosave(); });
      panel.appendChild(reset);
      return;
    }

    const m = f.mb;
    const head = document.createElement('div');
    head.innerHTML = `<div class="panel-head"><h3>${MB.typeLabels[m.type]}</h3><span class="badge">${esc((MB.getLayer(m.layerId) || {}).name || '')}</span></div>
      <div class="row"><label>Name</label><input type="text" id="propName" value="${esc(m.name)}" placeholder="Optional name"></div>
      <div class="row"><label>Layer</label><select id="propLayer">${MB.state.layers.slice().reverse().map(l => `<option value="${l.id}"${l.id === m.layerId ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
      <div class="measure-box" id="propMeasure"></div>`;
    panel.appendChild(head);
    $('#propName', panel).addEventListener('change', e => {
      m.name = e.target.value.trim();
      bindNameTip(f);
      MB.commit('rename'); MB.ui.renderLayers();
      $('#propsSub').textContent = m.name || MB.typeLabels[m.type];
    });
    $('#propLayer', panel).addEventListener('change', e => MB.moveFeatureToLayer(m.id, e.target.value));
    MB.ui.renderMeasureBox();
    if (MB.labelTypes.includes(m.type)) panel.appendChild(labelForm(f));

    if (m.type === 'text') {
      const t = document.createElement('div');
      t.innerHTML = `<div class="row"><label>Text</label><textarea id="propText">${esc(f.pm && f.pm.textArea ? f.pm.getText() : m.text || '')}</textarea></div>`;
      panel.appendChild(t);
      $('#propText', panel).addEventListener('input', e => { if (f.pm) { f.pm.setText(e.target.value); m.text = e.target.value; MB.commitDebounced('text'); } });
      panel.appendChild(styleForm(['text'], () => m.style, patch => MB.applyStyle(f, patch)));
    } else if (m.type === 'svg') {
      panel.appendChild(svgProps(f));
    } else if (m.type === 'marker') {
      panel.appendChild(styleForm(['stroke', 'markerOnly'], () => m.style, patch => MB.applyStyle(f, patch)));
    } else if (m.type === 'line' || m.type === 'measure-line') {
      panel.appendChild(styleForm(['stroke'], () => m.style, patch => MB.applyStyle(f, patch)));
    } else {
      panel.appendChild(styleForm(['stroke', 'fill'], () => m.style, patch => MB.applyStyle(f, patch)));
    }

    if (m.type === 'circle') {
      const r = document.createElement('div');
      const iu = MB.inputUnit('radius');
      const val = iu.fromMeters(f.getRadius());
      r.innerHTML = `<div class="row"><label>Radius</label><input type="number" id="propRadius" min="0.0001" step="any" value="${+val.toFixed(iu.label === 'NM' ? 3 : 2)}"><span class="unit">${iu.label}</span></div>`;
      panel.appendChild(r);
      $('#propRadius', panel).addEventListener('change', e => { const v = iu.toMeters(+e.target.value); if (v > 0) { f.setRadius(v); MB.updateTooltip(f); MB.ui.renderMeasureBox(); MB.commit('radius'); } });
    }

    const actions = document.createElement('div');
    actions.className = 'btn-row';
    actions.innerHTML = `<button class="btn small" data-act="zoom">Zoom to</button><button class="btn small" data-act="dup">Duplicate</button>${MB.canConvert(f) ? `<button class="btn small" data-act="convert">${esc(MB.convertLabel(f))}</button>` : ''}
      <button class="btn small" data-act="front">Bring to front</button><button class="btn small" data-act="back">Send to back</button>
      <button class="btn small danger" data-act="del">Delete</button>`;
    actions.addEventListener('click', e => {
      const act = e.target.dataset.act;
      if (act === 'zoom') MB.zoomToFeature(f);
      else if (act === 'dup') { const n = MB.duplicateFeature(m.id); if (n) MB.selectFeature(n); }
      else if (act === 'convert') MB.convertFeature(f);
      else if (act === 'front') MB.featureToEdge(m.id, true);
      else if (act === 'back') MB.featureToEdge(m.id, false);
      else if (act === 'del') MB.removeFeature(m.id);
    });
    panel.appendChild(actions);
  };

  function labelForm(f) {
    const lb = MB.getLabel(f);
    const seg = (k, opts) => `<div class="seg small" data-ls="${k}">${opts.map(o => `<button type="button" data-v="${o[0]}"${lb[k] === o[0] ? ' class="active"' : ''}>${o[1]}</button>`).join('')}</div>`;
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="section"><h3>Name label</h3>
      <label class="check"><input type="checkbox" data-lk="show"${lb.show ? ' checked' : ''}> Show name on the map</label>
      <div class="row"><label>Vertical</label>${seg('v', [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']])}</div>
      <div class="row"><label>Horizontal</label>${seg('h', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']])}</div>
      <div class="row"><label>Text</label><input type="color" data-lk="color" value="${lb.color}"><input type="range" data-lk="size" min="9" max="36" step="1" value="${lb.size}"><span class="val" data-lv="size">${lb.size}px</span></div>
      <label class="check"><input type="checkbox" data-lk="bg"${lb.bg ? ' checked' : ''}> Label background</label>
      ${f.mb.name ? '' : '<p class="note" data-note>Enter a name above to show a label.</p>'}
    </div>`;
    $$('[data-lk]', wrap).forEach(inp => {
      const handler = () => {
        const k = inp.dataset.lk;
        const v = inp.type === 'checkbox' ? inp.checked : (inp.type === 'range' ? +inp.value : inp.value);
        if (k === 'size') $('[data-lv="size"]', wrap).textContent = v + 'px';
        const patch = {}; patch[k] = v;
        MB.setLabel(f, patch);
        if (k === 'show' && v && !f.mb.name) { MB.toast('Give the object a name to show its label'); const n = $('#propName'); if (n) n.focus(); }
      };
      inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'input', handler);
    });
    $$('[data-ls]', wrap).forEach(group => group.addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      $$('button', group).forEach(x => x.classList.toggle('active', x === b));
      const patch = {}; patch[group.dataset.ls] = b.dataset.v;
      if (!MB.getLabel(f).show) patch.show = true, ($('[data-lk="show"]', wrap).checked = true);
      MB.setLabel(f, patch);
    }));
    return wrap;
  }

  function bindNameTip(f) {
    MB.updateLabel(f);
    if (f instanceof L.Path && MB.state.showMeasurements) return;
    if (f.mb.type === 'text' || MB.isMeasureType(f.mb.type)) return;
    if (f.getTooltip()) f.unbindTooltip();
    const labelShown = MB.labelTypes.includes(f.mb.type) && MB.getLabel(f).show;
    if (f.mb.name && !labelShown) f.bindTooltip(f.mb.name, { direction: 'top', className: 'mb-name-tip', offset: f.mb.type === 'marker' ? [0, -30] : [0, 0] });
  }
  MB.ui.bindNameTip = bindNameTip;

  MB.ui.renderMeasureBox = function () {
    const box = $('#propMeasure');
    const f = MB.selected;
    if (!box || !f) return;
    const mm = MB.featureMeasure(f);
    const rows = [];
    const dist = v => MB.formatDistance(v) + ` <span class="alt">${MB.formatDistanceAlt(v)}</span>`;
    if (mm.length != null) rows.push(['Length', dist(mm.length)]);
    if (mm.perimeter != null) rows.push(['Perimeter', dist(mm.perimeter)]);
    if (mm.area != null) rows.push(['Area', MB.formatArea(mm.area) + ` <span class="alt">${MB.formatAreaAlt(mm.area)}</span>`]);
    if (mm.radius != null) rows.push(['Radius', dist(mm.radius)]);
    if (mm.width != null) rows.push(['Size', MB.formatDistance(mm.width) + ' × ' + MB.formatDistance(mm.height)]);
    const c = MB.svgCenter(f);
    rows.push(['Position', MB.formatLatLng(f.getLatLng ? f.getLatLng() : (f.getBounds ? f.getBounds().getCenter() : c))]);
    box.innerHTML = rows.map(r => `<div><span>${r[0]}</span><span>${r[1]}</span></div>`).join('');
  };

  function svgProps(f) {
    const svg = f.mb.svg, lib = MB.state.svgLibrary[svg.svgId] || {};
    const wrap = document.createElement('div');
    const isGround = svg.mode === 'ground';
    const wVal = isGround ? +MB.fromMeters(svg.width).toFixed(2) : svg.width;
    wrap.innerHTML = `<div class="section"><h3>Image</h3>
      <div class="row"><label>File</label><select data-k="svgId">${Object.values(MB.state.svgLibrary).map(l => `<option value="${l.id}"${l.id === svg.svgId ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
      <div class="row"><label>Sizing</label><div class="seg small"><button data-mode="pin"${!isGround ? ' class="active"' : ''}>Fixed pixels</button><button data-mode="ground"${isGround ? ' class="active"' : ''}>Scale with map</button></div></div>
      <div class="row"><label>Width</label><input type="number" data-k="width" min="1" step="any" value="${wVal}"><span class="unit">${isGround ? MB.lengthUnitLabel() : 'px'}</span></div>
      ${isGround ? '' : `<div class="row"><label>Rotation</label><input type="range" data-k="rotation" min="0" max="360" step="1" value="${svg.rotation || 0}"><span class="val" data-val="rotation">${svg.rotation || 0}°</span></div>`}
      <div class="row"><label>Opacity</label><input type="range" data-k="opacity" min="0" max="1" step="0.05" value="${svg.opacity == null ? 1 : svg.opacity}"><span class="val" data-val="opacity">${Math.round((svg.opacity == null ? 1 : svg.opacity) * 100)}%</span></div>
      <p class="note">${esc(lib.name || '')} · ${lib.width ? lib.width + '×' + lib.height : ''}</p></div>`;
    $$('[data-mode]', wrap).forEach(b => b.addEventListener('click', () => {
      const mode = b.dataset.mode;
      if (mode === svg.mode) return;
      // convert width so the image keeps roughly the same on-screen size
      const c = MB.svgCenter(f);
      const mpp = 156543.03392 * Math.cos(c.lat * Math.PI / 180) / Math.pow(2, MB.map.getZoom());
      svg.width = mode === 'ground' ? svg.width * mpp : Math.max(8, Math.round(svg.width / mpp));
      svg.mode = mode;
      MB.rebuildFeature(f);
      MB.commit('svg mode');
    }));
    $$('[data-k]', wrap).forEach(inp => {
      inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'input', () => {
        const k = inp.dataset.k;
        if (k === 'width') { const v = +inp.value; if (!(v > 0)) return; svg.width = isGround ? MB.toMeters(v) : v; }
        else if (k === 'svgId') { svg.svgId = inp.value; MB.rebuildFeature(f); MB.commit('svg image'); return; }
        else svg[k] = +inp.value;
        const valEl = $(`[data-val="${k}"]`, wrap);
        if (valEl) valEl.textContent = k === 'rotation' ? svg.rotation + '°' : Math.round(svg.opacity * 100) + '%';
        MB.refreshSvg(f);
        if (f._mbHandle) f._mbHandle.setLatLng(f.getBounds().getCenter());
        MB.ui.renderMeasureBox();
        MB.commitDebounced('svg');
      });
    });
    return wrap;
  }

  /* ================= SVG panel ================= */

  MB.ui.renderSvgPanel = function () {
    const panel = $('#tab-svg');
    const lib = Object.values(MB.state.svgLibrary);
    const d = MB.svgDefaults;
    const isGround = d.mode === 'ground';
    panel.innerHTML = `<div class="panel-head"><h3>SVG library</h3><button class="btn small" data-act="upload">+ Upload SVG</button></div>
      <div class="drop-zone" id="svgDrop">Drop .svg files here or click to upload</div>
      ${lib.length ? '<div class="svg-grid">' + lib.map(l => `<div class="svg-card${MB.svgPlace.svgId === l.id && MB.tools.current === 'svg' ? ' active' : ''}" data-id="${l.id}" title="Click to place on the map"><button class="del" title="Remove from library">×</button><img src="${l.dataUrl}" alt=""><div class="name">${esc(l.name)}</div></div>`).join('') + '</div>'
        : '<p class="note">Upload an SVG, then click it to place it.</p>'}
      <div class="section" style="margin-top:16px"><h3>Placement defaults</h3>
        <div class="row"><label>Sizing</label><div class="seg small"><button data-mode="pin"${!isGround ? ' class="active"' : ''} title="Same size at every zoom (symbols)">Fixed pixels</button><button data-mode="ground"${isGround ? ' class="active"' : ''} title="Real-world size on the ground (site plans)">Scale with map</button></div></div>
        <div class="row"><label>Width</label><input type="number" id="svgDefWidth" min="1" step="any" value="${isGround ? +MB.fromMeters(d.widthM).toFixed(2) : d.widthPx}"><span class="unit">${isGround ? MB.lengthUnitLabel() : 'px'}</span></div>
        <div class="row"><label>Rotation</label><input type="range" id="svgDefRot" min="0" max="360" value="${d.rotation}"><span class="val" id="svgDefRotVal">${d.rotation}°</span></div>
        <div class="row"><label>Opacity</label><input type="range" id="svgDefOp" min="0" max="1" step="0.05" value="${d.opacity}"><span class="val" id="svgDefOpVal">${Math.round(d.opacity * 100)}%</span></div>
      </div>`;
    const upload = () => $('#svgUpload').click();
    $('[data-act="upload"]', panel).addEventListener('click', upload);
    const drop = $('#svgDrop', panel);
    drop.addEventListener('click', upload);
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); MB.addSvgFiles(e.dataTransfer.files); });
    $$('.svg-card', panel).forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.classList.contains('del')) { MB.removeSvg(card.dataset.id); return; }
        MB.svgPlace.svgId = card.dataset.id;
        if (MB.tools.current !== 'svg') MB.tools.set('svg'); else MB.emit('tool', 'svg');
      });
    });
    $$('[data-mode]', panel).forEach(b => b.addEventListener('click', () => { d.mode = b.dataset.mode; MB.ui.renderSvgPanel(); }));
    $('#svgDefWidth', panel).addEventListener('change', e => { const v = +e.target.value; if (v > 0) { if (isGround) d.widthM = MB.toMeters(v); else d.widthPx = v; } });
    $('#svgDefRot', panel).addEventListener('input', e => { d.rotation = +e.target.value; $('#svgDefRotVal').textContent = d.rotation + '°'; });
    $('#svgDefOp', panel).addEventListener('input', e => { d.opacity = +e.target.value; $('#svgDefOpVal').textContent = Math.round(d.opacity * 100) + '%'; });
  };

  function initSvgUpload() {
    $('#svgUpload').addEventListener('change', e => { MB.addSvgFiles(e.target.files).then(ids => { if (ids.length) { MB.svgPlace.svgId = ids[0]; } }); e.target.value = ''; });
    MB.on('svglibrary', () => MB.ui.renderSvgPanel());
    // allow dropping SVG / project files anywhere on the map
    const mapEl = $('#map');
    mapEl.addEventListener('dragover', e => e.preventDefault());
    mapEl.addEventListener('drop', e => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files || []);
      const svgs = files.filter(f => /\.svg$/i.test(f.name));
      const others = files.filter(f => /\.(geo)?json$/i.test(f.name));
      if (svgs.length) MB.addSvgFiles(svgs).then(ids => { if (ids.length) { MB.svgPlace.svgId = ids[0]; MB.tools.set('svg'); } });
      if (others.length) MB.openFile(others[0]);
    });
  }

  /* ================= places (POI) panel ================= */

  MB.ui.renderPlaces = function () {
    const panel = $('#tab-places');
    panel.innerHTML = `<div class="panel-head"><h3>Points of interest</h3></div>
      <p class="note">Searches OpenStreetMap within the current view.</p>
      <div class="row"><label>Category</label><select id="poiCat"><option value="">— choose —</option>${MB.poiCategories.map((c, i) => `<option value="${i}">${c[0]}</option>`).join('')}</select></div>
      <div class="row"><label>OSM tag</label><input type="text" id="poiTag" placeholder="amenity=cafe, shop=*"></div>
      <div class="row"><label>Name contains</label><input type="text" id="poiName" placeholder="optional"></div>
      <div class="btn-row"><button class="btn primary" id="poiSearch">Search in current view</button><button class="btn ghost" id="poiClear">Clear</button></div>
      <div id="poiStatus" class="note" style="margin-top:10px"></div>
      <div id="poiResults"></div>`;
    $('#poiSearch', panel).addEventListener('click', () => MB.ui.runPoiSearch());
    $('#poiClear', panel).addEventListener('click', () => { MB.ui.clearPoiResults(); });
    $('#poiCat', panel).addEventListener('change', () => { $('#poiTag').value = ''; });
    ['#poiTag', '#poiName'].forEach(s => $(s, panel).addEventListener('keydown', e => { if (e.key === 'Enter') MB.ui.runPoiSearch(); }));
  };

  MB.ui.poiLayer = null;
  MB.ui.clearPoiResults = function () {
    if (MB.ui.poiLayer) { MB.map.removeLayer(MB.ui.poiLayer); MB.ui.poiLayer = null; }
    $('#poiResults').innerHTML = ''; $('#poiStatus').textContent = '';
  };

  MB.ui.runPoiSearch = async function (preset) {
    const catSel = $('#poiCat'), tagInp = $('#poiTag'), nameInp = $('#poiName'), status = $('#poiStatus'), out = $('#poiResults');
    let key = null, value = null, name = nameInp.value.trim();
    if (preset) {
      const idx = MB.poiCategories.findIndex(c => c[2].split('|').includes(preset) || c[0].toLowerCase() === preset.toLowerCase());
      if (idx >= 0) catSel.value = String(idx);
      else if (preset.includes('=')) tagInp.value = preset;
      else { nameInp.value = preset; name = preset; }
    }
    const tag = tagInp.value.trim();
    if (tag) { const p = tag.split('='); key = p[0].trim(); value = (p[1] || '*').trim(); }
    else if (catSel.value !== '') { const c = MB.poiCategories[+catSel.value]; key = c[1]; value = c[2]; }
    if (!key && !name) { status.textContent = 'Choose a category, type an OSM tag, or a name.'; return; }
    status.textContent = 'Searching…'; out.innerHTML = '';
    try {
      const pois = await MB.busy.track('poi', 'points of interest', MB.search.findPois(key, value, name, MB.map.getBounds(), 150));
      MB.ui.showPois(pois);
      status.textContent = pois.length ? `${pois.length} result${pois.length > 1 ? 's' : ''} in view` : 'Nothing found in the current view. Try zooming out or another category.';
    } catch (e) { status.textContent = 'Search failed: ' + e.message; }
  };

  MB.ui.showPois = function (pois) {
    if (MB.ui.poiLayer) MB.map.removeLayer(MB.ui.poiLayer);
    const g = L.featureGroup([], { pmIgnore: true }).addTo(MB.map);
    MB.ui.poiLayer = g;
    const center = MB.map.getCenter();
    pois.sort((a, b) => a.latlng.distanceTo(center) - b.latlng.distanceTo(center));
    const out = $('#poiResults');
    const list = document.createElement('div');
    list.className = 'poi-list';
    pois.forEach(p => {
      const cm = L.circleMarker(p.latlng, { radius: 6, color: '#fff', weight: 1.5, fillColor: '#2f80ed', fillOpacity: .9, pmIgnore: true });
      cm.bindTooltip(p.name, { direction: 'top', className: 'mb-name-tip', offset: [0, -6] });
      cm.on('click', () => addPoi(p));
      cm.addTo(g);
      const item = document.createElement('div');
      item.className = 'poi-item';
      item.innerHTML = `<span class="pname">${esc(p.name)}<div class="pkind">${esc(p.kind)}${p.tags['addr:street'] ? ' · ' + esc((p.tags['addr:housenumber'] || '') + ' ' + p.tags['addr:street']) : ''}</div></span>
        <span class="pdist">${MB.formatDistance(p.latlng.distanceTo(center))}</span><button class="btn small" title="Add as marker to the active layer">+</button>`;
      item.addEventListener('click', e => {
        if (e.target.tagName === 'BUTTON') { addPoi(p); return; }
        MB.map.panTo(p.latlng); cm.openTooltip();
      });
      list.appendChild(item);
    });
    out.innerHTML = '';
    if (pois.length) {
      const all = document.createElement('div');
      all.className = 'btn-row';
      all.innerHTML = `<button class="btn small">Add all ${pois.length} as markers to "${esc(MB.activeLayer().name)}"</button>`;
      all.querySelector('button').addEventListener('click', () => { pois.forEach(p => addPoi(p, true)); MB.commit('add pois'); MB.ui.clearPoiResults(); MB.toast(pois.length + ' markers added'); });
      out.appendChild(all);
      out.appendChild(list);
      if (g.getBounds().isValid() && !MB.map.getBounds().contains(g.getBounds())) MB.map.fitBounds(g.getBounds().pad(0.1));
    }
    function addPoi(p, silent) {
      const f = MB.restoreFeature({ type: 'marker', latlng: [p.latlng.lat, p.latlng.lng], name: p.name, style: MB.newShapeStyle(true) });
      if (f) bindNameTip(f);
      if (!silent) { MB.commit('add poi'); MB.toast('Added "' + p.name + '"'); }
    }
  };

  /* ================= settings panel ================= */

  MB.ui.renderSettings = function () {
    const panel = $('#tab-settings');
    const s = MB.state;
    panel.innerHTML = `<div class="panel-head"><h3>Settings</h3></div>
      <div class="section"><h3>Map overlays</h3><div id="overlaySection"></div></div>
      <div class="section"><h3>Offline areas</h3><div id="offlineSection"></div></div>
      <div class="section"><h3>Units</h3>
        <div class="seg" id="unitsSeg2"><button data-units="metric"${s.units === 'metric' ? ' class="active"' : ''} title="m, km · m², km²">Metric</button><button data-units="imperial"${s.units === 'imperial' ? ' class="active"' : ''} title="ft, mi · ft², mi²">Imperial</button><button data-units="nautical"${s.units === 'nautical' ? ' class="active"' : ''} title="NM (ft or m below 0.1 NM) · ft², mi²">Nautical</button></div>
        <div class="row"${s.units === 'nautical' ? '' : ' style="display:none"'}><label>Short distances</label><select id="setShortUnit"><option value="ft"${s.shortUnit !== 'm' ? ' selected' : ''}>feet</option><option value="m"${s.shortUnit === 'm' ? ' selected' : ''}>meters</option></select></div>
      </div>
      <div class="section"><h3>Interface</h3>
        <div class="row"><label>Tooltip delay</label><select id="setTipDelay">${[0, 500, 1000, 2000, 3000, 5000].map(ms => `<option value="${ms}"${MB.tooltipDelay() === ms ? ' selected' : ''}>${ms === 0 ? 'immediate' : (ms / 1000) + ' s'}</option>`).join('')}</select></div>
        <div class="row"><label>Preload tiles</label><select id="setPrefetch">${[['auto', 'Automatic (off on volunteer servers)'], ['on', 'Always'], ['off', 'Never']].map(([v, t]) => `<option value="${v}"${((MB.settings && MB.settings.prefetchTiles) || 'auto') === v ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
      </div>
      <div class="section"><h3>Drawing</h3>
        <label class="check"><input type="checkbox" id="setMeasure"${s.showMeasurements ? ' checked' : ''}> Measurement labels on shapes</label>
        <label class="check"><input type="checkbox" id="setContinue"${s.continueDrawing ? ' checked' : ''}> Keep drawing tool active</label>
        <label class="check"><input type="checkbox" id="setSnap"${s.snapping ? ' checked' : ''}> Snap to other shapes</label>
      </div>
      <div class="section"><h3>Project</h3>
        <div class="btn-row"><button class="btn small" data-act="save">Save to file</button><button class="btn small" data-act="open">Open file</button><button class="btn small" data-act="geojson">Export GeoJSON</button></div>
        <p class="note" style="margin-top:8px" id="saveWhere"></p>
        <div id="desktopFilesBox"></div>
        <div class="btn-row"><button class="btn small" data-act="recent">Recent projects…</button><button class="btn small" id="setPersist" hidden>Keep on this device</button></div>
        <div class="btn-row"><button class="btn small danger" id="setReset">Reset project</button><button class="btn small ghost" data-act="about">About</button></div>
      </div>
      <div class="section"><h3>About</h3>
        <div class="measure-box"><div><span>Application</span><span>${esc(MB.APP.name)} (${esc(MB.APP.aka)})</span></div><div><span>Version</span><span id="appVersion">${esc(MB.APP.version)}</span></div></div>
      </div>
      <div class="section"><h3>Services</h3>
        <div class="btn-row"><button class="btn small" data-act="apis" title="Tile providers, API keys, geocoder and Overpass endpoints">Map &amp; search APIs…</button><button class="btn small" data-act="present">Presenter mode</button></div>
      </div>`;
    if (MB.data && MB.data.renderOverlays) MB.data.renderOverlays();
    if (MB.offline && MB.offline.renderSection) MB.offline.renderSection();
    $$('#unitsSeg2 button', panel).forEach(b => b.addEventListener('click', () => MB.setUnits(b.dataset.units)));
    $('#setShortUnit', panel).addEventListener('change', e => MB.setShortUnit(e.target.value));
    $('#setMeasure', panel).addEventListener('change', e => { s.showMeasurements = e.target.checked; MB.refreshAllTooltips(); MB.autosave(); });
    $('#setTipDelay', panel).addEventListener('change', e => { MB.settings.tooltipDelayMs = +e.target.value; MB.saveSettings(); });
    $('#setPrefetch', panel).addEventListener('change', e => { MB.settings.prefetchTiles = e.target.value; MB.saveSettings(); MB.tilePrefetch.lastKey = ''; MB.tilePrefetch.schedule(); });
    $('#setContinue', panel).addEventListener('change', e => { s.continueDrawing = e.target.checked; MB.autosave(); MB.tools.refreshDraw(); });
    $('#setSnap', panel).addEventListener('change', e => { s.snapping = e.target.checked; MB.autosave(); MB.tools.refreshDraw(); });
    $$('[data-act]', panel).forEach(b => b.addEventListener('click', () => MB.ui.menuAction(b.dataset.act)));
    $('#setReset', panel).addEventListener('click', async () => {
      if (!confirm('Delete this project (its layers, objects and SVG library) and its saved copies on this device? Other projects stay.')) return;
      await MB.projects.flush();
      await MB.clearAutosave();
      MB.projects.startFresh();
      MB.toast('Project reset');
    });
    $('#setPersist', panel).addEventListener('click', () => MB.projects.persist(true).then(ok => MB.toast(ok ? 'Kept on this device: the browser will not clear it to free space.' : 'The browser did not agree to keep it. Save important projects to a file.', 4500)));
    MB.ui.renderSaveWhere();
    MB.ui.renderDesktopFiles();
  };

  /* ================= saving status ================= */

  // Next to the project name: Saving… / Saved / Not saved, with the details on hover.
  function initSaveStatus() {
    const el = $('#saveStatus');
    const render = st => {
      const at = st.savedAt ? new Date(st.savedAt).toLocaleTimeString() : '';
      const view = {
        idle: ['', ''],
        saving: ['Saving…', 'Saving on this device'],
        saved: ['Saved', `Saved on this device${at ? ' at ' + at : ''} (${st.where})${MB.desktopFiles.file ? '\nFile: ' + MB.desktopFiles.file : ''}`],
        error: ['Not saved', 'Autosave failed: ' + st.error + '. Save the project to a file.'],
        readonly: ['Not saving', 'This map is open in another tab or window; changes here are not saved.']
      }[st.status] || ['', ''];
      el.textContent = view[0];
      el.title = view[1];
      el.dataset.state = st.status;
      MB.ui.renderSaveWhere();
    };
    MB.on('savestate', render);
    MB.on('desktopfiles', () => { render(MB.projects); MB.ui.renderDesktopFiles(); });
    render(MB.projects);
    // the desktop app: Save as, and Save project writes the project's file rather than downloading a copy
    if (MB.desktopFiles.available) {
      $$('[data-act="saveas"]').forEach(b => b.classList.remove('hidden'));
      $$('#menu [data-act="save"]').forEach(b => { b.textContent = 'Save project'; });
    }
  }

  // Settings -> Project, desktop app: the projects folder and the open project's file.
  MB.ui.renderDesktopFiles = function () {
    const box = $('#desktopFilesBox'), F = MB.desktopFiles;
    if (!box) return;
    if (!F.available) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="desktop-files">
        <div class="row"><label>Folder</label><span class="path" title="${esc(F.folder || '')}">${esc(F.folder || '…')}</span></div>
        <div class="row"><label>This project</label><span class="path" title="${esc(F.file || '')}">${F.file ? esc(F.file) : '<span class="dim">gets a file once it is named or saved</span>'}</span></div>
        <div class="btn-row"><button class="btn small" data-df="folder">Change folder…</button><button class="btn small" data-df="show">Show in folder</button><button class="btn small" data-df="saveas">Save as…</button></div>
        <p class="note">Each named project is also kept as a file here, saved a moment after every change.</p>
      </div>`;
    box.querySelector('[data-df="folder"]').addEventListener('click', () => F.chooseFolder());
    box.querySelector('[data-df="show"]').addEventListener('click', () => F.reveal());
    box.querySelector('[data-df="saveas"]').addEventListener('click', () => F.saveAs());
  };

  // Settings → Project: where projects are kept and whether the browser may clear them.
  MB.ui.renderSaveWhere = function () {
    const p = MB.projects, note = $('#saveWhere'), btn = $('#setPersist');
    if (!note) return;
    const kept = p.persisted === true ? 'The browser will not clear them to free space.'
      : (p.persisted === false ? 'The browser may clear them if the device runs low on space: save important projects to a file, or keep them on this device.' : '');
    note.textContent = 'Projects are saved automatically on this device as you work; reopen them from Recent projects. ' + kept;
    if (btn) btn.hidden = p.persisted !== false;
  };

  /* ================= scale + status controls ================= */

  MB.ui.setupScale = function () {
    if (!MB.scaleControl) MB.scaleControl = new MB.TwoBlockScale({ position: 'bottomright', maxWidth: 200 }).addTo(MB.map);
    MB.scaleControl.update();
  };

  function initStatus() {
    const Status = L.Control.extend({
      onAdd() {
        const div = L.DomUtil.create('div', 'mb-status');
        div.textContent = '—';
        this._div = div;
        return div;
      }
    });
    const ctl = new Status({ position: 'bottomleft' }).addTo(MB.map);
    MB.statusControl = ctl;
    ctl._div.innerHTML = '<div class="coords"></div>';
    const upd = ll => {
      const z = MB.map.getZoom();
      ctl._div.querySelector('.coords').textContent = (ll ? MB.formatLatLng(ll) : MB.formatLatLng(MB.map.getCenter())) + '  ·  zoom ' + z.toFixed(1).replace(/\.0$/, '');
    };
    MB.map.on('mousemove', e => upd(e.latlng));
    MB.map.on('moveend zoomend', () => upd());
    upd();
  }

  /* ================= keyboard ================= */

  function initKeys() {
    document.addEventListener('keydown', e => {
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === 'Escape') {
        if (MB.contextMenu && MB.contextMenu.isOpen()) { MB.contextMenu.hide(); return; }
        if (MB.presenter && MB.presenter.active) { MB.presenter.exit(); return; }
        if (typing) { t.blur(); return; }
        if (MB.measure.active && MB.measure.pts.length) { MB.measure.cancel(); return; }
        if (MB.tools.current !== 'select') { MB.tools.set('select'); return; }
        if (MB.selected || (MB.multi && MB.multi.size)) { MB.deselect(); return; }
        MB.search.clearMarker();
        return;
      }
      if (typing) return;
      if (MB.presenter && MB.presenter.active) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) MB.redo(); else MB.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); MB.redo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); MB.saveToFile(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && MB.selected) { e.preventDefault(); const n = MB.duplicateFeature(MB.selected.mb.id); if (n) MB.selectFeature(n); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { if (MB.multi && MB.multi.size > 1) { e.preventDefault(); MB.deleteMulti(); return; } if (MB.selected) { e.preventDefault(); if (MB.isFeatureLocked(MB.selected)) MB.toast('Object is locked'); else MB.removeFeature(MB.selected.mb.id); } return; }
      if (e.key === 'Enter' && MB.measure.active) { MB.measure.finish(); return; }
      if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); $('#searchInput').select(); return; }
      if (e.key.toLowerCase() === 'f') { e.preventDefault(); MB.presenter.enter(); return; }
      const map = { v: 'select', g: 'move', m: 'marker', t: 'text', l: 'line', p: 'polygon', r: 'rectangle', c: 'circle', s: 'svg', d: 'measure-distance', a: 'measure-area' };
      const tool = map[e.key.toLowerCase()];
      if (tool) { e.preventDefault(); MB.tools.set(tool); }
    });
  }

  /* ================= init ================= */

  MB.ui.init = function () {
    initTopbar();
    initSaveStatus();
    initSearch();
    initToolbar();
    initTabs();
    initSvgUpload();
    initKeys();
    initStatus();
    MB.ui.setupScale();
    MB.ui.renderLayers();
    MB.ui.renderProps();
    MB.ui.renderSvgPanel();
    MB.ui.renderPlaces();
    MB.ui.renderSettings();

    MB.on('layers', () => { MB.ui.renderLayers(); if (MB.selected) MB.ui.renderProps(); });
    MB.on('features', () => MB.ui.renderLayers());
    MB.on('selection', l => {
      // Picked on the map (not in the layer list): show its properties and its row, opening its layer if collapsed.
      const reveal = !quietSelect && !!(l || (MB.multi && MB.multi.size > 1));
      if (reveal && l && l.mb) MB.ui.collapsed.delete(l.mb.layerId);
      MB.ui.renderProps();
      MB.ui.renderLayers();
      if (reveal) { MB.ui.showTab('props'); revealRow(l); }
    });
    MB.on('multi-contextmenu', info => MB.menus.multi(info));
    MB.on('featurechange', l => { if (l === MB.selected) MB.ui.renderMeasureBox(); });
    MB.on('project', () => { MB.ui.renderSettings(); MB.ui.renderSvgPanel(); $('#basemapSelect').value = MB.state.basemap; });
    MB.on('poi-request', term => { MB.ui.showTab('places'); setTimeout(() => MB.ui.runPoiSearch(term), 800); });
    MB.on('feature-contextmenu', info => MB.menus.feature(info));
    MB.map.on('contextmenu', e => { if (MB.presenter.active) return; MB.menus.map(e); });
    $('#presentBtn').addEventListener('click', () => MB.presenter.enter());
    MB.on('history', () => {
      // keep name tips in sync after undo/redo, and refresh the layer list (color swatches, labels)
      Object.keys(MB.featureLayers).forEach(id => { const f = MB.featureLayers[id]; if (f.mb.name && !f.getTooltip()) bindNameTip(f); });
      MB.ui.renderLayers();
    });
  };
})(window.MB);
