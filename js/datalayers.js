/* GenGIS - external data layers (FAA UAS Data Delivery System + any ArcGIS Feature Service)
 * - queries ArcGIS Feature Services by bounding box (0.5 degree cells), paged, GeoJSON output
 * - caches cells in IndexedDB; re-checks each service's lastEditDate and invalidates the cache when the data changed
 * - renders below the user's own layers, with hover labels and click popups
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = MB.escapeHtml;
  const FAA = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/';
  const CELL = 0.5;            // degrees
  const MAX_CELLS = 24;        // refuse to load when the view spans more cells than this
  const MAX_CACHED_LAYERS = 80; // in-memory cell layers kept per dataset (LRU)

  /* ---------- styles ---------- */
  const CEIL = [[0, '#d7263d'], [50, '#f46036'], [100, '#f7b32b'], [200, '#9bc53d'], [300, '#5bc0eb'], [400, '#2e86de']];
  function ceilingColor(c) {
    c = +c;
    if (isNaN(c)) return '#888';
    let col = CEIL[CEIL.length - 1][1];
    for (const [v, k] of CEIL) if (c <= v) { col = k; break; }
    return col;
  }
  const ceilingStyle = p => { const col = ceilingColor(p.CEILING); return { color: col, weight: 1, opacity: .9, fillColor: col, fillOpacity: .2 }; };
  function ceilingBucket(c) {
    c = +c;
    if (isNaN(c)) return 400;
    for (const [v] of CEIL) if (c <= v) return v;
    return 400;
  }
  const CLASS_STYLE = {
    B: { color: '#1f5fd6', weight: 2.5, fillColor: '#1f5fd6', fillOpacity: .06 },
    C: { color: '#a12fb5', weight: 2.5, fillColor: '#a12fb5', fillOpacity: .06 },
    D: { color: '#1f5fd6', weight: 2, dashArray: '6,4', fillColor: '#1f5fd6', fillOpacity: .04 },
    E: { color: '#b76ad6', weight: 1.2, dashArray: '2,4', fillColor: '#b76ad6', fillOpacity: .03 }
  };
  const classStyle = p => Object.assign({ opacity: .9 }, CLASS_STYLE[(p.CLASS || '').trim().toUpperCase()] || { color: '#888', weight: 1, fillOpacity: .03 });
  const SUA_STYLE = {
    R: { color: '#d7263d', fillColor: '#d7263d', fillOpacity: .12, weight: 1.5 },
    P: { color: '#d7263d', fillColor: '#d7263d', fillOpacity: .25, weight: 2 },
    W: { color: '#f46036', fillColor: '#f46036', fillOpacity: .06, weight: 1.5, dashArray: '6,4' },
    MOA: { color: '#c2185b', fillColor: '#c2185b', fillOpacity: .06, weight: 1.5, dashArray: '8,4' },
    A: { color: '#f7b32b', fillColor: '#f7b32b', fillOpacity: .08, weight: 1.5 },
    NSA: { color: '#6a1b9a', fillColor: '#6a1b9a', fillOpacity: .06, weight: 1.5, dashArray: '2,4' }
  };
  const suaStyle = p => Object.assign({ opacity: .9 }, SUA_STYLE[(p.TYPE_CODE || '').trim().toUpperCase()] || { color: '#888', fillColor: '#888', fillOpacity: .05, weight: 1 });
  const solid = (color, fill) => () => ({ color, weight: 2, opacity: .95, fillColor: color, fillOpacity: fill == null ? .18 : fill });
  const hatched = (color) => () => ({ color, weight: 2, opacity: .95, dashArray: '6,3', fillColor: color, fillOpacity: .22 });

  const feetDesc = p => [p.LOWER_DESC, p.UPPER_DESC].filter(Boolean).join(' – ');

  /* ---------- catalog ---------- */
  const ESRI = 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/';
  const boundaryStyle = (color, weight, dash) => () => ({ color, weight, opacity: .85, fill: false, dashArray: dash || null, lineJoin: 'round' });

  MB.dataCatalog = [
    { id: 'countries', group: 'Boundaries', name: 'Country boundaries', minZoom: 0, defaultOn: true,
      levels: [{ maxZoom: 4, whole: true, offset: 0.05 }, { maxZoom: 7, cellSize: 20, offset: 0.01 }, { cellSize: 10, offset: 0 }],
      url: ESRI + 'World_Countries_(Generalized)/FeatureServer/0', style: boundaryStyle('#1b1f27', 1.6),
      label: p => p.COUNTRY || '', fields: ['COUNTRY', 'ISO', 'COUNTRYAFF'], legend: [['Country', '#1b1f27']], desc: 'Esri Living Atlas.' },
    { id: 'admin1', group: 'Boundaries', name: 'State / province boundaries', minZoom: 0, defaultOn: true,
      levels: [{ maxZoom: 3, whole: true, offset: 0.3 }, { maxZoom: 5, cellSize: 20, offset: 0.05 }, { maxZoom: 7, cellSize: 10, offset: 0.01 }, { cellSize: 5, offset: 0 }],
      url: ESRI + 'World_Administrative_Divisions/FeatureServer/0', style: boundaryStyle('#4a4f5c', 1.1, '5,4'),
      label: p => `${p.NAME || ''}${p.COUNTRY ? ', ' + p.COUNTRY : ''}`, fields: ['NAME', 'COUNTRY', 'ADMINTYPE', 'ISO_CODE', 'AUTONOMOUS', 'DISPUTED'], legend: [['State / province (dashed)', '#4a4f5c']],
      desc: 'States, provinces, regions. Full detail from zoom 8.' },
    { id: 'fria', group: 'Remote ID', name: 'FAA-Recognized Identification Areas (FRIA)', minZoom: 7,
      url: FAA + 'FAA_Recognized_Identification_Areas/FeatureServer/0', style: solid('#2ecc71', .25),
      label: p => p.title || p.orgName || 'FRIA', fields: ['title', 'orgName', 'address1', 'city', 'state', 'zipcode', 'startDate', 'endDate', 'refNumber'],
      legend: [['FRIA', '#2ecc71']], desc: 'Fly without Remote ID (VLOS).' },
    { id: 'uasfm', group: 'LAANC', name: 'UAS Facility Map (LAANC ceilings)', minZoom: 10,
      url: FAA + 'FAA_UAS_FacilityMap_Data/FeatureServer/0', style: ceilingStyle,
      label: p => `Ceiling ${p.CEILING} ${p.UNIT || 'ft'} AGL${p.APT1_NAME ? ' · ' + p.APT1_NAME : ''}`,
      fields: ['CEILING', 'UNIT', 'APT1_NAME', 'APT1_FAAID', 'APT1_LAANC', 'APT2_NAME', 'APT2_FAAID', 'AIRSPACE_1', 'AIRSPACE_2', 'MAP_EFF', 'LAST_EDIT'],
      legend: CEIL.map(([v, c]) => [v + ' ft', c]), desc: 'LAANC ceilings, ft AGL. 0 ft: coordination required.',
      subsets: { key: p => String(ceilingBucket(p.CEILING)), items: CEIL.map(([v, c]) => [String(v), v + ' ft', c]) } },
    { id: 'classAirspace', group: 'Airspace', name: 'Class B / C / D / E airspace', minZoom: 7,
      url: FAA + 'Class_Airspace/FeatureServer/0', style: classStyle,
      label: p => `Class ${p.CLASS} · ${p.NAME || ''} ${feetDesc(p)}`, fields: ['NAME', 'CLASS', 'LOCAL_TYPE', 'LOWER_DESC', 'UPPER_DESC', 'ICAO_ID', 'COMM_NAME', 'WKHR_RMK'],
      legend: [['Class B', '#1f5fd6'], ['Class C', '#a12fb5'], ['Class D (dashed)', '#1f5fd6'], ['Class E (dotted)', '#b76ad6']], desc: '',
      subsets: { key: p => (p.CLASS || '').trim().toUpperCase(), items: [['B', 'Class B', '#1f5fd6'], ['C', 'Class C', '#a12fb5'], ['D', 'Class D (dashed)', '#1f5fd6'], ['E', 'Class E (dotted)', '#b76ad6']], other: 'Other classes' } },
    { id: 'sua', group: 'Airspace', name: 'Special Use Airspace (R, W, MOA, A, NSA)', minZoom: 6,
      url: FAA + 'Special_Use_Airspace/FeatureServer/0', style: suaStyle,
      label: p => `${p.NAME || ''} (${p.TYPE_CODE || ''}) ${feetDesc(p)}`, fields: ['NAME', 'TYPE_CODE', 'LOWER_DESC', 'UPPER_DESC', 'TIMESOFUSE', 'CONT_AGENT', 'COMM_NAME', 'REMARKS'],
      legend: [['Restricted', '#d7263d'], ['Warning', '#f46036'], ['MOA', '#c2185b'], ['Alert', '#f7b32b'], ['NSA', '#6a1b9a']],
      subsets: { key: p => (p.TYPE_CODE || '').trim().toUpperCase(), items: [['R', 'Restricted (R)', '#d7263d'], ['W', 'Warning (W)', '#f46036'], ['MOA', 'Military Operations Area', '#c2185b'], ['A', 'Alert (A)', '#f7b32b'], ['NSA', 'National Security Area', '#6a1b9a'], ['P', 'Prohibited (P)', '#b71c1c']], other: 'Other types' } },
    { id: 'prohibited', group: 'Airspace', name: 'Prohibited Areas', minZoom: 6,
      url: FAA + 'Prohibited_Areas/FeatureServer/0', style: solid('#b71c1c', .3),
      label: p => `${p.NAME || 'Prohibited'} ${feetDesc(p)}`, fields: ['NAME', 'LOWER_DESC', 'UPPER_DESC', 'TIMESOFUSE', 'CONT_AGENT', 'REMARKS'], legend: [['Prohibited', '#b71c1c']] },
    { id: 'nsufr', group: 'UAS restrictions', name: 'National Security UAS Flight Restrictions (full-time)', minZoom: 7,
      url: FAA + 'DoD_Mar_13/FeatureServer/0', style: hatched('#e53935'),
      label: p => `${p.Facility || p.Base || 'NSUFR'} · ${p.Floor || 'SFC'}–${p.Ceiling || '400 ft'}`, fields: ['Facility', 'Base', 'Branch', 'Proponent', 'Reason', 'Floor', 'Ceiling', 'FAA_ID', 'State', 'POC'],
      legend: [['NSUFR 24/7', '#e53935']], desc: 'No UAS, surface to 400 ft AGL, 24/7.' },
    { id: 'nsufrPart', group: 'UAS restrictions', name: 'National Security UAS Flight Restrictions (part-time)', minZoom: 7,
      url: FAA + 'Part_Time_National_Security_UAS_Flight_Restrictions/FeatureServer/0', style: hatched('#fb8c00'),
      label: p => `${p.Facility || p.Base || 'Part-time NSUFR'} · ${p.ALERTYPE || ''}`, fields: ['Facility', 'Base', 'Reason', 'Floor', 'Ceiling', 'ALERTYPE', 'ACTIVETIME', 'ENDTIME', 'ADVISENOTE', 'FAA_ID'],
      legend: [['Part-time NSUFR', '#fb8c00']], desc: 'Active during announced periods.',
      subsets: { key: p => (p.ALERTYPE || '').trim() ? 'alert' : 'none', items: [['alert', 'With an active alert / schedule', '#fb8c00'], ['none', 'No current alert', '#fb8c00']] } },
    { id: 'nsufrPending', group: 'UAS restrictions', name: 'Pending National Security UAS Flight Restrictions', minZoom: 7,
      url: FAA + 'UAS_NSR_Pending/FeatureServer/0', style: hatched('#8e24aa'),
      label: p => `${p.Facility || p.Base || 'Pending NSUFR'}`, fields: ['Facility', 'Base', 'Branch', 'Reason', 'Floor', 'Ceiling', 'FAA_ID'], legend: [['Pending NSUFR', '#8e24aa']] },
    { id: 'ndaTfr', group: 'UAS restrictions', name: 'National Defense Airspace TFR areas', minZoom: 7,
      url: FAA + 'National_Defense_Airspace_TFR_Areas/FeatureServer/0', style: hatched('#6d4c41'),
      label: p => p.NAME || 'NDA TFR', fields: ['NAME', 'TYPE_CODE', 'LOCAL_TYPE', 'WKHR_RMK', 'CITY', 'STATE'], legend: [['NDA TFR', '#6d4c41']] },
    { id: 'recSites', group: 'Sites', name: 'Recreational Flyer Fixed Sites', minZoom: 8,
      url: FAA + 'Recreational_Flyer_Fixed_Sites/FeatureServer/0', style: solid('#00897b', .2),
      label: p => `${p.SITE_NAME || 'Fixed site'} · ceiling ${p.CEILING || '?'} ${p.UNIT || 'ft'}`, fields: ['SITE_NAME', 'SITE_ID', 'CEILING', 'UNIT', 'CITY', 'STATE', 'POC'], legend: [['Fixed site', '#00897b']] },
    { id: 'stadiums', group: 'Sites', name: 'Stadiums (3 NM TFR during events)', minZoom: 7, point: true,
      url: FAA + 'Stadiums/FeatureServer/0', style: () => ({ radius: 6, color: '#fff', weight: 1.5, fillColor: '#ef6c00', fillOpacity: .95 }),
      label: p => p.NAME || 'Stadium', fields: ['NAME', 'CITY', 'STATE', 'STATUS_CODE'], legend: [['Stadium', '#ef6c00']], desc: '3 NM TFR during major events.' },
    { id: 'airports', group: 'Sites', name: 'Airports', minZoom: 9, point: true,
      url: FAA + 'US_Airport/FeatureServer/0',
      style: p => {
        const priv = p.PRIVATEUSE === 'Y' || p.PRIVATEUSE === 1 || p.PRIVATEUSE === '1';
        const towered = !priv && MB.freqs && MB.freqs.index && MB.freqs.hasTower(p);
        return { radius: towered ? 6 : 5, color: '#fff', weight: 1.2, fillColor: priv ? '#78909c' : (towered ? '#1db3a9' : '#37474f'), fillOpacity: .95 };
      },
      label: p => `${p.NAME || ''} (${p.IDENT || p.ICAO_ID || ''})`, fields: ['NAME', 'IDENT', 'ICAO_ID', 'TYPE_CODE', 'ELEVATION', 'PRIVATEUSE', 'OPERSTATUS', 'SERVCITY', 'STATE'],
      legend: [['Towered', '#1db3a9'], ['Public', '#37474f'], ['Private', '#78909c']],
      subsets: { key: p => (p.PRIVATEUSE === 'Y' || p.PRIVATEUSE === 1 || p.PRIVATEUSE === '1') ? 'private' : 'public', items: [['public', 'Public use', '#37474f'], ['private', 'Private use', '#78909c']] },
      popupExtra: p => MB.freqs.ensure().then(() => MB.freqs.popupHtml(p)),
      onEnable: () => MB.freqs.ensure(), extraStatus: () => MB.freqs.statusLine(),
      desc: 'Click for radio frequencies. Teal = towered.' }
  ];

  /* ---------- IndexedDB (with in-memory fallback) ---------- */
  const DB = {
    name: 'map-builder-data', db: null, mem: { cells: new Map(), meta: new Map() },
    open() {
      if (this.db) return Promise.resolve(this.db);
      if (!window.indexedDB) return Promise.resolve(null);
      return new Promise(res => {
        const r = indexedDB.open(this.name, 1);
        r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('cells')) d.createObjectStore('cells'); if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta'); };
        r.onsuccess = () => { this.db = r.result; res(this.db); };
        r.onerror = () => res(null);
      });
    },
    async req(store, mode, fn) {
      const db = await this.open();
      if (!db) return null;
      return new Promise((res, rej) => {
        const t = db.transaction(store, mode);
        const q = fn(t.objectStore(store));
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
    },
    async get(store, key) { const db = await this.open(); if (!db) return this.mem[store].get(key); return this.req(store, 'readonly', s => s.get(key)); },
    async set(store, key, val) { const db = await this.open(); if (!db) { this.mem[store].set(key, val); return; } return this.req(store, 'readwrite', s => s.put(val, key)); },
    async del(store, key) { const db = await this.open(); if (!db) { this.mem[store].delete(key); return; } return this.req(store, 'readwrite', s => s.delete(key)); },
    async keys(store) { const db = await this.open(); if (!db) return Array.from(this.mem[store].keys()); return this.req(store, 'readonly', s => s.getAllKeys()); },
    async clear(store) { const db = await this.open(); if (!db) { this.mem[store].clear(); return; } return this.req(store, 'readwrite', s => s.clear()); }
  };

  /* ---------- core ---------- */
  MB.data = {
    sets: {},          // id -> runtime state
    settings: { checkHours: 6, maxAgeDays: 7, opacity: 1 },
    lastError: null,

    init() {
      const pane = MB.map.createPane('mb-data');
      pane.style.zIndex = 350;
      pane.style.pointerEvents = 'auto';
      const s = (MB.settings && MB.settings.data) || {};
      Object.assign(this.settings, s);
      this.applyOpacity();
      this.buildSets();
      MB.map.on('moveend zoomend', () => this.refreshSoon());
      MB.on('providers', () => { this.buildSets(); this.refreshSoon(); });
      setInterval(() => this.checkAll(), 15 * 60 * 1000); // periodic update check (honours checkHours)
    },

    buildSets() {
      const custom = ((MB.settings && MB.settings.dataServices) || []).map(c => ({
        id: 'custom:' + c.id, group: 'Custom services', name: c.name, url: c.url.replace(/\/query.*$/, '').replace(/\/$/, ''), minZoom: +c.minZoom || 8,
        point: !!c.point, custom: true, style: () => ({ color: c.color || '#4f8cff', weight: 2, opacity: .9, fillColor: c.color || '#4f8cff', fillOpacity: .15, radius: 6 }),
        label: p => firstText(p), fields: null, legend: [[c.name, c.color || '#4f8cff']]
      }));
      const all = MB.dataCatalog.concat(custom);
      const keep = {};
      all.forEach(def => {
        const prev = this.sets[def.id];
        keep[def.id] = prev ? Object.assign(prev, { def }) : { def, enabled: false, meta: null, group: null, cells: new Map(), loading: new Set(), status: '', error: null };
      });
      Object.keys(this.sets).forEach(id => { if (!keep[id] && this.sets[id].enabled) this.disable(id); });
      this.sets = keep;
      Object.keys(this.sets).forEach(id => { if (!this.sets[id].off) this.sets[id].off = new Set(); });
      MB.emit('data');
    },

    // Persisted entry for a dataset: { on: true, off: ['E', ...] } (older projects stored `true`).
    stateFor(id) {
      MB.state.dataLayers = MB.state.dataLayers || {};
      let e = MB.state.dataLayers[id];
      if (e === true || !e || typeof e !== 'object') e = { on: !!e, off: [] };
      MB.state.dataLayers[id] = e;
      return e;
    },

    subsetKey(ds, p) {
      const sub = ds.def.subsets;
      if (!sub) return null;
      const k = sub.key(p || {});
      return sub.items.some(i => i[0] === k) ? k : '__other';
    },

    isSubsetOn(ds, key) { return !ds.off.has(key); },

    setSubset(id, key, on) {
      const ds = this.sets[id];
      if (!ds) return;
      if (on) ds.off.delete(key); else ds.off.add(key);
      const st = this.stateFor(id);
      st.off = Array.from(ds.off);
      ds.cells.forEach(c => { if (c.layer) applyFilter(ds, c.layer); });
      MB.emit('data');
      MB.autosave();
    },

    catalog() { return Object.keys(this.sets).map(id => this.sets[id]); },

    async enable(id) {
      const ds = this.sets[id];
      if (!ds || ds.enabled) return;
      ds.enabled = true;
      if (!ds.group) ds.group = L.featureGroup([], { pmIgnore: true });
      ds.group.addTo(MB.map);
      const st = this.stateFor(id);
      st.on = true;
      ds.off = new Set(st.off || []);
      ds.cells.forEach(c => { if (c.layer) applyFilter(ds, c.layer); });
      ds.status = 'Checking for updates…';
      MB.emit('data');
      MB.autosave();
      if (ds.def.onEnable) { try { ds.def.onEnable(ds); } catch (e) { /* ignore */ } }
      if (MB.map.attributionControl) MB.map.attributionControl.addAttribution(ds.def.group === 'Boundaries' ? 'Boundaries &copy; Esri' : '<a href="https://udds-faa.opendata.arcgis.com/" target="_blank" rel="noopener">FAA UDDS</a>');
      await this.checkUpdates(ds, false);
      this.refresh();
    },

    disable(id) {
      const ds = this.sets[id];
      if (!ds || !ds.enabled) return;
      ds.enabled = false;
      if (ds.group) { MB.map.removeLayer(ds.group); ds.group.clearLayers(); }
      ds.cells.forEach(c => { c.shown = false; });
      if (MB.state.dataLayers) { const st = this.stateFor(id); st.on = false; }
      ds.status = '';
      MB.emit('data');
      MB.autosave();
    },

    toggle(id) { const ds = this.sets[id]; if (ds) (ds.enabled ? this.disable(id) : this.enable(id)); },

    // Re-enable the datasets recorded in the project.
    applyState() {
      const want = (MB.state.dataLayers) || {};
      Object.keys(this.sets).forEach(id => {
        const e = want[id];
        const on = e === undefined ? !!this.sets[id].def.defaultOn : (e === true || (e && e.on));
        if (on && !this.sets[id].enabled) this.enable(id);
        else if (!on && this.sets[id].enabled) this.disable(id);
        else if (on) { const ds = this.sets[id]; ds.off = new Set((e && e.off) || []); ds.cells.forEach(c => { if (c.layer) applyFilter(ds, c.layer); }); }
      });
      MB.emit('data');
    },

    applyOpacity() {
      const pane = MB.map.getPane('mb-data');
      if (pane) pane.style.opacity = this.settings.opacity;
    },

    saveSettings() {
      MB.settings.data = Object.assign({}, this.settings);
      MB.saveSettings();
    },

    /* ----- update checks ----- */
    async loadMeta(ds) {
      if (ds.meta) return ds.meta;
      ds.meta = (await DB.get('meta', ds.def.id)) || { lastEdit: null, checkedAt: 0 };
      return ds.meta;
    },

    async checkUpdates(ds, force) {
      ds.checking = true;
      try { return await this._checkUpdates(ds, force); } finally { ds.checking = false; }
    },

    async _checkUpdates(ds, force) {
      const meta = await this.loadMeta(ds);
      const interval = this.settings.checkHours * 3600 * 1000;
      if (!force && meta.checkedAt && Date.now() - meta.checkedAt < interval && meta.lastEdit) { ds.status = ''; return false; }
      try {
        const info = await fetch(ds.def.url + '?f=json').then(r => r.json());
        const lastEdit = (info.editingInfo && (info.editingInfo.dataLastEditDate || info.editingInfo.lastEditDate)) || null;
        ds.layerName = info.name;
        let changed = false;
        if (meta.lastEdit && lastEdit && lastEdit !== meta.lastEdit) {
          changed = true;
          await this.purge(ds);
          ds.status = 'Service data changed: reloading';
        }
        ds.meta = { lastEdit: lastEdit || meta.lastEdit || Date.now(), checkedAt: Date.now(), serviceName: info.name };
        await DB.set('meta', ds.def.id, ds.meta);
        if (!changed) ds.status = '';
        ds.error = null;
        MB.emit('data');
        return changed;
      } catch (e) {
        ds.error = 'Could not reach the service (' + e.message + '); using cached data if available.';
        ds.meta = meta.lastEdit ? meta : { lastEdit: 'offline', checkedAt: 0 };
        MB.emit('data');
        return false;
      }
    },

    async checkAll(force) {
      for (const ds of this.catalog()) if (ds.enabled) await this.checkUpdates(ds, force);
      this.refresh();
    },

    async purge(ds) {
      ds.cells.forEach(c => { if (ds.group && c.layer) ds.group.removeLayer(c.layer); });
      ds.cells.clear();
      const keys = await DB.keys('cells') || [];
      for (const k of keys) if (String(k).startsWith(ds.def.id + '|')) await DB.del('cells', k);
    },

    async clearCache() {
      for (const ds of this.catalog()) { ds.cells.forEach(c => { if (ds.group && c.layer) ds.group.removeLayer(c.layer); }); ds.cells.clear(); ds.meta = null; }
      await DB.clear('cells'); await DB.clear('meta');
      if (MB.freqs) { MB.freqs.index = null; MB.freqs.meta = null; }
      MB.emit('data');
      await this.checkAll(true); // re-read each service's update stamp before caching anything again
    },

    async cacheStats() {
      const keys = await DB.keys('cells') || [];
      const per = {};
      keys.forEach(k => { const id = String(k).split('|')[0]; per[id] = (per[id] || 0) + 1; });
      let bytes = null;
      try { if (navigator.storage && navigator.storage.estimate) bytes = (await navigator.storage.estimate()).usage; } catch (e) { /* ignore */ }
      return { cells: keys.length, per, bytes };
    },

    /* ----- loading ----- */
    refreshSoon: null,

    // Which loading level applies at this zoom: whole dataset (optionally generalized) or bbox cells of a given size.
    levelFor(def, zoom) {
      if (def.levels && def.levels.length) {
        const i = def.levels.findIndex(l => l.maxZoom == null || zoom <= l.maxZoom);
        const idx = i < 0 ? def.levels.length - 1 : i;
        const l = def.levels[idx];
        return { idx, whole: !!l.whole, cellSize: l.cellSize || CELL, offset: l.offset || 0 };
      }
      return { idx: 0, whole: false, cellSize: CELL, offset: 0 };
    },

    refresh() {
      const zoom = MB.map.getZoom(), bounds = MB.map.getBounds();
      this.catalog().forEach(ds => {
        if (!ds.enabled || ds.checking) return; // wait until the update stamp is known before caching anything
        if (zoom < ds.def.minZoom) {
          ds.status = 'Zoom in to level ' + ds.def.minZoom + ' or closer to load';
          ds.cells.forEach(c => { if (c.shown) { ds.group.removeLayer(c.layer); c.shown = false; } });
          return;
        }
        const level = this.levelFor(ds.def, zoom);
        const cells = level.whole ? [{ key: 'all', bounds: L.latLngBounds([-90, -180], [90, 180]) }] : cellsFor(bounds, level.cellSize);
        if (cells.length > MAX_CELLS) { ds.status = 'View too large: zoom in'; return; }
        const prefix = 'L' + level.idx + ':';
        const need = new Set(cells.map(c => prefix + c.key));
        ds.cells.forEach((c, key) => { if (!need.has(key) && c.shown) { ds.group.removeLayer(c.layer); c.shown = false; } });
        cells.forEach(cell => {
          const c = ds.cells.get(prefix + cell.key);
          if (c) { if (!c.shown && c.layer) { ds.group.addLayer(c.layer); c.shown = true; } c.used = Date.now(); }
          else this.loadCell(ds, cell, level);
        });
        // LRU eviction of hidden cell layers
        if (ds.cells.size > MAX_CACHED_LAYERS) {
          const hidden = Array.from(ds.cells.entries()).filter(([, c]) => !c.shown).sort((a, b) => a[1].used - b[1].used);
          hidden.slice(0, ds.cells.size - MAX_CACHED_LAYERS).forEach(([k]) => ds.cells.delete(k));
        }
        if (!ds.loading.size && !ds.error) ds.status = level.whole && level.offset ? 'overview (generalized): zoom in for full detail' : '';
      });
      MB.emit('data');
    },

    async loadCell(ds, cell, level) {
      level = level || this.levelFor(ds.def, MB.map.getZoom());
      const memKey = 'L' + level.idx + ':' + cell.key;
      const key = ds.def.id + '|' + memKey;
      if (ds.loading.has(key)) return;
      ds.loading.add(key);
      ds.status = 'Loading…';
      MB.emit('data');
      const meta = await this.loadMeta(ds);
      const maxAge = this.settings.maxAgeDays * 86400 * 1000;
      let geojson = null, fromCache = false;
      try {
        const cached = await DB.get('cells', key);
        if (cached && cached.lastEdit === meta.lastEdit && Date.now() - cached.ts < maxAge) { geojson = cached.geojson; fromCache = true; }
        if (!geojson) {
          try {
            geojson = await queryCell(ds.def.url, cell, ds.def.fields, level);
            await DB.set('cells', key, { ts: Date.now(), lastEdit: meta.lastEdit, geojson });
            ds.error = null;
          } catch (e) {
            if (cached) { geojson = cached.geojson; fromCache = true; ds.error = 'Offline or service error: showing cached data.'; }
            else { ds.error = 'Load failed: ' + e.message; }
          }
        }
      } finally { ds.loading.delete(key); }
      if (geojson) {
        const layer = makeLayer(ds, geojson);
        const entry = { layer, shown: false, used: Date.now(), fromCache, n: (geojson.features || []).length };
        ds.cells.set(memKey, entry);
        const cur = this.levelFor(ds.def, MB.map.getZoom());
        if (ds.enabled && cur.idx === level.idx && MB.map.getZoom() >= ds.def.minZoom && MB.map.getBounds().intersects(cell.bounds)) { ds.group.addLayer(layer); entry.shown = true; }
      }
      if (!ds.loading.size) ds.status = ds.error ? '' : '';
      MB.emit('data');
    },

    featureCount(ds) { let n = 0; ds.cells.forEach(c => { if (c.shown && c.layer) n += c.layer.getLayers().length; }); return n; }
  };
  MB.data.refreshSoon = MB.debounce(() => MB.data.refresh(), 350);
  MB.data.cellsFor = cellsFor;
  MB.data.db = DB;

  // Re-style every loaded feature of a dataset (used when derived info such as frequencies arrives later).
  MB.data.restyle = function (id) {
    const ds = MB.data.sets[id];
    if (!ds || !ds.def.style) return;
    ds.cells.forEach(c => { if (c.layer) c.layer.eachLayer(l => { if (l.setStyle && l.feature) l.setStyle(ds.def.style(l.feature.properties || {})); }); });
  };

  function cellsFor(bounds, size) {
    size = size || CELL;
    const out = [];
    const s = Math.max(-90, Math.floor(bounds.getSouth() / size) * size), n = Math.min(90, bounds.getNorth());
    const w = Math.max(-180, Math.floor(bounds.getWest() / size) * size), e = Math.min(180, bounds.getEast());
    for (let lat = s; lat < n; lat += size) {
      for (let lng = w; lng < e; lng += size) {
        const la = +lat.toFixed(2), lo = +lng.toFixed(2);
        out.push({ key: la + '_' + lo, bounds: L.latLngBounds([la, lo], [la + size, lo + size]) });
        if (out.length > MAX_CELLS + 1) return out;
      }
    }
    return out;
  }

  async function queryCell(url, cell, fields, level) {
    const b = cell.bounds;
    const features = [];
    let offset = 0;
    for (let page = 0; page < 30; page++) {
      const p = new URLSearchParams({
        where: '1=1', outFields: fields ? fields.join(',') : '*', outSR: '4326', geometryPrecision: level && level.offset ? '3' : '6', f: 'geojson',
        resultOffset: String(offset), resultRecordCount: '2000'
      });
      if (!(level && level.whole)) {
        p.set('geometry', [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(','));
        p.set('geometryType', 'esriGeometryEnvelope'); p.set('inSR', '4326'); p.set('spatialRel', 'esriSpatialRelIntersects');
      }
      if (level && level.offset) p.set('maxAllowableOffset', String(level.offset));
      const r = await fetch(url + '/query?' + p.toString());
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'service error');
      const feats = j.features || [];
      features.push(...feats);
      const more = (j.properties && j.properties.exceededTransferLimit) || j.exceededTransferLimit;
      if (!more || !feats.length) break;
      offset += feats.length;
    }
    return { type: 'FeatureCollection', features };
  }

  function firstText(p) {
    for (const k of ['NAME', 'name', 'title', 'Name', 'SITE_NAME', 'Facility', 'IDENT']) if (p[k]) return String(p[k]);
    const k = Object.keys(p).find(x => typeof p[x] === 'string' && p[x]);
    return k ? p[k] : '';
  }

  function fmtVal(k, v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && v > 1e11 && /date|time|eff|edit|start|end/i.test(k)) return new Date(v).toLocaleString();
    return String(v);
  }

  function popupHtml(ds, p) {
    const keys = ds.def.fields || Object.keys(p).filter(k => !/^(OBJECTID|GLOBAL_?ID|Shape__|GlobalID)/i.test(k)).slice(0, 18);
    const rows = keys.map(k => { const v = fmtVal(k, p[k]); return v ? `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>` : ''; }).join('');
    return `<div class="mb-popup"><div class="mb-popup-title">${esc(ds.def.name)}</div><table class="mb-datatable">${rows}</table></div>`;
  }

  // Show / hide the features of a cell layer according to the dataset's sub-element toggles.
  function applyFilter(ds, layer) {
    if (!ds.def.subsets || !layer._all) return;
    layer._all.forEach(sub => {
      const k = MB.data.subsetKey(ds, sub.feature && sub.feature.properties);
      const show = !ds.off.has(k);
      if (show && !layer.hasLayer(sub)) layer.addLayer(sub);
      else if (!show && layer.hasLayer(sub)) layer.removeLayer(sub);
    });
  }

  function makeLayer(ds, geojson) {
    const layer = buildGeoJson(ds, geojson);
    layer._all = layer.getLayers();
    applyFilter(ds, layer);
    return layer;
  }

  // One shared Canvas renderer for every data layer: thousands of features become a single bitmap instead of
  // thousands of SVG nodes, which roughly halves paint and zoom cost and keeps the DOM small.
  function dataRenderer() {
    if (!MB.data.renderer) MB.data.renderer = L.canvas({ pane: 'mb-data', padding: 0.5, tolerance: 3 });
    return MB.data.renderer;
  }
  MB.data.dataRenderer = dataRenderer;

  function buildGeoJson(ds, geojson) {
    const def = ds.def;
    const renderer = dataRenderer();
    return L.geoJSON(geojson, {
      pane: 'mb-data', pmIgnore: true, renderer,
      style: f => def.style(f.properties || {}),
      pointToLayer: (f, ll) => L.circleMarker(ll, Object.assign({ pane: 'mb-data', pmIgnore: true, renderer }, def.style(f.properties || {}))),
      onEachFeature: (f, layer) => {
        const p = f.properties || {};
        layer.options.pmIgnore = true;
        const lbl = def.label ? def.label(p) : firstText(p);
        if (lbl) layer.bindTooltip(String(lbl), { sticky: true, className: 'mb-name-tip', direction: 'top', opacity: .95 });
        layer.on('click', e => {
          const t = MB.tools.current;
          if (t !== 'select' && t !== 'move' && t !== 'present') return;
          L.DomEvent.stopPropagation(e);
          const popup = L.popup({ maxWidth: 380, className: 'mb-data-popup' }).setLatLng(e.latlng);
          const base = popupHtml(ds, p);
          if (def.popupExtra) {
            popup.setContent(base + '<div class="mb-extra dim">Loading frequencies…</div>').openOn(MB.map);
            Promise.resolve().then(() => def.popupExtra(p)).then(html => {
              if (!popup.isOpen()) return;
              popup.setContent(base + html);
            }).catch(err => { if (popup.isOpen()) popup.setContent(base + '<div class="mb-extra dim">Frequencies unavailable: ' + esc(err.message) + '</div>'); });
          } else popup.setContent(base).openOn(MB.map);
        });
      }
    });
  }

  /* ---------- panel ---------- */
  MB.data.renderPanel = async function () {
    const panel = document.getElementById('tab-data');
    if (!panel) return;
    const groups = {};
    this.catalog().forEach(ds => { if (ds.def.group !== 'Boundaries') (groups[ds.def.group] = groups[ds.def.group] || []).push(ds); });
    const zoom = MB.map.getZoom();
    const anyOn = this.catalog().some(ds => ds.enabled);
    const s = this.settings;
    let html = `<div class="panel-head"><h3>FAA airspace &amp; UAS data</h3><span class="badge">zoom ${zoom.toFixed(0)}</span></div>
      <p class="note">Live <a href="https://udds-faa.opendata.arcgis.com/" target="_blank" rel="noopener">FAA UDDS</a> data for the visible area, cached on this device. Informational only.</p>
      <div class="btn-row" style="margin:0 0 10px"><button class="btn small" data-act="check">Check for updates now</button><button class="btn small ghost" data-act="clear">Clear cached data</button></div>
      <div id="dataCacheStats" class="note" style="margin-bottom:10px"></div>`;
    Object.keys(groups).forEach(g => {
      html += `<div class="section"><h3>${esc(g)}</h3>`;
      groups[g].forEach(ds => {
        const d = ds.def;
        const shown = ds.enabled ? this.featureCount(ds) : 0;
        let statusLine = '';
        if (ds.enabled) {
          const bits = [];
          if (ds.loading.size) bits.push('loading ' + ds.loading.size + '…');
          if (ds.status) bits.push(ds.status);
          if (!ds.loading.size && !ds.status) bits.push(shown + ' features in view');
          if (ds.meta && ds.meta.lastEdit && ds.meta.lastEdit !== 'offline') bits.push('FAA updated ' + new Date(ds.meta.lastEdit).toLocaleDateString());
          if (ds.meta && ds.meta.checkedAt) bits.push('checked ' + ago(ds.meta.checkedAt));
          statusLine = esc(bits.join(' · '));
          if (d.extraStatus) { try { statusLine += '<br>' + esc(d.extraStatus()); } catch (e) { /* ignore */ } }
        } else statusLine = esc(d.minZoom ? 'zoom ' + d.minZoom + '+' : 'any zoom');
        html += `<div class="data-item${ds.enabled ? ' on' : ''}" data-id="${d.id}">
          <label class="check" style="margin:0"><input type="checkbox" data-act="toggle"${ds.enabled ? ' checked' : ''}> <span class="dname">${esc(d.name)}</span></label>
          ${d.custom ? `<button class="icon-btn mini danger" data-act="remove" title="Remove this service">${trashIcon}</button>` : ''}
          ${d.subsets
            ? `<div class="subsets">${d.subsets.items.concat(d.subsets.other ? [['__other', d.subsets.other, '#888']] : []).map(([k, t, c]) => `<label class="sub${ds.off.has(k) ? ' off' : ''}"><input type="checkbox" data-sub="${esc(k)}"${ds.off.has(k) ? '' : ' checked'}${ds.enabled ? '' : ' disabled'}><i style="background:${c}"></i>${esc(t)}</label>`).join('')}
               <span class="sub-actions"><button type="button" class="link" data-act="sub-all">all</button> · <button type="button" class="link" data-act="sub-none">none</button></span></div>`
            : `<div class="legend">${(d.legend || []).map(([t, c]) => `<span><i style="background:${c}"></i>${esc(t)}</span>`).join('')}</div>`}
          ${d.desc ? `<div class="note">${esc(d.desc)}</div>` : ''}
          <div class="dstatus${ds.error ? ' err' : ''}">${ds.error ? esc(ds.error) : statusLine}</div>
        </div>`;
      });
      html += '</div>';
    });
    html += `<div class="section"><h3>Options</h3>
      <div class="row"><label>Data opacity</label><input type="range" id="dataOpacity" min="0.1" max="1" step="0.05" value="${s.opacity}"><span class="val" id="dataOpacityVal">${Math.round(s.opacity * 100)}%</span></div>
      <div class="row" title="How often each service's last-edit stamp is compared; changed datasets are re-downloaded"><label>Check updates</label><select id="dataCheck">${[1, 3, 6, 12, 24].map(h => `<option value="${h}"${+s.checkHours === h ? ' selected' : ''}>every ${h} h</option>`).join('')}</select></div>
      <div class="row" title="Cached areas older than this are refreshed"><label>Keep cache</label><select id="dataMaxAge">${[1, 3, 7, 14, 30].map(dd => `<option value="${dd}"${+s.maxAgeDays === dd ? ' selected' : ''}>${dd} day${dd > 1 ? 's' : ''}</option>`).join('')}</select></div>
    </div>
    <div class="section"><h3>Add ArcGIS layer</h3>
      <form id="dataCustomForm">
        <div class="row"><label>Name</label><input type="text" name="name" required placeholder="Layer name"></div>
        <div class="row"><label>URL</label><input type="text" name="url" required placeholder="https://…/FeatureServer/0" title="Any public ArcGIS Feature Service layer"></div>
        <div class="row"><label>Color</label><input type="color" name="color" value="#4f8cff"><label style="flex:0 0 auto">Min zoom</label><input type="number" name="minZoom" class="narrow" min="3" max="16" value="8"></div>
        <label class="check"><input type="checkbox" name="point"> Points</label>
        <div class="btn-row"><button class="btn small primary" type="submit">Add layer</button></div>
      </form>
    </div>`;
    panel.innerHTML = html;

    panel.querySelector('[data-act="check"]').addEventListener('click', async () => { if (!anyOn) { MB.toast('Enable a dataset first'); return; } MB.toast('Checking FAA services…'); await this.checkAll(true); MB.toast('Update check finished'); });
    panel.querySelector('[data-act="clear"]').addEventListener('click', async () => { if (confirm('Delete all cached FAA/ArcGIS data on this device? It will be downloaded again as needed.')) { await this.clearCache(); MB.toast('Cache cleared'); } });
    panel.querySelectorAll('.data-item').forEach(item => {
      const id = item.dataset.id;
      item.querySelector('[data-act="toggle"]').addEventListener('change', () => this.toggle(id));
      item.querySelectorAll('input[data-sub]').forEach(cb => cb.addEventListener('change', () => this.setSubset(id, cb.dataset.sub, cb.checked)));
      const ds = this.sets[id];
      const allKeys = () => ds.def.subsets ? ds.def.subsets.items.map(i => i[0]).concat(ds.def.subsets.other ? ['__other'] : []) : [];
      const subAll = item.querySelector('[data-act="sub-all"]'), subNone = item.querySelector('[data-act="sub-none"]');
      if (subAll) subAll.addEventListener('click', () => allKeys().forEach(k => this.setSubset(id, k, true)));
      if (subNone) subNone.addEventListener('click', () => allKeys().forEach(k => this.setSubset(id, k, false)));
      const rm = item.querySelector('[data-act="remove"]');
      if (rm) rm.addEventListener('click', () => {
        const cid = id.replace(/^custom:/, '');
        this.disable(id);
        MB.settings.dataServices = (MB.settings.dataServices || []).filter(c => c.id !== cid);
        MB.saveSettings();
      });
    });
    panel.querySelector('#dataOpacity').addEventListener('input', e => { s.opacity = +e.target.value; panel.querySelector('#dataOpacityVal').textContent = Math.round(s.opacity * 100) + '%'; this.applyOpacity(); });
    panel.querySelector('#dataOpacity').addEventListener('change', () => this.saveSettings());
    panel.querySelector('#dataCheck').addEventListener('change', e => { s.checkHours = +e.target.value; this.saveSettings(); });
    panel.querySelector('#dataMaxAge').addEventListener('change', e => { s.maxAgeDays = +e.target.value; this.saveSettings(); });
    panel.querySelector('#dataCustomForm').addEventListener('submit', e => {
      e.preventDefault();
      const f = e.target.elements;
      const url = f.url.value.trim();
      if (!/FeatureServer\/\d+/i.test(url)) { MB.toast('URL must end with /FeatureServer/<layer id>'); return; }
      MB.settings.dataServices = MB.settings.dataServices || [];
      const entry = { id: MB.uid(), name: f.name.value.trim(), url, color: f.color.value, minZoom: +f.minZoom.value || 8, point: f.point.checked };
      MB.settings.dataServices.push(entry);
      MB.saveSettings();
      this.enable('custom:' + entry.id);
    });

    const st = await this.cacheStats();
    const el = document.getElementById('dataCacheStats');
    if (el) el.textContent = st.cells ? `Cache: ${st.cells} area${st.cells > 1 ? 's' : ''} stored` + (st.bytes ? ` · ~${(st.bytes / 1048576).toFixed(1)} MB used by this app` : '') : 'Cache: empty';
  };

  // "Map overlays" section in the Settings tab: boundary layers.
  MB.data.renderOverlays = function () {
    const box = document.getElementById('overlaySection');
    if (!box) return;
    const list = this.catalog().filter(ds => ds.def.group === 'Boundaries');
    box.innerHTML = list.map(ds => {
      const d = ds.def;
      let status = '';
      if (ds.enabled) {
        if (ds.error) status = ds.error;
        else if (ds.loading.size) status = 'loading…';
        else status = ds.status || (this.featureCount(ds) + ' in view');
      }
      return `<div class="overlay-item"><label class="check" style="margin:0"><input type="checkbox" data-id="${d.id}"${ds.enabled ? ' checked' : ''}> <span>${esc(d.name)}</span></label>
        <div class="note" style="margin-left:23px">${esc(d.desc || '')}${status ? ' <span class="dim">· ' + esc(status) + '</span>' : ''}</div></div>`;
    }).join('');
    box.querySelectorAll('input[data-id]').forEach(cb => cb.addEventListener('change', () => this.toggle(cb.dataset.id)));
  };
  MB.data.renderOverlaysSoon = MB.debounce(() => MB.data.renderOverlays(), 250);

  function ago(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 48) return h + ' h ago';
    return Math.round(h / 24) + ' days ago';
  }
  const trashIcon = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

  MB.data.renderPanelSoon = MB.debounce(() => MB.data.renderPanel(), 250);
})(window.MB);
