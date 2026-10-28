'use strict';
// MAVLink: the live view (js/mavlink.js: ground stations, systems without a position, pins) and the flight logs
// (js/mavlogs.js: DataFlash .bin, .tlog and ULog .ulg built here byte by byte) drawn by the shared track module
// (js/tracklogs.js: cleaning, time alignment). Browser modules in a sandbox, with a small stand-in for Leaflet.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..');
// (values from the sandbox are compared as plain data: their arrays are another realm's)
const same = (a, b, msg) => assert.deepEqual(a === undefined ? a : JSON.parse(JSON.stringify(a)), b, msg);

function haversine(a, b) {
  const la1 = (a.lat != null ? a.lat : a[0]), lo1 = (a.lng != null ? a.lng : a[1]), la2 = (b.lat != null ? b.lat : b[0]), lo2 = (b.lng != null ? b.lng : b[1]);
  const R = 6371008.8, r = Math.PI / 180, dLat = (la2 - la1) * r, dLon = (lo2 - lo1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// A map and Leaflet that only record what is added (no DOM).
function fakeLeaflet() {
  const layer = (type, opts, extra) => Object.assign({
    type, options: Object.assign({}, opts), events: {},
    on(ev, fn) { this.events[ev] = fn; return this; }, addTo(m) { m.layers.add(this); return this; },
    setLatLng(ll) { this.ll = ll; return this; }, setLatLngs(lls) { this.lls = lls; return this; }, setStyle(s) { Object.assign(this.options, s); return this; },
    getElement() { return null; }
  }, extra);
  const map = {
    layers: new Set(), removeLayer(l) { this.layers.delete(l); }, distance: haversine,
    createPane() { return { style: {}, classList: { toggle() {} } }; }, getPane() { return { classList: { toggle() {} } }; }, closePopup() {}
  };
  const L = {
    marker: (ll, o) => layer('marker', o, { ll }), divIcon: o => o, polyline: (lls, o) => layer('polyline', o, { lls }),
    popup: () => layer('popup', {}, { setContent() { return this; }, openOn() { return this; } }), DomEvent: { stopPropagation() {} }
  };
  return { L, map };
}

function load(files, opts) {
  opts = opts || {};
  const MB = {
    settings: {}, state: { units: 'metric' }, tools: { current: 'select' }, saveSettings() { this.saved = (this.saved || 0) + 1; },
    escapeHtml: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    formatLatLng: ll => ll.lat.toFixed(5) + ', ' + ll.lng.toFixed(5), formatDistance: m => Math.round(m) + ' m',
    on() {}, emit() {}
  };
  const ctx = { MB, console, setTimeout, clearTimeout, setInterval: () => 0, TextDecoder, performance, Date, Math };
  ctx.window = ctx;
  if (opts.map) { const f = fakeLeaflet(); ctx.L = f.L; MB.map = f.map; }
  vm.createContext(ctx);
  files.forEach(f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }));
  return MB;
}

/* ---------------------------------------------------------------- MAVLink frames */
const MSG = { HEARTBEAT: 0, SYS_STATUS: 1, GPS_RAW_INT: 24, GLOBAL_POSITION_INT: 33, VFR_HUD: 74, FOLLOW_TARGET: 144 };
function frame(M, sysid, compid, msgid, fill) {
  const [extra, len] = M.msgs[msgid];
  const payload = Buffer.alloc(len), d = new DataView(payload.buffer, payload.byteOffset, len);
  fill(d);
  const buf = Buffer.alloc(10 + len + 2);
  buf[0] = 0xFD; buf[1] = len; buf[5] = sysid; buf[6] = compid; buf[7] = msgid & 255; buf[8] = (msgid >> 8) & 255; buf[9] = msgid >> 16;
  payload.copy(buf, 10);
  const crc = M.crc16(buf, 1, 10 + len, extra);
  buf[10 + len] = crc & 255; buf[11 + len] = crc >> 8;
  return buf;
}
const heartbeat = (M, sys, comp, o) => frame(M, sys, comp, MSG.HEARTBEAT, d => {
  d.setUint32(0, o.mode || 0, true); d.setUint8(4, o.type); d.setUint8(5, o.autopilot); d.setUint8(6, o.baseMode || 0); d.setUint8(7, 4); d.setUint8(8, 3);
});
const gpi = (M, sys, comp, lat, lon, relAlt, alt) => frame(M, sys, comp, MSG.GLOBAL_POSITION_INT, d => {
  d.setInt32(4, Math.round(lat * 1e7), true); d.setInt32(8, Math.round(lon * 1e7), true); d.setInt32(12, Math.round((alt || 100) * 1000), true);
  d.setInt32(16, Math.round((relAlt || 0) * 1000), true); d.setInt16(20, 300, true); d.setInt16(22, 400, true); d.setInt16(24, -50, true); d.setUint16(26, 9000, true);
});
const sysStatus = (M, sys, mv, pct) => frame(M, sys, 1, MSG.SYS_STATUS, d => { d.setUint16(14, mv, true); d.setInt16(16, 1250, true); d.setInt8(30, pct); });
const followTarget = (M, sys, comp, lat, lon) => frame(M, sys, comp, MSG.FOLLOW_TARGET, d => { d.setInt32(16, Math.round(lat * 1e7), true); d.setInt32(20, Math.round(lon * 1e7), true); d.setFloat32(24, 12, true); });

/* ---------------------------------------------------------------- live */

test('MAVLink live: a ground station has its own icon and never a trail', () => {
  const MB = load(['js/mavlink.js'], { map: true }), M = MB.mavlink;
  const p = new M.Parser(m => M.handle(m));
  p.push(heartbeat(M, 255, 190, { type: 6, autopilot: 8 })); // MAV_TYPE_GCS, MAV_AUTOPILOT_INVALID
  p.push(gpi(M, 255, 190, 47.39, 8.54));
  p.push(gpi(M, 255, 190, 47.392, 8.542));
  p.push(followTarget(M, 255, 190, 47.395, 8.545));
  M.render();
  const g = M.vehicles.get(255);
  assert.ok(g && g.gcs, 'known as a ground station');
  assert.equal(g.lat, 47.395, 'its follow-me position places it');
  assert.ok(g.marker, 'it has a marker');
  assert.match(g.marker.options.icon.className, /mb-uav-gcs/);
  assert.match(g.marker.options.icon.html, /class="wave"/, 'drawn as a ground station');
  assert.equal(g.trail.length, 0, 'no trail kept');
  assert.equal(g.line, null, 'no trail drawn');
  assert.equal(g.homeMarker, null);
  assert.match(M.listHtml(), /Ground station 255/);
  assert.match(M.statusText.call(Object.assign(Object.create(M), { rt: Object.assign({}, M.rt, { on: true, open: true, bytes: 100, lastData: Date.now(), parser: { valid: 3 } }) })), /1 ground station/);
  // a vehicle beside it keeps its trail, in its own shape
  p.push(heartbeat(M, 1, 1, { type: 2, autopilot: 3, mode: 5, baseMode: 129 }));
  p.push(gpi(M, 1, 1, 47.40, 8.55, 20));
  p.push(gpi(M, 1, 1, 47.401, 8.551, 22));
  M.render();
  const v = M.vehicles.get(1);
  assert.equal(v.gcs, false);
  assert.match(v.marker.options.icon.className, /mb-uav-multi/);
  assert.equal(v.trail.length, 2);
  assert.ok(v.line, 'a vehicle has its trail');
  assert.notEqual(M.color(v), M.color(g), 'colored apart');
});

test('MAVLink live: a system that never sends a position is not shown; companions and gimbals are not vehicles', () => {
  const MB = load(['js/mavlink.js'], { map: true }), M = MB.mavlink;
  const p = new M.Parser(m => M.handle(m));
  p.push(heartbeat(M, 3, 1, { type: 2, autopilot: 3 }));
  p.push(sysStatus(M, 3, 15800, 76));
  p.push(heartbeat(M, 254, 190, { type: 6, autopilot: 8 })); // a ground station without a position
  p.push(heartbeat(M, 1, 191, { type: 18, autopilot: 8 }));  // an onboard computer
  M.render();
  assert.equal(M.vehicles.get(3).volt, 15.8, 'its telemetry is read');
  assert.equal(M.vehicles.get(3).marker, null, 'but no marker');
  assert.equal(M.vehicles.get(254).marker, null, 'nor for the ground station');
  assert.equal(M.listHtml(), '', 'and no list entry');
  assert.equal(M.countText.call(Object.assign(Object.create(M), { rt: { on: true } })), '0 shown');
  assert.ok(!M.vehicles.has(1), 'the companion computer is no vehicle');
  // a GPS without a fix does not place it either; and 0,0 never does
  p.push(frame(M, 3, 1, MSG.GPS_RAW_INT, d => { d.setInt32(8, 473900000, true); d.setInt32(12, 85400000, true); d.setUint8(28, 1); }));
  p.push(gpi(M, 3, 1, 0, 0));
  M.render();
  assert.equal(M.vehicles.get(3).lat, null);
  assert.equal(M.listHtml(), '');
});

test('MAVLink live: labels show the system id by default; pins add values for one vehicle and are remembered', () => {
  const MB = load(['js/mavlink.js'], { map: true }), M = MB.mavlink;
  const p = new M.Parser(m => M.handle(m));
  p.push(heartbeat(M, 7, 1, { type: 2, autopilot: 3, mode: 5, baseMode: 129 }));
  p.push(gpi(M, 7, 1, 47.4, 8.5, 31));
  p.push(sysStatus(M, 7, 15800, 76));
  p.push(heartbeat(M, 8, 1, { type: 2, autopilot: 3, mode: 6, baseMode: 1 }));
  p.push(gpi(M, 8, 1, 47.41, 8.51, 12));
  const v7 = M.vehicles.get(7), v8 = M.vehicles.get(8);
  same(M.conf().show, ['id'], 'the system id by default');
  same([...M.label(v7)], ['#7']);
  M.setPin(7, 'batt', true);
  M.setPin(7, 'mode', true);
  same([...M.label(v7)], ['#7', 'Loiter', 'Bat 76% · 15.8 V'], 'in the fields\' order');
  same([...M.label(v8)], ['#8'], 'pins are per vehicle');
  same([...MB.settings.mavlink.pins[7]], ['batt', 'mode'], 'kept in the device settings');
  assert.ok(MB.saved > 0);
  // Show by default: for every vehicle
  M.conf().show = ['id', 'alt'];
  same([...M.label(v8)], ['#8', 'Alt 12 m']);
  // labels off: the pins still show
  M.conf().labels = false;
  same([...M.label(v7)], ['Loiter', 'Bat 76% · 15.8 V']);
  same([...M.label(v8)], []);
  M.setPin(7, 'batt', false);
  same([...M.label(v7)], ['Loiter']);
  M.setPin(7, 'mode', false);
  assert.equal(MB.settings.mavlink.pins[7], undefined, 'no pins left: nothing kept');
  // every row of the details names a field that can be pinned
  const rows = M.rows(v7, Date.now());
  const pinnable = rows.filter(r => r.pin).map(r => r.key);
  ['id', 'mode', 'state', 'alt', 'gs', 'climb', 'hdg', 'batt', 'pos'].forEach(k => assert.ok(pinnable.includes(k), k));
  assert.ok(rows.every(r => !r.pin || M.fields.some(f => f.key === r.key)));
});

/* ---------------------------------------------------------------- .tlog */
function tlog(M, records) { // [[ms since 1970, frame]]
  return Buffer.concat(records.map(([ms, f]) => { const h = Buffer.alloc(8); h.writeBigUInt64BE(BigInt(Math.round(ms * 1000))); return Buffer.concat([h, f]); }));
}
const allModules = ['js/mavlink.js', 'js/tracklogs.js', 'js/mavlogs.js'];
const arr = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);

test('.tlog: a track per vehicle with UTC times and its modes; 0,0 dropped; a ground station has no track', async () => {
  const MB = load(allModules), M = MB.mavlink;
  const T = Date.UTC(2026, 4, 1, 12, 0, 0);
  const recs = [
    [T, heartbeat(M, 1, 1, { type: 2, autopilot: 3, mode: 3, baseMode: 129 })], // Auto
    [T + 100, gpi(M, 1, 1, 0, 0)],                                            // no position yet
    [T + 500, gpi(M, 1, 1, 47.4, 8.5, 10)],
    [T + 1000, heartbeat(M, 1, 1, { type: 2, autopilot: 3, mode: 6, baseMode: 129 })], // RTL
    [T + 1500, gpi(M, 1, 1, 47.401, 8.501, 15)],
    [T + 1600, heartbeat(M, 255, 190, { type: 6, autopilot: 8 })],
    [T + 1700, gpi(M, 255, 190, 47.3, 8.4)],
    [T + 2000, gpi(M, 2, 1, 47.5, 8.6, 5)]
  ];
  const buf = Buffer.concat([Buffer.from([0xFD, 1, 2, 3]), tlog(M, recs)]); // (a few stray bytes first)
  let last = 0;
  const { kind, log } = await MB.mavLogs.parse('flight.tlog', arr(buf), { onProgress: f => { last = f; } });
  assert.equal(kind, 'tlog');
  assert.equal(last, 1);
  assert.equal(log.timeBase, 'utc');
  same(log.vehicles.map(v => v.key), ['1', '2'], 'the ground station (255) has no track');
  const v1 = log.vehicles[0];
  assert.equal(v1.points.length, 2, '0,0 dropped');
  assert.equal(v1.points[0].t, T + 500);
  assert.equal(v1.points[0].mode, 'Auto');
  assert.equal(v1.points[1].mode, 'RTL');
  assert.equal(v1.points[1].alt, 15);
  assert.equal(v1.points[1].altRef, 'rel');
  assert.equal(v1.points[1].speed, 5);
  assert.equal(log.vehicles[1].label, 'Vehicle 2', 'a vehicle never heard by heartbeat');
  const id = MB.trackLogs.add(log);
  assert.ok(id);
  same(MB.trackLogs.list('mavlink').map(l => l.vehicles.length), [2]);
});

test('.tlog: a log without any position is not added', async () => {
  const MB = load(allModules), M = MB.mavlink, T = Date.UTC(2026, 4, 1);
  const buf = tlog(M, [[T, heartbeat(M, 1, 1, { type: 2, autopilot: 3 })], [T + 10, sysStatus(M, 1, 12000, 50)], [T + 20, gpi(M, 1, 1, 0, 0)]]);
  const { log } = await MB.mavLogs.parse('nothing.tlog', arr(buf));
  assert.equal(log.vehicles.length, 0);
  assert.equal(MB.trackLogs.add(log), null);
  assert.equal(MB.trackLogs.list().length, 0);
});

/* ---------------------------------------------------------------- DataFlash .bin */
const DF = { b: 1, B: 1, M: 1, h: 2, H: 2, c: 2, C: 2, i: 4, I: 4, e: 4, E: 4, L: 4, f: 4, n: 4, N: 16, Z: 64, d: 8, q: 8, Q: 8 };
function dfWrite(d, o, ch, v) {
  switch (ch) {
    case 'b': d.setInt8(o, v); break; case 'B': case 'M': d.setUint8(o, v); break; case 'h': d.setInt16(o, v, true); break; case 'H': d.setUint16(o, v, true); break;
    case 'c': d.setInt16(o, Math.round(v * 100), true); break; case 'C': d.setUint16(o, Math.round(v * 100), true); break;
    case 'i': d.setInt32(o, v, true); break; case 'I': d.setUint32(o, v, true); break; case 'e': d.setInt32(o, Math.round(v * 100), true); break;
    case 'E': d.setUint32(o, Math.round(v * 100), true); break; case 'L': d.setInt32(o, Math.round(v * 1e7), true); break; case 'f': d.setFloat32(o, v, true); break;
    case 'd': d.setFloat64(o, v, true); break; case 'q': d.setBigInt64(o, BigInt(v), true); break; case 'Q': d.setBigUint64(o, BigInt(v), true); break;
    case 'n': case 'N': case 'Z': Buffer.from(d.buffer, d.byteOffset, d.byteLength).write(String(v), o, DF[ch], 'latin1'); break;
  }
}
function dfLog() {
  const types = {}, parts = [];
  const msg = (type, format, values) => {
    const len = 3 + [...format].reduce((s, c) => s + DF[c], 0), b = Buffer.alloc(len), d = new DataView(b.buffer, b.byteOffset, len);
    b[0] = 0xA3; b[1] = 0x95; b[2] = type;
    let o = 3; [...format].forEach((c, k) => { dfWrite(d, o, c, values[k]); o += DF[c]; });
    parts.push(b);
  };
  const fmt = (type, name, format, cols) => { types[name] = { type, format }; msg(128, 'BBnNZ', [type, 3 + [...format].reduce((s, c) => s + DF[c], 0), name, format, cols]); };
  fmt(128, 'FMT', 'BBnNZ', 'Type,Length,Name,Format,Columns');
  return {
    fmt, raw: b => parts.push(b), bytes: () => Buffer.concat(parts),
    add: (name, values) => msg(types[name].type, types[name].format, values)
  };
}

test('DataFlash .bin: formats read from FMT; GPS with a 3D fix only; modes named for the firmware; UTC from GPS time', async () => {
  const MB = load(allModules);
  const b = dfLog();
  b.fmt(130, 'GPS', 'QBIHBcLLefffB', 'TimeUS,Status,GMS,GWk,NSats,HDop,Lat,Lng,Alt,Spd,GCrs,VZ,U');
  b.fmt(131, 'MODE', 'QMBB', 'TimeUS,Mode,ModeNum,Rsn');
  b.fmt(132, 'MSG', 'QZ', 'TimeUS,Message');
  b.fmt(133, 'POS', 'QLLfff', 'TimeUS,Lat,Lng,Alt,RelHomeAlt,RelOriginAlt');
  b.fmt(134, 'BAT', 'QBfffffcfB', 'TimeUS,Inst,Volt,VoltR,Curr,CurrTot,EnrgTot,Temp,Res,RemPct');
  b.fmt(135, 'XKF1', 'QBffff', 'TimeUS,C,Roll,Pitch,Yaw,VN'); // not read: skipped whole
  b.add('MSG', [1000, 'ArduCopter V4.5.7 (2a3dc4b7)']);
  b.add('MODE', [2000000, 5, 5, 1]); // Loiter
  const wk = 2400, gms = 302400000; // a GPS week and time of week
  b.add('GPS', [3000000, 1, gms, wk, 4, 9.9, 47.3, 8.5, 400, 0, 0, 0, 0]);     // no fix: dropped
  b.add('POS', [3900000, 47.4, 8.5, 410, 12.5, 12.5]);
  b.add('BAT', [3950000, 0, 15.9, 15.9, 8.2, 120, 0, 25, 0.01, 81]);
  b.add('GPS', [4000000, 3, gms + 1000, wk, 14, 0.7, 47.4, 8.5, 410, 6.2, 90, -1.5, 1]);
  b.add('XKF1', [4100000, 0, 1, 2, 3, 4]);
  b.raw(Buffer.from([0xA3, 0x95, 0xEE, 1, 2, 3])); // an unknown type: resynced
  b.add('MODE', [4500000, 6, 6, 2]); // RTL
  b.add('GPS', [5000000, 3, gms + 2000, wk, 14, 0.7, 0, 0, 410, 6, 90, 0, 1]); // 0,0: dropped
  b.add('POS', [5900000, 47.401, 8.501, 412, 14, 14]);
  b.add('GPS', [6000000, 4, gms + 3000, wk, 15, 0.6, 47.401, 8.501, 412, 5.5, 91, 0.5, 1]);
  const { kind, log } = await MB.mavLogs.parse('00000042.BIN', arr(b.bytes()));
  assert.equal(kind, 'bin');
  assert.equal(log.timeBase, 'utc');
  const pts = log.vehicles[0].points;
  assert.equal(log.vehicles[0].label, 'Copter');
  assert.equal(pts.length, 2);
  const utc = 315964800000 + wk * 604800000 + gms + 1000 - 18000;
  assert.equal(pts[0].t, utc, 'GPS week and time of week, less the leap seconds');
  assert.equal(pts[1].t, utc + 2000);
  same([pts[0].mode, pts[1].mode], ['Loiter', 'RTL']);
  assert.equal(pts[0].alt, 12.5); assert.equal(pts[0].altRef, 'rel'); assert.equal(pts[0].amsl, 410);
  assert.ok(Math.abs(pts[0].speed - 6.2) < 1e-5);
  assert.equal(pts[0].climb, 1.5, 'VZ is down');
  assert.equal(pts[0].sats, 14);
  assert.ok(Math.abs(pts[0].volt - 15.9) < 1e-5);
  assert.equal(pts[0].batt, 81);
});

test('DataFlash .bin: without GPS time the log is relative; without a fix it is not added', async () => {
  const MB = load(allModules);
  const b = dfLog();
  b.fmt(130, 'GPS', 'QBIHBcLLefffB', 'TimeUS,Status,GMS,GWk,NSats,HDop,Lat,Lng,Alt,Spd,GCrs,VZ,U');
  b.add('GPS', [9000000, 3, 0, 0, 8, 1, 47.4, 8.5, 400, 1, 0, 0, 0]);
  b.add('GPS', [9500000, 3, 0, 0, 8, 1, 47.4001, 8.5, 400, 1, 0, 0, 0]);
  const { log } = await MB.mavLogs.parse('a.bin', arr(b.bytes()));
  assert.equal(log.timeBase, 'relative');
  same(log.vehicles[0].points.map(p => p.t), [0, 500], 'from the first point');
  assert.equal(log.vehicles[0].points[0].mode, null, 'no MODE message');
  const none = dfLog();
  none.fmt(130, 'GPS', 'QBIHBcLLefffB', 'TimeUS,Status,GMS,GWk,NSats,HDop,Lat,Lng,Alt,Spd,GCrs,VZ,U');
  none.add('GPS', [1000, 1, 0, 0, 0, 99, 0, 0, 0, 0, 0, 0, 0]);
  const r = await MB.mavLogs.parse('b.bin', arr(none.bytes()));
  assert.equal(r.log.vehicles.length, 0);
  assert.equal(MB.trackLogs.add(r.log), null);
});

test('DataFlash .bin: Plane and Rover mode names', async () => {
  const MB = load(allModules);
  for (const [fw, num, name] of [['ArduPlane V4.5.0', 11, 'RTL'], ['ArduPlane V4.5.0', 5, 'FBWA'], ['ArduRover V4.5.0', 4, 'Hold']]) {
    const b = dfLog();
    b.fmt(130, 'GPS', 'QBIHBcLLefffB', 'TimeUS,Status,GMS,GWk,NSats,HDop,Lat,Lng,Alt,Spd,GCrs,VZ,U');
    b.fmt(131, 'MODE', 'QMBB', 'TimeUS,Mode,ModeNum,Rsn');
    b.fmt(132, 'MSG', 'QZ', 'TimeUS,Message');
    b.add('MSG', [1, fw]); b.add('MODE', [2, num, num, 0]);
    b.add('GPS', [1000000, 3, 0, 0, 8, 1, 47.4, 8.5, 400, 1, 0, 0, 0]);
    const { log } = await MB.mavLogs.parse('x.bin', arr(b.bytes()));
    assert.equal(log.vehicles[0].points[0].mode, name, fw + ' mode ' + num);
  }
});

/* ---------------------------------------------------------------- PX4 ULog .ulg */
function ulog() {
  const parts = [];
  const head = Buffer.alloc(16); head.write('ULog', 0, 'latin1'); head[4] = 0x01; head[5] = 0x12; head[6] = 0x35; head[7] = 1;
  parts.push(head);
  const msg = (type, body) => { const h = Buffer.alloc(3); h.writeUInt16LE(body.length, 0); h[2] = type.charCodeAt(0); parts.push(h, body); };
  msg('B', Buffer.alloc(40));
  const topics = {};
  let nextId = 0;
  return {
    format(name, fields) { topics[name] = fields; msg('F', Buffer.from(name + ':' + fields.map(([t, n]) => t + ' ' + n + ';').join(''), 'latin1')); },
    add(name, multi) { const id = nextId++, b = Buffer.alloc(3 + name.length); b[0] = multi || 0; b.writeUInt16LE(id, 1); b.write(name, 3, 'latin1'); msg('A', b); return id; },
    data(id, name, values) {
      const f = topics[name], size = f.reduce((s, [t]) => s + ({ uint64_t: 8, double: 8, int32_t: 4, float: 4, uint8_t: 1, 'uint8_t[3]': 3 })[t], 0);
      const b = Buffer.alloc(2 + size), d = new DataView(b.buffer, b.byteOffset, b.length);
      b.writeUInt16LE(id, 0);
      let o = 2;
      f.forEach(([t], k) => {
        const v = values[k];
        if (t === 'uint64_t') d.setBigUint64(o, BigInt(v), true), o += 8;
        else if (t === 'double') d.setFloat64(o, v, true), o += 8;
        else if (t === 'int32_t') d.setInt32(o, v, true), o += 4;
        else if (t === 'float') d.setFloat32(o, v, true), o += 4;
        else if (t === 'uint8_t') d.setUint8(o, v), o += 1;
        else o += 3; // padding
      });
      msg('D', b);
    },
    raw: b => parts.push(b),
    bytes: () => Buffer.concat(parts)
  };
}

test('PX4 .ulg: formats read from the log; the fused position preferred; nav_state as the mode; UTC from GPS', async () => {
  const MB = load(allModules);
  const u = ulog();
  u.format('vehicle_status', [['uint64_t', 'timestamp'], ['uint8_t', 'nav_state'], ['uint8_t', 'vehicle_type'], ['uint8_t[3]', '_padding0']]);
  u.format('vehicle_gps_position', [['uint64_t', 'timestamp'], ['uint64_t', 'time_utc_usec'], ['int32_t', 'lat'], ['int32_t', 'lon'], ['int32_t', 'alt'], ['float', 'vel_m_s'], ['uint8_t', 'fix_type'], ['uint8_t', 'satellites_used']]);
  u.format('vehicle_global_position', [['uint64_t', 'timestamp'], ['double', 'lat'], ['double', 'lon'], ['float', 'alt']]);
  u.format('vehicle_local_position', [['uint64_t', 'timestamp'], ['float', 'z'], ['float', 'vx'], ['float', 'vy'], ['float', 'vz']]);
  u.format('esc_status', [['uint64_t', 'timestamp'], ['float', 'rpm']]); // a topic not read
  const st = u.add('vehicle_status'), gps = u.add('vehicle_gps_position'), gpos = u.add('vehicle_global_position'), lpos = u.add('vehicle_local_position'), esc = u.add('esc_status');
  const UTC = Date.UTC(2026, 6, 4, 9, 30, 0) * 1000; // µs
  u.data(st, 'vehicle_status', [1000000, 2, 1, 0]);                              // Position
  u.data(gps, 'vehicle_gps_position', [2000000, 0, 473000000, 85000000, 400000, 0, 2, 5]);  // 2D fix: no time taken
  u.data(gps, 'vehicle_gps_position', [3000000, UTC, 474000000, 85000000, 410000, 3, 3, 12]);
  u.data(esc, 'esc_status', [3100000, 1234]);
  u.data(lpos, 'vehicle_local_position', [3150000, -25, 3, 4, -1]);
  u.data(gpos, 'vehicle_global_position', [3200000, 47.4, 8.5, 435]);
  u.raw(Buffer.from([0, 0, 0x7A, 9, 9])); // garbage, then a sync marker
  u.raw(Buffer.from([3, 0, 0x53 /* S */, 0x2F, 0x73, 0x13, 0x20, 0x25, 0x0C, 0xBB, 0x12]));
  u.data(st, 'vehicle_status', [3500000, 5, 1, 0]);                              // Return
  u.data(gpos, 'vehicle_global_position', [3800000, 0, 0, 435]);                 // 0,0: dropped
  u.data(gpos, 'vehicle_global_position', [4200000, 47.401, 8.501, 440]);
  const { kind, log } = await MB.mavLogs.parse('log_7_2026-7-4.ulg', arr(u.bytes()));
  assert.equal(kind, 'ulg');
  assert.equal(log.timeBase, 'utc');
  const v = log.vehicles[0];
  assert.equal(v.label, 'Multicopter');
  assert.equal(v.points.length, 2, 'the fused positions, 0,0 dropped');
  const off = UTC / 1000 - 3000;
  assert.equal(v.points[0].t, 3200 + off);
  assert.equal(v.points[1].t, 4200 + off);
  same(v.points.map(p => p.mode), ['Position', 'Return']);
  assert.equal(v.points[0].alt, 25, 'relative altitude from the local position');
  assert.equal(v.points[0].altRef, 'rel');
  assert.equal(v.points[0].amsl, 435);
  assert.equal(v.points[0].speed, 5);
  assert.equal(v.points[0].climb, 1);
});

test('PX4 .ulg: GPS positions when there is no fused one; no position at all: not added', async () => {
  const MB = load(allModules);
  const u = ulog();
  u.format('vehicle_gps_position', [['uint64_t', 'timestamp'], ['uint64_t', 'time_utc_usec'], ['int32_t', 'lat'], ['int32_t', 'lon'], ['int32_t', 'alt'], ['float', 'vel_m_s'], ['uint8_t', 'fix_type'], ['uint8_t', 'satellites_used']]);
  const gps = u.add('vehicle_gps_position');
  u.data(gps, 'vehicle_gps_position', [1000000, 0, 474000000, 85000000, 410000, 2, 3, 9]);
  u.data(gps, 'vehicle_gps_position', [1500000, 0, 474001000, 85000000, 410000, 2, 1, 9]); // no fix
  u.data(gps, 'vehicle_gps_position', [2000000, 0, 474002000, 85000000, 411000, 2, 4, 9]);
  const { log } = await MB.mavLogs.parse('g.ulg', arr(u.bytes()));
  assert.equal(log.timeBase, 'relative');
  same(log.vehicles[0].points.map(p => p.t), [0, 1000]);
  assert.equal(log.vehicles[0].points[1].alt, 411);
  const e = ulog();
  e.format('vehicle_status', [['uint64_t', 'timestamp'], ['uint8_t', 'nav_state']]);
  e.data(e.add('vehicle_status'), 'vehicle_status', [1, 3]);
  const r = await MB.mavLogs.parse('empty.ulg', arr(e.bytes()));
  assert.equal(r.log.vehicles.length, 0);
  assert.equal(MB.trackLogs.add(r.log), null);
});

/* ---------------------------------------------------------------- the shared track module */
const pts = (t0, n, lat, opts) => Array.from({ length: n }, (_, i) => Object.assign({ t: t0 + i * 1000, lat: lat + i * 0.0001, lon: 8.5, alt: 100 + i, altRef: 'msl', mode: i < n / 2 ? 'Auto' : 'RTL' }, opts));

test('tracks: UTC logs align on their clocks, relative logs at the earliest UTC start', () => {
  const MB = load(['js/tracklogs.js']), T = MB.trackLogs;
  const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
  const a = T.add({ source: 'mavlink', name: 'A', timeBase: 'utc', vehicles: [{ key: '1', label: 'A', points: pts(t0, 11, 47.4) }] });
  const b = T.add({ source: 'mavlink', name: 'B', timeBase: 'utc', vehicles: [{ key: '1', label: 'B', points: pts(t0 + 5000, 11, 47.5) }] });
  const c = T.add({ source: 'betaflight', name: 'C', timeBase: 'relative', vehicles: [{ key: 'q', label: 'C', points: pts(0, 4, 47.6) }] });
  same({ ...T.timeline() }, { start: t0, end: t0 + 15000, utc: true });
  assert.equal(T.offset(a), 0);
  assert.equal(T.offset(c), t0, 'a relative log starts with the earliest UTC one');
  // at t0 + 5 s: A at its 6th point, B at its first, C past its end
  assert.ok(Math.abs(T.positionAt(a, '1', t0 + 5000).lat - 47.4005) < 1e-9);
  assert.ok(Math.abs(T.positionAt(b, '1', t0 + 5000).lat - 47.5) < 1e-9);
  assert.equal(T.positionAt(c, 'q', t0 + 5000), null, 'outside its time');
  assert.ok(Math.abs(T.positionAt(c, 'q', t0 + 1500).lat - 47.60015) < 1e-9, 'in proportion between two points');
  assert.equal(T.positionAt(b, '1', t0 + 4999), null, 'before it starts');
  // without UTC logs, relative logs start together at 0
  T.remove(a); T.remove(b);
  const d = T.add({ source: 'betaflight', name: 'D', timeBase: 'relative', vehicles: [{ key: 'q', label: 'D', points: pts(0, 6, 47.7) }] });
  assert.equal(T.offset(c), 0);
  same({ ...T.timeline() }, { start: 0, end: 5000, utc: false });
  T.seek(2500);
  assert.equal(T.time(), 2500);
  T.setVisible(d, false);
  same({ ...T.timeline() }, { start: 0, end: 3000, utc: false }, 'hidden logs leave the time line');
  same(T.list('betaflight').map(l => l.name), ['C', 'D']);
});

test('tracks: points without a position are dropped, speed and climb worked out, color choices by what the log has', () => {
  const MB = load(['js/tracklogs.js']), T = MB.trackLogs;
  const raw = [
    { t: 2000, lat: 47.4002, lon: 8.5, alt: 104, altRef: 'msl' },
    { t: 0, lat: 47.4, lon: 8.5, alt: 100, altRef: 'msl' },
    { t: 500, lat: 0, lon: 0, alt: 100 },          // 0,0
    { t: 700, lat: 95, lon: 8.5 },                 // out of range
    { t: 800, lon: 8.5 },                          // no latitude
    { t: 1000, lat: 47.4001, lon: 8.5, alt: 102, altRef: 'msl' }
  ];
  const id = T.add({ source: 'mavlink', name: 'X', timeBase: 'relative', vehicles: [{ key: '1', label: 'X', points: raw }, { key: '2', label: 'Empty', points: [{ t: 0, lat: 0, lon: 0 }] }] });
  const l = T.get(id);
  assert.equal(l.vehicles.length, 1, 'a vehicle without a position is dropped');
  const p = l.vehicles[0].pts;
  same(p.map(x => x.t), [0, 1000, 2000], 'in time order');
  assert.ok(Math.abs(p[1].speed - 11.12) < 0.05, 'speed from the positions');
  assert.ok(Math.abs(p[1].climb - 2) < 1e-9, 'climb from the altitudes');
  same(p.map(x => x.h), [0, 2, 4], 'height above the start');
  assert.equal(T.setColorBy(id, 'mode'), false, 'no modes in this log');
  assert.equal(T.setColorBy(id, 'speed'), true);
  assert.equal(T.list()[0].colorBy, 'speed');
  assert.equal(T.add({ source: 'mavlink', name: 'none', vehicles: [{ points: [{ t: 0, lat: 0, lon: 0 }] }] }), null);
  same(T.COLOR_BY.map(c => c.id), ['track', 'speed', 'alt', 'mode', 'climb']);
});

test('tracks: the same kind of flight mode has the same color in MAVLink and Betaflight logs', () => {
  const MB = load(['js/tracklogs.js']), c = MB.trackLogs.modeColor;
  [['RTL', 'GPS Rescue'], ['Return', 'Smart RTL'], ['Land', 'Failsafe'], ['Loiter', 'Position hold'], ['PosHold', 'Hold'],
    ['AltHold', 'Altitude hold'], ['ALTCTL', 'Altitude hold'],
    ['Stabilize', 'Angle'], ['Acro', 'Horizon'], ['Auto', 'Autopilot'], ['Mission', 'Auto']].forEach(([a, b]) => assert.equal(c(a), c(b), a + ' / ' + b));
  assert.notEqual(c('RTL'), c('Land'));
  assert.notEqual(c('Auto'), c('Loiter'));
  assert.notEqual(c('AltHold'), c('PosHold'), 'holding height is not holding position');
  assert.equal(c('Some new mode'), c('Some new mode'), 'others: a color of their own, kept');
});
