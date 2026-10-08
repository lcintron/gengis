/* GenGIS - the Scale tool: a box with eight handles around the selection (an object, or a layer's group); dragging
   one resizes it. A group is also moved as one here (the Move tool). */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  // Handles: where each sits on the box, as which way it pulls (-1 left/top, 1 right/bottom, 0 neither).
  const HANDLES = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };
  const MIN = 4; // px: the smallest a selection can be scaled down to, across

  // Objects that keep their proportions whatever the handle: a circle stays round, a text and an image keep their
  // shape (a selection with one of them scales alike both ways).
  const uniform = layer => ['circle', 'text', 'svg'].includes(layer.mb.type);
  // Markers are pins of a fixed size: nothing to scale (in a group they move with it).
  MB.canScale = layer => !!layer && !!layer.mb && layer.mb.type !== 'marker';

  // Screen pixels, unrounded (Leaflet's latLngToContainerPoint rounds to whole pixels: every scaling would move the
  // vertices onto the pixel grid, by up to half a pixel's worth of ground when zoomed out).
  const cp = ll => MB.map.project(ll).subtract(MB.map.getPixelOrigin()).subtract(MB.map.containerPointToLayerPoint([0, 0]));
  const ll = p => MB.map.containerPointToLatLng(p);
  const mapNested = (a, fn) => Array.isArray(a) ? a.map(x => mapNested(x, fn)) : fn(a);
  // The map's own pointer and keyboard handlers, off while a selection is dragged (a drag works in screen pixels at
  // the zoom it started at).
  const HANDLERS = ['dragging', 'scrollWheelZoom', 'doubleClickZoom', 'touchZoom', 'boxZoom', 'keyboard'];
  const handlersOff = () => { const off = HANDLERS.filter(k => MB.map[k] && MB.map[k].enabled()); off.forEach(k => MB.map[k].disable()); return off; };
  const handlersOn = off => (off || []).forEach(k => MB.map[k].enable());

  // An object's box on screen (container pixels): its geometry's bounds, or what a point object shows.
  function rectOf(layer) {
    if (layer instanceof L.Circle && layer._radius != null) {
      const c = cp(layer.getLatLng()), rx = layer._radius, ry = layer._radiusY || rx;
      return { x0: c.x - rx, y0: c.y - ry, x1: c.x + rx, y1: c.y + ry };
    }
    if (layer.getBounds && !(layer instanceof L.Marker)) {
      const b = layer.getBounds();
      if (!b.isValid()) return null;
      const a = cp(b.getNorthWest()), c = cp(b.getSouthEast());
      return { x0: a.x, y0: a.y, x1: c.x, y1: c.y };
    }
    if (!MB.map.hasLayer(layer)) return null; // a point object hidden: nothing drawn to measure
    const el = layer.mb.type === 'text' ? layer.pm && layer.pm.textArea : layer.getElement && layer.getElement();
    const shown = el && (el.querySelector && el.querySelector('img, svg')) || el;
    if (!shown) return null;
    const r = shown.getBoundingClientRect(), m = MB.map.getContainer().getBoundingClientRect();
    return { x0: r.left - m.left, y0: r.top - m.top, x1: r.right - m.left, y1: r.bottom - m.top };
  }
  // The box around several (the shown ones).
  function unionRect(layers) {
    let u = null;
    layers.forEach(l => {
      if (!MB.map.hasLayer(l)) return;
      const r = rectOf(l);
      if (!r) return;
      u = u ? { x0: Math.min(u.x0, r.x0), y0: Math.min(u.y0, r.y0), x1: Math.max(u.x1, r.x1), y1: Math.max(u.y1, r.y1) } : r;
    });
    return u;
  }

  // What an object is now (on screen, and as it is on the map, for Esc to put back exactly).
  function snapshot(layer) {
    const t = layer.mb.type, sn = { layer, r: rectOf(layer) };
    if (t === 'circle') { sn.center = cp(layer.getLatLng()); sn.radius = layer.getRadius(); }
    else if (t === 'text') { sn.pos = cp(layer.getLatLng()); sn.size = MB.textShownSize(layer.mb.style); }
    else if (t === 'svg') { sn.pos = cp(MB.svgCenter(layer)); sn.width = +layer.mb.svg.width; }
    else if (t === 'marker') sn.pos = cp(layer.getLatLng());
    else sn.pts = mapNested(layer.getLatLngs(), cp);
    sn.orig = { lls: layer.getLatLngs && !(layer instanceof L.Circle) ? mapNested(layer.getLatLngs(), p => L.latLng(p.lat, p.lng)) : null,
      ll: layer.getLatLng ? L.latLng(layer.getLatLng()) : null, radius: layer.getRadius ? layer.getRadius() : null,
      bounds: t === 'svg' && layer.setBounds ? L.latLngBounds(layer.getBounds().getSouthWest(), layer.getBounds().getNorthEast()) : null,
      style: MB.deepClone(layer.mb.style), svgWidth: t === 'svg' ? layer.mb.svg.width : null };
    return sn;
  }

  // The object as snapshotted, its points through `to` (screen pixels) and its sizes times s; (ax, ay): the point
  // that stays put, for a text (whose box does not grow quite in step with its font: its padding stays, sizes are
  // whole pixels, so it is moved to keep that point's place on its box).
  function transform(sn, to, s, ax, ay) {
    const layer = sn.layer, t = layer.mb.type;
    if (t === 'circle') { layer.setLatLng(ll(to(sn.center))); layer.setRadius(Math.max(0.01, sn.radius * s)); }
    else if (t === 'marker') layer.setLatLng(ll(to(sn.pos)));
    else if (t === 'text') {
      if (s === 1) layer.setLatLng(ll(to(sn.pos)));
      else {
        MB.applyStyle(layer, { textSize: Math.max(4, Math.min(400, Math.round(sn.size * s))) }, { noCommit: true });
        layer.setLatLng(ll(to(sn.pos)));
        const r0 = sn.r, r1 = r0 && rectOf(layer);
        if (r1) {
          const fx = (ax - r0.x0) / ((r0.x1 - r0.x0) || 1), fy = (ay - r0.y0) / ((r0.y1 - r0.y0) || 1);
          const want = to(L.point(r0.x0 + fx * (r0.x1 - r0.x0), r0.y0 + fy * (r0.y1 - r0.y0))); // where that point of the box goes
          const p = cp(layer.getLatLng());
          layer.setLatLng(ll(L.point(p.x + (want.x - fx * (r1.x1 - r1.x0)) - r1.x0, p.y + (want.y - fy * (r1.y1 - r1.y0)) - r1.y0)));
        }
      }
    } else if (t === 'svg') {
      if (s !== 1) layer.mb.svg.width = Math.max(layer.setBounds ? 0.1 : 4, +(sn.width * s).toFixed(2)); // meters on the ground, or pixels
      if (layer.setBounds) {
        const lib = MB.state.svgLibrary[layer.mb.svg.svgId] || { aspect: 1 };
        layer.setBounds(MB.boundsAround(ll(to(sn.pos)), layer.mb.svg.width, layer.mb.svg.width / (lib.aspect || 1)));
      } else layer.setLatLng(ll(to(sn.pos)));
      if (s !== 1) MB.refreshSvg(layer); // resized: its icon redrawn (a move only moves it)
    } else layer.setLatLngs(mapNested(sn.pts, p => ll(to(p))));
    MB.updateTooltip(layer);
  }

  function restore(sn) {
    const layer = sn.layer, o = sn.orig, t = layer.mb.type;
    if (t === 'circle') { layer.setLatLng(o.ll); layer.setRadius(o.radius); }
    else if (t === 'text') { Object.assign(layer.mb.style, o.style); MB.applyTextStyle(layer); layer.setLatLng(o.ll); }
    else if (t === 'svg') { layer.mb.svg.width = o.svgWidth; if (o.bounds) layer.setBounds(o.bounds); else layer.setLatLng(o.ll); MB.refreshSvg(layer); }
    else if (t === 'marker') layer.setLatLng(o.ll);
    else layer.setLatLngs(o.lls);
    MB.updateTooltip(layer);
  }

  MB.scaler = {
    targets: [], box: null, drag: null,

    init() {
      const box = this.box = document.createElement('div');
      box.className = 'mb-scale-box';
      box.innerHTML = Object.keys(HANDLES).map(h => `<span class="mb-scale-h" data-h="${h}"></span>`).join('');
      MB.map.getContainer().appendChild(box);
      L.DomEvent.disableClickPropagation(box); // a handle is not a click on the map (which would deselect)
      L.DomEvent.disableScrollPropagation(box);
      box.querySelectorAll('.mb-scale-h').forEach(h => h.addEventListener('pointerdown', e => this.start(e, h.dataset.h)));
      MB.map.on('move zoomend viewreset resize', () => this.place());
      MB.map.on('zoomstart', () => { if (this.drag) this.cancel(); if (this.targets.length) box.style.display = 'none'; }); // e.g. a zoom button
      MB.on('featurechange', l => { if (this.targets.includes(l) && !this.drag) this.place(); });
      MB.on('history', () => { if (this.targets.some(l => MB.featureLayers[l.mb.id] !== l)) this.detach(); else this.place(); });
      MB.groupDrag.init();
    },

    // Show the box around the selection: an object, or a group's objects. opts.frame: the box alone, no handles
    // (the Move tool shows what it moves the same way).
    attach(layers, opts) {
      this.detach();
      const frame = !!(opts && opts.frame);
      layers = [].concat(layers).filter(Boolean);
      if (!frame && layers.length === 1 && !MB.canScale(layers[0])) { MB.toast('Markers have a fixed size: pick a line, shape, text or image to scale'); return; }
      this.targets = layers;
      this.frame = frame;
      this.box.classList.toggle('frame', frame);
      this.place();
    },
    // The box follows an object being dragged (the Move tool's drag of one object).
    follow(layer) { if (!this.drag && this.targets.includes(layer)) this.place(); },

    detach() {
      if (this.drag) this.cancel();
      this.targets = []; this.frame = false;
      if (this.box) this.box.style.display = 'none';
    },

    place() {
      const box = this.box;
      if (!box) return;
      const r = this.targets.length ? unionRect(this.targets) : null;
      if (!r) { box.style.display = 'none'; return; }
      Object.assign(box.style, { display: 'block', left: r.x0 + 'px', top: r.y0 + 'px', width: Math.max(0, r.x1 - r.x0) + 'px', height: Math.max(0, r.y1 - r.y0) + 'px' });
    },

    // A handle grabbed: what the selection is now (on screen), so every step scales from there.
    start(e, h) {
      const targets = this.targets;
      if (!targets.length || e.button !== 0 || this.frame) return;
      if (targets.some(l => MB.isFeatureLocked(l))) { MB.toast(targets.length > 1 ? 'The layer is locked' : 'Object is locked'); return; }
      e.preventDefault(); e.stopPropagation();
      const r = unionRect(targets);
      if (!r) return;
      // where on the handle it was grabbed, from the box's side or corner it moves: a grab is not yet a resize
      const m = MB.map.getContainer().getBoundingClientRect(), [dx, dy] = HANDLES[h];
      const grab = { x: dx ? e.clientX - m.left - (dx > 0 ? r.x1 : r.x0) : 0, y: dy ? e.clientY - m.top - (dy > 0 ? r.y1 : r.y0) : 0 };
      this.drag = { h, r, grab, snaps: targets.map(snapshot), uniform: targets.some(uniform), pointer: e.pointerId, last: e };
      try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* the pointer is gone already: the window listeners still follow it */ }
      this.handlersOff = handlersOff();
      this.box.classList.add('dragging');
      this._move = ev => { if (ev.pointerId === this.drag.pointer) { this.drag.last = ev; this.apply(ev); } };
      this._up = ev => { if (ev.pointerId === this.drag.pointer) this.end(); };
      // Shift and Alt change the scaling as soon as they are pressed, without moving; Esc puts the selection back
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
    // or a selection with an object that keeps its shape, scales both ways alike.
    apply(e) {
      const d = this.drag, r = d.r, [dx, dy] = HANDLES[d.h];
      const m = MB.map.getContainer().getBoundingClientRect(), px = e.clientX - m.left - d.grab.x, py = e.clientY - m.top - d.grab.y;
      const alt = !!e.altKey, w0 = r.x1 - r.x0, h0 = r.y1 - r.y0, cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
      const ax = alt || !dx ? cx : dx > 0 ? r.x0 : r.x1, ay = alt || !dy ? cy : dy > 0 ? r.y0 : r.y1;
      // the new size across each pulled side, over the old (null: this handle does not pull that way, or the selection has no size that way)
      const factor = (p, a, dir, size) => !dir || size < 1 ? null : Math.max(MIN, dir * (p - a) * (alt ? 2 : 1)) / size;
      let sx = factor(px, ax, dx, w0), sy = factor(py, ay, dy, h0);
      if (sx == null && sy == null) return;
      if (e.shiftKey || d.uniform) { const s = sx != null && sy != null ? Math.max(sx, sy) : (sx != null ? sx : sy); sx = sy = s; }
      else { if (sx == null) sx = 1; if (sy == null) sy = 1; }
      d.moved = true;
      this.scale(sx, sy, ax, ay);
    },

    // The selection as it was when the handle was grabbed, scaled by sx, sy about the point (ax, ay) on screen.
    scale(sx, sy, ax, ay) {
      const to = p => L.point(ax + (p.x - ax) * sx, ay + (p.y - ay) * sy);
      this.drag.snaps.forEach(sn => transform(sn, to, sx, ax, ay));
      this.place();
    },

    end() {
      const d = this.drag;
      this.stopDrag();
      if (!d || !d.moved || !this.targets.length) return;
      this.targets.forEach(l => MB.emit('featurechange', l));
      MB.commit(this.targets.length > 1 ? 'scale group' : 'scale');
    },

    // Esc while dragging: the selection as it was.
    cancel() {
      if (!this.drag) return;
      if (this.drag.moved) this.drag.snaps.forEach(restore);
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
      handlersOn(this.handlersOff);
      this.handlersOff = null;
      this.box.classList.remove('dragging');
      this.drag = null;
    }
  };

  /* ---------- a group moved as one (the Move tool) ----------
   * With a layer's group selected, pressing on any of its objects and dragging moves all of them together (Geoman
   * moves one object at a time). Esc while dragging puts them back. */
  MB.groupDrag = {
    drag: null,
    init() {
      // capture: before Leaflet starts panning the map from the same press
      MB.map.getContainer().addEventListener('pointerdown', e => this.down(e), true);
      // an undo or redo during the drag rebuilt its objects: the drag ends there (nothing to put back or save)
      MB.on('history', () => { if (this.drag && this.drag.snaps.some(sn => MB.featureLayers[sn.layer.mb.id] !== sn.layer)) this.done('drop'); });
    },
    down(e) {
      if (e.button !== 0 || MB.tools.current !== 'move' || this.drag) return;
      const gid = MB.selectedGroup && MB.selectedGroup();
      if (!gid) return;
      const m = MB.map.getContainer().getBoundingClientRect(), p = L.point(e.clientX - m.left, e.clientY - m.top);
      if (!MB.data.objectsAt(MB.map.containerPointToLatLng(p), p).some(f => MB.multi.has(f))) return; // not on the group: the map pans
      const members = Array.from(MB.multi);
      if (members.some(l => MB.isFeatureLocked(l))) { MB.toast('The layer is locked'); return; }
      e.preventDefault(); e.stopPropagation();
      this.drag = { start: p, snaps: members.map(snapshot), pointer: e.pointerId, moved: false };
      this.off = handlersOff();
      const move = ev => {
        if (ev.pointerId !== this.drag.pointer) return;
        const q = L.point(ev.clientX - m.left, ev.clientY - m.top), d = q.subtract(this.drag.start);
        if (!this.drag.moved && Math.abs(d.x) + Math.abs(d.y) < 3) return; // a click, not a drag
        this.drag.moved = true;
        this.drag.snaps.forEach(sn => transform(sn, pt => pt.add(d), 1));
        MB.scaler.place();
      };
      // how = 'cancel' (Esc: put back), 'drop' (the objects were rebuilt: leave them), or nothing (save the move)
      const done = this.done = how => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        window.removeEventListener('keydown', key, true);
        handlersOn(this.off);
        const dr = this.drag;
        this.drag = null; this.done = null;
        if (!dr.moved || how === 'drop') return;
        if (how === 'cancel') { dr.snaps.forEach(restore); return; }
        dr.snaps.forEach(sn => MB.emit('featurechange', sn.layer));
        MB.commit('move group');
      };
      const up = ev => { if (ev.pointerId === this.drag.pointer) done(); };
      const key = ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); done('cancel'); } };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      window.addEventListener('keydown', key, true);
    }
  };
})(window.MB);
