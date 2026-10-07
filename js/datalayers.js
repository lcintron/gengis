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
  const MAX_CELLS = 24;        // refuse to load when the view spans more cells than this (a dataset's maxCells: its own)
  const MAX_CACHED_LAYERS = 80; // in-memory cells kept per dataset (LRU)
  const CACHE_REV = 2;          // part of every stored cell's key; bump when what a cell holds changes (2: detail follows the zoom)
  // Detail follows the zoom. The FAA polygons carry thousands of vertices each at 10 cm precision: far more than
  // can be seen until zoomed right in, and every vertex is re-projected on each zoom step. Tolerances are in
  // degrees (0.0005 is about 55 m), each under half a pixel across its zoom range; full detail from zoom 17.
  // Cells grow as detail drops: a query costs the same share of the service's quota whatever it returns, so zoomed
  // out it is better to ask for a few large areas than many small ones.
  const DETAIL = [{ maxZoom: 9, offset: 0.0005, cellSize: 2 }, { maxZoom: 12, offset: 0.0001, cellSize: 1 }, { maxZoom: 16, offset: 0.00001 }, { offset: 0 }];
  const MAX_ACTIVE = 6;         // queries in flight at once

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
  // Airspace as on the FAA's VFR sectional charts: blue and magenta; solid for Class B and C, dashed for Class D and
  // surface Class E, a vignette (a band fading inward) for Class E with a floor above the surface (magenta: 700 ft AGL,
  // blue: 1,200 ft AGL or higher), a thin line for the Mode C veil, and a comb (ticks on the inner side) for special
  // use airspace (blue: prohibited, restricted, warning, danger; magenta: MOA, alert). The vignette and comb are
  // drawn by the data renderer (band: in a style).
  const BLUE = '#2c6bd1', MAGENTA = '#b23a7e';
  const CLASS_STYLE = {
    B: { color: BLUE, weight: 3, fillColor: BLUE, fillOpacity: .05 },
    C: { color: MAGENTA, weight: 3, fillColor: MAGENTA, fillOpacity: .05 },
    D: { color: BLUE, weight: 2, dashArray: '8,5', fillColor: BLUE, fillOpacity: .04 },
    ESFC: { color: MAGENTA, weight: 2, dashArray: '8,5', fillColor: MAGENTA, fillOpacity: .03 },
    E700: { color: MAGENTA, weight: .8, opacity: .55, fillOpacity: 0, band: 'vignette' },
    E1200: { color: BLUE, weight: .8, opacity: .55, fillOpacity: 0, band: 'vignette' },
    MODEC: { color: MAGENTA, weight: 1.2, fillOpacity: 0 }
  };
  // Which of those an area is: its class, and for Class E its floor (the surface, 700 ft, or higher).
  function classKind(p) {
    const c = String(p.CLASS || '').trim().toUpperCase();
    if (c === 'E') { const lo = +p.LOWER_VAL; return !(lo > 0) ? 'ESFC' : (lo === 700 ? 'E700' : 'E1200'); }
    if (String(p.LOCAL_TYPE || '').trim().toUpperCase() === 'MODE C') return 'MODEC';
    return c;
  }
  const classStyle = p => Object.assign({ opacity: .9 }, CLASS_STYLE[classKind(p)] || { color: '#888', weight: 1, fillOpacity: .03 });
  const comb = (color, fill) => ({ color, weight: 1.5, fillColor: color, fillOpacity: fill, band: 'comb' });
  const SUA_STYLE = {
    P: comb(BLUE, .08), R: comb(BLUE, .05), W: comb(BLUE, .03), D: comb(BLUE, .03),
    MOA: comb(MAGENTA, .03), A: comb(MAGENTA, .03),
    NSA: { color: MAGENTA, weight: 4, dashArray: '10,8', fillColor: MAGENTA, fillOpacity: .04 }
  };
  const suaStyle = p => Object.assign({ opacity: .9 }, SUA_STYLE[(p.TYPE_CODE || '').trim().toUpperCase()] || { color: '#888', fillColor: '#888', fillOpacity: .05, weight: 1 });
  const solid = (color, fill) => () => ({ color, weight: 2, opacity: .95, fillColor: color, fillOpacity: fill == null ? .18 : fill });
  const hatched = (color) => () => ({ color, weight: 2, opacity: .95, dashArray: '6,3', fillColor: color, fillOpacity: .22 });

  const feetDesc = p => [p.LOWER_DESC, p.UPPER_DESC].filter(Boolean).join(' – ');

  // An airspace floor or ceiling as charted: SFC, 1,200 ft MSL, 700 ft AGL, FL180, unlimited. -9998 stands for a
  // limit that is not a number (unlimited, by NOTAM, the airspace above); one the code does not name is left out.
  function altitude(v, uom, code) {
    code = String(code || '').toUpperCase(); uom = String(uom || '').toUpperCase();
    if (code === 'UNLTD') return 'unlimited';
    if (code === 'BYNOTAM') return 'by NOTAM';
    if (v == null || v === '' || +v < 0) return '';
    if (code === 'SFC' && !+v) return 'SFC';
    if (uom === 'FL' || code === 'STD') return 'FL' + v;
    return Number(v).toLocaleString('en-US') + ' ft ' + (code === 'SFC' ? 'AGL' : (code || 'MSL'));
  }
  const floorOf = p => altitude(p.LOWER_VAL, p.LOWER_UOM, p.LOWER_CODE);
  const ceilingOf = p => altitude(p.UPPER_VAL, p.UPPER_UOM, p.UPPER_CODE);
  const altRange = p => { const lo = floorOf(p), hi = ceilingOf(p); return lo && hi ? lo + ' – ' + hi : (hi ? 'up to ' + hi : (lo ? 'from ' + lo : '')); };
  const cap = s => String(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

  /* ---------- catalog ---------- */
  const ESRI = 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/';
  // A border: a light line on a dark casing (buildBorders draws the casing under it), seen on imagery and light maps.
  const boundaryStyle = (color, weight, dash) => () => ({ color, weight, opacity: .95, fill: false, dashArray: dash || null, lineJoin: 'round',
    casing: { color: '#0b1118', weight: weight + 2.5, opacity: .55 } });
  // A simplification tolerance (degrees) of half a pixel at zoom z, at latitudes up to about 55 degrees: what the
  // eye cannot tell from the full outline. The FAA layers keep to the same budget (DETAIL).
  const halfPx = z => 0.5 * 360 / (256 * Math.pow(2, z)) * Math.cos(55 * Math.PI / 180);

  MB.dataSources = {
    faa: { name: 'FAA UAS Data Delivery System', url: 'https://udds-faa.opendata.arcgis.com/', note: 'Live FAA airspace and UAS data for the visible area, cached on this device. Informational only.' },
    custom: { name: 'Custom ArcGIS layers', url: '', note: '' }
  };

  // Subset rows: [key, label, color, chart symbol of its swatch]
  const CLASS_ITEMS = [['B', 'Class B', BLUE, 'solid'], ['C', 'Class C', MAGENTA, 'solid'], ['D', 'Class D', BLUE, 'dashed'],
    ['ESFC', 'Class E from the surface', MAGENTA, 'dashed'], ['E700', 'Class E from 700 ft AGL', MAGENTA, 'vignette'],
    ['E1200', 'Class E from 1,200 ft AGL or higher', BLUE, 'vignette'], ['MODEC', 'Mode C veil (30 NM)', MAGENTA, 'line']];
  const SUA_ITEMS = [['P', 'Prohibited (P)', BLUE, 'comb'], ['R', 'Restricted (R)', BLUE, 'comb'], ['W', 'Warning (W)', BLUE, 'comb'],
    ['D', 'Danger (D)', BLUE, 'comb'], ['MOA', 'Military Operations Area', MAGENTA, 'comb'], ['A', 'Alert (A)', MAGENTA, 'comb'],
    ['NSA', 'National Security Area', MAGENTA, 'dashed-wide']];

  MB.dataCatalog = [
    // Both boundary layers draw borders only: the edges two neighbours share. A coastline is never traced (the base
    // map draws its own, and a boundary dataset's coast is tens to hundreds of metres off it, up to kilometres for
    // the simplified world countries). With the coast gone, the simplified world countries are good enough at every
    // zoom: their land borders are as close as the detailed data's, and their polygons take in lakes, so borders
    // across lakes (US-Canada) are kept. The state outlines stop at the shore: borders across water are not there.
    // Borders are shown at every zoom and for any view: they come from Esri's services (not the FAA's metered
    // quota) and are cached, so a wide view may take up to 200 cells (the whole world is 162 at their 20 degrees).
    { id: 'countries', group: 'Boundaries', name: 'Country borders', minZoom: 0, maxCells: 200, defaultOn: true, rev: 1,
      borders: p => p.COUNTRY || '',
      levels: [{ maxZoom: 4, whole: true, offset: halfPx(4) }, { maxZoom: 7, cellSize: 20, offset: halfPx(7) }, { cellSize: 10, offset: 0 }],
      url: ESRI + 'World_Countries_(Generalized)/FeatureServer/0', style: boundaryStyle('#ffffff', 2),
      label: p => p.COUNTRY || '', fields: ['COUNTRY', 'ISO', 'COUNTRYAFF'], legend: [['Country border', '#ffffff']], desc: 'Esri Living Atlas. Land borders at every zoom; coastlines are left to the base map.' },
    { id: 'admin1', group: 'Boundaries', name: 'State / province borders', minZoom: 0, maxCells: 200, defaultOn: true, rev: 1,
      borders: p => (p.NAME || '') + '|' + (p.COUNTRY || ''),
      levels: [{ maxZoom: 3, whole: true, offset: halfPx(3) }, { maxZoom: 5, cellSize: 20, offset: halfPx(5) }, { maxZoom: 7, cellSize: 10, offset: halfPx(7) }, { cellSize: 5, offset: 0 }],
      url: ESRI + 'World_Administrative_Divisions/FeatureServer/0', style: boundaryStyle('#d6dde8', 1.4, '6,4'),
      label: p => p.NAME || '', fields: ['NAME', 'COUNTRY', 'ADMINTYPE', 'ISO_CODE', 'AUTONOMOUS', 'DISPUTED'], legend: [['State / province border (dashed)', '#d6dde8']],
      desc: 'States, provinces, regions: land borders at every zoom, full detail from zoom 8.' },
    { id: 'fria', group: 'Remote ID', name: 'FAA-Recognized Identification Areas (FRIA)', minZoom: 7, cellSize: 1,
      source: 'faa', url: FAA + 'FAA_Recognized_Identification_Areas/FeatureServer/0', style: solid('#2ecc71', .25),
      label: p => p.title || p.orgName || 'FRIA', fields: ['title', 'orgName', 'address1', 'city', 'state', 'zipcode', 'startDate', 'endDate', 'refNumber'],
      legend: [['FRIA', '#2ecc71']], desc: 'Fly without Remote ID (VLOS).' },
    { id: 'uasfm', group: 'LAANC', name: 'UAS Facility Map (LAANC ceilings)', minZoom: 10,
      source: 'faa', url: FAA + 'FAA_UAS_FacilityMap_Data/FeatureServer/0', style: ceilingStyle,
      tiled: true, // grid squares that cover the area edge to edge: a point is in one of them
      label: p => `Ceiling ${p.CEILING} ${p.UNIT || 'ft'} AGL${p.APT1_NAME ? ' · ' + p.APT1_NAME : ''}`,
      fields: ['CEILING', 'UNIT', 'APT1_NAME', 'APT1_FAAID', 'APT1_LAANC', 'APT2_NAME', 'APT2_FAAID', 'AIRSPACE_1', 'AIRSPACE_2', 'MAP_EFF', 'LAST_EDIT'],
      legend: CEIL.map(([v, c]) => [v + ' ft', c]), desc: 'LAANC ceilings, ft AGL. 0 ft: coordination required.',
      subsets: { key: p => String(ceilingBucket(p.CEILING)), items: CEIL.map(([v, c]) => [String(v), v + ' ft', c]) } },
    { id: 'classAirspace', group: 'Airspace', name: 'Class B / C / D / E airspace', minZoom: 7, levels: DETAIL,
      source: 'faa', url: FAA + 'Class_Airspace/FeatureServer/0', style: classStyle,
      // A Class B or C is several sectors (shelves) with the same name: the sector and its floor tell them apart.
      label: p => [p.CLASS ? 'Class ' + p.CLASS : (p.LOCAL_TYPE || 'Airspace'), p.NAME || '', p.SECTOR ? cap(p.SECTOR) : '', altRange(p)].filter(Boolean).join(' · '),
      fields: ['NAME', 'CLASS', 'SECTOR', 'LOCAL_TYPE', 'LOWER_DESC', 'UPPER_DESC', 'ICAO_ID', 'COMM_NAME', 'WKHR_RMK'],
      queryFields: ['LOWER_VAL', 'LOWER_UOM', 'LOWER_CODE', 'UPPER_VAL', 'UPPER_UOM', 'UPPER_CODE'],
      rows: p => [['Floor', floorOf(p)], ['Ceiling', ceilingOf(p)]],
      rev: 1, // cells stored before the altitudes were requested are fetched again
      legend: CLASS_ITEMS.map(i => i.slice(1)), desc: 'Drawn as on VFR sectional charts.',
      subsets: { key: classKind, items: CLASS_ITEMS, other: 'Other classes' } },
    { id: 'sua', group: 'Airspace', name: 'Special Use Airspace (R, W, MOA, A, NSA)', minZoom: 6, levels: DETAIL,
      source: 'faa', url: FAA + 'Special_Use_Airspace/FeatureServer/0', style: suaStyle,
      // an area can be several parts with the same name at other altitudes (R-2934: from the surface, and above 1,200 ft)
      label: p => [`${p.NAME || ''} (${p.TYPE_CODE || ''})`, altRange(p)].filter(Boolean).join(' · '), fields: ['NAME', 'TYPE_CODE', 'LOWER_DESC', 'UPPER_DESC', 'TIMESOFUSE', 'CONT_AGENT', 'COMM_NAME', 'REMARKS'],
      queryFields: ['LOWER_VAL', 'LOWER_UOM', 'LOWER_CODE', 'UPPER_VAL', 'UPPER_UOM', 'UPPER_CODE'],
      rows: p => [['Floor', floorOf(p)], ['Ceiling', ceilingOf(p)]],
      rev: 1,
      legend: SUA_ITEMS.map(i => i.slice(1)), desc: 'Drawn as on VFR sectional charts.',
      subsets: { key: p => (p.TYPE_CODE || '').trim().toUpperCase(), items: SUA_ITEMS, other: 'Other types' } },
    { id: 'prohibited', group: 'Airspace', name: 'Prohibited Areas', minZoom: 6, levels: DETAIL,
      source: 'faa', url: FAA + 'Prohibited_Areas/FeatureServer/0', style: () => Object.assign({ opacity: .9 }, SUA_STYLE.P),
      label: p => `${p.NAME || 'Prohibited'} ${feetDesc(p)}`, fields: ['NAME', 'LOWER_DESC', 'UPPER_DESC', 'TIMESOFUSE', 'CONT_AGENT', 'REMARKS'], legend: [['Prohibited', BLUE, 'comb']] },
    { id: 'nsufr', group: 'UAS restrictions', name: 'National Security UAS Flight Restrictions (full-time)', minZoom: 7, levels: DETAIL,
      source: 'faa', url: FAA + 'DoD_Mar_13/FeatureServer/0', style: hatched('#e53935'),
      label: p => `${String(p.Facility || '').trim() || p.Base || 'NSUFR'} · ${p.Floor || 'SFC'}–${p.Ceiling || '400 ft'}`, fields: ['Facility', 'Base', 'Branch', 'Proponent', 'Reason', 'Floor', 'Ceiling', 'FAA_ID', 'State', 'POC'],
      legend: [['NSUFR 24/7', '#e53935']], desc: 'No UAS, surface to 400 ft AGL, 24/7.' },
    { id: 'nsufrPart', group: 'UAS restrictions', name: 'National Security UAS Flight Restrictions (part-time)', minZoom: 7, levels: DETAIL,
      source: 'faa', url: FAA + 'Part_Time_National_Security_UAS_Flight_Restrictions/FeatureServer/0', style: hatched('#fb8c00'),
      label: p => `${String(p.Facility || '').trim() || p.Base || 'Part-time NSUFR'} · ${p.ALERTYPE || ''}`, fields: ['Facility', 'Base', 'Reason', 'Floor', 'Ceiling', 'ALERTYPE', 'ACTIVETIME', 'ENDTIME', 'ADVISENOTE', 'FAA_ID'],
      legend: [['Part-time NSUFR', '#fb8c00']], desc: 'Active during announced periods.',
      subsets: { key: p => (p.ALERTYPE || '').trim() ? 'alert' : 'none', items: [['alert', 'With an active alert / schedule', '#fb8c00'], ['none', 'No current alert', '#fb8c00']] } },
    { id: 'nsufrPending', group: 'UAS restrictions', name: 'Pending National Security UAS Flight Restrictions', minZoom: 7, levels: DETAIL,
      source: 'faa', url: FAA + 'UAS_NSR_Pending/FeatureServer/0', style: hatched('#8e24aa'),
      label: p => `${String(p.Facility || '').trim() || p.Base || 'Pending NSUFR'}`, fields: ['Facility', 'Base', 'Branch', 'Reason', 'Floor', 'Ceiling', 'FAA_ID'], legend: [['Pending NSUFR', '#8e24aa']] },
    { id: 'ndaTfr', group: 'UAS restrictions', name: 'National Defense Airspace TFR areas', minZoom: 7, levels: DETAIL,
      source: 'faa', url: FAA + 'National_Defense_Airspace_TFR_Areas/FeatureServer/0', style: hatched('#6d4c41'),
      label: p => p.NAME || 'NDA TFR', fields: ['NAME', 'TYPE_CODE', 'LOCAL_TYPE', 'WKHR_RMK', 'CITY', 'STATE'], legend: [['NDA TFR', '#6d4c41']] },
    { id: 'recSites', group: 'Sites', name: 'Recreational Flyer Fixed Sites', minZoom: 8, levels: DETAIL,
      source: 'faa', url: FAA + 'Recreational_Flyer_Fixed_Sites/FeatureServer/0', style: solid('#00897b', .2),
      label: p => `${p.SITE_NAME || 'Fixed site'} · ceiling ${p.CEILING || '?'} ${p.UNIT || 'ft'}`, fields: ['SITE_NAME', 'SITE_ID', 'CEILING', 'UNIT', 'CITY', 'STATE', 'POC'], legend: [['Fixed site', '#00897b']] },
    { id: 'stadiums', group: 'Sites', name: 'Stadiums (3 NM TFR during events)', minZoom: 7, cellSize: 1, point: true,
      source: 'faa', url: FAA + 'Stadiums/FeatureServer/0', style: () => ({ radius: 6, color: '#fff', weight: 1.5, fillColor: '#ef6c00', fillOpacity: .95 }),
      icon: () => stadiumIcon(), iconSize: 22,
      label: p => p.NAME || 'Stadium', fields: ['NAME', 'CITY', 'STATE', 'STATUS_CODE'], legend: [['Stadium', '#ef6c00']], desc: '3 NM TFR during major events.' },
    { id: 'airports', group: 'Sites', name: 'Airports', minZoom: 9, cellSize: 1, point: true,
      source: 'faa', url: FAA + 'US_Airport/FeatureServer/0',
      style: p => {
        const priv = p.PRIVATEUSE === 'Y' || p.PRIVATEUSE === 1 || p.PRIVATEUSE === '1';
        const towered = !priv && MB.freqs && MB.freqs.index && MB.freqs.hasTower(p);
        return { radius: towered ? 6 : 5, color: '#fff', weight: 1.2, fillColor: priv ? '#78909c' : (towered ? '#1f5fd6' : '#c2185b'), fillOpacity: .95 };
      },
      // Sectional-chart conventions: blue = towered, magenta = non-towered, grey = private; H = heliport, anchor = seaplane base.
      icon: p => airportIcon(p), iconSize: 22,
      label: p => `${p.NAME || ''} (${p.IDENT || p.ICAO_ID || ''})`, fields: ['NAME', 'IDENT', 'ICAO_ID', 'TYPE_CODE', 'ELEVATION', 'PRIVATEUSE', 'OPERSTATUS', 'SERVCITY', 'STATE'],
      legend: [['Towered', '#1f5fd6'], ['Non-towered', '#c2185b'], ['Private', '#78909c'], ['H = heliport', '#c2185b']],
      subsets: { key: p => (p.PRIVATEUSE === 'Y' || p.PRIVATEUSE === 1 || p.PRIVATEUSE === '1') ? 'private' : 'public', items: [['public', 'Public use', '#37474f'], ['private', 'Private use', '#78909c']] },
      popupExtra: p => MB.freqs.ensure().then(() => MB.freqs.popupHtml(p)),
      onEnable: () => MB.freqs.ensure(), extraStatus: () => MB.freqs.statusLine(),
      desc: 'Click for radio frequencies. Chart colors: blue towered, magenta non-towered.' }
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
      const mpane = MB.map.createPane('mb-data-markers'); // icon markers above the data canvas, below user objects
      mpane.style.zIndex = 360;
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
      setTimeout(() => this.sweepLegacy().then(n => { if (n) MB.emit('data'); }).catch(() => {}), 20000); // once start-up has settled
    },

    buildSets() {
      const custom = ((MB.settings && MB.settings.dataServices) || []).map(c => ({
        id: 'custom:' + c.id, group: 'Custom ArcGIS layers', source: 'custom', name: c.name, url: c.url.replace(/\/query.*$/, '').replace(/\/$/, ''), minZoom: +c.minZoom || 8,
        point: !!c.point, custom: true, style: () => ({ color: c.color || '#4f8cff', weight: 2, opacity: .9, fillColor: c.color || '#4f8cff', fillOpacity: .15, radius: 6 }),
        label: p => firstText(p), fields: null, legend: [[c.name, c.color || '#4f8cff']]
      }));
      const all = MB.dataCatalog.concat(custom);
      const keep = {};
      all.forEach(def => {
        const prev = this.sets[def.id];
        keep[def.id] = prev ? Object.assign(prev, { def }) : { def, enabled: false, meta: null, group: null, cells: new Map(), feats: new Map(), failed: new Set(), loading: new Set(), status: '', error: null };
      });
      Object.keys(this.sets).forEach(id => { if (!keep[id] && this.sets[id].enabled) this.disable(id); });
      this.sets = keep;
      Object.keys(this.sets).forEach(id => { if (!this.sets[id].off) this.sets[id].off = new Set(); });
      Object.keys(this.sets).forEach(id => { if (!this.sets[id].failed) this.sets[id].failed = new Set(); });
      MB.emit('data');
    },

    // Persisted entry for a dataset: { on: true, off: ['E', ...] } (older projects stored `true`).
    stateFor(id) {
      MB.state.dataLayers = MB.state.dataLayers || {};
      let e = MB.state.dataLayers[id];
      if (e === true || !e || typeof e !== 'object') e = { on: !!e, off: [] };
      // Class E was one subset, 'E', before it was split by floor (ESFC, E700, E1200): hiding it hid every floor.
      if (id === 'classAirspace' && Array.isArray(e.off) && e.off.includes('E')) {
        e.off = Array.from(new Set(e.off.filter(k => k !== 'E').concat(['ESFC', 'E700', 'E1200'])));
      }
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
      applyFilter(ds);
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
      applyFilter(ds);
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
      if (ds && this.picked && this.picked.ds === ds) this.pick(null);
      if (!ds || !ds.enabled) return;
      ds.enabled = false;
      if (ds.group) { MB.map.removeLayer(ds.group); ds.group.clearLayers(); }
      ds.bordersDirty = true; // its border lines were cleared with the rest
      ds.cells.forEach(c => { c.shown = false; });
      ds.feats.forEach(e => { e.refs = 0; });
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
        const e = want[id] === undefined ? undefined : this.stateFor(id);
        const on = e === undefined ? !!this.sets[id].def.defaultOn : (e === true || (e && e.on));
        if (on && !this.sets[id].enabled) this.enable(id);
        else if (!on && this.sets[id].enabled) this.disable(id);
        else if (on) { const ds = this.sets[id]; ds.off = new Set((e && e.off) || []); applyFilter(ds); }
      });
      MB.emit('data');
    },

    applyOpacity() {
      ['mb-data', 'mb-data-markers'].forEach(name => { const pane = MB.map.getPane(name); if (pane) pane.style.opacity = this.settings.opacity; });
    },

    saveSettings() {
      MB.settings.data = Object.assign({}, this.settings);
      MB.saveSettings();
      if (MB.autosave) MB.autosave(); // the project records the data opacity
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
      forget(ds);
      const keys = await DB.keys('cells') || [];
      for (const k of keys) if (String(k).startsWith(ds.def.id + '|')) await DB.del('cells', k);
    },

    async clearCache() {
      for (const ds of this.catalog()) { forget(ds); ds.meta = null; }
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
      return { idx: 0, whole: false, cellSize: def.cellSize || CELL, offset: 0 };
    },

    refresh() {
      const zoom = MB.map.getZoom(), bounds = MB.map.getBounds();
      this.catalog().forEach(ds => {
        if (!ds.enabled || ds.checking) return; // wait until the update stamp is known before caching anything
        if (zoom < ds.def.minZoom || zoom > (ds.def.maxZoom == null ? Infinity : ds.def.maxZoom)) {
          ds.status = zoom < ds.def.minZoom ? 'Zoom in to level ' + ds.def.minZoom + ' or closer to load' : 'Shown up to zoom ' + ds.def.maxZoom;
          ds.cells.forEach(c => hideCell(ds, c));
          return;
        }
        const level = this.levelFor(ds.def, zoom);
        const max = ds.def.maxCells || MAX_CELLS;
        const cells = level.whole ? [{ key: 'all', bounds: L.latLngBounds([-90, -180], [90, 180]) }] : cellsFor(bounds, level.cellSize, max);
        if (cells.length > max) { ds.status = 'View too large: zoom in'; return; }
        const prefix = 'L' + level.idx + ':';
        cells.forEach(cell => {
          const c = ds.cells.get(prefix + cell.key);
          if (c) c.used = Date.now();
          else this.loadCell(ds, cell, level);
        });
        this.settle(ds);
        // LRU eviction of hidden cells
        if (ds.cells.size > MAX_CACHED_LAYERS) {
          const hidden = Array.from(ds.cells.entries()).filter(([, c]) => !c.shown).sort((a, b) => a[1].used - b[1].used);
          hidden.slice(0, ds.cells.size - MAX_CACHED_LAYERS).forEach(([k, c]) => { dropCell(ds, c); ds.cells.delete(k); });
        }
        if (!ds.loading.size && !ds.error) ds.status = level.whole && level.offset ? 'overview (generalized): zoom in for full detail' : '';
      });
      MB.emit('data');
    },

    // Decide which loaded cells are on the map for the current view. One detail level is shown at a time: while
    // cells of another level are still up (a zoom threshold was just crossed), this level's cells wait and the two
    // are exchanged in one step, so the layer is neither blank nor drawn (and identified) twice in between.
    settle(ds) {
      if (!ds.enabled || !ds.group) return;
      const zoom = MB.map.getZoom(), view = MB.map.getBounds();
      if (zoom < ds.def.minZoom || zoom > (ds.def.maxZoom == null ? Infinity : ds.def.maxZoom)) { ds.cells.forEach(c => hideCell(ds, c)); return; }
      const level = this.levelFor(ds.def, zoom), prefix = 'L' + level.idx + ':';
      const max = ds.def.maxCells || MAX_CELLS;
      const cells = level.whole ? [{ key: 'all' }] : cellsFor(view, level.cellSize, max);
      if (cells.length > max) return; // view too large for this dataset: leave what is shown
      const need = cells.map(c => prefix + c.key), needed = new Set(need);
      // out of view: this level's cells at once, another level's as soon as they no longer touch the view
      ds.cells.forEach((c, key) => { if (c.shown && !needed.has(key) && (key.startsWith(prefix) || !view.intersects(c.bounds))) hideCell(ds, c); });
      const other = [];
      ds.cells.forEach((c, key) => { if (c.shown && !key.startsWith(prefix)) other.push(c); });
      // a cell that failed counts as settled: it must not hold the exchange up (it is asked for again on the next move)
      const settled = need.every(k => ds.cells.has(k) || ds.failed.has(k));
      if (other.length && !settled) return;
      other.forEach(c => hideCell(ds, c));
      need.forEach(k => { const c = ds.cells.get(k); if (c) showCell(ds, c); });
      // an error is about the view on screen: once everything it needs is loaded and current, a failure elsewhere is history
      if (need.every(k => ds.cells.has(k) && !ds.cells.get(k).stale)) ds.error = null;
    },

    async loadCell(ds, cell, level) {
      level = level || this.levelFor(ds.def, MB.map.getZoom());
      const memKey = 'L' + level.idx + ':' + cell.key;
      const key = ds.def.id + '|r' + CACHE_REV + '|' + memKey;
      if (ds.loading.has(key)) return;
      ds.loading.add(key);
      ds.failed.delete(memKey);
      ds.status = 'Loading…';
      MB.emit('data');
      const meta = await this.loadMeta(ds);
      const maxAge = this.settings.maxAgeDays * 86400 * 1000;
      let geojson = null, fromCache = false, stale = false;
      try {
        const cached = await DB.get('cells', key);
        // A cell is used only with the same service data and the same fields as the cells fetched now: a cached cell
        // with other attributes would register the polygons it shares with its neighbours a second time.
        if (cached && cached.lastEdit === meta.lastEdit && (cached.rev || 0) === (ds.def.rev || 0) && Date.now() - cached.ts < maxAge) { geojson = cached.geojson; fromCache = true; }
        if (!geojson) {
          try {
            geojson = await queryCell(ds.def.url, cell, ds.def.fields && ds.def.fields.concat(ds.def.queryFields || []), level);
            await DB.set('cells', key, { ts: Date.now(), lastEdit: meta.lastEdit, rev: ds.def.rev || 0, geojson });
          } catch (e) {
            // Offline or the service failed: anything stored for this area will do, including what an earlier
            // version saved with an offline area.
            // Only a cell like the ones fetched now (same fields, same service data): any other would sit next to
            // current cells with other attributes, its shared features registered and listed twice. Cells stored by
            // earlier versions have the fields of revision 0.
            const rev = ds.def.rev || 0;
            const old = cached ? ((cached.rev || 0) === rev && (cached.lastEdit === meta.lastEdit || meta.lastEdit === 'offline') ? cached : null)
              : (rev ? null : await legacyCell(ds, cell, memKey, level));
            if (old && old.geojson) { geojson = old.geojson; fromCache = stale = true; ds.error = 'Offline or service error: showing cached data.'; }
            else { ds.error = 'Load failed: ' + e.message; }
          }
        }
      } finally { ds.loading.delete(key); }
      if (geojson) {
        const prev = ds.cells.get(memKey);
        if (prev) dropCell(ds, prev); // loaded again (offline pre-loading, a retry): replace, never stack
        ds.cells.set(memKey, { keys: registerCell(ds, geojson, level), bounds: cell.bounds, shown: false, used: Date.now(), fromCache, stale, n: (geojson.features || []).length });
      } else ds.failed.add(memKey);
      this.settle(ds);
      if (!ds.loading.size) ds.status = ds.error ? '' : '';
      MB.emit('data');
    },

    // Cells stored by earlier versions (keys without a revision) are full detail and several megabytes each. They
    // only still serve as the fallback for an offline area saved with its data; without one, remove them.
    async sweepLegacy() {
      if (MB.offline && (MB.offline.areas || []).some(a => a.dataCells)) return 0;
      const keys = (await DB.keys('cells') || []).filter(k => /^[^|]+\|L\d+:/.test(String(k)));
      for (const k of keys) await DB.del('cells', k);
      return keys.length;
    },

    featureCount(ds) { let n = 0; if (ds.group) ds.feats.forEach(e => { if (e.refs > 0 && (ds.def.borders || ds.group.hasLayer(e.layer))) n++; }); return n; }
  };
  MB.data.refreshSoon = MB.debounce(() => MB.data.refresh(), 350);
  MB.data.cellsFor = cellsFor;
  MB.data.db = DB;

  // Re-style every loaded feature of a dataset (used when derived info such as frequencies arrives later).
  MB.data.restyle = function (id) {
    const ds = MB.data.sets[id];
    if (!ds || !ds.def.style) return;
    ds.feats.forEach(e => {
      const l = e.layer;
      if (l.setIcon && ds.def.icon && l.feature) l.setIcon(makeIcon(ds.def, l.feature.properties));
      else if (l.setStyle && l.feature) l.setStyle(ds.def.style(l.feature.properties || {}));
    });
  };

  function cellsFor(bounds, size, max) {
    size = size || CELL; max = max || MAX_CELLS;
    const out = [];
    const s = Math.max(-90, Math.floor(bounds.getSouth() / size) * size), n = Math.min(90, bounds.getNorth());
    const w = Math.max(-180, Math.floor(bounds.getWest() / size) * size), e = Math.min(180, bounds.getEast());
    for (let lat = s; lat < n; lat += size) {
      for (let lng = w; lng < e; lng += size) {
        const la = +lat.toFixed(2), lo = +lng.toFixed(2);
        out.push({ key: la + '_' + lo, bounds: L.latLngBounds([la, lo], [la + size, lo + size]) });
        if (out.length > max + 1) return out;
      }
    }
    return out;
  }

  /* ----- request scheduling -----
   * The FAA services meter all of their users against one quota (x-esri-org-request-units-per-min). When it is
   * used up a query answers "429 ... Retry after N sec", often inside an HTTP 200. Queries therefore run a few at
   * a time, and a 429 pauses every query to that host until the stated time; they are then tried again instead
   * of leaving a hole in the map. */
  const net = { active: 0, queue: [], pausedUntil: {}, timer: null };
  const hostOf = url => { try { return new URL(url).host; } catch (e) { return ''; } };

  function throttled(host, task) {
    return new Promise((resolve, reject) => { net.queue.push({ host, task, resolve, reject, tries: 0 }); pump(); });
  }
  function pump() {
    while (net.active < MAX_ACTIVE && net.queue.length) {
      const now = Date.now();
      const i = net.queue.findIndex(j => !(net.pausedUntil[j.host] > now));
      if (i < 0) { // everything waiting is paused: wake when the first pause ends
        const wake = Math.min.apply(null, net.queue.map(j => net.pausedUntil[j.host]));
        clearTimeout(net.timer);
        net.timer = setTimeout(pump, Math.max(50, wake - now));
        return;
      }
      const job = net.queue.splice(i, 1)[0];
      net.active++;
      job.task().then(job.resolve, err => {
        if (err && err.retryAfter && job.tries < 3) {
          job.tries++;
          net.pausedUntil[job.host] = Date.now() + err.retryAfter * 1000;
          net.queue.unshift(job);
          MB.emit('data'); // the panel says what is being waited for
        } else job.reject(err);
      }).finally(() => { net.active--; pump(); });
    }
  }
  // Seconds until queries to this dataset's service resume, or 0.
  MB.data.pausedFor = ds => Math.max(0, Math.ceil(((net.pausedUntil[hostOf(ds.def.url)] || 0) - Date.now()) / 1000));

  async function fetchJson(u) {
    const r = await fetch(u);
    let j = null;
    try { j = await r.json(); } catch (e) { /* not JSON */ }
    const err = j && j.error;
    if (r.status === 429 || (err && +err.code === 429)) {
      const text = err ? [err.message].concat(err.details || []).join(' ') : '';
      const m = /retry after (\d+)/i.exec(text);
      const e = new Error('the service is over its request quota');
      e.retryAfter = Math.min(120, +(m ? m[1] : (r.headers.get('Retry-After') || 60)) || 60) + Math.random() * 3; // jitter: do not all return at once
      throw e;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (!j) throw new Error('unreadable response');
    if (err) throw new Error(err.message || 'service error');
    return j;
  }

  // Decimal places worth sending for a given generalization tolerance (degrees): one digit finer than the tolerance.
  function precisionFor(offset) {
    if (!offset) return '6';
    return offset >= 0.01 ? '3' : (offset >= 0.001 ? '4' : (offset >= 0.0001 ? '5' : '6'));
  }

  async function queryCell(url, cell, fields, level) {
    const b = cell.bounds;
    const features = [];
    let offset = 0;
    for (let page = 0; page < 30; page++) {
      const p = new URLSearchParams({
        where: '1=1', outFields: fields ? fields.join(',') : '*', outSR: '4326', geometryPrecision: precisionFor(level && level.offset), f: 'geojson',
        resultOffset: String(offset), resultRecordCount: '2000'
      });
      if (!(level && level.whole)) {
        p.set('geometry', [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(','));
        p.set('geometryType', 'esriGeometryEnvelope'); p.set('inSR', '4326'); p.set('spatialRel', 'esriSpatialRelIntersects');
      }
      if (level && level.offset) p.set('maxAllowableOffset', String(level.offset));
      const j = await throttled(hostOf(url), () => fetchJson(url + '/query?' + p.toString()));
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
    const row = (k, v) => v ? `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>` : '';
    let rows = keys.map(k => row(k, fmtVal(k, p[k]))).join('');
    if (ds.def.rows) { try { rows += ds.def.rows(p).map(([k, v]) => row(k, v)).join(''); } catch (e) { /* ignore */ } }
    return `<div class="mb-popup"><div class="mb-popup-title">${esc(ds.def.name)}</div><table class="mb-datatable">${rows}</table></div>`;
  }

  // What an earlier version stored for this area: keys without a revision, kept only for an offline area saved
  // with its data. Boundary and custom layers used the cells they use now; FAA data was a single full-detail level
  // of 0.5 degree cells ("L0"), so a larger cell is put together from the old ones inside it.
  async function legacyCell(ds, cell, memKey, level) {
    const features = [];
    let found = false;
    const take = rec => { if (rec && rec.geojson && Array.isArray(rec.geojson.features)) { found = true; for (const f of rec.geojson.features) features.push(f); } };
    take(await DB.get('cells', ds.def.id + '|' + memKey));
    if (!level.whole && level.cellSize <= 2) {
      for (const sub of cellsFor(cell.bounds, CELL)) take(await DB.get('cells', ds.def.id + '|L0:' + sub.key));
    }
    return found ? { geojson: { type: 'FeatureCollection', features } } : null; // a feature in several of them is registered once
  }

  /* ----- feature registry -----
   * A polygon that spans several cells comes back from each of their queries. Features therefore live once per
   * dataset in ds.feats (key -> { layer, cells, refs }): `cells` counts the loaded cells that contain the feature,
   * `refs` the shown ones. It is on the map while refs > 0 and its sub-element toggle is on, so it is built,
   * projected, drawn and identified exactly once however many cells it touches. */

  // Identity across cells: the attributes plus a cheap fingerprint of the geometry (the same feature at another
  // detail level has other vertices and is a different entry).
  function featureKey(f) {
    const g = f.geometry || {};
    let n = 0, sx = 0, sy = 0;
    const walk = a => {
      if (typeof a[0] === 'number') { n++; sx += a[0] * (n % 7 + 1); sy += a[1] * (n % 5 + 1); }
      else for (let i = 0; i < a.length; i++) walk(a[i]);
    };
    if (Array.isArray(g.coordinates)) walk(g.coordinates);
    return JSON.stringify(f.properties || {}) + '|' + g.type + '|' + n + '|' + sx.toFixed(4) + '|' + sy.toFixed(4);
  }

  // Build layers for the features of a cell that are not known yet; returns the keys of every feature in the cell.
  function registerCell(ds, geojson, level) {
    const keys = new Set(), fresh = [], keyOf = new Map();
    (geojson.features || []).forEach(f => {
      if (!f || !f.geometry) return;
      const k = featureKey(f);
      if (keys.has(k)) return;
      keys.add(k);
      const e = ds.feats.get(k);
      if (e) e.cells++; else { fresh.push(f); keyOf.set(f, k); }
    });
    if (fresh.length) {
      const built = buildGeoJson(ds, { type: 'FeatureCollection', features: fresh });
      const layers = built.getLayers();
      // Detach them from the group they were built in: Leaflet links each layer back to its group (event parent)
      // and the group to all of its layers, so one surviving feature would keep its evicted siblings in memory.
      built.clearLayers();
      layers.forEach(l => {
        const k = keyOf.get(l.feature);
        if (k) ds.feats.set(k, { layer: l, cells: 1, refs: 0, level: level ? level.idx : 0, offset: level ? level.offset : 0 });
      });
      if (ds.def.borders) ds.bordersDirty = true;
    }
    return Array.from(keys).filter(k => ds.feats.has(k)); // a geometry Leaflet could not build has no entry
  }

  function sync(ds, e) {
    if (!ds.group) return;
    if (ds.def.borders) { scheduleBorders(ds); return; } // drawn as shared edges, not as the polygons themselves
    const on = ds.group.hasLayer(e.layer);
    const want = e.refs > 0 && !(ds.def.subsets && ds.off.has(MB.data.subsetKey(ds, e.layer.feature && e.layer.feature.properties)));
    if (want && !on) ds.group.addLayer(e.layer);
    else if (!want && on) ds.group.removeLayer(e.layer);
  }
  function showCell(ds, c) {
    if (c.shown) return;
    c.shown = true;
    c.keys.forEach(k => { const e = ds.feats.get(k); if (e) { e.refs++; sync(ds, e); } });
  }
  function hideCell(ds, c) {
    if (!c.shown) return;
    c.shown = false;
    c.keys.forEach(k => { const e = ds.feats.get(k); if (e) { e.refs--; sync(ds, e); } });
  }
  // Forget a cell: its features go too once no other loaded cell contains them.
  function dropCell(ds, c) {
    hideCell(ds, c);
    c.keys.forEach(k => { const e = ds.feats.get(k); if (e && --e.cells <= 0) { ds.feats.delete(k); ds.bordersDirty = true; } });
  }
  function forget(ds) {
    if (ds.group) ds.group.clearLayers();
    ds.borderLines = null; ds.bordersShown = null; ds.bordersDirty = true;
    ds.cells.clear();
    ds.feats.clear();
    ds.failed.clear();
  }
  // Apply the dataset's sub-element toggles to what is on the map.
  function applyFilter(ds) { ds.feats.forEach(e => sync(ds, e)); }

  /* ----- land borders: the edges two neighbouring polygons share -----
   * For a dataset with `borders` (a function naming a feature's side: its country, its state), the polygons are
   * not drawn. Each edge of a polygon that lies along another polygon of a different side becomes part of a border
   * line between the two; edges along nothing (coastlines) are dropped. Neighbours simplified separately do not
   * share vertices any more, so "along" is judged within a tolerance of a few times the simplification. Each border
   * is drawn once for its pair, and hovering it names both sides. */
  function scheduleBorders(ds) {
    if (ds.bordersTimer) return;
    ds.bordersTimer = setTimeout(() => { ds.bordersTimer = null; updateBorders(ds); }, 30);
  }

  function polygonsOf(g) {
    if (!g) return [];
    if (g.type === 'Polygon') return [g.coordinates];
    if (g.type === 'MultiPolygon') return g.coordinates;
    return [];
  }

  // Shared edges of the shown features of one detail level, as polylines per pair of sides.
  function buildBorders(ds, entries, offset) {
    const def = ds.def;
    const eps = Math.max(2.5 * offset, 2e-5);                // degrees
    const G = Math.max(eps * 2, 0.02);                       // index cell, degrees
    const items = entries.map((e, i) => {
      const p = (e.layer.feature && e.layer.feature.properties) || {};
      // rings smaller than the shortest border stretch (1.5 tolerances) are dropped: sub-pixel at the zooms that tolerance serves (most of a
      // simplified world dataset is such islets), and too small to hold a border
      const big = ring => { let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const c of ring) { if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; } return Math.hypot(x1 - x0, y1 - y0) >= 1.5 * eps; }; // the shortest stretch matching accepts
      return { i, side: def.borders(p), label: def.label ? String(def.label(p)) : '', rings: polygonsOf(e.layer.feature && e.layer.feature.geometry).flat().filter(big) };
    });
    // The grid cells an edge passes through, widened by eps (numeric keys). A short edge takes the cells of its
    // widened box; a long one is sampled along its length, so it is in every cell along it (not in its whole bounding
    // box) and the index stays proportional to the outlines' length.
    const key = (gx, gy) => (gx + 4096) * 8192 + (gy + 4096);
    const cellsAlong = (a, b) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]), keys = new Set();
      const box = (xa, ya, xb, yb) => {
        const x0 = Math.floor((Math.min(xa, xb) - eps) / G), x1 = Math.floor((Math.max(xa, xb) + eps) / G);
        const y0 = Math.floor((Math.min(ya, yb) - eps) / G), y1 = Math.floor((Math.max(ya, yb) + eps) / G);
        for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) keys.add(key(gx, gy));
      };
      if (len <= G) box(a[0], a[1], b[0], b[1]);
      else {
        const n = Math.ceil(len / G);
        for (let k = 0; k < n; k++) box(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, a[0] + (b[0] - a[0]) * (k + 1) / n, a[1] + (b[1] - a[1]) * (k + 1) / n);
      }
      return Array.from(keys);
    };
    const grid = new Map();
    items.forEach(it => { it.edges = it.rings.map(ring => {
      const edges = [];
      for (let s = 1; s < ring.length; s++) {
        const v = { it, a: ring[s - 1], b: ring[s], keys: cellsAlong(ring[s - 1], ring[s]) }; // its cells, kept for the lookup below
        v.keys.forEach(k => { let arr = grid.get(k); if (!arr) grid.set(k, arr = []); arr.push(v); });
        edges.push(v);
      }
      return edges;
    }); });
    // Which stretch of edge AB runs along edge CD: the part of CD within eps of the line through AB, projected onto
    // AB (as parameters 0..1), or null. The two must run roughly the same way (within 25 degrees: a shared border
    // simplified on each side separately stays close to parallel), so edges that cross are never a border, however
    // shallow the crossing; and the stretch must be at least 1.5 eps long.
    const MAX_SIN = Math.sin(25 * Math.PI / 180);
    const alongStretch = (A, B, C, D) => {
      const ux = B[0] - A[0], uy = B[1] - A[1], L = Math.hypot(ux, uy);
      if (!L) return null;
      const vx = D[0] - C[0], vy = D[1] - C[1], M = Math.hypot(vx, vy);
      if (!M || Math.abs(ux * vy - uy * vx) / (L * M) > MAX_SIN) return null;
      const nx = -uy / L, ny = ux / L;
      const dC = (C[0] - A[0]) * nx + (C[1] - A[1]) * ny, dD = (D[0] - A[0]) * nx + (D[1] - A[1]) * ny, dd = dD - dC;
      let s0 = 0, s1 = 1;
      if (Math.abs(dd) < 1e-15) { if (Math.abs(dC) > eps) return null; }
      else { let lo = (-eps - dC) / dd, hi = (eps - dC) / dd; if (lo > hi) [lo, hi] = [hi, lo]; s0 = Math.max(0, lo); s1 = Math.min(1, hi); if (s0 >= s1) return null; }
      const t = s => (((C[0] + (D[0] - C[0]) * s) - A[0]) * ux + ((C[1] + (D[1] - C[1]) * s) - A[1]) * uy) / (L * L);
      let t0 = t(s0), t1 = t(s1);
      if (t0 > t1) [t0, t1] = [t1, t0];
      t0 = Math.max(0, t0); t1 = Math.min(1, t1);
      return (t1 - t0) * L > 1.5 * eps ? [t0, t1] : null;
    };
    // For each edge, the stretches along each neighbour of another side (merged), in order along the edge.
    let stamp = 0;
    const stretches = (it, edge) => {
      const a = edge.a, b = edge.b, byN = new Map(), mark = ++stamp;
      const minX = Math.min(a[0], b[0]) - eps, maxX = Math.max(a[0], b[0]) + eps, minY = Math.min(a[1], b[1]) - eps, maxY = Math.max(a[1], b[1]) + eps;
      for (const k of edge.keys) {
        const arr = grid.get(k);
        if (!arr) continue;
        for (const v of arr) {
          if (v.seen === mark || v.it === it || v.it.side === it.side) continue;
          v.seen = mark;
          // cheap rejection: boxes apart by more than eps
          if (Math.max(v.a[0], v.b[0]) < minX || Math.min(v.a[0], v.b[0]) > maxX || Math.max(v.a[1], v.b[1]) < minY || Math.min(v.a[1], v.b[1]) > maxY) continue;
          const r = alongStretch(a, b, v.a, v.b);
          if (r) { let rs = byN.get(v.it); if (!rs) byN.set(v.it, rs = []); rs.push(r); }
        }
      }
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, gap = eps / L, out = [];
      byN.forEach((arr, n) => {
        arr.sort((x, y) => x[0] - y[0]);
        let cur = null;
        arr.forEach(r => { if (cur && r[0] <= cur[1] + gap) cur[1] = Math.max(cur[1], r[1]); else { if (cur) out.push({ n, t0: cur[0], t1: cur[1] }); cur = r.slice(); } });
        if (cur) out.push({ n, t0: cur[0], t1: cur[1] });
      });
      return out.sort((x, y) => x.t0 - y.t0);
    };
    // Walk each ring, joining stretches along the same neighbour into lines; a pair is drawn from one side only.
    const pairs = new Map();
    items.forEach(it => it.edges.forEach(edges => {
      let run = null, runWith = null, runOpenEnd = false;
      const flush = () => { if (run && run.length > 1) { const key = it.side + '\u0000' + runWith.side; let p = pairs.get(key); if (!p) pairs.set(key, p = { a: it, b: runWith, lines: [] }); p.lines.push(run); } run = null; runWith = null; runOpenEnd = false; };
      for (const edge of edges) {
        const a = edge.a, b = edge.b, L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, near = eps / L;
        const at = t => [a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t]; // [lat, lng]
        let continued = false;
        for (const st of stretches(it, edge)) {
          if (it.side > st.n.side) continue; // drawn from the other side
          if (run && runWith === st.n && runOpenEnd && st.t0 <= near) run.push(at(st.t1)); // goes on from the previous edge
          else { flush(); runWith = st.n; run = [at(st.t0), at(st.t1)]; }
          runOpenEnd = st.t1 >= 1 - near;
          continued = true;
        }
        if (!continued || !runOpenEnd) flush();
      }
      flush();
    }));
    const style = def.style({}), casing = style.casing;
    const lines = [];
    pairs.forEach(p => {
      // the casing first (drawn under the line), solid, not clickable
      if (casing) lines.push(L.polyline(p.lines, Object.assign({ fill: false, lineJoin: 'round' }, casing, { pane: 'mb-data', renderer: dataRenderer(), pmIgnore: true, interactive: false })));
      const line = L.polyline(p.lines, Object.assign({}, style, { pane: 'mb-data', renderer: dataRenderer(), pmIgnore: true, interactive: true }));
      const names = [p.a.label, p.b.label].filter(Boolean);
      if (names.length) line.bindTooltip(names.join(' / '), { sticky: true, className: 'mb-name-tip', direction: 'top', opacity: .95 });
      lines.push(line);
    });
    return lines;
  }

  // Put the borders of what is shown now on the map (rebuilt when the shown features change).
  function updateBorders(ds) {
    if (!ds.group) return;
    const shown = [];
    ds.feats.forEach(e => { if (e.refs > 0) shown.push(e); });
    const sig = shown.length + ':' + shown.map(e => MB.data.registryId(e)).join(',');
    if (!ds.bordersDirty && sig === ds.bordersSig) return;
    ds.bordersDirty = false;
    ds.bordersSig = sig;
    (ds.bordersShown || []).forEach(l => ds.group.removeLayer(l));
    const byLevel = new Map();
    shown.forEach(e => { let a = byLevel.get(e.level); if (!a) byLevel.set(e.level, a = []); a.push(e); });
    const t0 = performance.now();
    let lines = [];
    byLevel.forEach(entries => { lines = lines.concat(buildBorders(ds, entries, entries[0].offset || 0)); });
    ds.bordersMs = Math.round(performance.now() - t0);
    lines.forEach(l => ds.group.addLayer(l));
    ds.bordersShown = lines;
  }
  // A stable id per registry entry (for knowing when the shown set changed).
  let regIds = new WeakMap(), regNext = 0;
  MB.data.registryId = e => { let id = regIds.get(e); if (id == null) regIds.set(e, id = ++regNext); return id; };

  // A Canvas renderer that also draws the two chart symbols Leaflet has no style for, inside a polygon's outline only
  // (clipped to it, so they never spill onto the neighbouring area): band: 'vignette', a band fading inward from the
  // outline, and band: 'comb', ticks along the inner side of the outline. Both in the style's color.
  const ChartCanvas = L.Canvas.extend({
    _fillStroke(ctx, layer) {
      const o = layer.options;
      L.Canvas.prototype._fillStroke.call(this, ctx, layer);
      if (o.band && layer instanceof L.Polygon) {
        ctx.save();
        ctx.clip(o.fillRule || 'evenodd'); // the outline is still the current path: filling and stroking keep it
        ctx.strokeStyle = o.color;
        ctx.setLineDash([]);
        if (o.band === 'comb') { // a tick every 8 px across the outline, 7 px each way: the half outside is clipped away
          ctx.beginPath();
          for (const part of layer._parts) {
            if (part.length < 2) continue;
            let distance = 0, nextTick = 4;
            for (let i = 0; i < part.length; i++) {
              const a = part[i], b = part[(i + 1) % part.length];
              const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
              while (length > 0 && nextTick < distance + length) {
                const along = nextTick - distance, x = a.x + dx * along / length, y = a.y + dy * along / length;
                const nx = -dy * 7 / length, ny = dx * 7 / length;
                ctx.moveTo(x - nx, y - ny);
                ctx.lineTo(x + nx, y + ny);
                nextTick += 8;
              }
              distance += length;
            }
          }
          ctx.lineCap = 'butt'; ctx.lineWidth = o.weight; ctx.globalAlpha = o.opacity; ctx.stroke();
        } else {                 // the outline three widths over each other: darkest at the outline
          ctx.lineJoin = 'round';
          for (const [w, a] of [[26, .1], [16, .13], [7, .17]]) { ctx.lineWidth = w; ctx.globalAlpha = a; ctx.stroke(); }
        }
        ctx.restore();
      }
    }
  });

  // One shared Canvas renderer for every data layer: thousands of features become a single bitmap instead of
  // thousands of SVG nodes, which roughly halves paint and zoom cost and keeps the DOM small.
  function dataRenderer() {
    if (!MB.data.renderer) MB.data.renderer = new ChartCanvas({ pane: 'mb-data', padding: 0.5, tolerance: 3 });
    return MB.data.renderer;
  }
  MB.data.dataRenderer = dataRenderer;

  /* ----- chart-style icons for point datasets ----- */
  function airportIcon(p) {
    const priv = p.PRIVATEUSE === 'Y' || p.PRIVATEUSE === 1 || p.PRIVATEUSE === '1';
    const towered = !priv && MB.freqs && MB.freqs.index && MB.freqs.hasTower(p);
    const c = priv ? '#78909c' : (towered ? '#1f5fd6' : '#c2185b');
    const type = (p.TYPE_CODE || '').toUpperCase();
    const ring = `<circle cx="12" cy="12" r="9" fill="rgba(255,255,255,.92)" stroke="${c}" stroke-width="2.3"/>`;
    if (type === 'HP' || type === 'HELIPORT') return `<svg viewBox="0 0 24 24">${ring}<text x="12" y="16.5" text-anchor="middle" font-size="12" font-weight="700" fill="${c}" font-family="system-ui,sans-serif">H</text></svg>`;
    if (type === 'SP' || type === 'SEAPLANE') return `<svg viewBox="0 0 24 24">${ring}<path d="M12 6.5v10M8 10h8M7.5 13c0 3 2 4.5 4.5 4.5s4.5-1.5 4.5-4.5" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"/></svg>`;
    if (type === 'GL' || type === 'GLIDERPORT') return `<svg viewBox="0 0 24 24">${ring}<path d="M5 12h14M12 9v6" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"/></svg>`;
    if (type === 'UL' || type === 'ULTRALIGHT') return `<svg viewBox="0 0 24 24">${ring}<text x="12" y="16.5" text-anchor="middle" font-size="11" font-weight="700" fill="${c}" font-family="system-ui,sans-serif">U</text></svg>`;
    // airport: ring with a runway bar; towered airports get the chart's outer tick marks
    const ticks = towered ? '<path d="M12 1v3M12 20v3M1 12h3M20 12h3" stroke="' + c + '" stroke-width="2"/>' : '';
    return `<svg viewBox="0 0 24 24">${ticks}${ring}<rect x="4.5" y="10.4" width="15" height="3.2" rx="1.2" fill="${c}" transform="rotate(-35 12 12)"/></svg>`;
  }
  function stadiumIcon() {
    return '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="10" ry="6.5" fill="rgba(255,255,255,.92)" stroke="#ef6c00" stroke-width="2.3"/><rect x="7.5" y="9.3" width="9" height="5.4" rx="1" fill="none" stroke="#ef6c00" stroke-width="1.6"/><path d="M12 9.3v5.4" stroke="#ef6c00" stroke-width="1.4"/></svg>';
  }
  function makeIcon(def, p) {
    const s = def.iconSize || 22;
    return L.divIcon({ className: 'mb-data-icon', html: def.icon(p || {}), iconSize: [s, s], iconAnchor: [s / 2, s / 2] });
  }

  function buildGeoJson(ds, geojson) {
    const def = ds.def;
    const renderer = dataRenderer();
    return L.geoJSON(geojson, {
      pane: 'mb-data', pmIgnore: true, renderer,
      style: f => def.style(f.properties || {}),
      pointToLayer: (f, ll) => def.icon
        ? L.marker(ll, { icon: makeIcon(def, f.properties), pane: 'mb-data-markers', pmIgnore: true, keyboard: false })
        : L.circleMarker(ll, Object.assign({ pane: 'mb-data', pmIgnore: true, renderer }, def.style(f.properties || {}))),
      onEachFeature: (f, layer) => {
        const p = f.properties || {};
        layer.options.pmIgnore = true;
        const lbl = def.label ? def.label(p) : firstText(p);
        if (lbl) layer.bindTooltip(String(lbl), { sticky: true, className: 'mb-name-tip', direction: 'top', opacity: .95 });
        layer.on('click', e => {
          const t = MB.tools.current;
          if (t !== 'select' && t !== 'move' && t !== 'present') return;
          L.DomEvent.stopPropagation(e);
          MB.data.identify(e.latlng, e.containerPoint, layer);
        });
      }
    });
  }

  /* ---------- identify: everything under a click in one popup ---------- */

  // Is a layer point inside a polygon's filled area (not merely within the click tolerance of its outline)?
  function inside(l, p) {
    if (!l._parts || !l._rawPxBounds || !l._rawPxBounds.contains(p)) return false;
    let into = false;
    for (const part of l._parts) {
      for (let j = 0, k = part.length - 1; j < part.length; k = j++) {
        const a = part[j], b = part[k];
        if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) into = !into;
      }
    }
    return into;
  }
  // Does a click at this point concern the layer? Points within a few pixels; lines and outlines within the click
  // tolerance; for a tiled dataset, only the square the point is in (a tap near an edge is not also its neighbour).
  function hitTest(ds, l, lp, cp) {
    try {
      if (l.getLatLng) return MB.map.latLngToContainerPoint(l.getLatLng()).distanceTo(cp) <= 14;
      if (ds.def.tiled && l instanceof L.Polygon) return inside(l, lp);
      return !!(l._containsPoint && l._pxBounds && l._pxBounds.contains(lp) && l._containsPoint(lp));
    } catch (err) { return false; }
  }

  // Features of every enabled dataset at this point (polygons containing it, lines/points within a few pixels), top-most first.
  MB.data.featuresAt = function (latlng, containerPoint) {
    const map = MB.map;
    const lp = map.latLngToLayerPoint(latlng);
    const cp = containerPoint || map.latLngToContainerPoint(latlng);
    const hits = [];
    const sets = this.catalog().filter(ds => ds.enabled && ds.def.group !== 'Boundaries').reverse(); // later datasets draw on top
    sets.forEach(ds => {
      if (!ds.group) return;
      ds.feats.forEach(e => {
        const l = e.layer;
        if (e.refs <= 0 || !l.feature || !ds.group.hasLayer(l)) return;
        if (hitTest(ds, l, lp, cp)) hits.push({ ds, layer: l, props: l.feature.properties || {} });
      });
    });
    return hits; // every feature is in the registry once: distinct features are never merged, duplicates never appear
  };

  // The user's own objects at this point (shown ones only), top-most first: they draw above every dataset.
  // Lines, shapes and circles by their geometry, ground images by their bounds, and markers (pins, text, pinned
  // SVGs) by what they show on screen, wherever it sits around their anchor.
  MB.data.objectsAt = function (latlng, containerPoint) {
    const map = MB.map;
    const lp = map.latLngToLayerPoint(latlng);
    const cp = containerPoint || map.latLngToContainerPoint(latlng);
    // Does an element, as drawn, cover the point? The point is turned back by the element's rotation (about its
    // centre, which the rotation keeps in place) and tested against the element's own, unrotated size.
    const box = map.getContainer().getBoundingClientRect(), px = box.left + cp.x, py = box.top + cp.y;
    const covers = el => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      let dx = px - (r.left + r.width / 2), dy = py - (r.top + r.height / 2);
      const t = getComputedStyle(el).transform;
      if (t && t !== 'none') {
        const m = new DOMMatrix(t);
        m.e = 0; m.f = 0; // a translation (text anchoring) is already in the rectangle's position
        const q = m.inverse().transformPoint(new DOMPoint(dx, dy));
        dx = q.x; dy = q.y;
      }
      const w = el.offsetWidth != null ? el.offsetWidth : r.width, h = el.offsetHeight != null ? el.offsetHeight : r.height; // an inline <svg> has no offset size
      return Math.abs(dx) <= w / 2 && Math.abs(dy) <= h / 2;
    };
    const byLayer = {};
    Object.keys(MB.featureLayers).forEach(id => { const f = MB.featureLayers[id]; (byLayer[f.mb.layerId] = byLayer[f.mb.layerId] || []).push(f); });
    const marks = [], shapes = [];
    MB.state.layers.slice().reverse().forEach(l => {
      (byLayer[l.id] || []).slice().reverse().forEach(f => {
        if (!map.hasLayer(f)) return;
        try {
          if (f instanceof L.Path) { if (f._pxBounds && f._pxBounds.contains(lp) && f._containsPoint(lp)) shapes.push(f); }
          else if (f.getLatLng) {
            // what is drawn: the (rotated) image of a pinned SVG or the text box, not the icon's unrotated wrapper
            const el = f.getElement && f.getElement(), shown = el ? Array.from(el.querySelectorAll('img, svg, textarea')) : [];
            if (el && (shown.length ? shown.some(covers) : covers(el))) marks.push(f);
          }
          else if (f.getBounds && f.getBounds().contains(latlng)) shapes.push(f); // ground images
        } catch (e) { /* ignore */ }
      });
    });
    // Markers are in the marker pane, above every shape and image, stacked by Leaflet's z-index and, at the same
    // z-index, by their order in the pane (the later one on top).
    marks.sort((a, b) => ((b._zIndex || 0) - (a._zIndex || 0)) ||
      (a.getElement().compareDocumentPosition(b.getElement()) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1));
    return marks.concat(shapes);
  };

  let identifyPopup = null, highlighted = null;
  function clearHighlight() {
    if (!highlighted) return;
    if (highlighted.own) { // the user's object: a class, so its own style is never touched
      const el = highlighted.layer.getElement ? highlighted.layer.getElement() : highlighted.layer._path;
      if (el) L.DomUtil.removeClass(el, 'mb-ident-hl');
      highlighted = null;
      return;
    }
    const { ds } = highlighted;
    (highlighted.layers || [highlighted.layer]).forEach(layer => {
      try {
        if (layer.setStyle && layer.feature) layer.setStyle(ds.def.style(layer.feature.properties || {}));
        else if (layer.getElement && layer.getElement()) L.DomUtil.removeClass(layer.getElement(), 'mb-data-hl');
      } catch (e) { /* ignore */ }
    });
    highlighted = null;
  }
  function highlight(h) {
    clearHighlight();
    if (h.own) {
      const el = h.layer.getElement ? h.layer.getElement() : h.layer._path;
      if (el) L.DomUtil.addClass(el, 'mb-ident-hl');
      highlighted = h;
      return;
    }
    const { ds } = h;
    (h.layers || [h.layer]).forEach(layer => {
      try {
        if (layer.setStyle && layer.feature) { layer.setStyle({ weight: 4, color: '#ffd166', opacity: 1, fillOpacity: Math.min(0.5, (ds.def.style(layer.feature.properties || {}).fillOpacity || 0) + 0.25) }); if (layer.bringToFront) layer.bringToFront(); }
        else if (layer.getElement && layer.getElement()) L.DomUtil.addClass(layer.getElement(), 'mb-data-hl');
      } catch (e) { /* ignore */ }
    });
    highlighted = h;
  }

  // Everything under a click in one popup. opts.own: the user's objects at the point, listed first (their objects
  // draw above the data, so a click on one never reaches the data under it). It opens only when there is data at the
  // point; the return value says whether it did.
  MB.data.identify = function (latlng, containerPoint, clicked, opts) {
    opts = opts || {};
    let hits = this.featuresAt(latlng, containerPoint);
    if (clicked && clicked.feature && !hits.some(h => h.layer === clicked)) {
      // the layer the map reported (it may be the neighbour of the square that was tapped, when tiled)
      const ds = this.catalog().find(d => d.group && d.group.hasLayer(clicked));
      if (ds && !ds.def.tiled) hits.unshift({ ds, layer: clicked, props: clicked.feature.properties || {} });
    }
    if (!hits.length) return false;
    // Polygons that read the same (a LAANC grid square and its neighbour with the same ceiling, tapped near their
    // shared edge) are one entry; it highlights all of them.
    const byText = new Map();
    hits = hits.filter(h => {
      const k = h.ds.def.id + '|' + JSON.stringify(h.props);
      const first = byText.get(k);
      if (first) { first.layers.push(h.layer); return false; }
      h.layers = [h.layer];
      byText.set(k, h);
      return true;
    });
    // At most 15 entries; however many objects overlap, at least five places (or all the data) go to the data.
    const own = (opts.own || []).map(layer => ({ own: true, layer }));
    const total = own.length + hits.length;
    const ownShown = own.slice(0, 15 - Math.min(hits.length, Math.max(5, 15 - own.length)));
    hits = ownShown.concat(hits.slice(0, 15 - ownShown.length));
    const label = h => { const d = h.ds.def; try { return d.label ? String(d.label(h.props)) : firstText(h.props); } catch (e) { return ''; } };
    const presenting = MB.presenter && MB.presenter.active;
    const ownSection = (h, i) => {
      const m = h.layer.mb, lay = MB.getLayer(m.layerId), type = MB.typeLabels[m.type] || m.type;
      const name = m.name || (m.type === 'text' ? m.text : '') || type;
      let measure = '';
      try { measure = MB.measureText(h.layer); } catch (e) { /* ignore */ }
      const rows = [['Type', type], ['Layer', lay ? lay.name : ''], ['Size', measure]].map(([k, v]) => v ? `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>` : '').join('');
      const locked = MB.isFeatureLocked(h.layer);
      const act = presenting ? '' : `<div class="btn-row"><button type="button" class="btn small" data-select="${i}"${locked ? ' disabled title="Locked"' : ''}>Select</button></div>`;
      return `<details class="mb-ident mb-ident-own" name="mb-ident" data-i="${i}"><summary><span class="mb-ident-ds">${esc(lay ? lay.name : 'Your objects')}</span><span class="mb-ident-label">${esc(String(name))}</span></summary><table class="mb-datatable">${rows}</table>${act}</details>`;
    };
    const sections = hits.map((h, i) => {
      if (h.own) return ownSection(h, i);
      const body = popupHtml(h.ds, h.props).replace(/^<div class="mb-popup"><div class="mb-popup-title">[^<]*<\/div>/, '').replace(/<\/div>$/, '');
      const extra = h.ds.def.popupExtra ? `<div class="mb-extra dim" data-extra="${i}">Loading frequencies…</div>` : '';
      return `<details class="mb-ident" name="mb-ident" data-i="${i}"${hits.length === 1 ? ' open' : ''}><summary><span class="mb-ident-ds">${esc(h.ds.def.name)}</span><span class="mb-ident-label">${esc(label(h))}</span></summary>${body}${extra}</details>`;
    }).join('');
    // No header: each entry names its dataset and feature. Several features start collapsed, so the whole list is
    // in view at once (an expanded first entry used to push the others below the popup's scroll); the shared
    // name makes them an accordion. Only a truncated list gets a note.
    const more = total > hits.length ? `<div class="mb-ident-more dim">Showing ${hits.length} of ${total}</div>` : '';
    const html = `<div class="mb-popup mb-identify">${sections}${more}</div>`;
    if (identifyPopup && identifyPopup.isOpen()) MB.map.closePopup(identifyPopup);
    // Hand Leaflet a DOM node, not the HTML string: popup.update() (called when frequencies arrive) re-renders
    // string content from scratch, which would wipe the loaded frequencies, the listeners and the expanded state.
    const content = document.createElement('div'); content.innerHTML = html;
    const popup = identifyPopup = L.popup({ maxWidth: 400, maxHeight: Math.round(MB.map.getSize().y * 0.6), className: 'mb-data-popup', autoPanPadding: [20, 20] }).setLatLng(latlng).setContent(content.firstElementChild).openOn(MB.map);
    let pinned = hits.length === 1 ? hits[0] : null; // the expanded entry stays highlighted when the pointer leaves the list
    popup.on('remove', () => { pinned = null; clearHighlight(); });
    const root = popup.getElement();
    root.querySelectorAll('[data-select]').forEach(b => b.addEventListener('click', () => {
      if (MB.presenter && MB.presenter.active) return; // a popup opened before presenting: no editing now
      const h = hits[+b.dataset.select];
      MB.map.closePopup(popup);
      // the object may have been deleted (or undone away) since the popup opened
      if (MB.featureLayers[h.layer.mb.id] !== h.layer) { MB.toast('That object no longer exists.'); return; }
      MB.selectFeature(h.layer);
      if (MB.ui && MB.ui.revealFeature) MB.ui.revealFeature(h.layer);
    }));
    root.querySelectorAll('details.mb-ident').forEach(d => {
      const h = hits[+d.dataset.i];
      d.addEventListener('mouseenter', () => highlight(h));
      d.addEventListener('mouseleave', () => { if (pinned) highlight(pinned); else clearHighlight(); });
      d.addEventListener('toggle', () => {
        if (d.open) { pinned = h; highlight(h); if (!h.own) MB.data.pick(h); return; }
        if (pinned !== h) return;
        const still = Array.from(root.querySelectorAll('details.mb-ident[open]')).pop(); // fall back to another entry that is still expanded
        pinned = still ? hits[+still.dataset.i] : null;
        if (d.matches(':hover')) return; // keep the hovered entry lit until the pointer leaves
        if (pinned) highlight(pinned); else clearHighlight();
      });
    });
    hits.forEach((h, i) => {
      if (h.own || !h.ds.def.popupExtra) return;
      Promise.resolve().then(() => h.ds.def.popupExtra(h.props)).then(extraHtml => {
        const el = root.querySelector(`[data-extra="${i}"]`); if (el) { el.outerHTML = extraHtml; if (popup.isOpen()) popup.update(); }
      }).catch(err => { const el = root.querySelector(`[data-extra="${i}"]`); if (el) { el.textContent = 'Frequencies unavailable: ' + err.message; if (popup.isOpen()) popup.update(); } });
    });
    if (pinned) highlight(pinned);
    // Properties shows the expanded entry, or the top-most data feature (not over a selected object of one's own)
    const shown = pinned && !pinned.own ? pinned : hits.find(h => !h.own);
    if (shown && !own.length) MB.data.pick(shown);
    return true;
  };

  /* ---------- a data feature in Properties ----------
   * The feature expanded in the identify popup is described in the Layers tab's Properties: where it comes from,
   * its geometry and measurements, and all its attributes. */

  MB.data.picked = null;
  MB.data.pick = function (h) {
    const was = this.picked;
    if (!h && !was) return;
    if (h && MB.selected) MB.deselect(); // Properties shows one thing: the data feature now
    this.picked = h ? { ds: h.ds, layer: h.layer, layers: h.layers || [h.layer], props: h.props, html: describe(h) } : null;
    MB.emit('datapick', this.picked);
  };

  const PUBLISHERS = { faa: 'FAA UAS Data Delivery System (UDDS)', esri: 'Esri Living Atlas of the World' };
  // Fields that are the service's bookkeeping, not data: object ids, global ids, and the service's own shape
  // measurements (in Web Mercator units, not true ones).
  const BOOKKEEPING = /^(OBJECTID|FID|GLOBAL_?ID|Shape__|Shape_(Area|Length|Leng)$|SHAPE_(AREA|LEN))/i;

  function describe(h) {
    const ds = h.ds, def = ds.def, p = h.props || {};
    const row = (k, v, title) => v == null || v === '' ? '' : `<tr${title ? ` title="${esc(title)}"` : ''}><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`;
    const date = v => v && v !== 'offline' ? new Date(v).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    let label = '';
    try { label = def.label ? String(def.label(p)) : firstText(p); } catch (e) { /* ignore */ }

    // the source
    const publisher = def.custom ? 'Custom ArcGIS layer' : PUBLISHERS[def.source || (def.group === 'Boundaries' ? 'esri' : '')] || '';
    const service = (ds.meta && ds.meta.serviceName) || ((def.url || '').match(/services\/([^/]+)\/(?:Feature|Map)Server/) || [])[1] || '';
    let host = '';
    try { host = def.custom ? new URL(def.url).hostname : ''; } catch (e) { /* ignore */ }
    const src = [row('Dataset', def.name), row('Publisher', publisher), row('Host', host), row('Service', service.replace(/_/g, ' ')),
      row('Category', def.group), row('Source updated', date(ds.meta && ds.meta.lastEdit)), row('Last checked', date(ds.meta && ds.meta.checkedAt)),
      row('Coordinates', 'WGS 84 (EPSG:4326)')].join('');

    // the geometry: what is loaded now (generalized when zoomed out)
    const geo = (h.layer.feature && h.layer.feature.geometry) || {};
    const kinds = { Polygon: 'Polygon', MultiPolygon: 'Multipart polygon', LineString: 'Line', MultiLineString: 'Multipart line', Point: 'Point', MultiPoint: 'Multipoint' };
    const parts = /^Multi/.test(geo.type) ? (geo.coordinates || []).length : 1;
    let vertices = 0;
    const count = c => { if (typeof c[0] === 'number') vertices++; else c.forEach(count); };
    try { count(geo.coordinates || []); } catch (e) { /* ignore */ }
    let measures = '', where = '';
    try {
      const l = h.layer;
      if (l instanceof L.Polygon) {
        const ll = l.getLatLngs(), outer = ll.map(x => MB.isLatLng(x[0]) ? x : x[0]); // each part's outer ring
        measures = row('Area', MB.formatArea(MB.polygonArea(ll))) + row('Perimeter', MB.formatDistance(MB.pathLength(MB.isLatLng(ll[0]) ? ll : outer, true)));
      } else if (l instanceof L.Polyline) measures = row('Length', MB.formatDistance(MB.pathLength(l.getLatLngs())));
      if (l.getBounds) {
        const b = l.getBounds(), c = b.getCenter();
        where = row('Center', MB.formatLatLng(c)) +
          row('Extent', `N ${b.getNorth().toFixed(4)}, S ${b.getSouth().toFixed(4)}, E ${b.getEast().toFixed(4)}, W ${b.getWest().toFixed(4)}`, 'Bounding box, degrees') +
          row('Size', `${MB.formatDistance(L.latLng(c.lat, b.getWest()).distanceTo(L.latLng(c.lat, b.getEast())))} × ${MB.formatDistance(L.latLng(b.getSouth(), c.lng).distanceTo(L.latLng(b.getNorth(), c.lng)))}`, 'Bounding box, east-west × north-south');
      } else if (l.getLatLng) where = row('Position', MB.formatLatLng(l.getLatLng()));
    } catch (e) { /* ignore */ }
    const level = MB.data.levelFor(def, MB.map.getZoom());
    const generalized = level && level.offset > 0;
    const geom = row('Geometry', kinds[geo.type] || geo.type) + (parts > 1 ? row('Parts', parts) : '') + row('Vertices', vertices ? vertices.toLocaleString() : '') + measures + where;

    // the attributes: the dataset's chosen fields first, then the rest, then what is worked out from them
    const keys = (def.fields || []).filter(k => k in p).concat(Object.keys(p).filter(k => !(def.fields || []).includes(k))).filter(k => !BOOKKEEPING.test(k));
    let attrs = keys.map(k => row(k, fmtVal(k, p[k]))).join('');
    if (def.rows) { try { attrs += def.rows(p).map(([k, v]) => row(k, v)).join(''); } catch (e) { /* ignore */ } }

    return `<div class="panel-head"><h3>${esc(def.name)}</h3><span class="badge">data</span><button type="button" class="icon-btn mini" data-act="close-data" title="Close" aria-label="Close"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button></div>
      ${label ? `<div class="data-pick-label">${esc(label)}</div>` : ''}
      <div class="section"><h3>Source</h3><table class="mb-datatable">${src}</table>${/^https?:\/\//i.test(def.url || '') ? `<div class="btn-row"><a class="btn small" href="${esc(def.url)}" target="_blank" rel="noopener" title="The service's description, fields and extent">Service page</a></div>` : ''}</div>
      <div class="section"><h3>Geometry</h3><table class="mb-datatable">${geom}</table>${generalized ? '<p class="note">Measured on the outline loaded at this zoom, simplified for display: zoom in for full detail.</p>' : ''}</div>
      <div class="section"><h3>Attributes</h3>${attrs ? `<table class="mb-datatable">${attrs}</table>` : '<p class="note">No attributes.</p>'}</div>`;
  }

  /* ---------- panel ---------- */
  MB.data.ui = { q: '', filter: 'all', closed: new Set() };
  // Which source blocks (FAA, ADS-B, custom layers...) are collapsed: a convenience of this device.
  try { MB.data.ui.closed = new Set(JSON.parse(localStorage.getItem('gengis.dataClosed') || '[]')); } catch (e) { /* private mode: all open */ }
  MB.data.saveClosed = function () { try { localStorage.setItem('gengis.dataClosed', JSON.stringify(Array.from(this.ui.closed))); } catch (e) { /* ignore */ } };
  // A source block that collapses; a search keeps every block open so its matches show.
  MB.data.sourceOpen = function (key) { return !!this.ui.q.trim() || !this.ui.closed.has(key); };
  // A dataset's details behind an info icon next to its name (hover, or tap on a touch screen).
  MB.data.infoIcon = function (text) {
    return text ? `<span class="ds-info" tabindex="0" role="img" aria-label="About this source: ${esc(text)}">i</span><span class="ds-tip" role="tooltip">${esc(text)}</span>` : '';
  };

  MB.data.renderPanel = async function () {
    const panel = document.getElementById('tab-data');
    if (!panel) return;
    // Don't rebuild while the user is typing in the search box; a later 'data' event will catch up.
    const focused = document.activeElement;
    if (focused && panel.contains(focused) && (focused.id === 'dsSearch' || focused.hasAttribute('data-keep-focus'))) { clearTimeout(this._deferred); this._deferred = setTimeout(() => this.renderPanel(), 1500); return; }
    const ui = this.ui;
    const q = ui.q.trim().toLowerCase();
    const matches = ds => {
      if (ui.filter === 'on' && !ds.enabled) return false;
      if (ui.filter === 'off' && ds.enabled) return false;
      if (!q) return true;
      const d = ds.def;
      return [d.name, d.group, d.desc || '', (d.legend || []).map(x => x[0]).join(' ')].join(' ').toLowerCase().includes(q);
    };
    const bySource = {};
    this.catalog().forEach(ds => {
      if (ds.def.group === 'Boundaries') return; // boundary overlays live in Settings
      const src = ds.def.source || 'custom';
      (bySource[src] = bySource[src] || []).push(ds);
    });
    const zoom = MB.map.getZoom();
    const anyOn = this.catalog().some(ds => ds.enabled);
    const s = this.settings;
    const enabledCount = this.catalog().filter(ds => ds.enabled && ds.def.group !== 'Boundaries').length + (MB.adsb ? MB.adsb.enabledCount() : 0);
    let html = `<div class="panel-head"><h3>Data sources</h3><span class="badge">${enabledCount} on · zoom ${zoom.toFixed(0)}</span></div>
      <div class="row ds-tools"><input type="search" id="dsSearch" placeholder="Search datasets" value="${esc(ui.q)}" autocomplete="off"><select id="dsFilter"><option value="all"${ui.filter === 'all' ? ' selected' : ''}>All</option><option value="on"${ui.filter === 'on' ? ' selected' : ''}>Enabled</option><option value="off"${ui.filter === 'off' ? ' selected' : ''}>Disabled</option></select></div>
      <div class="btn-row" style="margin:0 0 8px"><button class="btn small" data-act="check">Check for updates</button><button class="btn small ghost" data-act="clear">Clear cache</button></div>
      <div id="dataCacheStats" class="note" style="margin-bottom:10px"></div>`;
    const adsbHtml = MB.adsb ? MB.adsb.panelHtml(q, ui.filter) : ''; // live air traffic: its own block, same search and filter
    html += adsbHtml;
    let shownTotal = 0;
    Object.keys(bySource).forEach(srcKey => {
      const src = MB.dataSources[srcKey] || { name: srcKey, url: '', note: '' };
      const list = bySource[srcKey].filter(matches);
      if (!list.length) return;
      shownTotal += list.length;
      const groups = {};
      list.forEach(ds => { (groups[ds.def.group] = groups[ds.def.group] || []).push(ds); });
      html += `<details class="ds-source" data-src="${esc(srcKey)}"${this.sourceOpen(srcKey) ? ' open' : ''}><summary class="ds-source-head"><h3>${src.url ? `<a href="${src.url}" target="_blank" rel="noopener">${esc(src.name)}</a>` : esc(src.name)}</h3><span class="badge">${bySource[srcKey].filter(d => d.enabled).length}/${bySource[srcKey].length} on</span></summary>${src.note ? `<p class="note">${esc(src.note)}</p>` : ''}`;
    Object.keys(groups).forEach(g => {
      html += `<div class="section"><h3>${esc(g)}</h3>`;
      groups[g].forEach(ds => {
        const d = ds.def;
        const shown = ds.enabled ? this.featureCount(ds) : 0;
        let statusLine = '';
        if (ds.enabled) {
          const bits = [];
          if (ds.loading.size) bits.push('loading ' + ds.loading.size + '…');
          if (ds.loading.size && this.pausedFor(ds)) bits.push('the service is over its shared request quota, retrying in ' + this.pausedFor(ds) + ' s');
          if (ds.status) bits.push(ds.status);
          if (!ds.loading.size && !ds.status) bits.push(shown + ' features in view');
          if (ds.meta && ds.meta.lastEdit && ds.meta.lastEdit !== 'offline') bits.push('source updated ' + new Date(ds.meta.lastEdit).toLocaleDateString());
          if (ds.meta && ds.meta.checkedAt) bits.push('checked ' + ago(ds.meta.checkedAt));
          statusLine = esc(bits.join(' · '));
          if (d.extraStatus) { try { statusLine += '<br>' + esc(d.extraStatus()); } catch (e) { /* ignore */ } }
        } else statusLine = esc(d.minZoom ? 'zoom ' + d.minZoom + '+' : 'any zoom');
        html += `<div class="data-item${ds.enabled ? ' on' : ''}" data-id="${d.id}">
          <div class="ds-head"><label class="check"><input type="checkbox" data-act="toggle"${ds.enabled ? ' checked' : ''}> <span class="dname">${esc(d.name)}</span></label>${this.infoIcon(d.desc)}</div>
          ${d.custom ? `<button class="icon-btn mini danger" data-act="remove" title="Remove this service">${trashIcon}</button>` : ''}
          ${d.subsets
            ? `<div class="subsets">${d.subsets.items.concat(d.subsets.other ? [['__other', d.subsets.other, '#888']] : []).map(([k, t, c, sym]) => `<label class="sub${ds.off.has(k) ? ' off' : ''}"><input type="checkbox" data-sub="${esc(k)}"${ds.off.has(k) ? '' : ' checked'}${ds.enabled ? '' : ' disabled'}>${swatch(c, sym)}${esc(t)}</label>`).join('')}
               <span class="sub-actions"><button type="button" class="link" data-act="sub-all">all</button> · <button type="button" class="link" data-act="sub-none">none</button></span></div>`
            : `<div class="legend">${(d.legend || []).map(([t, c, sym]) => `<span>${swatch(c, sym)}${esc(t)}</span>`).join('')}</div>`}
          <div class="dstatus${ds.error ? ' err' : ''}">${ds.error ? esc(ds.error) : statusLine}</div>
        </div>`;
      });
      html += '</div>';
    });
      html += '</details>';
    });
    if (!shownTotal && !adsbHtml) html += '<p class="note">No datasets match.</p>';
    html += `<div class="section"><h3>Options</h3>
      <div class="row"><label>Data opacity</label><input type="range" id="dataOpacity" min="0.1" max="1" step="0.05" value="${s.opacity}"><span class="val" id="dataOpacityVal">${Math.round(s.opacity * 100)}%</span></div>
      <div class="row" title="How often each service's last-edit stamp is compared; changed datasets are re-downloaded"><label>Check updates</label><select id="dataCheck">${[1, 3, 6, 12, 24].map(h => `<option value="${h}"${+s.checkHours === h ? ' selected' : ''}>every ${h} h</option>`).join('')}</select></div>
      <div class="row" title="Cached areas older than this are refreshed"><label>Keep cache</label><select id="dataMaxAge">${[1, 3, 7, 14, 30].map(dd => `<option value="${dd}"${+s.maxAgeDays === dd ? ' selected' : ''}>${dd} day${dd > 1 ? 's' : ''}</option>`).join('')}</select></div>
    </div>
    <div class="section"><h3>Add ArcGIS layer</h3><p class="note">Any public ArcGIS Feature Service layer becomes a dataset under "Custom ArcGIS layers".</p>
      <form id="dataCustomForm">
        <div class="row"><label>Name</label><input type="text" name="name" required placeholder="Layer name"></div>
        <div class="row"><label>URL</label><input type="text" name="url" required placeholder="https://…/FeatureServer/0" title="Any public ArcGIS Feature Service layer"></div>
        <div class="row"><label>Color</label><input type="color" name="color" value="#4f8cff"><label style="flex:0 0 auto">Min zoom</label><input type="number" name="minZoom" class="narrow" min="3" max="16" value="8"></div>
        <label class="check"><input type="checkbox" name="point"> Points</label>
        <div class="btn-row"><button class="btn small primary" type="submit">Add layer</button></div>
      </form>
    </div>`;
    panel.innerHTML = html;

    const search = panel.querySelector('#dsSearch');
    search.addEventListener('input', () => { ui.q = search.value; clearTimeout(this._searchTimer); this._searchTimer = setTimeout(() => { if (document.activeElement === search) { const pos = search.selectionStart; search.blur(); this.renderPanel().then(() => { const el = document.getElementById('dsSearch'); if (el) { el.focus(); el.setSelectionRange(pos, pos); } }); } else this.renderPanel(); }, 350); });
    panel.querySelector('#dsFilter').addEventListener('change', e => { ui.filter = e.target.value; this.renderPanel(); });
    panel.querySelector('[data-act="check"]').addEventListener('click', async () => { if (!anyOn) { MB.toast('Enable a dataset first'); return; } MB.toast('Checking data services…'); await this.checkAll(true); MB.toast('Update check finished'); });
    panel.querySelector('[data-act="clear"]').addEventListener('click', async () => { if (confirm('Delete all cached data-layer content on this device? It is downloaded again as needed.')) { await this.clearCache(); MB.toast('Cache cleared'); } });
    if (MB.adsb) MB.adsb.bindPanel(panel);
    panel.querySelectorAll('details.ds-source[data-src]').forEach(d => d.addEventListener('toggle', () => {
      if (ui.q.trim()) return; // opened by a search, not by the user
      if (d.open) ui.closed.delete(d.dataset.src); else ui.closed.add(d.dataset.src);
      this.saveClosed();
    }));
    panel.querySelectorAll('.ds-info').forEach(i => i.addEventListener('click', e => e.preventDefault()));
    panel.querySelectorAll('.data-item[data-id]').forEach(item => {
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
      if (!/^https?:\/\//i.test(url) || !/FeatureServer\/\d+/i.test(url)) { MB.toast('URL must be a web address (https://…) ending with /FeatureServer/<layer id>'); return; }
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
  // A legend swatch: a color square, or a sample of the chart symbol (css: i.sym-*) in that color.
  const swatch = (c, sym) => sym ? `<i class="sym sym-${esc(sym)}" style="--c:${esc(c)}"></i>` : `<i style="background:${esc(c)}"></i>`;
  const trashIcon = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

  MB.data.renderPanelSoon = MB.debounce(() => MB.data.renderPanel(), 250);
})(window.MB);
