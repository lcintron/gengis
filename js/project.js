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

  const clone = v => MB.deepClone(v);

  // Credentials never leave the device. An API key inside a URL (a query parameter or user:password@) is replaced
  // by the {key} placeholder, which the app fills from the key stored on the device; the recipient enters their own.
  const SECRET_PARAM = /^(api[-_]?key|key|access[-_]?token|token|auth|authorization|signature|sig|secret|password|pass|app[-_]?id|client[-_]?secret)$/i;
  const decoded = v => { try { return decodeURIComponent(v); } catch (e) { return v; } }; // names may be percent-encoded
  function sanitizeUrl(u) {
    // user:password@ goes whatever precedes the authority: a scheme, a protocol-relative "//", or nothing
    let s = String(u || '').trim().replace(/^((?:[a-z][a-z0-9+.-]*:)?\/\/|)[^/?#@]+@/i, '$1');
    const q = s.indexOf('?');
    if (q < 0) return s;
    const params = s.slice(q + 1).split('&').map(part => { const i = part.indexOf('='); const name = i < 0 ? part : part.slice(0, i); return SECRET_PARAM.test(decoded(name)) ? name + '={key}' : part; });
    return s.slice(0, q) + '?' + params.join('&');
  }
  MB.sanitizeUrl = sanitizeUrl;
  // URLs compare without credentials, a /query suffix or trailing slashes, so a definition on this device (with
  // its key) matches the same one from a file (with the placeholder). Only the scheme and host are case-insensitive:
  // paths and parameters are not, on most servers.
  const normUrl = u => sanitizeUrl(u).replace(/\/query.*$/i, '').replace(/\/+$/, '').replace(/^([a-z]+:\/\/[^/?#]*)/i, m => m.toLowerCase());
  const sameUrl = (a, b) => normUrl(a) === normUrl(b);

  /* ---------- what the app knows, by URI ---------- */

  // Dataset definitions: the built-in catalog plus this device's custom ArcGIS layers.
  function datasets() {
    const custom = ((MB.settings && MB.settings.dataServices) || []).map(c => ({ id: 'custom:' + c.id, name: c.name, url: c.url, custom: true }));
    return (MB.dataCatalog || []).map(d => ({ id: d.id, name: d.name, url: d.url })).concat(custom);
  }
  // A custom layer may point at the same service as a built-in dataset (to style it differently): an entry says
  // which of the two it is for, and both keep their own toggle.
  const datasetByUrl = (url, custom) => datasets().find(d => !!d.custom === !!custom && sameUrl(d.url, url)) || datasets().find(d => sameUrl(d.url, url));
  const datasetById = id => datasets().find(d => d.id === id);

  // Custom tile providers are told apart by what decides how their tiles are fetched and placed: URL, WMS layers,
  // type, tile size and format. Two providers with one URL and different tile sizes are two providers.
  const RENDERING = ['type', 'layers', 'tileSize', 'format'];
  const renderingOf = p => RENDERING.map(k => String(p[k] == null || p[k] === '' ? { type: 'xyz', tileSize: 256, format: 'image/png' }[k] || '' : p[k])).join('|');
  const sameProvider = (a, b) => sameUrl(a.url, b.url) && renderingOf(a) === renderingOf(b);
  const providerLike = def => (MB.settings.providers || []).find(p => sameProvider(p, def));

  // The declared basemap options and their valid choices: the only settings keys a project may carry or set.
  function declaredOptions() {
    const out = Object.create(null); // a file's option names are looked up here: no inherited names (toString) must match
    Object.keys(MB.builtinKeyGroups || {}).forEach(g => (MB.builtinKeyGroups[g].options || []).forEach(o => { out[o.key] = o.choices.map(c => c[0]); }));
    return out;
  }
  function basemapOptions() {
    const out = {}, declared = declaredOptions();
    Object.keys(declared).forEach(k => { out[k] = MB.builtinOption(k, declared[k][0]); });
    return out;
  }
  // A definition as it may leave the device: no key field, no credentials in URLs.
  function exportable(def) {
    const d = clone(def);
    delete d.key;
    if (d.url) d.url = sanitizeUrl(d.url);
    return d;
  }

  // The base map in use -> { name, tiles, layers?, options }
  function basemapRef(key) {
    const ref = { name: key, tiles: '', options: basemapOptions() };
    if (MB.basemaps[key]) { ref.name = MB.basemaps[key].name; ref.tiles = MB.basemaps[key].url; }
    else if (key && key.startsWith('custom:')) {
      const p = MB.getProvider(key.slice(7));
      if (p) { ref.name = p.name; ref.tiles = sanitizeUrl(p.url); RENDERING.forEach(k => { if (p[k] != null && p[k] !== '') ref[k] = p[k]; }); }
    }
    return ref;
  }
  // A saved reference -> the key the app uses, or null when the base map is not known here.
  function basemapKey(ref) {
    if (!ref || !ref.tiles) return null;
    const builtin = Object.keys(MB.basemaps).find(k => sameUrl(MB.basemaps[k].url, ref.tiles));
    if (builtin) return builtin;
    const p = providerLike(Object.assign({}, ref, { url: ref.tiles }));
    return p ? 'custom:' + p.id : null;
  }

  function trafficRef() {
    if (!MB.adsb) return undefined;
    const cf = MB.adsb.conf();
    return {
      sources: MB.adsb.sources.map(s => {
        const c = MB.adsb.srcConf(s.id);
        return s.kind === 'receiver' ? { kind: 'receiver', uri: sanitizeUrl(c.url || ''), enabled: !!c.on, refreshSeconds: c.interval }
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
      id: s.projectId, // which project this is: its saved copy on a device follows it (optional; older files have none)
      name: s.projectName,
      units: { system: s.units, shortDistances: s.shortUnit },
      editing: { showMeasurements: !!s.showMeasurements, continueDrawing: s.continueDrawing !== false, snapping: s.snapping !== false },
      layers: clone(s.layers), activeLayer: s.activeLayerId,
      features: Object.keys(MB.featureLayers).map(id => MB.serializeFeature(MB.featureLayers[id])),
      svgLibrary: clone(s.svgLibrary),
      dataSources: Object.keys(s.dataLayers || {}).map(id => {
        const d = datasetById(id), e = s.dataLayers[id];
        if (!d) return null;
        const entry = { uri: sanitizeUrl(d.url), name: d.name, enabled: !!(e === true || (e && e.on)), hidden: (e && Array.isArray(e.off)) ? e.off.slice() : [] };
        if (d.custom) entry.custom = true;
        return entry;
      }).filter(Boolean)
    };
    // The view and the display state belong to a saved project, not to undo snapshots (objects and layers only).
    if (!opts.noView && MB.map) {
      const c = MB.map.getCenter();
      p.savedAt = new Date().toISOString();
      p.view = { lat: c.lat, lng: c.lng, zoom: MB.map.getZoom() };
      p.basemap = basemapRef(s.basemap);
      // only the definitions this project uses, and nothing secret in them
      const prov = s.basemap && s.basemap.startsWith('custom:') ? MB.getProvider(s.basemap.slice(7)) : null;
      p.tileProviders = prov ? [exportable(prov)] : [];
      p.customDataSources = (MB.settings.dataServices || []).filter(c => s.dataLayers && s.dataLayers['custom:' + c.id]).map(exportable);
      p.dataOpacity = MB.data ? MB.data.settings.opacity : 1;
      p.liveTraffic = trafficRef();
      p.vesselTraffic = vesselRef();
      p.placeLabels = Object.assign({}, s.placeLabels);
      p.magneticDeclination = { enabled: !!(s.declination && s.declination.on) };
      // the defaults for new objects: the color-variation toggle and the styles (a pinned color included)
      p.autoColor = s.autoColor !== false;
      p.defaults = { shape: clone(MB.currentStyle), measure: clone(MB.measureStyle) };
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
      if (providerLike(x)) return;
      const d = exportable(x);
      if (!d.id || MB.getProvider(d.id)) d.id = MB.uid();
      st.providers.push(d); changed = basemap = true;
    });
    (p.customDataSources || []).forEach(c => {
      if (!c || !c.url) return;
      st.dataServices = st.dataServices || [];
      if (st.dataServices.some(x => sameUrl(x.url, c.url))) return;
      const d = exportable(c);
      if (!d.id || st.dataServices.some(x => x.id === d.id)) d.id = MB.uid();
      st.dataServices.push(d); changed = true;
    });
    // only declared options with a valid choice: settings.keys also holds the API keys, which a file must not touch
    const opts = (p.basemap && p.basemap.options) || {}, declared = declaredOptions();
    Object.keys(opts).forEach(k => { if (declared[k] && declared[k].includes(opts[k]) && st.keys[k] !== opts[k]) { st.keys[k] = opts[k]; changed = basemap = true; } });
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

  // Live vessel traffic (AIS): which sources are on, and the display options. The aisstream.io key stays on the device.
  function vesselRef() {
    if (!MB.ais) return undefined;
    const cf = MB.ais.conf();
    return {
      sources: MB.ais.sources.map(s => {
        const c = MB.ais.srcConf(s.id);
        return s.kind === 'receiver' ? { kind: 'receiver', uri: sanitizeUrl(c.url || ''), enabled: !!c.on, refreshSeconds: c.interval }
          : { uri: s.site, enabled: !!c.on };
      }),
      hiddenTypes: cf.off.slice(), labels: !!cf.labels, stationary: !!cf.stationary
    };
  }

  function applyVessels(t) {
    if (!MB.ais || !t || typeof t !== 'object') return;
    const cf = MB.ais.conf();
    const rx = MB.ais.sources.find(s => s.kind === 'receiver');
    const mine = rx && cf.sources[rx.id] && cf.sources[rx.id].url; // a receiver address set on this device stays
    (t.sources || []).forEach(src => {
      if (!src) return;
      const def = src.kind === 'receiver' ? rx : MB.ais.sources.find(s => s.site && sameUrl(s.site, src.uri));
      if (!def) return;
      const c = MB.ais.srcConf(def.id);
      c.on = !!src.enabled;
      if (def.intervals && def.intervals.includes(+src.refreshSeconds)) c.interval = +src.refreshSeconds;
      if (def.kind === 'receiver' && !mine && src.uri) c.url = String(src.uri);
    });
    if (Array.isArray(t.hiddenTypes)) cf.off = t.hiddenTypes.filter(k => MB.ais.types[k]);
    if (typeof t.labels === 'boolean') cf.labels = t.labels;
    if (typeof t.stationary === 'boolean') cf.stationary = t.stationary;
    MB.saveSettings();
    MB.ais.applyConf();
  }

  function placeLabels(v, keep) {
    const def = { countries: true, cities: true, marine: true };
    if (!v || typeof v !== 'object') return keep && MB.state.placeLabels ? MB.state.placeLabels : def;
    Object.keys(def).forEach(k => { if (typeof v[k] === 'boolean') def[k] = v[k]; });
    return def;
  }

  // Every object of the project rebuilt: one redraw of the layers and objects at the end (MB.batch).
  MB.loadProject = (p, opts) => MB.batch(() => loadProject(p, opts));
  function loadProject(p, opts) {
    opts = opts || {};
    p = migrate(p || {});
    MB.clearAll();
    const units = p.units || {}, ed = p.editing || {};
    Object.assign(MB.state, {
      // a file without an id (an older version's) becomes a project of its own; undo keeps the open one's
      projectId: typeof p.id === 'string' && p.id ? p.id : (opts.keepHistory ? MB.state.projectId : MB.uid()),
      projectName: p.name || 'Untitled map',
      units: MB.unitSystems[units.system] ? units.system : 'metric',
      shortUnit: units.shortDistances === 'm' ? 'm' : 'ft',
      showMeasurements: !!ed.showMeasurements,
      continueDrawing: ed.continueDrawing !== false,
      snapping: ed.snapping !== false,
      autoColor: p.autoColor === undefined ? (opts.keepHistory ? MB.state.autoColor : true) : p.autoColor !== false, // undo leaves the preference alone
      svgLibrary: p.svgLibrary || {},
      dataLayers: {},
      // place names: on unless the project turned them off; undo snapshots carry none and leave them alone
      placeLabels: placeLabels(p.placeLabels, opts.keepHistory),
      // magnetic declination: as the project left it; undo snapshots carry none and leave it alone
      declination: p.magneticDeclination && typeof p.magneticDeclination === 'object' ? { on: !!p.magneticDeclination.enabled }
        : (opts.keepHistory && MB.state.declination ? MB.state.declination : { on: false })
    });
    if (p.defaults && typeof p.defaults === 'object') {
      if (p.defaults.shape && typeof p.defaults.shape === 'object') MB.currentStyle = Object.assign(clone(MB.defaultStyle), p.defaults.shape);
      if (p.defaults.measure && typeof p.defaults.measure === 'object') MB.measureStyle = Object.assign(clone(MB.defaultMeasureStyle), p.defaults.measure);
    }
    const rebuild = importDefinitions(p); // before datasets and the base map: the project may carry what they refer to
    (p.dataSources || []).forEach(e => {
      const d = e && datasetByUrl(e.uri, e.custom);
      if (d) MB.state.dataLayers[d.id] = { on: !!e.enabled, off: Array.isArray(e.hidden) ? e.hidden.slice() : [] };
    });
    (p.layers || []).forEach(l => MB.createLayer(l.name, { id: l.id, visible: l.visible, locked: l.locked, grouped: l.grouped, activate: false }));
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
    if (p.vesselTraffic) applyVessels(p.vesselTraffic);
    if (!opts.keepView && p.view && MB.map) MB.map.setView([p.view.lat, p.view.lng], p.view.zoom);
    MB.emit('units', MB.state.units);
    MB.emit('layers');
    MB.emit('features');
    MB.emit('project');
    if (!opts.keepHistory) MB.resetHistory();
  }

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
    // A custom layer id is resolved from the file's own definitions first: the same id on this device may be another service.
    const carried = id => out.customDataSources.find(x => 'custom:' + x.id === id);
    out.dataSources = Object.keys(v.dataLayers || {}).map(id => {
      const e = v.dataLayers[id], def = carried(id) || datasetById(id);
      if (!def || !def.url) return null;
      const entry = { uri: def.url, name: def.name || id, enabled: !!(e === true || (e && e.on)), hidden: (e && Array.isArray(e.off)) ? e.off : [] };
      if (id.startsWith('custom:')) entry.custom = true;
      return entry;
    }).filter(Boolean);
    if (v.basemap) {
      let ref = null;
      if (MB.basemaps[v.basemap]) ref = { name: MB.basemaps[v.basemap].name, tiles: MB.basemaps[v.basemap].url };
      else if (v.basemap.startsWith('custom:')) {
        const id = v.basemap.slice(7), p = out.tileProviders.find(x => x.id === id) || MB.getProvider(id);
        if (p) { ref = { name: p.name, tiles: p.url }; RENDERING.forEach(k => { if (p[k] != null && p[k] !== '') ref[k] = p[k]; }); }
      }
      if (ref) { ref.options = d.basemapOptions || {}; out.basemap = ref; }
    }
    if (typeof d.dataOpacity === 'number') out.dataOpacity = d.dataOpacity;
    if (v.autoColor !== undefined) out.autoColor = v.autoColor !== false;
    if (v.shapeStyle || v.measureStyle) out.defaults = { shape: v.shapeStyle, measure: v.measureStyle };
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
