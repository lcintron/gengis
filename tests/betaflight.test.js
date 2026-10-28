'use strict';
// Betaflight blackbox logs (js/betaflight.js): the decoder against logs written here byte by byte from the published
// format (header lines, each encoding and predictor, I/P/G/H/S/E frames, several logs in one file), blackbox_decode's
// CSV, and what the panel does with a file that has no position.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..');

// js/betaflight.js in a sandbox, with a stand-in for the track layer (tracklogs.js) and the toast.
function load() {
  const added = [], toasts = [], zoomed = [];
  const MB = {
    escapeHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    toast: msg => toasts.push(msg),
    ICON: { open: '<svg viewBox="0 0 24 24"></svg>' },
    iconBtn: (icon, title, attrs) => `<button type="button" class="icon-btn mini" ${attrs}>${icon}</button>`,
    data: { sourceOpen: () => true, infoIcon: t => `<span class="ds-info">${t}</span>` },
    trackLogs: {
      add(log) {
        const pts = log.vehicles.flatMap(v => v.points).filter(p => isFinite(p.lat) && isFinite(p.lon) && !(p.lat === 0 && p.lon === 0));
        if (!pts.length) return null;
        added.push(log);
        return 'log' + added.length;
      },
      list: () => added.map((l, i) => ({ id: 'log' + (i + 1), source: l.source })),
      listHtml: () => added.map((l, i) => `<div class="data-item trk-item" data-log="log${i + 1}"></div>`).join(''),
      renderList() {},
      zoomTo(id) { zoomed.push(id); }
    }
  };
  const ctx = { window: { MB }, setTimeout, performance, TextDecoder, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/betaflight.js'), 'utf8'), ctx, { filename: 'betaflight.js' });
  return { BF: MB.betaflight, MB, added, toasts, zoomed };
}
const { BF } = load();
const plain = x => JSON.parse(JSON.stringify(x)); // (the sandbox's arrays and objects, as this realm's)

/* ---------------------------------------------------------------- a writer for the format */

const uvb = v => { const out = []; v = Math.floor(v) >>> 0; while (v >= 128) { out.push((v & 127) | 128); v = Math.floor(v / 128); } out.push(v); return out; };
const zig = v => ((v << 1) ^ (v >> 31)) >>> 0;
const svb = v => uvb(zig(v));
const fits = (v, bits) => v >= -(2 ** (bits - 1)) && v < 2 ** (bits - 1);
const sized = vals => { // 3 values of 1 to 4 bytes, little-endian, their sizes in the lead byte
  let sel = 0; const body = [];
  vals.forEach((v, i) => {
    const n = fits(v, 8) ? 1 : fits(v, 16) ? 2 : fits(v, 24) ? 3 : 4;
    sel |= (n - 1) << (2 * i);
    for (let k = 0; k < n; k++) body.push((v >> (8 * k)) & 255);
  });
  return [0xc0 | sel, ...body];
};
const ENCODE = {
  0: vals => svb(vals[0]),
  1: vals => uvb(vals[0]),
  3: vals => uvb((-vals[0]) & 0x3fff),
  9: () => [],
  6: vals => {
    if (vals.length === 1) return svb(vals[0]);
    let h = 0; const body = [];
    vals.forEach((v, i) => { if (v) { h |= 1 << i; body.push(...svb(v)); } });
    return [h, ...body];
  },
  7: ([a, b, c]) => {
    if ([a, b, c].every(v => fits(v, 2))) return [(a & 3) << 4 | (b & 3) << 2 | (c & 3)];
    if ([a, b, c].every(v => fits(v, 4))) return [0x40 | (a & 15), (b & 15) << 4 | (c & 15)];
    if ([a, b, c].every(v => fits(v, 6))) return [0x80 | (a & 63), b & 63, c & 63];
    return sized([a, b, c]);
  },
  10: ([a, b, c]) => {
    if ([a, b, c].every(v => fits(v, 2))) return [(a & 3) << 4 | (b & 3) << 2 | (c & 3)];
    if (fits(a, 5) && fits(b, 5) && fits(c, 4)) return [0x40 | (a & 31) << 1 | (b >> 4 & 1), (b & 15) << 4 | (c & 15)];
    if (fits(a, 8) && fits(b, 7) && fits(c, 7)) return [0x80 | (a & 255) >> 2, (a & 3) << 6 | (b & 127) >> 1, (b & 1) << 7 | (c & 127)];
    return sized([a, b, c]);
  },
  8: vals => { // 4 values: 0, 4, 8 or 16 bits, packed as nibbles, most significant first
    let sel = 0; const sizes = vals.map((v, i) => { const s = v === 0 ? 0 : fits(v, 4) ? 1 : fits(v, 8) ? 2 : 3; sel |= s << (2 * i); return s; });
    const out = [sel]; let half = false, buf = 0;
    const nib = n => { if (!half) { buf = (n & 15) << 4; half = true; } else { out.push(buf | (n & 15)); half = false; } };
    vals.forEach((v, i) => { if (sizes[i] === 1) nib(v); else if (sizes[i] === 2) { nib(v >> 4); nib(v); } else if (sizes[i] === 3) { nib(v >> 12); nib(v >> 8); nib(v >> 4); nib(v); } });
    if (half) out.push(buf);
    return out;
  }
};
const GROUP = { 7: 3, 10: 3, 8: 4 };

// A frame definition as the header gives it.
function def(names, signed, pred, enc) { return { names: names.split(','), signed, pred, enc }; }
const MAIN = 'loopIteration,time,axisP[0],axisP[1],axisP[2],rcCommand[0],rcCommand[1],rcCommand[2],rcCommand[3],gyroADC[0],gyroADC[1],gyroADC[2],motor[0],motor[1],vbatLatest,amperageLatest,rssi';
const DEFS = {
  I: def(MAIN, [0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0], [0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 11, 5, 9, 0, 0], [1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 3, 0, 1]),
  P: def(MAIN, null, [6, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 3, 1, 1, 1], [9, 0, 7, 7, 7, 8, 8, 8, 8, 10, 10, 10, 6, 6, 6, 6, 6]),
  G: def('time,GPS_numSat,GPS_coord[0],GPS_coord[1],GPS_altitude,GPS_speed,GPS_ground_course', [0, 0, 1, 1, 1, 0, 0], [10, 0, 7, 7, 0, 0, 0], [1, 1, 0, 0, 0, 1, 1]),
  H: def('GPS_home[0],GPS_home[1]', [1, 1], [0, 0], [0, 0]),
  S: def('flightModeFlags,stateFlags,failsafePhase,rxSignalReceived,rxFlightChannelsValid', [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [1, 1, 7, 7, 7])
};
const K = { minthrottle: 1070, vbatref: 420, minmotor: 48 };

// One log, from a list of frames: ['I', values], ['P', values], ['G', values], ['H', values], ['S', values], ['E', bytes],
// or ['raw', bytes] (anything, for corruption). Values are the real ones: the writer works out what is stored.
function writeLog(frames, o) {
  o = o || {};
  const defs = o.defs || DEFS;
  const lines = ['Product:Blackbox flight data recorder by Nicholas Sherlock', 'Data version:2', 'I interval:4', 'P interval:' + (o.pInterval || '1/2'), 'P ratio:2',
    'Firmware type:Cleanflight', 'Firmware revision:' + (o.firmware || 'Betaflight 4.4.2 (7b1d7e3) STM32F405'), 'Log start datetime:' + (o.datetime || '0000-01-01T00:00:00.000+00:00'),
    'Craft name:' + (o.craft || ''), 'minthrottle:' + K.minthrottle, 'vbatref:' + K.vbatref, 'motorOutput:' + K.minmotor + ',2047'];
  for (const t of 'IPGHS') {
    const d = defs[t];
    if (!d) continue;
    if (t !== 'P') lines.push(`Field ${t} name:${d.names.join(',')}`, `Field ${t} signed:${d.signed.join(',')}`);
    lines.push(`Field ${t} predictor:${d.pred.join(',')}`, `Field ${t} encoding:${d.enc.join(',')}`);
  }
  const out = [...Buffer.from(lines.map(l => 'H ' + l + '\n').join(''), 'latin1')];
  let prev = null, prev2 = null, gPrev = null, home = [0, 0], lastTime = 0;
  const sign = (d, i) => !!(defs.I.signed[i]);
  for (const [type, vals] of frames) {
    if (type === 'raw' || type === 'E') { if (type === 'E') out.push(69); out.push(...vals); continue; }
    const d = type === 'P' ? defs.P : defs[type];
    const names = type === 'P' ? defs.I.names : d.names;
    const deltas = vals.map((v, i) => {
      let p = 0;
      switch (d.pred[i]) {
        case 1: p = type === 'G' ? gPrev[i] : prev[i]; break;
        case 2: p = 2 * prev[i] - prev2[i]; break;
        case 3: p = Math.trunc((prev[i] + prev2[i]) / 2); break;
        case 4: p = K.minthrottle; break;
        case 5: p = vals[names.indexOf('motor[0]')]; break;
        case 6: p = vals[i]; break; // (the decoder knows it: nothing is stored)
        case 7: p = home[/\[1\]/.test(names[i]) ? 1 : 0]; break;
        case 9: p = K.vbatref; break;
        case 10: p = lastTime; break;
        case 11: p = K.minmotor; break;
      }
      return (v - p) | 0;
    });
    void sign;
    for (let i = 0; i < d.enc.length;) {
      const e = d.enc[i];
      let n = GROUP[e] || 1;
      if (e === 6) { n = 1; while (i + n < d.enc.length && n < 8 && d.enc[i + n] === 6) n++; }
      const group = deltas.slice(i, i + n);
      while (group.length < n) group.push(0);
      out.push(...(i === 0 ? [type.charCodeAt(0)] : []), ...ENCODE[e](group));
      i += n;
    }
    if (type === 'I') { prev = prev2 = vals; lastTime = vals[1]; }
    else if (type === 'P') { prev2 = prev; prev = vals; lastTime = vals[1]; }
    else if (type === 'G') gPrev = vals;
    else if (type === 'H') home = vals.slice(0, 2);
  }
  if (!o.noEnd) out.push(69, 255, ...Buffer.from('End of log\0', 'latin1'));
  return Buffer.from(out);
}

// A flight: main frames every 2 loop iterations (I every 4), a GPS fix every 4th frame, from home at (lat, lon).
function flight(o) {
  o = o || {};
  const n = o.frames || 40, frames = [], lat0 = o.lat == null ? 47.3977419 : o.lat, lon0 = o.lon == null ? 8.5455938 : o.lon;
  const home = [Math.round(lat0 * 1e7), Math.round(lon0 * 1e7)];
  let time = o.time0 == null ? 1000000 : o.time0;
  const mains = [];
  if (!o.noHome) frames.push(['raw', []]);
  if (o.slow !== false) frames.push(['S', o.slow || [0b10, 0b11, 0, 1, 1]]); // ANGLE box on, GPS fix
  for (let k = 0; k < n; k++) {
    const it = k * 2;
    time = (time + 250 + (k % 3)) >>> 0; // (a straight-line predictor misses by a little)
    const thr = 1300 + k * 7, m0 = 900 + (k * 37) % 300;
    const vals = [it, time, k - 20, 3 * k, -400 + k * 25, k % 5 - 2, -300 + k * 31, 1200 - k * 50, thr, (k * 1013) % 4000 - 2000, k % 7 - 3, (-k * 3) | 0, m0, m0 + (k % 9) - 4, 1650 - k, k * 10 - 50, 800 + k];
    mains.push(vals);
    frames.push([it % 4 === 0 ? 'I' : 'P', vals]);
    if (k === 0 && !o.noHome) frames.push(['H', home]);
    if (k % 4 === 1 && !o.noGps) {
      const j = (k - 1) / 4, fix = o.fix ? o.fix(j) : true;
      frames.push(['G', [time + 37, fix ? 11 : 0, fix ? home[0] + j * 450 : 0, fix ? home[1] + j * 300 : 0, 4321 + j * 15, 1200 + j * 10, 1800 + j]]);
    }
    if (o.at && o.at[k]) frames.push(...o.at[k]);
  }
  return { frames, mains, home };
}

/* ---------------------------------------------------------------- the encodings */

const stream = bytes => new BF.Stream(Uint8Array.from(bytes));

test('variable byte values: unsigned (7 bits a byte, low first) and signed (zigzag)', () => {
  assert.deepEqual(uvb(1), [0x01]);
  assert.deepEqual(uvb(128), [0x80, 0x01]);
  assert.deepEqual(uvb(23456), [0xa0, 0xb7, 0x01]);
  for (const v of [0, 1, 127, 128, 23456, 2 ** 31, 2 ** 32 - 1]) assert.equal(stream(uvb(v)).uvb(), v);
  for (const v of [0, -1, 1, -64, 63, -1000000, 2 ** 31 - 1, -(2 ** 31)]) assert.equal(stream(svb(v)).svb(), v);
  assert.equal(stream([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]).uvb(), 0, 'more than 5 bytes: not a value');
  assert.throws(() => stream([0x80]).uvb(), /end of data/);
});

test('negative 14-bit (battery voltage against vbatref)', () => {
  for (const v of [0, 5, -5, 100, -8191, 8191]) assert.equal(stream(uvb((-v) & 0x3fff)).neg14(), v);
});

test('TAG8_8SVB: a byte of which fields are not zero, then those; a lone field has no byte', () => {
  const out = [];
  stream([0b00010100, ...svb(4), ...svb(-8)]).tag8_8svb(out, 5);
  assert.deepEqual(plain(out.slice(0, 5)), [0, 0, 4, 0, -8]);
  stream(svb(-77)).tag8_8svb(out, 1);
  assert.equal(out[0], -77);
});

test('TAG2_3S32: 2, 4 and 6 bit fields, and 1 to 4 bytes each', () => {
  const out = [];
  for (const vals of [[0, -1, 1], [-2, 1, 0], [7, -8, 3], [31, -32, 5], [100, -3, 40000], [-2000000, 3, 2 ** 31 - 1], [-(2 ** 31), 127, -129]]) {
    stream(ENCODE[7](vals)).tag2_3s32(out);
    assert.deepEqual(out.slice(0, 3), vals, String(vals));
  }
  assert.deepEqual(ENCODE[7]([0, -1, 1]), [0b00001101], 'all in 2 bits: one byte');
});

test('TAG2_3SVARIABLE: 2, 5-5-4 and 8-7-7 bit fields, and 1 to 4 bytes each', () => {
  const out = [];
  for (const vals of [[1, -2, 0], [15, -16, 7], [-16, 15, -8], [127, -64, 63], [-128, 63, -64], [300, 0, -70000]]) {
    stream(ENCODE[10](vals)).tag2_3svar(out);
    assert.deepEqual(out.slice(0, 3), vals, String(vals));
  }
  assert.equal(ENCODE[10]([15, -16, 7]).length, 2);
  assert.equal(ENCODE[10]([-128, 63, -64]).length, 3);
});

test('TAG8_4S16 (data version 2): nibbles most significant first, whatever the alignment', () => {
  assert.deepEqual(ENCODE[8]([13, 0, 4, 2]), [0b01010010, 0x0d, 0x42], 'the documented example');
  const out = [];
  for (const vals of [[13, 0, 4, 2], [3, 1000, -5, -30000], [-1, 100, 32767, -8], [0, 0, 0, 0], [5, -128, 127, 1], [-7, -2000, 9, 0]]) {
    stream(ENCODE[8](vals)).tag8_4s16(out, false);
    assert.deepEqual(out.slice(0, 4), vals, String(vals));
  }
});

test('TAG8_4S16 (data version 1): whole bytes, 16 bits little-endian, two 4-bit fields share a byte', () => {
  const out = [];
  // fields: 4-bit pair (3, -2), 8-bit -100, 16-bit 1234
  stream([0b11100101, (3 & 15) | ((-2 & 15) << 4), (-100) & 255, 1234 & 255, 1234 >> 8]).tag8_4s16(out, true);
  assert.deepEqual(plain(out.slice(0, 4)), [3, -2, -100, 1234]);
});

/* ---------------------------------------------------------------- headers and frames */

test('the header: each log found by its first line, fields and firmware read', () => {
  const a = writeLog(flight().frames, { craft: 'Wing 7' }), b = writeLog(flight().frames);
  const file = Buffer.concat([Buffer.from('junk before'), a, b]);
  assert.deepEqual(plain(BF.findLogs(Uint8Array.from(file))), [11, 11 + a.length]);
  const { headers, pos } = BF.readHeaders(file, 11, file.length);
  assert.equal(headers['Craft name'], 'Wing 7');
  assert.equal(headers['Field G name'], DEFS.G.names.join(','));
  assert.equal(String.fromCharCode(file[pos]), 'S', 'the frames start after the last header line');
  const r = new BF.LogReader(file, 11, 11 + a.length);
  assert.equal(r.defs.P.names.length, DEFS.I.names.length, 'P frames take the I frame\'s names');
  assert.deepEqual(plain(r.defs.P.signed), DEFS.I.signed.map(Boolean));
  assert.equal(r.fw.name, 'betaflight'); assert.equal(r.fw.major, 4); assert.ok(r.fw.bf4);
  assert.equal(r.pDenom, 2);
});

test('I and P frames: every predictor gives back the values written', () => {
  const f = flight({ frames: 41 }), got = [];
  const logs = BF.readBlackboxSync(writeLog(f.frames), v => got.push(v));
  assert.equal(logs.length, 1);
  assert.equal(got.length, f.mains.length, 'every main frame read');
  got.forEach((v, k) => assert.deepEqual(plain(v), f.mains[k], 'frame ' + k));
  assert.equal(logs[0].corrupt, 0);
});

test('a P interval written as a single number (Betaflight 4) counts the same skipped iterations', () => {
  const f = flight({ frames: 12 }), got = [];
  BF.readBlackboxSync(writeLog(f.frames, { pInterval: '2' }), v => got.push(v));
  assert.deepEqual(plain(got.map(v => v[0])), f.mains.map(v => v[0]));
});

test('G and H frames: positions from the home, in degrees, meters and m/s, with the main frame\'s values', () => {
  const f = flight({ frames: 40 });
  const [log] = BF.readBlackboxSync(writeLog(f.frames, { craft: 'Quad' }));
  assert.equal(log.points.length, 10);
  assert.equal(log.timeBase, 'relative');
  assert.equal(log.craft, 'Quad');
  const p = log.points[2];
  assert.ok(Math.abs(p.lat - (f.home[0] + 900) / 1e7) < 1e-12);
  assert.ok(Math.abs(p.lon - (f.home[1] + 600) / 1e7) < 1e-12);
  assert.equal(p.alt, 432.1 + 3, 'decimeters since Betaflight 4');
  assert.equal(p.altRef, 'msl');
  assert.equal(p.speed, 12.2);
  assert.equal(p.heading, 180.2);
  assert.equal(p.sats, 11);
  assert.equal(p.mode, 'Angle', 'the ANGLE box in the slow frame');
  const k = 9, m = f.mains[k]; // the main frame before this GPS frame
  assert.equal(p.volt, m[14] / 100);
  assert.equal(p.curr, m[15] / 100);
  assert.equal(p.throttle, Math.round((m[8] - 1000) / 10));
  assert.equal(p.rssi, Math.round(m[16] / 1024 * 1000) / 10);
  // time: ms from the first main frame, the GPS frame's own time
  assert.equal(log.points[0].t, (f.mains[1][1] + 37 - f.mains[0][1]) / 1000);
  assert.ok(log.points.every((q, i) => !i || q.t > log.points[i - 1].t));
});

test('positions logged without a fix are dropped (no satellites, 0,0, or the GPS_FIX state off)', () => {
  const noFix = j => j % 3 !== 0;
  const [a] = BF.readBlackboxSync(writeLog(flight({ frames: 40, fix: j => !noFix(j) }).frames));
  assert.equal(a.points.length, 4, 'fixes 0, 3, 6, 9 only');
  assert.equal(a.noFix, 6);
  // the slow frame says GPS_FIX is off: every position is dropped
  const [b] = BF.readBlackboxSync(writeLog(flight({ slow: [0b10, 0b01, 0, 1, 1] }).frames));
  assert.equal(b.points.length, 0);
  assert.equal(b.why, 'GPS never had a fix');
});

test('flight mode: from the slow frame, flight mode events and the failsafe phase', () => {
  const f = flight({ frames: 40, at: {
    10: [['E', [30, ...uvb(0b100), ...uvb(0b10)]]],                  // HORIZON
    20: [['S', [0b1, 0b11, 6, 1, 1]]],                                // failsafe phase: GPS rescue
    30: [['S', [1 << 7, 0b11, 0, 1, 1]]]                              // the GPS rescue box (4.0 to 4.5)
  } });
  const [log] = BF.readBlackboxSync(writeLog(f.frames));
  assert.deepEqual(plain(log.points.map(p => p.mode)), ['Angle', 'Angle', 'Angle', 'Horizon', 'Horizon', 'GPS Rescue', 'GPS Rescue', 'GPS Rescue', 'GPS Rescue', 'GPS Rescue']);
  const fw = v => ({ name: 'betaflight', major: v[0], minor: v[1], bfLike: true, bf4: v[0] >= 4 });
  assert.equal(BF.modeOf(fw([4, 5]), 1 << 7, 0), 'GPS Rescue');
  assert.equal(BF.modeOf(fw([2025, 12]), 1 << 10, 0), 'GPS Rescue', 'the box order after 4.5');
  assert.equal(BF.modeOf(fw([2025, 12]), 1 << 4, 0), 'Altitude hold');
  assert.equal(BF.modeOf(fw([4, 4]), 1, 0), 'Acro');
  assert.equal(BF.modeOf({ name: 'inav', major: 7, minor: 0, bfLike: false }, 2, 0), null, 'other firmware: not read');
});

test('several logs in one file: each read, with why one has no position', () => {
  const file = Buffer.concat([
    writeLog(flight({ frames: 20 }).frames, { craft: 'A' }),
    writeLog(flight({ frames: 20, noGps: true, noHome: true }).frames, { defs: Object.assign({}, DEFS, { G: null, H: null }) }), // GPS not logged
    writeLog(flight({ frames: 20, noGps: true }).frames),                                              // GPS on, no frame
    writeLog(flight({ frames: 20, fix: () => false }).frames),                                         // never a fix
    writeLog(flight({ frames: 30, lat: -33.8688, lon: 151.2093 }).frames, { craft: 'B' })
  ]);
  const logs = BF.readBlackboxSync(file);
  assert.deepEqual(plain(logs.map(l => l.index)), [1, 2, 3, 4, 5]);
  assert.deepEqual(plain(logs.map(l => l.points.length)), [5, 0, 0, 0, 8]);
  assert.deepEqual(plain(logs.map(l => l.why)), [null, 'no GPS was logged', 'no GPS frames', 'GPS never had a fix', null]);
  assert.ok(logs[4].points[0].lat < -33 && logs[4].points[0].lon > 151);
});

test('corruption: bytes between frames are skipped, P frames wait for the next I frame', () => {
  const f = flight({ frames: 40, at: { 13: [['raw', [0x01, 0x02, 0xff]]] } });
  const got = [];
  const [log] = BF.readBlackboxSync(writeLog(f.frames), v => got.push(v));
  assert.ok(log.corrupt > 0 || got.length < f.mains.length, 'the damage was noticed');
  // every frame read is right, and reading picks up again at the next I frame (iteration 28)
  got.forEach(v => assert.deepEqual(plain(v), f.mains[v[0] / 2]));
  assert.ok(got.some(v => v[0] === 28), 'read again from the next I frame');
  assert.ok(got.length >= f.mains.length - 2);
  assert.ok(log.points.length >= 9);
});

test('a log cut short, a log end marker followed by junk, and a 32-bit time that wraps', () => {
  const f = flight({ frames: 40, time0: 2 ** 32 - 5000 });
  const full = writeLog(f.frames);
  const [log] = BF.readBlackboxSync(Buffer.concat([full, Buffer.from([1, 2, 3, 0x49, 7])]));
  assert.equal(log.points.length, 10);
  assert.ok(log.points.every((q, i) => !i || q.t > log.points[i - 1].t), 'time keeps going after the wrap');
  assert.ok(log.points[9].t < 20, 'and stays in ms from the start');
  const [cut] = BF.readBlackboxSync(full.subarray(0, full.length - 120));
  assert.ok(cut.points.length >= 7 && cut.points.length < 10);
});

test('a log with its start time (the flight controller\'s clock was set) is on UTC time', () => {
  const [log] = BF.readBlackboxSync(writeLog(flight().frames, { datetime: '2024-06-01T10:00:00.000+02:00' }));
  assert.equal(log.timeBase, 'utc');
  const start = Date.UTC(2024, 5, 1, 8, 0, 0);
  assert.ok(log.points[0].t > start && log.points[0].t < start + 1000);
});

test('the reading pauses for the page and reports its progress', async () => {
  const big = writeLog(flight({ frames: 60000 }).frames);
  const seen = [];
  const t0 = Date.now();
  const logs = await BF.readBlackbox(big, f => seen.push(f));
  assert.equal(logs[0].points.length, 15000);
  assert.ok(seen.length >= 1 && seen[seen.length - 1] === 1);
  assert.ok(seen.every((f, i) => !i || f >= seen[i - 1]), 'progress only goes up');
  assert.ok(Date.now() - t0 < 20000);
});

/* ---------------------------------------------------------------- blackbox_decode's CSV */

const GPS_CSV = [
  'time (us), GPS_numSat, GPS_coord[0], GPS_coord[1], GPS_altitude, GPS_speed (m/s), GPS_ground_course',
  '1000000, 0, 0.0000000, 0.0000000, 0, 0.00, 0.0',
  '1200000, 9, 47.3977419, 8.5455938, 4321, 1.50, 90.5',
  '1400000, 9, 47.3977519, 8.5456038, 4331, 2.25, 91.0',
  '1600000, 9, 47.3977619, 8.5456138, 4341, 3.00, 92.0',
  ''
].join('\n');

test('CSV: the GPS file blackbox_decode writes (degrees, the raw altitude, m/s)', async () => {
  const res = await BF.readCsv(GPS_CSV);
  assert.equal(res.kind, 'gps');
  assert.equal(res.points.length, 3, 'the row without a fix is dropped');
  const p = res.points[1];
  assert.equal(p.lat, 47.3977519); assert.equal(p.lon, 8.5456038);
  assert.equal(p.alt, 433.1); assert.equal(p.speed, 2.25); assert.equal(p.heading, 91); assert.equal(p.sats, 9);
  assert.equal(res.points[0].t, 200, 'ms from the first row');
});

test('CSV: a main file with GPS merged in (the fix repeats on every row) and one without', async () => {
  const head = 'loopIteration, time (us), axisP[0], flightModeFlags (flags), GPS_numSat, GPS_coord[0], GPS_coord[1], GPS_altitude, GPS_speed (m/s)';
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push(`${i}, ${1000000 + i * 1000}, 3, ${i < 15 ? 'ANGLE_MODE' : 'HORIZON_MODE'}, 8, 47.39${Math.floor(i / 10)}, 8.54${Math.floor(i / 10)}, 400, 1.00`);
  const res = await BF.readCsv([head, ...rows].join('\n'));
  assert.equal(res.kind, 'main');
  assert.equal(res.points.length, 3);
  assert.deepEqual(plain(res.points.map(p => p.mode)), ['Angle', 'Angle', 'Horizon']);
  const none = await BF.readCsv('loopIteration, time (us), axisP[0]\n0, 100, 3\n');
  assert.equal(none.points.length, 0);
  assert.equal(none.kind, 'main');
  assert.match(none.why, /no GPS columns/);
  assert.equal((await BF.readCsv('a,b,c\n1,2,3\n')).kind, 'other');
});

/* ---------------------------------------------------------------- opening files */

const file = (name, bytes) => ({ name, arrayBuffer: async () => Uint8Array.from(bytes).buffer });

test('opening a log with no location warns, naming the file, and adds nothing', async () => {
  const { BF: B, added, toasts } = load();
  await B.openFiles([file('LOG00007.BFL', writeLog(flight({ fix: () => false }).frames))]);
  assert.equal(added.length, 0);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /LOG00007\.BFL/);
  assert.match(toasts[0], /no location data/);
  assert.match(toasts[0], /Nothing to show on the map/);
  assert.ok(B.notes[0].warn);
  await B.openFiles([file('btfl_001.bbl', writeLog(flight({ noGps: true }).frames))]);
  assert.match(toasts[1], /btfl_001\.bbl: no location data\./);
  await B.openFiles([file('flight.gps.csv', Buffer.from('time (us), GPS_numSat, GPS_coord[0], GPS_coord[1]\n100, 0, 0, 0\n'))]);
  assert.match(toasts[2], /flight\.gps\.csv: no location data/);
  await B.openFiles([file('notes.txt', Buffer.from('hello'))]);
  assert.match(toasts[3], /notes\.txt: not a Betaflight blackbox log/);
  assert.equal(added.length, 0);
});

test('opening a file of several logs adds each with positions and warns about the rest', async () => {
  const { BF: B, added, toasts } = load();
  const bytes = Buffer.concat([writeLog(flight().frames, { craft: 'Ranger' }), writeLog(flight({ noGps: true }).frames), writeLog(flight().frames, { datetime: '2024-06-01T10:00:00.000Z' })]);
  await B.openFiles([file('LOG00001.TXT', bytes)]);
  assert.equal(added.length, 2);
  assert.deepEqual(added.map(l => l.name), ['LOG00001.TXT · log 1', 'LOG00001.TXT · log 3']);
  assert.deepEqual(added.map(l => l.timeBase), ['relative', 'utc']);
  assert.equal(added[0].source, 'betaflight');
  assert.equal(added[0].vehicles[0].label, 'Ranger');
  assert.equal(added[1].vehicles[0].label, 'Betaflight');
  assert.ok(added[0].vehicles[0].points.length > 0);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /LOG00001\.TXT: 2 of 3 logs on the map; no location data in log 2/);
  // a GPS csv
  await B.openFiles([file('flight.gps.csv', Buffer.from(GPS_CSV))]);
  assert.equal(added.length, 3);
  assert.equal(added[2].name, 'flight.gps.csv');
  assert.equal(toasts.length, 1, 'no warning when everything is shown');
});

test('files opened while one is read wait their turn; the map goes to the last track; a cancel stops the reading', async () => {
  const { BF: B, added, toasts, zoomed } = load();
  const a = B.openFiles([file('a.bbl', writeLog(flight().frames))]);
  const b = B.openFiles([file('b.bbl', writeLog(flight({ lat: 10, lon: 20 }).frames))]);
  await Promise.all([a, b]);
  assert.deepEqual(added.map(l => l.name), ['a.bbl', 'b.bbl']);
  assert.deepEqual(plain(zoomed), ['log2']);
  assert.equal(toasts.length, 0);
  const big = writeLog(flight({ frames: 80000 }).frames);
  const run = B.openFiles([file('big.bbl', big), file('next.bbl', big)]);
  await new Promise(r => setTimeout(r, 30));
  assert.ok(B.job && B.job.name === 'big.bbl');
  B.cancel();
  await run;
  assert.equal(added.length, 2, 'nothing more added');
  assert.match(B.notes[B.notes.length - 1].text, /big\.bbl: not opened \(cancelled\)/);
  assert.equal(B.job, null);
});

test('the panel block: the progress bar is hidden when nothing is being read', () => {
  const { BF: B } = load();
  const html = B.panelHtml('', 'all');
  assert.match(html, /id="bfProgress" hidden/);
  assert.match(html, /data-act="bf-open"/);
  assert.match(html, /<div id="bfList" class="trk-list"><\/div>/, 'no log: an empty list');
  assert.equal(B.panelHtml('', 'on'), '', 'no log open: not among the enabled');
  assert.equal(B.panelHtml('weather', 'all'), '');
  assert.notEqual(B.panelHtml('blackbox', 'all'), '');
  B.job = { name: 'big.bbl', frac: 0.5 };
  assert.doesNotMatch(B.panelHtml('', 'all'), /id="bfProgress" hidden/);
});
