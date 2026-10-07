/* GenGIS - right-click context menus for objects and the map */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = MB.escapeHtml;

  MB.contextMenu = {
    el: null, actions: null,

    isOpen() { return !!(this.el && !this.el.classList.contains('hidden')); },

    show(x, y, items) {
      this.hide();
      if (!this.el) {
        const el = document.createElement('ul');
        el.className = 'mb-ctx hidden';
        el.addEventListener('click', e => {
          const li = e.target.closest('li[data-id]');
          if (!li || li.classList.contains('disabled') || li.classList.contains('has-sub')) return;
          const fn = this.actions && this.actions.get(li.dataset.id);
          this.hide();
          if (fn) fn();
        });
        el.addEventListener('mouseover', e => {
          const li = e.target.closest('li.has-sub');
          if (!li) return;
          const sub = li.querySelector('ul');
          if (!sub) return;
          sub.style.left = ''; sub.style.right = '';
          const r = sub.getBoundingClientRect();
          if (r.right > window.innerWidth) { sub.style.left = 'auto'; sub.style.right = '100%'; }
        });
        el.addEventListener('contextmenu', e => e.preventDefault());
        document.body.appendChild(el);
        document.addEventListener('mousedown', e => { if (!e.target.closest('.mb-ctx')) this.hide(); });
        window.addEventListener('blur', () => this.hide());
        window.addEventListener('resize', () => this.hide());
        if (MB.map) MB.map.on('movestart zoomstart', () => this.hide());
        this.el = el;
      }
      this.actions = new Map();
      let n = 0;
      const render = list => list.map(it => {
        if (it.sep) return '<li class="sep"></li>';
        const id = 'm' + (n++);
        if (it.action) this.actions.set(id, it.action);
        const cls = [it.disabled ? 'disabled' : '', it.children ? 'has-sub' : '', it.danger ? 'danger' : ''].filter(Boolean).join(' ');
        return `<li data-id="${id}" class="${cls}"><span class="lbl">${it.html || esc(it.label)}</span>` +
          (it.hint ? `<span class="hint">${esc(it.hint)}</span>` : '') +
          (it.children ? `<span class="arrow">&#9656;</span><ul class="mb-ctx sub">${render(it.children)}</ul>` : '') + '</li>';
      }).join('');
      this.el.innerHTML = render(items);
      this.el.classList.remove('hidden');
      const w = this.el.offsetWidth, h = this.el.offsetHeight;
      const px = Math.max(4, Math.min(x, window.innerWidth - w - 4));
      const py = Math.max(4, Math.min(y, window.innerHeight - h - 4));
      this.el.style.left = px + 'px';
      this.el.style.top = py + 'px';
    },

    hide() { if (this.el) this.el.classList.add('hidden'); }
  };

  function copyText(txt) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(() => MB.toast('Copied ' + txt)).catch(() => fallbackCopy(txt));
    } else fallbackCopy(txt);
  }
  function fallbackCopy(txt) {
    const ta = document.createElement('textarea');
    ta.value = txt; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); MB.toast('Copied ' + txt); } catch (e) { prompt('Copy:', txt); }
    document.body.removeChild(ta);
  }
  MB.copyText = copyText;

  MB.menus = {
    // Right-click on an object
    feature(info) {
      const { layer, latlng, x, y } = info;
      const m = layer.mb;
      const lay = MB.getLayer(m.layerId) || {};
      const locked = MB.isFeatureLocked(layer);
      const center = MB.featureCenter(layer);
      const isPoint = m.type === 'marker' || m.type === 'text' || m.type === 'svg' || m.type === 'circle';
      const items = [
        { label: 'Properties…', disabled: locked, action: () => { MB.selectFeature(layer); MB.ui.showTab('props'); } },
        { label: 'Center map here', action: () => MB.map.panTo(center) },
        { label: 'Zoom to fit', action: () => MB.zoomToFeature(layer) },
        { sep: true },
        { label: 'Copy coordinates', hint: MB.formatLatLng(latlng, 5), action: () => copyText(MB.formatLatLng(latlng, 6)) },
        { label: isPoint ? 'Copy object position' : 'Copy object center', hint: MB.formatLatLng(center, 5), action: () => copyText(MB.formatLatLng(center, 6)) },
        { sep: true }
      ];
      if (m.type === 'text') {
        items.push({ label: 'Edit text', disabled: locked, action: () => { MB.tools.set('select'); MB.selectFeature(layer); try { layer.pm.focus(); } catch (e) { /* ignore */ } } });
      }
      items.push(
        { label: 'Rename…', disabled: locked, action: () => {
          const v = prompt('Object name', m.name || '');
          if (v === null) return;
          m.name = v.trim();
          MB.ui.bindNameTip(layer);
          MB.commit('rename');
          MB.emit('selection', MB.selected);
        } },
        ...(MB.labelTypes.includes(m.type) ? [{ label: MB.getLabel(layer).show ? 'Hide name label' : 'Show name label', disabled: locked, action: () => {
          const show = !MB.getLabel(layer).show;
          if (show && !m.name) {
            const v = prompt('Object name (shown as the label)', '');
            if (!v || !v.trim()) return;
            m.name = v.trim();
          }
          MB.setLabel(layer, { show });
          MB.emit('selection', MB.selected);
        } }] : []),
        ...(MB.canConvert(layer) ? [{ label: MB.convertLabel(layer), disabled: locked, action: () => MB.convertFeature(layer) }] : []),
        { label: 'Duplicate', hint: 'Ctrl+D', disabled: locked, action: () => { const n = MB.duplicateFeature(m.id); if (n) MB.selectFeature(n); } },
        { label: 'Move to layer', disabled: locked, children: MB.state.layers.slice().reverse().map(l => ({
          label: l.name, disabled: l.id === m.layerId, action: () => MB.moveFeatureToLayer(m.id, l.id)
        })) },
        { label: MB.tools.current === 'move' ? 'Edit vertices (Select tool)' : 'Move whole object (Move tool)', disabled: locked, action: () => {
          MB.tools.set(MB.tools.current === 'move' ? 'select' : 'move');
          MB.selectFeature(layer);
        } },
        ...(MB.canScale(layer) && MB.tools.current !== 'scale' ? [{ label: 'Resize (Scale tool)', hint: 'K', disabled: locked, action: () => {
          MB.tools.set('scale');
          MB.selectFeature(layer);
        } }] : []),
        { sep: true }
      );
      if (m.type !== 'svg') {
        items.push(
          { label: 'Copy style', action: () => MB.copyStyle(layer) },
          { label: 'Paste style', disabled: !MB.styleClipboard || locked, action: () => MB.pasteStyle(layer) }
        );
      }
      if (layer.bringToFront) {
        items.push(
          { label: 'Bring to front', action: () => MB.featureToEdge(layer.mb.id, true) },
          { label: 'Send to back', action: () => MB.featureToEdge(layer.mb.id, false) }
        );
      }
      items.push(
        { sep: true },
        { label: m.locked ? 'Unlock object' : 'Lock object', action: () => MB.setFeatureLocked(m.id, !m.locked) },
        { label: 'Hide object', hint: 'Layers panel to show', action: () => MB.setFeatureVisible(m.id, false) },
        { label: (lay.locked ? 'Unlock layer "' : 'Lock layer "') + (lay.name || '') + '"', action: () => { MB.setLayerLocked(lay.id, !lay.locked); MB.commit('layer lock'); } },
        { label: 'Delete', hint: 'Del', danger: true, disabled: locked, action: () => MB.removeFeature(m.id) }
      );
      MB.contextMenu.show(x, y, items);
    },

    // Right-click on one of several selected objects
    multi(info) {
      const list = Array.from(MB.multi);
      const lines = list.filter(l => l.mb.type === 'line' || l.mb.type === 'measure-line');
      MB.contextMenu.show(info.x, info.y, [
        { label: list.length + ' objects selected', disabled: true },
        { sep: true },
        { label: 'Join lines', disabled: lines.length < 1, hint: lines.length + ' line' + (lines.length === 1 ? '' : 's'), action: () => MB.joinLines(MB.multi) },
        { label: 'Create polygon from lines (keep lines)', disabled: lines.length < 1, action: () => MB.joinLines(MB.multi, { keepLines: true }) },
        { sep: true },
        { label: 'Move to layer', children: MB.state.layers.slice().reverse().map(l => ({ label: l.name, action: () => MB.moveMultiToLayer(l.id) })) },
        { label: 'Copy coordinates', hint: MB.formatLatLng(info.latlng, 5), action: () => MB.copyText(MB.formatLatLng(info.latlng, 6)) },
        { sep: true },
        { label: 'Clear selection', hint: 'Esc', action: () => MB.deselect() },
        { label: 'Delete ' + list.length + ' objects', hint: 'Del', danger: true, action: () => MB.deleteMulti() }
      ]);
    },

    // Right-click on the empty map
    map(e) {
      const ll = e.latlng;
      const x = e.originalEvent.clientX, y = e.originalEvent.clientY;
      const hasSvg = Object.keys(MB.state.svgLibrary).length > 0;
      const items = [
        { label: 'Copy coordinates', hint: MB.formatLatLng(ll, 5), action: () => copyText(MB.formatLatLng(ll, 6)) },
        { label: 'Center map here', action: () => MB.map.panTo(ll) },
        { label: 'Zoom in here', action: () => MB.map.setView(ll, Math.min(MB.map.getMaxZoom ? MB.map.getMaxZoom() : 19, MB.map.getZoom() + 2)) },
        { sep: true },
        { label: 'Add marker here', action: () => {
          const f = MB.restoreFeature({ type: 'marker', latlng: [ll.lat, ll.lng], style: MB.newShapeStyle(true) });
          MB.commit('add marker'); MB.tools.set('select'); if (f) MB.selectFeature(f); MB.noteAdded(f);
        } },
        { label: 'Add text here', action: () => {
          const f = MB.restoreFeature({ type: 'text', latlng: [ll.lat, ll.lng], text: 'Label', style: MB.deepClone(MB.currentStyle) });
          MB.commit('add text'); MB.tools.set('select'); MB.noteAdded(f);
          if (f) { MB.selectFeature(f); try { f.pm.focus(); f.pm.textArea.select(); } catch (err) { /* ignore */ } }
        } },
        { label: 'Place SVG here', disabled: !hasSvg, action: () => {
          const id = (MB.svgPlace.svgId && MB.state.svgLibrary[MB.svgPlace.svgId]) ? MB.svgPlace.svgId : Object.keys(MB.state.svgLibrary)[0];
          const f = MB.createSvgFeature(ll, id);
          MB.commit('place svg'); MB.tools.set('select'); if (f) MB.selectFeature(f); MB.noteAdded(f);
        } },
        { label: 'Measure from here', action: () => {
          MB.tools.set('measure-distance');
          MB.measure._click({ latlng: ll, containerPoint: MB.map.latLngToContainerPoint(ll) });
        } },
        { sep: true },
        { label: "What's here?", action: async () => {
          MB.toast('Looking up address…');
          try {
            const r = await MB.search.reverse(ll);
            MB.search.showMarker(ll, r.display_name || r.name || 'No address found');
          } catch (err) { MB.toast('Lookup failed: ' + err.message); }
        } }
      ];
      if (MB.selected) items.push({ sep: true }, { label: 'Deselect', hint: 'Esc', action: () => MB.deselect() });
      MB.contextMenu.show(x, y, items);
    }
  };
})(window.MB);
