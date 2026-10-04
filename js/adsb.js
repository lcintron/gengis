/* GenGIS - live air traffic (ADS-B)
 * - polls a dump1090-style receiver (dump1090, dump1090-fa / SkyAware, readsb, tar1090: data/aircraft.json) and the
 *   open community networks that publish the same JSON, about once a second
 * - one marker per aircraft, merged across sources by ICAO address; icon by aircraft type, color by altitude
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
  // Where the various receiver packages publish aircraft.json, relative to the address the user enters.
  const RECEIVER_PATHS = ['/data/aircraft.json', '/skyaware/data/aircraft.json', '/tar1090/data/aircraft.json', '/dump1090-fa/data/aircraft.json', '/dump1090/data/aircraft.json'];

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

  /* ---------- parsing ---------- */
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  const str = v => (typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : ''));

  // One record per aircraft from dump1090 / readsb / tar1090 JSON (current and legacy field names).
  function normalize(a, now) {
    if (!a || typeof a.hex !== 'string' || !/^~?[0-9a-f]{6}$/i.test(a.hex)) return null; // the address goes into links
    let lat = num(a.lat), lon = num(a.lon), seenPos = num(a.seen_pos);
    if (lat == null && a.lastPosition) { lat = num(a.lastPosition.lat); lon = num(a.lastPosition.lon); seenPos = num(a.lastPosition.seen_pos); }
    const altRaw = a.alt_baro != null ? a.alt_baro : (a.altitude != null ? a.altitude : a.alt_geom);
    const ground = altRaw === 'ground' || a.ground === true;
    const hex = a.hex.replace(/^~/, '').toLowerCase();
    const rec = {
      hex, nonIcao: a.hex[0] === '~',
      flight: str(a.flight).trim(), r: str(a.r), t: str(a.t), desc: str(a.desc), ownOp: str(a.ownOp),
      category: str(a.category).toUpperCase(), dbFlags: a.dbFlags | 0,
      lat, lon, hasPos: lat != null && lon != null,
      alt: ground ? 'ground' : num(altRaw), altGeom: num(a.alt_geom),
      gs: num(a.gs != null ? a.gs : a.speed),
      track: num(a.track != null ? a.track : (a.true_heading != null ? a.true_heading : a.mag_heading)),
      rate: num(a.baro_rate != null ? a.baro_rate : (a.geom_rate != null ? a.geom_rate : a.vert_rate)),
      squawk: str(a.squawk), emergency: (a.emergency && a.emergency !== 'none') ? str(a.emergency) : '',
      via: /mlat/.test(str(a.type)) || (a.mlat && a.mlat.length) ? 'MLAT' : (/tisb/.test(str(a.type)) || (a.tisb && a.tisb.length) ? 'TIS-B' : (/adsr/.test(str(a.type)) ? 'ADS-R' : (/mode_s|other/.test(str(a.type)) ? 'Mode S' : 'ADS-B'))),
      rssi: num(a.rssi),
      seen: num(a.seen) || 0,
      posTime: now - (seenPos || 0) * 1000
    };
    rec.mil = isMilitary(rec);
    rec.kind = classify(rec);
    return rec;
  }

  // `clock` remembers when each snapshot (the feed's own "now") was first seen, so a feed that keeps serving the
  // same snapshot ages instead of looking live. Local time only: the receiver's clock is never trusted.
  function parseFeed(json, clock) {
    const list = json && (Array.isArray(json.aircraft) ? json.aircraft : (Array.isArray(json.ac) ? json.ac : null));
    if (!list) throw new Error('not an aircraft.json feed');
    let at = Date.now();
    if (clock && typeof json.now === 'number') {
      if (clock.now === json.now) at = clock.at; else { clock.now = json.now; clock.at = at; }
    } else if (clock) clock.at = at;
    return list.map(a => normalize(a, at)).filter(Boolean);
  }

  async function getJson(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return await res.json();
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
    const list = path ? [u + '/data/aircraft.json'] : [];
    RECEIVER_PATHS.forEach(p => { const c = origin + p; if (!list.includes(c)) list.push(c); });
    return list;
  }

  function isLocalHost(url) {
    try { const h = new URL(url).hostname; return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || /\.localhost$/.test(h); } catch (e) { return false; }
  }

  function explain(src, err, url) {
    if (err && err.name === 'AbortError') return 'No answer within ' + TIMEOUT / 1000 + ' s';
    if (err && err.status === 429) return 'Rate limited by ' + src.name + '; slowing down';
    if (err && err.status) return src.name + ' answered ' + err.message;
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
    aircraft: new Map(),    // hex -> { hex, by: { sourceId: record }, cur, info, srcs, marker }
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
      const pane = MB.map.createPane('mb-adsb'); // above the data layers, below the user's own objects
      pane.style.zIndex = 370;
      SOURCES.forEach(s => { this.rt[s.id] = { on: false, timer: null, gen: 0, busy: false, error: null, fails: 0, total: 0, withPos: 0, lastOk: 0, resolved: null, note: '', clock: { now: null, at: 0 } }; });
      this.buildLegend();
      MB.map.on('zoomstart', () => pane.classList.remove('smooth'));
      MB.map.on('zoomend', () => { this.applyPaneState(); });
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
      if (src.kind === 'receiver' && !receiverCandidates(cf.url).length) {
        if (!quiet) { MB.toast('Enter the address of your dump1090 server first'); const el = document.querySelector('.adsb-url'); if (el) el.focus(); }
        cf.on = false;
        return;
      }
      rt.on = true; rt.gen++; rt.error = null; rt.fails = 0; rt.total = 0; rt.withPos = 0; rt.lastOk = 0; rt.resolved = null; rt.note = ''; rt.clock = { now: null, at: 0 };
      cf.on = true; this.save();
      if (src.attribution && MB.map.attributionControl) MB.map.attributionControl.addAttribution(src.attribution);
      this.applyPaneState();
      this.schedule(src, 0);
      MB.emit('data');
    },

    disable(id) {
      const src = SOURCES.find(s => s.id === id), rt = this.rt[id];
      if (!src || !rt.on) return;
      rt.on = false; rt.gen++; clearTimeout(rt.timer); rt.error = null; rt.total = 0; rt.withPos = 0;
      this.srcConf(id).on = false; this.save();
      if (src.attribution && MB.map.attributionControl) MB.map.attributionControl.removeAttribution(src.attribution);
      this.ingest(id, []);
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
      if (changed) { cf.url = url; this.save(); }
      if (this.rt[id].on && changed) { this.disable(id); this.enable(id); }
      else if (!this.rt[id].on && connect) this.enable(id);
    },
    setIntervalFor(id, seconds) {
      const cf = this.srcConf(id), src = SOURCES.find(s => s.id === id);
      cf.interval = src.intervals.includes(+seconds) ? +seconds : cf.interval;
      this.save();
      if (this.rt[id].on) this.schedule(src, cf.interval * 1000);
    },

    schedule(src, delay) {
      const rt = this.rt[src.id];
      clearTimeout(rt.timer);
      rt.timer = setTimeout(() => this.poll(src), delay);
    },

    async poll(src) {
      const rt = this.rt[src.id], cf = this.srcConf(src.id);
      if (!rt.on) return;
      if (document.hidden) return; // resumed by the visibilitychange handler
      if (rt.busy) { this.schedule(src, 250); return; }
      const gen = rt.gen, started = Date.now();
      rt.busy = true;
      let failedUrl = '';
      try {
        let list;
        if (src.kind === 'receiver') {
          const urls = rt.resolved ? [rt.resolved] : receiverCandidates(cf.url);
          let lastErr = new Error('No receiver address');
          for (const u of urls) {
            failedUrl = u;
            try { list = parseFeed(await getJson(u), rt.clock); rt.resolved = u; break; } catch (e) { lastErr = e; if (gen !== rt.gen) return; }
          }
          if (!list) throw lastErr;
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
        if (rt.fails >= 3) this.ingest(src.id, []);
      } finally { rt.busy = false; }
      if (gen !== rt.gen) return;
      this.render();
      this.tickStatus();
      const base = cf.interval * 1000;
      // back off while failing: gently for a receiver on the local network, further for the shared networks
      const wait = rt.fails ? Math.min(src.kind === 'receiver' ? 10000 : 30000, base * Math.pow(2, Math.min(rt.fails, 5))) : base;
      this.schedule(src, Math.max(200, wait - (Date.now() - started)));
    },

    /* ----- store: merge the sources by ICAO address ----- */
    ingest(srcId, list) {
      const seen = new Set();
      list.forEach(rec => {
        if (!rec.hasPos) return;
        seen.add(rec.hex);
        let e = this.aircraft.get(rec.hex);
        if (!e) { e = { hex: rec.hex, by: {}, cur: null, marker: null }; this.aircraft.set(rec.hex, e); }
        rec.src = srcId;
        e.by[srcId] = rec;
      });
      this.aircraft.forEach(e => { if (e.by[srcId] && !seen.has(e.hex)) delete e.by[srcId]; });
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
      this.aircraft.forEach((e, hex) => {
        // the freshest report wins; fields a feed lacks (registration, type) are filled from the others
        let cur = null;
        Object.keys(e.by).forEach(k => { const r = e.by[k]; if ((now - r.posTime) / 1000 > MAX_AGE) { delete e.by[k]; return; } if (!cur || r.posTime > cur.posTime) cur = r; });
        if (!cur) { this.drop(e); this.aircraft.delete(hex); return; }
        e.cur = cur;
        e.srcs = Object.keys(e.by);
        e.info = this.merged(e);
        const show = this.visible(e.info) && (bounds.contains([cur.lat, cur.lon]) || hex === this.selected);
        if (!show) { this.drop(e); return; }
        this.draw(e, now);
      });
      this.updatePopup();
    },

    merged(e) {
      const cur = e.cur, out = Object.assign({}, cur);
      Object.keys(e.by).forEach(k => {
        const r = e.by[k];
        ['flight', 'r', 't', 'desc', 'ownOp', 'category', 'squawk'].forEach(f => { if (!out[f] && r[f]) out[f] = r[f]; });
        if (r.mil) out.mil = true;
        out.dbFlags |= r.dbFlags;
      });
      out.kind = classify(out);
      return out;
    },

    label(a) { return a.flight || a.r || a.hex.toUpperCase(); },

    draw(e, now) {
      const a = e.info;
      const color = altColor(a.alt), track = a.track == null ? 0 : Math.round(a.track);
      const label = this.label(a), dim = (now - a.posTime) / 1000 > DIM_AGE;
      const ll = [a.lat, a.lon];
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
          this.select(e.hex);
        });
        e.marker.addTo(MB.map);
        e.kind = a.kind; e.color = e.label = e.track = e.dim = e.sel = e.step = null;
      } else e.marker.setLatLng(ll);
      const el = e.marker.getElement();
      if (!el) return;
      const rot = el.firstChild;
      const step = this.srcConf(a.src).interval; // glide across one refresh of the source this position came from
      if (e.step !== step) { el.style.transitionDuration = step + 's'; e.step = step; }
      if (e.track !== track) { rot.style.transform = `rotate(${track}deg)`; e.track = track; }
      if (e.color !== color) { rot.style.color = color; e.color = color; }
      if (e.label !== label) { el.lastChild.textContent = label; e.label = label; }
      if (e.dim !== dim) { el.classList.toggle('stale', dim); e.dim = dim; }
      const sel = e.hex === this.selected;
      if (e.sel !== sel) { el.classList.toggle('sel', sel); e.sel = sel; }
    },

    drop(e) {
      if (e.marker) { MB.map.removeLayer(e.marker); e.marker = null; }
      e.kind = null;
    },

    // Pane classes: labels by zoom and setting; icons glide between position reports.
    applyPaneState() {
      const pane = MB.map.getPane('mb-adsb');
      if (!pane) return;
      const cf = this.conf();
      pane.classList.toggle('labels', !!cf.labels && MB.map.getZoom() >= LABEL_ZOOM);
      // set on the next frame so markers re-placed by a zoom do not glide to their new pixel position
      requestAnimationFrame(() => requestAnimationFrame(() => pane.classList.toggle('smooth', this.anyOn())));
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
    select(hex) {
      const e = this.aircraft.get(hex);
      if (!e || !e.cur) return;
      const prev = this.selected;
      this.selected = hex;
      if (prev && prev !== hex) { const p = this.aircraft.get(prev); if (p && p.marker) this.draw(p, Date.now()); }
      if (this.popup) { const old = this.popup; this.popup = null; MB.map.closePopup(old); }
      const node = document.createElement('div');
      node.className = 'mb-popup mb-ac-info';
      node.innerHTML = '<div class="mb-popup-title"></div><table class="mb-datatable"></table><div class="mb-ac-look"></div><div class="mb-ac-links"></div>';
      const popup = L.popup({ className: 'mb-data-popup', maxWidth: 330, offset: [0, -8], autoPanPadding: [20, 20] }).setLatLng([e.cur.lat, e.cur.lon]).setContent(node);
      popup.on('remove', () => {
        if (this.popup !== popup) return;
        this.popup = null; this.selected = null;
        const cur = this.aircraft.get(hex);
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
      popup.setLatLng([a.lat, a.lon]);
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
      const hex = this.selected, e = this.aircraft.get(hex);
      const box = popup.getContent().querySelector('.mb-ac-look');
      if (!e || !e.info || e.info.nonIcao) { box.innerHTML = ''; return; }
      const cs = e.info.flight, key = hex + '|' + cs;
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
        this.select(hit.hex);
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
      if (!rt.on) return 'Off';
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
      if (n) { let shown = 0; this.aircraft.forEach(e => { if (e.marker) shown++; }); const t = this.anyOn() ? shown + ' shown' : this.enabledCount() + '/' + SOURCES.length + ' on'; if (n.textContent !== t) n.textContent = t; }
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
      let html = `<details class="ds-source" id="adsbSource" data-src="adsb"${MB.data.sourceOpen('adsb') ? ' open' : ''}><summary class="ds-source-head"><h3>ADS-B live air traffic</h3><span class="badge" id="adsbCount">${this.enabledCount()}/${SOURCES.length} on</span></summary>
        <p class="note">Aircraft positions as they are received. Informational only, not for navigation.</p>`;
      Object.keys(sections).forEach(sec => {
        html += `<div class="section"><h3>${esc(sec)}</h3>`;
        sections[sec].forEach(s => {
          const rt = this.rt[s.id], sc = this.srcConf(s.id);
          html += `<div class="data-item${rt.on ? ' on' : ''}" data-adsb="${s.id}">
            <div class="ds-head"><label class="check"><input type="checkbox" data-act="adsb-toggle"${rt.on ? ' checked' : ''}> <span class="dname">${s.site ? `<a href="${s.site}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)}</span></label>${MB.data.infoIcon(s.desc)}</div>
            ${s.kind === 'receiver' ? `<div class="row adsb-row"><label>Server</label><input type="text" class="adsb-url" data-keep-focus value="${esc(sc.url)}" placeholder="http://192.168.1.50:8080" autocomplete="off" spellcheck="false"></div>` : ''}
            <div class="row adsb-row"><label>Refresh</label><select class="adsb-interval">${s.intervals.map(n => `<option value="${n}"${+sc.interval === n ? ' selected' : ''}>every ${n} s</option>`).join('')}</select></div>
            <div class="dstatus${rt.on && rt.error ? ' err' : ''}" id="adsbStatus-${s.id}">${esc(this.statusText(s.id))}</div>
          </div>`;
        });
        html += '</div>';
      });
      html += `<div class="section"><h3>Aircraft shown</h3><div class="data-item adsb-display">
          <div class="subsets adsb-types">${TYPE_KEYS.map(k => `<label class="sub${cf.off.includes(k) ? ' off' : ''}"><input type="checkbox" data-adsb-type="${k}"${cf.off.includes(k) ? '' : ' checked'}><svg viewBox="0 0 32 32" aria-hidden="true">${TYPES[k].svg}</svg>${esc(TYPES[k].name)}</label>`).join('')}</div>
          <div class="subsets"><label class="sub"><input type="checkbox" id="adsbGround"${cf.ground ? ' checked' : ''}>On the ground</label><label class="sub"><input type="checkbox" id="adsbLabels"${cf.labels ? ' checked' : ''}>Callsign labels</label></div>
          <form class="row adsb-row" id="adsbFind"><input type="text" data-keep-focus value="${esc(this.findState.q)}" placeholder="Find callsign, registration or ICAO address" autocomplete="off" spellcheck="false"><button class="btn small" type="submit">Find</button></form>
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
