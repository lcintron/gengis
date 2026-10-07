/* GenGIS - the Scale tool: a box with eight handles around the selected object; dragging one resizes the object */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  // Handles: where each sits on the box, as which way it pulls (-1 left/top, 1 right/bottom, 0 neither).
  const HANDLES = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };
  const MIN = 4; // px: the smallest an object can be scaled down to, across

  // Objects that keep their proportions whatever the handle: a circle stays round, a text and an image keep their shape.
  const uniform = layer => ['circle', 'text', 'svg'].includes(layer.mb.type);
  // Markers are pins of a fixed size: nothing to scale.
  MB.canScale = layer => !!layer && !!layer.mb && layer.mb.type !== 'marker';

  const cp = ll => MB.map.latLngToContainerPoint(ll);
  const ll = p => MB.map.containerPointToLatLng(p);
  const mapNested = (a, fn) => Array.isArray(a) ? a.map(x => mapNested(x, fn)) : fn(a);

  MB.scaler = {
    layer: null, box: null, drag: null,

    init() {
      const box = this.box = document.createElement('div');
      box.className = 'mb-scale-box';
      box.innerHTML = Object.keys(HANDLES).map(h => `<span class="mb-scale-h" data-h="${h}"></span>`).join('');
      MB.map.getContainer().appendChild(box);
      L.DomEvent.disableClickPropagation(box); // a handle is not a click on the map (which would deselect)
      L.DomEvent.disableScrollPropagation(box);
      box.querySelectorAll('.mb-scale-h').forEach(h => h.addEventListener('pointerdown', e => this.start(e, h.dataset.h)));
      MB.map.on('move zoomend viewreset resize', () => this.place());
      MB.map.on('zoomstart', () => { if (this.layer) box.style.display = 'none'; });
      MB.on('featurechange', l => { if (l === this.layer && !this.drag) this.place(); });
      MB.on('history', () => { if (this.layer && MB.featureLayers[this.layer.mb.id] !== this.layer) this.detach(); else this.place(); });
    },

    // Show the box around a selected object (the Scale tool's selection).
    attach(layer) {
      this.detach();
      if (!MB.canScale(layer)) { MB.toast('Markers have a fixed size: pick a line, shape, text or image to scale'); return; }
      this.layer = layer;
      this.box.classList.toggle('uniform', uniform(layer));
      this.place();
    },

    detach() {
      if (this.drag) this.cancel();
      this.layer = null;
      if (this.box) this.box.style.display = 'none';
    },

    // The object's box on screen (container pixels): its geometry's bounds, or what a point object shows.
    rect(layer) {
      if (layer.getBounds && !(layer instanceof L.Marker)) {
        const b = layer.getBounds();
        if (!b.isValid()) return null;
        const a = cp(b.getNorthWest()), c = cp(b.getSouthEast());
        return { x0: a.x, y0: a.y, x1: c.x, y1: c.y };
      }
      const el = layer.mb.type === 'text' ? layer.pm && layer.pm.textArea : layer.getElement && layer.getElement();
      const shown = el && (el.querySelector && el.querySelector('img')) || el;
      if (!shown) return null;
      const r = shown.getBoundingClientRect(), m = MB.map.getContainer().getBoundingClientRect();
      return { x0: r.left - m.left, y0: r.top - m.top, x1: r.right - m.left, y1: r.bottom - m.top };
    },

    place() {
      const box = this.box;
      if (!box) return;
      const r = this.layer && MB.map.hasLayer(this.layer) ? this.rect(this.layer) : null;
      if (!r) { box.style.display = 'none'; return; }
      Object.assign(box.style, { display: 'block', left: r.x0 + 'px', top: r.y0 + 'px', width: Math.max(0, r.x1 - r.x0) + 'px', height: Math.max(0, r.y1 - r.y0) + 'px' });
    },

    // A handle grabbed: what the object is now (on screen), so every step scales from there.
    start(e, h) {
      const layer = this.layer;
      if (!layer || e.button !== 0) return;
      if (MB.isFeatureLocked(layer)) { MB.toast('Object is locked'); return; }
      e.preventDefault(); e.stopPropagation();
      const r = this.rect(layer);
      if (!r) return;
      const t = layer.mb.type, snap = { r };
      if (t === 'circle') { snap.center = cp(layer.getLatLng()); snap.radius = layer.getRadius(); }
      else if (t === 'text') { snap.pos = cp(layer.getLatLng()); snap.size = MB.textShownSize(layer.mb.style); }
      else if (t === 'svg') { snap.pos = cp(MB.svgCenter(layer)); snap.width = +layer.mb.svg.width; }
      else snap.pts = mapNested(layer.getLatLngs(), cp);
      // where on the handle it was grabbed, from the box's side or corner it moves: a grab is not yet a resize
      const m = MB.map.getContainer().getBoundingClientRect(), [dx, dy] = HANDLES[h];
      snap.grab = { x: dx ? e.clientX - m.left - (dx > 0 ? r.x1 : r.x0) : 0, y: dy ? e.clientY - m.top - (dy > 0 ? r.y1 : r.y0) : 0 };
      this.drag = { h, snap, pointer: e.pointerId, last: e };
      try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* the pointer is gone already: the window listeners still follow it */ }
      MB.map.dragging.disable();
      this.box.classList.add('dragging');
      this._move = ev => { if (ev.pointerId === this.drag.pointer) { this.drag.last = ev; this.apply(ev); } };
      this._up = ev => { if (ev.pointerId === this.drag.pointer) this.end(); };
      // Shift and Alt change the scaling as soon as they are pressed, without moving; Esc puts the object back
      this._key = ev => {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.cancel(); return; }
        if (ev.key === 'Shift' || ev.key === 'Alt') {
          ev.preventDefault(); // Alt would open the window menu
          const l = this.drag.last;
          this.apply({ clientX: l.clientX, clientY: l.clientY, shiftKey: ev.type === 'keydown' ? ev.key === 'Shift' || ev.shiftKey : ev.key !== 'Shift' && ev.shiftKey,
            altKey: ev.type === 'keydown' ? ev.key === 'Alt' || ev.altKey : ev.key !== 'Alt' && ev.altKey });
        }
      };
      window.addEventListener('pointermove', this._move);
      window.addEventListener('pointerup', this._up);
      window.addEventListener('pointercancel', this._up);
      window.addEventListener('keydown', this._key, true);
      window.addEventListener('keyup', this._key, true);
    },

    // Scale for the pointer at e: the handle pulls its sides, the opposite ones stay (Alt: the center stays); Shift,
    // or an object that keeps its shape, scales both ways alike.
    apply(e) {
      const d = this.drag, { r } = d.snap, [dx, dy] = HANDLES[d.h];
      const m = MB.map.getContainer().getBoundingClientRect(), px = e.clientX - m.left - d.snap.grab.x, py = e.clientY - m.top - d.snap.grab.y;
      const alt = !!e.altKey, w0 = r.x1 - r.x0, h0 = r.y1 - r.y0, cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
      const ax = alt || !dx ? cx : dx > 0 ? r.x0 : r.x1, ay = alt || !dy ? cy : dy > 0 ? r.y0 : r.y1;
      // the new size across each pulled side, over the old (null: this handle does not pull that way, or the object has no size that way)
      const factor = (p, a, dir, size) => !dir || size < 1 ? null : Math.max(MIN, dir * (p - a) * (alt ? 2 : 1)) / size;
      let sx = factor(px, ax, dx, w0), sy = factor(py, ay, dy, h0);
      if (sx == null && sy == null) return;
      if (e.shiftKey || uniform(this.layer)) { const s = sx != null && sy != null ? Math.max(sx, sy) : (sx != null ? sx : sy); sx = sy = s; }
      else { if (sx == null) sx = 1; if (sy == null) sy = 1; }
      d.moved = true;
      this.scale(sx, sy, ax, ay);
    },

    // The object as it was when the handle was grabbed, scaled by sx, sy about the point (ax, ay) on screen.
    scale(sx, sy, ax, ay) {
      const to = p => L.point(ax + (p.x - ax) * sx, ay + (p.y - ay) * sy);
      const layer = this.layer, t = layer.mb.type, sn = this.drag.snap;
      if (t === 'circle') { layer.setLatLng(ll(to(sn.center))); layer.setRadius(Math.max(0.01, sn.radius * sx)); }
      else if (t === 'text') {
        // A text's box does not grow quite in step with its font (its padding stays, sizes are whole pixels): it is
        // moved so the point that stays put (a corner, a side, the center) keeps its place on the box.
        MB.applyStyle(layer, { textSize: Math.max(4, Math.min(400, Math.round(sn.size * sx))) }, { noCommit: true });
        const r0 = sn.r, r1 = this.rect(layer);
        if (r1) {
          const fx = (ax - r0.x0) / ((r0.x1 - r0.x0) || 1), fy = (ay - r0.y0) / ((r0.y1 - r0.y0) || 1);
          const p = cp(layer.getLatLng());
          layer.setLatLng(ll(L.point(p.x + (ax - fx * (r1.x1 - r1.x0)) - r1.x0, p.y + (ay - fy * (r1.y1 - r1.y0)) - r1.y0)));
        }
      } else if (t === 'svg') {
        layer.mb.svg.width = Math.max(layer.setBounds ? 0.1 : 4, +(sn.width * sx).toFixed(2)); // meters on the ground, or pixels
        if (layer.setBounds) {
          const lib = MB.state.svgLibrary[layer.mb.svg.svgId] || { aspect: 1 };
          layer.setBounds(MB.boundsAround(ll(to(sn.pos)), layer.mb.svg.width, layer.mb.svg.width / (lib.aspect || 1)));
        } else layer.setLatLng(ll(to(sn.pos)));
        MB.refreshSvg(layer);
      } else layer.setLatLngs(mapNested(sn.pts, p => ll(to(p))));
      MB.updateTooltip(layer);
      this.place();
    },

    end() {
      const changed = this.drag && this.drag.moved;
      this.stopDrag();
      if (!changed || !this.layer) return;
      MB.emit('featurechange', this.layer);
      MB.commit('scale');
    },

    // Esc while dragging: the object as it was.
    cancel() {
      if (!this.drag) return;
      if (this.layer && this.drag.moved) this.scale(1, 1, 0, 0);
      this.stopDrag();
      this.place();
    },

    stopDrag() {
      if (!this.drag) return;
      window.removeEventListener('pointermove', this._move);
      window.removeEventListener('pointerup', this._up);
      window.removeEventListener('pointercancel', this._up);
      window.removeEventListener('keydown', this._key, true);
      window.removeEventListener('keyup', this._key, true);
      MB.map.dragging.enable();
      this.box.classList.remove('dragging');
      this.drag = null;
    }
  };
})(window.MB);
