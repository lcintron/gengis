/* GenGIS - live air traffic (ADS-B)
 * - polls a dump1090-style receiver (dump1090-fa / SkyAware, dump1090-mutability, readsb, tar1090: data/aircraft.json;
 *   the original dump1090's built-in server: data.json) and the
 *   open community networks that publish the same JSON, about once a second
 * - one marker per aircraft, merged across sources by address: the freshest position wins (by the age of the data, not
 *   the order the sources answer in), and every other field comes from the freshest report that carries it
 * - icon by aircraft type, color by altitude
 * - click an aircraft for live details; "Look up" adds registration, type, owner and route from adsbdb.com / hexdb.io
 * Nothing is stored: positions live in memory only. Source choices and the receiver address are device settings.
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = MB.escapeHtml;
  const MAX_AGE = 60;     // s: an aircraft whose last position is older than this is removed
  const DIM_AGE = 20;     // s: and faded after this
  const TIMEOUT = 8000;   // ms per request
  const MAX_NM = 250;     // largest radius the community networks answer
  const LABEL_ZOOM = 8;   // callsign labels from this zoom
  const CLOCK_SAMPLES = 20; // feed snapshots remembered to place a feed's clock on ours
  const CLOCK_STEP = 30000; // ms: a feed whose snapshots suddenly arrive this much later than usual has changed its clock
  const NET_ZOOM = 8;     // the community networks from this zoom only: a wider view asks them for thousands of aircraft
                          // every few seconds, all redrawn (your own receiver hears ~200 NM at most: shown at any zoom)
  // Where the various receiver packages publish aircraft.json, relative to the address the user enters.
  // The last is the original dump1090's built-in web server (antirez / MalcolmRobb builds): it answers every other path
  // with its map page, so it is tried after the others.
  const RECEIVER_PATHS = ['/data/aircraft.json', '/skyaware/data/aircraft.json', '/tar1090/data/aircraft.json', '/dump1090-fa/data/aircraft.json', '/dump1090/data/aircraft.json', '/data.json'];

  const SOURCES = [
    // `intervals`: refresh rates offered (seconds), first measured against each service; `interval`: the default
    { id: 'dump1090', section: 'dump1090', name: 'dump1090', kind: 'receiver', interval: 1, intervals: [1, 2, 5, 10],
      desc: 'Your own receiver: dump1090, dump1090-fa (SkyAware), readsb or tar1090. Enter the address its map opens at.' },
    { id: 'adsblol', section: 'Community networks', name: 'adsb.lol', kind: 'area', interval: 10, intervals: [5, 10, 30], site: 'https://adsb.lol',
      attribution: 'Air traffic &copy; <a href="https://adsb.lol" target="_blank" rel="noopener">adsb.lol</a> (ODbL)',
      query: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`,
      desc: 'Open, unfiltered data. Rate-limited: it sustains a request every 5 to 10 s.' },
    { id: 'adsbfi', section: 'Community networks', name: 'adsb.fi', kind: 'area', interval: 2, intervals: [2, 5, 10], site: 'https://adsb.fi',
      attribution: 'Air traffic by <a href="https://adsb.fi" target="_blank" rel="noopener">adsb.fi</a>',
      query: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
      desc: 'Open data for personal use. Sustains a refresh every 2 s.' }
  ];

  // The community networks answer no web page (no CORS headers): offered in the desktop app only. A project that has one
  // on keeps it on (a desktop app opening it shows it); a web page just does not start it.
  const usable = src => src.kind !== 'area' || !!window.gengisDesktop;
  const ONLY_DESKTOP = src => src.name + ' works in the GenGIS desktop app only: it does not accept requests from web pages.';

  /* ---------- aircraft types: one silhouette each, drawn pointing north in a 32 x 32 box ---------- */
  const TYPES = {
    heli: { name: 'Helicopters', one: 'Helicopter', size: 26,
      svg: '<path d="M16 7.5c2.3 0 3.7 1.9 3.7 4.8v3.4c0 2-.9 3.4-2.2 3.9V26h2.6v2.2h-8.2V26h2.6v-6.4c-1.3-.5-2.2-1.9-2.2-3.9v-3.4c0-2.9 1.4-4.8 3.7-4.8z"/><path class="rotor-bg" d="M4.5 2.5l23 21M27.5 2.5l-23 21"/><path class="rotor" d="M4.5 2.5l23 21M27.5 2.5l-23 21"/>' },
    small: { name: 'Light aircraft', one: 'Light aircraft', size: 22,
      svg: '<path d="M16 3c1 0 1.7 1.1 1.7 2.800V10h10.800c.8 0 1.500.7 1.500 1.500v1.700c0 .7-.5 1.200-1.200 1.200H17.700v8.300l3.900 1.500c.6.2 1 .8 1 1.400v1.200H9.400v-1.200c0-.6.4-1.200 1-1.400l3.900-1.500v-8.300H3.200c-.7 0-1.200-.5-1.200-1.200v-1.700c0-.8.7-1.500 1.500-1.500h10.800V5.800C14.300 4.100 15 3 16 3z"/>' },
    large: { name: 'Airliners and heavies', one: 'Airliner / heavy', size: 28,
      svg: '<path d="M16 1.5c1.2 0 2 1.7 2 4.200v6l11.500 7.300v2.700L18 18.100v6.300l3.700 2.800v2.100L16 27.900l-5.700 1.400v-2.100l3.700-2.800v-6.300L2.500 21.700V19L14 11.700v-6c0-2.500.8-4.200 2-4.200z"/>' },
    mil: { name: 'Military', one: 'Military', size: 26,
      svg: '<path d="M16 1.5l1.700 7.300 2.300 3.300 9 9.200v2.600l-9.400-2.300-1.100 4.300 3.100 2.500v2L16 29l-5.600 1.400v-2l3.100-2.500-1.100-4.300L3 23.900v-2.600l9-9.200 2.300-3.300z"/>' },
    other: { name: 'Other / unknown', one: 'Aircraft', size: 20,
      svg: '<path d="M16 3.5l8.500 24.500L16 22.800 7.500 28z"/>' }
  };
  const TYPE_KEYS = Object.keys(TYPES);

  // Common helicopter type designators, for feeds that give a type code but no emitter category.
  const HELI_TYPES = /^(H60|H47|H53|H64|R22|R44|R66|B06|B407|B412|B429|B505|B212|B222|B430|EC20|EC30|EC35|EC45|EC55|EC25|EC75|AS50|AS55|AS65|AS32|A109|A119|A139|A169|A189|S76|S92|S61|S70|UH1|MD52|MD60|H500|NH90|EH10)$/;
  // Well-known military ICAO address blocks. A heuristic for receivers that carry no aircraft database:
  // the networks flag military aircraft themselves (dbFlags).
  const MIL_RANGES = [
    [0xADF7C8, 0xAFFFFF], // United States
    [0x43C000, 0x43CFFF], // United Kingdom
    [0x3AA000, 0x3AFFFF], [0x3B7000, 0x3BFFFF], // France
    [0x3EA000, 0x3EBFFF], [0x3F4000, 0x3FBFFF], // Germany
    [0x33FF00, 0x33FFFF], // Italy
    [0x350000, 0x37FFFF], // Spain
    [0x480000, 0x480FFF], // Netherlands
    [0x44F000, 0x44FFFF], // Belgium
    [0x4B7000, 0x4B7FFF], // Switzerland
    [0xC20000, 0xC3FFFF], // Canada
    [0x7CF800, 0x7CFAFF]  // Australia
  ];
  const CATEGORY = { A1: 'Light (under 15,500 lb)', A2: 'Small (15,500 to 75,000 lb)', A3: 'Large (75,000 to 300,000 lb)', A4: 'High-vortex large', A5: 'Heavy (over 300,000 lb)',
    A6: 'High performance', A7: 'Rotorcraft', B1: 'Glider / sailplane', B2: 'Lighter than air', B3: 'Parachutist', B4: 'Ultralight / paraglider', B6: 'Unmanned aircraft',
    B7: 'Space vehicle', C1: 'Emergency surface vehicle', C2: 'Service surface vehicle', C3: 'Fixed obstacle' };

  function isMilitary(a) {
    if (a.dbFlags & 1) return true;
    const n = parseInt(a.hex, 16);
    return !isNaN(n) && MIL_RANGES.some(r => n >= r[0] && n <= r[1]);
  }
  function classify(a) {
    const cat = a.category || '';
    if (cat === 'A7' || HELI_TYPES.test(a.t || '')) return 'heli';
    if (a.mil || cat === 'A6') return 'mil';
    if (cat === 'A1' || cat === 'A2' || cat === 'B1' || cat === 'B4') return 'small';
    if (cat === 'A3' || cat === 'A4' || cat === 'A5') return 'large';
    return 'other';
  }

  /* ---------- altitude colors (the scale flight trackers use: warm near the ground, through green and blue, to magenta) ---------- */
  const ALT_HUE = [[0, 20], [2000, 32.5], [4000, 43], [6000, 54], [8000, 72], [9000, 85], [11000, 140], [40000, 300], [51000, 360]];
  const HUE_LIGHT = [[0, 52], [45, 50], [60, 43], [180, 41], [200, 55], [270, 57], [300, 46], [360, 52]];
  const GROUND_COLOR = '#98a4b3', UNKNOWN_COLOR = '#dfe4ea';
  function interp(table, x) {
    if (x <= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
      if (x <= table[i][0]) { const a = table[i - 1], b = table[i]; return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); }
    }
    return table[table.length - 1][1];
  }
  function altColor(alt) {
    if (alt === 'ground') return GROUND_COLOR;
    if (alt == null || isNaN(alt)) return UNKNOWN_COLOR;
    const h = interp(ALT_HUE, Math.round(alt / 250) * 250); // 250 ft steps keep the icon from restyling every second
    return `hsl(${h.toFixed(0)},85%,${interp(HUE_LIGHT, h).toFixed(0)}%)`;
  }
  // Legend axis: 0 to 10,000 ft takes the first half, 10,000 to 40,000 ft the second.
  const LEGEND_TICKS = [0, 2000, 4000, 6000, 8000, 10000, 20000, 30000, 40000];
  const legendPos = ft => ft <= 10000 ? ft / 10000 * 50 : 50 + Math.min(1, (ft - 10000) / 30000) * 50;
  const legendAlt = pct => pct <= 50 ? pct / 50 * 10000 : 10000 + (pct - 50) / 50 * 30000;

  // An aircraft's position at time t (ms), carried on from its report along its track at its ground speed (dead
  // reckoning), or null when the report does not say how it moves (or near a pole: it stays at its report there).
  const KT = 0.514444; // m/s
  function ahead(a, t) {
    if (a.gs == null || a.gs < 1 || a.track == null || Math.abs(a.lat) > 85) return null;
    const d = a.gs * KT * Math.max(0, (t - a.posTime) / 1000), tr = a.track * Math.PI / 180;
    const lon = a.lon + d * Math.sin(tr) / (111320 * Math.cos(a.lat * Math.PI / 180));
    return [a.lat + d * Math.cos(tr) / 111320, ((lon + 540) % 360) - 180]; // (across the antimeridian: back to -180..180)
  }

  // "Zoom in" on the map while a network source of live traffic waits for zoom NET_ZOOM: aircraft here, vessels (ais.js).
  MB.LIVE_ZOOM = NET_ZOOM;
  const waitingFor = new Set();
  let zoomHint = null;
  MB.liveZoomHint = function (what, on) {
    if (on) waitingFor.add(what); else waitingFor.delete(what);
    if (!zoomHint) {
      if (!waitingFor.size) return;
      zoomHint = document.createElement('div');
      zoomHint.className = 'mb-zoom-hint';
      const Hint = L.Control.extend({ onAdd: () => zoomHint });
      new Hint({ position: 'bottomright' }).addTo(MB.map); // stacked above the altitude legend
    }
    zoomHint.textContent = 'Zoom in to see live ' + [...waitingFor].sort().join(' and ');
    zoomHint.classList.toggle('hidden', !waitingFor.size);
  };

  /* ---------- parsing ---------- */
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  const str = v => (typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : ''));
  // The fields merged report by report across sources (the position goes with the report it came in).
  const MERGED = ['alt', 'altGeom', 'gs', 'track', 'rate', 'flight', 'squawk', 'emergency', 'category', 'r', 't', 'desc', 'ownOp'];

  // One record per aircraft from dump1090 / readsb / tar1090 JSON (current and legacy field names). `at`: the local
  // time of the snapshot it came in.
  function normalize(a, at) {
    // `id`, the key the sources are merged by: the address in one form. A "~" marks a non-ICAO address (TIS-B, ADS-R):
    // a different aircraft from the ICAO address of the same digits.
    const id = a && typeof a.hex === 'string' ? a.hex.trim().toLowerCase() : '';
    if (!/^~?[0-9a-f]{6}$/.test(id)) return null; // the address goes into links
    let lat = num(a.lat), lon = num(a.lon), seenPos = num(a.seen_pos);
    if (a.validposition === 0 || (lat === 0 && lon === 0)) { lat = null; lon = null; } // the original dump1090: no fix yet
    if (lat == null && a.lastPosition) { lat = num(a.lastPosition.lat); lon = num(a.lastPosition.lon); seenPos = num(a.lastPosition.seen_pos); }
    const seen = num(a.seen);
    if (seenPos == null) seenPos = seen || 0; // the original dump1090 gives only the age of the last message: the position is at least that old
    const altRaw = a.alt_baro != null ? a.alt_baro : (a.altitude != null ? a.altitude : a.alt_geom);
    const ground = altRaw === 'ground' || a.ground === true;
    const rec = {
      id, hex: id.replace(/^~/, ''), nonIcao: id[0] === '~',
      flight: str(a.flight).trim(), r: str(a.r), t: str(a.t), desc: str(a.desc), ownOp: str(a.ownOp),
      category: str(a.category).toUpperCase(), dbFlags: a.dbFlags | 0,
      lat, lon, hasPos: lat != null && lon != null,
      alt: ground ? 'ground' : num(altRaw), altGeom: num(a.alt_geom),
      gs: num(a.gs != null ? a.gs : a.speed),
      track: a.validtrack === 0 ? null : num(a.track != null ? a.track : (a.true_heading != null ? a.true_heading : a.mag_heading)),
      rate: num(a.baro_rate != null ? a.baro_rate : (a.geom_rate != null ? a.geom_rate : a.vert_rate)),
      squawk: str(a.squawk), emergency: a.emergency == null ? null : (a.emergency !== 'none' ? str(a.emergency) : ''), // (null: not reported)
      via: /mlat/.test(str(a.type)) || (a.mlat && a.mlat.length) ? 'MLAT' : (/tisb/.test(str(a.type)) || (a.tisb && a.tisb.length) ? 'TIS-B' : (/adsr/.test(str(a.type)) ? 'ADS-R' : (/mode_s|other/.test(str(a.type)) ? 'Mode S' : 'ADS-B'))),
      rssi: num(a.rssi),
      seen: seen || 0,
      posTime: at - seenPos * 1000,                       // when the position was received
      time: at - (seen != null ? seen : seenPos) * 1000  // when anything was last received
    };
    rec.mil = isMilitary(rec);
    rec.kind = classify(rec);
    return rec;
  }

  // `clock` (one per source) places each snapshot on the local clock, so ages from different sources compare. The feed's
  // own "now" (seconds from a receiver and adsb.fi, milliseconds from adsb.lol) is moved by the smallest gap seen lately
  // between it and the moment it arrived: the quickest snapshot stands for "no delay", and one served late (a lagging
  // server, or a feed that keeps serving the same snapshot) ages by its delay. The feed's clock does not have to be right,
  // only steady; a gap that suddenly grows by more than CLOCK_STEP on a new snapshot is a changed clock, and is learned again.
  // `clock.at` is when the current snapshot was first seen (the source's status line: how old its data is).
  function parseFeed(json, clock) {
    const list = Array.isArray(json) ? json : json && (Array.isArray(json.aircraft) ? json.aircraft : (Array.isArray(json.ac) ? json.ac : null)); // (a bare list: the original dump1090's data.json)
    if (!list) throw new Error('not an aircraft.json feed');
    const arrived = Date.now();
    let at = arrived;
    if (clock && typeof json.now === 'number' && isFinite(json.now)) {
      const t = json.now > 1e11 ? json.now : json.now * 1000, gap = arrived - t, fresh = t !== clock.now;
      clock.gaps = clock.gaps || [];
      if (fresh && clock.gaps.length && gap > Math.min.apply(null, clock.gaps) + CLOCK_STEP) clock.gaps = [];
      clock.gaps.push(gap);
      if (clock.gaps.length > CLOCK_SAMPLES) clock.gaps.shift();
      if (fresh) { clock.now = t; clock.at = arrived; }
      at = t + Math.min.apply(null, clock.gaps);
    } else if (clock) clock.at = arrived;
    return list.map(a => normalize(a, at)).filter(Boolean);
  }

  async function getJson(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      const text = await res.text();
      if (/^\s*</.test(text)) { const e = new Error('web page'); e.html = true; throw e; } // a map page, not data
      return JSON.parse(text);
    } finally { clearTimeout(timer); }
  }

  // "192.168.1.50:8080", "pi.local/skyaware/" or a full .../aircraft.json -> the URLs worth trying, in order.
  function receiverCandidates(input) {
    let u = String(input || '').trim();
    if (!u) return [];
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    u = u.replace(/[?#].*$/, '');
    if (/\.json$/i.test(u)) return [u];
    u = u.replace(/\/(index\.html?)?$/i, '').replace(/\/+$/, '');
    let path = '';
    try { path = new URL(u).pathname.replace(/\/+$/, ''); } catch (e) { return []; }
    // An address that already names a sub-folder (".../skyaware") is tried as given before the usual locations.
    const origin = u.slice(0, u.length - path.length);
    const list = path ? [u + '/data/aircraft.json', u + '/data.json'] : [];
    RECEIVER_PATHS.forEach(p => { const c = origin + p; if (!list.includes(c)) list.push(c); });
    return list;
  }

  // How much a failure says about the receiver: a network/browser block or a real error beats a web page in place of
  // data, which beats "not found" (most of the paths tried simply do not exist on a given receiver).
  function rank(e) { return e && e.status === 404 ? 0 : e && e.html ? 1 : 2; }

  function isLocalHost(url) {
    try { const h = new URL(url).hostname; return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || /\.localhost$/.test(h); } catch (e) { return false; }
  }

  function explain(src, err, url) {
    if (err && err.name === 'AbortError') return 'No answer within ' + TIMEOUT / 1000 + ' s';
    if (err && err.status === 429) return 'Rate limited by ' + src.name + '; slowing down';
    if (err && err.html) return 'That address answered with a web page, not aircraft data. Enter the address the receiver\'s map opens at, or the full URL of its aircraft.json (or data.json).';
    if (err && err.status === 404) return 'No aircraft data found at that address. Enter the address the receiver\'s map opens at, or the full URL of its aircraft.json (or data.json).';
    if (err && err.status) return src.name + ' answered ' + err.message;
    if (err instanceof SyntaxError) return 'That address did not answer with aircraft data.';
    if (err instanceof TypeError) {
      if (!navigator.onLine) return 'Offline';
      if (src.kind === 'area') return src.name + ' does not accept requests from web pages. This source works in the GenGIS desktop app.';
      if (location.protocol === 'https:' && /^http:/i.test(url || '') && !isLocalHost(url)) {
        return 'This page is served over HTTPS, so the browser blocks a plain-HTTP receiver. Use the desktop app, open GenGIS from http://localhost, or reach the receiver over HTTPS.';
      }
      return 'Could not read the receiver. Check the address; in a browser it must also allow cross-origin requests (dump1090-fa and tar1090 do by default).';
    }
    return (err && err.message) || 'Request failed';
  }

  /* ---------- module ---------- */
  MB.adsb = {
    sources: SOURCES, types: TYPES, altColor, parseFeed, receiverUrls: receiverCandidates,
    rt: {},                 // source id -> { on, timer, gen, busy, error, fails, total, withPos, lastOk, resolved, note, clock }
    aircraft: new Map(),    // id ("~" + hex for a non-ICAO address) -> { id, hex, by: { sourceId: record }, cur, info, srcs, marker }
    lookups: new Map(),     // "hex|callsign" -> Promise of details, kept for the session
    selected: null, popup: null, legend: null,
    findState: { q: '', html: '' }, // kept here because the Data panel is rebuilt whenever a data layer changes

    conf() {
      const s = MB.settings.adsb = MB.settings.adsb || {};
      s.sources = s.sources || {};
      s.off = Array.isArray(s.off) ? s.off : [];
      if (s.labels === undefined) s.labels = true;
      if (s.ground === undefined) s.ground = true;
      return s;
    },
    srcConf(id) {
      const all = this.conf().sources, def = SOURCES.find(s => s.id === id);
      all[id] = Object.assign({ on: false, interval: def.interval, url: '' }, all[id]);
      if (!def.intervals.includes(+all[id].interval)) all[id].interval = def.interval;
      return all[id];
    },
    save() { MB.saveSettings(); if (MB.autosave) MB.autosave(); }, // the project records which sources and options are in use

    init() {
      // Above everything else drawn on the map (the user's objects included), so a click on an aircraft always opens its
      // details; under the location dot (which takes no clicks), tooltips and popups. Drawing tools click through it (css).
      const pane = MB.map.createPane('mb-adsb');
      pane.style.zIndex = 625;
      SOURCES.forEach(s => { this.rt[s.id] = { on: false, timer: null, gen: 0, busy: false, error: null, fails: 0, total: 0, withPos: 0, lastOk: 0, resolved: null, note: '', clock: { now: null, at: 0 } }; });
      this.buildLegend();
      // A zoom re-places every icon at once, from where it is now: no glide until the zoom is over
      MB.map.on('zoomstart', () => { this.zooming = true; pane.classList.remove('smooth'); this.place(Date.now(), true); });
      MB.map.on('zoomend', () => { this.zooming = false; this.applyPaneState(); this.netZoom(); this.place(Date.now(), true); });
      MB.map.on('moveend', () => { if (this.anyOn()) this.render(); }); // aircraft are only drawn in and near the view
      MB.on('units', () => this.updatePopup());
      document.addEventListener('visibilitychange', () => { if (!document.hidden) SOURCES.forEach(s => { if (this.rt[s.id].on) this.schedule(s, 0); }); });
      setInterval(() => this.tickStatus(), 1000);
      SOURCES.forEach(s => { if (this.srcConf(s.id).on) this.enable(s.id, true); });
    },

    // Bring the running sources in line with the saved configuration (a project was opened).
    applyConf() {
      if (!this.legend) return; // before init: init() reads the configuration itself
      SOURCES.forEach(s => { const want = !!this.srcConf(s.id).on; if (want && !this.rt[s.id].on) this.enable(s.id, true); else if (!want && this.rt[s.id].on) this.disable(s.id); });
      this.applyPaneState();
      this.render();
      MB.emit('data');
    },

    anyOn() { return SOURCES.some(s => this.rt[s.id].on); },
    enabledCount() { return SOURCES.filter(s => this.rt[s.id].on).length; },

    enable(id, quiet) {
      const src = SOURCES.find(s => s.id === id), rt = this.rt[id], cf = this.srcConf(id);
      if (!src || rt.on) return;
      if (!usable(src)) { if (!quiet) MB.toast(ONLY_DESKTOP(src), 5000); return; } // (its setting kept, for the desktop app)
      if (src.kind === 'receiver' && !receiverCandidates(cf.url).length) {
        if (!quiet) { MB.toast('Enter the address of your dump1090 server first'); const el = document.querySelector('.adsb-url'); if (el) el.focus(); }
        cf.on = false;
        return;
      }
      rt.on = true; rt.gen++; rt.error = null; rt.fails = 0; rt.total = 0; rt.withPos = 0; rt.lastOk = 0; rt.resolved = null; rt.note = ''; rt.clock = { now: null, at: 0 }; rt.waiting = false;
      cf.on = true; this.save();
      if (src.attribution && MB.map.attributionControl) MB.map.attributionControl.addAttribution(src.attribution);
      this.applyPaneState();
      this.schedule(src, 0);
      MB.emit('data');
    },

    disable(id) {
      const src = SOURCES.find(s => s.id === id), rt = this.rt[id];
      if (!src || !rt.on) return;
      rt.on = false; rt.gen++; clearTimeout(rt.timer); rt.error = null; rt.total = 0; rt.withPos = 0; rt.waiting = false;
      this.hint();
      this.srcConf(id).on = false; this.save();
      if (src.attribution && MB.map.attributionControl) MB.map.attributionControl.removeAttribution(src.attribution);
      this.purge(id);
      this.render();
      this.applyPaneState();
      MB.emit('data');
    },

    toggle(id) { if (this.rt[id].on) this.disable(id); else this.enable(id); },

    // Apply a new receiver address (reconnects when the source is on).
    setReceiverUrl(id, url, connect) {
      const cf = this.srcConf(id);
      url = String(url || '').trim();
      const changed = cf.url !== url;
      if (changed) { cf.url = url; delete cf.found; delete cf.foundFor; this.save(); } // a new address: search its paths again
      if (this.rt[id].on && changed) { this.disable(id); this.enable(id); }
      else if (!this.rt[id].on && connect) this.enable(id);
    },
    setIntervalFor(id, seconds) {
      const cf = this.srcConf(id), src = SOURCES.find(s => s.id === id);
      cf.interval = src.intervals.includes(+seconds) ? +seconds : cf.interval;
      this.save();
      if (this.rt[id].on) this.schedule(src, cf.interval * 1000);
    },

    zoomedOut() { return MB.map.getZoom() < NET_ZOOM; },
    // A network source below NET_ZOOM: no requests, its aircraft off the map, until the map is zoomed in again.
    wait(src) {
      const rt = this.rt[src.id];
      clearTimeout(rt.timer); rt.gen++;
      rt.waiting = true; rt.error = null; rt.fails = 0; rt.total = 0; rt.withPos = 0; rt.note = '';
      this.purge(src.id);
      this.render();
      this.hint();
      this.tickStatus();
    },
    netZoom() {
      SOURCES.forEach(s => {
        const rt = this.rt[s.id];
        if (!rt.on || s.kind === 'receiver') return;
        if (this.zoomedOut()) { if (!rt.waiting) this.wait(s); }
        else if (rt.waiting) { rt.waiting = false; rt.lastOk = 0; this.schedule(s, 0); }
      });
      this.hint();
    },
    hint() { MB.liveZoomHint('aircraft', SOURCES.some(s => this.rt[s.id].on && this.rt[s.id].waiting)); },

    schedule(src, delay) {
      const rt = this.rt[src.id];
      clearTimeout(rt.timer);
      rt.timer = setTimeout(() => this.poll(src), delay);
    },

    async poll(src) {
      const rt = this.rt[src.id], cf = this.srcConf(src.id);
      if (!rt.on) return;
      if (document.hidden) return; // resumed by the visibilitychange handler
      if (src.kind !== 'receiver' && this.zoomedOut()) { this.wait(src); return; } // resumed by netZoom
      if (rt.busy) { this.schedule(src, 250); return; }
      const gen = rt.gen, started = Date.now();
      rt.busy = true;
      let failedUrl = '';
      try {
        let list;
        if (src.kind === 'receiver') {
          let urls = rt.resolved ? [rt.resolved] : receiverCandidates(cf.url);
          if (!rt.resolved && cf.found && cf.foundFor === cf.url) urls = [cf.found].concat(urls.filter(x => x !== cf.found)); // where it was last time
          let best = null, bestUrl = '';
          for (const u of urls) {
            failedUrl = u;
            try {
              list = parseFeed(await getJson(u), rt.clock); rt.resolved = u;
              if (cf.found !== u || cf.foundFor !== cf.url) { cf.found = u; cf.foundFor = cf.url; MB.saveSettings(); } // locked in, across reloads (a device setting: no project autosave)
              break;
            } catch (e) {
              if (gen !== rt.gen) return;
              if (!best || rank(e) > rank(best)) { best = e; bestUrl = u; }
            }
          }
          if (!list) { failedUrl = bestUrl; throw best || new Error('No receiver address'); }
        } else {
          const c = MB.map.getCenter().wrap(), b = MB.map.getBounds();
          const need = Math.ceil(c.distanceTo(b.getNorthEast()) / 1852);
          const nm = Math.max(5, Math.min(MAX_NM, need));
          rt.note = need > MAX_NM ? MAX_NM + ' NM around the map center' : '';
          failedUrl = src.query(c.lat.toFixed(4), c.lng.toFixed(4), nm);
          list = parseFeed(await getJson(failedUrl), rt.clock);
        }
        if (gen !== rt.gen) return;
        rt.error = null; rt.fails = 0; rt.lastOk = Date.now();
        rt.total = list.length; rt.withPos = list.filter(a => a.hasPos).length;
        this.ingest(src.id, list);
      } catch (err) {
        if (gen !== rt.gen) return;
        rt.fails++;
        rt.error = explain(src, err, failedUrl);
        if (src.kind === 'receiver' && rt.fails >= 3) rt.resolved = null; // the receiver may have moved: search again
        if (rt.fails >= 3) this.purge(src.id);
      } finally { rt.busy = false; }
      if (gen !== rt.gen) return;
      this.render();
      this.tickStatus();
      const base = cf.interval * 1000;
      // back off while failing: gently for a receiver on the local network, further for the shared networks
      const wait = rt.fails ? Math.min(src.kind === 'receiver' ? 10000 : 30000, base * Math.pow(2, Math.min(rt.fails, 5))) : base;
      this.schedule(src, Math.max(200, wait - (Date.now() - started)));
    },

    /* ----- store: merge the sources by address ----- */
    // Each source keeps its latest report of each aircraft. A report never brings back an older position than the one that
    // source already gave (a snapshot served late, or an aircraft listed twice). An aircraft the source no longer lists is
    // "held": its last report stays only while it is fresher than every other source's, so the marker does not jump back;
    // pick() drops it as soon as another source has newer data, and the aircraft once no source lists it.
    ingest(srcId, list) {
      const listed = new Set();
      list.forEach(rec => {
        if (!rec.hasPos) return;
        let e = this.aircraft.get(rec.id);
        if (!e) { e = { id: rec.id, hex: rec.hex, by: {}, cur: null, marker: null }; this.aircraft.set(rec.id, e); }
        const old = e.by[srcId];
        listed.add(rec.id);
        if (old && old.posTime > rec.posTime) {
          old.held = false;
          if (old.time >= rec.time) return; // older altogether
          rec.lat = old.lat; rec.lon = old.lon; rec.posTime = old.posTime; // newer, but for its position
        }
        rec.src = srcId;
        e.by[srcId] = rec;
      });
      this.aircraft.forEach(e => { const r = e.by[srcId]; if (r && !listed.has(e.id)) r.held = true; });
    },

    // A source turned off or failing: its reports go at once.
    purge(srcId) {
      this.aircraft.forEach(e => { delete e.by[srcId]; });
    },

    // The report whose position is shown: the freshest. Reports too old, and held ones another source has overtaken, go.
    pick(e, now) {
      let cur = null, listed = false;
      for (const k in e.by) {
        const r = e.by[k];
        if (now - r.posTime > MAX_AGE * 1000) { delete e.by[k]; continue; }
        if (!r.held) listed = true;
        if (!cur || r.posTime > cur.posTime) cur = r;
      }
      if (!listed) { e.by = {}; return null; }
      for (const k in e.by) if (e.by[k].held && e.by[k] !== cur) delete e.by[k];
      return cur;
    },

    /* ----- drawing ----- */
    visible(rec) {
      const cf = this.conf();
      if (cf.off.includes(rec.kind)) return false;
      if (rec.alt === 'ground' && !cf.ground) return false;
      return true;
    },

    render() {
      const now = Date.now();
      const bounds = MB.map.getBounds().pad(0.25);
      this.aircraft.forEach((e, id) => {
        const cur = this.pick(e, now);
        if (!cur) { this.drop(e); this.aircraft.delete(id); return; }
        e.cur = cur;
        e.srcs = Object.keys(e.by);
        e.info = this.merged(e);
        const show = this.visible(e.info) && (bounds.contains([cur.lat, cur.lon]) || id === this.selected);
        if (!show) { this.drop(e); return; }
        this.draw(e, now);
      });
      this.place(now);
      this.updatePopup();
    },

    // What is shown: the position from the freshest report (pick), every other field from the freshest report that
    // carries it (by when anything was last received from the aircraft), so a gap in one feed is filled by another.
    merged(e) {
      const cur = e.cur, out = Object.assign({}, cur);
      const recs = Object.values(e.by);
      if (recs.length < 2) return out;
      recs.sort((a, b) => b.time - a.time);
      MERGED.forEach(f => {
        for (const r of recs) { const v = r[f]; if (v != null && (v !== '' || f === 'emergency')) { out[f] = v; break; } }
      });
      recs.forEach(r => { if (r.mil) out.mil = true; out.dbFlags |= r.dbFlags; });
      out.kind = classify(out);
      return out;
    },

    label(a) { return a.flight || a.r || a.hex.toUpperCase(); },

    draw(e, now) {
      const a = e.info;
      const color = altColor(a.alt), track = a.track == null ? 0 : Math.round(a.track);
      const label = this.label(a), dim = (now - a.posTime) / 1000 > DIM_AGE;
      // A new report: from now on the icon is carried on along the aircraft's track until the next report is due, from
      // the fastest source reporting it (see place). Gliding to the report instead would trail the aircraft by a refresh.
      if (e.from !== a.posTime) {
        e.from = a.posTime;
        e.until = now + 1000 * Math.min(...(e.srcs && e.srcs.length ? e.srcs : [a.src]).map(id => this.srcConf(id).interval));
      }
      const ll = this.at(e, now);
      if (!e.marker || e.kind !== a.kind) {
        this.drop(e);
        const size = TYPES[a.kind].size;
        e.marker = L.marker(ll, {
          pane: 'mb-adsb', pmIgnore: true, keyboard: false, bubblingMouseEvents: true,
          icon: L.divIcon({ className: 'mb-ac mb-ac-' + a.kind, iconSize: [size, size], iconAnchor: [size / 2, size / 2],
            html: `<div class="mb-ac-rot"><svg viewBox="0 0 32 32" aria-hidden="true">${TYPES[a.kind].svg}</svg></div><span class="mb-ac-label"></span>` })
        });
        e.marker.options.pmIgnore = true;
        e.marker.on('click', ev => {
          const t = MB.tools.current;
          if (t !== 'select' && t !== 'move' && t !== 'present') return; // drawing tools keep the click
          L.DomEvent.stopPropagation(ev);
          this.select(e.id);
        });
        e.marker.addTo(MB.map);
        e.kind = a.kind; e.color = e.label = e.track = e.dim = e.sel = e.placed = null;
      }
      const el = e.marker.getElement();
      if (!el) return;
      const rot = el.firstChild;
      if (e.track !== track) { rot.style.transform = `rotate(${track}deg)`; e.track = track; }
      if (e.color !== color) { rot.style.color = color; e.color = color; }
      if (e.label !== label) { el.lastChild.textContent = label; e.label = label; }
      if (e.dim !== dim) { el.classList.toggle('stale', dim); e.dim = dim; }
      const sel = e.id === this.selected;
      if (e.sel !== sel) { el.classList.toggle('sel', sel); e.sel = sel; }
    },

    // Where an aircraft's icon goes at time t: carried on from its report, never past when its next report is due.
    at(e, t) { const a = e.info || e.cur; return ahead(a, Math.min(t, e.until || 0)) || [a.lat, a.lon]; },

    // Each icon with a new report (all of them after a zoom) where its aircraft is now, then gliding on to where it will
    // be when its next report is due; the others glide on undisturbed. The first move is made with the icon's glide off
    // and applied (a style read) before its glide is switched on for the second. The glide is the pane's "smooth" rule
    // for icons marked "glide", its length a variable: not the icon's own transition, which would glide on every move,
    // a zoom's re-placing included.
    place(now, all) {
      const pane = MB.map.getPane('mb-adsb'), todo = [];
      this.aircraft.forEach(e => { if (e.marker && e.info && (all || e.placed !== e.until)) todo.push(e); });
      if (!todo.length) return;
      todo.forEach(e => { const el = e.marker.getElement(); if (el) el.classList.remove('glide'); e.marker.setLatLng(this.at(e, now)); });
      if (this.zooming) return;
      void pane.offsetWidth;
      pane.classList.add('smooth');
      todo.forEach(e => {
        e.placed = e.until;
        const el = e.marker.getElement();
        if (!el || e.until <= now || !ahead(e.info, now)) return;
        el.style.setProperty('--glide', ((e.until - now) / 1000).toFixed(2) + 's');
        el.classList.add('glide');
        e.marker.setLatLng(this.at(e, e.until));
      });
    },

    drop(e) {
      if (e.marker) { MB.map.removeLayer(e.marker); e.marker = null; }
      e.kind = null;
    },

    // Pane classes: labels by zoom and setting. (Gliding between position reports is switched on by each report.)
    applyPaneState() {
      const pane = MB.map.getPane('mb-adsb');
      if (!pane) return;
      const cf = this.conf();
      pane.classList.toggle('labels', !!cf.labels && MB.map.getZoom() >= LABEL_ZOOM);
      if (!this.anyOn()) pane.classList.remove('smooth');
      if (this.legend) this.legend.classList.toggle('hidden', !this.anyOn());
    },

    setTypeShown(kind, on) {
      const cf = this.conf();
      cf.off = cf.off.filter(k => k !== kind);
      if (!on) cf.off.push(kind);
      this.save(); this.render();
    },

    buildLegend() {
      const stops = [];
      for (let p = 0; p <= 100; p += 2.5) stops.push(`${altColor(legendAlt(p))} ${p}%`);
      const el = document.createElement('div');
      el.className = 'mb-alt-legend hidden';
      el.setAttribute('aria-label', 'Aircraft altitude colors, in feet');
      el.innerHTML = `<div class="ttl">Altitude (ft)</div>
        <div class="scale"><span class="gnd" style="background:${GROUND_COLOR}" title="On the ground"></span><span class="bar" style="background:linear-gradient(90deg,${stops.join(',')})"></span></div>
        <div class="ticks"><span class="gnd">GND</span><span class="axis">${LEGEND_TICKS.map(t => `<i style="left:${legendPos(t)}%">${t >= 40000 ? '40k+' : (t ? t / 1000 + 'k' : '0')}</i>`).join('')}</span></div>`;
      // a map control in the corner with the scale bar: Leaflet stacks it above, so the two never overlap
      const Legend = L.Control.extend({ onAdd: () => el });
      new Legend({ position: 'bottomright' }).addTo(MB.map);
      this.legend = el;
    },

    /* ----- selection and popup ----- */
    select(id) {
      const e = this.aircraft.get(id);
      if (!e || !e.cur) return;
      const prev = this.selected;
      this.selected = id;
      if (prev && prev !== id) { const p = this.aircraft.get(prev); if (p && p.marker) this.draw(p, Date.now()); }
      if (this.popup) { const old = this.popup; this.popup = null; MB.map.closePopup(old); }
      const node = document.createElement('div');
      node.className = 'mb-popup mb-ac-info';
      node.innerHTML = '<div class="mb-popup-title"></div><table class="mb-datatable"></table><div class="mb-ac-look"></div><div class="mb-ac-links"></div>';
      const popup = L.popup({ className: 'mb-data-popup', maxWidth: 330, offset: [0, -8], autoPanPadding: [20, 20] }).setLatLng(this.at(e, Date.now())).setContent(node);
      popup.on('remove', () => {
        if (this.popup !== popup) return;
        this.popup = null; this.selected = null;
        const cur = this.aircraft.get(id);
        if (cur && cur.marker) this.draw(cur, Date.now());
      });
      this.popup = popup;
      this.render(); // draws the selection ring and fills the popup
      popup.openOn(MB.map);
      this.renderLookup();
    },

    updatePopup() {
      const popup = this.popup;
      if (!popup) return;
      const e = this.aircraft.get(this.selected), node = popup.getContent();
      if (!e || !e.cur) { // gone: keep the last values, say so
        const t = node.querySelector('.mb-popup-title'); if (t && !t.querySelector('.gone')) t.insertAdjacentHTML('beforeend', ' <span class="gone dim">· signal lost</span>');
        return;
      }
      const a = e.info, units = MB.state.units;
      const alt2 = ft => units === 'metric' ? ` (${Math.round(ft * 0.3048).toLocaleString()} m)` : '';
      const spd2 = kt => units === 'metric' ? ` (${Math.round(kt * 1.852)} km/h)` : (units === 'imperial' ? ` (${Math.round(kt * 1.15078)} mph)` : '');
      const rows = [];
      const row = (k, v) => { if (v !== '' && v != null) rows.push(`<tr><td>${esc(k)}</td><td>${v}</td></tr>`); };
      row('Callsign', esc(a.flight));
      row('Registration', esc(a.r));
      row('Type', esc([a.t, a.desc].filter(Boolean).join(' · ')));
      row('Operator', esc(a.ownOp));
      row('ICAO address', esc(a.hex.toUpperCase()) + (a.nonIcao ? ' <span class="dim">(not an ICAO address)</span>' : ''));
      row('Category', esc(CATEGORY[a.category] ? `${CATEGORY[a.category]} (${a.category})` : a.category));
      row('Altitude', a.alt === 'ground' ? 'On the ground' : (a.alt == null ? '' : `<i class="swatch" style="background:${altColor(a.alt)}"></i>${a.alt.toLocaleString()} ft${alt2(a.alt)}`));
      row('Vertical rate', a.rate == null || a.alt === 'ground' ? '' : (Math.abs(a.rate) < 64 ? 'level' : `${a.rate > 0 ? '▲' : '▼'} ${Math.abs(a.rate).toLocaleString()} ft/min`));
      row('Ground speed', a.gs == null ? '' : `${Math.round(a.gs)} kt${spd2(a.gs)}`);
      row('Track', a.track == null ? '' : `${Math.round(a.track)}°`);
      row('Squawk', esc(a.squawk) + (a.emergency ? ` <span class="warn">${esc(a.emergency)}</span>` : ''));
      row('Position', esc(MB.formatLatLng({ lat: a.lat, lng: a.lon })));
      const age = Math.max(0, Math.round((Date.now() - a.posTime) / 1000));
      row('Seen', `${age < 2 ? 'now' : age + ' s ago'} · ${esc(a.via)} · ${esc(e.srcs.map(id => id === 'dump1090' ? 'dump1090' : SOURCES.find(s => s.id === id).name).join(', '))}`);
      node.querySelector('.mb-popup-title').innerHTML = `${esc(this.label(a))} <span class="dim">· ${esc(TYPES[a.kind].one)}${a.mil && a.kind !== 'mil' ? ', military' : ''}</span>`;
      node.querySelector('.mb-datatable').innerHTML = rows.join('');
      const hexU = a.hex.toUpperCase();
      const links = [];
      if (a.flight) links.push(`<a href="https://www.flightaware.com/live/flight/${encodeURIComponent(a.flight)}" target="_blank" rel="noopener">FlightAware</a>`);
      if (!a.nonIcao) links.push(`<a href="https://globe.adsbexchange.com/?icao=${a.hex}" target="_blank" rel="noopener">ADS-B Exchange</a>`, `<a href="https://www.planespotters.net/hex/${hexU}" target="_blank" rel="noopener">Photos</a>`);
      node.querySelector('.mb-ac-links').innerHTML = links.join(' · ');
      popup.setLatLng(this.at(e, Date.now())); // at the icon (it moves on with each render, the icon in between)
    },

    /* ----- look-up: registration, type, owner and route from open aircraft databases ----- */
    lookup(hex, callsign) {
      const key = hex + '|' + (callsign || '');
      if (this.lookups.has(key)) return this.lookups.get(key);
      const p = (async () => {
        const out = { aircraft: null, route: null };
        const tasks = [
          getJson('https://api.adsbdb.com/v0/aircraft/' + encodeURIComponent(hex)).then(j => {
            const a = j && j.response && j.response.aircraft;
            if (a) out.aircraft = { registration: a.registration, manufacturer: a.manufacturer, type: a.type, typeCode: a.icao_type, owner: a.registered_owner, country: a.registered_owner_country_name, source: 'adsbdb.com' };
          }).catch(() => {})
        ];
        if (callsign) tasks.push(
          getJson('https://api.adsbdb.com/v0/callsign/' + encodeURIComponent(callsign)).then(j => {
            const r = j && j.response && j.response.flightroute;
            const place = x => x ? { code: x.iata_code || x.icao_code, name: x.name, city: x.municipality, country: x.country_name } : null;
            if (r) out.route = { airline: r.airline && r.airline.name, flight: r.callsign_iata || r.callsign, from: place(r.origin), to: place(r.destination) };
          }).catch(() => {})
        );
        await Promise.all(tasks);
        if (!out.aircraft) { // second database
          try {
            const h = await getJson('https://hexdb.io/api/v1/aircraft/' + encodeURIComponent(hex));
            if (h && h.Registration) out.aircraft = { registration: h.Registration, manufacturer: h.Manufacturer, type: h.Type, typeCode: h.ICAOTypeCode, owner: h.RegisteredOwners, country: '', source: 'hexdb.io' };
          } catch (e) { /* unknown aircraft */ }
        }
        return out;
      })();
      this.lookups.set(key, p);
      p.catch(() => this.lookups.delete(key));
      return p;
    },

    lookupHtml(d) {
      if (!d.aircraft && !d.route) return '<div class="note">No record of this aircraft in the open databases.</div>';
      const rows = [];
      const row = (k, v) => { if (v) rows.push(`<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`); };
      const a = d.aircraft, r = d.route;
      if (a) {
        row('Registration', a.registration);
        row('Aircraft', [a.manufacturer, a.type].filter(Boolean).join(' ') + (a.typeCode ? ` (${a.typeCode})` : ''));
        row('Owner', a.owner);
        row('Registered in', a.country);
      }
      if (r) {
        const place = x => x ? `${x.code || ''} ${x.city || x.name || ''}`.trim() : '?';
        row('Flight', [r.airline, r.flight].filter(Boolean).join(' · '));
        row('Route', `${place(r.from)} → ${place(r.to)}`);
      }
      return `<table class="mb-datatable">${rows.join('')}</table><div class="note">${a ? 'Aircraft: ' + esc(a.source) + '. ' : ''}${r ? 'Route is looked up by callsign and can be out of date.' : ''}</div>`;
    },

    // The look-up area of the open popup: a button until asked, then the result (kept for the session).
    renderLookup() {
      const popup = this.popup;
      if (!popup) return;
      const e = this.aircraft.get(this.selected);
      const box = popup.getContent().querySelector('.mb-ac-look');
      if (!e || !e.info || e.info.nonIcao) { box.innerHTML = ''; return; }
      const hex = e.hex, cs = e.info.flight, key = hex + '|' + cs;
      const show = () => {
        box.innerHTML = '<div class="note">Looking up…</div>';
        this.lookup(hex, cs).then(d => { if (this.popup === popup) { box.innerHTML = this.lookupHtml(d); popup.update(); } })
          .catch(() => { if (this.popup === popup) box.innerHTML = '<div class="note">Look-up failed. Try again later.</div>'; });
      };
      if (this.lookups.has(key)) { show(); return; }
      box.innerHTML = '<button type="button" class="btn small">Look up aircraft details</button>';
      // stop the click here: the button is replaced below, and Leaflet takes a click from a detached element for a map click (which closes the popup)
      box.querySelector('button').addEventListener('click', ev => { L.DomEvent.stop(ev); show(); });
    },

    // "Find aircraft": a tracked callsign, registration or address is selected on the map; otherwise an
    // address or registration is looked up in the databases.
    async find(text) {
      const st = this.findState;
      const say = html => { if (st.q !== text) return; st.html = html; const el = document.getElementById('adsbFindOut'); if (el) el.innerHTML = html; };
      st.q = text = String(text || '').trim();
      const q = text.toUpperCase().replace(/\s+/g, '');
      if (!q) { say(''); return; }
      let hit = null;
      this.aircraft.forEach(e => {
        if (hit || !e.info) return;
        const a = e.info;
        if (a.hex.toUpperCase() === q || a.flight.toUpperCase() === q || (a.r || '').toUpperCase().replace(/-/g, '') === q.replace(/-/g, '')) hit = e;
      });
      if (!hit) this.aircraft.forEach(e => { if (!hit && e.info && (e.info.flight.toUpperCase().startsWith(q) || (e.info.r || '').toUpperCase().startsWith(q))) hit = e; });
      if (hit) {
        say(`<div class="note">${esc(this.label(hit.info))} is on the map.</div>`);
        MB.map.setView([hit.cur.lat, hit.cur.lon], Math.max(MB.map.getZoom(), 9));
        this.select(hit.id);
        return;
      }
      say('<div class="note">Not tracked right now. Looking it up…</div>');
      try {
        const d = await this.lookup(q.toLowerCase(), '');
        say('<div class="note">Not tracked right now.</div>' + (d.aircraft ? this.lookupHtml(d) : '<div class="note">No aircraft with that address or registration in the open databases. A callsign can only be found while the flight is tracked.</div>'));
      } catch (e) { say('<div class="note">Look-up failed. Try again later.</div>'); }
    },

    /* ----- panel (rendered inside the Data tab by MB.data.renderPanel) ----- */
    statusText(id) {
      const rt = this.rt[id];
      if (!usable(SOURCES.find(s => s.id === id))) return ONLY_DESKTOP(SOURCES.find(s => s.id === id));
      if (!rt.on) return 'Off';
      if (rt.waiting) return `Zoom in to see aircraft (zoom ${NET_ZOOM} or closer)`;
      if (rt.error) return rt.error;
      if (!rt.lastOk) return 'Connecting…';
      const age = Math.round((Date.now() - (rt.clock.at || rt.lastOk)) / 1000); // age of the data, not of the last request
      const bits = [`${rt.withPos} aircraft` + (rt.total > rt.withPos ? ` (${rt.total - rt.withPos} more without a position)` : ''), age <= Math.max(2, this.srcConf(id).interval + 1) ? 'live' : 'data is ' + age + ' s old'];
      if (rt.note) bits.push(rt.note);
      if (document.hidden) bits.push('paused');
      return bits.join(' · ');
    },

    tickStatus() {
      SOURCES.forEach(s => {
        const el = document.getElementById('adsbStatus-' + s.id);
        if (!el) return;
        const t = this.statusText(s.id), err = !!(this.rt[s.id].on && this.rt[s.id].error);
        if (el.textContent !== t) el.textContent = t;
        el.classList.toggle('err', err);
      });
      const n = document.getElementById('adsbCount');
      if (n) { const t = this.countText(); if (n.textContent !== t) n.textContent = t; }
    },

    // The section's badge: aircraft on the map while a source is on, else how many sources are on. The panel and the
    // once-a-second status use the same text, so a redraw of the panel does not flip it back and forth.
    countText() {
      if (!this.anyOn()) return this.enabledCount() + '/' + SOURCES.length + ' on';
      let shown = 0;
      this.aircraft.forEach(e => { if (e.marker) shown++; });
      return shown + ' shown';
    },

    matches(src, q, filter) {
      const on = this.rt[src.id].on;
      if (filter === 'on' && !on) return false;
      if (filter === 'off' && on) return false;
      if (!q) return true;
      return ['ads-b adsb live air traffic aircraft flights planes', src.name, src.section, src.desc].join(' ').toLowerCase().includes(q);
    },

    panelHtml(q, filter) {
      const list = SOURCES.filter(s => this.matches(s, q, filter));
      if (!list.length) return '';
      const cf = this.conf();
      const sections = {};
      list.forEach(s => { (sections[s.section] = sections[s.section] || []).push(s); });
      let html = `<details class="ds-source" id="adsbSource" data-src="adsb"${MB.data.sourceOpen('adsb') ? ' open' : ''}><summary class="ds-source-head"><h3>ADS-B live air traffic</h3><span class="badge" id="adsbCount">${this.countText()}</span></summary>
        <p class="note">Aircraft positions as they are received. Informational only, not for navigation.</p>`;
      Object.keys(sections).forEach(sec => {
        html += `<div class="section"><h3>${esc(sec)}</h3>`;
        sections[sec].forEach(s => {
          const rt = this.rt[s.id], sc = this.srcConf(s.id), off = usable(s) ? '' : ' disabled';
          html += `<div class="data-item${rt.on ? ' on' : ''}${off ? ' unavailable' : ''}" data-adsb="${s.id}">
            <div class="ds-head"><label class="check"><input type="checkbox" data-act="adsb-toggle"${rt.on ? ' checked' : ''}${off}> <span class="dname">${s.site ? `<a href="${s.site}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)}</span></label>${MB.data.infoIcon(s.desc)}</div>
            ${s.kind === 'receiver' ? `<div class="row adsb-row"><label>Server</label><input type="text" class="adsb-url" data-keep-focus value="${esc(sc.url)}" placeholder="http://192.168.1.50:8080" inputmode="url" spellcheck="false"></div>` : ''}
            <div class="row adsb-row"><label>Refresh</label><select class="adsb-interval"${off}>${s.intervals.map(n => `<option value="${n}"${+sc.interval === n ? ' selected' : ''}>every ${n} s</option>`).join('')}</select></div>
            <div class="dstatus${rt.on && rt.error ? ' err' : ''}" id="adsbStatus-${s.id}">${esc(this.statusText(s.id))}</div>
          </div>`;
        });
        html += '</div>';
      });
      html += `<div class="section"><h3>Aircraft shown</h3><div class="data-item adsb-display">
          <div class="subsets adsb-types">${TYPE_KEYS.map(k => `<label class="sub${cf.off.includes(k) ? ' off' : ''}"><input type="checkbox" data-adsb-type="${k}"${cf.off.includes(k) ? '' : ' checked'}><svg viewBox="0 0 32 32" aria-hidden="true">${TYPES[k].svg}</svg>${esc(TYPES[k].name)}</label>`).join('')}</div>
          <div class="subsets"><label class="sub"><input type="checkbox" id="adsbGround"${cf.ground ? ' checked' : ''}>On the ground</label><label class="sub"><input type="checkbox" id="adsbLabels"${cf.labels ? ' checked' : ''}>Callsign labels</label></div>
          <form class="row adsb-row" id="adsbFind"><input type="text" data-keep-focus value="${esc(this.findState.q)}" placeholder="Find callsign, registration or ICAO address" enterkeyhint="search" spellcheck="false"><button class="icon-btn mini" type="submit" title="Find" aria-label="Find">${MB.ICON.search}</button></form>
          <div id="adsbFindOut">${this.findState.html}</div>
          <div class="note">Icon color shows altitude (legend on the map). Click an aircraft for details.</div>
        </div></div></details>`;
      return html;
    },

    bindPanel(panel) {
      panel.querySelectorAll('[data-adsb]').forEach(item => {
        const id = item.dataset.adsb;
        const url = item.querySelector('.adsb-url');
        const cb = item.querySelector('[data-act="adsb-toggle"]');
        cb.addEventListener('change', () => {
          if (url) this.setReceiverUrl(id, url.value);
          this.toggle(id);
          cb.checked = this.rt[id].on; item.classList.toggle('on', this.rt[id].on); // enabling is refused without an address
        });
        if (url) {
          url.addEventListener('change', () => this.setReceiverUrl(id, url.value));
          url.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.setReceiverUrl(id, url.value, true); url.blur(); } });
        }
        item.querySelector('.adsb-interval').addEventListener('change', e => this.setIntervalFor(id, e.target.value));
      });
      panel.querySelectorAll('input[data-adsb-type]').forEach(cb => cb.addEventListener('change', () => { cb.closest('label').classList.toggle('off', !cb.checked); this.setTypeShown(cb.dataset.adsbType, cb.checked); }));
      const g = panel.querySelector('#adsbGround'), l = panel.querySelector('#adsbLabels'), f = panel.querySelector('#adsbFind');
      if (g) g.addEventListener('change', () => { this.conf().ground = g.checked; this.save(); this.render(); });
      if (l) l.addEventListener('change', () => { this.conf().labels = l.checked; this.save(); this.applyPaneState(); });
      if (f) f.addEventListener('submit', e => { e.preventDefault(); this.find(f.querySelector('input').value); });
    }
  };

})(window.MB);
