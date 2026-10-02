/* GenGIS - the project file: format "gengis-project", schema 2.
 * Everything a project refers to is named by what it is, not by this build's internal names, so a file stays
 * readable as the app evolves: data sources by their service URL, the base map by its tile URL, live-traffic
 * sources by their site or receiver address. Definitions a project needs (custom tile providers, custom ArcGIS
 * layers) travel inside it, without API keys. Files written by earlier versions (schema 1, "map-builder") are
 * migrated on open; a file from a newer schema is opened as far as it is understood.
 *
 * Changing the format: bump SCHEMA, write the new shape in serializeProject(), and add a step to migrate() that
 * lifts the previous schema to the new one. Older steps stay, so any old file is lifted step by step.
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const FORMAT = 'gengis-project';
  const SCHEMA = 2;
  MB.PROJECT_FORMAT = FORMAT;
  MB.PROJECT_SCHEMA = SCHEMA;
  MB.PROJECT_EXT = '.gengis.json';

  const normUrl = u => String(u || '').trim().replace(/\/query.*$/i, '').replace(/\/+$/, '');
  const sameUrl = (a, b) => normUrl(a).toLowerCase() === normUrl(b).toLowerCase();
  const clone = v => MB.deepClone(v);

  /* ---------- what the app knows, by URI ---------- */

  // Dataset definitions: the built-in catalog plus this device's custom ArcGIS layers.
  function datasets() {
    const custom = ((MB.settings && MB.settings.dataServices) || []).map(c => ({ id: 'custom:' + c.id, name: c.name, url: c.url }));
    return (MB.dataCatalog || []).map(d => ({ id: d.id, name: d.name, url: d.url })).concat(custom);
  }
  const datasetByUrl = url => datasets().find(d => sameUrl(d.url, url));
  const datasetById = id => datasets().find(d => d.id === id);

  // Custom tile providers are told apart by tile URL (and WMS layers); the id is this device's.
  const sameProvider = (a, b) => sameUrl(a.url, b.url) && String(a.layers || '') === String(b.layers || '');
  const providerByUrl = (url, layers) => (MB.settings.providers || []).find(p => sameProvider(p, { url, layers }));

  function basemapOptions() {
    const out = {};
    Object.keys(MB.builtinKeyGroups || {}).forEach(g => (MB.builtinKeyGroups[g].options || []).forEach(o => { out[o.key] = MB.builtinOption(o.key, o.choices[0][0]); }));
    return out;
  }

  // The base map in use -> { name, tiles, layers?, options }
  function basemapRef(key) {
    const ref = { name: key, tiles: '', options: basemapOptions() };
    if (MB.basemaps[key]) { ref.name = MB.basemaps[key].name; ref.tiles = MB.basemaps[key].url; }
    else if (key && key.startsWith('custom:')) { const p = MB.getProvider(key.slice(7)); if (p) { ref.name = p.name; ref.tiles = p.url; if (p.layers) ref.layers = p.layers; } }
    return ref;
  }
  // A saved reference -> the key the app uses, or null when the base map is not known here.
  function basemapKey(ref) {
    if (!ref || !ref.tiles) return null;
    const builtin = Object.keys(MB.basemaps).find(k => sameUrl(MB.basemaps[k].url, ref.tiles));
    if (builtin) return builtin;
    const p = providerByUrl(ref.tiles, ref.layers);
    return p ? 'custom:' + p.id : null;
  }

  function trafficRef() {
    if (!MB.adsb) return undefined;
    const cf = MB.adsb.conf();
    return {
      sources: MB.adsb.sources.map(s => {
        const c = MB.adsb.srcConf(s.id);
        return s.kind === 'receiver' ? { kind: 'receiver', uri: c.url || '', enabled: !!c.on, refreshSeconds: c.interval }
          : { uri: s.site, enabled: !!c.on, refreshSeconds: c.interval };
      }),
      hiddenTypes: cf.off.slice(), labels: !!cf.labels, ground: !!cf.ground
    };
  }

  /* ---------- writing ---------- */

  MB.serializeProject = function (opts) {
    opts = opts || {};
    const s = MB.state;
    const p = {
      format: FORMAT, schema: SCHEMA, generator: { name: MB.APP.name, version: MB.APP.version },
      name: s.projectName,
      units: { system: s.units, shortDistances: s.shortUnit },
      editing: { showMeasurements: !!s.showMeasurements, continueDrawing: s.continueDrawing !== false, snapping: s.snapping !== false },
      layers: clone(s.layers), activeLayer: s.activeLayerId,
      features: Object.keys(MB.featureLayers).map(id => MB.serializeFeature(MB.featureLayers[id])),
      svgLibrary: clone(s.svgLibrary),
      dataSources: Object.keys(s.dataLayers || {}).map(id => {
        const d = datasetById(id), e = s.dataLayers[id];
        return d ? { uri: d.url, name: d.name, enabled: !!(e === true || (e && e.on)), hidden: (e && Array.isArray(e.off)) ? e.off.slice() : [] } : null;
      }).filter(Boolean)
    };
    // The view and the display state belong to a saved project, not to undo snapshots (objects and layers only).
    if (!opts.noView && MB.map) {
      const c = MB.map.getCenter();
      p.savedAt = new Date().toISOString();
      p.view = { lat: c.lat, lng: c.lng, zoom: MB.map.getZoom() };
      p.basemap = basemapRef(s.basemap);
      p.tileProviders = (MB.settings.providers || []).map(x => { const d = Object.assign({}, x); delete d.key; return d; }); // never the API key
      p.customDataSources = clone(MB.settings.dataServices || []);
      p.dataOpacity = MB.data ? MB.data.settings.opacity : 1;
      p.liveTraffic = trafficRef();
    }
    return p;
  };

  MB.isProject = p => !!p && typeof p === 'object' && (p.format === FORMAT || p.app === 'map-builder');

  /* ---------- reading ---------- */

  // Add the definitions a project carries when this device lacks them. Existing ones (which may hold an API key)
  // are kept. Returns true when the base map has to be rebuilt.
  function importDefinitions(p) {
    const st = MB.settings;
    let changed = false, basemap = false;
    (p.tileProviders || []).forEach(x => {
      if (!x || !x.url) return;
      if (providerByUrl(x.url, x.layers)) return;
      const d = clone(x); delete d.key;
      if (!d.id || MB.getProvider(d.id)) d.id = MB.uid();
      st.providers.push(d); changed = basemap = true;
    });
    (p.customDataSources || []).forEach(c => {
      if (!c || !c.url) return;
      st.dataServices = st.dataServices || [];
      if (st.dataServices.some(x => sameUrl(x.url, c.url))) return;
      const d = clone(c);
      if (!d.id || st.dataServices.some(x => x.id === d.id)) d.id = MB.uid();
      st.dataServices.push(d); changed = true;
    });
    const opts = (p.basemap && p.basemap.options) || {};
    Object.keys(opts).forEach(k => { if (st.keys[k] !== opts[k]) { st.keys[k] = opts[k]; changed = basemap = true; } });
    if (changed) MB.saveSettings(); // also announces 'providers': the basemap list and custom datasets follow
    return basemap;
  }

  function applyTraffic(t) {
    if (!MB.adsb || !t || typeof t !== 'object') return;
    const cf = MB.adsb.conf();
    const mine = cf.sources.dump1090 && cf.sources.dump1090.url; // a receiver address set on this device stays
    (t.sources || []).forEach(src => {
      if (!src) return;
      const def = src.kind === 'receiver' ? MB.adsb.sources.find(s => s.kind === 'receiver') : MB.adsb.sources.find(s => s.site && sameUrl(s.site, src.uri));
      if (!def) return;
      const c = MB.adsb.srcConf(def.id);
      c.on = !!src.enabled;
      if (def.intervals.includes(+src.refreshSeconds)) c.interval = +src.refreshSeconds;
      if (def.kind === 'receiver' && !mine && src.uri) c.url = String(src.uri);
    });
    if (Array.isArray(t.hiddenTypes)) cf.off = t.hiddenTypes.filter(k => MB.adsb.types[k]);
    if (typeof t.labels === 'boolean') cf.labels = t.labels;
    if (typeof t.ground === 'boolean') cf.ground = t.ground;
    MB.saveSettings();
    MB.adsb.applyConf();
  }

  MB.loadProject = function (p, opts) {
    opts = opts || {};
    p = migrate(p || {});
    MB.clearAll();
    const units = p.units || {}, ed = p.editing || {};
    Object.assign(MB.state, {
      projectName: p.name || 'Untitled map',
      units: MB.unitSystems[units.system] ? units.system : 'metric',
      shortUnit: units.shortDistances === 'm' ? 'm' : 'ft',
      showMeasurements: !!ed.showMeasurements,
      continueDrawing: ed.continueDrawing !== false,
      snapping: ed.snapping !== false,
      svgLibrary: p.svgLibrary || {},
      dataLayers: {}
    });
    const rebuild = importDefinitions(p); // before datasets and the base map: the project may carry what they refer to
    (p.dataSources || []).forEach(e => {
      const d = e && datasetByUrl(e.uri);
      if (d) MB.state.dataLayers[d.id] = { on: !!e.enabled, off: Array.isArray(e.hidden) ? e.hidden.slice() : [] };
    });
    (p.layers || []).forEach(l => MB.createLayer(l.name, { id: l.id, visible: l.visible, locked: l.locked, activate: false }));
    if (!MB.state.layers.length) MB.createLayer('Layer 1');
    MB.state.activeLayerId = MB.getLayer(p.activeLayer) ? p.activeLayer : MB.state.layers[MB.state.layers.length - 1].id;
    (p.features || []).forEach(f => { try { MB.restoreFeature(f); } catch (e) { console.warn('Could not restore feature', f, e); } });
    MB.applyZOrder();
    const key = basemapKey(p.basemap);
    if (key && MB.map && (rebuild || key !== MB.state.basemap)) MB.setBasemap(key);
    if (MB.data && typeof p.dataOpacity === 'number' && isFinite(p.dataOpacity)) {
      // only the opacity: the other data settings are device preferences, and before start-up the module holds defaults
      const opacity = Math.min(1, Math.max(0.1, p.dataOpacity));
      MB.data.settings.opacity = opacity;
      MB.settings.data = Object.assign({}, MB.settings.data, { opacity });
      MB.saveSettings();
      MB.data.applyOpacity();
    }
    if (p.liveTraffic) applyTraffic(p.liveTraffic);
    if (!opts.keepView && p.view && MB.map) MB.map.setView([p.view.lat, p.view.lng], p.view.zoom);
    MB.emit('units', MB.state.units);
    MB.emit('layers');
    MB.emit('features');
    MB.emit('project');
    if (!opts.keepHistory) MB.resetHistory();
  };

  MB.newProject = function () {
    MB.loadProject({ format: FORMAT, schema: SCHEMA, name: 'Untitled map', units: { system: MB.state.units, shortDistances: MB.state.shortUnit },
      layers: [{ id: MB.uid(), name: 'Layer 1', visible: true, locked: false }] }, { keepView: true });
  };

  /* ---------- migration ---------- */

  function migrate(p) {
    if (p.format === FORMAT) {
      if (+p.schema > SCHEMA) console.warn(`Project schema ${p.schema} is newer than this version understands (${SCHEMA}); opening what it can.`);
      return p;
    }
    if (p.app === 'map-builder') return fromSchema1(p);
    throw new Error('Not a GenGIS project');
  }

  // Schema 1 ("map-builder", through GenGIS 0.2.0) named things by this build's internal keys and kept the
  // display state under `display`.
  function fromSchema1(v) {
    const d = v.display || {};
    const out = {
      format: FORMAT, schema: SCHEMA, generator: { name: v.appName || 'GenGIS', version: v.appVersion || '' },
      name: v.projectName, units: { system: v.units, shortDistances: v.shortUnit },
      editing: { showMeasurements: !!v.showMeasurements, continueDrawing: v.continueDrawing !== false, snapping: v.snapping !== false },
      layers: v.layers || [], activeLayer: v.activeLayerId, features: v.features || [], svgLibrary: v.svgLibrary || {},
      view: v.view, tileProviders: d.providers || [], customDataSources: d.dataServices || []
    };
    const customUrl = id => { const c = out.customDataSources.find(x => 'custom:' + x.id === id); return c ? c.url : null; };
    out.dataSources = Object.keys(v.dataLayers || {}).map(id => {
      const e = v.dataLayers[id], def = datasetById(id);
      const url = def ? def.url : customUrl(id);
      return url ? { uri: url, name: def ? def.name : id, enabled: !!(e === true || (e && e.on)), hidden: (e && Array.isArray(e.off)) ? e.off : [] } : null;
    }).filter(Boolean);
    if (v.basemap) {
      let ref = null;
      if (MB.basemaps[v.basemap]) ref = { name: MB.basemaps[v.basemap].name, tiles: MB.basemaps[v.basemap].url };
      else if (v.basemap.startsWith('custom:')) {
        const id = v.basemap.slice(7), p = out.tileProviders.find(x => x.id === id) || MB.getProvider(id);
        if (p) { ref = { name: p.name, tiles: p.url }; if (p.layers) ref.layers = p.layers; }
      }
      if (ref) { ref.options = d.basemapOptions || {}; out.basemap = ref; }
    }
    if (typeof d.dataOpacity === 'number') out.dataOpacity = d.dataOpacity;
    if (d.adsb && MB.adsb) {
      const srcs = d.adsb.sources || {};
      out.liveTraffic = {
        sources: MB.adsb.sources.map(s => { const c = srcs[s.id] || {}; return s.kind === 'receiver' ? { kind: 'receiver', uri: c.url || '', enabled: !!c.on, refreshSeconds: c.interval } : { uri: s.site, enabled: !!c.on, refreshSeconds: c.interval }; }),
        hiddenTypes: d.adsb.off || [], labels: d.adsb.labels !== false, ground: d.adsb.ground !== false
      };
    }
    return out;
  }
})(window.MB);
