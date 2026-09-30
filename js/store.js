/* GenGIS - state, layers, history, event bus */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  MB.state = {
    projectName: 'Untitled map',
    units: 'metric',        // metric | imperial | nautical
    shortUnit: 'ft',        // nautical only: unit for distances under 0.1 NM (ft | m)
    basemap: 'osm',
    showMeasurements: false,
    continueDrawing: true,
    snapping: true,
    layers: [],           // [{id, name, visible, locked}] bottom -> top
    activeLayerId: null,
    svgLibrary: {}        // id -> {id, name, dataUrl, aspect}
  };

  MB.groups = {};         // layerId -> L.FeatureGroup
  MB.featureLayers = {};  // featureId -> leaflet layer (with .mb metadata)
  MB.selected = null;

  /* ---------- event bus ---------- */
  const listeners = {};
  MB.on = function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); };
  MB.emit = function (ev, data) { (listeners[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); };

  /* ---------- basemaps (no API keys required) ---------- */
  MB.basemaps = {
    osm: { name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
    hot: { name: 'OSM Humanitarian', url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, Tiles style by <a href="https://www.hotosm.org/">HOT</a>' },
    topo: { name: 'OpenTopoMap', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', maxZoom: 17,
      attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' },
    cartoLight: { name: 'CARTO Light (Positron)', url: 'https://{s}.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png', maxZoom: 20, keyGroup: 'carto',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' },
    cartoDark: { name: 'CARTO Dark (Dark Matter)', url: 'https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png', maxZoom: 20, keyGroup: 'carto',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' },
    cartoVoyager: { name: 'CARTO Voyager', url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', maxZoom: 20, keyGroup: 'carto',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' },
    esriSat: { name: 'Esri World Imagery', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZoom: 19,
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community' },
    cyclosm: { name: 'CyclOSM', url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', maxZoom: 20,
      attribution: '<a href="https://github.com/cyclosm/cyclosm-cartocss-style/releases">CyclOSM</a> | &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }
  };

  // Built-in providers that need (free) API keys. The key is entered once in the Map & search APIs dialog.
  MB.builtinKeyGroups = {
    carto: { name: 'CARTO Basemaps', param: 'key', signup: 'https://carto.com/basemaps/apikey/',
      note: 'Free key, no account needed. Required since Sept 2026; without it tiles are watermarked "API KEY REQUIRED".',
      options: [{ key: 'cartoLabels', label: 'Labels', choices: [['all', 'With labels'], ['nolabels', 'No labels'], ['labels_under', 'Labels under roads (Voyager only)']] }] }
  };
  MB.builtinOption = (k, dflt) => (MB.settings && MB.settings.keys && MB.settings.keys[k]) || dflt;
  MB.builtinKey = group => (MB.settings && MB.settings.keys && MB.settings.keys[group]) || '';

  MB.buildBaseLayer = function (key) {
    if (key && key.startsWith('custom:')) {
      const p = MB.getProvider && MB.getProvider(key.slice(7));
      if (!p) return null;
      const url = p.url.replace(/\{key\}/g, encodeURIComponent(p.key || ''));
      const common = { attribution: p.attribution || '', maxZoom: +p.maxZoom || 19, subdomains: p.subdomains || 'abc', crossOrigin: true, keepBuffer: 4, updateInterval: 120 };
      if (p.type === 'wms') {
        return L.tileLayer.wms(url, Object.assign(common, { layers: p.layers || '', format: p.format || 'image/png', transparent: false, version: p.version || '1.1.1' }));
      }
      if (+p.tileSize === 512) Object.assign(common, { tileSize: 512, zoomOffset: -1 });
      return L.tileLayer(url, common);
    }
    const def = MB.basemaps[key];
    if (!def) return null;
    let url = def.url;
    if (def.keyGroup === 'carto') {
      const v = MB.builtinOption('cartoLabels', 'all');
      if (v === 'nolabels') url = url.replace('/light_all/', '/light_nolabels/').replace('/dark_all/', '/dark_nolabels/').replace('/voyager/', '/voyager_nolabels/');
      else if (v === 'labels_under') url = url.replace('/voyager/', '/voyager_labels_under/');
    }
    if (def.keyGroup) {
      const k = MB.builtinKey(def.keyGroup), grp = MB.builtinKeyGroups[def.keyGroup];
      if (k && grp) url += (url.includes('?') ? '&' : '?') + grp.param + '=' + encodeURIComponent(k);
    }
    // keepBuffer keeps a ring of already-loaded tiles around the view so small pans never reload; updateInterval
    // makes new tiles appear sooner while dragging.
    return L.tileLayer(url, { maxZoom: def.maxZoom, attribution: def.attribution, crossOrigin: true, keepBuffer: 4, updateInterval: 120 });
  };

  MB.setBasemap = function (key) {
    let layer = MB.buildBaseLayer(key);
    if (!layer) { key = 'osm'; layer = MB.buildBaseLayer(key); }
    if (MB.baseLayer) MB.map.removeLayer(MB.baseLayer);
    MB.baseLayer = layer;
    MB.baseLayer.addTo(MB.map);
    MB.baseLayer.bringToBack();
    MB.state.basemap = key;
    MB.emit('basemap', key);
    MB.autosave();
  };

  /* ---------- layers ---------- */

  MB.getLayer = id => MB.state.layers.find(l => l.id === id);

  MB.activeLayer = function () {
    return MB.getLayer(MB.state.activeLayerId) || MB.state.layers[MB.state.layers.length - 1] || null;
  };

  MB.createLayer = function (name, opts) {
    opts = opts || {};
    const layer = {
      id: opts.id || MB.uid(),
      name: name || ('Layer ' + (MB.state.layers.length + 1)),
      visible: opts.visible !== false,
      locked: !!opts.locked
    };
    MB.state.layers.push(layer);
    const g = L.featureGroup();
    g.options.pmIgnore = true;
    MB.groups[layer.id] = g;
    if (layer.visible) g.addTo(MB.map);
    if (opts.activate !== false) MB.state.activeLayerId = layer.id;
    MB.applyZOrder();
    MB.emit('layers');
    return layer;
  };

  MB.removeLayer = function (id) {
    const layer = MB.getLayer(id);
    if (!layer) return;
    const g = MB.groups[id];
    Object.keys(MB.featureLayers).forEach(fid => {
      const f = MB.featureLayers[fid];
      if (f.mb.layerId === id) MB.removeFeature(fid, { silent: true });
    });
    if (g) { MB.map.removeLayer(g); delete MB.groups[id]; }
    MB.state.layers = MB.state.layers.filter(l => l.id !== id);
    if (!MB.state.layers.length) MB.createLayer('Layer 1');
    if (MB.state.activeLayerId === id) MB.state.activeLayerId = MB.state.layers[MB.state.layers.length - 1].id;
    MB.emit('layers');
    MB.emit('features');
  };

  MB.renameLayer = function (id, name) {
    const layer = MB.getLayer(id);
    if (!layer || !name) return;
    layer.name = name;
    MB.emit('layers');
  };

  MB.setLayerVisible = function (id, visible) {
    const layer = MB.getLayer(id), g = MB.groups[id];
    if (!layer) return;
    layer.visible = !!visible;
    if (visible) { g.addTo(MB.map); MB.applyZOrder(); }
    else {
      if (MB.selected && MB.selected.mb.layerId === id) MB.deselect();
      MB.map.removeLayer(g);
    }
    MB.emit('layers');
  };

  MB.setLayerLocked = function (id, locked) {
    const layer = MB.getLayer(id);
    if (!layer) return;
    layer.locked = !!locked;
    if (locked && MB.selected && MB.selected.mb.layerId === id) MB.deselect();
    MB.emit('layers');
  };

  MB.setActiveLayer = function (id) {
    if (!MB.getLayer(id)) return;
    MB.state.activeLayerId = id;
    MB.emit('layers');
  };

  MB.moveLayer = function (id, delta) {
    const arr = MB.state.layers;
    const i = arr.findIndex(l => l.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= arr.length) return;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    MB.applyZOrder();
    MB.emit('layers');
  };

  MB.applyZOrder = function () {
    MB.state.layers.forEach(l => {
      const g = MB.groups[l.id];
      if (g && MB.map.hasLayer(g)) g.bringToFront();
    });
  };

  MB.layerFeatureCount = function (id) {
    let n = 0;
    Object.keys(MB.featureLayers).forEach(fid => { if (MB.featureLayers[fid].mb.layerId === id) n++; });
    return n;
  };

  /* ---------- units ---------- */
  MB.setUnits = function (units) {
    MB.state.units = MB.unitSystems[units] ? units : 'metric';
    MB.emit('units', MB.state.units);
    MB.autosave();
  };
  MB.setShortUnit = function (u) {
    MB.state.shortUnit = u === 'm' ? 'm' : 'ft';
    MB.emit('units', MB.state.units);
    MB.autosave();
  };

  /* ---------- history (undo / redo) ---------- */
  const history = { undo: [], redo: [], max: 80 };
  MB.history = history;

  MB.commit = function (label) {
    const json = JSON.stringify(MB.serializeProject({ noView: true }));
    const top = history.undo[history.undo.length - 1];
    if (top && top.json === json) return;
    history.undo.push({ json, label: label || '' });
    if (history.undo.length > history.max) history.undo.shift();
    history.redo.length = 0;
    MB.emit('history');
    MB.autosave();
  };

  MB.resetHistory = function () {
    history.undo.length = 0; history.redo.length = 0;
    MB.commit('initial');
  };

  MB.canUndo = () => history.undo.length > 1;
  MB.canRedo = () => history.redo.length > 0;

  MB.undo = function () {
    if (!MB.canUndo()) return;
    history.redo.push(history.undo.pop());
    const snap = history.undo[history.undo.length - 1];
    MB.loadProject(JSON.parse(snap.json), { keepView: true, keepHistory: true });
    MB.emit('history');
    MB.autosave();
  };

  MB.redo = function () {
    if (!MB.canRedo()) return;
    const snap = history.redo.pop();
    history.undo.push(snap);
    MB.loadProject(JSON.parse(snap.json), { keepView: true, keepHistory: true });
    MB.emit('history');
    MB.autosave();
  };
})(window.MB);
