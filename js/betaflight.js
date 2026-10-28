/* GenGIS - Betaflight flight logs
 * - reads the blackbox logs a Betaflight flight controller records (.bbl, .bfl, and the .txt some boards name them),
 *   and the GPS .csv that blackbox_decode writes from them (or its main .csv, when GPS was merged into it)
 * - a file can hold several logs (one each time the craft was armed): each with GPS positions becomes a track
 *   (tracklogs.js draws it, colored by speed, altitude or flight mode, on the shared time bar); a log without a
 *   single position is reported when it is opened and left out, and positions logged without a GPS fix are dropped
 * - a large file is read a slice at a time, so the page keeps responding, its progress shown in the panel
 * The decoder follows the published blackbox format (Betaflight's "Blackbox logging internals"): header lines, then
 * frames I and P (the main loop), G and H (GPS and its home), S (slow state: flight mode, failsafe) and E (events).
 * Files are read on this device only; nothing is uploaded or stored.
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = s => (MB.escapeHtml ? MB.escapeHtml(s) : String(s));
  const MARKER = 'H Product:Blackbox flight data recorder';
  const ENC = { SVB: 0, UVB: 1, NEG14: 3, ELIAS_U: 4, ELIAS_S: 5, TAG8_8SVB: 6, TAG2_3S32: 7, TAG8_4S16: 8, NULL: 9, TAG2_3SVAR: 10 };
  const PRED = { ZERO: 0, PREV: 1, LINE: 2, AVG2: 3, MINTHROTTLE: 4, MOTOR0: 5, INC: 6, HOME: 7, P1500: 8, VBATREF: 9, LASTTIME: 10, MINMOTOR: 11 };
  const FRAMES = 'IPGHSE';
  const isFrame = b => b === 73 || b === 80 || b === 71 || b === 72 || b === 83 || b === 69; // I P G H S E
  const MAX_FRAME = 256;        // bytes: a longer frame is corruption
  const MAX_JUMP = 10e6;        // us: an I frame further than this from the last main frame is corruption
  const SLICE_MS = 12;          // ms of reading between pauses for the page
  const sx = (v, bits) => (v << (32 - bits)) >> (32 - bits); // sign-extend the low `bits` bits
  class Truncated extends Error {}
  class Cancelled extends Error { constructor() { super('Cancelled'); } }
  const END = new Truncated('end of data');

  /* ---------- the byte stream: the format's encodings ---------- */
  class Stream {
    constructor(b, p, end) { this.b = b; this.p = p || 0; this.end = end == null ? b.length : end; }
    u8() { if (this.p >= this.end) throw END; return this.b[this.p++]; }
    // unsigned variable byte: 7 bits a byte, least significant first, the top bit set while more follow (5 at most)
    uvb() {
      let v = 0, mul = 1;
      for (let i = 0; i < 5; i++) {
        const c = this.u8();
        v += (c & 0x7f) * mul;
        if (c < 0x80) return v >>> 0;
        mul *= 128;
      }
      return 0; // too long: not a value (the frame fails its checks)
    }
    svb() { const u = this.uvb(); return (u >>> 1) ^ -(u & 1); } // zigzag
    neg14() { const w = this.uvb() & 0x3fff; return -sx(w, 14) | 0; }
    // up to 8 fields: a byte with a bit set for each field that is not zero, then those as signed VB (one field: no byte)
    tag8_8svb(out, n) {
      if (n === 1) { out[0] = this.svb(); return; }
      const h = this.u8();
      for (let i = 0; i < n; i++) out[i] = h & (1 << i) ? this.svb() : 0;
    }
    // 3 fields, their width in the lead byte's top 2 bits: 2, 4 or 6 bits each, or 1 to 4 bytes each
    tag2_3s32(out) {
      const lead = this.u8();
      switch (lead >> 6) {
        case 0: out[0] = sx(lead >> 4 & 3, 2); out[1] = sx(lead >> 2 & 3, 2); out[2] = sx(lead & 3, 2); break;
        case 1: { out[0] = sx(lead & 15, 4); const b = this.u8(); out[1] = sx(b >> 4, 4); out[2] = sx(b & 15, 4); break; }
        case 2: out[0] = sx(lead & 63, 6); out[1] = sx(this.u8() & 63, 6); out[2] = sx(this.u8() & 63, 6); break;
        default: this.sized3(out, lead);
      }
    }
    // the same with 2, 5-5-4 or 8-7-7 bit fields
    tag2_3svar(out) {
      const lead = this.u8();
      switch (lead >> 6) {
        case 0: out[0] = sx(lead >> 4 & 3, 2); out[1] = sx(lead >> 2 & 3, 2); out[2] = sx(lead & 3, 2); break;
        case 1: { out[0] = sx(lead >> 1 & 31, 5); const b = this.u8(); out[1] = sx((lead & 1) << 4 | b >> 4, 5); out[2] = sx(b & 15, 4); break; }
        case 2: {
          const b1 = this.u8(), b2 = this.u8();
          out[0] = sx((lead & 63) << 2 | b1 >> 6, 8); out[1] = sx((b1 & 63) << 1 | b2 >> 7, 7); out[2] = sx(b2 & 127, 7);
          break;
        }
        default: this.sized3(out, lead);
      }
    }
    // 3 fields of 1 to 4 bytes each (little-endian), their sizes 2 bits each in the lead byte, the first field lowest
    sized3(out, lead) {
      for (let i = 0, s = lead; i < 3; i++, s >>= 2) {
        const n = (s & 3) + 1;
        let v = 0;
        for (let k = 0; k < n; k++) v |= this.u8() << (8 * k);
        out[i] = n === 4 ? v | 0 : sx(v, 8 * n);
      }
    }
    // 4 fields, 2 bits each in a lead byte (the first field lowest): zero, 4, 8 or 16 bits, packed in nibbles with
    // the most significant first (data version 2); version 1 kept each value in whole bytes
    tag8_4s16(out, v1) {
      const sel = this.u8();
      if (v1) {
        for (let i = 0, s = sel; i < 4; i++, s >>= 2) {
          switch (s & 3) {
            case 0: out[i] = 0; break;
            case 1: { const c = this.u8(); out[i] = sx(c & 15, 4); if (i < 3) { i++; s >>= 2; out[i] = sx(c >> 4, 4); } break; }
            case 2: out[i] = sx(this.u8(), 8); break;
            default: { const lo = this.u8(); out[i] = sx(lo | this.u8() << 8, 16); }
          }
        }
        return;
      }
      let half = false, buf = 0; // half: the low nibble of buf is still to be read
      for (let i = 0, s = sel; i < 4; i++, s >>= 2) {
        switch (s & 3) {
          case 0: out[i] = 0; break;
          case 1:
            if (!half) { buf = this.u8(); out[i] = sx(buf >> 4, 4); half = true; } else { out[i] = sx(buf & 15, 4); half = false; }
            break;
          case 2:
            if (!half) out[i] = sx(this.u8(), 8);
            else { const hi = (buf & 15) << 4; buf = this.u8(); out[i] = sx(hi | buf >> 4, 8); }
            break;
          default:
            if (!half) { const hi = this.u8(); out[i] = sx(hi << 8 | this.u8(), 16); } else {
              const n1 = (buf & 15) << 4; buf = this.u8(); const b1 = n1 | buf >> 4;
              const n2 = (buf & 15) << 4; buf = this.u8(); const b2 = n2 | buf >> 4;
              out[i] = sx(b1 << 8 | b2, 16);
            }
        }
      }
    }
  }

  /* ---------- header ---------- */
  // Where each log in the file starts (its first header line).
  function findLogs(b) {
    const m = Array.from(MARKER, c => c.charCodeAt(0)), starts = [];
    for (let i = b.indexOf(72); i >= 0 && i <= b.length - m.length; i = b.indexOf(72, i + 1)) {
      let k = 1;
      while (k < m.length && b[i + k] === m[k]) k++;
      if (k === m.length) { starts.push(i); i += m.length - 1; }
    }
    return starts;
  }

  // The "H name:value" lines from p on: { headers, pos (the first byte after them) }.
  function readHeaders(b, p, end) {
    const headers = {};
    while (p + 2 < end && b[p] === 72 && b[p + 1] === 32) {
      let q = p + 2, colon = -1;
      const lim = Math.min(end, p + 4096);
      while (q < lim && b[q] !== 10) { if (colon < 0 && b[q] === 58) colon = q; if (b[q] < 32 && b[q] !== 9 && b[q] !== 13) break; q++; }
      if (q >= lim || b[q] !== 10 || colon < 0) break; // not a header line: the frames start here
      const name = text(b, p + 2, colon), value = text(b, colon + 1, q).replace(/\r$/, '');
      headers[name] = value;
      p = q + 1;
    }
    return { headers, pos: p };
  }
  function text(b, s, e) { let t = ''; for (let i = s; i < e; i++) t += String.fromCharCode(b[i]); return t; }
  const nums = s => (s == null || s === '' ? [] : s.split(',').map(x => parseInt(x, 10) || 0));

  // The firmware: { name, major, minor, bfLike, bf4 }.
  function firmwareOf(h) {
    const rev = h['Firmware revision'] || '', m = /^\s*([A-Za-z]+)\s+(\d+)\.(\d+)/.exec(rev);
    const name = m ? m[1].toLowerCase() : (h['Firmware type'] || '').toLowerCase();
    const major = m ? +m[2] : 0, minor = m ? +m[3] : 0;
    const bfLike = ['betaflight', 'emuflight', 'rotorflight'].includes(name);
    return { name, major, minor, bfLike, bf4: bfLike && (name !== 'betaflight' || major >= 4) };
  }

  // A frame type's fields from the header: names, signed, predictor, encoding, and the extra each predictor needs.
  function frameDef(h, t) {
    const names = (h['Field ' + t + ' name'] || h[t === 'P' ? 'Field I name' : ''] || '').split(',').filter(Boolean);
    if (!names.length) return null;
    const signed = nums(h['Field ' + t + ' signed'] || (t === 'P' ? h['Field I signed'] : ''));
    const pred = nums(h['Field ' + t + ' predictor']), enc = nums(h['Field ' + t + ' encoding']);
    const n = names.length, home = [];
    let homes = 0;
    for (let i = 0; i < n; i++) {
      if ((pred[i] || 0) !== PRED.HOME) continue;
      const k = /\[(\d)\]$/.exec(names[i]);
      home[i] = k ? +k[1] : homes;
      homes++;
    }
    return { t, names, n, signed: names.map((x, i) => !!signed[i]), pred: names.map((x, i) => pred[i] || 0), enc: names.map((x, i) => (enc[i] == null ? ENC.SVB : enc[i])), home, idx: name => names.indexOf(name) };
  }

  /* ---------- one log: frames to GPS points ---------- */
  // Betaflight logs the switches' modes (its box ids) as flightModeFlags; their order changed after 4.5.
  const BOXES_45 = { angle: 1, horizon: 2, failsafe: 6, rescue: 7 };
  const BOXES_46 = { angle: 1, horizon: 2, althold: 4, failsafe: 8, poshold: 9, rescue: 10, autopilot: 11 };
  function modeOf(fw, mask, phase) {
    if (!fw.bfLike) return null; // other firmware: its own mode list, not read
    if (phase === 6) return 'GPS Rescue';
    if (phase === 7) return 'Autopilot';
    if (phase >= 1 && phase <= 3) return 'Failsafe';
    if (fw.name !== 'betaflight' || fw.major < 4 || mask == null) return null; // (the box order of forks and of 3.x: not read)
    const B = fw.major > 4 || fw.minor >= 6 ? BOXES_46 : BOXES_45, on = k => B[k] != null && mask & (1 << B[k]);
    if (on('rescue')) return 'GPS Rescue';
    if (on('failsafe')) return 'Failsafe';
    if (on('autopilot')) return 'Autopilot';
    if (on('poshold')) return 'Position hold';
    if (on('althold')) return 'Altitude hold';
    if (on('angle')) return 'Angle';
    if (on('horizon')) return 'Horizon';
    return 'Acro';
  }

  class LogReader {
    constructor(b, start, end, onMain) {
      const { headers: h, pos } = readHeaders(b, start, end);
      this.onMain = onMain || null; // (each main frame's values as read: the tests)
      this.h = h; this.s = new Stream(b, pos, end);
      this.fw = firmwareOf(h);
      this.v1 = (parseInt(h['Data version'], 10) || 2) < 2;
      this.defs = { I: frameDef(h, 'I'), P: frameDef(h, 'P'), G: frameDef(h, 'G'), H: frameDef(h, 'H'), S: frameDef(h, 'S') };
      this.error = null;
      if (!this.defs.I) this.error = 'no field definitions in its header';
      for (const t of 'IPGHS') {
        const d = this.defs[t];
        if (d && d.enc.some(e => e === ENC.ELIAS_U || e === ENC.ELIAS_S)) this.error = 'it uses the Elias delta encoding, which is not supported';
      }
      const mo = nums(h.motorOutput);
      this.k = { minthrottle: parseInt(h.minthrottle, 10) || 0, vbatref: parseInt(h.vbatref, 10) || 0, minmotor: mo[0] || 0 };
      const iv = parseInt(h['I interval'], 10) || 1, pi = /^(\d+)(?:\/(\d+))?$/.exec((h['P interval'] || '').trim());
      this.iInterval = Math.max(1, iv);
      this.pNum = pi ? (pi[2] ? +pi[1] : 1) : 1; this.pDenom = pi ? (pi[2] ? +pi[2] : +pi[1]) : 1;
      if (!(this.pNum > 0 && this.pDenom > 0)) this.pNum = this.pDenom = 1;
      const I = this.defs.I || { idx: () => -1, n: 0 }, G = this.defs.G || { idx: () => -1, n: 0 }, S = this.defs.S || { idx: () => -1 }, H = this.defs.H || { idx: () => -1 };
      this.ix = {
        iter: I.idx('loopIteration'), time: I.idx('time'), motor0: I.idx('motor[0]'),
        vbat: I.idx('vbatLatest'), amp: I.idx('amperageLatest'), rssi: I.idx('rssi'), thr: I.idx('rcCommand[3]'),
        gTime: G.idx('time'), sats: G.idx('GPS_numSat'), lat: G.idx('GPS_coord[0]'), lon: G.idx('GPS_coord[1]'), alt: G.idx('GPS_altitude'),
        speed: G.idx('GPS_speed'), course: G.idx('GPS_ground_course'), velD: G.idx('GPS_velned[2]'),
        home0: H.idx('GPS_home[0]'), home1: H.idx('GPS_home[1]'),
        flags: S.idx('flightModeFlags'), state: S.idx('stateFlags'), phase: S.idx('failsafePhase')
      };
      const n = Math.max(I.n, 1);
      this.cur = new Array(n).fill(0); this.prev = null; this.prev2 = null;
      this.gCur = new Array(G.n || 1).fill(0); this.gPrev = null;
      this.tmp = new Array(8).fill(0);
      this.home = [0, 0];
      this.mainValid = false; this.resumed = false; this.lastTime = null; this.lastIter = -1; this.rejectedI = null;
      this.main = null; // the last main frame's values the points carry: { volt, curr, rssi, throttle }
      this.mask = null; this.phase = 0; this.state = null;
      this.timeHi = 0; this.rawLast = null; this.t0 = null;
      this.points = []; this.frames = 0; this.corrupt = 0; this.gFrames = 0; this.gNoFix = 0; this.ended = false;
      const dt = Date.parse(h['Log start datetime'] || '');
      this.startUtc = isFinite(dt) && new Date(dt).getUTCFullYear() >= 2010 ? dt : null;
    }

    // A main frame read becomes the last one (an I frame: the last two); the array no longer needed is read into next.
    accept(out, intra) {
      const free = intra ? this.prev : this.prev2 !== this.prev ? this.prev2 : null;
      if (intra) this.prev = this.prev2 = out; else { this.prev2 = this.prev; this.prev = out; }
      this.cur = free && free !== this.prev && free !== this.prev2 ? free : new Array(out.length).fill(0);
    }

    // One frame's values into `out`, from the stream: the encoded deltas plus each field's prediction.
    decode(def, out, prev, prev2, skipped) {
      const s = this.s, n = def.n, enc = def.enc, tmp = this.tmp;
      let i = 0;
      while (i < n) {
        const e = enc[i];
        let k = 1;
        switch (e) {
          case ENC.SVB: tmp[0] = s.svb(); break;
          case ENC.UVB: tmp[0] = s.uvb(); break;
          case ENC.NEG14: tmp[0] = s.neg14(); break;
          case ENC.NULL: tmp[0] = 0; break;
          case ENC.TAG8_8SVB: while (i + k < n && k < 8 && enc[i + k] === ENC.TAG8_8SVB) k++; s.tag8_8svb(tmp, k); break;
          case ENC.TAG2_3S32: s.tag2_3s32(tmp); k = 3; break;
          case ENC.TAG2_3SVAR: s.tag2_3svar(tmp); k = 3; break;
          case ENC.TAG8_4S16: s.tag8_4s16(tmp, this.v1); k = 4; break;
          default: throw new Error('it uses an unknown field encoding (' + e + ')');
        }
        for (let j = 0; j < k && i < n; j++, i++) out[i] = this.predict(def, i, tmp[j], out, prev, prev2, skipped);
      }
    }

    predict(def, i, raw, cur, prev, prev2, skipped) {
      let p = 0;
      switch (def.pred[i]) {
        case PRED.ZERO: break;
        case PRED.PREV: p = prev ? prev[i] : 0; break;
        case PRED.LINE: p = prev ? (prev2 ? 2 * prev[i] - prev2[i] : prev[i]) : 0; break;
        case PRED.AVG2: p = prev ? (prev2 ? (def.signed[i] ? Math.trunc((prev[i] + prev2[i]) / 2) : Math.floor((prev[i] + prev2[i]) / 2)) : prev[i]) : 0; break;
        case PRED.MINTHROTTLE: p = this.k.minthrottle; break;
        case PRED.MOTOR0: p = this.ix.motor0 >= 0 && this.ix.motor0 < i ? cur[this.ix.motor0] : 0; break;
        case PRED.INC: p = (prev ? prev[i] : 0) + skipped + 1; break;
        case PRED.HOME: p = this.home[def.home[i]] || 0; break;
        case PRED.P1500: p = 1500; break;
        case PRED.VBATREF: p = this.k.vbatref; break;
        case PRED.LASTTIME: p = this.lastTime == null ? 0 : this.lastTime; break;
        case PRED.MINMOTOR: p = this.k.minmotor; break;
        default: throw new Error('it uses an unknown predictor (' + def.pred[i] + ')');
      }
      const v = raw + p;
      return def.signed[i] ? v | 0 : v >>> 0;
    }

    // Main loop iterations the logging rate leaves out after the last main frame (the INC predictor counts them).
    skipped() {
      if (this.lastIter < 0) return 0;
      let n = 0;
      for (let it = this.lastIter + 1; n < 1024; it++, n++) {
        const k = it % this.iInterval;
        if (k === 0 || (k + this.pNum - 1) % this.pDenom < this.pNum) break;
      }
      return n;
    }

    // Read frames for about `ms` milliseconds; true once the log is read to its end.
    step(ms) {
      const s = this.s, b = s.b, t0 = now();
      let count = 0;
      while (s.p < s.end && !this.ended) {
        if ((++count & 255) === 0 && now() - t0 > ms) return false;
        const start = s.p, type = b[s.p];
        if (!isFrame(type)) { s.p++; this.mainValid = false; continue; } // between frames: corruption, skipped
        s.p++;
        let res;
        try { res = this.frame(type); } catch (e) {
          if (e instanceof Truncated) { s.p = s.end; break; } // the last frame was cut short
          throw e;
        }
        const next = s.p < s.end ? b[s.p] : -1;
        if (res === false || s.p - start > MAX_FRAME || (next !== -1 && !isFrame(next) && !this.ended)) {
          s.p = start + 1; this.corrupt++;
          if (type === 73 || type === 80) this.mainValid = false;
          this.ended = false;
          continue;
        }
        if (res) res();
        this.frames++;
      }
      return true;
    }

    // Reads one frame of the given type. Returns what accepts it (run once the bytes after it look right), null when it
    // is read but not used, or false when it cannot be right.
    frame(type) {
      const d = this.defs;
      switch (type) {
        case 73: { // I: every value whole
          const out = this.cur;
          this.decode(d.I, out, null, null, 0);
          const time = this.ix.time >= 0 ? out[this.ix.time] : null;
          if (time != null && this.lastTime != null && !this.resumed) {
            const dt = (time - this.lastTime) | 0;
            if (dt < -1e6 || dt > MAX_JUMP) { // too far from the last frame; two such frames in a row are a real jump
              const r = this.rejectedI, ok = r != null && ((time - r) | 0) >= 0 && ((time - r) | 0) <= MAX_JUMP;
              this.rejectedI = time;
              if (!ok) return false;
            }
          }
          return () => { this.accept(out, true); this.mainValid = true; this.resumed = false; this.rejectedI = null; this.mainFrame(out); };
        }
        case 80: { // P: deltas from the frames before
          if (!d.P) return false;
          const out = this.cur;
          this.decode(d.P, out, this.prev, this.prev2, this.skipped());
          if (!this.mainValid || !this.prev) return null; // after corruption: no frame to build on until the next I frame
          return () => { this.accept(out, false); this.mainFrame(out); };
        }
        case 71: { // G: a GPS fix, its position from the home in the last H frame
          if (!d.G) return false;
          const out = this.gCur;
          this.decode(d.G, out, this.gPrev, null, 0);
          return () => { this.gCur = this.gPrev || new Array(out.length).fill(0); this.gPrev = out; this.gpsFrame(out); };
        }
        case 72: { // H: the GPS home
          if (!d.H) return false;
          const out = new Array(d.H.n).fill(0);
          this.decode(d.H, out, null, null, 0);
          return () => { this.home = [this.ix.home0 >= 0 ? out[this.ix.home0] : 0, this.ix.home1 >= 0 ? out[this.ix.home1] : 0]; };
        }
        case 83: { // S: flight mode, state and failsafe
          if (!d.S) return false;
          const out = new Array(d.S.n).fill(0);
          this.decode(d.S, out, null, null, 0);
          return () => {
            if (this.ix.flags >= 0) this.mask = out[this.ix.flags];
            if (this.ix.state >= 0) this.state = out[this.ix.state];
            if (this.ix.phase >= 0) this.phase = out[this.ix.phase];
          };
        }
        case 69: return this.event();
      }
      return false;
    }

    event() {
      const s = this.s, kind = s.u8();
      switch (kind) {
        case 0: s.uvb(); return null; // sync beep
        case 13: { const f = s.u8(); if (f & 128) { s.u8(); s.u8(); s.u8(); s.u8(); } else s.svb(); return null; } // in-flight adjustment
        case 14: { // logging resumed: the next main frame is an I frame, after a gap
          const iter = s.uvb(), time = s.uvb();
          return () => { this.lastIter = iter; this.lastTime = time; this.mainValid = false; this.resumed = true; };
        }
        case 15: s.uvb(); return null; // disarm
        case 30: { const flags = s.uvb(); s.uvb(); return () => { this.mask = flags; }; } // flight mode (the new modes, then the old)
        case 255: { // end of log: "End of log" and a zero byte
          const tail = 'End of log';
          for (let i = 0; i < tail.length; i++) if (s.u8() !== tail.charCodeAt(i)) return false;
          if (s.p < s.end && s.b[s.p] === 0) s.p++;
          this.ended = true;
          return null;
        }
      }
      return false; // an event this reader does not know: its length is unknown
    }

    // The time on one line from the log's first main frame (the logged time is 32 bits of microseconds and wraps).
    us(raw) {
      if (this.rawLast != null) {
        const d = raw - this.rawLast;
        if (d < -0x80000000) this.timeHi += 0x100000000; // wrapped
        else if (d > 0x80000000) return this.timeHi - 0x100000000 + raw; // from just before the wrap
      }
      this.rawLast = raw;
      return this.timeHi + raw;
    }

    mainFrame(v) {
      const ix = this.ix;
      if (ix.iter >= 0) this.lastIter = v[ix.iter];
      if (ix.time >= 0) { this.lastTime = v[ix.time]; const t = this.us(v[ix.time]); if (this.t0 == null) this.t0 = t; }
      if (this.onMain) this.onMain(v.slice());
      const fw = this.fw;
      this.main = {
        volt: ix.vbat >= 0 && fw.bf4 ? v[ix.vbat] / 100 : null,
        curr: ix.amp >= 0 && fw.bf4 ? v[ix.amp] / 100 : null,
        rssi: ix.rssi >= 0 ? Math.round(v[ix.rssi] / 1024 * 1000) / 10 : null,
        throttle: ix.thr >= 0 && fw.bfLike ? Math.max(0, Math.min(100, Math.round((v[ix.thr] - 1000) / 10))) : null
      };
    }

    gpsFrame(g) {
      const ix = this.ix, fw = this.fw;
      this.gFrames++;
      if (this.lastTime == null || this.t0 == null || ix.lat < 0 || ix.lon < 0) return;
      const lat = g[ix.lat] / 1e7, lon = g[ix.lon] / 1e7, sats = ix.sats >= 0 ? g[ix.sats] : null;
      const noFix = (fw.bfLike && this.state != null && !(this.state & 2)) || sats === 0; // stateFlags bit 1: GPS_FIX
      if (noFix || !validLL(lat, lon)) { this.gNoFix++; return; }
      const raw = ix.gTime >= 0 ? g[ix.gTime] : this.lastTime;
      const ms = (this.us(raw) - this.t0) / 1000;
      if (this.points.length && ms < this.points[this.points.length - 1].t) return; // out of order: corruption
      // altitude: decimeters since Betaflight 4, centimeters before; other firmware logs meters
      const altScale = fw.bf4 ? 0.1 : fw.bfLike ? 0.01 : 1;
      const p = { t: ms, lat, lon, alt: ix.alt >= 0 ? (g[ix.alt] | 0) * altScale : null, altRef: 'msl',
        speed: ix.speed >= 0 ? g[ix.speed] / 100 : null, mode: modeOf(fw, this.mask, this.phase) };
      if (sats != null) p.sats = sats;
      if (ix.course >= 0) p.heading = g[ix.course] / 10;
      if (ix.velD >= 0) p.climb = -g[ix.velD] / 100;
      const m = this.main;
      if (m) for (const k in m) if (m[k] != null) p[k] = m[k];
      this.points.push(p);
    }

    result() {
      const h = this.h, why = this.error ? 'could not be read: ' + this.error
        : !this.defs.G ? 'no GPS was logged' : !this.gFrames ? 'no GPS frames' : !this.points.length ? 'GPS never had a fix' : null;
      return {
        points: this.points, craft: (h['Craft name'] || '').trim(), firmware: (h['Firmware revision'] || '').trim(),
        timeBase: this.startUtc != null ? 'utc' : 'relative', start: this.startUtc, frames: this.frames, corrupt: this.corrupt,
        gpsFrames: this.gFrames, noFix: this.gNoFix, why
      };
    }
  }

  const validLL = (lat, lon) => isFinite(lat) && isFinite(lon) && !(lat === 0 && lon === 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const pause = () => new Promise(r => setTimeout(r, 0));

  // Every log in a blackbox file: [{ index (1-based), points, craft, firmware, timeBase, start, why (no points: why not) }].
  // onProgress(fraction) as it goes; the page gets a moment between slices, and isCancelled() can stop it there.
  async function readBlackbox(bytes, onProgress, isCancelled) {
    const starts = findLogs(bytes), logs = [];
    for (let k = 0; k < starts.length; k++) {
      const end = k + 1 < starts.length ? starts[k + 1] : bytes.length, r = new LogReader(bytes, starts[k], end);
      if (!r.error) {
        try {
          while (!r.step(SLICE_MS)) { if (onProgress) onProgress(r.s.p / bytes.length); await pause(); if (isCancelled && isCancelled()) throw new Cancelled(); }
        } catch (e) { if (e instanceof Cancelled) throw e; r.error = e.message; }
      }
      logs.push(done(r, k));
      if (onProgress) onProgress(end / bytes.length);
    }
    return logs;
  }
  // The same in one go (tests, small files); onMain(values) with each main frame read.
  function readBlackboxSync(bytes, onMain) {
    return findLogs(bytes).map((s, k, all) => {
      const r = new LogReader(bytes, s, k + 1 < all.length ? all[k + 1] : bytes.length, onMain);
      if (!r.error) { try { r.step(Infinity); } catch (e) { r.error = e.message; } }
      return done(r, k);
    });
  }
  function done(r, k) {
    const res = r.result();
    res.index = k + 1;
    if (res.timeBase === 'utc') res.points.forEach(p => { p.t += r.startUtc; });
    return res;
  }

  /* ---------- blackbox_decode's CSV ---------- */
  // The GPS .csv (time, GPS_numSat, GPS_coord[0], GPS_coord[1], GPS_altitude, GPS_speed...), or a main .csv with GPS
  // merged in. Returns { points, kind: 'gps' | 'main' | 'other', why }. Rows that repeat the last position are left out.
  async function readCsv(textIn, onProgress, isCancelled) {
    const first = textIn.indexOf('\n');
    const head = (first < 0 ? textIn : textIn.slice(0, first)).split(',').map(c => c.trim()); // (trim drops a byte order mark too)
    const col = {}, unit = {};
    head.forEach((c, i) => { const m = /^(.*?)\s*(?:\(([^)]*)\))?$/.exec(c); col[m[1]] = i; unit[m[1]] = (m[2] || '').toLowerCase(); });
    const has = k => col[k] != null;
    const blackbox = has('loopIteration') || Object.keys(col).some(k => /^GPS_/.test(k));
    if (!has('GPS_coord[0]') || !has('GPS_coord[1]')) {
      return { points: [], kind: blackbox ? 'main' : 'other', why: blackbox ? 'no GPS columns (blackbox_decode writes positions to the .gps.csv file)' : 'not a blackbox_decode CSV' };
    }
    const tScale = { us: 1e-3, ms: 1, s: 1000 }[unit.time] || 1e-3;
    const aScale = { m: 1, cm: 0.01, ft: 0.3048, dm: 0.1 }[unit.GPS_altitude] || 0.1; // no unit: the raw value, decimeters since Betaflight 4
    const sScale = { 'm/s': 1, 'km/h': 1 / 3.6, kph: 1 / 3.6, 'mi/h': 0.44704, mph: 0.44704 }[unit.GPS_speed] || 0.01; // raw: cm/s
    const coord = v => (Math.abs(v) > 180 ? v / 1e7 : v);
    const num = (r, k) => { if (!has(k)) return null; const v = parseFloat(r[col[k]]); return isFinite(v) ? v : null; };
    const points = [];
    let p = first < 0 ? textIn.length : first + 1, t0 = null, last = null, noFix = 0, rows = 0, tick = now();
    while (p < textIn.length) {
      let e = textIn.indexOf('\n', p);
      if (e < 0) e = textIn.length;
      const line = textIn.slice(p, e);
      p = e + 1;
      if (!line.trim()) continue;
      rows++;
      if ((rows & 1023) === 0 && now() - tick > SLICE_MS) { if (onProgress) onProgress(p / textIn.length); await pause(); tick = now(); if (isCancelled && isCancelled()) throw new Cancelled(); }
      const r = line.split(',');
      const lat = coord(num(r, 'GPS_coord[0]')), lon = coord(num(r, 'GPS_coord[1]')), sats = num(r, 'GPS_numSat');
      let t = num(r, 'time');
      if (t == null) continue;
      t *= tScale;
      if (t0 == null) t0 = t;
      if (lat == null || lon == null || sats === 0 || !validLL(lat, lon)) { noFix++; continue; }
      const alt = num(r, 'GPS_altitude'), speed = num(r, 'GPS_speed');
      if (last && last.lat === lat && last.lon === lon && last.rawAlt === alt) continue; // a merged main .csv repeats the fix on every row
      const pt = { t: t - t0, lat, lon, alt: alt == null ? null : alt * aScale, altRef: 'msl', speed: speed == null ? null : speed * sScale, mode: csvMode(r[col.flightModeFlags], r[col.failsafePhase]) };
      if (sats != null) pt.sats = sats;
      const c = num(r, 'GPS_ground_course');
      if (c != null) pt.heading = unit.GPS_ground_course || /\./.test(r[col.GPS_ground_course]) ? c : c / 10;
      const v = num(r, 'vbatLatest'); if (v != null && unit.vbatLatest === 'v') pt.volt = v;
      const a = num(r, 'amperageLatest'); if (a != null && unit.amperageLatest === 'a') pt.curr = a;
      if (pt.t < (points.length ? points[points.length - 1].t : -Infinity)) continue;
      points.push(pt);
      last = { lat, lon, rawAlt: alt };
    }
    return { points, kind: has('loopIteration') ? 'main' : 'gps', why: points.length ? null : noFix ? 'GPS never had a fix' : 'no GPS rows' };
  }
  // A flight mode from blackbox_decode's flag names (ANGLE_MODE|..., or a failsafe phase name), when it wrote them.
  function csvMode(flags, phase) {
    const ph = String(phase || '').toUpperCase(), f = String(flags || '').toUpperCase();
    if (/RESCUE/.test(ph) || /RESCUE/.test(f)) return 'GPS Rescue';
    if (/LANDING|LANDED|RX_LOSS_DETECTED/.test(ph) || /FAILSAFE/.test(f)) return 'Failsafe';
    if (flags == null || /^\s*\d*\s*$/.test(f)) return null;
    if (/ANGLE/.test(f)) return 'Angle';
    if (/HORIZON/.test(f)) return 'Horizon';
    return 'Acro';
  }

  /* ---------- module: files in, tracks out ---------- */
  const LOG_EXT = /\.(bbl|bfl|txt)$/i;
  MB.betaflight = {
    Stream, LogReader, findLogs, readHeaders, readBlackbox, readBlackboxSync, readCsv, modeOf,
    job: null,       // the file being read: { name, frac, cancelled }
    queue: [],       // files waiting their turn
    notes: [],       // what the files opened came to: [{ text, warn }]

    isLogFile(f) { return /\.(bbl|bfl)$/i.test(f.name) || /\.gps\.csv$/i.test(f.name); }, // (dropped on the map; .txt and .csv only through the panel)

    // Read the files one after the other; each log with positions goes to the map. What had no position is told in
    // the panel, and in a message once the last file is read.
    async openFiles(files) {
      const list = Array.from(files || []);
      if (!list.length) return;
      this.queue.push(...list);
      if (this.job) return; // (the file being read takes these in turn)
      const from = this.notes.length;
      let last = null;
      if (MB.busy) MB.busy.set('betaflight', 'Betaflight log');
      while (this.queue.length) {
        const f = this.queue.shift(), job = this.job = { name: f.name, frac: 0, cancelled: false };
        this.tick();
        try { last = (await this.openFile(f, job)) || last; } catch (e) {
          if (e instanceof Cancelled) this.note(f.name + ': not opened (cancelled).', false);
          else this.note(f.name + ': could not be read (' + (e.message || e) + ').', true);
        }
      }
      this.job = null;
      if (MB.busy) MB.busy.clear('betaflight');
      this.tick();
      if (last && MB.trackLogs.zoomTo) MB.trackLogs.zoomTo(last);
      const warn = this.notes.slice(from).filter(n => n.warn);
      if (warn.length) MB.toast(warn.length === 1 ? warn[0].text : warn.length + ' files with no location data in some or all of their logs: see Betaflight logs in the Data panel.', 6000);
    },
    cancel() { if (this.job) this.job.cancelled = true; this.queue = []; },

    // One file: its logs with positions to the map. Returns the id of the last one added.
    async openFile(f, job) {
      const progress = frac => { job.frac = frac; this.tick(); }, cancelled = () => job.cancelled;
      const buf = new Uint8Array(await f.arrayBuffer());
      if (!findLogs(buf).length) {
        if (!/\.(csv|txt)$/i.test(f.name)) { this.note(f.name + ': not a blackbox log.', true); return null; }
        const res = await readCsv(new TextDecoder().decode(buf), progress, cancelled);
        if (res.kind === 'other') { this.note(f.name + ': not a Betaflight blackbox log or blackbox_decode CSV.', true); return null; }
        return this.addLog(f.name, res.points, 'relative', '', res.why);
      }
      const logs = await readBlackbox(buf, progress, cancelled), many = logs.length > 1;
      const ids = logs.map(l => this.addLog(many ? `${f.name} · log ${l.index}` : f.name, l.points, l.timeBase, l.craft, l.why, many));
      const shown = logs.filter((l, i) => ids[i]).map(l => l.index), left = logs.filter((l, i) => !ids[i]).map(l => l.index);
      if (many) {
        if (!shown.length) this.note(`${f.name}: no location data in any of its ${logs.length} logs. Nothing to show on the map.`, true);
        else if (left.length) this.note(`${f.name}: ${shown.length} of ${logs.length} logs on the map; no location data in log${left.length > 1 ? 's' : ''} ${left.join(', ')}.`, true);
        else this.note(`${f.name}: ${shown.length} logs on the map.`, false);
      }
      return ids.filter(Boolean).pop() || null;
    },

    // One log to the map: its id, or null (and a warning, unless the file's other logs are told of together) when it
    // has no position.
    addLog(name, points, timeBase, craft, why, quiet) {
      const id = points.length && MB.trackLogs ? MB.trackLogs.add({ source: 'betaflight', name, timeBase,
        vehicles: [{ key: 'fc', label: craft || 'Betaflight', points }] }) : null;
      if (!id) {
        if (!quiet) this.note(`${name}: no location data${why && why !== 'no GPS frames' ? ' (' + why + ')' : ''}. Nothing to show on the map.`, true);
        return null;
      }
      if (!quiet) this.note(`${name}: ${points.length.toLocaleString()} points on the map.`, false);
      return id;
    },

    note(text, warn) { this.notes.push({ text, warn: !!warn }); this.notes = this.notes.slice(-20); this.tick(); },

    /* ---------- the panel (datalayers.js draws it under the MAVLink block) ---------- */
    count() { return MB.trackLogs ? MB.trackLogs.list('betaflight').length : 0; },
    countText() { const n = this.count(); return n ? n + ' log' + (n > 1 ? 's' : '') : 'none open'; },
    notesHtml() {
      return this.notes.slice(-3).map(n => `<div class="dstatus${n.warn ? ' err' : ''}">${esc(n.text)}</div>`).join('');
    },
    matches(q, filter) {
      const on = this.count() > 0;
      if (filter === 'on' && !on) return false;
      if (filter === 'off' && on) return false;
      return !q || 'betaflight blackbox flight logs bbl bfl fpv gps csv blackbox_decode'.includes(q);
    },

    panelHtml(q, filter) {
      if (!this.matches(q, filter)) return '';
      const job = this.job;
      return `<details class="ds-source" id="bfSource" data-src="betaflight"${MB.data.sourceOpen('betaflight') ? ' open' : ''}><summary class="ds-source-head"><h3>Betaflight logs</h3><span class="badge" id="bfCount">${esc(this.countText())}</span></summary>
        <div class="section"><div class="data-item adsb-display" id="bfItem">
          <div class="ds-head"><button type="button" class="btn small with-icon" data-act="bf-open">${MB.ICON.open.replace('<svg ', '<svg class="mi" ')}Open logs</button><span class="dim trk-kinds">.bbl · .bfl · .txt · .csv</span>${MB.data.infoIcon('Blackbox logs from a Betaflight flight controller with a GPS (.bbl, .bfl, or .txt on some boards; one file can hold several flights), or the .gps.csv that blackbox_decode writes. Each flight with GPS positions is a track; positions without a fix are left out. Read on this device only.')}</div>
          <div class="trk-progress" id="bfProgress"${job ? '' : ' hidden'}><div class="progress"><div class="bar" style="width:${job ? Math.round(job.frac * 100) : 0}%"></div></div><div class="trk-job"><span class="note" id="bfJob">${job ? esc(job.name) : ''}</span>${MB.iconBtn('close', 'Cancel', 'data-act="bf-cancel"', '', 'Cancel reading the log')}</div></div>
          <div id="bfNotes">${this.notesHtml()}</div>
          <div id="bfList" class="trk-list">${MB.trackLogs ? MB.trackLogs.listHtml('betaflight') : ''}</div>
        </div></div></details>`;
    },

    bindPanel(panel) {
      const item = panel.querySelector('#bfItem');
      if (!item) return;
      item.querySelector('[data-act="bf-open"]').addEventListener('click', () => this.input().click());
      item.querySelector('[data-act="bf-cancel"]').addEventListener('click', () => this.cancel());
      item.addEventListener('dragover', e => { e.preventDefault(); item.classList.add('over'); });
      item.addEventListener('dragleave', () => item.classList.remove('over'));
      item.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); item.classList.remove('over'); this.openFiles(e.dataTransfer.files); });
      if (MB.trackLogs) MB.trackLogs.renderList(panel.querySelector('#bfList'), { source: 'betaflight' });
      this.tick();
    },

    // The file chooser: one for the page, outside the panel (which is redrawn while it is open).
    input() {
      if (this._input) return this._input;
      const el = this._input = document.createElement('input');
      el.type = 'file'; el.multiple = true; el.hidden = true;
      el.accept = '.bbl,.bfl,.txt,.csv,.BBL,.BFL,.TXT,.CSV';
      el.addEventListener('change', () => { const files = Array.from(el.files || []); el.value = ''; this.openFiles(files); });
      document.body.appendChild(el);
      return el;
    },

    // The progress, the notes and the count, updated in place.
    tick() {
      if (typeof document === 'undefined') return;
      const job = this.job, prog = document.getElementById('bfProgress');
      if (prog) {
        prog.hidden = !job;
        const bar = prog.querySelector('.bar'), w = (job ? Math.round(job.frac * 100) : 0) + '%';
        if (bar && bar.style.width !== w) bar.style.width = w;
        const j = document.getElementById('bfJob');
        if (j && j.textContent !== (job ? job.name : '')) j.textContent = job ? job.name : '';
      }
      const notes = document.getElementById('bfNotes');
      if (notes) { const h = this.notesHtml(); if (notes._html !== h) { notes.innerHTML = h; notes._html = h; } }
      const n = document.getElementById('bfCount');
      if (n) { const t = this.countText(); if (n.textContent !== t) n.textContent = t; }
    }
  };
  if (MB.on) MB.on('tracklogs', () => MB.betaflight.tick()); // a log added or removed: the count
})(window.MB);
