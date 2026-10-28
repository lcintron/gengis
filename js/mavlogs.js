/* GenGIS - MAVLink flight logs: ArduPilot DataFlash (.bin), MAVLink telemetry logs (.tlog) and PX4 ULog (.ulg)
 * - opened from the MAVLink section of the Data panel (or dropped on the map); several at once, each a track layer
 *   drawn by tracklogs.js, where the time bar plays them together
 * - read in slices, so the page stays responsive on a log of hundreds of MB, with its progress in the panel
 * - a track is the positions with a valid fix (never 0,0), each with the flight mode, altitudes, speeds, battery,
 *   attitude and GPS values logged around it; a log without any position is left out, with a short message
 * - DataFlash and ULog describe their own messages (FMT, F); a .tlog is read with mavlink.js's decoder, and a ground
 *   station in it has no track
 * Nothing is stored: a log lives in memory for the session, and nothing is ever sent anywhere.
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = MB.escapeHtml;
  const SLICE_MS = 14;        // work per slice before the page gets a turn
  const MIN_STEP = 100;       // ms between two track points (faster logs are thinned to this)
  const GPS_EPOCH = 315964800000, LEAP_MS = 18000; // 1980-01-06 in UTC ms; GPS time is ahead of UTC by 18 s (since 2017)
  const FILES = /\.(bin|tlog|ulg)$/i;

  class Cancelled extends Error { constructor() { super('Cancelled'); this.cancelled = true; } }
  const later = () => new Promise(r => setTimeout(r, 0));
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // Calls work in slices: job.tick(position) between steps yields to the page now and then and reports the share done.
  function slicer(total, onProgress, isCancelled) {
    let t0 = now();
    return async pos => {
      if (now() - t0 < SLICE_MS) return;
      if (onProgress) onProgress(Math.min(1, pos / total));
      await later();
      if (isCancelled && isCancelled()) throw new Cancelled();
      t0 = now();
    };
  }
  const validLL = (lat, lon) => isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  const fin = x => (typeof x === 'number' && isFinite(x) ? x : undefined);
  const r1 = x => (x == null || !isFinite(x) ? undefined : Math.round(x * 10) / 10);

  /* ---------- ArduPilot DataFlash (.bin) ---------- */
  // Each message: 0xA3 0x95, its type, then its fields as its FMT message describes them.
  const DF_SIZE = { a: 64, b: 1, B: 1, h: 2, H: 2, i: 4, I: 4, f: 4, d: 8, n: 4, N: 16, Z: 64, c: 2, C: 2, e: 4, E: 4, L: 4, M: 1, q: 8, Q: 8, g: 2 };
  const text = (u8, o, n) => { let e = o; while (e < o + n && u8[e]) e++; let s = ''; for (let i = o; i < e; i++) s += String.fromCharCode(u8[i]); return s; };
  function half(h) { const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023; return e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15); }
  function dfRead(dv, u8, o, ch) {
    switch (ch) {
      case 'b': return dv.getInt8(o);
      case 'B': case 'M': return dv.getUint8(o);
      case 'h': return dv.getInt16(o, true);
      case 'H': return dv.getUint16(o, true);
      case 'i': return dv.getInt32(o, true);
      case 'I': return dv.getUint32(o, true);
      case 'f': return dv.getFloat32(o, true);
      case 'd': return dv.getFloat64(o, true);
      case 'c': return dv.getInt16(o, true) / 100;
      case 'C': return dv.getUint16(o, true) / 100;
      case 'e': return dv.getInt32(o, true) / 100;
      case 'E': return dv.getUint32(o, true) / 100;
      case 'L': return dv.getInt32(o, true) / 1e7;
      case 'q': return Number(dv.getBigInt64(o, true));
      case 'Q': return Number(dv.getBigUint64(o, true));
      case 'g': return half(dv.getUint16(o, true));
      case 'n': return text(u8, o, 4);
      case 'N': return text(u8, o, 16);
      case 'Z': return text(u8, o, 64);
      default: return null;
    }
  }
  // The messages a track needs, and the columns read from each.
  const DF_WANT = {
    GPS: ['TimeUS', 'TimeMS', 'I', 'Instance', 'Status', 'GMS', 'GWk', 'Week', 'NSats', 'HDop', 'Lat', 'Lng', 'Alt', 'Spd', 'GCrs', 'VZ', 'Yaw'],
    POS: ['TimeUS', 'RelHomeAlt'], MODE: ['TimeUS', 'Mode', 'ModeNum'], ATT: ['TimeUS', 'Roll', 'Pitch', 'Yaw'],
    BAT: ['TimeUS', 'Instance', 'Inst', 'Volt', 'Curr', 'CurrTot', 'RemPct'], CURR: ['TimeUS', 'Volt', 'Curr', 'CurrTot'],
    ARSP: ['TimeUS', 'I', 'Airspeed'], MSG: ['Message'], VER: ['BU'], RSSI: ['RXRSSI']
  };
  // ArduPilot's firmware (VER's build type, or the version text at the start) as a MAV_TYPE, for its mode names.
  const BUILD_TYPE = { 1: 10, 2: 2, 3: 1, 7: 12, 13: 4 };
  function firmwareType(msg) {
    if (/copter|heli/i.test(msg)) return /heli/i.test(msg) ? 4 : 2;
    if (/plane/i.test(msg)) return 1;
    if (/rover/i.test(msg)) return 10;
    if (/sub\b|ardusub/i.test(msg)) return 12;
    return null;
  }
  const VEHICLE_NAME = { 1: 'Plane', 2: 'Copter', 4: 'Helicopter', 10: 'Rover', 12: 'Sub' };

  async function parseBin(buf, opts) {
    opts = opts || {};
    const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), n = u8.length;
    const fmts = { 128: { name: 'FMT', len: 89, cols: null } };
    const tick = slicer(n, opts.onProgress, opts.isCancelled);
    let vtype = null, utcOff = null, mode = null, modeNum = null, relAlt = null, relTime = -1e12, att = null, bat = null, arsp = null, rssi = null;
    const raw = []; // the track's points, at boot time (ms), modes still as numbers
    let lastT = -1e12, steps = 0, i = 0;
    while (i + 3 <= n) {
      if (++steps === 2048) { steps = 0; await tick(i); }
      if (u8[i] !== 0xA3 || u8[i + 1] !== 0x95) { i++; continue; }
      const type = u8[i + 2], f = fmts[type];
      if (!f || i + f.len > n) { i++; continue; }
      const o = i + 3;
      if (type === 128) { // FMT: a message type described
        const t = u8[o], len = u8[o + 1], name = text(u8, o + 2, 4), format = text(u8, o + 6, 16), cols = text(u8, o + 22, 64).split(',');
        if (t !== 128 && len >= 3) {
          const def = { name, len, read: null };
          const want = DF_WANT[name];
          if (want) {
            def.read = [];
            let off = 0;
            for (let k = 0; k < format.length; k++) {
              const ch = format[k], sz = DF_SIZE[ch];
              if (sz == null) { def.read = null; break; }
              if (want.includes(cols[k])) def.read.push([cols[k], off, ch]);
              off += sz;
            }
            if (def.read && off + 3 > len) def.read = null; // a format longer than its message: not read
          }
          fmts[t] = def;
        }
        i += f.len; continue;
      }
      if (f.read) {
        const m = {};
        for (const [col, off, ch] of f.read) m[col] = dfRead(dv, u8, o + off, ch);
        const bt = m.TimeUS != null ? m.TimeUS / 1000 : m.TimeMS; // ms since boot
        switch (f.name) {
          case 'GPS': {
            const inst = m.I != null ? m.I : (m.Instance != null ? m.Instance : 0);
            if (inst !== 0) break;
            let lat = m.Lat, lon = m.Lng;
            if (Math.abs(lat) > 1000 || Math.abs(lon) > 1000) { lat /= 1e7; lon /= 1e7; } // (very old logs: raw degrees * 1e7)
            if (!(m.Status >= 3) || !validLL(lat, lon) || bt == null) break; // a 3D fix only
            const wk = m.GWk != null ? m.GWk : m.Week, ms = m.GMS;
            if (utcOff == null && wk > 0 && ms != null) utcOff = GPS_EPOCH + wk * 604800000 + ms - LEAP_MS - bt;
            if (Math.abs(bt - lastT) < MIN_STEP) break;
            lastT = bt;
            const rel = bt - relTime < 2000 ? relAlt : null;
            raw.push({ t: bt, lat, lon, alt: rel != null ? rel : m.Alt, altRef: rel != null ? 'rel' : 'msl', amsl: fin(m.Alt), speed: fin(m.Spd),
              climb: m.VZ != null ? r1(-m.VZ) : undefined, heading: fin(m.GCrs), sats: fin(m.NSats), hdop: fin(m.HDop), modeNum: modeNum, modeText: mode,
              roll: att ? att.roll : undefined, pitch: att ? att.pitch : undefined, volt: bat ? bat.volt : undefined, curr: bat ? bat.curr : undefined,
              mah: bat ? bat.mah : undefined, batt: bat ? bat.pct : undefined, airspeed: arsp != null ? arsp : undefined, rssi: rssi != null ? rssi : undefined });
            break;
          }
          case 'POS': if (m.RelHomeAlt != null && isFinite(m.RelHomeAlt)) { relAlt = m.RelHomeAlt; relTime = bt; } break;
          case 'MODE': modeNum = m.ModeNum != null ? m.ModeNum : m.Mode; mode = null; break;
          case 'ATT': att = { roll: r1(m.Roll), pitch: r1(m.Pitch) }; break;
          case 'BAT': case 'CURR': {
            const inst = m.Instance != null ? m.Instance : (m.Inst != null ? m.Inst : 0);
            if (inst !== 0) break;
            bat = { volt: fin(m.Volt), curr: fin(m.Curr), mah: m.CurrTot != null ? Math.round(m.CurrTot) : undefined, pct: m.RemPct != null && m.RemPct <= 100 ? m.RemPct : undefined };
            break;
          }
          case 'ARSP': if (!m.I) arsp = fin(m.Airspeed); break;
          case 'RSSI': if (m.RXRSSI != null) rssi = Math.round(m.RXRSSI * (m.RXRSSI <= 1 ? 100 : 1)); break;
          case 'VER': if (BUILD_TYPE[m.BU]) vtype = BUILD_TYPE[m.BU]; break;
          case 'MSG': if (vtype == null) vtype = firmwareType(m.Message || ''); break;
          default: break;
        }
      }
      i += f.len;
    }
    if (opts.onProgress) opts.onProgress(1);
    const name = (n) => (vtype != null && MB.mavlink ? MB.mavlink.modeName({ customMode: n, baseMode: 1, autopilot: 3, type: vtype }) : 'Mode ' + n);
    const t0 = raw.length ? raw[0].t : 0;
    const points = raw.map(p => {
      const q = Object.assign({}, p);
      q.mode = p.modeNum != null ? name(p.modeNum) : null;
      delete q.modeNum; delete q.modeText;
      q.t = utcOff != null ? p.t + utcOff : p.t - t0;
      Object.keys(q).forEach(k => { if (q[k] === undefined) delete q[k]; });
      return q;
    });
    return { timeBase: utcOff != null ? 'utc' : 'relative', vehicles: points.length ? [{ key: '1', label: VEHICLE_NAME[vtype] || 'Vehicle', points }] : [] };
  }

  /* ---------- MAVLink telemetry log (.tlog) ---------- */
  // Each record: the time it was received (8 bytes, big-endian, microseconds since 1970), then a MAVLink frame.
  async function parseTlog(buf, opts) {
    opts = opts || {};
    const M = MB.mavlink, u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), n = u8.length;
    const tick = slicer(n, opts.onProgress, opts.isCancelled);
    const systems = new Map(); // sysid -> { st, compid, points, lastT }
    const handle = (m, t) => {
      let s = systems.get(m.sysid);
      if (!s) { s = { st: M.newState(m.sysid), compid: null, points: [], lastT: -1e12 }; systems.set(m.sysid, s); }
      const st = s.st;
      if (m.msgid === 0) {
        if (!M.heartbeatKind(m)) return;
        if (s.compid == null) s.compid = m.compid;
        if (m.compid === s.compid) M.applyHeartbeat(st, m, t);
        return;
      }
      if (s.compid != null ? m.compid !== s.compid : m.compid !== 1) return;
      const pos = M.apply(st, m, t);
      if (!pos || st.gcs) return; // a ground station: no track
      if (m.msgid === 24 && !(st.fix >= 3)) return;
      if (Math.abs(t - s.lastT) < MIN_STEP) return; // (a clock set back: its points kept)
      s.lastT = t;
      const rel = st.relAlt != null && m.msgid === 33;
      const winged = st.type === 1 || (st.type >= 19 && st.type <= 25);
      const p = { t, lat: pos.lat, lon: pos.lon, alt: rel ? st.relAlt : st.alt, altRef: rel ? 'rel' : 'msl', amsl: fin(st.alt), speed: fin(st.gs), climb: fin(st.climb),
        heading: r1(M.heading(st)), mode: M.modeName(st) || null, volt: fin(st.volt), curr: fin(st.amp), batt: fin(st.battPct), mah: fin(st.mah),
        sats: fin(st.sats), hdop: fin(st.eph), throttle: fin(st.thr), rssi: fin(st.rssi), roll: r1(st.roll), pitch: r1(st.pitch), airspeed: winged ? fin(st.airspeed) : undefined };
      Object.keys(p).forEach(k => { if (p[k] === undefined) delete p[k]; });
      s.points.push(p);
    };
    let i = 0, steps = 0;
    while (i + 8 < n) {
      if (++steps === 4096) { steps = 0; await tick(i); }
      const stx = u8[i + 8];
      if (stx === 0xFD || stx === 0xFE) {
        const us = dv.getUint32(i) * 4294967296 + dv.getUint32(i + 4);
        if (us > 946684800e6 && us < 4102444800e6) { // between 2000 and 2100: a record's time
          const f = M.frameAt(u8, i + 8);
          if (f && f.need) break;
          if (f) {
            if (f.msg) { try { handle(f.msg, us / 1000); } catch (e) { /* one bad message */ } }
            i += 8 + f.total; continue;
          }
        }
      }
      i++;
    }
    if (opts.onProgress) opts.onProgress(1);
    const vehicles = [];
    systems.forEach((s, id) => { if (s.points.length && !s.st.gcs) vehicles.push({ key: String(id), label: M.name(s.st), points: s.points }); });
    vehicles.sort((a, b) => +a.key - +b.key);
    return { timeBase: 'utc', vehicles };
  }

  /* ---------- PX4 ULog (.ulg) ---------- */
  // A 16-byte header, then messages: size (2 bytes), type (a letter), then size bytes. 'F' describes a topic's fields,
  // 'A' subscribes a topic under a message id, 'D' is one sample of it.
  const UL_SIZE = { int8_t: 1, uint8_t: 1, bool: 1, char: 1, int16_t: 2, uint16_t: 2, int32_t: 4, uint32_t: 4, float: 4, int64_t: 8, uint64_t: 8, double: 8 };
  const UL_SYNC = [0x2F, 0x73, 0x13, 0x20, 0x25, 0x0C, 0xBB, 0x12];
  const NAV_STATE = { 0: 'Manual', 1: 'Altitude', 2: 'Position', 3: 'Mission', 4: 'Hold', 5: 'Return', 6: 'Position slow', 10: 'Acro', 12: 'Descend',
    13: 'Termination', 14: 'Offboard', 15: 'Stabilized', 16: 'Rattitude', 17: 'Takeoff', 18: 'Land', 19: 'Follow me', 20: 'Precision land', 21: 'Orbit', 22: 'VTOL takeoff' };
  const PX4_VEHICLE = { 1: 'Multicopter', 2: 'Fixed wing', 3: 'Rover', 4: 'Airship' };
  const UL_WANT = {
    vehicle_global_position: ['timestamp', 'lat', 'lon', 'alt', 'lat_lon_valid', 'alt_valid', 'vel_n', 'vel_e', 'vel_d'],
    vehicle_gps_position: ['timestamp', 'lat', 'lon', 'alt', 'latitude_deg', 'longitude_deg', 'altitude_msl_m', 'fix_type', 'vel_m_s', 'vel_d_m_s', 'cog_rad', 'satellites_used', 'hdop', 'time_utc_usec'],
    vehicle_local_position: ['timestamp', 'z', 'vx', 'vy', 'vz', 'z_valid', 'v_xy_valid', 'heading'],
    vehicle_status: ['timestamp', 'nav_state', 'vehicle_type'],
    battery_status: ['timestamp', 'voltage_v', 'voltage_filtered_v', 'current_a', 'remaining', 'discharged_mah'],
    vehicle_attitude: ['timestamp', 'q']
  };
  UL_WANT.sensor_gps = UL_WANT.vehicle_gps_position;
  function ulRead(dv, o, type) {
    switch (type) {
      case 'int8_t': return dv.getInt8(o);
      case 'uint8_t': case 'bool': case 'char': return dv.getUint8(o);
      case 'int16_t': return dv.getInt16(o, true);
      case 'uint16_t': return dv.getUint16(o, true);
      case 'int32_t': return dv.getInt32(o, true);
      case 'uint32_t': return dv.getUint32(o, true);
      case 'float': return dv.getFloat32(o, true);
      case 'double': return dv.getFloat64(o, true);
      case 'int64_t': return Number(dv.getBigInt64(o, true));
      case 'uint64_t': return Number(dv.getBigUint64(o, true));
      default: return null;
    }
  }

  async function parseUlog(buf, opts) {
    opts = opts || {};
    const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), n = u8.length;
    if (n < 16 || text(u8, 0, 4) !== 'ULog') throw new Error('Not a ULog file');
    const tick = slicer(n, opts.onProgress, opts.isCancelled);
    const formats = {};  // name -> [{ type, name, count }]
    const sizes = {};
    const subs = {};     // msg id -> { topic, multi, read: [[name, off, type, count]] }
    const sizeOf = name => {
      if (sizes[name] != null) return sizes[name];
      const f = formats[name];
      if (!f) return null;
      sizes[name] = -1; // (a format that holds itself: not read)
      let s = 0;
      for (const x of f) { const z = UL_SIZE[x.type] != null ? UL_SIZE[x.type] : sizeOf(x.type); if (z == null || z < 0) return (sizes[name] = null); s += z * x.count; }
      return (sizes[name] = s);
    };
    const compile = topic => {
      const f = formats[topic], want = UL_WANT[topic];
      if (!f || !want) return null;
      const read = [];
      let off = 0;
      for (const x of f) {
        const z = UL_SIZE[x.type] != null ? UL_SIZE[x.type] : sizeOf(x.type);
        if (z == null || z < 0) return null;
        if (want.includes(x.name) && UL_SIZE[x.type] != null) read.push([x.name, off, x.type, x.count]);
        off += z * x.count;
      }
      return read;
    };
    let utcOff = null, mode = null, vtype = null, local = null, bat = null, att = null;
    const gpos = [], gps = [];
    let lastG = -1e12, lastS = -1e12, i = 16, steps = 0;
    while (i + 3 <= n) {
      if (++steps === 2048) { steps = 0; await tick(i); }
      const size = dv.getUint16(i, true), type = u8[i + 2], o = i + 3;
      if (o + size > n) break;
      const c = String.fromCharCode(type);
      if (!'FAIDLCPQMBROS'.includes(c) || (!size && c !== 'S')) { // not a message: look for the next sync marker
        let j = i + 1, found = -1;
        for (; j + 8 <= n; j++) { let k = 0; while (k < 8 && u8[j + k] === UL_SYNC[k]) k++; if (k === 8) { found = j + 8; break; } }
        if (found < 0) break;
        i = found; continue;
      }
      if (c === 'F') {
        const s = text(u8, o, size), colon = s.indexOf(':');
        if (colon > 0) {
          formats[s.slice(0, colon)] = s.slice(colon + 1).split(';').filter(Boolean).map(d => {
            const m = d.trim().match(/^(\w+)(?:\[(\d+)\])?\s+(\w+)$/);
            return m ? { type: m[1], count: m[2] ? +m[2] : 1, name: m[3] } : { type: '?', count: 1, name: '' };
          });
        }
      } else if (c === 'A') {
        const multi = u8[o], id = dv.getUint16(o + 1, true), topic = text(u8, o + 3, size - 3);
        const read = compile(topic);
        if (read) subs[id] = { topic, multi, read };
      } else if (c === 'D') {
        const sub = subs[dv.getUint16(o, true)];
        if (sub) {
          const d = {}, base = o + 2, end = o + size;
          for (const [name, off, type, count] of sub.read) {
            const sz = UL_SIZE[type];
            if (base + off + sz * count > end) continue; // (trailing padding is not logged)
            if (count === 1) d[name] = ulRead(dv, base + off, type);
            else { const a = []; for (let k = 0; k < count; k++) a.push(ulRead(dv, base + off + k * sz, type)); d[name] = a; }
          }
          const t = d.timestamp / 1000; // ms since boot
          switch (sub.topic) {
            case 'vehicle_status': if (d.nav_state != null) mode = NAV_STATE[d.nav_state] || 'Mode ' + d.nav_state; if (PX4_VEHICLE[d.vehicle_type]) vtype = d.vehicle_type; break;
            case 'vehicle_local_position': local = { t, rel: d.z_valid === 0 ? null : -d.z, gs: d.v_xy_valid === 0 ? null : Math.hypot(d.vx, d.vy), climb: d.vz != null ? -d.vz : null, hdg: d.heading }; break;
            case 'battery_status':
              if (sub.multi === 0) bat = { volt: fin(d.voltage_v) || fin(d.voltage_filtered_v), curr: d.current_a >= 0 ? fin(d.current_a) : undefined, batt: d.remaining >= 0 ? Math.round(d.remaining * 100) : undefined, mah: d.discharged_mah >= 0 ? Math.round(d.discharged_mah) : undefined };
              break;
            case 'vehicle_attitude': {
              const q = d.q;
              if (q && q.length === 4) {
                const [w, x, y, z] = q;
                att = { roll: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * 180 / Math.PI, pitch: Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))) * 180 / Math.PI };
              }
              break;
            }
            case 'vehicle_gps_position': case 'sensor_gps': {
              if (sub.multi !== 0) break;
              const lat = d.latitude_deg != null ? d.latitude_deg : d.lat / 1e7, lon = d.longitude_deg != null ? d.longitude_deg : d.lon / 1e7;
              const alt = d.altitude_msl_m != null ? d.altitude_msl_m : d.alt / 1000;
              if (!(d.fix_type >= 3) || !validLL(lat, lon)) break;
              if (utcOff == null && d.time_utc_usec > 1e15) utcOff = d.time_utc_usec / 1000 - t;
              if (Math.abs(t - lastS) < MIN_STEP) break;
              lastS = t;
              gps.push(Object.assign(extras(t), { t, lat, lon, alt, altRef: 'msl', speed: fin(d.vel_m_s), climb: d.vel_d_m_s != null ? -d.vel_d_m_s : undefined,
                heading: d.cog_rad != null && isFinite(d.cog_rad) ? ((d.cog_rad * 180 / Math.PI) % 360 + 360) % 360 : undefined, sats: fin(d.satellites_used), hdop: fin(d.hdop) }));
              break;
            }
            case 'vehicle_global_position': {
              const lat = d.lat > 1000 || d.lat < -1000 ? d.lat / 1e7 : d.lat, lon = d.lon > 1000 || d.lon < -1000 ? d.lon / 1e7 : d.lon;
              if (d.lat_lon_valid === 0 || !validLL(lat, lon)) break;
              if (Math.abs(t - lastG) < MIN_STEP) break;
              lastG = t;
              const p = Object.assign(extras(t), { t, lat, lon, alt: d.alt, altRef: 'msl' });
              if (d.vel_n != null && p.speed == null) p.speed = Math.hypot(d.vel_n, d.vel_e);
              if (d.vel_d != null && p.climb == null) p.climb = -d.vel_d;
              gpos.push(p);
              break;
            }
            default: break;
          }
        }
      }
      i = o + size;
    }
    // the values logged around a point (the latest of each)
    function extras(t) {
      const p = { mode };
      if (local && t - local.t < 1000) {
        if (local.rel != null && isFinite(local.rel)) p.rel = local.rel;
        if (local.gs != null && isFinite(local.gs)) p.speed = local.gs;
        if (local.climb != null && isFinite(local.climb)) p.climb = local.climb;
      }
      if (bat) Object.assign(p, bat);
      if (att) { p.roll = r1(att.roll); p.pitch = r1(att.pitch); }
      return p;
    }
    if (opts.onProgress) opts.onProgress(1);
    const src = gpos.length ? gpos : gps;
    const t0 = src.length ? src[0].t : 0;
    const points = src.map(p => {
      const q = Object.assign({}, p);
      if (q.rel != null) { q.amsl = q.alt; q.alt = q.rel; q.altRef = 'rel'; }
      delete q.rel;
      q.t = utcOff != null ? p.t + utcOff : p.t - t0;
      Object.keys(q).forEach(k => { if (q[k] === undefined) delete q[k]; });
      return q;
    });
    return { timeBase: utcOff != null ? 'utc' : 'relative', vehicles: points.length ? [{ key: '1', label: PX4_VEHICLE[vtype] || 'PX4 vehicle', points }] : [] };
  }

  // Which reader a file needs: by its first bytes, else by its name.
  function kindOf(name, u8) {
    if (u8.length >= 7 && u8[0] === 0x55 && u8[1] === 0x4C && u8[2] === 0x6F && u8[3] === 0x67 && u8[4] === 0x01 && u8[5] === 0x12 && u8[6] === 0x35) return 'ulg';
    if (u8.length >= 3 && u8[0] === 0xA3 && u8[1] === 0x95 && u8[2] === 0x80) return 'bin';
    if (u8.length >= 9 && (u8[8] === 0xFD || u8[8] === 0xFE)) return 'tlog';
    const ext = (String(name).match(/\.(\w+)$/) || [])[1];
    return ext ? ext.toLowerCase() : '';
  }
  const KIND_NAME = { bin: 'ArduPilot DataFlash log', tlog: 'MAVLink telemetry log', ulg: 'PX4 log' };

  // A log's bytes read: { kind, log } (log as tracklogs.js takes it; vehicles empty when it has no position).
  async function parse(name, buf, opts) {
    const u8 = new Uint8Array(buf), kind = kindOf(name, u8);
    const reader = { bin: parseBin, tlog: parseTlog, ulg: parseUlog }[kind];
    if (!reader) throw new Error('not a .bin, .tlog or .ulg flight log');
    const r = await reader(buf, opts);
    return { kind, log: Object.assign({ source: 'mavlink', name: String(name).replace(/\.(bin|tlog|ulg)$/i, '') }, r) };
  }

  /* ---------- the panel ---------- */
  MB.mavLogs = {
    parse, parseBin, parseTlog, parseUlog, kindOf, Cancelled,
    queue: [], job: null, notes: [],

    isLogFile: f => FILES.test((f && f.name) || ''),

    pick() {
      let input = this._input;
      if (!input) {
        input = this._input = document.createElement('input');
        input.type = 'file'; input.hidden = true; input.multiple = true;
        input.accept = '.bin,.tlog,.ulg,.BIN,.TLOG,.ULG';
        input.addEventListener('change', () => { const f = Array.from(input.files || []); input.value = ''; if (f.length) this.openFiles(f); });
        document.body.appendChild(input);
      }
      input.click();
    },

    // Files read one after another; each with a position becomes a track (the first one opened is zoomed to).
    openFiles(files) {
      Array.from(files || []).forEach(f => this.queue.push(f));
      if (!this.job) this.next();
    },

    async next() {
      const file = this.queue.shift();
      if (!file) { this.job = null; this.tick(); return; }
      const job = this.job = { name: file.name, frac: 0, cancelled: false };
      this.tick();
      try {
        const buf = await file.arrayBuffer();
        const r = await parse(file.name, buf, { onProgress: f => { job.frac = f; this.tick(); }, isCancelled: () => job.cancelled });
        const id = MB.trackLogs.add(r.log);
        if (!id) this.note(`${file.name}: no position in this log, so no track.`, true);
        else {
          const l = MB.trackLogs.list().find(x => x.id === id), pts = l.vehicles.reduce((s, v) => s + v.count, 0);
          this.note(`${file.name}: ${KIND_NAME[r.kind]}, ${pts.toLocaleString()} points${l.vehicles.length > 1 ? ', ' + l.vehicles.length + ' vehicles' : ''}.`);
          if (!this.queue.length || MB.trackLogs.list('mavlink').length === 1) MB.trackLogs.zoomTo(id);
        }
      } catch (e) {
        if (e && e.cancelled) this.note(`${file.name}: not opened (cancelled).`);
        else this.note(`${file.name}: could not be read (${(e && e.message) || e}).`, true);
      }
      this.job = null;
      this.next();
    },

    cancel() { if (this.job) this.job.cancelled = true; this.queue = []; },

    note(text, warn) {
      this.notes.push({ text, warn: !!warn });
      this.notes = this.notes.slice(-3);
      if (warn && MB.toast) MB.toast(text, 4000);
      this.tick();
    },

    panelHtml() {
      const job = this.job;
      return `<div class="section"><h3>Flight logs</h3><div class="data-item adsb-display" id="mavLogItem">
          <div class="ds-head"><button type="button" class="btn small with-icon" data-act="mav-open-log">${MB.ICON.open.replace('<svg ', '<svg class="mi" ')}Open logs</button><span class="dim trk-kinds">.bin · .tlog · .ulg</span>${MB.data.infoIcon('ArduPilot DataFlash logs (.bin), telemetry logs (.tlog) from Mission Planner, QGroundControl or MAVProxy, and PX4 logs (.ulg). Each is a track; several overlay, and the time bar plays them together. Read on this device only; points without a GPS fix are left out.')}</div>
          <div class="trk-progress" id="mavLogProgress"${job ? '' : ' hidden'}><div class="progress"><div class="bar" style="width:${job ? Math.round(job.frac * 100) : 0}%"></div></div><div class="trk-job"><span class="note" id="mavLogJob">${job ? esc(job.name) : ''}</span>${MB.iconBtn('close', 'Cancel', 'data-act="mav-log-cancel"', '', 'Cancel reading the log')}</div></div>
          <div id="mavLogNotes">${this.notesHtml()}</div>
          <div id="mavLogList" class="trk-list">${MB.trackLogs ? MB.trackLogs.listHtml('mavlink') : ''}</div>
        </div></div>`;
    },
    notesHtml() { return this.notes.map(n => `<div class="dstatus${n.warn ? ' err' : ''}">${esc(n.text)}</div>`).join(''); },

    bindPanel(panel) {
      const item = panel.querySelector('#mavLogItem');
      if (!item) return;
      item.querySelector('[data-act="mav-open-log"]').addEventListener('click', () => this.pick());
      item.querySelector('[data-act="mav-log-cancel"]').addEventListener('click', () => this.cancel());
      item.addEventListener('dragover', e => { e.preventDefault(); item.classList.add('over'); });
      item.addEventListener('dragleave', () => item.classList.remove('over'));
      item.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); item.classList.remove('over'); this.openFiles(Array.from(e.dataTransfer.files || []).filter(this.isLogFile)); });
      if (MB.trackLogs) MB.trackLogs.renderList(panel.querySelector('#mavLogList'), { source: 'mavlink' });
      this.tick();
    },

    // The progress and the notes, in place (the panel is not rebuilt for them).
    tick() {
      if (typeof document === 'undefined') return;
      const job = this.job, p = document.getElementById('mavLogProgress');
      if (p) {
        p.hidden = !job;
        const bar = p.querySelector('.bar'), w = (job ? Math.round(job.frac * 100) : 0) + '%';
        if (bar.style.width !== w) bar.style.width = w;
        const nm = document.getElementById('mavLogJob'), t = job ? job.name : '';
        if (nm.textContent !== t) nm.textContent = t;
      }
      const notes = document.getElementById('mavLogNotes');
      if (notes) { const h = this.notesHtml(); if (notes._h !== h) { notes.innerHTML = h; notes._h = h; } }
    }
  };

})(window.MB);
