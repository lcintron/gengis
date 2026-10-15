/* GenGIS - preset shapes (the toolbar's Shapes button)
 * - the button opens a palette beside the toolbar: rectangle, triangle, pentagon, hexagon, octagon, star, lightning;
 *   the shape chosen stays on the button, and R draws it again
 * - the rectangle is the drawing tool's own (two clicks); the others are drawn by dragging a box on the map (Shift
 *   keeps the shape's own proportions) or by a click (a default size), and saved as a polygon named after the shape,
 *   edited, measured and styled like any other
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const DEFAULT_PX = 120; // a shape placed by a click: this wide on screen
  const MIN_DRAG = 6;     // px: less is a click
  // A regular polygon of n corners (or a star of n points), as [x, y] with y down; even ones lie flat on a side.
  const regular = (n, inner) => {
    const pts = [], k = inner ? 2 * n : n, rot = -Math.PI / 2 + (!inner && n % 2 === 0 ? Math.PI / n : 0);
    for (let i = 0; i < k; i++) {
      const a = rot + i * 2 * Math.PI / k, r = inner && i % 2 ? inner : 1;
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return pts;
  };
  const PRESETS = [
    { id: 'rectangle', name: 'Rectangle' },
    { id: 'triangle', name: 'Triangle', pts: regular(3) },
    { id: 'pentagon', name: 'Pentagon', pts: regular(5) },
    { id: 'hexagon', name: 'Hexagon', pts: regular(6) },
    { id: 'octagon', name: 'Octagon', pts: regular(8) },
    { id: 'star', name: 'Star', pts: regular(5, 0.382) },
    { id: 'lightning', name: 'Lightning', pts: [[4, 14], [14, 2], [11.9, 10], [20, 10], [10, 22], [12.1, 14]] }
  ];
  // Each outline fitted to a 0..1 box, with its own width : height.
  PRESETS.forEach(p => {
    if (!p.pts) { p.unit = [[0, 0], [1, 0], [1, 1], [0, 1]]; p.aspect = 4 / 3; return; }
    const xs = p.pts.map(q => q[0]), ys = p.pts.map(q => q[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0, h = Math.max(...ys) - y0;
    p.unit = p.pts.map(([x, y]) => [(x - x0) / w, (y - y0) / h]);
    p.aspect = w / h;
  });
  const byId = id => PRESETS.find(p => p.id === id) || PRESETS[0];

  // The shape as an icon (24 x 24, its proportions kept).
  function iconSvg(p) {
    const s = 17, w = p.aspect >= 1 ? s : s * p.aspect, h = p.aspect >= 1 ? s / p.aspect : s, x = 12 - w / 2, y = 12 - h / 2;
    const d = p.unit.map(([u, v], i) => (i ? 'L' : 'M') + (x + u * w).toFixed(2) + ' ' + (y + v * h).toFixed(2)).join('') + 'Z';
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
  }

  MB.shapes = {
    presets: PRESETS,
    get current() { return byId(MB.settings && MB.settings.shapePreset).id; },
    toolOf(id) { return id === 'rectangle' ? 'rectangle' : 'shape'; },
    btn: null, palette: null, preview: null, down: null,

    init() {
      const btn = this.btn = document.getElementById('shapeBtn');
      if (!btn) return;
      const pal = this.palette = document.createElement('div');
      pal.id = 'shapePalette';
      pal.className = 'shape-palette hidden';
      pal.setAttribute('role', 'menu');
      pal.setAttribute('aria-label', 'Shapes');
      pal.innerHTML = PRESETS.map(p => `<button type="button" role="menuitemradio" data-shape="${p.id}" title="${p.name}" aria-label="${p.name}">${iconSvg(p)}</button>`).join('');
      document.getElementById('mapwrap').appendChild(pal);
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (MB.tools.current === btn.dataset.tool) { this.close(); MB.tools.set('select'); return; } // drawing: the button puts it away
        if (pal.classList.contains('hidden')) this.open(); else this.close();
      });
      pal.addEventListener('click', e => {
        const b = e.target.closest('[data-shape]');
        if (!b) return;
        this.choose(b.dataset.shape);
      });
      pal.addEventListener('keydown', e => {
        const items = Array.from(pal.querySelectorAll('[data-shape]')), i = items.indexOf(document.activeElement);
        const d = { ArrowRight: 1, ArrowDown: 4, ArrowLeft: -1, ArrowUp: -4 }[e.key];
        if (d && i >= 0) { e.preventDefault(); items[Math.max(0, Math.min(items.length - 1, i + d))].focus(); }
        if (e.key === 'Escape') { e.stopPropagation(); this.close(); btn.focus(); }
      });
      document.addEventListener('pointerdown', e => { if (!e.target.closest('#shapePalette, #shapeBtn')) this.close(); });
      pal.addEventListener('focusout', e => { if (!e.relatedTarget || !e.relatedTarget.closest('#shapePalette, #shapeBtn')) this.close(); }); // tabbed away
      window.addEventListener('resize', () => this.close());
      MB.on('tool', () => this.close());
      // drawing a preset: a box dragged on the map
      const c = MB.map.getContainer();
      c.addEventListener('pointerdown', e => this.onDown(e));
      c.addEventListener('pointermove', e => this.onMove(e));
      c.addEventListener('pointerup', e => this.onUp(e));
      c.addEventListener('pointercancel', () => this.cancel());
      MB.map.on('zoomstart', () => this.cancel()); // a zoom mid-drag: the box's start point no longer lies where it did
      this.renderButton();
    },

    // The button shows the shape it draws, and stands for its tool (the toolbar marks the tool in use).
    renderButton() {
      const p = byId(this.current);
      this.btn.dataset.tool = this.toolOf(p.id);
      this.btn.title = `Shapes: ${p.name} (R)`;
      this.btn.setAttribute('aria-label', `Shapes: ${p.name}`);
      this.btn.innerHTML = iconSvg(p).replace('<svg ', '<svg class="shape-icon" ');
    },

    open() {
      const pal = this.palette, b = this.btn.getBoundingClientRect(), wrap = document.getElementById('mapwrap').getBoundingClientRect();
      pal.querySelectorAll('[data-shape]').forEach(x => { const on = x.dataset.shape === this.current; x.classList.toggle('active', on); x.setAttribute('aria-checked', on); });
      pal.classList.remove('hidden');
      // beside the toolbar, on the side with room (the toolbar can be on either side)
      const tb = document.getElementById('toolbar').getBoundingClientRect(), right = tb.left + tb.width / 2 < wrap.left + wrap.width / 2;
      const left = right ? tb.right + 8 : tb.left - 8 - pal.offsetWidth;
      const top = Math.max(wrap.top + 8, Math.min(b.top, wrap.bottom - pal.offsetHeight - 8));
      pal.style.left = (left - wrap.left) + 'px';
      pal.style.top = (top - wrap.top) + 'px';
      this.btn.setAttribute('aria-expanded', 'true');
      (pal.querySelector('.active') || pal.querySelector('[data-shape]')).focus();
    },
    close() {
      if (!this.palette || this.palette.classList.contains('hidden')) return;
      this.palette.classList.add('hidden');
      this.btn.setAttribute('aria-expanded', 'false');
    },

    choose(id) {
      MB.settings.shapePreset = byId(id).id;
      MB.saveSettings();
      this.renderButton();
      this.close();
      const tool = this.toolOf(this.current);
      if (MB.tools.current !== tool) MB.tools.set(tool); // already drawing presets: the next one is this shape
      else MB.emit('tool', tool); // the toolbar and the hint
    },
    // R: draw the button's shape (again: put the tool away, as any tool's key does)
    activate() { MB.tools.set(this.toolOf(this.current)); },

    /* ----- drawing a preset by dragging a box ----- */
    // A drag draws, so the map does not pan; a double-click is two shapes' clicks, so it does not zoom either.
    start() {
      MB.map.dragging.disable(); MB.map.boxZoom.disable(); MB.map.doubleClickZoom.disable();
      MB.map.getContainer().classList.add('mb-shape-draw'); // a finger's drag draws: not a scroll for the browser (app.css)
    },
    stop() { // on any change of tool (start() follows for this one)
      this.cancel();
      MB.map.dragging.enable(); MB.map.boxZoom.enable(); MB.map.doubleClickZoom.enable();
      MB.map.getContainer().classList.remove('mb-shape-draw');
    },
    active() { return MB.tools.current === 'shape'; },

    onDown(e) {
      if (!this.active() || e.button !== 0 || e.target.closest('.leaflet-control, #toolbar, #shapePalette, .leaflet-popup')) return;
      e.preventDefault();
      this.down = { p: MB.map.mouseEventToContainerPoint(e), id: e.pointerId };
      try { MB.map.getContainer().setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    },
    onMove(e) {
      if (!this.down || e.pointerId !== this.down.id) return;
      const pts = this.outline(this.down.p, MB.map.mouseEventToContainerPoint(e), e.shiftKey);
      if (!pts) return;
      const ls = Object.assign(MB.toLeafletStyle(MB.newShapeStyle()), { interactive: false, dashArray: '6,4', pmIgnore: true });
      if (!this.preview) this.preview = L.polygon(pts, ls).addTo(MB.map);
      else this.preview.setLatLngs(pts);
    },
    onUp(e) {
      if (!this.down || e.pointerId !== this.down.id) return;
      const p0 = this.down.p, p1 = MB.map.mouseEventToContainerPoint(e);
      this.cancel();
      let pts = this.outline(p0, p1, e.shiftKey);
      if (!pts) { // a click: the default size, unless it is the second click of a double-click (one shape is enough)
        const last = this.lastClick, now = Date.now();
        this.lastClick = { t: now, p: p0 };
        if (last && now - last.t < 350 && last.p.distanceTo(p0) < MIN_DRAG) return;
        pts = this.outline(p0, null, true);
      }
      this.add(pts);
    },
    cancel() {
      if (this.preview) { MB.map.removeLayer(this.preview); this.preview = null; }
      this.down = null;
    },

    // The outline (lat/lngs) in the box from p0 to p1 (container px), the shape's own proportions with Shift; null
    // for less than a drag. Without p1: centered on p0 at the default size.
    outline(p0, p1, keep) {
      const p = byId(this.current);
      let x0, y0, w, h;
      if (!p1) { w = DEFAULT_PX; h = DEFAULT_PX / p.aspect; x0 = p0.x - w / 2; y0 = p0.y - h / 2; }
      else {
        let dx = p1.x - p0.x, dy = p1.y - p0.y;
        if (Math.abs(dx) < MIN_DRAG && Math.abs(dy) < MIN_DRAG) return null;
        if (keep) { // as wide as the drag allows at the shape's proportions
          const s = Math.max(Math.abs(dx), Math.abs(dy) * p.aspect);
          dx = Math.sign(dx || 1) * s; dy = Math.sign(dy || 1) * s / p.aspect;
        }
        x0 = Math.min(p0.x, p0.x + dx); y0 = Math.min(p0.y, p0.y + dy); w = Math.abs(dx); h = Math.abs(dy);
      }
      return p.unit.map(([u, v]) => MB.map.containerPointToLatLng([x0 + u * w, y0 + v * h]));
    },

    add(latlngs) {
      const p = byId(this.current);
      const f = MB.restoreFeature({ type: 'polygon', latlngs: [latlngs.map(ll => [ll.lat, ll.lng])], layerId: MB.activeLayer().id, name: p.name, style: MB.newShapeStyle(true) });
      if (!f) return;
      MB.commit('draw ' + p.name.toLowerCase());
      MB.noteAdded(f);
      if (!MB.state.continueDrawing) { MB.tools.set('select'); MB.selectFeature(f); }
    }
  };
})(window.MB);
