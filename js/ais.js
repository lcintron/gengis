/* GenGIS - live vessel traffic (AIS)
 * - polls your own AIS-catcher receiver (its web viewer's ships.json) every few seconds
 * - or takes aisstream.io's live stream of worldwide AIS for the map view (free API key; the desktop app only: the
 *   service does not accept connections from web pages)
 * - one marker per vessel, merged across sources by MMSI; color by ship type, pointed along its heading or course
 * - click a vessel for its details, with links to MarineTraffic and VesselFinder
 * Nothing is stored: positions live in memory only. Source choices, the receiver address and the key are device settings.
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = MB.escapeHtml;
  const MAX_AGE = 20 * 60; // s: a vessel not heard from for this long is removed (one at anchor reports every 3 min)
  const DIM_AGE = 6 * 60;  // s: and faded after this
  const TIMEOUT = 8000;    // ms per request
  const LABEL_ZOOM = 10;   // name labels from this zoom
  const MAX_DRAWN = 2500;  // vessels drawn at most; a wide view of a busy coast holds more
  const MOVING = 0.5;      // kn: slower than this, a vessel is drawn as stationary
  const STREAM_URL = 'wss://stream.aisstream.io/v0/stream';
  // Where AIS-catcher's web viewer publishes its vessel list, relative to the address the user enters.
  const RECEIVER_PATHS = ['/api/ships.json', '/ships.json'];

  const SOURCES = [
    { id: 'aiscatcher', section: 'AIS-catcher', name: 'AIS-catcher', kind: 'receiver', interval: 2, intervals: [1, 2, 5, 10],
      desc: 'Your own receiver running AIS-catcher with its web viewer on (for example -N 8100). Enter the address its map opens at.' },
    { id: 'aisstream', section: 'Networks', name: 'aisstream.io', kind: 'stream', site: 'https://aisstream.io',
      attribution: 'Vessel traffic by <a href="https://aisstream.io" target="_blank" rel="noopener">aisstream.io</a>',
      desc: 'Worldwide AIS as a live stream for the map view. Needs a free API key (sign in at aisstream.io). Works in the GenGIS desktop app: aisstream.io does not accept connections from web pages.' }
  ];

  /* ---------- vessel types: the colors the vessel trackers use ---------- */
  const TYPES = {
    cargo: { name: 'Cargo', one: 'Cargo vessel', color: '#5ac85a' },
    tanker: { name: 'Tankers', one: 'Tanker', color: '#e8473f' },
    passenger: { name: 'Passenger', one: 'Passenger vessel', color: '#3d8ef0' },
    highspeed: { name: 'High-speed craft', one: 'High-speed craft', color: '#f2d13a' },
    special: { name: 'Tugs and special craft', one: 'Tug / special craft', color: '#3cd2d6' },
    fishing: { name: 'Fishing', one: 'Fishing vessel', color: '#f39a2b' },
    pleasure: { name: 'Sailing and pleasure', one: 'Sailing / pleasure craft', color: '#d65cf0' },
    other: { name: 'Other / unknown', one: 'Vessel', color: '#a7b0bc' },
    aton: { name: 'Navigation aids', one: 'Navigation aid', color: '#f5f7fa' }
  };
  const TYPE_KEYS = Object.keys(TYPES);
  // drawn pointing north in a 32 x 32 box
  const SHAPES = {
    moving: '<path d="M16 2.5c2.900 3.700 4.700 8.200 4.700 13.300v11.700c0 1-.8 1.800-1.800 1.800h-5.800c-1 0-1.800-.8-1.800-1.800V15.800c0-5.100 1.800-9.600 4.700-13.300z"/>',
    stationary: '<path d="M16 9.500a6.500 6.500 0 1 1 0 13 6.500 6.500 0 1 1 0-13z"/>',
    aton: '<path d="M16 5.500l10.500 10.500L16 26.500 5.500 16z"/>'
  };
  const SIZE = { moving: 22, stationary: 13, aton: 14 };

  function typeKey(t) {
    if (t == null) return 'other';
    if (t >= 70 && t <= 79) return 'cargo';
    if (t >= 80 && t <= 89) return 'tanker';
    if (t >= 60 && t <= 69) return 'passenger';
    if (t >= 40 && t <= 49) return 'highspeed';
    if (t === 30) return 'fishing';
    if (t === 36 || t === 37) return 'pleasure';
    if ([31, 32, 33, 34, 50, 51, 52, 53, 54, 55, 58].includes(t)) return 'special';
    return 'other';
  }
  function classify(v) {
    if (/^99/.test(v.mmsi) || /^00/.test(v.mmsi) || v.aton) return 'aton'; // aids to navigation and base stations
    return typeKey(v.shiptype);
  }
  const TYPE_NAMES = { 30: 'Fishing', 31: 'Towing', 32: 'Towing (large)', 33: 'Dredging / underwater operations', 34: 'Diving operations', 35: 'Military operations',
    36: 'Sailing', 37: 'Pleasure craft', 50: 'Pilot vessel', 51: 'Search and rescue', 52: 'Tug', 53: 'Port tender', 54: 'Anti-pollution', 55: 'Law enforcement',
    58: 'Medical transport', 59: 'Noncombatant ship' };
  function typeName(t) {
    if (t == null || t <= 0) return '';
    const d = Math.floor(t / 10);
    const base = TYPE_NAMES[t] || { 2: 'Wing in ground', 4: 'High-speed craft', 6: 'Passenger', 7: 'Cargo', 8: 'Tanker', 9: 'Other' }[d] || 'Type';
    const cat = [2, 4, 6, 7, 8, 9].includes(d) && t % 10 >= 1 && t % 10 <= 4 ? ', hazardous category ' + 'ABCD'[t % 10 - 1] : '';
    return `${base}${cat} (${t})`;
  }
  const STATUS = ['Under way using engine', 'At anchor', 'Not under command', 'Restricted manoeuvrability', 'Constrained by draught', 'Moored', 'Aground',
    'Engaged in fishing', 'Under way sailing', '', '', 'Towing astern', 'Pushing ahead / towing alongside', '', 'AIS-SART active', ''];

  /* ---------- parsing ---------- */
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  const str = v => (typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : ''));
  const text = v => str(v).replace(/@+$/, '').trim(); // AIS pads its text fields with '@'
  // the "not available" values AIS gives speed, course, heading and position
  const sogOf = v => { v = num(v); return v == null || v < 0 || v >= 102.2 ? null : v; };
  const cogOf = v => { v = num(v); return v == null || v < 0 || v >= 360 ? null : v; };
  const latOf = v => { v = num(v); return v == null || Math.abs(v) > 90 ? null : v; };
  const lonOf = v => { v = num(v); return v == null || Math.abs(v) > 180 ? null : v; };
  const validMmsi = m => Number.isInteger(m) && m > 0 && m <= 999999999;
  const pad = n => String(n).padStart(2, '0');
  const etaOf = (mo, d, h, mi) => (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${pad(mo)}-${pad(d)}` + (h < 24 && mi < 60 ? ` ${pad(h)}:${pad(mi)} UTC` : '') : '');
  const dims = (a, b, c, d) => {
    const L = num(a) != null && num(b) != null ? a + b : null, W = num(c) != null && num(d) != null ? c + d : null;
    return { length: L > 0 ? L : null, width: W > 0 ? W : null };
  };

  function blank(mmsi) {
    return { mmsi: String(mmsi).padStart(9, '0'), name: '', callsign: '', imo: null, shiptype: null, lat: null, lon: null, hasPos: false,
      sog: null, cog: null, heading: null, status: null, destination: '', eta: '', draught: null, length: null, width: null, country: '', cls: '', aton: false, posTime: 0 };
  }

  // One record per vessel from AIS-catcher's ships.json.
  function fromCatcher(s, now) {
    if (!s || !validMmsi(s.mmsi)) return null;
    const r = blank(s.mmsi);
    r.lat = latOf(s.lat); r.lon = lonOf(s.lon); r.hasPos = r.lat != null && r.lon != null;
    r.sog = sogOf(s.speed); r.cog = cogOf(s.cog); r.heading = cogOf(s.heading);
    r.status = num(s.status); r.shiptype = num(s.shiptype);
    r.name = text(s.shipname); r.callsign = text(s.callsign); r.destination = text(s.destination);
    r.imo = num(s.imo) > 0 ? s.imo : null;
    r.draught = num(s.draught) > 0 ? s.draught : null;
    Object.assign(r, dims(s.to_bow, s.to_stern, s.to_port, s.to_starboard));
    r.country = /^[A-Z]{2}$/.test(str(s.country)) ? s.country : '';
    r.eta = etaOf(s.eta_month, s.eta_day, s.eta_hour, s.eta_minute);
    r.cls = [1, 2, 3].includes(s.msg_type) ? 'A' : ([18, 19].includes(s.msg_type) ? 'B' : '');
    r.posTime = now - (num(s.last_signal) || 0) * 1000;
    return r;
  }

  function parseCatcher(json) {
    const list = json && (Array.isArray(json.ships) ? json.ships : (Array.isArray(json) ? json : null));
    if (!list) throw new Error('not an AIS-catcher ships.json');
    const now = Date.now();
    return list.map(s => fromCatcher(s, now)).filter(Boolean);
  }

  // One aisstream.io message folded into the vessel's record (`store`: MMSI -> record). Returns the record.
  function fromStream(msg, store) {
    const type = msg && msg.MessageType, md = (msg && msg.MetaData) || {}, body = msg && msg.Message && msg.Message[type];
    if (!body) return null;
    const mmsi = validMmsi(md.MMSI) ? md.MMSI : body.UserID;
    if (!validMmsi(mmsi)) return null;
    let r = store.get(mmsi);
    if (!r) { r = blank(mmsi); store.set(mmsi, r); }
    const pos = (cls) => {
      const lat = latOf(body.Latitude), lon = lonOf(body.Longitude);
      if (lat == null || lon == null) return;
      r.lat = lat; r.lon = lon; r.hasPos = true; r.posTime = Date.now();
      if (cls) r.cls = cls;
    };
    const dim = d => { if (d) Object.assign(r, dims(d.A, d.B, d.C, d.D)); };
    switch (type) {
      case 'PositionReport':
        pos('A'); r.sog = sogOf(body.Sog); r.cog = cogOf(body.Cog); r.heading = cogOf(body.TrueHeading); r.status = num(body.NavigationalStatus);
        break;
      case 'StandardClassBPositionReport':
        pos('B'); r.sog = sogOf(body.Sog); r.cog = cogOf(body.Cog); r.heading = cogOf(body.TrueHeading);
        break;
      case 'ExtendedClassBPositionReport':
        pos('B'); r.sog = sogOf(body.Sog); r.cog = cogOf(body.Cog); r.heading = cogOf(body.TrueHeading);
        if (text(body.Name)) r.name = text(body.Name);
        if (num(body.Type)) r.shiptype = body.Type;
        dim(body.Dimension);
        break;
      case 'ShipStaticData':
        if (text(body.Name)) r.name = text(body.Name);
        if (text(body.CallSign)) r.callsign = text(body.CallSign);
        if (num(body.ImoNumber) > 0) r.imo = body.ImoNumber;
        if (num(body.Type)) r.shiptype = body.Type;
        r.destination = text(body.Destination) || r.destination;
        if (body.Eta) r.eta = etaOf(body.Eta.Month, body.Eta.Day, body.Eta.Hour, body.Eta.Minute);
        if (num(body.MaximumStaticDraught) > 0) r.draught = body.MaximumStaticDraught;
        dim(body.Dimension);
        break;
      case 'StaticDataReport':
        if (body.ReportA && body.ReportA.Valid && text(body.ReportA.Name)) r.name = text(body.ReportA.Name);
        if (body.ReportB && body.ReportB.Valid) {
          if (num(body.ReportB.ShipType)) r.shiptype = body.ReportB.ShipType;
          if (text(body.ReportB.CallSign)) r.callsign = text(body.ReportB.CallSign);
          dim(body.ReportB.Dimension);
        }
        break;
      case 'AidsToNavigationReport':
        pos(''); r.aton = true;
        if (text(body.Name)) r.name = text(body.Name);
        break;
      case 'BaseStationReport':
        pos(''); r.aton = true;
        break;
      case 'StandardSearchAndRescueAircraftReport':
        pos(''); r.sog = sogOf(body.Sog); r.cog = cogOf(body.Cog);
        break;
      default:
        break;
    }
    if (!r.name && text(md.ShipName)) r.name = text(md.ShipName);
    return r;
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

  // "192.168.1.50:8100" or a full .../ships.json -> the URLs worth trying, in order.
  function receiverCandidates(input) {
    let u = String(input || '').trim();
    if (!u) return [];
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    u = u.replace(/[?#].*$/, '');
    if (/\.json$/i.test(u)) return [u];
    u = u.replace(/\/(index\.html?)?$/i, '').replace(/\/+$/, '');
    try { new URL(u); } catch (e) { return []; }
    return RECEIVER_PATHS.map(p => u + p);
  }

  function isLocalHost(url) {
    try { const h = new URL(url).hostname; return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || /\.localhost$/.test(h); } catch (e) { return false; }
  }

  function explain(src, err, url) {
    if (err && err.name === 'AbortError') return 'No answer within ' + TIMEOUT / 1000 + ' s';
    if (err && err.status) return src.name + ' answered ' + err.message;
    if (err instanceof TypeError) {
      if (!navigator.onLine) return 'Offline';
      if (location.protocol === 'https:' && /^http:/i.test(url || '') && !isLocalHost(url)) {
        return 'This page is served over HTTPS, so the browser blocks a plain-HTTP receiver. Use the desktop app, open GenGIS from http://localhost, or reach the receiver over HTTPS.';
      }
      return 'Could not read the receiver. Check the address, and that AIS-catcher\'s web viewer is on (-N).';
    }
    return (err && err.message) || 'Request failed';
  }

  // The map view as aisstream.io bounding boxes ([[lat, lon], [lat, lon]] corners), split at the antimeridian.
  function viewBoxes() {
    const b = MB.map.getBounds().pad(0.2);
    const s = Math.max(-90, b.getSouth()), n = Math.min(90, b.getNorth());
    const w = b.getWest(), e = b.getEast();
    if (e - w >= 360) return [[[s, -180], [n, 180]]];
    const w0 = ((w + 180) % 360 + 360) % 360 - 180, e0 = w0 + (e - w);
    const r = x => Math.round(x * 100) / 100;
    return e0 <= 180 ? [[[r(s), r(w0)], [r(n), r(e0)]]] : [[[r(s), r(w0)], [r(n), 180]], [[r(s), -180], [r(n), r(e0 - 360)]]];
  }

  /* ---------- module ---------- */
  MB.ais = {
    sources: SOURCES, types: TYPES, parseCatcher, fromStream, receiverUrls: receiverCandidates, viewBoxes,
    rt: {},                 // source id -> { on, timer, gen, busy, error, fails, total, withPos, lastOk, resolved, ws, store, ... }
    vessels: new Map(),     // mmsi -> { mmsi, by: { sourceId: record }, cur, info, srcs, marker }
    selected: null, popup: null, capped: 0,
    findState: { q: '', html: '' }, // kept here because the Data panel is rebuilt whenever a data layer changes

    conf() {
      const s = MB.settings.ais = MB.settings.ais || {};
      s.sources = s.sources || {};
      s.off = Array.isArray(s.off) ? s.off : [];
      if (s.labels === undefined) s.labels = true;
      if (s.stationary === undefined) s.stationary = true;
      return s;
    },
    srcConf(id) {
      const all = this.conf().sources, def = SOURCES.find(s => s.id === id);
      all[id] = Object.assign({ on: false, interval: def.interval || 0, url: '', key: '' }, all[id]);
      if (def.intervals && !def.intervals.includes(+all[id].interval)) all[id].interval = def.interval;
      return all[id];
    },
    save() { MB.saveSettings(); if (MB.autosave) MB.autosave(); }, // the project records which sources and options are in use

    init() {
      const pane = MB.map.createPane('mb-ais'); // above the place names, under live air traffic
      pane.style.zIndex = 368;
      SOURCES.forEach(s => { this.rt[s.id] = { on: false, timer: null, gen: 0, busy: false, error: null, fails: 0, total: 0, withPos: 0, lastOk: 0, resolved: null, ws: null, store: new Map(), dirty: false, sent: '', sentAt: 0, subTimer: null }; });
      MB.map.on('zoomend', () => this.applyPaneState());
      MB.map.on('moveend', () => {
        if (this.anyOn()) this.render(); // vessels are only drawn in and near the view
        if (this.rt.aisstream.on) this.subscribeSoon();
      });
      MB.on('units', () => this.updatePopup());
      // hidden, the receiver stops polling and the stream is closed (nothing is drawn, and the stream would pile up)
      document.addEventListener('visibilitychange', () => SOURCES.forEach(s => {
        const rt = this.rt[s.id];
        if (!rt.on) return;
        if (s.kind === 'receiver') { if (!document.hidden) this.schedule(s, 0); return; }
        if (document.hidden) { rt.gen++; clearTimeout(rt.timer); clearTimeout(rt.subTimer); if (rt.ws) { try { rt.ws.close(); } catch (e) { /* closing already */ } rt.ws = null; } }
        else { rt.gen++; rt.fails = 0; this.connect(s); }
      }));
      // the stream arrives a message at a time: drawn at most once a second
      setInterval(() => { if (this.rt.aisstream.dirty && !document.hidden) { this.rt.aisstream.dirty = false; this.countStream(); this.render(); } this.tickStatus(); }, 1000);
      SOURCES.forEach(s => { if (this.srcConf(s.id).on) this.enable(s.id, true); });
      this.applyPaneState();
    },

    // Bring the running sources in line with the saved configuration (a project was opened).
    applyConf() {
      if (!this.rt.aisstream) return; // before init: init() reads the configuration itself
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
      const missing = src.kind === 'receiver' ? !receiverCandidates(cf.url).length : !String(cf.key || '').trim();
      if (missing) {
        if (!quiet) {
          MB.toast(src.kind === 'receiver' ? 'Enter the address of your AIS-catcher receiver first' : 'Enter your aisstream.io API key first');
          const el = document.querySelector(`[data-ais="${id}"] ${src.kind === 'receiver' ? '.ais-url' : '.ais-key'}`); if (el) el.focus();
        }
        cf.on = false;
        return;
      }
      rt.on = true; rt.gen++; rt.error = null; rt.fails = 0; rt.total = 0; rt.withPos = 0; rt.lastOk = 0; rt.resolved = null; rt.store = new Map(); rt.sent = '';
      cf.on = true; this.save();
      if (src.attribution && MB.map.attributionControl) MB.map.attributionControl.addAttribution(src.attribution);
      this.applyPaneState();
      if (src.kind === 'stream') this.connect(src); else this.schedule(src, 0);
      MB.emit('data');
    },

    disable(id) {
      const src = SOURCES.find(s => s.id === id), rt = this.rt[id];
      if (!src || !rt.on) return;
      rt.on = false; rt.gen++; clearTimeout(rt.timer); clearTimeout(rt.subTimer); rt.error = null; rt.total = 0; rt.withPos = 0;
      if (rt.ws) { try { rt.ws.close(); } catch (e) { /* closing already */ } rt.ws = null; }
      rt.store = new Map();
      this.srcConf(id).on = false; this.save();
      if (src.attribution && MB.map.attributionControl) MB.map.attributionControl.removeAttribution(src.attribution);
      this.ingest(id, []);
      this.render();
      this.applyPaneState();
      MB.emit('data');
    },

    toggle(id) { if (this.rt[id].on) this.disable(id); else this.enable(id); },

    // A new receiver address or key (reconnects when the source is on).
    setField(id, field, value, connect) {
      const cf = this.srcConf(id);
      value = String(value || '').trim();
      const changed = cf[field] !== value;
      if (changed) { cf[field] = value; this.save(); }
      if (this.rt[id].on && changed) { this.disable(id); this.enable(id); }
      else if (!this.rt[id].on && connect) this.enable(id);
    },
    setIntervalFor(id, seconds) {
      const cf = this.srcConf(id), src = SOURCES.find(s => s.id === id);
      cf.interval = src.intervals.includes(+seconds) ? +seconds : cf.interval;
      this.save();
      if (this.rt[id].on) this.schedule(src, cf.interval * 1000);
    },

    /* ----- AIS-catcher: polled ----- */
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
        const urls = rt.resolved ? [rt.resolved] : receiverCandidates(cf.url);
        let list, lastErr = new Error('No receiver address');
        for (const u of urls) {
          failedUrl = u;
          try { list = parseCatcher(await getJson(u)); rt.resolved = u; break; } catch (e) { lastErr = e; if (gen !== rt.gen) return; }
        }
        if (!list) throw lastErr;
        if (gen !== rt.gen) return;
        rt.error = null; rt.fails = 0; rt.lastOk = Date.now();
        rt.total = list.length; rt.withPos = list.filter(v => v.hasPos).length;
        this.ingest(src.id, list);
      } catch (err) {
        if (gen !== rt.gen) return;
        rt.fails++;
        rt.error = explain(src, err, failedUrl);
        if (rt.fails >= 3) { rt.resolved = null; this.ingest(src.id, []); } // the receiver may have moved: search again
      } finally { rt.busy = false; }
      if (gen !== rt.gen) return;
      this.render();
      this.tickStatus();
      const base = cf.interval * 1000;
      const wait = rt.fails ? Math.min(10000, base * Math.pow(2, Math.min(rt.fails, 5))) : base; // back off gently while failing
      this.schedule(src, Math.max(200, wait - (Date.now() - started)));
    },

    /* ----- aisstream.io: a WebSocket, subscribed to the map view ----- */
    connect(src) {
      const rt = this.rt[src.id], gen = rt.gen;
      let ws;
      if (document.hidden) return; // connected when the page is shown again
      try { ws = new WebSocket(STREAM_URL); } catch (e) { rt.error = 'Could not connect to aisstream.io'; rt.fails++; this.retry(src, gen, this.backoff(rt)); return; }
      ws.binaryType = 'arraybuffer';
      rt.ws = ws; rt.sent = ''; rt.sentAt = 0;
      let opened = false, heard = false, refused = '';
      const decoder = new TextDecoder();
      ws.onopen = () => { if (gen !== rt.gen) { ws.close(); return; } opened = true; this.subscribe(src); };
      ws.onmessage = ev => {
        if (gen !== rt.gen) return;
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : decoder.decode(ev.data)); } catch (e) { return; }
        if (msg && msg.error) { refused = String(msg.error); return; } // the service says why, then closes
        const rec = fromStream(msg, rt.store);
        if (!rec) return;
        if (!heard) { heard = true; rt.fails = 0; }
        rt.error = null; rt.lastOk = Date.now(); rt.dirty = true;
        if (rec.hasPos) { rec.src = src.id; this.upsert(src.id, rec); }
      };
      ws.onerror = () => {}; // a close follows
      ws.onclose = () => {
        if (gen !== rt.gen) return;
        rt.ws = null;
        if (!heard) rt.fails++;
        if (refused) rt.error = 'aisstream.io: ' + refused + (/key/i.test(refused) ? '. Check the API key.' : '');
        else if (!navigator.onLine) rt.error = 'Offline';
        else if (!heard && !window.gengisDesktop) rt.error = 'aisstream.io does not accept connections from web pages. This source works in the GenGIS desktop app.';
        else if (!opened) rt.error = 'Could not connect to aisstream.io';
        else if (!heard) rt.error = 'aisstream.io closed the connection. Check the API key.';
        else rt.error = 'Connection lost; reconnecting';
        this.tickStatus();
        if (!heard && !window.gengisDesktop && navigator.onLine) return; // refused in a web page: asking again will not help
        this.retry(src, gen, heard ? 1000 : this.backoff(rt));
      };
    },
    // reconnect: at once after a dropped connection that was working, backing off up to 5 min while refused
    backoff(rt) { return Math.min(300000, 5000 * Math.pow(2, Math.min(Math.max(rt.fails - 1, 0), 6))); },
    retry(src, gen, wait) {
      const rt = this.rt[src.id];
      clearTimeout(rt.timer);
      rt.timer = setTimeout(() => { if (gen === rt.gen && rt.on) this.connect(src); }, wait);
    },

    // Send the view as the subscription (it replaces the previous one); aisstream.io takes one update a second.
    subscribe(src) {
      const rt = this.rt[src.id], ws = rt.ws;
      if (!ws || ws.readyState !== 1) return;
      const boxes = viewBoxes(), sub = JSON.stringify(boxes);
      if (sub === rt.sent) return;
      const wait = rt.sentAt + 1100 - Date.now();
      if (wait > 0) { clearTimeout(rt.subTimer); rt.subTimer = setTimeout(() => this.subscribe(src), wait); return; }
      ws.send(JSON.stringify({ APIKey: this.srcConf(src.id).key, BoundingBoxes: boxes }));
      rt.sent = sub; rt.sentAt = Date.now();
    },
    subscribeSoon() {
      const rt = this.rt.aisstream;
      clearTimeout(rt.subTimer);
      rt.subTimer = setTimeout(() => this.subscribe(SOURCES.find(s => s.id === 'aisstream')), 400);
    },

    // The stream's counts, for its status line.
    countStream() {
      const rt = this.rt.aisstream, now = Date.now();
      let n = 0;
      rt.store.forEach((r, k) => {
        if (!r.hasPos) return;
        if ((now - r.posTime) / 1000 > MAX_AGE) rt.store.delete(k); else n++;
      });
      // names and types heard before a position are kept for when it comes, within reason
      if (rt.store.size > 50000) rt.store.forEach((r, k) => { if (!r.hasPos) rt.store.delete(k); });
      rt.total = rt.withPos = n;
    },

    /* ----- store: merge the sources by MMSI ----- */
    upsert(srcId, rec) {
      let e = this.vessels.get(rec.mmsi);
      if (!e) { e = { mmsi: rec.mmsi, by: {}, cur: null, marker: null }; this.vessels.set(rec.mmsi, e); }
      e.by[srcId] = rec;
    },
    ingest(srcId, list) {
      const seen = new Set();
      list.forEach(rec => {
        if (!rec.hasPos) return;
        seen.add(rec.mmsi);
        rec.src = srcId;
        this.upsert(srcId, rec);
      });
      this.vessels.forEach(e => { if (e.by[srcId] && !seen.has(e.mmsi)) delete e.by[srcId]; });
    },

    /* ----- drawing ----- */
    moving(v) { return v.sog != null && v.sog >= MOVING; },
    shape(v) { return v.kind === 'aton' ? 'aton' : (this.moving(v) ? 'moving' : 'stationary'); },

    visible(v) {
      const cf = this.conf();
      if (cf.off.includes(v.kind)) return false;
      if (!cf.stationary && v.kind !== 'aton' && !this.moving(v)) return false;
      return true;
    },

    render() {
      const now = Date.now();
      const bounds = MB.map.getBounds().pad(0.25);
      let drawn = 0;
      this.capped = 0;
      this.vessels.forEach((e, mmsi) => {
        // the freshest report wins; fields a source lacks (name, type, size) are filled from the others
        let cur = null;
        Object.keys(e.by).forEach(k => { const r = e.by[k]; if ((now - r.posTime) / 1000 > MAX_AGE) { delete e.by[k]; return; } if (!cur || r.posTime > cur.posTime) cur = r; });
        if (!cur) { this.drop(e); this.vessels.delete(mmsi); return; }
        e.cur = cur;
        if (!bounds.contains([cur.lat, cur.lon]) && mmsi !== this.selected) { this.drop(e); e.info = null; return; } // merged when it comes into view
        e.srcs = Object.keys(e.by);
        e.info = this.merged(e);
        if (!this.visible(e.info)) { this.drop(e); return; }
        if (drawn >= MAX_DRAWN && mmsi !== this.selected) { this.drop(e); this.capped++; return; }
        drawn++;
        this.draw(e, now);
      });
      this.updatePopup();
    },

    merged(e) {
      const out = Object.assign({}, e.cur);
      Object.keys(e.by).forEach(k => {
        const r = e.by[k];
        ['name', 'callsign', 'imo', 'shiptype', 'destination', 'eta', 'draught', 'length', 'width', 'country', 'cls', 'status'].forEach(f => { if ((out[f] == null || out[f] === '') && r[f] != null && r[f] !== '') out[f] = r[f]; });
        if (r.aton) out.aton = true;
      });
      out.kind = classify(out);
      return out;
    },

    label(v) { return v.name || v.callsign || 'MMSI ' + v.mmsi; },

    draw(e, now) {
      const v = e.info, shape = this.shape(v);
      const color = TYPES[v.kind].color, label = this.label(v), dim = (now - v.posTime) / 1000 > DIM_AGE;
      const dir = shape === 'moving' ? Math.round(v.heading != null ? v.heading : (v.cog != null ? v.cog : 0)) : 0;
      const ll = [v.lat, v.lon];
      if (!e.marker || e.shape !== shape) {
        this.drop(e);
        const size = SIZE[shape];
        e.marker = L.marker(ll, {
          pane: 'mb-ais', pmIgnore: true, keyboard: false, bubblingMouseEvents: true,
          icon: L.divIcon({ className: 'mb-vs mb-vs-' + shape, iconSize: [size, size], iconAnchor: [size / 2, size / 2],
            html: `<div class="mb-vs-rot"><svg viewBox="0 0 32 32" aria-hidden="true">${SHAPES[shape]}</svg></div><span class="mb-vs-label"></span>` })
        });
        e.marker.options.pmIgnore = true;
        e.marker.on('click', ev => {
          const t = MB.tools.current;
          if (t !== 'select' && t !== 'move' && t !== 'present') return; // drawing tools keep the click
          L.DomEvent.stopPropagation(ev);
          this.select(e.mmsi);
        });
        e.marker.addTo(MB.map);
        e.shape = shape; e.color = e.label = e.dir = e.dim = e.sel = null;
      } else e.marker.setLatLng(ll);
      const el = e.marker.getElement();
      if (!el) return;
      const rot = el.firstChild;
      if (e.dir !== dir) { rot.style.transform = dir ? `rotate(${dir}deg)` : ''; e.dir = dir; }
      if (e.color !== color) { rot.style.color = color; e.color = color; }
      if (e.label !== label) { el.lastChild.textContent = label; e.label = label; }
      if (e.dim !== dim) { el.classList.toggle('stale', dim); e.dim = dim; }
      const sel = e.mmsi === this.selected;
      if (e.sel !== sel) { el.classList.toggle('sel', sel); e.sel = sel; }
    },

    drop(e) {
      if (e.marker) { MB.map.removeLayer(e.marker); e.marker = null; }
      e.shape = null;
    },

    applyPaneState() {
      const pane = MB.map.getPane('mb-ais');
      if (pane) pane.classList.toggle('labels', !!this.conf().labels && MB.map.getZoom() >= LABEL_ZOOM);
    },

    setTypeShown(kind, on) {
      const cf = this.conf();
      cf.off = cf.off.filter(k => k !== kind);
      if (!on) cf.off.push(kind);
      this.save(); this.render();
    },

    /* ----- selection and popup ----- */
    select(mmsi) {
      const e = this.vessels.get(mmsi);
      if (!e || !e.cur) return;
      const prev = this.selected;
      this.selected = mmsi;
      if (prev && prev !== mmsi) { const p = this.vessels.get(prev); if (p && p.marker) this.draw(p, Date.now()); }
      if (this.popup) { const old = this.popup; this.popup = null; MB.map.closePopup(old); }
      const node = document.createElement('div');
      node.className = 'mb-popup mb-vs-info';
      node.innerHTML = '<div class="mb-popup-title"></div><table class="mb-datatable"></table><div class="mb-vs-links"></div>';
      const popup = L.popup({ className: 'mb-data-popup', maxWidth: 330, offset: [0, -6], autoPanPadding: [20, 20] }).setLatLng([e.cur.lat, e.cur.lon]).setContent(node);
      popup.on('remove', () => {
        if (this.popup !== popup) return;
        this.popup = null; this.selected = null;
        const cur = this.vessels.get(mmsi);
        if (cur && cur.marker) this.draw(cur, Date.now());
      });
      this.popup = popup;
      this.render(); // draws the selection and fills the popup
      popup.openOn(MB.map);
    },

    updatePopup() {
      const popup = this.popup;
      if (!popup) return;
      const e = this.vessels.get(this.selected), node = popup.getContent();
      if (!e || !e.cur) { // gone: keep the last values, say so
        const t = node.querySelector('.mb-popup-title'); if (t && !t.querySelector('.gone')) t.insertAdjacentHTML('beforeend', ' <span class="gone dim">· signal lost</span>');
        return;
      }
      const v = e.info, units = MB.state.units;
      const spd2 = kt => units === 'metric' ? ` (${(kt * 1.852).toFixed(1)} km/h)` : (units === 'imperial' ? ` (${(kt * 1.15078).toFixed(1)} mph)` : '');
      const len = m => units === 'imperial' ? `${Math.round(m * 3.28084)} ft` : `${m} m`;
      const rows = [];
      const row = (k, val) => { if (val !== '' && val != null) rows.push(`<tr><td>${esc(k)}</td><td>${val}</td></tr>`); };
      row('Name', esc(v.name));
      row('MMSI', esc(v.mmsi) + (v.cls ? ` <span class="dim">· class ${v.cls}</span>` : ''));
      row('IMO', v.imo ? esc(String(v.imo)) : '');
      row('Call sign', esc(v.callsign));
      row('Flag', esc(v.country));
      row('Type', v.kind === 'aton' ? esc(/^00/.test(v.mmsi) ? 'Base station' : 'Aid to navigation') : `<i class="swatch" style="background:${TYPES[v.kind].color}"></i>${esc(typeName(v.shiptype) || 'Not reported')}`);
      row('Status', esc(v.status != null ? STATUS[v.status] || '' : ''));
      row('Speed', v.sog == null ? '' : `${v.sog.toFixed(1)} kn${spd2(v.sog)}`);
      row('Course', v.cog == null ? '' : `${Math.round(v.cog)}°`);
      row('Heading', v.heading == null ? '' : `${Math.round(v.heading)}°`);
      row('Destination', esc(v.destination) + (v.eta ? ` <span class="dim">· ETA ${esc(v.eta)}</span>` : ''));
      row('Size', v.length && v.width ? `${len(v.length)} × ${len(v.width)}` : '');
      row('Draught', v.draught ? (units === 'imperial' ? `${(v.draught * 3.28084).toFixed(1)} ft` : `${v.draught} m`) : '');
      row('Position', esc(MB.formatLatLng({ lat: v.lat, lng: v.lon })));
      const age = Math.max(0, Math.round((Date.now() - v.posTime) / 1000));
      row('Seen', `${age < 2 ? 'now' : (age < 120 ? age + ' s ago' : Math.round(age / 60) + ' min ago')} · ${esc(e.srcs.map(id => SOURCES.find(s => s.id === id).name).join(', '))}`);
      node.querySelector('.mb-popup-title').innerHTML = `${esc(this.label(v))} <span class="dim">· ${esc(TYPES[v.kind].one)}</span>`;
      node.querySelector('.mb-datatable').innerHTML = rows.join('');
      node.querySelector('.mb-vs-links').innerHTML = v.kind === 'aton' ? '' :
        `<a href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${v.mmsi}" target="_blank" rel="noopener">MarineTraffic</a> · <a href="https://www.vesselfinder.com/vessels/details/${v.mmsi}" target="_blank" rel="noopener">VesselFinder</a>`;
      popup.setLatLng([v.lat, v.lon]);
    },

    // "Find vessel": a tracked vessel by name, call sign or MMSI.
    find(q) {
      const st = this.findState;
      st.q = q = String(q || '').trim();
      const say = html => { st.html = html; const el = document.getElementById('aisFindOut'); if (el) el.innerHTML = html; };
      if (!q) { say(''); return; }
      const Q = q.toUpperCase();
      let hit = null;
      this.vessels.forEach(e => { if (!e.info && e.cur) { e.srcs = Object.keys(e.by); e.info = this.merged(e); } }); // out of view: not merged yet
      this.vessels.forEach(e => { if (!hit && e.info && (e.mmsi === Q.padStart(9, '0') || e.info.name.toUpperCase() === Q || e.info.callsign.toUpperCase() === Q)) hit = e; });
      if (!hit) this.vessels.forEach(e => { if (!hit && e.info && e.info.name.toUpperCase().includes(Q)) hit = e; });
      if (!hit) { say('<div class="note">No tracked vessel by that name, call sign or MMSI.</div>'); return; }
      say(`<div class="note">${esc(this.label(hit.info))} is on the map.</div>`);
      MB.map.setView([hit.cur.lat, hit.cur.lon], Math.max(MB.map.getZoom(), 12));
      this.select(hit.mmsi);
    },

    /* ----- panel (rendered inside the Data tab by MB.data.renderPanel) ----- */
    statusText(id) {
      const rt = this.rt[id], src = SOURCES.find(s => s.id === id);
      if (!rt.on) return 'Off';
      if (rt.error) return rt.error;
      if (!rt.lastOk) return 'Connecting…';
      const bits = [`${rt.withPos} vessel${rt.withPos === 1 ? '' : 's'}` + (rt.total > rt.withPos ? ` (${rt.total - rt.withPos} more without a position)` : '')];
      if (src.kind === 'stream') bits.push('live');
      else { const age = Math.round((Date.now() - rt.lastOk) / 1000); bits.push(age <= Math.max(2, this.srcConf(id).interval + 1) ? 'live' : 'data is ' + age + ' s old'); }
      if (this.capped) bits.push(`${MAX_DRAWN.toLocaleString()} drawn; zoom in for the rest`);
      if (document.hidden) bits.push('paused');
      return bits.join(' · ');
    },

    tickStatus() {
      SOURCES.forEach(s => {
        const el = document.getElementById('aisStatus-' + s.id);
        if (!el) return;
        const t = this.statusText(s.id), err = !!(this.rt[s.id].on && this.rt[s.id].error);
        if (el.textContent !== t) el.textContent = t;
        el.classList.toggle('err', err);
      });
      const n = document.getElementById('aisCount');
      if (n) { const t = this.countText(); if (n.textContent !== t) n.textContent = t; }
    },

    countText() {
      if (!this.anyOn()) return this.enabledCount() + '/' + SOURCES.length + ' on';
      let shown = 0;
      this.vessels.forEach(e => { if (e.marker) shown++; });
      return shown + ' shown';
    },

    matches(src, q, filter) {
      const on = this.rt[src.id].on;
      if (filter === 'on' && !on) return false;
      if (filter === 'off' && on) return false;
      if (!q) return true;
      return ['ais live vessel marine traffic ships boats', src.name, src.section, src.desc].join(' ').toLowerCase().includes(q);
    },

    panelHtml(q, filter) {
      const list = SOURCES.filter(s => this.matches(s, q, filter));
      if (!list.length) return '';
      const cf = this.conf();
      const sections = {};
      list.forEach(s => { (sections[s.section] = sections[s.section] || []).push(s); });
      let html = `<details class="ds-source" id="aisSource" data-src="ais"${MB.data.sourceOpen('ais') ? ' open' : ''}><summary class="ds-source-head"><h3>AIS live vessel traffic</h3><span class="badge" id="aisCount">${this.countText()}</span></summary>
        <p class="note">Vessel positions as they are received. Informational only, not for navigation.</p>`;
      Object.keys(sections).forEach(sec => {
        html += `<div class="section"><h3>${esc(sec)}</h3>`;
        sections[sec].forEach(s => {
          const rt = this.rt[s.id], sc = this.srcConf(s.id);
          html += `<div class="data-item${rt.on ? ' on' : ''}" data-ais="${s.id}">
            <div class="ds-head"><label class="check"><input type="checkbox" data-act="ais-toggle"${rt.on ? ' checked' : ''}> <span class="dname">${s.site ? `<a href="${s.site}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)}</span></label>${MB.data.infoIcon(s.desc)}</div>
            ${s.kind === 'receiver' ? `<div class="row adsb-row"><label>Server</label><input type="text" class="ais-url" data-keep-focus value="${esc(sc.url)}" placeholder="http://192.168.1.50:8100" autocomplete="off" spellcheck="false"></div>
            <div class="row adsb-row"><label>Refresh</label><select class="ais-interval">${s.intervals.map(n => `<option value="${n}"${+sc.interval === n ? ' selected' : ''}>every ${n} s</option>`).join('')}</select></div>`
            : `<div class="row adsb-row"><label>API key</label><input type="password" class="ais-key" data-keep-focus value="${esc(sc.key)}" placeholder="Key from aisstream.io" autocomplete="off" spellcheck="false"></div>`}
            <div class="dstatus${rt.on && rt.error ? ' err' : ''}" id="aisStatus-${s.id}">${esc(this.statusText(s.id))}</div>
          </div>`;
        });
        html += '</div>';
      });
      html += `<div class="section"><h3>Vessels shown</h3><div class="data-item adsb-display">
          <div class="subsets ais-types">${TYPE_KEYS.map(k => `<label class="sub${cf.off.includes(k) ? ' off' : ''}"><input type="checkbox" data-ais-type="${k}"${cf.off.includes(k) ? '' : ' checked'}><svg viewBox="0 0 32 32" aria-hidden="true" style="color:${TYPES[k].color}">${SHAPES[k === 'aton' ? 'aton' : 'moving']}</svg>${esc(TYPES[k].name)}</label>`).join('')}</div>
          <div class="subsets"><label class="sub"><input type="checkbox" id="aisStationary"${cf.stationary ? ' checked' : ''}>Moored and at anchor</label><label class="sub"><input type="checkbox" id="aisLabels"${cf.labels ? ' checked' : ''}>Name labels</label></div>
          <form class="row adsb-row" id="aisFind"><input type="text" data-keep-focus value="${esc(this.findState.q)}" placeholder="Find vessel name, call sign or MMSI" autocomplete="off" spellcheck="false"><button class="btn small" type="submit">Find</button></form>
          <div id="aisFindOut">${this.findState.html}</div>
          <div class="note">Icon color shows the vessel type; a circle is a vessel under ${MOVING} kn. Click a vessel for details.</div>
        </div></div></details>`;
      return html;
    },

    bindPanel(panel) {
      panel.querySelectorAll('[data-ais]').forEach(item => {
        const id = item.dataset.ais;
        const url = item.querySelector('.ais-url'), key = item.querySelector('.ais-key');
        const field = url ? ['url', url] : ['key', key];
        const cb = item.querySelector('[data-act="ais-toggle"]');
        cb.addEventListener('change', () => {
          this.setField(id, field[0], field[1].value);
          this.toggle(id);
          cb.checked = this.rt[id].on; item.classList.toggle('on', this.rt[id].on); // enabling is refused without an address or key
        });
        field[1].addEventListener('change', () => this.setField(id, field[0], field[1].value));
        field[1].addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.setField(id, field[0], field[1].value, true); field[1].blur(); } });
        const iv = item.querySelector('.ais-interval');
        if (iv) iv.addEventListener('change', e => this.setIntervalFor(id, e.target.value));
      });
      panel.querySelectorAll('input[data-ais-type]').forEach(cb => cb.addEventListener('change', () => { cb.closest('label').classList.toggle('off', !cb.checked); this.setTypeShown(cb.dataset.aisType, cb.checked); }));
      const st = panel.querySelector('#aisStationary'), l = panel.querySelector('#aisLabels'), f = panel.querySelector('#aisFind');
      if (st) st.addEventListener('change', () => { this.conf().stationary = st.checked; this.save(); this.render(); });
      if (l) l.addEventListener('change', () => { this.conf().labels = l.checked; this.save(); this.applyPaneState(); });
      if (f) f.addEventListener('submit', e => { e.preventDefault(); this.find(f.querySelector('input').value); });
    }
  };

})(window.MB);
