/* GenGIS - preset shapes (the toolbar's Shapes button)
 * - the button opens a palette beside the toolbar: rectangle, triangle, pentagon, hexagon, octagon, star, lightning;
 *   the shape chosen stays on the button, and R draws it again
 * - the rectangle is the drawing tool's own (corner to corner, from its center, or three points: MB.rectDraw at the
 *   foot of this file); the others are drawn by dragging a box on the map (Shift
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
      MB.rectDraw.patch(); // the rectangle tool's three modes, before anything is drawn
      MB.rectDraw.apply();
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

  /* ----- the rectangle tool's three modes -----
   * Corner (two opposite corners, as it always was), Center (the center, then a corner) and Three-point (two clicks
   * for one side, a third for the depth: a rectangle at any angle). The mode is remembered on this device and
   * chosen in the tool hint; Geoman draws the rectangle either way, with its preview, snapping and readout.
   */
  const RECT_MODES = [
    {
      id: 'corner', name: 'Corner', title: 'Corner to corner',
      icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="16" height="12" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="4" cy="6" r="2.4" fill="currentColor"/><circle cx="20" cy="18" r="2.4" fill="currentColor"/></svg>'
    },
    {
      id: 'center', name: 'Center', title: 'Center, then a corner',
      icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="16" height="12" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="20" cy="18" r="2.4" fill="currentColor"/></svg>'
    },
    {
      id: 'three', name: 'Angled', title: 'Two points for one side, then the depth',
      icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12L7.3 17L16.3 11L13 6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="4" cy="12" r="2.4" fill="currentColor"/><circle cx="13" cy="6" r="2.4" fill="currentColor"/></svg>'
    }
  ];
  const MIN_RECT_PX = 2; // less across than this: nothing is drawn (a stray click, not a rectangle)

  MB.rectDraw = {
    modes: RECT_MODES,
    el: null,
    pending: null, // the corners a three-point rectangle is to get (read in tools.js when it is created)

    get mode() {
      const m = MB.settings && MB.settings.rectMode;
      return RECT_MODES.some(x => x.id === m) ? m : 'corner';
    },

    setMode(m) {
      if (!RECT_MODES.some(x => x.id === m) || m === this.mode) return;
      MB.settings.rectMode = m;
      MB.saveSettings();
      this.apply();
      if (MB.tools.current === 'rectangle') { MB.map.pm.disableDraw(); MB.tools.startDraw('rectangle'); } // a half-drawn one goes
      MB.emit('tool', 'rectangle'); // the hint's instructions and the buttons
    },

    // The center mode's first point is a center, not a corner: Geoman's start marker shows an X there (css/app.css).
    apply() {
      if (MB.map) MB.map.getContainer().classList.toggle('mb-rect-center', this.mode === 'center');
    },

    // The buttons, where the tool's instructions go (one node, kept and re-used: ui.js appends it each render).
    controls() {
      if (!this.el) {
        const el = this.el = document.createElement('div');
        el.className = 'seg small rect-modes';
        el.setAttribute('role', 'radiogroup');
        el.setAttribute('aria-label', 'Rectangle mode');
        el.innerHTML = RECT_MODES.map(m => `<button type="button" role="radio" data-rect-mode="${m.id}" title="${m.title}" aria-checked="false">${m.icon}<span>${m.name}</span></button>`).join('');
        el.addEventListener('click', e => { const b = e.target.closest('[data-rect-mode]'); if (b) this.setMode(b.dataset.rectMode); });
        el.addEventListener('keydown', e => { if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation(); }); // the app's letter shortcuts stay out
        MB.ui.radios(el);
      }
      const cur = this.mode;
      this.el.querySelectorAll('[data-rect-mode]').forEach(b => {
        const on = b.dataset.rectMode === cur;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on);
        b.tabIndex = on ? 0 : -1;
      });
      return this.el;
    },

    /* Geoman's rectangle draws from two opposite corners. The other two modes work out the corners themselves (in
     * the map's own projection, so the rectangle is square on the map), then hand Geoman the diagonal of what they
     * made: it creates, styles and fires the rectangle as it always does. */
    patch() {
      const P = L.PM && L.PM.Draw && L.PM.Draw.Rectangle && L.PM.Draw.Rectangle.prototype;
      if (!P || P._mbRectModes || !P.enable || !P._syncRectangleSize || !P._finishShape) return;
      P._mbRectModes = true;
      const self = this;
      // the map's projection at this zoom, and back: unrounded, so a corner does not land on the pixel grid
      const px = ll => MB.map.project(ll, MB.map.getZoom());
      const latlng = p => MB.map.unproject(L.point(p.x, p.y), MB.map.getZoom());
      const enable = P.enable, sync = P._syncRectangleSize, finish = P._finishShape;
      // Geoman's two corner markers: on the corners the pointer is not on
      const styleAt = (draw, pts) => {
        if (!draw.options.cursorMarker || !draw._styleMarkers) return;
        pts.forEach((p, i) => { try { draw._styleMarkers[i].setLatLng(p); } catch (e) { /* ignore */ } });
      };

      P.enable = function (...a) {
        delete this._mbBase; // a side left half drawn by the last turn of the tool
        return enable.apply(this, a);
      };

      // The preview under the pointer.
      P._syncRectangleSize = function () {
        const mode = self.mode;
        if (mode === 'corner' || this._mbFinishing) return sync.call(this);
        const start = px(this._startMarker.getLatLng()), hint = px(this._hintMarker.getLatLng());
        if (mode === 'center') {
          const ring = MB.rectFromCenter(start, hint).map(latlng);
          this._layer.setLatLngs(ring);
          styleAt(this, [ring[1], ring[3]]);
          return;
        }
        if (!this._mbBase) { this._layer.setLatLngs([this._startMarker.getLatLng(), this._hintMarker.getLatLng()]); return; } // the side being drawn
        const ring = MB.rectFrom3(start, px(this._mbBase), hint);
        if (!ring) return;
        const corners = ring.map(latlng);
        this._layer.setLatLngs(corners);
        styleAt(this, [this._mbBase, corners[1]]);
      };

      // A click: the depth of a three-point rectangle, or the finished shape.
      P._finishShape = function (e) {
        const mode = self.mode;
        if (mode === 'corner') return finish.call(this, e);
        if (e && e.latlng && !this._hintMarker._snapped) this._hintMarker.setLatLng(e.latlng); // (as Geoman's own does)
        const startLL = this._startMarker.getLatLng(), hintLL = this._hintMarker.getLatLng();
        const start = px(startLL), hint = px(hintLL);
        if (mode === 'three' && !this._mbBase) { // the second click ends the side; the rectangle takes a third
          if (Math.abs(hint.x - start.x) < MIN_RECT_PX && Math.abs(hint.y - start.y) < MIN_RECT_PX) return;
          this._mbBase = L.latLng(hintLL.lat, hintLL.lng);
          this._syncRectangleSize();
          return;
        }
        const ring = mode === 'center' ? MB.rectFromCenter(start, hint) : MB.rectFrom3(start, px(this._mbBase), hint);
        if (!ring) return;
        const side = p => Math.sqrt((p[1].x - p[0].x) ** 2 + (p[1].y - p[0].y) ** 2);
        if (side([ring[0], ring[1]]) < MIN_RECT_PX || side([ring[0], ring[3]]) < MIN_RECT_PX) return; // too small to be meant
        const corners = ring.map(latlng);
        if (mode === 'three') self.pending = corners; // turned: tools.js gives the new rectangle these corners
        this._mbFinishing = true;
        try {
          this._startMarker.setLatLng(corners[0]);
          this._hintMarker.setLatLng(corners[2]); // the diagonal Geoman builds from
          finish.call(this);
        } finally {
          delete this._mbFinishing;
          delete this._mbBase;
          self.pending = null;
        }
      };
    }
  };
})(window.MB);
