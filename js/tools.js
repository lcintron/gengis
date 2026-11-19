/* GenGIS - tools: drawing (Geoman), measuring, SVG placement */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  /* ---------- tool switching ---------- */

  MB.tools = {
    current: 'select',
    shapes: { marker: 'Marker', text: 'Text', line: 'Line', polygon: 'Polygon', rectangle: 'Rectangle', circle: 'Circle' },

    // The tools that pick objects on the map (rather than add them): Select edits, Move drags, Scale resizes.
    picks(name) { return name === 'select' || name === 'move' || name === 'scale'; },

    set(name) {
      if (name === this.current && name !== 'select') name = 'select';
      MB.map.pm.disableDraw();
      MB.measure.stop();
      MB.svgPlace.stop();
      MB.iconPlace.stop();
      if (MB.shapes) MB.shapes.stop();
      MB.ink.stop();
      MB.drawDrag.stop();
      if (this.current === 'circle' && name !== 'circle') MB.circleRadius.reset(); // a typed radius is for the circle being drawn
      const keep = MB.tools.picks(name) ? MB.selected : null;
      const keepGroup = MB.tools.picks(name) && MB.selectedGroup ? MB.selectedGroup() : null;
      if (keep) MB.deselect();
      this.current = name;
      MB.circleRadius.forTool(name); // the radius label is on the map while the circle tool is
      MB.map.getContainer().classList.toggle('mb-crosshair', !MB.tools.picks(name));
      MB.map.getContainer().classList.toggle('mb-move', name === 'move');
      MB.map.getContainer().classList.toggle('mb-scale-tool', name === 'scale');
      if (keep) MB.selectFeature(keep); // re-select so edit vs. drag-only mode matches the tool
      if (keepGroup) MB.selectGroup(keepGroup); // and a group's box under the Scale tool
      if (this.shapes[name]) { MB.deselect(); this.startDraw(name); }
      else if (name === 'measure-distance') { MB.deselect(); MB.measure.start('distance'); }
      else if (name === 'measure-area') { MB.deselect(); MB.measure.start('area'); }
      else if (name === 'svg') { MB.deselect(); MB.svgPlace.start(); }
      else if (name === 'icon') { MB.deselect(); MB.iconPlace.start(); } // an icon as a marker (js/icons.js)
      else if (name === 'shape') { MB.deselect(); MB.shapes.start(); } // a preset shape (js/shapes.js)
      else if (name === 'annotate') { MB.deselect(); MB.ink.start(); }
      MB.emit('tool', name);
    },

    drawOptions() {
      const st = MB.newShapeStyle(), ls = MB.toLeafletStyle(st); // the preview shows the color the object will get
      return {
        snappable: MB.state.snapping, snapDistance: 15,
        continueDrawing: MB.state.continueDrawing,
        allowSelfIntersection: true,
        pathOptions: ls,
        templineStyle: { color: st.color, weight: ls.weight, dashArray: ls.dashArray, lineCap: ls.lineCap },
        hintlineStyle: { color: st.color, weight: 1.5, dashArray: '5,5' },
        markerStyle: { icon: MB.pinIcon(st.color) },
        textOptions: { focusAfterCreate: true, removeIfEmpty: true },
        tooltips: false, // no "Click to place…" under the pointer: the tool's hint above the map says it
        cursorMarker: true,
        finishOn: 'dblclick'
      };
    },

    startDraw(name) {
      // A text box on a hidden layer is never on the map, so it cannot be typed in (Geoman fails making it): the
      // text tool waits instead, and a click on the map says why (see the click handler below).
      this.textWaits = name === 'text' && !MB.activeLayer().visible;
      if (this.textWaits) { MB.map.pm.disableDraw(); return; }
      const group = MB.groups[MB.activeLayer().id];
      MB.map.pm.setGlobalOptions({ layerGroup: group });
      const opts = this.drawOptions();
      if (name === 'line') opts.pathOptions = Object.assign({}, opts.pathOptions, { fill: false });
      if (name === 'circle') { // a typed radius pins the one being drawn (0: any radius)
        const r = MB.circleRadius.locked || 0;
        opts.minRadiusCircle = r; opts.maxRadiusCircle = r;
      }
      MB.map.pm.enableDraw(this.shapes[name], opts);
      if (name === 'circle') MB.circleRadius.update(); // nothing drawn yet: the radius label docks
      if (name === 'rectangle' || name === 'circle') MB.drawDrag.start(); // a finger may drag one out
    },

    // Called when the default style or active layer changes while a draw tool is active.
    refreshDraw() {
      MB.circleRadius.color = null; // the next object's color: the radius ghost takes it afresh
      // the text tool waiting for its layer to be shown, or its layer just hidden
      if (this.current === 'text' && this.textWaits !== !MB.activeLayer().visible) { this.startDraw('text'); return; }
      if (this.shapes[this.current]) {
        const group = MB.groups[MB.activeLayer().id];
        MB.map.pm.setGlobalOptions({ layerGroup: group });
        const st = MB.newShapeStyle(), ls = MB.toLeafletStyle(st);
        MB.map.pm.setPathOptions(ls);
        try {
          MB.map.pm.Draw[this.shapes[this.current]].setOptions({
            pathOptions: ls,
            templineStyle: { color: st.color, weight: ls.weight, dashArray: ls.dashArray, lineCap: ls.lineCap },
            hintlineStyle: { color: st.color, weight: 1.5, dashArray: '5,5' },
            markerStyle: { icon: MB.pinIcon(st.color) }
          });
        } catch (e) { /* ignore */ }
      }
    },

    init() {
      MB.drawDrag.init(); // first: its pm:create listener must see a shape made mid-gesture before this one acts on it
      MB.circleRadius.init();
      // Deleting an object can free a palette color: the previews show what the next object will really get.
      MB.on('features', () => { this.refreshDraw(); if (MB.measure.active) MB.measure.restyleTemp(); });
      MB.map.on('pm:create', e => {
        const type = Object.keys(this.shapes).find(k => this.shapes[k] === e.shape) || 'polygon';
        const layer = e.layer;
        if (layer.mb) return;
        if (type === 'line') {
          // A line that ends where it started is a closed outline: store it as a polygon so it has an area.
          const lls = layer.getLatLngs();
          // finished by clicking the first vertex: on the marker itself, or with the pointer pulled onto it (the magnet)
          const line = MB.map.pm.Draw.Line, hintLL = line && line._hintMarker && line._hintMarker.getLatLng();
          const atFirst = !!hintLL && MB.isLatLng(lls[0]) && MB.pxDist(lls[0], hintLL) <= 1.5;
          const byClick = (this._closeLine || atFirst) && lls.length >= 3 && MB.isLatLng(lls[0]);
          const byProximity = lls.length >= 4 && MB.isLatLng(lls[0]) && MB.pxDist(lls[0], lls[lls.length - 1]) <= MB.SNAP_PX;
          this._closeLine = false;
          if (byClick || byProximity) {
            const pts = (byProximity ? lls.slice(0, -1) : lls).map(p => [p.lat, p.lng]);
            const g = MB.groups[MB.activeLayer().id];
            if (g.hasLayer(layer)) g.removeLayer(layer);
            if (MB.map.hasLayer(layer)) MB.map.removeLayer(layer);
            const poly = MB.restoreFeature({ type: 'polygon', latlngs: [pts], layerId: MB.activeLayer().id, style: MB.newShapeStyle(true) });
            MB.commit('draw closed line as polygon');
            this.refreshDraw(); // the next object gets the next color
            MB.toast('Closed outline: saved as a polygon (' + MB.formatArea(MB.polygonArea(poly.getLatLngs())) + ')', 3500);
            MB.noteAdded(poly);
            if (!MB.state.continueDrawing) { this.set('select'); MB.selectFeature(poly); }
            return;
          }
        }
        // A rectangle drawn from three points is turned: Geoman built it from the diagonal, so it gets its real
        // corners here (and the angle, so dragging one keeps it rectangular).
        if (type === 'rectangle' && MB.rectDraw.pending) {
          const ring = MB.rectDraw.pending;
          layer.setLatLngs(ring);
          if (layer.pm) layer.pm._setAngle(MB.ringAngle(ring));
        }
        // A circle drawn to a typed radius must still be resizable afterwards (Geoman passes the draw's pinned
        // radius on to the new circle).
        if (type === 'circle' && layer.pm && layer.pm.setOptions) layer.pm.setOptions({ minRadiusCircle: 0, maxRadiusCircle: 0 });
        MB.addFeature(layer, { type, layerId: MB.activeLayer().id, style: MB.newShapeStyle(true) });
        if (type === 'text' && layer.pm) layer.mb.text = layer.pm.getText();
        MB.commit('draw ' + type);
        MB.noteAdded(layer);
        this.refreshDraw(); // the next object gets the next color
        if (!MB.state.continueDrawing) {
          this.set('select');
          if (type !== 'text') MB.selectFeature(layer);
        }
      });
      MB.map.on('click', e => {
        if (this.current === 'text' && this.textWaits) { MB.noteHiddenText(); return; }
        if (e.originalEvent && e.originalEvent.shiftKey) return; // keep a multi-selection while shift is held
        if (this.current === 'select') { MB.deselect(); MB.data.pick(null); }
        else if (this.current === 'scale') MB.deselect();
        // With magnetic declination on, a click anywhere tells the declination there (and any data at the point):
        // after a moment, so the two clicks of a double-click zoom open nothing.
        clearTimeout(this._pointTimer);
        const handled = e.originalEvent && e.originalEvent._mbIdentified; // an object's click opened the popup (presenting)
        if (!handled && (this.current === 'select' || this.current === 'present') && MB.declination && MB.declination.on) {
          this._pointTimer = setTimeout(() => MB.data.identify(e.latlng, e.containerPoint, null), 280);
        }
      });
      MB.map.on('dblclick zoomstart popupopen', () => clearTimeout(this._pointTimer)); // also when an object's or a vessel's popup opens first
      MB.on('layers', () => this.refreshDraw()); // the active layer, or whether it is shown, changed
      // Geoman's text tool re-arms itself when a text box loses focus while drawing continues: not while it waits
      // for a hidden layer (and, armed anyway, it makes nothing: its text box would never reach the map)
      const TextDraw = L.PM && L.PM.Draw && L.PM.Draw.Text && L.PM.Draw.Text.prototype;
      if (TextDraw && TextDraw.enable && TextDraw._createMarker) {
        const enable = TextDraw.enable, create = TextDraw._createMarker;
        TextDraw.enable = function (...a) { if (MB.tools.textWaits) return; return enable.apply(this, a); };
        TextDraw._createMarker = function (e) { if (MB.tools.textWaits) return; return create.call(this, e); };
      }
      this.initCircleTip();
    },

    // The radius of a circle being drawn, beside the pointer (like the measuring tool's readout). Geoman's cursor
    // marker follows the pointer (snapped); once the center is placed, the radius is the distance between the two.
    initCircleTip() {
      const tip = document.createElement('div');
      tip.className = 'mb-measure-tip';
      MB.map.getContainer().appendChild(tip);
      const hide = () => { tip.style.display = 'none'; };
      MB.map.on('pm:drawstart', e => {
        hide();
        const draw = MB.map.pm.Draw.Circle, hint = draw && draw._hintMarker;
        if (e.shape !== 'Circle' || !hint) return;
        hint.on('move', () => {
          const center = draw._centerMarker;
          if (!center || !draw._layerGroup || !draw._layerGroup.hasLayer(center)) { // the center is not placed yet (with a typed radius: the circle to come)
            MB.circleRadius.showGhost(hint.getLatLng());
            MB.circleRadius.update();
            return;
          }
          MB.circleRadius.showGhost(null);
          const r = center.getLatLng().distanceTo(hint.getLatLng()), p = MB.map.latLngToContainerPoint(hint.getLatLng());
          // the radius on the map: the pinned one, or the one being dragged out (read out in the label too)
          MB.circleRadius.place(center.getLatLng(), MB.circleRadius.locked || r);
          MB.circleRadius.showLive(r);
          tip.innerHTML = `<b>Radius ${MB.formatDistance(r)}</b><br><span class="dim">${MB.formatDistanceAlt(r)}</span>`; // the measure only (how to finish: the hint)
          tip.style.display = 'block';
          // beside the pointer, on the side where it fits
          const size = MB.map.getSize(), w = tip.offsetWidth, h = tip.offsetHeight;
          tip.style.left = (p.x + 16 + w > size.x ? p.x - 16 - w : p.x + 16) + 'px';
          tip.style.top = (p.y + 16 + h > size.y ? p.y - 16 - h : p.y + 16) + 'px';
        });
      });
      MB.map.on('pm:drawend', () => { hide(); MB.circleRadius.endDraw(); }); // (the circle is made, or the tool is going: the label docks again)
    }
  };

  /* ---------- a typed radius for the circle ---------- */
  // The circle's radius, on the map: a dimension line from the center to the edge, with the value in a label that
  // can be typed in. Type a radius and the circle takes it (one click on the map places a circle of exactly that
  // size); drag one out instead and the label reads the radius out as it grows. Geoman does the pinning: its
  // smallest and largest radius, set to the same value, hold the circle being drawn to it.
  // The label is one node, made once and never re-parented (that would drop the caret and a phone's keyboard): it
  // sits in the map's container and is moved with left / top. It is docked under the tool hint until a center is
  // placed, so it never moves with the pointer and can always be typed in.

  MB.circleRadius = {
    locked: null, // meters, or null for "as dragged"
    live: false,  // the value in the box is a readout of the circle being dragged, not typed
    attached: false, // on the circle's dimension line, rather than docked under the tool hint
    dockDirty: true, // the docked place is to be measured again (the hint's height or the map's width changed)
    el: null, line: null, ghost: null, color: null, // (the ghost's color, worked out once: it is drawn on every move)

    init() {
      this.mount();
      MB.on('units', () => this.useDefaultUnit()); // (the ghost's color is cleared in MB.tools.refreshDraw)
      MB.map.on('move zoomend viewreset', () => this.update());
      MB.map.on('resize', () => this.redock()); // the docked place is measured from the map's width
      MB.map.on('zoomstart', () => this.hide()); // mid-zoom the center is nowhere in particular
      // the center placed with a radius typed: that is the whole circle, no second click
      const Circle = L.PM && L.PM.Draw && L.PM.Draw.Circle && L.PM.Draw.Circle.prototype;
      if (Circle && Circle._placeCenterMarker && !Circle._mbRadiusBox) {
        const place = Circle._placeCenterMarker;
        Circle._mbRadiusBox = true;
        Circle._placeCenterMarker = function (e) {
          const r = place.call(this, e);
          if (MB.circleRadius.locked) this._finishShape();
          return r;
        };
      }
    },

    box() { return this.el && this.el.querySelector('#radiusInput'); },
    unitSel() { return this.el && this.el.querySelector('#radiusUnit'); },

    // The label and its dimension line, built once into the map's container (hidden until the circle tool is on).
    mount() {
      if (this.el) return this.el;
      const line = this.line = document.createElement('div');
      line.className = 'mb-dim-line';
      MB.map.getContainer().appendChild(line);
      const el = this.el = document.createElement('div');
      el.className = 'mb-dim radius-row';
      el.innerHTML = '<label for="radiusInput">R</label>' +
        '<input id="radiusInput" type="text" inputmode="decimal" enterkeyhint="done" autocomplete="off" spellcheck="false" aria-label="Radius" placeholder="type a value">' +
        `<select id="radiusUnit" aria-label="Radius unit">${Object.keys(MB.distanceUnits).map(u => `<option value="${u}">${u}</option>`).join('')}</select>` +
        '<button type="button" class="radius-clear" aria-label="Clear radius" title="Clear radius">✕</button>';
      MB.map.getContainer().appendChild(el);
      L.DomEvent.disableClickPropagation(el); // typing in the label is not a click on the map (which would place a circle)
      L.DomEvent.disableScrollPropagation(el);
      L.DomEvent.on(el, 'mousemove', L.DomEvent.stopPropagation); // the pointer over the label does not drag the radius out from under it
      const box = this.box(), sel = this.unitSel();
      sel.value = MB.inputUnit('radius').label;
      box.addEventListener('input', () => { this.live = false; this.read(); }); // typed over: no longer a readout
      box.addEventListener('focus', () => { if (this.live) box.select(); }); // the first digit typed replaces the readout
      sel.addEventListener('change', () => { if (this.live) this.clearBox(); this.dockDirty = true; this.read(); box.focus(); }); // a readout is in the old unit
      const keys = e => {
        e.stopPropagation(); // the app's single-key shortcuts stay out of a typed value
        const t = e.currentTarget; // the value box or the unit beside it
        if (e.key === 'Enter') { e.preventDefault(); if (!this.finish()) t.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); if (t === box) this.reset(); t.blur(); } // the typed value is the box's own to clear
      };
      box.addEventListener('keydown', keys);
      sel.addEventListener('keydown', keys);
      el.querySelector('.radius-clear').addEventListener('click', () => { this.reset(); box.focus(); });
      return el;
    },

    // Enter: the center is waiting and there is a radius, so this is the second click. Whether it made the circle.
    finish() {
      const draw = MB.map.pm.Draw.Circle, center = draw && draw._centerMarker;
      const placed = center && draw._layerGroup && draw._layerGroup.hasLayer(center);
      if (!placed) return false;
      const r = this.locked || (draw._hintMarker ? center.getLatLng().distanceTo(draw._hintMarker.getLatLng()) : 0);
      if (!(r > 0)) return false; // nothing of a circle yet: Enter only puts the keyboard away
      draw._finishShape();
      return true;
    },

    // The unit chosen in Settings, and a radius already typed rewritten in it.
    useDefaultUnit() {
      const sel = this.unitSel();
      if (!sel) return;
      const was = this.locked;
      if (this.live) this.clearBox();
      sel.value = MB.inputUnit('radius').label;
      if (was) {
        // the same length in the new unit, with digits enough that it stays that length (1 m is 0.000539957 NM, and
        // rounded short it would be 0: no radius at all)
        let v = String(+(was / MB.distanceUnits[sel.value]).toPrecision(6)); // (plain digits: the box is read back)
        if (!MB.parseDistance(v, sel.value)) { sel.value = 'm'; v = String(+was.toPrecision(6)); } // not writable there (a hair's breadth in miles): meters say it
        this.box().value = v;
        this.read();
      }
    },

    // What is in the box now: a radius to keep to, nothing, or a value that makes no sense.
    read() {
      const box = this.box(), sel = this.unitSel();
      if (!box) return;
      const text = box.value.trim();
      if (!text) { box.removeAttribute('aria-invalid'); this.unlock(); return; }
      const r = MB.parseDistance(text, sel.value);
      if (!r) { box.setAttribute('aria-invalid', 'true'); this.unlock(); return; }
      box.removeAttribute('aria-invalid');
      if (r.unit !== sel.value) sel.value = r.unit; // a unit typed after the number wins
      this.lock(r.meters);
    },

    lock(meters) { this.set(meters); },
    unlock() { this.set(null); },
    clearBox() {
      const box = this.box();
      if (box) { box.value = ''; box.removeAttribute('aria-invalid'); }
      this.live = false;
    },
    reset() {
      this.clearBox();
      this.unlock();
    },

    set(meters) {
      const was = this.locked;
      this.locked = meters;
      const draw = MB.map && MB.map.pm && MB.map.pm.Draw && MB.map.pm.Draw.Circle;
      if (draw) {
        draw.options.minRadiusCircle = meters || 0;
        draw.options.maxRadiusCircle = meters || 0;
        if (draw.enabled() && draw._hintMarker) draw._hintMarker.fire('move'); // the preview and the readout follow at once
      }
      if (!meters) this.showGhost(null);
      if (was !== meters && MB.ui && MB.ui.renderToolHint) MB.ui.renderToolHint(); // the instructions say the radius
      else this.update();
    },

    /* ----- the label on the map ----- */

    // The circle tool is on (the label goes on the map, docked) or off (it goes away).
    forTool(name) {
      if (!this.el) return;
      this.attached = false; // the tool is coming or going: the label starts docked either way
      if (name === 'circle') { this.el.style.display = 'inline-flex'; this.redock(); return; }
      const box = this.box();
      if (box && document.activeElement === box) box.blur();
      this.el.style.display = 'none';
      this.line.style.display = 'none';
    },

    // The draw is over (the circle is made, or the tool is going): a radius only read out is not one that was typed,
    // so it goes rather than sit in the docked box looking typed. The label docks, ready for the next circle.
    endDraw() {
      this.showGhost(null);
      if (this.live) this.clearBox();
      this.dock(); // (and the next circle's label attaches afresh, once there is room on its line)
    },

    // The docked place may have moved (the tool hint's height, the map's width, the label's own width).
    redock() { this.dockDirty = true; this.update(); },

    // Out of the way (a zoom): docked instead while it is being typed in, so the keyboard and the caret stay.
    hide() {
      if (!this.el || MB.tools.current !== 'circle') return;
      if (document.activeElement === this.box()) { this.dock(); return; }
      this.el.style.display = 'none';
      this.line.style.display = 'none';
    },

    // Attached to the circle being drawn, docked under the tool hint until its center is placed (while the radius is
    // typed, the dashed ghost is what follows the pointer: the label stays where it can be typed in).
    update() {
      if (!this.el || MB.tools.current !== 'circle') return;
      const draw = MB.map.pm.Draw && MB.map.pm.Draw.Circle, hint = draw && draw._hintMarker;
      const center = draw && draw._centerMarker;
      if (center && draw._layerGroup && draw._layerGroup.hasLayer(center)) {
        this.place(center.getLatLng(), this.locked || (hint ? center.getLatLng().distanceTo(hint.getLatLng()) : 0));
      } else this.dock();
    },

    // Under the tool's instructions, at the top of the map: nothing to measure yet. Another tool's draw can end here
    // (pm:drawend is the map's), and then the label belongs nowhere: it stays off the map.
    dock() {
      const el = this.el;
      if (!el) return;
      if (MB.tools.current !== 'circle') { el.style.display = 'none'; this.line.style.display = 'none'; this.attached = false; return; }
      el.style.display = 'inline-flex';
      el.classList.add('docked');
      this.line.style.display = 'none';
      const was = this.attached;
      this.attached = false;
      if (!was && !this.dockDirty) return; // already docked where it belongs: nothing to measure again (this runs on every move)
      this.dockDirty = false;
      const r = MB.map.getContainer().getBoundingClientRect(), hint = document.getElementById('toolHint');
      const hr = hint && !hint.classList.contains('hidden') ? hint.getBoundingClientRect() : null;
      el.style.left = Math.round(Math.max(8, (r.width - el.offsetWidth) / 2)) + 'px';
      el.style.top = Math.round(hr && hr.height ? hr.bottom - r.top + 8 : 12) + 'px';
    },

    // On the map: a dimension line from the center out to the edge, the value beside it.
    place(anchor, meters) {
      const el = this.el;
      if (!el || !(meters > 0)) { this.dock(); return; }
      el.style.display = 'inline-flex'; // shown before it is measured (a zoom may have hidden it)
      const size = MB.map.getSize(), p = MB.map.latLngToContainerPoint(anchor);
      const o = this.layout({ cx: p.x, cy: p.y, rPx: this.radiusPx(anchor, meters), w: el.offsetWidth, h: el.offsetHeight, mapW: size.x, mapH: size.y, attached: this.attached });
      if (o.dock) { this.dock(); return; } // no room on the line for the label yet: it stays docked, still and reachable
      el.classList.remove('docked');
      this.attached = true;
      el.style.left = o.x + 'px';
      el.style.top = o.y + 'px';
      const line = this.line;
      line.style.display = o.lineLen >= 10 ? 'block' : 'none'; // too short for an arrow at each end: the label alone says it
      line.style.left = Math.round(p.x) + 'px';
      line.style.top = Math.round(p.y) + 'px';
      line.style.width = o.lineLen + 'px';
    },

    // Where the label goes, in container pixels: on the line, 14 px clear of the center, which depends on the
    // center alone and so never follows the pointer. Until there is room on the line for it, it stays docked (where
    // it is still and can be typed in); once attached it stays attached until the draw ends, however short the line
    // becomes - a pointer coming in towards the label must not flip it between the line and the dock.
    layout(o) {
      const GAP = 14, EDGE = 8;
      const lineLen = Math.max(0, Math.round(o.rPx));
      if (!o.attached && o.rPx < o.w + 24) return { dock: true, lineLen };
      const x = Math.max(EDGE, Math.min(o.cx + GAP, o.mapW - o.w - EDGE));
      const y = Math.max(EDGE, Math.min(o.cy - o.h / 2, o.mapH - o.h - EDGE));
      return { x: Math.round(x), y: Math.round(y), lineLen, dock: false };
    },

    // The radius in container pixels: the circle's east edge, worked out as Leaflet draws one.
    radiusPx(anchor, meters) {
      const dLng = Math.min(179, (meters / 40075017) * 360 / Math.max(0.01, Math.cos(anchor.lat * Math.PI / 180))); // (a radius of thousands of km does not wrap the world)
      const a = MB.map.latLngToContainerPoint(anchor), b = MB.map.latLngToContainerPoint(L.latLng(anchor.lat, anchor.lng + dLng));
      return Math.abs(b.x - a.x);
    },

    // While a circle is dragged out, the label reads the radius out: plain digits in the unit beside it, so the
    // first key typed replaces it with a value of the user's own.
    showLive(meters) {
      const box = this.box(), sel = this.unitSel();
      if (!box || this.locked || (box.value && !this.live)) return; // a value typed by hand stands
      const txt = String(+(meters / MB.distanceUnits[sel.value]).toPrecision(4)); // (plain digits: the box is read back)
      const text = MB.parseDistance(txt, sel.value) ? txt : ''; // nothing of a radius yet (or too small to be one)
      if (box.value === text) return;
      box.value = text;
      box.removeAttribute('aria-invalid');
      this.live = !!text;
      if (document.activeElement === box) box.select();
    },

    // Where the circle would land, while the center is still to be clicked.
    showGhost(latlng) {
      if (!latlng || !this.locked || MB.tools.current !== 'circle') {
        if (this.ghost) { MB.map.removeLayer(this.ghost); this.ghost = null; }
        return;
      }
      const color = this.color || (this.color = MB.newShapeStyle().color);
      if (!this.ghost) {
        this.ghost = L.circle(latlng, { radius: this.locked, color, weight: 1.5, dashArray: '5,5', fill: false, interactive: false, pmIgnore: true }).addTo(MB.map);
      } else {
        if (this.ghost.options.color !== color) this.ghost.setStyle({ color });
        this.ghost.setLatLng(latlng);
        this.ghost.setRadius(this.locked);
      }
    }
  };

  /* ---------- drag to draw (a finger or a stylus) ---------- */
  // The rectangle and circle tools take two clicks, which is awkward with a finger: press where the shape starts,
  // drag, lift where it ends. Geoman draws it as ever - the gesture gives it the click and the moves it would have
  // had from a mouse. A tap is left alone, so tap-then-tap still works, and the mouse is unchanged (its drag pans).

  MB.drawDrag = {
    active: false, g: null, swallow: 0, ended: null, // ended: the pointer of a gesture that finished mid-drag
    MIN: 6, // px: less is a tap

    init() {
      const wrap = document.getElementById('mapwrap');
      // the capture phase on the map's parent: the gesture's events never reach Leaflet, so the map does not pan
      wrap.addEventListener('pointerdown', e => this.down(e), true);
      wrap.addEventListener('pointermove', e => this.move(e), true);
      ['pointerup', 'pointercancel'].forEach(t => wrap.addEventListener(t, e => this.up(e, t === 'pointercancel'), true));
      wrap.addEventListener('click', e => { if (Date.now() < this.swallow && MB.ink.onMap(e)) { e.stopPropagation(); e.preventDefault(); } }, true); // the gesture's own click would add a point
      MB.map.on('zoomstart', () => this.cancel()); // a pinch mid-gesture: the first point no longer lies where it did
      MB.map.on('pm:create', () => { if (this.g) this.g.created = true; });
    },

    start() {
      this.active = true;
      MB.map.getContainer().classList.add('mb-shape-draw'); // a finger's drag draws: not a scroll for the browser (app.css)
    },
    stop() {
      this.active = false; // (before the abort: the tool is going, nothing is started again)
      this.cancel();
      MB.map.getContainer().classList.remove('mb-shape-draw');
    },

    // While a shape is dragged out the map stays put: its drag and pinch are off (Leaflet starts a pan from the
    // touch event that follows the pointer one, which never reaches it), back as they were after.
    hold(on) {
      const m = MB.map;
      if (on) { this.held = ['dragging', 'touchZoom'].filter(h => m[h] && m[h].enabled()); this.held.forEach(h => m[h].disable()); }
      else if (this.held) { this.held.forEach(h => m[h].enable()); this.held = null; }
    },

    // A gesture given up on (a second finger, a pinch, the tool put away): what it began is dropped.
    cancel() {
      const g = this.g;
      this.hold(false);
      if (!g) return;
      this.g = null;
      if (g.placed) { this.swallow = Date.now() + 400; this.ended = g.id; } // its lift's click is still not the map's
      if (g.placed && !g.created) this.restartDraw();
    },
    restartDraw() {
      const t = MB.tools.current;
      if (!this.active || (t !== 'rectangle' && t !== 'circle')) return;
      MB.map.pm.disableDraw();
      MB.tools.startDraw(t);
    },

    // Whether the draw already has its first point down (a rectangle's first corner or the end of its side, a
    // circle's center): then a drag sets the next one where the finger is lifted, not where it went down.
    started() {
      const t = MB.tools.current, pm = MB.map.pm.Draw;
      const draw = t === 'rectangle' ? pm.Rectangle : t === 'circle' ? pm.Circle : null;
      if (!draw || !draw._layerGroup) return false;
      const first = t === 'circle' ? draw._centerMarker : draw._layer; // Geoman adds it on the first click
      return !!first && draw._layerGroup.hasLayer(first);
    },

    point(e) {
      const r = MB.map.getContainer().getBoundingClientRect();
      return L.point(e.clientX - r.left, e.clientY - r.top);
    },
    // The click or move Geoman would have had from a mouse (it does the snapping, the preview and the readout).
    fire(type, p, e) {
      MB.map.fire(type, { latlng: MB.map.containerPointToLatLng(p), layerPoint: MB.map.containerPointToLayerPoint(p), containerPoint: p, originalEvent: e });
    },

    down(e) {
      if (!this.active) return;
      if (this.g) { if (e.pointerId !== this.g.id) this.cancel(); return; } // a second finger: not a drawing
      if (e.pointerType === 'mouse' || !e.isPrimary || e.button !== 0 || !MB.ink.onMap(e)) return;
      e.preventDefault(); e.stopPropagation();
      const box = MB.circleRadius.box();
      if (box && document.activeElement === box) box.blur(); // the phone's keyboard is in the way of the map
      this.hold(true);
      this.ended = null;
      this.g = { id: e.pointerId, p0: this.point(e), placed: false, created: false, second: this.started() };
      try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* gone already */ }
    },

    move(e) {
      const g = this.g;
      if (!g) return;
      if (e.pointerId !== g.id) { this.cancel(); return; }
      e.preventDefault(); e.stopPropagation();
      const p = this.point(e);
      if (!g.placed) {
        if (Math.abs(p.x - g.p0.x) < this.MIN && Math.abs(p.y - g.p0.y) < this.MIN) return; // still a tap
        g.placed = true;
        this.swallow = Date.now() + 400; // (set before the click: the gesture may make the shape there and then)
        if (!g.second) { // the first point, where the finger went down (with one already down, the lift sets the next)
          this.fire('mousemove', g.p0, e); // first the move: Geoman's hint marker, and its snapping, belong there
          this.fire('click', g.p0, e);
          if (!this.g || g.created) return; // the shape is already made (a typed radius) or the tool is gone
        }
      }
      this.fire('mousemove', p, e);
    },

    up(e, cancelled) {
      const g = this.g;
      if (!g || e.pointerId !== g.id) {
        // the gesture already ended (its first point made the shape): its lift must not reach the map either, or
        // the click lands in the tool that followed and undoes the selection
        if (this.ended != null && this.ended === e.pointerId) { this.ended = null; this.swallow = Date.now() + 400; e.preventDefault(); e.stopPropagation(); }
        return;
      }
      e.preventDefault(); e.stopPropagation();
      if (cancelled) { this.cancel(); return; }
      this.g = null;
      this.hold(false);
      const p = this.point(e);
      // A tap: Leaflet gets its own click (tap, then tap, draws as it always did). The move first, so Geoman's hint
      // marker is where the finger is and its snapping decided before the click reads it.
      if (!g.placed) { this.fire('mousemove', p, e); return; }
      this.swallow = Date.now() + 400;
      if (g.created) return;
      this.fire('mousemove', p, e); // where it was lifted, snapping and all
      this.fire('click', p, e);
    }
  };

  /* ---------- measurement tool ---------- */
  // Finished measurements become regular objects ("Distance measurement" / "Area measurement")
  // on the active layer, so they can be selected, styled, edited, moved between layers and deleted.

  MB.measure = {
    active: false, mode: null, pts: [], tempGroup: null, tip: null,

    init() {
      this.tempGroup = L.featureGroup([], { pmIgnore: true }).addTo(MB.map);
      this.tip = document.createElement('div');
      this.tip.className = 'mb-measure-tip';
      MB.map.getContainer().appendChild(this.tip);
    },

    start(mode) {
      this.stop();
      this.active = true; this.mode = mode; this.pts = [];
      MB.map.doubleClickZoom.disable();
      MB.map.on('click', this._click, this);
      MB.map.on('mousemove', this._move, this);
      MB.map.on('dblclick', this._dbl, this);
      this._buildTemp();
      this._setTip(''); // nothing measured yet: no readout (the hint says how to start)
    },

    stop() {
      if (!this.active) return;
      this.active = false;
      this._clearTemp();
      MB.map.off('click', this._click, this);
      MB.map.off('mousemove', this._move, this);
      MB.map.off('dblclick', this._dbl, this);
      MB.map.doubleClickZoom.enable();
      this.tip.style.display = 'none';
    },

    cancel() { // Escape: drop the in-progress measurement, stay in the tool
      this.pts = [];
      this._clearTemp();
      this._buildTemp();
      this._setTip('');
    },

    _tempStyle() {
      this.style = MB.newMeasureStyle(); // the color this measurement will get
      const ms = MB.toLeafletStyle(this.style);
      return Object.assign(ms, { dashArray: ms.dashArray || '6,4', pmIgnore: true, interactive: false });
    },
    _buildTemp() {
      const st = this._tempStyle();
      this.tempLine = L.polyline([], Object.assign({}, st, { fill: false })).addTo(this.tempGroup);
      this.tempPoly = L.polygon([], st).addTo(this.tempGroup);
    },
    // Restyle the measurement in progress (the defaults or the color variation changed) without losing its points.
    restyleTemp() {
      if (!this.active) return;
      const st = this._tempStyle();
      this.tempLine.setStyle(Object.assign({}, st, { fill: false }));
      this.tempPoly.setStyle(st);
      this.tempGroup.eachLayer(l => { if (l.setRadius) l.setStyle({ color: this.style.color }); });
    },
    _clearTemp() { this.tempGroup.clearLayers(); },

    _click(e) {
      const last = this.pts[this.pts.length - 1];
      if (last && last.equals(e.latlng)) return;
      this.pts.push(e.latlng);
      L.circleMarker(e.latlng, { radius: 4, color: (this.style || MB.measureStyle).color, fillColor: '#1b1f27', fillOpacity: 1, weight: 2, pmIgnore: true, interactive: false }).addTo(this.tempGroup);
      this._redraw(e.latlng, e.containerPoint);
    },

    _move(e) { this._redraw(e.latlng, e.containerPoint); },

    _dbl(e) { L.DomEvent.stop(e); this.finish(); },

    _redraw(cursor, cp) {
      const pts = this.pts.concat(cursor ? [cursor] : []);
      if (cp) { this.tip.style.left = (cp.x + 16) + 'px'; this.tip.style.top = (cp.y + 16) + 'px'; }
      if (!this.pts.length) return;
      if (this.mode === 'area') {
        this.tempPoly.setLatLngs(pts);
        const area = MB.polygonArea(pts), per = MB.pathLength(pts, true);
        const seg = this.pts[this.pts.length - 1].distanceTo(cursor);
        this._setTip(`<b>${MB.formatArea(area)}</b><br>perimeter ${MB.formatDistance(per)}<br><span class="dim">segment ${MB.formatDistance(seg)}</span>`);
      } else {
        this.tempLine.setLatLngs(pts);
        const total = MB.pathLength(pts);
        const seg = this.pts[this.pts.length - 1].distanceTo(cursor);
        this._setTip(`<b>${MB.formatDistance(total)}</b><br><span class="dim">segment ${MB.formatDistance(seg)}</span>`);
      }
    },

    // The readout beside the pointer: measurements only (shown while there are some)
    _setTip(html) { this.tip.innerHTML = html; this.tip.style.display = html ? 'block' : 'none'; },

    finish() {
      if (!this.active) return;
      const pts = this.pts.slice();
      const need = this.mode === 'area' ? 3 : 2;
      if (pts.length < need) { this.cancel(); return; }
      const type = this.mode === 'area' ? 'measure-area' : 'measure-line';
      // the measurement gets the color it was previewed in; the palette moves on from it
      const style = this.style || MB.newMeasureStyle();
      if (MB.state.autoColor !== false) MB.nextColor(true, style.color);
      const f = MB.restoreFeature({
        type, layerId: MB.activeLayer().id, style: MB.deepClone(style),
        latlngs: pts.map(p => [p.lat, p.lng])
      });
      MB.commit('measure');
      MB.noteAdded(f);
      this.pts = [];
      this._clearTemp();
      this._buildTemp();
      this._setTip('');
      if (!MB.state.continueDrawing && f) { MB.tools.set('select'); MB.selectFeature(f); }
    }
  };

  /* ---------- SVG placement tool ---------- */

  MB.svgPlace = {
    active: false, svgId: null,
    start(svgId) {
      if (svgId) this.svgId = svgId;
      if (!this.svgId || !MB.state.svgLibrary[this.svgId]) {
        this.svgId = Object.keys(MB.state.svgLibrary)[0] || null;
      }
      if (!this.svgId) {
        MB.toast('Upload an image in the Images panel first');
        setTimeout(() => MB.tools.set('select'), 0);
        return;
      }
      this.active = true;
      MB.map.on('click', this._click, this);
    },
    stop() {
      if (!this.active) return;
      this.active = false;
      MB.map.off('click', this._click, this);
    },
    _click(e) {
      const layer = MB.createSvgFeature(e.latlng, this.svgId);
      if (!layer) return;
      MB.commit('place svg');
      MB.noteAdded(layer);
      if (!MB.state.continueDrawing) { MB.tools.set('select'); MB.selectFeature(layer); }
    }
  };

  /* ---------- icon placement tool ---------- */

  // The icon chosen in the picker (js/icons.js), placed by the map's next click as a marker named after it. The
  // marker takes the next color of the palette, as every new object does; its color, size, outline and angle are
  // changed in Properties afterwards.
  MB.iconPlace = {
    active: false, icon: null,
    arm(icon) { this.icon = icon && icon.name ? { name: String(icon.name), halo: icon.halo !== false } : null; },
    start() {
      if (!this.icon) { // nothing armed (the tool reached from elsewhere): the picker chooses one first
        MB.toast('Press I to choose an icon first');
        setTimeout(() => MB.tools.set('select'), 0);
        return;
      }
      this.active = true;
      MB.map.on('click', this._click, this);
    },
    stop() {
      if (!this.active) return;
      this.active = false;
      MB.map.off('click', this._click, this);
    },
    _click(e) {
      const icon = this.icon;
      if (!icon) return;
      const style = Object.assign(MB.newShapeStyle(true), { markerShape: 'icon', markerIcon: icon.name, markerHalo: icon.halo !== false });
      const layer = MB.restoreFeature({ type: 'marker', latlng: [e.latlng.lat, e.latlng.lng], layerId: MB.activeLayer().id, name: icon.name, style });
      if (!layer) return;
      MB.commit('place icon');
      MB.noteAdded(layer);
      MB.tools.refreshDraw(); // the next object gets the next color
      if (!MB.state.continueDrawing) { MB.tools.set('select'); MB.selectFeature(layer); }
    }
  };
})(window.MB);
