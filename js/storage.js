/* GenGIS - storage: autosave, project files, GeoJSON import/export */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  // Saving in the background lives in projectstore.js; these are the names the rest of the app calls.
  MB.autosave = kind => MB.projects.schedule(kind); // kind 'view': only the map view changed
  MB.saveNow = () => MB.projects.saveNow(); // the page is being hidden or closed
  MB.loadAutosave = () => MB.projects.loadMirror();
  MB.clearAutosave = () => MB.projects.removeCurrent();

  MB.saveToFile = function () {
    if (MB.desktopFiles && MB.desktopFiles.available) return MB.desktopFiles.save(); // the desktop app writes the file itself
    if (MB.browserFiles && MB.browserFiles.available) return MB.browserFiles.save(); // so do Chrome and Edge (a file picked once)
    const p = MB.serializeProject();
    const name = (p.name || 'map').replace(/[^\w\- ]+/g, '_').trim() || 'map';
    MB.download(name + MB.PROJECT_EXT, JSON.stringify(p, null, 1));
    MB.projects.markFileBacked(); // saved explicitly: not a draft any more
    MB.toast('Project saved');
  };

  MB.openFile = function (file) {
    return file.text().then(txt => MB.openText(txt, file.name));
  };

  // A project or GeoJSON file's text (from a file picker, or the desktop app's own dialogs). Resolves 'project' or
  // 'geojson' for what was opened, or null.
  MB.openText = async function (txt, name) {
    try {
      const p = JSON.parse(txt);
      if (MB.isProject(p)) { if (!(await MB.projects.beforeOpen(p))) return null; MB.loadProject(p); MB.projects.markFileBacked(); MB.toast('Project loaded'); return 'project'; }
      if (p && (p.type === 'FeatureCollection' || p.type === 'Feature')) { MB.importGeoJSON(p, name); return 'geojson'; }
      throw new Error('Unrecognized file');
    } catch (e) { MB.toast('Could not open file: ' + e.message); return null; }
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

  MB.importGeoJSON = (gj, sourceName) => MB.batch(() => importGeoJSON(gj, sourceName)); // one redraw at the end
  function importGeoJSON(gj, sourceName) {
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
            MB.restoreFeature(Object.assign(base, { type: p.type === 'measure-line' || p.type === 'ink' ? p.type : 'line', latlngs: c.map(pt => [pt[1], pt[0]]) })); n++; break;
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
  }

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

  /* ---------- image library: SVGs, and pictures (PNG, JPEG, WebP, GIF) ---------- */

  const RASTER_MAX = 2048; // px: a larger picture is scaled down on adding (it lives in the project file)
  MB.isSvgFile = f => /\.svg$/i.test(f.name) || f.type === 'image/svg+xml';
  MB.isRasterFile = f => /^image\/(png|jpeg|webp|gif)$/.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name);
  const readDataUrl = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });

  // A picture for the library: at most RASTER_MAX px across, as JPEG (WebP, or PNG where the browser cannot write
  // WebP, when it has transparency), unless the original file is already smaller (a GIF keeps its animation then).
  async function rasterEntry(f) {
    const url = URL.createObjectURL(f);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(f.name + ' could not be read as an image')); i.src = url; });
      const w0 = img.naturalWidth, h0 = img.naturalHeight;
      if (!w0 || !h0) throw new Error(f.name + ' has no size');
      const k = Math.min(1, RASTER_MAX / Math.max(w0, h0)), w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
      let alpha = false;
      if (!/jpe?g$/i.test(f.type || f.name)) { const d = ctx.getImageData(0, 0, w, h).data; for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { alpha = true; break; } }
      let dataUrl = alpha ? cv.toDataURL('image/webp', 0.9) : cv.toDataURL('image/jpeg', 0.85);
      if (alpha && !dataUrl.startsWith('data:image/webp')) dataUrl = cv.toDataURL('image/png');
      if (k === 1 && f.size < 1048576 && f.size * 4 / 3 < dataUrl.length) dataUrl = await readDataUrl(f); // a small original, and the smaller
      return { name: f.name, dataUrl, aspect: w0 / h0, width: w0, height: h0, kind: 'raster' };
    } finally { URL.revokeObjectURL(url); }
  }

  MB.addImageFiles = function (files) {
    const list = Array.from(files || []).filter(f => MB.isSvgFile(f) || MB.isRasterFile(f));
    if (!list.length) { MB.toast('Please choose SVG, PNG, JPEG, WebP or GIF files'); return Promise.resolve([]); }
    return Promise.all(list.map(f => (MB.isSvgFile(f) ? f.text().then(txt => {
      if (!/<svg[\s>]/i.test(txt)) throw new Error(f.name + ' is not an SVG');
      const info = MB.svgInfo(txt);
      return { name: f.name, dataUrl: MB.svgDataUrl(txt), aspect: info.aspect, width: info.width, height: info.height };
    }) : rasterEntry(f)).then(entry => {
      const id = MB.uid();
      MB.state.svgLibrary[id] = Object.assign({ id }, entry);
      return id;
    }).catch(e => { MB.toast(e.message); return null; }))).then(ids => {
      ids = ids.filter(Boolean);
      if (ids.length) { MB.emit('svglibrary'); MB.commit('add image'); MB.toast(ids.length + ' image' + (ids.length > 1 ? 's' : '') + ' added'); }
      return ids;
    });
  };
  MB.addSvgFiles = MB.addImageFiles; // its earlier name

  MB.removeSvg = function (id) {
    const used = Object.keys(MB.featureLayers).filter(fid => { const m = MB.featureLayers[fid].mb; return m.type === 'svg' && m.svg.svgId === id; });
    if (used.length && !confirm('This image is placed ' + used.length + ' time(s) on the map. Remove it and those placements?')) return;
    used.forEach(fid => MB.removeFeature(fid, { silent: true }));
    delete MB.state.svgLibrary[id];
    MB.emit('svglibrary'); MB.emit('features');
    MB.commit('remove svg');
  };
})(window.MB);
