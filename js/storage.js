/* GenGIS - storage: autosave, project files, GeoJSON import/export */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  // Saving in the background lives in projectstore.js; these are the names the rest of the app calls.
  MB.autosave = () => MB.projects.schedule();
  MB.saveNow = () => MB.projects.saveNow(); // the page is being hidden or closed
  MB.loadAutosave = () => MB.projects.loadMirror();
  MB.clearAutosave = () => MB.projects.removeCurrent();

  MB.saveToFile = function () {
    const p = MB.serializeProject();
    const name = (p.name || 'map').replace(/[^\w\- ]+/g, '_').trim() || 'map';
    MB.download(name + MB.PROJECT_EXT, JSON.stringify(p, null, 1));
    MB.toast('Project saved');
  };

  MB.openFile = function (file) {
    return file.text().then(async txt => {
      const p = JSON.parse(txt);
      if (MB.isProject(p)) { await MB.projects.beforeOpen(p); MB.loadProject(p); MB.toast('Project loaded'); return; }
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
