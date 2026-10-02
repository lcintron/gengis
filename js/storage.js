/* GenGIS - storage: autosave, project files, GeoJSON import/export */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const KEY = 'map-builder.project.v1';

  MB.autosave = MB.debounce(function () {
    try {
      localStorage.setItem(KEY, JSON.stringify(MB.serializeProject()));
      MB.emit('saved');
    } catch (e) {
      console.warn('Autosave failed', e);
      MB.toast('Autosave failed (storage full?). Save your project to a file.');
    }
  }, 600);

  // Synchronous save, used when the page is being hidden/closed so a pending debounced save is not lost.
  MB.saveNow = function () {
    try { localStorage.setItem(KEY, JSON.stringify(MB.serializeProject())); } catch (e) { /* ignore */ }
  };

  MB.loadAutosave = function () {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return false;
      const p = JSON.parse(raw);
      if (!p || p.app !== 'map-builder') return false;
      MB.loadProject(p);
      return true;
    } catch (e) { console.warn('Could not load autosave', e); return false; }
  };

  MB.clearAutosave = function () { localStorage.removeItem(KEY); };

  /* ---------- display state: the part of a project that is not an object ---------- */
  // Everything else needed to open the project the same way on another device: data opacity, the custom tile
  // providers and ArcGIS layers the project can refer to, basemap options, and the live-traffic sources and
  // display options. API keys and device preferences (geocoder, cache policy, tooltip delay) are not part of it.
  MB.displayState = function () {
    const st = MB.settings || {};
    const optionKeys = [].concat.apply([], Object.keys(MB.builtinKeyGroups || {}).map(g => (MB.builtinKeyGroups[g].options || []).map(o => o.key)));
    const basemapOptions = {};
    optionKeys.forEach(k => { if (st.keys && st.keys[k]) basemapOptions[k] = st.keys[k]; });
    return {
      dataOpacity: MB.data ? MB.data.settings.opacity : 1,
      basemapOptions,
      providers: (st.providers || []).map(p => { const c = Object.assign({}, p); delete c.key; return c; }),
      dataServices: MB.deepClone(st.dataServices || []),
      adsb: MB.adsb ? MB.deepClone(MB.adsb.conf()) : undefined
    };
  };

  MB.applyDisplayState = function (d) {
    if (!d || !MB.settings) return;
    const st = MB.settings;
    let changed = false;
    // definitions the project refers to are added by id; one already on this device (which may hold an API key) is kept
    (d.providers || []).forEach(p => { if (p && p.id && !st.providers.some(x => x.id === p.id)) { st.providers.push(MB.deepClone(p)); changed = true; } });
    (d.dataServices || []).forEach(c => { st.dataServices = st.dataServices || []; if (c && c.id && !st.dataServices.some(x => x.id === c.id)) { st.dataServices.push(MB.deepClone(c)); changed = true; } });
    Object.keys(d.basemapOptions || {}).forEach(k => { if (st.keys[k] !== d.basemapOptions[k]) { st.keys[k] = d.basemapOptions[k]; changed = true; } });
    if (d.adsb && typeof d.adsb === 'object') {
      const mine = st.adsb && st.adsb.sources && st.adsb.sources.dump1090 && st.adsb.sources.dump1090.url;
      st.adsb = MB.deepClone(d.adsb);
      if (mine) { st.adsb.sources = st.adsb.sources || {}; st.adsb.sources.dump1090 = Object.assign({}, st.adsb.sources.dump1090, { url: mine }); } // a receiver address set here stays
      changed = true;
    }
    if (changed) MB.saveSettings(); // also announces 'providers': the basemap list and custom datasets follow
    if (MB.data && typeof d.dataOpacity === 'number' && isFinite(d.dataOpacity)) {
      MB.data.settings.opacity = Math.min(1, Math.max(0.1, d.dataOpacity));
      MB.data.applyOpacity();
      MB.data.saveSettings();
    }
    if (MB.adsb && d.adsb) MB.adsb.applyConf();
  };

  MB.saveToFile = function () {
    const p = MB.serializeProject();
    const name = (p.projectName || 'map').replace(/[^\w\- ]+/g, '_').trim() || 'map';
    MB.download(name + '.mapproject.json', JSON.stringify(p, null, 1));
    MB.toast('Project saved');
  };

  MB.openFile = function (file) {
    return file.text().then(txt => {
      const p = JSON.parse(txt);
      if (p && p.app === 'map-builder') { MB.loadProject(p); MB.toast('Project loaded'); return; }
      if (p && (p.type === 'FeatureCollection' || p.type === 'Feature')) { MB.importGeoJSON(p, file.name); return; }
      throw new Error('Unrecognized file');
    }).catch(e => MB.toast('Could not open file: ' + e.message));
  };

  /* ---------- GeoJSON ---------- */

  MB.exportGeoJSON = function () {
    const features = [];
    Object.keys(MB.featureLayers).forEach(id => {
      const l = MB.featureLayers[id], m = l.mb;
      const lay = MB.getLayer(m.layerId);
      const props = { id: m.id, name: m.name || '', layer: lay ? lay.name : '', type: m.type, style: m.style };
      let geometry = null;
      switch (m.type) {
        case 'marker': case 'text': case 'svg': {
          const ll = MB.svgCenter(l);
          geometry = { type: 'Point', coordinates: [ll.lng, ll.lat] };
          if (m.type === 'text') props.text = l.pm ? l.pm.getText() : m.text;
          if (m.type === 'svg') props.svg = m.svg;
          break;
        }
        case 'circle': {
          const ll = l.getLatLng();
          geometry = { type: 'Point', coordinates: [ll.lng, ll.lat] };
          props.radius = l.getRadius();
          break;
        }
        default: geometry = l.toGeoJSON().geometry;
      }
      if (geometry) features.push({ type: 'Feature', properties: props, geometry });
    });
    const fc = { type: 'FeatureCollection', features };
    const name = (MB.state.projectName || 'map').replace(/[^\w\- ]+/g, '_').trim() || 'map';
    MB.download(name + '.geojson', JSON.stringify(fc, null, 1), 'application/geo+json');
    MB.toast('GeoJSON exported (' + features.length + ' features)');
  };

  MB.importGeoJSON = function (gj, sourceName) {
    const feats = gj.type === 'Feature' ? [gj] : (gj.features || []);
    const layerName = (sourceName || 'Imported').replace(/\.(geo)?json$/i, '');
    const layer = MB.createLayer(layerName);
    let n = 0;
    const byLayer = {};
    feats.forEach(f => {
      if (!f || !f.geometry) return;
      const p = f.properties || {};
      let targetId = layer.id;
      if (p.layer) {
        if (!byLayer[p.layer]) byLayer[p.layer] = MB.createLayer(p.layer, { activate: false }).id;
        targetId = byLayer[p.layer];
      }
      const style = p.style && typeof p.style === 'object' ? p.style : Object.assign({}, MB.currentStyle, styleFromSimpleStyle(p));
      const base = { layerId: targetId, name: p.name || p.title || '', style };
      const g = f.geometry, c = g.coordinates;
      try {
        switch (g.type) {
          case 'Point':
            if (p.radius) MB.restoreFeature(Object.assign(base, { type: 'circle', latlng: [c[1], c[0]], radius: +p.radius }));
            else if (p.type === 'text' && p.text) MB.restoreFeature(Object.assign(base, { type: 'text', latlng: [c[1], c[0]], text: p.text }));
            else if (p.type === 'svg' && p.svg && MB.state.svgLibrary[p.svg.svgId]) MB.restoreFeature(Object.assign(base, { type: 'svg', latlng: [c[1], c[0]], svg: p.svg }));
            else MB.restoreFeature(Object.assign(base, { type: 'marker', latlng: [c[1], c[0]] }));
            n++; break;
          case 'MultiPoint':
            c.forEach(pt => { MB.restoreFeature(Object.assign({}, base, { type: 'marker', latlng: [pt[1], pt[0]] })); n++; }); break;
          case 'LineString':
            MB.restoreFeature(Object.assign(base, { type: p.type === 'measure-line' ? 'measure-line' : 'line', latlngs: c.map(pt => [pt[1], pt[0]]) })); n++; break;
          case 'MultiLineString':
            MB.restoreFeature(Object.assign(base, { type: 'line', latlngs: c.map(ls => ls.map(pt => [pt[1], pt[0]])) })); n++; break;
          case 'Polygon':
            MB.restoreFeature(Object.assign(base, { type: p.type === 'rectangle' ? 'rectangle' : (p.type === 'measure-area' ? 'measure-area' : 'polygon'), latlngs: c.map(r => r.map(pt => [pt[1], pt[0]])) })); n++; break;
          case 'MultiPolygon':
            MB.restoreFeature(Object.assign(base, { type: 'polygon', latlngs: c.map(pg => pg.map(r => r.map(pt => [pt[1], pt[0]]))) })); n++; break;
        }
      } catch (e) { console.warn('Skipped feature', f, e); }
    });
    MB.applyZOrder();
    MB.emit('layers'); MB.emit('features');
    MB.commit('import geojson');
    MB.toast('Imported ' + n + ' features into "' + layerName + '"');
    const g = MB.groups[layer.id];
    if (g && g.getBounds().isValid()) MB.map.fitBounds(g.getBounds().pad(0.2));
  };

  // Support the common "simplestyle" GeoJSON properties (stroke, fill, ...).
  function styleFromSimpleStyle(p) {
    const s = {};
    if (p.stroke) s.color = p.stroke;
    if (p['stroke-width'] != null) s.weight = +p['stroke-width'];
    if (p['stroke-opacity'] != null) s.opacity = +p['stroke-opacity'];
    if (p.fill) s.fillColor = p.fill;
    if (p['fill-opacity'] != null) s.fillOpacity = +p['fill-opacity'];
    if (p['marker-color']) s.color = p['marker-color'];
    return s;
  }

  /* ---------- SVG library ---------- */

  MB.addSvgFiles = function (files) {
    const list = Array.from(files || []).filter(f => /\.svg$/i.test(f.name) || f.type === 'image/svg+xml');
    if (!list.length) { MB.toast('Please choose .svg files'); return Promise.resolve([]); }
    return Promise.all(list.map(f => f.text().then(txt => {
      if (!/<svg[\s>]/i.test(txt)) throw new Error(f.name + ' is not an SVG');
      const info = MB.svgInfo(txt);
      const id = MB.uid();
      MB.state.svgLibrary[id] = { id, name: f.name, dataUrl: MB.svgDataUrl(txt), aspect: info.aspect, width: info.width, height: info.height };
      return id;
    }).catch(e => { MB.toast(e.message); return null; }))).then(ids => {
      ids = ids.filter(Boolean);
      if (ids.length) { MB.emit('svglibrary'); MB.commit('add svg'); MB.toast(ids.length + ' SVG' + (ids.length > 1 ? 's' : '') + ' added'); }
      return ids;
    });
  };

  MB.removeSvg = function (id) {
    const used = Object.keys(MB.featureLayers).filter(fid => { const m = MB.featureLayers[fid].mb; return m.type === 'svg' && m.svg.svgId === id; });
    if (used.length && !confirm('This SVG is placed ' + used.length + ' time(s) on the map. Remove it and those placements?')) return;
    used.forEach(fid => MB.removeFeature(fid, { silent: true }));
    delete MB.state.svgLibrary[id];
    MB.emit('svglibrary'); MB.emit('features');
    MB.commit('remove svg');
  };
})(window.MB);
