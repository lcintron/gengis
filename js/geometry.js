/* GenGIS - geometry helpers: multi-select, line <-> polygon conversion, joining lines, snap indicator */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  MB.SNAP_PX = 15; // same tolerance as drawing / editing snap distance

  MB.pxDist = (a, b) => MB.map.latLngToLayerPoint(a).distanceTo(MB.map.latLngToLayerPoint(b));

  function firstPart(ll) { // first ring / part as a flat LatLng array
    while (ll.length && !MB.isLatLng(ll[0])) ll = ll[0];
    return ll;
  }
  function flattenAll(ll, out) {
    out = out || [];
    if (MB.isLatLng(ll)) out.push(ll); else ll.forEach(x => flattenAll(x, out));
    return out;
  }
  const toArr = p => [+p.lat.toFixed(7), +p.lng.toFixed(7)];

  function mark(layer, on) {
    const el = layer.getElement ? layer.getElement() : layer._path;
    if (el) L.DomUtil[on ? 'addClass' : 'removeClass'](el, 'mb-selected');
  }

  // Put a feature back at a given position of the draw order.
  function reinsert(id, index) {
    const ids = Object.keys(MB.featureLayers);
    const cur = ids.indexOf(id);
    if (cur < 0 || index < 0) return;
    ids.splice(cur, 1);
    ids.splice(Math.min(index, ids.length), 0, id);
    const next = {};
    ids.forEach(k => { next[k] = MB.featureLayers[k]; });
    MB.featureLayers = next;
  }

  /* ================= multi-select (shift-click) ================= */

  MB.multi = new Set();

  MB.clearMulti = function (silent) {
    if (!MB.multi.size) return;
    MB.multi.forEach(l => mark(l, false));
    MB.multi.clear();
    if (!silent) MB.emit('selection', MB.selected);
  };

  MB.toggleMulti = function (layer) {
    if (!layer || MB.isFeatureLocked(layer)) return;
    if (MB.selected && !MB.multi.size) {
      const s = MB.selected;
      MB.deselect();
      if (s === layer) return; // shift-clicking the only selected object just deselects it
      MB.multi.add(s); mark(s, true);
    }
    if (MB.multi.has(layer)) { MB.multi.delete(layer); mark(layer, false); }
    else { MB.multi.add(layer); mark(layer, true); }
    if (MB.multi.size === 1) { // back to a normal single selection
      const only = Array.from(MB.multi)[0];
      MB.multi.clear(); mark(only, false);
      MB.selectFeature(only);
      return;
    }
    MB.emit('selection', null);
  };

  MB.deleteMulti = function () {
    const list = Array.from(MB.multi).filter(l => !MB.isFeatureLocked(l));
    if (!list.length) return;
    MB.deselect();
    list.forEach(l => MB.removeFeature(l.mb.id, { silent: true }));
    MB.emit('features');
    MB.commit('delete objects');
    MB.toast(list.length + ' objects deleted');
  };

  MB.moveMultiToLayer = function (layerId) {
    const list = Array.from(MB.multi);
    MB.deselect();
    list.forEach(l => MB.moveFeatureToLayer(l.mb.id, layerId));
  };

  /* ================= line <-> polygon conversion ================= */

  MB.canConvert = function (layer) {
    const t = layer.mb.type;
    return t === 'line' ? 'polygon' : (t === 'polygon' || t === 'rectangle') ? 'line' : t === 'measure-line' ? 'measure-area' : t === 'measure-area' ? 'measure-line' : null;
  };
  MB.convertLabel = function (layer) {
    return { polygon: 'Convert to polygon (close shape)', line: 'Convert to line (outline)', 'measure-area': 'Convert to area measurement', 'measure-line': 'Convert to distance measurement' }[MB.canConvert(layer)] || '';
  };

  MB.convertFeature = function (layer) {
    const to = MB.canConvert(layer);
    if (!to) return null;
    const closing = to === 'polygon' || to === 'measure-area';
    let pts = firstPart(layer.getLatLngs()).slice();
    if (closing) {
      if (pts.length > 3 && MB.pxDist(pts[0], pts[pts.length - 1]) <= MB.SNAP_PX) pts.pop(); // drop a duplicated closing point
      if (pts.length < 3) { MB.toast('A polygon needs at least 3 points'); return null; }
    } else pts.push(pts[0]);
    const d = MB.serializeFeature(layer);
    const idx = Object.keys(MB.featureLayers).indexOf(d.id);
    const wasSelected = MB.selected === layer;
    MB.removeFeature(d.id, { silent: true });
    d.type = to;
    d.latlngs = closing ? [pts.map(toArr)] : pts.map(toArr);
    const n = MB.restoreFeature(d);
    reinsert(d.id, idx);
    MB.applyFeatureOrder(n.mb.layerId);
    if (MB.ui && MB.ui.bindNameTip) MB.ui.bindNameTip(n);
    MB.emit('features');
    MB.commit('convert shape');
    if (wasSelected) MB.selectFeature(n);
    if (closing) MB.toast('Converted to a closed shape: ' + MB.formatArea(MB.polygonArea(n.getLatLngs())));
    return n;
  };

  /* ================= joining lines ================= */

  function segmentsCross(a, b, c, d) {
    const o = (p, q, r) => Math.sign((q.lng - p.lng) * (r.lat - p.lat) - (q.lat - p.lat) * (r.lng - p.lng));
    return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b) && o(a, b, c) !== 0 && o(a, b, d) !== 0;
  }
  MB.selfIntersects = function (ring) {
    const n = ring.length;
    if (n < 4 || n > 1500) return false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue; // adjacent through the closing edge
        if (segmentsCross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
      }
    }
    return false;
  };

  // Join lines whose endpoints touch (within the snap tolerance) into one line, or a polygon when they close.
  // opts.keepLines: keep the original lines and add a fill-only polygon underneath (requires a closed chain).
  MB.joinLines = function (layers, opts) {
    opts = opts || {};
    const lines = Array.from(layers).filter(l => l.mb.type === 'line' || l.mb.type === 'measure-line');
    if (!lines.length) { MB.toast('Select the lines to join (shift-click to select several)'); return null; }
    const tol = MB.SNAP_PX;
    const parts = lines.map(l => ({ layer: l, pts: firstPart(l.getLatLngs()).slice() })).filter(p => p.pts.length >= 2);
    let chain = parts[0].pts.slice();
    const rest = parts.slice(1);
    let progress = true;
    while (rest.length && progress) {
      progress = false;
      for (let i = 0; i < rest.length; i++) {
        const p = rest[i].pts, head = chain[0], tail = chain[chain.length - 1];
        if (MB.pxDist(tail, p[0]) <= tol) chain = chain.concat(p.slice(1));
        else if (MB.pxDist(tail, p[p.length - 1]) <= tol) chain = chain.concat(p.slice(0, -1).reverse());
        else if (MB.pxDist(head, p[p.length - 1]) <= tol) chain = p.slice(0, -1).concat(chain);
        else if (MB.pxDist(head, p[0]) <= tol) chain = p.slice(1).reverse().concat(chain);
        else continue;
        rest.splice(i, 1); progress = true; break;
      }
    }
    if (rest.length) {
      let best = Infinity;
      rest.forEach(r => [r.pts[0], r.pts[r.pts.length - 1]].forEach(e => [chain[0], chain[chain.length - 1]].forEach(c => { best = Math.min(best, e.distanceTo(c)); })));
      MB.toast(`These lines don't all connect: the nearest gap is ${MB.formatDistance(best)}. Drag the endpoints together (they snap) and try again.`, 5000);
      return null;
    }
    const closed = chain.length >= 4 && MB.pxDist(chain[0], chain[chain.length - 1]) <= tol;
    if (closed) chain = chain.slice(0, -1);
    if (opts.keepLines && !closed) {
      MB.toast(`The lines don't form a closed outline: the ends are ${MB.formatDistance(chain[0].distanceTo(chain[chain.length - 1]))} apart.`, 5000);
      return null;
    }
    if (!closed && lines.length < 2) { MB.toast('Select two or more connected lines to join'); return null; }
    const first = lines[0].mb;
    const measure = lines.every(l => l.mb.type === 'measure-line');
    const type = closed ? (measure ? 'measure-area' : 'polygon') : (measure ? 'measure-line' : 'line');
    const named = lines.find(l => l.mb.name);
    const style = MB.deepClone(first.style);
    if (opts.keepLines) { style.opacity = 0; style.fill = true; } // fill only: the original lines stay as the border
    const d = { type, layerId: first.layerId, name: named ? named.mb.name : '', style, label: first.label ? MB.deepClone(first.label) : undefined,
      latlngs: closed ? [chain.map(toArr)] : chain.map(toArr) };
    const idx = Object.keys(MB.featureLayers).indexOf(first.id);
    MB.deselect();
    if (!opts.keepLines) lines.forEach(l => MB.removeFeature(l.mb.id, { silent: true }));
    const n = MB.restoreFeature(d);
    reinsert(n.mb.id, idx); // below the kept lines / where the first line was
    MB.applyFeatureOrder(n.mb.layerId);
    if (MB.ui && MB.ui.bindNameTip) MB.ui.bindNameTip(n);
    MB.emit('features');
    MB.commit('join lines');
    if (MB.tools.current !== 'select' && MB.tools.current !== 'move') MB.tools.set('select');
    MB.selectFeature(n);
    if (closed && MB.selfIntersects(chain)) MB.toast('Joined, but the outline crosses itself, so the area may be misleading.', 5000);
    else if (closed) MB.toast(`${opts.keepLines ? 'Created a polygon from' : 'Joined'} ${lines.length} line${lines.length > 1 ? 's' : ''}: area ${MB.formatArea(MB.polygonArea(chain))}`, 4000);
    else MB.toast(`Joined ${lines.length} lines into one line (${MB.formatDistance(MB.pathLength(chain))})`, 4000);
    return n;
  };

  /* ================= joining shapes ================= */
  // Overlapping (or touching) polygons, rectangles, circles and area measurements become one polygon: their union,
  // holes kept. The union is worked out in Web Mercator, where the shapes' edges are drawn straight (a circle as a
  // 72-sided polygon), with polygon-clipping (vendor/).

  const SHAPE_TYPES = ['polygon', 'rectangle', 'circle', 'measure-area'];
  MB.isJoinableShape = l => SHAPE_TYPES.includes(l.mb.type);
  const merc = L.Projection.SphericalMercator;
  const closeRing = r => (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) ? r.concat([r[0]]) : r);
  const ringXY = lls => closeRing(lls.map(p => { const q = merc.project(p); return [q.x, q.y]; }));

  // A shape as polygon-clipping's multipolygon: [polygon [ring [x, y]]]
  function shapeGeom(l) {
    if (l.mb.type === 'circle') {
      const c = l.getLatLng(), r = l.getRadius();
      return [[ringXY(Array.from({ length: 72 }, (_, i) => MB.destination(c, i * 5, r)))]];
    }
    const ll = l.getLatLngs();
    if (MB.isLatLng(ll[0])) return [[ringXY(ll)]];                    // one ring
    if (ll[0] && MB.isLatLng(ll[0][0])) return [ll.map(ringXY)];       // a ring and its holes
    return ll.map(poly => poly.map(ringXY));                            // several parts
  }

  // The union of the selected shapes, or why there is none.
  MB.shapeUnion = function (layers) {
    const shapes = Array.from(layers).filter(MB.isJoinableShape);
    if (shapes.length < 2) return { shapes, error: 'Select two or more overlapping shapes to join' };
    if (!window.polygonClipping) return { shapes, error: 'Joining shapes is not available' };
    let result;
    try { result = window.polygonClipping.union(...shapes.map(shapeGeom)); } catch (e) { return { shapes, error: 'These shapes could not be joined' }; }
    if (result.length !== 1) return { shapes, error: "These shapes don't all overlap: move them together and try again" };
    return { shapes, polygon: result[0] };
  };

  MB.joinShapes = function (layers) {
    const u = MB.shapeUnion(layers);
    if (!u.polygon) { MB.toast(u.error, 5000); return null; }
    const shapes = u.shapes, first = shapes[0].mb;
    const rings = u.polygon.map(r => r.slice(0, -1).map(p => toArr(merc.unproject(L.point(p[0], p[1])))));
    const named = shapes.find(l => l.mb.name);
    const d = { type: shapes.every(l => l.mb.type === 'measure-area') ? 'measure-area' : 'polygon', layerId: first.layerId,
      name: named ? named.mb.name : '', style: MB.deepClone(first.style), label: first.label ? MB.deepClone(first.label) : undefined, latlngs: rings };
    const idx = Object.keys(MB.featureLayers).indexOf(first.id);
    MB.deselect();
    shapes.forEach(l => MB.removeFeature(l.mb.id, { silent: true }));
    const n = MB.restoreFeature(d);
    reinsert(n.mb.id, idx); // where the first shape was
    MB.applyFeatureOrder(n.mb.layerId);
    if (MB.ui && MB.ui.bindNameTip) MB.ui.bindNameTip(n);
    MB.emit('features');
    MB.commit('join shapes');
    if (!MB.tools.picks(MB.tools.current)) MB.tools.set('select');
    MB.selectFeature(n);
    MB.toast(`Joined ${shapes.length} shapes: area ${MB.formatArea(MB.polygonArea(n.getLatLngs()))}` + (rings.length > 1 ? ` (${rings.length - 1} hole${rings.length > 2 ? 's' : ''} kept)` : ''), 4000);
    return n;
  };

  /* ================= snap indicator ================= */

  MB.snap = {
    marker: null,
    show(e) {
      const ll = e && e.snapLatLng;
      if (!ll) return;
      let kind = 'edge';
      try {
        const other = e.layerInteractedWith;
        const pts = other.getLatLngs ? flattenAll(other.getLatLngs()) : (other.getLatLng ? [other.getLatLng()] : []);
        let bi = -1, bd = Infinity;
        pts.forEach((p, i) => { const dd = MB.pxDist(p, ll); if (dd < bd) { bd = dd; bi = i; } });
        if (bd <= 1.5) {
          kind = 'vertex';
          if (other instanceof L.Polyline && !(other instanceof L.Polygon) && (bi === 0 || bi === pts.length - 1)) kind = 'endpoint';
          if (!other.getLatLngs) kind = 'point';
        }
      } catch (err) { /* ignore */ }
      const color = kind === 'edge' ? '#ffd166' : '#2ecc71';
      const radius = kind === 'endpoint' ? 11 : 8;
      const text = { edge: 'on edge', vertex: 'vertex', endpoint: 'line end', point: 'point' }[kind];
      if (!this.marker) {
        this.marker = L.circleMarker(ll, { radius, color, weight: 3, fill: false, interactive: false, pmIgnore: true, pane: 'mb-snap' });
        this.marker.bindTooltip(text, { permanent: true, direction: 'right', offset: [12, 0], className: 'mb-snap-tip', pane: 'mb-snap' });
      }
      this.marker.setLatLng(ll); this.marker.setStyle({ color }); this.marker.setRadius(radius);
      if (!MB.map.hasLayer(this.marker)) this.marker.addTo(MB.map);
      this.marker.setTooltipContent(text);
    },
    hide() { if (this.marker && MB.map.hasLayer(this.marker)) MB.map.removeLayer(this.marker); }
  };

  MB.geometry = {
    init() {
      const pane = MB.map.createPane('mb-snap');
      pane.style.zIndex = 660;
      pane.style.pointerEvents = 'none';
      MB.map.on('pm:drawstart', e => {
        const wl = e.workingLayer;
        if (!wl || !wl.on) return;
        wl.on('pm:snap', ev => MB.snap.show(ev));
        wl.on('pm:unsnap', () => MB.snap.hide());
        MB.tools._closeLine = false;
        if (e.shape === 'Line') {
          // Clicking back on the first point closes the outline: pm:create then stores it as a polygon.
          // (The drawing library finishes the line when its first vertex marker is clicked, without adding a point,
          //  so remember that the finish came from the first vertex.)
          wl.on('pm:vertexadded', ev => {
            const lls = wl.getLatLngs();
            if (lls.length === 1 && ev.marker && ev.marker.on) {
              ev.marker.on('mousedown', () => { if (wl.getLatLngs().length >= 3) MB.tools._closeLine = true; });
            }
            if (lls.length >= 4 && MB.pxDist(lls[0], lls[lls.length - 1]) <= MB.SNAP_PX) {
              setTimeout(() => { try { MB.map.pm.Draw.Line._finishShape(); } catch (err) { /* ignore */ } }, 0);
            }
          });
        }
      });
      MB.map.on('pm:drawend', () => MB.snap.hide());
    }
  };
})(window.MB);
