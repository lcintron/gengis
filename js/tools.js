/* GenGIS - tools: drawing (Geoman), measuring, SVG placement */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  /* ---------- tool switching ---------- */

  MB.tools = {
    current: 'select',
    shapes: { marker: 'Marker', text: 'Text', line: 'Line', polygon: 'Polygon', rectangle: 'Rectangle', circle: 'Circle' },

    set(name) {
      if (name === this.current && name !== 'select') name = 'select';
      MB.map.pm.disableDraw();
      MB.measure.stop();
      MB.svgPlace.stop();
      const keep = (name === 'select' || name === 'move') ? MB.selected : null;
      if (keep) MB.deselect();
      this.current = name;
      MB.map.getContainer().classList.toggle('mb-crosshair', name !== 'select' && name !== 'move');
      MB.map.getContainer().classList.toggle('mb-move', name === 'move');
      if (keep) MB.selectFeature(keep); // re-select so edit vs. drag-only mode matches the tool
      if (this.shapes[name]) { MB.deselect(); this.startDraw(name); }
      else if (name === 'measure-distance') { MB.deselect(); MB.measure.start('distance'); }
      else if (name === 'measure-area') { MB.deselect(); MB.measure.start('area'); }
      else if (name === 'svg') { MB.deselect(); MB.svgPlace.start(); }
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
      MB.map.pm.enableDraw(this.shapes[name], opts);
    },

    // Called when the default style or active layer changes while a draw tool is active.
    refreshDraw() {
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
      // Deleting an object can free a palette color: the previews show what the next object will really get.
      MB.on('features', () => { this.refreshDraw(); if (MB.measure.active) MB.measure.restyleTemp(); });
      MB.map.on('pm:create', e => {
        const type = Object.keys(this.shapes).find(k => this.shapes[k] === e.shape) || 'polygon';
        const layer = e.layer;
        if (layer.mb) return;
        if (type === 'line') {
          // A line that ends where it started is a closed outline: store it as a polygon so it has an area.
          const lls = layer.getLatLngs();
          const byClick = this._closeLine && lls.length >= 3 && MB.isLatLng(lls[0]); // finished by clicking the first vertex
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
        if (this.current === 'select') MB.deselect();
      });
      MB.on('layers', () => this.refreshDraw()); // the active layer, or whether it is shown, changed
      // Geoman's text tool re-arms itself when a text box loses focus while drawing continues: not while it waits
      // for a hidden layer (and, armed anyway, it makes nothing: its text box would never reach the map)
      const TextDraw = L.PM && L.PM.Draw && L.PM.Draw.Text && L.PM.Draw.Text.prototype;
      if (TextDraw && TextDraw.enable && TextDraw._createMarker) {
        const enable = TextDraw.enable, create = TextDraw._createMarker;
        TextDraw.enable = function (...a) { if (MB.tools.textWaits) return; return enable.apply(this, a); };
        TextDraw._createMarker = function (e) { if (MB.tools.textWaits) return; return create.call(this, e); };
      }
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
      this._setTip('Click to start measuring ' + (mode === 'area' ? 'an area' : 'a distance'));
      this.tip.style.display = 'block';
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
      this._setTip('Cancelled. Click to start again');
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
        this._setTip(`<b>${MB.formatArea(area)}</b><br>perimeter ${MB.formatDistance(per)}<br><span class="dim">segment ${MB.formatDistance(seg)} · double-click or Enter to finish</span>`);
      } else {
        this.tempLine.setLatLngs(pts);
        const total = MB.pathLength(pts);
        const seg = this.pts[this.pts.length - 1].distanceTo(cursor);
        this._setTip(`<b>${MB.formatDistance(total)}</b><br><span class="dim">segment ${MB.formatDistance(seg)} · double-click or Enter to finish</span>`);
      }
    },

    _setTip(html) { this.tip.innerHTML = html; },

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
      this._setTip('Saved to layer "' + MB.activeLayer().name + '". Click to start another measurement');
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
        MB.toast('Upload an SVG in the SVG panel first');
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
})(window.MB);
