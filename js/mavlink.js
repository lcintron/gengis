/* GenGIS - live drones (MAVLink)
 * - reads MAVLink (v1 and v2) from a mavp2p (or mavlink-router) server. The desktop app connects over TCP or UDP
 *   (electron/mavlink.js opens the link); a web page cannot open those, so it connects through a WebSocket bridge
 *   (websockify) instead
 * - read only: nothing is ever sent to a vehicle (over UDP to a server, the desktop app sends a keepalive of its own
 *   so the server keeps sending; it is not a ground station's heartbeat and carries no command)
 * - one marker per vehicle (MAVLink system id): icon by vehicle type, pointed along its heading, orange when armed;
 *   its trail and home position; click it for flight mode, altitude, speed, battery, GPS and its latest message
 * Nothing is stored: positions live in memory only. The connection and the display options are device settings.
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = MB.escapeHtml;
  const DIM_AGE = 5;        // s without a message from a vehicle: drawn faded
  const MAX_AGE = 300;      // s: its last known position is kept this long, then removed
  const TRAIL_POINTS = 900; // trail points kept per vehicle
  const TRAIL_STEP = 1.5;   // m: a new trail point once the vehicle has moved this far
  const NOT_MAVLINK = 8192; // bytes received without a single valid frame: not a MAVLink stream
  const COLORS = { armed: '#ff8a3d', disarmed: '#3fd0f0' };

  // How GenGIS reaches the server. tcp, udp and listen need the desktop app (a page cannot open TCP or UDP).
  const KINDS = {
    tcp: { name: 'TCP (mavp2p tcps)', port: 5760, desktop: true, placeholder: '192.168.1.20',
      help: 'mavp2p\'s TCP server endpoint, for example <code>tcps:0.0.0.0:5760</code>. Enter the IP address of the computer running mavp2p (port 5760, or add another: 192.168.1.20:5761).' },
    udp: { name: 'UDP (mavp2p udps)', port: 14550, desktop: true, placeholder: '192.168.1.20',
      help: 'mavp2p\'s UDP server endpoint, for example <code>udps:0.0.0.0:14550</code>. Enter the IP address of the computer running mavp2p (port 14550, or add another). GenGIS sends it a small keepalive once a second so it keeps sending; no commands, and not a ground station\'s heartbeat.' },
    listen: { name: 'UDP, listen here', port: 14550, desktop: true, placeholder: '14550', field: 'Port',
      help: 'GenGIS listens for MAVLink sent to this computer: give mavp2p an endpoint <code>udpc:THIS-COMPUTER-IP:14550</code>, or point a vehicle or router here. Enter the port (14550), or address:port to listen on one network only. Windows may ask to let GenGIS through its firewall the first time.' },
    ws: { name: 'WebSocket (websockify)', port: 5761, placeholder: '192.168.1.20:5761',
      help: 'mavp2p has no WebSocket, and a web page can open nothing else: run <code>websockify 5761 localhost:5760</code> next to mavp2p\'s <code>tcps:0.0.0.0:5760</code> endpoint. The desktop app can use TCP directly.' }
  };
  const KIND_KEYS = Object.keys(KINDS);

  /* ---------- MAVLink: the messages read, as [CRC extra, full payload length] (common.xml) ---------- */
  const MSGS = {
    0: [50, 9],      // HEARTBEAT
    1: [124, 43],    // SYS_STATUS
    24: [24, 52],    // GPS_RAW_INT
    30: [39, 28],    // ATTITUDE
    33: [104, 28],   // GLOBAL_POSITION_INT
    74: [20, 20],    // VFR_HUD
    147: [154, 54],  // BATTERY_STATUS
    242: [104, 60],  // HOME_POSITION
    245: [130, 2],   // EXTENDED_SYS_STATE
    253: [83, 54]    // STATUSTEXT
  };

  // CRC-16/MCRF4XX (MAVLink's "x25") over buf[start, end), then the message's CRC extra.
  function crc16(buf, start, end, extra) {
    let crc = 0xffff;
    const acc = b => { let t = (b ^ crc) & 0xff; t = (t ^ (t << 4)) & 0xff; crc = ((crc >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 0xffff; };
    for (let i = start; i < end; i++) acc(buf[i]);
    acc(extra);
    return crc;
  }

  // A byte stream in, whole messages out: { sysid, compid, msgid, v: DataView of the payload at its full length }.
  // Frames of messages not read here are skipped whole; a frame that fails its checksum is skipped a byte at a time.
  class Parser {
    constructor(onMsg) { this.buf = new Uint8Array(0); this.onMsg = onMsg; this.valid = 0; }
    push(chunk) {
      let buf = chunk;
      if (this.buf.length) { buf = new Uint8Array(this.buf.length + chunk.length); buf.set(this.buf); buf.set(chunk, this.buf.length); }
      let i = 0;
      while (i < buf.length) {
        const stx = buf[i];
        if (stx !== 0xFD && stx !== 0xFE) { i++; continue; }
        const v2 = stx === 0xFD, hl = v2 ? 10 : 6;
        if (buf.length - i < hl) break;
        const len = buf[i + 1], flags = v2 ? buf[i + 2] : 0;
        if (flags & ~1) { i++; continue; } // an incompatibility flag this reader does not know: not a frame it can read
        const total = hl + len + 2 + (flags & 1 ? 13 : 0); // (a signed frame carries a 13-byte signature)
        if (buf.length - i < total) break;
        const msgid = v2 ? buf[i + 7] | buf[i + 8] << 8 | buf[i + 9] << 16 : buf[i + 5];
        const def = MSGS[msgid];
        if (def) {
          const end = i + hl + len;
          if (crc16(buf, i + 1, end, def[0]) !== (buf[end] | buf[end + 1] << 8)) { i++; continue; }
          const payload = new Uint8Array(Math.max(def[1], len)); // MAVLink 2 drops trailing zero bytes: put them back
          payload.set(buf.subarray(i + hl, end));
          this.valid++;
          try { this.onMsg({ sysid: buf[i + (v2 ? 5 : 3)], compid: buf[i + (v2 ? 6 : 4)], msgid, v: new DataView(payload.buffer) }); } catch (e) { /* one bad message */ }
        } else if (i + total < buf.length && buf[i + total] !== 0xFD && buf[i + total] !== 0xFE) { i++; continue; } // (no checksum to go by: only when another frame follows it)
        i += total;
      }
      this.buf = i >= buf.length ? new Uint8Array(0) : buf.slice(i);
      if (this.buf.length > 65536) this.buf = new Uint8Array(0);
    }
  }

  /* ---------- names ---------- */
  const TYPE_NAMES = { 0: 'Vehicle', 1: 'Fixed wing', 2: 'Quadcopter', 3: 'Coaxial helicopter', 4: 'Helicopter', 7: 'Airship', 8: 'Balloon', 9: 'Rocket',
    10: 'Ground rover', 11: 'Boat', 12: 'Submarine', 13: 'Hexacopter', 14: 'Octocopter', 15: 'Tricopter', 16: 'Flapping wing', 17: 'Kite', 19: 'VTOL tailsitter (duo)',
    20: 'VTOL tailsitter (quad)', 21: 'VTOL tiltrotor', 22: 'VTOL', 23: 'VTOL tailsitter', 24: 'VTOL tiltwing', 25: 'VTOL', 28: 'Parafoil', 29: 'Dodecacopter', 35: 'Decacopter', 43: 'Multicopter' };
  const AUTOPILOTS = { 3: 'ArduPilot', 12: 'PX4', 4: 'OpenPilot', 13: 'SMACCMPilot', 14: 'AutoQuad', 15: 'Armazila', 16: 'Aerob', 17: 'ASLUAV', 18: 'SmartAP', 19: 'AirRails', 20: 'Reflex' };
  const SYS_STATUS = ['', 'Booting', 'Calibrating', 'Standby', 'Active', 'Critical', 'Emergency', 'Powering off', 'Flight termination'];
  const LANDED = ['', 'On the ground', 'In the air', 'Taking off', 'Landing'];
  const FIX = ['No GPS', 'No fix', '2D fix', '3D fix', 'DGPS', 'RTK float', 'RTK fixed', 'Static', 'PPP'];
  const SEVERITY = ['Emergency', 'Alert', 'Critical', 'Error', 'Warning', 'Notice', 'Info', 'Debug'];

  const COPTER = { 0: 'Stabilize', 1: 'Acro', 2: 'AltHold', 3: 'Auto', 4: 'Guided', 5: 'Loiter', 6: 'RTL', 7: 'Circle', 9: 'Land', 11: 'Drift', 13: 'Sport', 14: 'Flip',
    15: 'AutoTune', 16: 'PosHold', 17: 'Brake', 18: 'Throw', 19: 'Avoid ADS-B', 20: 'Guided NoGPS', 21: 'Smart RTL', 22: 'FlowHold', 23: 'Follow', 24: 'ZigZag',
    25: 'SystemID', 26: 'Autorotate', 27: 'Auto RTL', 28: 'Turtle' };
  const PLANE = { 0: 'Manual', 1: 'Circle', 2: 'Stabilize', 3: 'Training', 4: 'Acro', 5: 'FBWA', 6: 'FBWB', 7: 'Cruise', 8: 'AutoTune', 10: 'Auto', 11: 'RTL', 12: 'Loiter',
    13: 'Takeoff', 14: 'Avoid ADS-B', 15: 'Guided', 17: 'QStabilize', 18: 'QHover', 19: 'QLoiter', 20: 'QLand', 21: 'QRTL', 22: 'QAutoTune', 23: 'QAcro', 24: 'Thermal',
    25: 'Loiter to QLand' };
  const ROVER = { 0: 'Manual', 1: 'Acro', 3: 'Steering', 4: 'Hold', 5: 'Loiter', 6: 'Follow', 7: 'Simple', 8: 'Dock', 9: 'Circle', 10: 'Auto', 11: 'RTL', 12: 'Smart RTL', 15: 'Guided' };
  const SUB = { 0: 'Stabilize', 1: 'Acro', 2: 'Depth hold', 3: 'Auto', 4: 'Guided', 7: 'Circle', 9: 'Surface', 16: 'PosHold', 19: 'Manual' };
  const MULTI = [2, 3, 4, 13, 14, 15, 29, 35, 43];

  function modeName(v) {
    if (v.customMode == null || !(v.baseMode & 1)) return '';
    const cm = v.customMode;
    if (v.autopilot === 3) {
      const table = MULTI.includes(v.type) ? COPTER : (v.type === 1 || (v.type >= 19 && v.type <= 25) ? PLANE : (v.type === 10 || v.type === 11 ? ROVER : (v.type === 12 ? SUB : null)));
      return table ? table[cm] || 'Mode ' + cm : 'Mode ' + cm;
    }
    if (v.autopilot === 12) {
      const main = (cm >>> 16) & 0xff, sub = (cm >>> 24) & 0xff;
      if (main === 4) return { 1: 'Ready', 2: 'Takeoff', 3: 'Hold', 4: 'Mission', 5: 'Return', 6: 'Land', 8: 'Follow me', 9: 'Precision land' }[sub] || 'Auto';
      return { 1: 'Manual', 2: 'Altitude', 3: 'Position', 5: 'Acro', 6: 'Offboard', 7: 'Stabilized', 8: 'Rattitude' }[main] || '';
    }
    return '';
  }

  /* ---------- vehicle icons: drawn pointing north in a 32 x 32 box ---------- */
  const SHAPES = {
    multi: '<path class="arm-bg" d="M9 9l14 14M23 9L9 23"/><path class="arm" d="M9 9l14 14M23 9L9 23"/><circle class="rotor" cx="8" cy="8" r="5.5"/><circle class="rotor" cx="24" cy="8" r="5.5"/><circle class="rotor" cx="8" cy="24" r="5.5"/><circle class="rotor" cx="24" cy="24" r="5.5"/><path d="M16 8l5.500 11-5.500-2.800-5.500 2.800z"/>',
    heli: '<circle class="rotor" cx="16" cy="15" r="12.500"/><path d="M16 5l4.500 10-2.300 1v11h1.800v2h-8v-2h1.800V16l-2.300-1z"/>',
    plane: '<path d="M16 2.500c1.300 0 2 1.200 2 2.800v7.200l11 6.200v3l-11-3.200v6.300l3.500 2.600v2.400L16 28.500l-5.500 1.300v-2.400l3.500-2.600v-6.300L3 21.700v-3l11-6.200V5.300c0-1.600.7-2.800 2-2.800z"/>',
    vtol: '<circle class="rotor" cx="6" cy="10" r="4"/><circle class="rotor" cx="26" cy="10" r="4"/><circle class="rotor" cx="6" cy="24" r="4"/><circle class="rotor" cx="26" cy="24" r="4"/><path d="M16 2.500c1.300 0 2 1.200 2 2.800v7.200l11 4.200v3l-11-1.200v6.300l3.500 2.600v2.400L16 28.500l-5.500 1.300v-2.400l3.500-2.600v-6.300L3 19.700v-3l11-4.200V5.300c0-1.600.7-2.800 2-2.800z"/>',
    rover: '<path d="M11 5h10a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z"/><path class="mark" d="M16 9l4.500 7h-9z"/>',
    boat: '<path d="M16 2.500c3.200 3.800 5.200 8.400 5.200 13.600v11.400c0 1-.8 1.800-1.800 1.800h-6.800c-1 0-1.800-.8-1.800-1.800V16.100c0-5.200 2-9.800 5.200-13.600z"/>',
    other: '<path d="M16 3l10 25-10-6-10 6z"/>'
  };
  const SIZE = { multi: 28, heli: 28, plane: 28, vtol: 30, rover: 20, boat: 22, other: 22 };
  function shapeOf(t) {
    if (MULTI.includes(t)) return t === 4 || t === 3 ? 'heli' : 'multi';
    if (t >= 19 && t <= 25) return 'vtol';
    if (t === 1 || t === 16 || t === 17 || t === 28) return 'plane';
    if (t === 10) return 'rover';
    if (t === 11 || t === 12) return 'boat';
    return 'other';
  }

  /* ---------- addresses ---------- */
  // What the user typed, as the link to open: { host, port } (tcp, udp, listen) or { url } (ws). null: not usable.
  function target(kind, input) {
    const k = KINDS[kind];
    if (!k) return null;
    let s = String(input || '').trim();
    if (kind === 'ws') {
      if (!s) return null;
      if (!/^wss?:\/\//i.test(s)) s = 'ws://' + s.replace(/^https?:\/\//i, '');
      try {
        const u = new URL(s);
        if (!u.port) u.port = String(k.port);
        return { url: u.href };
      } catch (e) { return null; }
    }
    s = s.replace(/^(?:tcp|udp|tcpc|tcps|udpc|udps|udpb):\/*/i, '').replace(/\/+$/, '');
    if (kind === 'listen') {
      if (!s) return { host: '0.0.0.0', port: k.port };
      if (/^\d+$/.test(s)) s = '0.0.0.0:' + s;
    }
    if (!s) return null;
    const m = s.match(/^\[([0-9a-f:.]+)\](?::(\d+))?$/i) || s.match(/^([a-z0-9.-]+)(?::(\d+))?$/i);
    if (!m) return null;
    const port = m[2] ? +m[2] : k.port;
    if (!(port >= 1 && port <= 65535)) return null;
    const host = m[1];
    if (kind === 'listen' && !/^(\d{1,3}\.){3}\d{1,3}$/.test(host) && !host.includes(':')) return null; // a bind address is an IP
    return { host, port };
  }
  const where = t => t.url ? t.url.replace(/\/$/, '') : (t.host.includes(':') ? `[${t.host}]` : t.host) + ':' + t.port;

  function isLocalHost(url) {
    try { const h = new URL(url).hostname; return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || /\.localhost$/.test(h); } catch (e) { return false; }
  }

  // The desktop app's reasons for a link that failed (Node error codes), in words.
  function linkError(code, t, kind) {
    const at = where(t);
    switch (code) {
      case 'ECONNREFUSED': return kind === 'udp' ? `Nothing answered at ${at}. Check the address, and that mavp2p has a udps endpoint on that port.` : `Connection refused at ${at}. Check the address, and that mavp2p has a tcps endpoint on that port.`;
      case 'ENOTFOUND': case 'EAI_AGAIN': return `Could not find ${t.host}. Check the address.`;
      case 'ETIMEDOUT': case 'TIMEOUT': return `No answer from ${at}. Check the address, and that this computer can reach it.`;
      case 'EHOSTUNREACH': case 'ENETUNREACH': return `${t.host} cannot be reached from this computer.`;
      case 'ECONNRESET': return 'The server closed the connection; reconnecting.';
      case 'EADDRINUSE': return `Port ${t.port} is already in use on this computer (another ground station?). Choose another port, and send to it.`;
      case 'EADDRNOTAVAIL': return `${t.host} is not an address of this computer.`;
      case 'EACCES': return `Not allowed to listen on port ${t.port}. Use a port above 1024.`;
      case 'CLOSED': return 'Connection closed; reconnecting.';
      default: return 'Connection failed' + (code ? ' (' + code + ')' : '') + '; retrying.';
    }
  }

  const i8 = (d, o) => d.getInt8(o), u8 = (d, o) => d.getUint8(o), u16 = (d, o) => d.getUint16(o, true), i16 = (d, o) => d.getInt16(o, true);
  const u32 = (d, o) => d.getUint32(o, true), i32 = (d, o) => d.getInt32(o, true), f32 = (d, o) => d.getFloat32(o, true);
  const fin = x => (isFinite(x) ? x : null);
  const deg = r => ((r * 180 / Math.PI) % 360 + 360) % 360;

  /* ---------- module ---------- */
  MB.mavlink = {
    kinds: KINDS, Parser, target, crc16, modeName,
    rt: { on: false, gen: 0, token: 0, ws: null, link: null, open: false, error: null, fails: 0, timer: null, parser: null, bytes: 0, lastData: 0, systems: new Set() },
    vehicles: new Map(), // sysid -> vehicle state, its marker, trail and home marker
    selected: null, popup: null, dirty: false,

    conf() {
      const s = MB.settings.mavlink = MB.settings.mavlink || {};
      if (!KINDS[s.kind] || (KINDS[s.kind].desktop && !window.gengisDesktop)) s.kind = window.gengisDesktop ? 'tcp' : 'ws'; // a page: the bridge
      if (typeof s.url !== 'string') s.url = '';
      s.on = !!s.on;
      if (s.labels === undefined) s.labels = true;
      if (s.trails === undefined) s.trails = true;
      return s;
    },
    save() { MB.saveSettings(); if (MB.autosave) MB.autosave(); }, // the project records the connection and options in use
    desktop() { return !!(window.gengisDesktop && window.gengisDesktop.mavlink); },

    init() {
      // Above every other map layer, live air and vessel traffic included (adsb.js): a click on a drone opens its details.
      const trail = MB.map.createPane('mb-uav-trail');
      trail.style.zIndex = 628;
      trail.style.pointerEvents = 'none';
      const pane = MB.map.createPane('mb-uav');
      pane.style.zIndex = 630;
      MB.on('units', () => { this.vehicles.forEach(v => { v.label = null; }); this.render(); });
      if (this.desktop()) {
        const d = window.gengisDesktop.mavlink;
        d.onData((token, bytes) => { if (token === this.rt.token && this.rt.on) this.feed(bytes); });
        d.onStatus((token, st) => { if (token === this.rt.token && this.rt.on) this.linkStatus(st); });
      }
      setInterval(() => { if (this.dirty) { this.dirty = false; this.render(); } }, 250); // messages come many a second: drawn 4 times a second
      setInterval(() => { this.expire(); this.tickStatus(); }, 1000);
      if (this.conf().on) this.enable(true);
      this.applyPaneState();
    },

    // Bring the connection in line with the saved configuration (a project was opened).
    applyConf() {
      if (!MB.map || !MB.map.getPane('mb-uav')) return; // before init: init() reads the configuration itself
      const want = this.conf().on;
      if (want && !this.rt.on) this.enable(true); else if (!want && this.rt.on) this.disable();
      this.applyPaneState();
      this.render();
      MB.emit('data');
    },

    enabledCount() { return this.rt.on ? 1 : 0; },

    enable(quiet) {
      const cf = this.conf(), rt = this.rt;
      if (rt.on) return;
      if (!target(cf.kind, cf.url)) {
        if (!quiet) {
          MB.toast(cf.kind === 'listen' ? 'Enter a port to listen on' : 'Enter the address of your MAVLink server first');
          const el = document.querySelector('#mavSource .mav-url'); if (el) el.focus();
        }
        cf.on = false;
        return;
      }
      rt.on = true; rt.error = null; rt.fails = 0;
      cf.on = true; this.save();
      this.connect();
      MB.emit('data');
    },

    disable() {
      const rt = this.rt;
      if (!rt.on) return;
      rt.on = false;
      this.hangUp();
      rt.error = null;
      this.conf().on = false; this.save();
      this.vehicles.forEach(v => this.drop(v));
      this.vehicles.clear();
      if (this.popup) { const p = this.popup; this.popup = null; this.selected = null; MB.map.closePopup(p); }
      MB.emit('data');
    },

    toggle() { if (this.rt.on) this.disable(); else this.enable(); },

    // A new connection kind or address (reconnects when on).
    setConn(kind, url, connect) {
      const cf = this.conf();
      url = String(url || '').trim();
      if (!KINDS[kind]) kind = cf.kind;
      const changed = cf.kind !== kind || cf.url !== url;
      if (changed) { cf.kind = kind; cf.url = url; this.save(); }
      if (this.rt.on && changed) { this.disable(); this.enable(); }
      else if (!this.rt.on && connect) this.enable();
    },

    /* ----- the link ----- */
    hangUp() {
      const rt = this.rt;
      rt.gen++; clearTimeout(rt.timer);
      if (rt.ws) { const ws = rt.ws; rt.ws = null; try { ws.close(); } catch (e) { /* closing already */ } }
      if (rt.link != null && this.desktop()) window.gengisDesktop.mavlink.close(rt.link);
      rt.link = null; rt.open = false;
    },

    connect() {
      const rt = this.rt, cf = this.conf();
      this.hangUp();
      const gen = rt.gen, t = target(cf.kind, cf.url);
      rt.parser = new Parser(m => this.handle(m));
      rt.bytes = 0; rt.lastData = 0; rt.systems = new Set(); rt.target = t; rt.kind = cf.kind;
      if (!t) { rt.error = 'Enter the address of your MAVLink server.'; return; }
      if (cf.kind === 'ws') {
        if (location.protocol === 'https:' && /^ws:/i.test(t.url) && !isLocalHost(t.url)) {
          rt.error = 'This page is served over HTTPS, so the browser blocks a plain ws:// bridge. Use the desktop app, open GenGIS from http://localhost, or serve the bridge over wss://.';
          return; // retrying will not help
        }
        let ws;
        try { ws = new WebSocket(t.url); } catch (e) { rt.error = 'That is not a WebSocket address.'; return; }
        ws.binaryType = 'arraybuffer';
        rt.ws = ws;
        let opened = false;
        ws.onopen = () => { if (gen !== rt.gen) return; opened = rt.open = true; rt.error = null; this.tickStatus(); };
        ws.onmessage = ev => { if (gen === rt.gen && typeof ev.data !== 'string') this.feed(new Uint8Array(ev.data)); };
        ws.onerror = () => {}; // a close follows
        ws.onclose = () => {
          if (gen !== rt.gen) return;
          rt.ws = null; rt.open = false;
          if (!navigator.onLine) rt.error = 'Offline';
          else if (!opened) rt.error = `Could not connect to ${where(t)}. Check the address, and that the WebSocket bridge (websockify) is running.`;
          else rt.error = 'Connection lost; reconnecting.';
          this.retry(gen, opened);
        };
      } else {
        if (!this.desktop()) { rt.error = 'This connection works in the GenGIS desktop app. In a web page, connect through a WebSocket bridge.'; return; }
        const token = rt.token = rt.token + 1;
        rt.link = token;
        window.gengisDesktop.mavlink.open(token, cf.kind, t.host, t.port).then(res => {
          if (gen !== rt.gen) return;
          if (res && res.error) { rt.link = null; rt.error = res.error; this.retry(gen, false); }
        }, () => { if (gen === rt.gen) { rt.link = null; rt.error = 'Could not open the connection.'; this.retry(gen, false); } });
      }
      this.tickStatus();
    },

    // From the desktop app: { state: 'open' } or { state: 'closed', code }.
    linkStatus(st) {
      const rt = this.rt, gen = rt.gen;
      if (st && st.state === 'open') { rt.open = true; rt.error = null; this.tickStatus(); return; }
      const was = rt.open;
      rt.link = null; rt.open = false;
      rt.error = linkError(st && st.code, rt.target, rt.kind);
      this.tickStatus();
      this.retry(gen, was && st && st.code === 'CLOSED');
    },

    // Reconnect: soon after a link that was working dropped, backing off up to 30 s while it fails.
    retry(gen, wasWorking) {
      const rt = this.rt;
      if (wasWorking) rt.fails = 0; else rt.fails++;
      clearTimeout(rt.timer);
      const wait = wasWorking ? 1000 : Math.min(30000, 2000 * Math.pow(2, Math.min(rt.fails - 1, 4)));
      rt.timer = setTimeout(() => { if (gen === rt.gen && rt.on) this.connect(); }, wait);
    },

    feed(bytes) {
      const rt = this.rt;
      rt.bytes += bytes.length; rt.lastData = Date.now();
      if (rt.parser) rt.parser.push(bytes);
    },

    /* ----- messages -> vehicle state ----- */
    vehicle(sysid) {
      let v = this.vehicles.get(sysid);
      if (!v) {
        v = { sysid, compid: null, type: null, autopilot: null, baseMode: 0, customMode: null, sysStatus: null, seen: 0, hb: 0,
          lat: null, lon: null, alt: null, relAlt: null, posTime: 0, gpiTime: 0, heading: null, yaw: null, hud: null, cog: null, gs: null, airspeed: null, climb: null, battPct: null, volt: null, amp: null, mah: null, battLeft: null, fix: null, sats: null, eph: null, landed: 0, home: null, text: null,
          trail: [], marker: null, line: null, homeMarker: null };
        this.vehicles.set(sysid, v);
      }
      return v;
    },

    handle(m) {
      const d = m.v, now = Date.now(), rt = this.rt;
      rt.systems.add(m.sysid);
      if (m.msgid === 0) {
        const type = u8(d, 4), ap = u8(d, 5);
        if (ap === 8 || type === 6 || type === 18 || type === 26 || type === 27 || type === 30) return; // ground stations, companions, gimbals, cameras...: not a vehicle
        const v = this.vehicle(m.sysid);
        if (v.compid == null) v.compid = m.compid;
        if (m.compid !== v.compid) return;
        v.type = type; v.autopilot = ap; v.baseMode = u8(d, 6); v.customMode = u32(d, 0); v.sysStatus = u8(d, 7);
        v.hb = v.seen = now; this.dirty = true;
        return;
      }
      // the rest from the vehicle's autopilot only (its heartbeat named it; until then, the usual component id 1)
      const known = this.vehicles.get(m.sysid);
      if (known ? (known.compid != null ? m.compid !== known.compid : m.compid !== 1) : m.compid !== 1) return;
      const v = known || this.vehicle(m.sysid);
      v.seen = now; this.dirty = true;
      switch (m.msgid) {
        case 33: { // GLOBAL_POSITION_INT: the autopilot's own estimate, preferred
          const lat = i32(d, 4) / 1e7, lon = i32(d, 8) / 1e7;
          if (!(lat === 0 && lon === 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) { this.moveTo(v, lat, lon, now); v.gpiTime = now; }
          v.alt = i32(d, 12) / 1000; v.relAlt = i32(d, 16) / 1000;
          const hdg = u16(d, 26); if (hdg !== 65535) v.heading = hdg / 100;
          const vx = i16(d, 20) / 100, vy = i16(d, 22) / 100;
          v.gs = Math.hypot(vx, vy); v.climb = -i16(d, 24) / 100;
          break;
        }
        case 24: { // GPS_RAW_INT: the receiver's fix; its position only when the estimate above is not coming
          v.fix = u8(d, 28); v.sats = u8(d, 29); const eph = u16(d, 20); v.eph = eph === 65535 ? null : eph / 100;
          const lat = i32(d, 8) / 1e7, lon = i32(d, 12) / 1e7;
          if (v.fix >= 2 && !(lat === 0 && lon === 0) && now - v.gpiTime > 3000) {
            this.moveTo(v, lat, lon, now); v.alt = i32(d, 16) / 1000;
            const vel = u16(d, 24), cog = u16(d, 26);
            if (vel !== 65535) v.gs = vel / 100;
            v.cog = cog === 65535 ? null : cog / 100;
          }
          if (v.sats === 255) v.sats = null;
          break;
        }
        case 30: v.yaw = fin(deg(f32(d, 12))); break; // ATTITUDE
        case 74: v.airspeed = fin(f32(d, 0)); v.climb = fin(f32(d, 12)); v.hud = i16(d, 16); break; // VFR_HUD
        case 1: { // SYS_STATUS
          const mv = u16(d, 14), ca = i16(d, 16), pct = i8(d, 30);
          v.volt = mv === 65535 ? null : mv / 1000; v.amp = ca === -1 ? null : ca / 100; v.battPct = pct < 0 ? null : pct;
          break;
        }
        case 147: { // BATTERY_STATUS: the main battery's use and time left
          if (u8(d, 32) !== 0) break;
          const mah = i32(d, 0), left = i32(d, 36), pct = i8(d, 35);
          v.mah = mah < 0 ? null : mah; v.battLeft = left > 0 ? left : null;
          if (v.battPct == null && pct >= 0) v.battPct = pct;
          break;
        }
        case 242: { // HOME_POSITION
          const lat = i32(d, 0) / 1e7, lon = i32(d, 4) / 1e7;
          if (!(lat === 0 && lon === 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) v.home = { lat, lon, alt: i32(d, 8) / 1000 };
          break;
        }
        case 245: v.landed = u8(d, 1); break; // EXTENDED_SYS_STATE
        case 253: { // STATUSTEXT
          const bytes = new Uint8Array(d.buffer, 1, 50), end = bytes.indexOf(0);
          const msg = new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end)), id = u16(d, 51);
          if (id && u8(d, 53) > 0 && v.text && v.text.id === id) { v.text.msg = (v.text.msg + msg).trim(); v.text.time = now; } // the next piece of a long message
          else if (msg.trim()) v.text = { msg: msg.trim(), sev: u8(d, 0), id, time: now };
          break;
        }
        default: break;
      }
    },

    moveTo(v, lat, lon, now) {
      v.lat = lat; v.lon = lon; v.posTime = now;
      const last = v.trail[v.trail.length - 1];
      if (!last || MB.map.distance(last, [lat, lon]) >= TRAIL_STEP) {
        v.trail.push([lat, lon]);
        if (v.trail.length > TRAIL_POINTS) v.trail.splice(0, v.trail.length - TRAIL_POINTS);
        v.trailDirty = true;
      }
    },

    // Vehicles not heard from for MAX_AGE removed (a selected one stays until its popup closes).
    expire() {
      const now = Date.now();
      let gone = false;
      this.vehicles.forEach((v, id) => {
        if ((now - v.seen) / 1000 > MAX_AGE && id !== this.selected) { this.drop(v); this.vehicles.delete(id); gone = true; }
      });
      if (gone || this.vehicles.size) this.dirty = true; // the faded state and "seen" times move on
    },

    /* ----- drawing ----- */
    heading(v) { return [v.heading, v.yaw, v.hud, v.cog].find(h => h != null) || 0; },
    armed(v) { return !!(v.baseMode & 128); },
    alt(m) { return MB.state.units === 'metric' ? `${Math.round(m)} m` : `${Math.round(m * 3.28084)} ft`; },
    name(v) { return `${TYPE_NAMES[v.type] || 'Vehicle'} ${v.sysid}`; },
    label(v) {
      const bits = ['#' + v.sysid];
      const mode = modeName(v); if (mode) bits.push(mode);
      if (v.relAlt != null) bits.push(this.alt(v.relAlt));
      return bits.join(' · ');
    },

    render() {
      const now = Date.now();
      this.vehicles.forEach(v => { if (v.lat == null) return; this.draw(v, now); });
      this.updatePopup();
    },

    draw(v, now) {
      const cf = this.conf(), shape = shapeOf(v.type), armed = this.armed(v);
      const color = armed ? COLORS.armed : COLORS.disarmed, dim = (now - v.seen) / 1000 > DIM_AGE;
      const dir = Math.round(this.heading(v)), label = this.label(v), ll = [v.lat, v.lon];
      if (!v.marker || v.shape !== shape) {
        if (v.marker) { MB.map.removeLayer(v.marker); v.marker = null; }
        const size = SIZE[shape];
        v.marker = L.marker(ll, {
          pane: 'mb-uav', pmIgnore: true, keyboard: false, bubblingMouseEvents: true,
          icon: L.divIcon({ className: 'mb-uav mb-uav-' + shape, iconSize: [size, size], iconAnchor: [size / 2, size / 2],
            html: `<div class="mb-uav-rot"><svg viewBox="0 0 32 32" aria-hidden="true">${SHAPES[shape]}</svg></div><span class="mb-uav-label"></span>` })
        });
        v.marker.options.pmIgnore = true;
        v.marker.on('click', ev => {
          const t = MB.tools.current;
          if (t !== 'select' && t !== 'move' && t !== 'present') return; // drawing tools keep the click
          L.DomEvent.stopPropagation(ev);
          this.select(v.sysid);
        });
        v.marker.addTo(MB.map);
        v.shape = shape; v.color = v.label = v.dir = v.dim = v.sel = null;
      } else v.marker.setLatLng(ll);
      // the trail and home, in the vehicle's color
      if (cf.trails && v.trail.length > 1) {
        if (!v.line) { v.line = L.polyline(v.trail, { pane: 'mb-uav-trail', interactive: false, weight: 2.5, opacity: 0.85, color }).addTo(MB.map); v.trailDirty = false; }
        else if (v.trailDirty) { v.line.setLatLngs(v.trail); v.trailDirty = false; }
        if (v.line.options.color !== color) v.line.setStyle({ color });
      } else if (v.line) { MB.map.removeLayer(v.line); v.line = null; }
      if (cf.trails && v.home) {
        if (!v.homeMarker) v.homeMarker = L.marker([v.home.lat, v.home.lon], { pane: 'mb-uav-trail', interactive: false, keyboard: false, pmIgnore: true,
          icon: L.divIcon({ className: 'mb-uav-home', iconSize: [16, 16], iconAnchor: [8, 8], html: 'H' }) }).addTo(MB.map);
        else v.homeMarker.setLatLng([v.home.lat, v.home.lon]);
      } else if (v.homeMarker) { MB.map.removeLayer(v.homeMarker); v.homeMarker = null; }
      const el = v.marker.getElement();
      if (!el) return;
      const rot = el.firstChild;
      if (v.dir !== dir) { rot.style.transform = dir ? `rotate(${dir}deg)` : ''; v.dir = dir; }
      if (v.color !== color) { rot.style.color = color; v.color = color; }
      if (v.label !== label) { el.lastChild.textContent = label; v.label = label; }
      if (v.dim !== dim) { el.classList.toggle('stale', dim); v.dim = dim; }
      const sel = v.sysid === this.selected;
      if (v.sel !== sel) { el.classList.toggle('sel', sel); v.sel = sel; }
    },

    drop(v) {
      ['marker', 'line', 'homeMarker'].forEach(k => { if (v[k]) { MB.map.removeLayer(v[k]); v[k] = null; } });
      v.shape = null;
    },

    applyPaneState() {
      const pane = MB.map.getPane('mb-uav');
      if (pane) pane.classList.toggle('labels', !!this.conf().labels);
    },

    /* ----- selection and popup ----- */
    select(sysid) {
      const v = this.vehicles.get(sysid);
      if (!v || v.lat == null) return;
      this.selected = sysid;
      if (this.popup) { const old = this.popup; this.popup = null; MB.map.closePopup(old); }
      const node = document.createElement('div');
      node.className = 'mb-popup mb-uav-info';
      node.innerHTML = '<div class="mb-popup-title"></div><table class="mb-datatable"></table>';
      const popup = L.popup({ className: 'mb-data-popup', maxWidth: 330, offset: [0, -8], autoPanPadding: [20, 20] }).setLatLng([v.lat, v.lon]).setContent(node);
      popup.on('remove', () => {
        if (this.popup !== popup) return;
        this.popup = null; this.selected = null;
        this.render();
      });
      this.popup = popup;
      this.render(); // draws the selection and fills the popup
      popup.openOn(MB.map);
    },

    updatePopup() {
      const popup = this.popup;
      if (!popup) return;
      const v = this.vehicles.get(this.selected), node = popup.getContent();
      if (!v) return;
      const now = Date.now(), units = MB.state.units;
      const spd = ms => units === 'metric' ? `${ms.toFixed(1)} m/s (${Math.round(ms * 3.6)} km/h)` : (units === 'imperial' ? `${(ms * 2.23694).toFixed(1)} mph` : `${(ms * 1.94384).toFixed(1)} kn`);
      const vs = ms => Math.abs(ms) < 0.1 ? 'level' : `${ms > 0 ? '▲' : '▼'} ${units === 'metric' ? Math.abs(ms).toFixed(1) + ' m/s' : Math.round(Math.abs(ms) * 196.85) + ' ft/min'}`;
      const ago = s => s < 2 ? 'now' : (s < 120 ? s + ' s ago' : Math.round(s / 60) + ' min ago');
      const rows = [];
      const row = (k, val) => { if (val !== '' && val != null) rows.push(`<tr><td>${esc(k)}</td><td>${val}</td></tr>`); };
      const armed = this.armed(v), mode = modeName(v);
      row('Vehicle', esc([TYPE_NAMES[v.type] || 'Not reported yet', AUTOPILOTS[v.autopilot]].filter(Boolean).join(' · ')));
      row('System ID', esc(String(v.sysid)) + (v.compid != null ? ` <span class="dim">· component ${v.compid}</span>` : ''));
      row('Mode', esc(mode));
      row('State', v.hb ? `<i class="swatch" style="background:${armed ? COLORS.armed : COLORS.disarmed}"></i>${armed ? '<b>Armed</b>' : 'Disarmed'}` +
        esc([LANDED[v.landed], SYS_STATUS[v.sysStatus] && v.sysStatus !== 4 && v.sysStatus !== 3 ? SYS_STATUS[v.sysStatus] : ''].filter(Boolean).map(s => ' · ' + s).join('')) : '');
      row('Altitude', v.relAlt != null ? `${this.alt(v.relAlt)} above home` + (v.alt != null ? ` <span class="dim">· ${this.alt(v.alt)} MSL</span>` : '') : (v.alt != null ? this.alt(v.alt) + ' MSL' : ''));
      row('Ground speed', v.gs == null ? '' : spd(v.gs));
      row('Airspeed', v.airspeed == null || !(v.type === 1 || (v.type >= 19 && v.type <= 25)) ? '' : spd(v.airspeed));
      row('Climb', v.climb == null ? '' : vs(v.climb));
      row('Heading', `${Math.round(this.heading(v))}°`);
      const batt = [v.battPct != null ? `<b>${v.battPct}%</b>` : '', v.volt != null ? v.volt.toFixed(1) + ' V' : '', v.amp != null ? v.amp.toFixed(1) + ' A' : '',
        v.mah != null ? v.mah.toLocaleString() + ' mAh used' : '', v.battLeft ? Math.round(v.battLeft / 60) + ' min left' : ''].filter(Boolean);
      row('Battery', batt.length ? (v.battPct != null && v.battPct <= 20 ? '<span class="warn">' + batt.join(' · ') + '</span>' : batt.join(' · ')) : '');
      row('GPS', v.fix == null ? '' : esc([FIX[v.fix] || 'Fix ' + v.fix, v.sats != null ? v.sats + ' satellites' : '', v.eph != null ? 'HDOP ' + v.eph.toFixed(1) : ''].filter(Boolean).join(' · ')));
      row('Position', esc(MB.formatLatLng({ lat: v.lat, lng: v.lon })));
      if (v.home) row('Home', esc(MB.formatDistance(MB.map.distance([v.lat, v.lon], [v.home.lat, v.home.lon]))) + ' away');
      if (v.text && now - v.text.time < 600000) row('Message', `<span class="${v.text.sev <= 4 ? 'warn' : ''}">${esc(v.text.msg)}</span> <span class="dim">· ${esc(SEVERITY[v.text.sev] || '')}, ${ago(Math.round((now - v.text.time) / 1000))}</span>`);
      const seen = Math.max(0, Math.round((now - v.seen) / 1000)), pos = Math.max(0, Math.round((now - v.posTime) / 1000));
      row('Seen', ago(seen) + (pos - seen > 3 ? ` <span class="dim">· position ${ago(pos)}</span>` : '') + ` · MAVLink`);
      node.querySelector('.mb-popup-title').innerHTML = `${esc(this.name(v))}${mode ? ` <span class="dim">· ${esc(mode)}</span>` : ''}${seen > DIM_AGE ? ' <span class="gone dim">· signal lost</span>' : ''}`;
      node.querySelector('.mb-datatable').innerHTML = rows.join('');
      popup.setLatLng([v.lat, v.lon]);
    },

    /* ----- panel (rendered inside the Data tab by MB.data.renderPanel) ----- */
    statusText() {
      const rt = this.rt, cf = this.conf();
      if (!rt.on) return 'Off';
      if (rt.error) return rt.error;
      const t = rt.target;
      if (!rt.open) return cf.kind === 'listen' ? 'Opening the port…' : `Connecting to ${t ? where(t) : 'the server'}…`;
      const v = rt.parser ? rt.parser.valid : 0;
      if (!rt.bytes) return cf.kind === 'listen' ? `Listening on port ${t.port}. Waiting for MAVLink…` : `${cf.kind === 'udp' ? 'Sending to' : 'Connected to'} ${where(t)}. Waiting for MAVLink…`;
      if (!v) return rt.bytes > NOT_MAVLINK ? 'Data is arriving, but it is not MAVLink. Check the port.' : 'Receiving data…';
      let n = 0; this.vehicles.forEach(x => { if (x.lat != null) n++; });
      const age = Math.round((Date.now() - rt.lastData) / 1000);
      const live = age <= 3 ? 'live' : 'no data for ' + age + ' s';
      if (!n) return `Receiving MAVLink (${rt.systems.size} system${rt.systems.size === 1 ? '' : 's'}), no vehicle position yet · ${live}`;
      return `${n} vehicle${n === 1 ? '' : 's'} · ${live}`;
    },

    countText() {
      if (!this.rt.on) return 'off';
      let n = 0; this.vehicles.forEach(v => { if (v.lat != null) n++; });
      return n + ' shown';
    },

    listHtml() {
      const list = [...this.vehicles.values()].filter(v => v.lat != null).sort((a, b) => a.sysid - b.sysid);
      return list.map(v => {
        const mode = modeName(v), armed = this.armed(v);
        const bits = [mode, v.relAlt != null ? this.alt(v.relAlt) : '', v.battPct != null ? v.battPct + '%' : ''].filter(Boolean);
        return `<button type="button" class="mav-veh${v.sysid === this.selected ? ' sel' : ''}" data-sys="${v.sysid}"><svg viewBox="0 0 32 32" aria-hidden="true" style="color:${armed ? COLORS.armed : COLORS.disarmed}">${SHAPES[shapeOf(v.type)]}</svg><span class="nm">${esc(this.name(v))}</span><span class="dim">${esc(bits.join(' · '))}</span></button>`;
      }).join('');
    },

    tickStatus() {
      const el = document.getElementById('mavStatus');
      if (el) {
        const t = this.statusText(), err = !!(this.rt.on && this.rt.error);
        if (el.textContent !== t) el.textContent = t;
        el.classList.toggle('err', err);
      }
      const n = document.getElementById('mavCount');
      if (n) { const t = this.countText(); if (n.textContent !== t) n.textContent = t; }
      const l = document.getElementById('mavList');
      if (l) { const h = this.listHtml(); if (l._html !== h) { l.innerHTML = h; l._html = h; } }
    },

    matches(q, filter) {
      const on = this.rt.on;
      if (filter === 'on' && !on) return false;
      if (filter === 'off' && on) return false;
      if (!q) return true;
      return 'mavlink live drones uav uas vehicles mavp2p ardupilot px4 telemetry websockify'.includes(q);
    },

    panelHtml(q, filter) {
      if (!this.matches(q, filter)) return '';
      const cf = this.conf(), rt = this.rt, k = KINDS[cf.kind], desk = !!window.gengisDesktop;
      return `<details class="ds-source" id="mavSource" data-src="mavlink"${MB.data.sourceOpen('mavlink') ? ' open' : ''}><summary class="ds-source-head"><h3>MAVLink live drones</h3><span class="badge" id="mavCount">${this.countText()}</span></summary>
        <p class="note">Drones and other MAVLink vehicles from a mavp2p server, as their telemetry arrives. GenGIS only reads: it never sends a vehicle a command. Informational only.</p>
        <div class="section"><div class="data-item${rt.on ? ' on' : ''}" id="mavItem">
          <div class="ds-head"><label class="check"><input type="checkbox" data-act="mav-toggle"${rt.on ? ' checked' : ''}> <span class="dname"><a href="https://github.com/bluenviron/mavp2p" target="_blank" rel="noopener">mavp2p</a> / MAVLink server</span></label>${MB.data.infoIcon('Connects to a mavp2p (or mavlink-router) server and shows every vehicle it relays. mavp2p asks ArduPilot vehicles for their telemetry itself (unless started with --streamreq-disable).')}</div>
          <div class="row adsb-row"><label>Connect</label><select class="mav-kind">${KIND_KEYS.map(id => `<option value="${id}"${cf.kind === id ? ' selected' : ''}${KINDS[id].desktop && !desk ? ' disabled' : ''}>${esc(KINDS[id].name)}${KINDS[id].desktop && !desk ? ' (desktop app)' : ''}</option>`).join('')}</select></div>
          <div class="row adsb-row"><label class="mav-field">${esc(k.field || 'Server')}</label><input type="text" class="mav-url" data-keep-focus value="${esc(cf.url)}" placeholder="${esc(k.placeholder)}" inputmode="url" autocapitalize="off" spellcheck="false"></div>
          <div class="note mav-help">${k.help}</div>
          <div class="dstatus${rt.on && rt.error ? ' err' : ''}" id="mavStatus">${esc(this.statusText())}</div>
        </div></div>
        <div class="section"><h3>Vehicles</h3><div class="data-item adsb-display">
          <div id="mavList" class="mav-list"></div>
          <div class="subsets"><label class="sub"><input type="checkbox" id="mavLabels"${cf.labels ? ' checked' : ''}>Labels</label><label class="sub"><input type="checkbox" id="mavTrails"${cf.trails ? ' checked' : ''}>Trails and home</label></div>
          <div class="note">Cyan: disarmed; orange: armed. Faded: no telemetry for ${DIM_AGE} s. Click a vehicle for its details.</div>
        </div></div></details>`;
    },

    bindPanel(panel) {
      const item = panel.querySelector('#mavItem');
      if (!item) return;
      const kind = item.querySelector('.mav-kind'), url = item.querySelector('.mav-url'), cb = item.querySelector('[data-act="mav-toggle"]');
      cb.addEventListener('change', () => {
        this.setConn(kind.value, url.value);
        this.toggle();
        cb.checked = this.rt.on; item.classList.toggle('on', this.rt.on); // enabling is refused without an address
        this.tickStatus();
      });
      kind.addEventListener('change', () => {
        const k = KINDS[kind.value];
        url.placeholder = k.placeholder;
        item.querySelector('.mav-field').textContent = k.field || 'Server';
        item.querySelector('.mav-help').innerHTML = k.help;
        this.setConn(kind.value, url.value);
        this.tickStatus();
      });
      url.addEventListener('change', () => { this.setConn(kind.value, url.value); this.tickStatus(); });
      url.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.setConn(kind.value, url.value, true); cb.checked = this.rt.on; item.classList.toggle('on', this.rt.on); url.blur(); this.tickStatus(); } });
      const list = panel.querySelector('#mavList');
      list.addEventListener('click', e => {
        const b = e.target.closest('[data-sys]');
        if (!b) return;
        const v = this.vehicles.get(+b.dataset.sys);
        if (!v || v.lat == null) return;
        MB.map.setView([v.lat, v.lon], Math.max(MB.map.getZoom(), 16));
        this.select(v.sysid);
      });
      const l = panel.querySelector('#mavLabels'), t = panel.querySelector('#mavTrails');
      l.addEventListener('change', () => { this.conf().labels = l.checked; this.save(); this.applyPaneState(); });
      t.addEventListener('change', () => { this.conf().trails = t.checked; this.save(); this.render(); });
      this.tickStatus();
    }
  };

})(window.MB);
