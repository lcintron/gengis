/* GenGIS - features: shapes, styles, SVG placements, selection, (de)serialization */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  MB.defaultStyle = {
    color: '#e4572e', weight: 3, opacity: 1, dash: 'solid',
    fill: true, fillColor: '#e4572e', fillOpacity: 0.25,
    textColor: '#ffffff', textSize: 14, textBg: '#1b1f27', textBgOn: true,
    textBold: false, textItalic: false, textUnderline: false, textStrike: false,
    textAlign: 'center', textHAnchor: 'center', textVAnchor: 'middle',
    textScale: 'screen' // 'screen': the same size at every zoom; 'map': grows and shrinks with the map (textSize at textRefZoom)
  };
  MB.currentStyle = MB.deepClone(MB.defaultStyle);

  // Default style for measurement objects (distance / area).
  MB.defaultMeasureStyle = { color: '#ffd166', weight: 3, opacity: 1, dash: 'solid', fill: true, fillColor: '#ffd166', fillOpacity: 0.18 };
  MB.measureStyle = MB.deepClone(MB.defaultMeasureStyle);

  MB.svgDefaults = { mode: 'pin', widthPx: 48, widthM: 20, rotation: 0, opacity: 1 };

  /* ---------- a color of its own for each new object ----------
   * Unless the user pins a color in the "New shapes" defaults, every new line, shape, marker and measurement takes
   * the next color of the palette: the one used by the fewest existing objects, cycling from the last one handed
   * out. Picking telling colors apart on both light and dark maps is what the palette was chosen for. */
  MB.PALETTE = ['#e4572e', '#2f80ed', '#27ae60', '#9b51e0', '#f2c94c', '#00b8d9', '#eb5757', '#f2994a', '#1abc9c', '#d81b60', '#8d6e63', '#6c8ebf'];
  let lastColor = null;
  // The color the next object would get; with `take`, it is handed out (the cycle moves on).
  MB.nextColor = function (take, from) {
    if (from) { lastColor = from; return from; } // a color that was previewed and then used: the cycle moves on from it
    const used = {};
    Object.keys(MB.featureLayers).forEach(id => { const m = MB.featureLayers[id].mb; const c = m && m.style && String(m.style.color || '').toLowerCase(); if (c) used[c] = (used[c] || 0) + 1; });
    const P = MB.PALETTE, start = (P.indexOf(lastColor) + 1) % P.length;
    let best = P[start], min = Infinity;
    for (let i = 0; i < P.length; i++) { const c = P[(start + i) % P.length], n = used[c] || 0; if (n < min) { min = n; best = c; } }
    if (take) lastColor = best;
    return best;
  };
  function withNextColor(base, take) {
    const s = MB.deepClone(base);
    if (MB.state.autoColor !== false) { const c = MB.nextColor(take); s.color = c; s.fillColor = c; }
    return s;
  }
  MB.newShapeStyle = take => withNextColor(MB.currentStyle, take);
  MB.newMeasureStyle = take => withNextColor(MB.measureStyle, take);

  MB.dashStyles = {
    solid: 'Solid', dashed: 'Dashed', dotted: 'Dotted', dashdot: 'Dash-dot', longdash: 'Long dash'
  };

  MB.dashArrayFor = function (style) {
    const w = Math.max(1, +style.weight || 3);
    switch (style.dash) {
      case 'dashed': return `${w * 3} ${w * 2}`;
      case 'dotted': return `0 ${w * 2.2}`;
      case 'dashdot': return `${w * 4} ${w * 2.2} 0 ${w * 2.2}`;
      case 'longdash': return `${w * 7} ${w * 3}`;
      default: return null;
    }
  };

  MB.toLeafletStyle = function (style) {
    const s = Object.assign({}, MB.defaultStyle, style || {});
    const capRound = s.dash !== 'dashed' && s.dash !== 'longdash';
    return {
      color: s.color, weight: +s.weight, opacity: +s.opacity,
      fill: !!s.fill, fillColor: s.fillColor, fillOpacity: +s.fillOpacity,
      dashArray: MB.dashArrayFor(s), lineCap: capRound ? 'round' : 'butt', lineJoin: 'round'
    };
  };

  MB.typeLabels = {
    marker: 'Marker', text: 'Text', line: 'Line', polygon: 'Polygon', rectangle: 'Rectangle',
    circle: 'Circle', svg: 'SVG image', 'measure-line': 'Distance measurement', 'measure-area': 'Area measurement'
  };
  MB.isMeasureType = t => t === 'measure-line' || t === 'measure-area';

  MB.commitDebounced = MB.debounce(label => MB.commit(label), 400);

  /* ---------- add / remove ---------- */

  MB.addFeature = function (layer, meta) {
    meta = meta || {};
    const id = meta.id || MB.uid();
    let layerId = meta.layerId;
    if (!layerId || !MB.groups[layerId]) layerId = MB.activeLayer().id;
    layer.mb = {
      id, layerId, type: meta.type || 'polygon', name: meta.name || '',
      style: meta.style ? MB.deepClone(meta.style) : MB.deepClone(MB.currentStyle),
      text: meta.text, svg: meta.svg ? MB.deepClone(meta.svg) : undefined,
      visible: meta.visible !== false, locked: !!meta.locked,
      label: meta.label ? MB.deepClone(meta.label) : undefined
    };
    MB.featureLayers[id] = layer;
    const g = MB.groups[layerId];
    if (!g.hasLayer(layer)) {
      if (MB.map.hasLayer(layer)) MB.map.removeLayer(layer);
      g.addLayer(layer);
    }
    MB.applyStyle(layer, {}, { noCommit: true });
    bindFeatureEvents(layer);
    MB.updateTooltip(layer);
    if (!layer.mb.visible) { removeSegLabels(layer); g.removeLayer(layer); }
    MB.applyZOrderSoon();
    MB.emit('features');
    return layer;
  };

  MB.isFeatureLocked = function (layer) {
    const lay = MB.getLayer(layer.mb.layerId);
    return !!(layer.mb.locked || (lay && lay.locked));
  };

  // Objects of a layer, bottom-most first (draw order).
  MB.layerFeatures = function (layerId) {
    return Object.keys(MB.featureLayers).map(id => MB.featureLayers[id]).filter(f => f.mb.layerId === layerId);
  };

  MB.setFeatureVisible = function (id, visible) {
    const l = MB.featureLayers[id];
    if (!l) return;
    l.mb.visible = !!visible;
    const g = MB.groups[l.mb.layerId];
    if (visible) {
      if (!g.hasLayer(l)) g.addLayer(l);
      MB.updateTooltip(l);
      MB.applyFeatureOrder(l.mb.layerId);
    } else {
      if (MB.selected === l) MB.deselect();
      removeSegLabels(l);
      g.removeLayer(l);
      if (MB.map.hasLayer(l)) MB.map.removeLayer(l);
    }
    MB.emit('features');
    MB.commit('object visibility');
  };

  MB.setFeatureLocked = function (id, locked) {
    const l = MB.featureLayers[id];
    if (!l) return;
    l.mb.locked = !!locked;
    if (MB.selected === l) { MB.deselect(); MB.selectFeature(l); }
    MB.emit('features');
    MB.commit('object lock');
  };

  // Re-apply the draw order of the objects (paths / image overlays; markers keep their pane order). Every layer is
  // restacked: the layers above this one must stay above it.
  MB.applyFeatureOrder = function () { MB.applyZOrder(); };

  // Put an object at the top (or bottom) of its layer's order.
  function placeFeature(id, top) {
    const ids = Object.keys(MB.featureLayers).filter(k => k !== id);
    if (top) ids.push(id); else ids.unshift(id);
    const next = {};
    ids.forEach(k => { next[k] = MB.featureLayers[k]; });
    MB.featureLayers = next;
  }
  MB.featureToEdge = function (id, top) {
    if (!MB.featureLayers[id]) return;
    placeFeature(id, top);
    MB.applyZOrder();
    MB.emit('features');
    MB.commit(top ? 'bring to front' : 'send to back');
  };

  // Move an object one step up (+1, towards the top) or down (-1) within its layer.
  MB.moveFeature = function (id, delta) {
    const l = MB.featureLayers[id];
    if (!l) return;
    const ids = Object.keys(MB.featureLayers);
    const i = ids.indexOf(id);
    let j = i + (delta > 0 ? 1 : -1);
    while (j >= 0 && j < ids.length && MB.featureLayers[ids[j]].mb.layerId !== l.mb.layerId) j += (delta > 0 ? 1 : -1);
    if (j < 0 || j >= ids.length) return;
    const t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    const next = {};
    ids.forEach(k => { next[k] = MB.featureLayers[k]; });
    MB.featureLayers = next;
    MB.applyFeatureOrder(l.mb.layerId);
    MB.emit('features');
    MB.commit('reorder objects');
  };

  MB.removeFeature = function (id, opts) {
    const l = MB.featureLayers[id];
    if (!l) return;
    if (l.mb.locked && !(opts && (opts.silent || opts.force))) { MB.toast('Object is locked. Unlock it first.'); return; }
    if (MB.selected === l) MB.deselect();
    if (MB.multi && MB.multi.has(l)) MB.multi.delete(l);
    removeSegLabels(l);
    const g = MB.groups[l.mb.layerId];
    if (g) g.removeLayer(l);
    if (MB.map.hasLayer(l)) MB.map.removeLayer(l);
    delete MB.featureLayers[id];
    if (!opts || !opts.silent) { MB.emit('features'); MB.commit('delete'); }
  };

  MB.moveFeatureToLayer = function (id, layerId) {
    const l = MB.featureLayers[id];
    if (!l || !MB.groups[layerId] || l.mb.layerId === layerId) return;
    const wasSelected = MB.selected === l;
    if (wasSelected) MB.deselect();
    removeSegLabels(l);
    MB.groups[l.mb.layerId].removeLayer(l);
    l.mb.layerId = layerId;
    placeFeature(id, true); // it lands on top of the objects of its new layer
    if (l.mb.visible !== false) { MB.groups[layerId].addLayer(l); updateSegLabels(l); MB.updateLabel(l); }
    MB.applyZOrder();
    if (wasSelected && MB.getLayer(layerId).visible) MB.selectFeature(l);
    MB.emit('features');
    MB.commit('move to layer');
  };

  MB.duplicateFeature = function (id) {
    const l = MB.featureLayers[id];
    if (!l) return null;
    const d = MB.serializeFeature(l);
    d.id = MB.uid();
    d.name = d.name ? d.name + ' copy' : '';
    const n = MB.restoreFeature(d);
    MB.commit('duplicate');
    return n;
  };

  function bindFeatureEvents(layer) {
    if (layer._mbBound) return;
    layer._mbBound = true;
    layer.on('click', e => {
      const t = MB.tools.current;
      if (t !== 'select' && t !== 'move' && t !== 'present') return;
      const shift = e.originalEvent && e.originalEvent.shiftKey;
      if (t !== 'present' && !MB.isFeatureLocked(layer)) {
        L.DomEvent.stopPropagation(e);
        if (shift) MB.toggleMulti(layer); else MB.selectFeature(layer);
        if (MB.ui && MB.ui.revealFeature) MB.ui.revealFeature(layer);
        if (shift) return;
      }
      // Objects draw above the data layers, so the data under one is only reachable from here: the same popup as
      // a click on the data, with the objects at this point listed first. Nothing opens where there is no data, nor
      // with the Move tool (a click there ends a drag).
      if (shift || t === 'move' || !MB.data || !MB.data.identify) return;
      // where the pointer was: a marker's event carries its anchor (a keyboard activation has no pointer)
      const oe = e.originalEvent, pointer = oe && oe.clientX != null && (oe.clientX || oe.clientY);
      const latlng = pointer ? MB.map.mouseEventToLatLng(oe) : e.latlng, cp = pointer ? MB.map.mouseEventToContainerPoint(oe) : e.containerPoint;
      MB.data.identify(latlng, cp, null, { own: MB.data.objectsAt(latlng, cp) });
    });
    layer.on('pm:snap', ev => MB.snap.show(ev));
    layer.on('pm:unsnap pm:markerdragend pm:dragend', () => MB.snap.hide());
    layer.on('contextmenu', e => {
      if (MB.presenter && MB.presenter.active) return;
      if (MB.tools.current !== 'select' && MB.tools.current !== 'move') return;
      const tgt = e.originalEvent && e.originalEvent.target;
      if (tgt && tgt.tagName === 'TEXTAREA' && !tgt.readOnly && document.activeElement === tgt) return; // native menu while typing
      L.DomEvent.stop(e);
      if (MB.multi.size > 1 && MB.multi.has(layer)) {
        MB.emit('multi-contextmenu', { layer, latlng: e.latlng, x: e.originalEvent.clientX, y: e.originalEvent.clientY });
        return;
      }
      MB.selectFeature(layer);
      MB.emit('feature-contextmenu', { layer, latlng: e.latlng, x: e.originalEvent.clientX, y: e.originalEvent.clientY });
    });
    const changed = label => {
      MB.updateTooltip(layer);
      MB.emit('featurechange', layer);
      MB.commitDebounced(label);
    };
    layer.on('pm:edit', () => changed('edit'));
    layer.on('pm:dragend', () => changed('move'));
    layer.on('dragend', () => changed('move'));
    layer.on('drag pm:drag', () => MB.updateLabel(layer));
    layer.on('pm:textchange', e => { layer.mb.text = e.text; MB.commitDebounced('text'); });
    layer.on('pm:textblur', () => {
      const txt = layer.pm ? layer.pm.getText() : '';
      if (!txt || !txt.trim()) { MB.removeFeature(layer.mb.id); return; }
      layer.mb.text = txt;
      MB.commit('text');
    });
  }

  /* ---------- style ---------- */

  MB.applyStyle = function (layer, patch, opts) {
    opts = opts || {};
    const t = layer.mb.type;
    if (t === 'text' && patch) textSizing(layer.mb.style, patch = Object.assign({}, patch));
    const st = Object.assign(layer.mb.style, patch || {});
    if (layer instanceof L.Path) {
      const ls = MB.toLeafletStyle(st);
      if (t === 'line' || t === 'measure-line') ls.fill = false; // open lines are never filled
      layer.setStyle(ls);
      if (MB.isMeasureType(t)) updateSegLabels(layer);
    }
    else if (t === 'marker') layer.setIcon(MB.pinIcon(st.color));
    else if (t === 'text') MB.applyTextStyle(layer);
    else if (t === 'svg') MB.refreshSvg(layer);
    if (!opts.noCommit) MB.commitDebounced('style');
  };

  // Text that scales with the map: its size is textSize at zoom textRefZoom, doubling with each zoom step in.
  const zoomNow = () => (MB.map ? MB.map.getZoom() : 0);
  const mapScale = st => (st.textScale === 'map' && st.textRefZoom != null ? Math.pow(2, zoomNow() - st.textRefZoom) : 1);
  // The size it shows at now, in px (what the size slider shows and sets, and what it keeps when switching to fixed
  // pixels): scaled, but never beyond MAX_SHOWN, where drawing stops growing.
  const MAX_SHOWN = 2000;
  const shown = st => Math.min((+st.textSize || 14) * mapScale(st), Math.max(MAX_SHOWN, +st.textSize || 14));
  MB.textShownSize = st => Math.round(shown(st));
  // A style change on a text: switching to 'map' keeps the size it shows (from this zoom on); back to 'screen', it
  // keeps the size it shows now; a new size while scaling with the map is the size at this zoom.
  function textSizing(st, patch) {
    const mode = patch.textScale || st.textScale;
    if (patch.textScale && patch.textScale !== st.textScale) {
      if (mode === 'map') patch.textRefZoom = zoomNow();
      else { if (!('textSize' in patch)) patch.textSize = Math.max(1, MB.textShownSize(st)); patch.textRefZoom = null; }
    }
    if ('textSize' in patch && mode === 'map') patch.textRefZoom = zoomNow();
  }

  // Where the text block sits relative to its map point (its anchor), and its scale for 'map' sizing (about the
  // anchor, so the text grows from the point it is pinned to). Too small to read, it is not drawn.
  const ANCHOR_X = { left: ['0', '0%'], center: ['-50%', '50%'], right: ['-100%', '100%'] };
  const ANCHOR_Y = { top: ['0', '0%'], middle: ['-50%', '50%'], bottom: ['-100%', '100%'] };
  MB.textTransform = function (layer) {
    const st = layer.mb.style, ta = layer.pm && layer.pm.textArea;
    if (!ta) return;
    const [hx, ox] = ANCHOR_X[st.textHAnchor || 'center'], [vy, oy] = ANCHOR_Y[st.textVAnchor || 'middle'];
    const px = shown(st), s = px / (+st.textSize || 14);
    ta.style.transformOrigin = ox + ' ' + oy;
    ta.style.transform = `translate(${hx}, ${vy})` + (s !== 1 ? ` scale(${s})` : '');
    ta.style.visibility = px < 3 ? 'hidden' : '';
  };
  let zoomHooked = false;
  function rescaleTexts() {
    Object.keys(MB.featureLayers).forEach(id => {
      const f = MB.featureLayers[id];
      if (f.mb && f.mb.type === 'text' && f.mb.style.textScale === 'map') MB.textTransform(f);
    });
  }

  MB.applyTextStyle = function (layer) {
    const st = layer.mb.style;
    const ta = layer.pm && layer.pm.textArea;
    if (!ta) return;
    if (st.textScale === 'map' && st.textRefZoom == null) st.textRefZoom = zoomNow(); // placed while scaling with the map
    if (!zoomHooked && MB.map) { MB.map.on('zoom zoomend', rescaleTexts); zoomHooked = true; }
    ta.style.color = st.textColor;
    ta.style.fontSize = st.textSize + 'px';
    ta.style.lineHeight = '1.2';
    ta.style.background = st.textBgOn ? st.textBg : 'transparent';
    ta.style.padding = st.textBgOn ? '2px 6px' : '0';
    ta.style.borderRadius = '4px';
    ta.style.fontWeight = st.textBold ? '700' : '500';
    ta.style.fontStyle = st.textItalic ? 'italic' : 'normal';
    ta.style.textDecoration = [st.textUnderline && 'underline', st.textStrike && 'line-through'].filter(Boolean).join(' ') || 'none';
    ta.style.textAlign = st.textAlign || 'center';
    MB.textTransform(layer);
    try { layer.pm.setText(layer.pm.getText()); } catch (e) { /* not yet on map */ }
  };

  // Geoman sizes a text box to its scrollHeight/scrollWidth, and then the padding is added again around that
  // (content-box): an empty strip at the bottom of a text with a background. scrollHeight holds both vertical
  // paddings; a text area's scrollWidth holds only the left one (and rounds down: one pixel more, or the text spills
  // into the right padding). Size the content to the text alone.
  if (L.PM && L.PM.Edit && L.PM.Edit.Text && L.PM.Edit.Text.prototype._autoResize) {
    const autoResize = L.PM.Edit.Text.prototype._autoResize;
    L.PM.Edit.Text.prototype._autoResize = function () {
      autoResize.call(this);
      const ta = this.textArea, cs = getComputedStyle(ta);
      if (cs.boxSizing !== 'content-box') return;
      const px = v => parseFloat(v) || 0;
      ta.style.height = Math.max(1, px(ta.style.height) - px(cs.paddingTop) - px(cs.paddingBottom)) + 'px';
      ta.style.width = Math.max(1, px(ta.style.width) - px(cs.paddingLeft) + 1) + 'px';
    };
  }

  /* ---------- SVG features ---------- */

  MB.svgPinIcon = function (lib, svg) {
    const w = Math.max(4, +svg.width || 48), h = w / (lib.aspect || 1);
    return L.divIcon({
      className: 'mb-svg-pin',
      html: `<img src="${lib.dataUrl}" draggable="false" style="width:${w}px;height:${h}px;transform:rotate(${+svg.rotation || 0}deg);opacity:${svg.opacity == null ? 1 : svg.opacity}">`,
      iconSize: [w, h], iconAnchor: [w / 2, h / 2]
    });
  };

  MB.buildSvgLayer = function (latlng, svg) {
    const lib = MB.state.svgLibrary[svg.svgId];
    if (!lib) return null;
    latlng = L.latLng(latlng);
    if (svg.mode === 'ground') {
      const b = MB.boundsAround(latlng, svg.width, svg.width / (lib.aspect || 1));
      return L.imageOverlay(lib.dataUrl, b, {
        interactive: true, opacity: svg.opacity == null ? 1 : svg.opacity, pmIgnore: true, className: 'mb-svg-ground'
      });
    }
    return L.marker(latlng, { icon: MB.svgPinIcon(lib, svg), pmIgnore: true, draggable: false });
  };

  MB.svgCenter = function (layer) {
    return layer.getLatLng ? layer.getLatLng() : layer.getBounds().getCenter();
  };

  MB.refreshSvg = function (layer) {
    const svg = layer.mb.svg, lib = MB.state.svgLibrary[svg.svgId];
    if (!lib) return;
    if (svg.mode === 'ground' && layer.setBounds) {
      const c = layer.getBounds().getCenter();
      layer.setBounds(MB.boundsAround(c, svg.width, svg.width / (lib.aspect || 1)));
      layer.setOpacity(svg.opacity == null ? 1 : svg.opacity);
    } else if (layer.setIcon) {
      layer.setIcon(MB.svgPinIcon(lib, svg));
      if (MB.selected === layer && layer.getElement()) L.DomUtil.addClass(layer.getElement(), 'mb-selected');
    }
    MB.updateLabel(layer);
  };

  // Rebuild a feature from its serialized form (needed when an SVG switches pin <-> ground).
  MB.rebuildFeature = function (layer) {
    const d = MB.serializeFeature(layer);
    const wasSelected = MB.selected === layer;
    MB.removeFeature(layer.mb.id, { silent: true });
    const n = MB.restoreFeature(d);
    if (wasSelected && n) MB.selectFeature(n);
    MB.emit('features');
    return n;
  };

  MB.createSvgFeature = function (latlng, svgId, overrides) {
    const lib = MB.state.svgLibrary[svgId];
    if (!lib) return null;
    const d = MB.svgDefaults;
    const svg = Object.assign({
      svgId, mode: d.mode, rotation: d.rotation, opacity: d.opacity,
      width: d.mode === 'ground' ? d.widthM : d.widthPx
    }, overrides || {});
    const layer = MB.buildSvgLayer(latlng, svg);
    if (!layer) return null;
    return MB.addFeature(layer, { type: 'svg', svg, name: lib.name.replace(/\.svg$/i, ''), style: MB.deepClone(MB.currentStyle) });
  };

  function addGroundHandle(layer) {
    removeGroundHandle(layer);
    const c = layer.getBounds().getCenter();
    const h = L.marker(c, {
      draggable: true, pmIgnore: true, zIndexOffset: 2000,
      icon: L.divIcon({ className: 'mb-handle', iconSize: [16, 16], iconAnchor: [8, 8], html: '<span></span>' })
    }).addTo(MB.map);
    h.on('drag', () => {
      const svg = layer.mb.svg, lib = MB.state.svgLibrary[svg.svgId];
      layer.setBounds(MB.boundsAround(h.getLatLng(), svg.width, svg.width / (lib.aspect || 1)));
      MB.updateLabel(layer);
    });
    h.on('dragend', () => { MB.emit('featurechange', layer); MB.commit('move'); });
    layer._mbHandle = h;
  }
  function removeGroundHandle(layer) {
    if (layer._mbHandle) { MB.map.removeLayer(layer._mbHandle); layer._mbHandle = null; }
  }

  /* ---------- selection ---------- */

  MB.selectFeature = function (layer) {
    if (!layer || MB.selected === layer) return;
    MB.deselect();
    MB.selected = layer;
    const t = layer.mb.type;
    const moveOnly = MB.tools.current === 'move';
    const editable = !MB.isFeatureLocked(layer) && MB.map.hasLayer(layer);
    if (!editable) { /* locked or hidden: selectable for the Properties panel only */ }
    else if (t === 'svg') {
      if (layer.dragging) layer.dragging.enable();
      if (layer.setBounds) addGroundHandle(layer);
    } else if (layer.pm) {
      try {
        if (moveOnly) layer.pm.enableLayerDrag();
        else layer.pm.enable({ allowSelfIntersection: true, draggable: true, snappable: MB.state.snapping, snapDistance: 15 });
      } catch (e) { console.warn(e); }
    }
    const el = layer.getElement ? layer.getElement() : layer._path;
    if (el) L.DomUtil.addClass(el, 'mb-selected');
    MB.emit('selection', layer);
  };

  MB.deselect = function () {
    const hadMulti = MB.multi && MB.multi.size > 0;
    if (hadMulti) MB.clearMulti(true);
    if (MB.snap) MB.snap.hide();
    const l = MB.selected;
    if (!l) { if (hadMulti) MB.emit('selection', null); return; }
    MB.selected = null;
    try { if (l.pm && l.pm.enabled && l.pm.enabled()) l.pm.disable(); } catch (e) { /* ignore */ }
    try { if (l.pm && l.pm.layerDragEnabled && l.pm.layerDragEnabled()) l.pm.disableLayerDrag(); } catch (e) { /* ignore */ }
    if (l.mb && l.mb.type === 'svg') {
      if (l.dragging) l.dragging.disable();
      removeGroundHandle(l);
    }
    const el = l.getElement ? l.getElement() : l._path;
    if (el) L.DomUtil.removeClass(el, 'mb-selected');
    MB.emit('selection', null);
  };

  MB.zoomToFeature = function (layer) {
    if (layer.getBounds) {
      const b = layer.getBounds();
      if (b.isValid()) MB.map.fitBounds(b.pad(0.3), { maxZoom: 18 });
    } else if (layer.getLatLng) MB.map.setView(layer.getLatLng(), Math.max(MB.map.getZoom(), 16));
  };

  /* ---------- style clipboard ---------- */

  MB.styleClipboard = null;
  MB.copyStyle = function (layer) {
    MB.styleClipboard = MB.deepClone(layer.mb.style);
    MB.toast('Style copied');
  };
  MB.pasteStyle = function (layer) {
    if (!MB.styleClipboard) return;
    MB.applyStyle(layer, MB.deepClone(MB.styleClipboard));
    MB.emit('featurechange', layer);
    MB.commit('paste style');
  };

  MB.featureCenter = function (layer) {
    if (layer.getLatLng) return layer.getLatLng();
    if (layer.getBounds) return layer.getBounds().getCenter();
    return null;
  };

  /* ---------- measurements ---------- */

  MB.featureMeasure = function (layer) {
    const t = layer.mb.type, out = {};
    if (t === 'line' || t === 'measure-line') out.length = MB.pathLength(layer.getLatLngs());
    else if (t === 'polygon' || t === 'rectangle' || t === 'measure-area') {
      const ll = layer.getLatLngs();
      out.area = MB.polygonArea(ll);
      out.perimeter = MB.pathLength(ll, true);
    } else if (t === 'circle') {
      const r = layer.getRadius();
      out.radius = r; out.area = Math.PI * r * r; out.perimeter = 2 * Math.PI * r;
    } else if (t === 'svg' && layer.mb.svg.mode === 'ground') {
      const lib = MB.state.svgLibrary[layer.mb.svg.svgId];
      out.width = layer.mb.svg.width;
      out.height = lib ? layer.mb.svg.width / lib.aspect : null;
    }
    return out;
  };

  MB.measureText = function (layer) {
    const m = MB.featureMeasure(layer), parts = [];
    if (m.length != null) parts.push(MB.formatDistance(m.length));
    if (m.radius != null) parts.push('r ' + MB.formatDistance(m.radius));
    if (m.area != null) parts.push(MB.formatArea(m.area));
    return parts.join(' · ');
  };

  MB.updateTooltip = function (layer) {
    MB.updateLabel(layer);
    if (!(layer instanceof L.Path)) return;
    if (MB.isMeasureType(layer.mb.type)) {
      const mm = MB.featureMeasure(layer);
      const txt = layer.mb.type === 'measure-area'
        ? `<b>${MB.formatArea(mm.area)}</b><br>${MB.formatDistance(mm.perimeter)}`
        : `<b>${MB.formatDistance(mm.length)}</b>`;
      const tt = layer.getTooltip();
      if (tt) {
        tt.setContent(txt);
        if (layer.isTooltipOpen()) { layer.closeTooltip(); layer.openTooltip(); }
      } else {
        layer.bindTooltip(txt, { permanent: true, direction: layer.mb.type === 'measure-area' ? 'center' : 'top', className: 'mb-measure-result', interactive: false });
      }
      updateSegLabels(layer);
      return;
    }
    if (MB.state.showMeasurements) {
      const txt = MB.measureText(layer);
      const tt = layer.getTooltip();
      if (tt) {
        tt.setContent(txt);
        if (layer.isTooltipOpen()) { layer.closeTooltip(); layer.openTooltip(); }
      } else {
        layer.bindTooltip(txt, { permanent: true, direction: 'center', className: 'mb-measure-label', interactive: false });
      }
    } else if (layer.getTooltip()) {
      layer.unbindTooltip();
    }
  };

  // Per-segment distance labels for distance measurements (shown when there are 2+ segments).
  function updateSegLabels(layer) {
    if (!layer.mb || layer.mb.type !== 'measure-line') return;
    const g = MB.groups[layer.mb.layerId];
    if (!g) return;
    layer._mbSeg = layer._mbSeg || [];
    let pts = layer.getLatLngs();
    if (pts.length && !MB.isLatLng(pts[0])) pts = pts[0];
    const needed = pts.length >= 3 ? pts.length - 1 : 0;
    while (layer._mbSeg.length > needed) { const mk = layer._mbSeg.pop(); g.removeLayer(mk); if (MB.map.hasLayer(mk)) MB.map.removeLayer(mk); }
    const color = layer.mb.style.color;
    for (let i = 0; i < needed; i++) {
      const a = pts[i], b = pts[i + 1];
      const mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
      const icon = L.divIcon({ className: 'mb-seg-label', html: `<span style="color:${color}">${MB.formatDistance(a.distanceTo(b))}</span>`, iconSize: null });
      if (!layer._mbSeg[i]) {
        const mk = L.marker(mid, { icon, interactive: false, pmIgnore: true, keyboard: false });
        layer._mbSeg[i] = mk;
        g.addLayer(mk);
      } else { layer._mbSeg[i].setLatLng(mid); layer._mbSeg[i].setIcon(icon); }
    }
  }
  function removeSegLabels(layer) {
    const g = layer.mb && MB.groups[layer.mb.layerId];
    (layer._mbSeg || []).forEach(mk => { if (g) g.removeLayer(mk); if (MB.map.hasLayer(mk)) MB.map.removeLayer(mk); });
    layer._mbSeg = [];
    removeLabel(layer);
  }

  /* ---------- on-map name labels ---------- */

  MB.labelTypes = ['marker', 'line', 'polygon', 'rectangle', 'circle', 'svg'];
  MB.defaultLabel = t => ({ show: false, v: (t === 'marker' || t === 'svg') ? 'top' : 'middle', h: 'center', size: 12, color: '#ffffff', bg: true });
  MB.getLabel = layer => Object.assign(MB.defaultLabel(layer.mb.type), layer.mb.label || {});

  function removeLabel(layer) {
    const mk = layer._mbLabel;
    if (!mk) return;
    const g = layer.mb && MB.groups[layer.mb.layerId];
    if (g) g.removeLayer(mk);
    if (MB.map.hasLayer(mk)) MB.map.removeLayer(mk);
    layer._mbLabel = null;
  }

  // Create / move / remove the name label of an object according to its label settings.
  MB.updateLabel = function (layer) {
    const m = layer.mb;
    if (!m || !MB.labelTypes.includes(m.type)) return;
    const lb = MB.getLabel(layer), g = MB.groups[m.layerId];
    if (!lb.show || !m.name || m.visible === false || !g) { removeLabel(layer); return; }
    // Anchor: a point on the object's bounding box (shapes) or a pixel offset around the icon (markers, fixed-size SVGs).
    let bounds = null, latlng, dx = 0, dy = 0;
    if (m.type === 'circle') bounds = layer.getLatLng().toBounds(layer.getRadius() * 2);
    else if (m.type === 'marker' || (m.type === 'svg' && !layer.setBounds)) bounds = null;
    else bounds = layer.getBounds();
    if (bounds) {
      const c = bounds.getCenter();
      latlng = L.latLng(lb.v === 'top' ? bounds.getNorth() : lb.v === 'bottom' ? bounds.getSouth() : c.lat,
        lb.h === 'left' ? bounds.getWest() : lb.h === 'right' ? bounds.getEast() : c.lng);
    } else {
      latlng = layer.getLatLng();
      let box = { l: -13, r: 13, t: -38, b: 0 }; // pin icon
      if (m.type === 'svg') {
        const lib = MB.state.svgLibrary[m.svg.svgId] || { aspect: 1 };
        const w = +m.svg.width || 48, h = w / (lib.aspect || 1);
        box = { l: -w / 2, r: w / 2, t: -h / 2, b: h / 2 };
      }
      dx = lb.h === 'left' ? box.l : lb.h === 'right' ? box.r : (box.l + box.r) / 2;
      dy = lb.v === 'top' ? box.t : lb.v === 'bottom' ? box.b : (box.t + box.b) / 2;
    }
    const tx = lb.h === 'left' ? 'calc(-100% - 5px)' : lb.h === 'right' ? '5px' : '-50%';
    const ty = lb.v === 'top' ? 'calc(-100% - 5px)' : lb.v === 'bottom' ? '5px' : '-50%';
    const css = `left:${dx}px;top:${dy}px;transform:translate(${tx},${ty});font-size:${+lb.size || 12}px;color:${lb.color};` +
      (lb.bg ? '' : 'background:transparent;border-color:transparent;text-shadow:0 0 3px #000,0 0 2px #000,0 0 1px #000;');
    const icon = L.divIcon({ className: 'mb-name-label-wrap', html: `<span class="mb-name-label" style="${css}">${MB.escapeHtml(m.name)}</span>`, iconSize: [0, 0] });
    if (layer._mbLabel) {
      layer._mbLabel.setLatLng(latlng);
      layer._mbLabel.setIcon(icon);
      if (!g.hasLayer(layer._mbLabel)) g.addLayer(layer._mbLabel);
    } else {
      layer._mbLabel = L.marker(latlng, { icon, interactive: false, keyboard: false, pmIgnore: true, zIndexOffset: 500 });
      g.addLayer(layer._mbLabel);
    }
  };

  MB.setLabel = function (layer, patch) {
    layer.mb.label = Object.assign(MB.getLabel(layer), patch || {});
    if (MB.ui && MB.ui.bindNameTip) MB.ui.bindNameTip(layer); else MB.updateLabel(layer);
    MB.commitDebounced('label');
  };
  MB.updateSegLabels = updateSegLabels;

  MB.refreshAllTooltips = function () {
    Object.keys(MB.featureLayers).forEach(id => MB.updateTooltip(MB.featureLayers[id]));
  };

  /* ---------- (de)serialization ---------- */

  function toArr(ll) {
    if (MB.isLatLng(ll)) return [+ll.lat.toFixed(7), +ll.lng.toFixed(7)];
    return ll.map(toArr);
  }
  function fromArr(a) {
    if (Array.isArray(a) && typeof a[0] === 'number') return L.latLng(a[0], a[1]);
    return a.map(fromArr);
  }
  function flattenLatLngs(ll) {
    if (MB.isLatLng(ll)) return [ll];
    return ll.reduce((acc, x) => acc.concat(flattenLatLngs(x)), []);
  }

  MB.serializeFeature = function (layer) {
    const m = layer.mb;
    const d = { id: m.id, layerId: m.layerId, type: m.type, name: m.name, style: MB.deepClone(m.style) };
    if (m.visible === false) d.visible = false;
    if (m.locked) d.locked = true;
    if (m.label) d.label = MB.deepClone(m.label);
    switch (m.type) {
      case 'marker': d.latlng = toArr(layer.getLatLng()); break;
      case 'text':
        d.latlng = toArr(layer.getLatLng());
        d.text = layer.pm && layer.pm.textArea ? layer.pm.getText() : (m.text || '');
        break;
      case 'line': case 'polygon': case 'rectangle': case 'measure-line': case 'measure-area': d.latlngs = toArr(layer.getLatLngs()); break;
      case 'circle': d.latlng = toArr(layer.getLatLng()); d.radius = layer.getRadius(); break;
      case 'svg': d.svg = MB.deepClone(m.svg); d.latlng = toArr(MB.svgCenter(layer)); break;
    }
    return d;
  };

  MB.restoreFeature = function (d) {
    const st = MB.toLeafletStyle(d.style);
    let layer = null;
    switch (d.type) {
      case 'marker': layer = L.marker(fromArr(d.latlng), { icon: MB.pinIcon((d.style || {}).color) }); break;
      case 'text': layer = L.marker(fromArr(d.latlng), { textMarker: true, text: d.text || '' }); break;
      case 'line': case 'measure-line': layer = L.polyline(fromArr(d.latlngs), st); break;
      case 'polygon': case 'measure-area': layer = L.polygon(fromArr(d.latlngs), st); break;
      case 'rectangle': layer = L.rectangle(L.latLngBounds(flattenLatLngs(fromArr(d.latlngs))), st); break;
      case 'circle': layer = L.circle(fromArr(d.latlng), Object.assign({ radius: d.radius }, st)); break;
      case 'svg': layer = MB.buildSvgLayer(fromArr(d.latlng), d.svg); break;
    }
    if (!layer) return null;
    return MB.addFeature(layer, d);
  };

  MB.clearAll = function () {
    MB.deselect();
    Object.keys(MB.featureLayers).forEach(id => MB.removeFeature(id, { silent: true }));
    Object.keys(MB.groups).forEach(id => { MB.map.removeLayer(MB.groups[id]); delete MB.groups[id]; });
    MB.state.layers = [];
    MB.state.activeLayerId = null;
  };
})(window.MB);
