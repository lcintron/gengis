'use strict';
// Live air traffic (js/adsb.js) with several sources on: one marker per aircraft, and what it shows is the freshest data
// any source has. The real module runs in a sandbox with a stub map, fake feeds (a receiver, adsb.fi, adsb.lol) and a
// clock the tests move.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..'); // (GENGIS_ROOT: run the tests against another copy of the code)
const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);

function makeAdsb() {
  const clock = { t: T0 };
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock.t])); }
    static now() { return clock.t; }
  }
  const classes = () => {
    const s = new Set();
    return { toggle: (c, on) => { if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); }, add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c) };
  };
  const node = () => ({ style: { setProperty() {} }, classList: classes(), setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, innerHTML: '', textContent: '' });
  const layers = new Set();
  const map = {
    createPane: () => node(), getPane: () => node(), on() {}, getZoom: () => 9,
    getCenter: () => ({ wrap: () => ({ lat: 40.64, lng: -73.78, distanceTo: () => 30000 }) }),
    getBounds: () => ({ pad: () => ({ contains: () => true }), getNorthEast: () => ({}) }),
    removeLayer: m => { layers.delete(m); }, closePopup() {},
    attributionControl: { addAttribution() {}, removeAttribution() {} }
  };
  const L = {
    marker(ll, opts) {
      const el = node();
      el.firstChild = node(); el.lastChild = node();
      const m = { ll, options: Object.assign({}, opts), setLatLng(x) { m.ll = x; return m; }, getElement: () => el, on() { return m; }, addTo() { layers.add(m); return m; } };
      return m;
    },
    divIcon: o => o,
    Control: { extend: () => function () { this.addTo = () => this; } },
    DomEvent: { stopPropagation() {}, stop() {} }
  };
  // feeds: source id -> the JSON it answers with (a value, or a function returning one or a promise of one)
  const feeds = {};
  const fetch = async url => {
    const id = /rx\.test/.test(url) ? 'dump1090' : (/adsb\.fi/.test(url) ? 'adsbfi' : (/adsb\.lol/.test(url) ? 'adsblol' : ''));
    let body = feeds[id];
    if (typeof body === 'function') body = await body(url);
    if (body == null) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const MB = {
    native: { app: false, platform: 'web' }, // (js/native.js, outside the Android app: MB.getText is fetch)
    getText: async (url, timeout) => { const r = await fetch(url, { cache: 'no-store' }); return { ok: r.ok, status: r.status, text: await r.text() }; },
    escapeHtml: s => String(s), settings: {}, saveSettings() {}, autosave: null, toast() {}, on() {}, emit() {},
    map, tools: { current: 'select' }, state: { units: 'nautical' }, formatLatLng: p => p.lat + ', ' + p.lng,
    ICON: { search: '' }, data: { sourceOpen: () => false, infoIcon: () => '' }
  };
  const ctx = {
    window: { MB, gengisDesktop: {} }, MB, // (the desktop app: the community networks are offered there only)
    L, Date: FakeDate, fetch, AbortController, URL, console,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0,
    document: { hidden: false, addEventListener() {}, createElement: node, getElementById: () => null, querySelector: () => null },
    navigator: { onLine: true }, location: { protocol: 'http:' }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/adsb.js'), 'utf8'), ctx, { filename: 'js/adsb.js' });
  const A = MB.adsb;
  A.srcConf('dump1090').url = 'http://rx.test:8080';
  A.init();

  const app = {
    A, feeds, layers, clock,
    advance: ms => { clock.t += ms; },
    on: (...ids) => ids.forEach(id => { A.enable(id, true); assert.ok(A.rt[id].on, id + ' is on'); }),
    poll: async id => { await A.poll(A.sources.find(s => s.id === id)); },
    // what each source answers: its own JSON shape, its snapshot made `lag` ms before the request
    rx: (list, lag) => { feeds.dump1090 = { now: (clock.t - (lag || 0)) / 1000, messages: 1, aircraft: list }; },
    fi: (list, lag) => { feeds.adsbfi = { now: (clock.t - (lag || 0)) / 1000, aircraft: list, resultCount: list.length, ptime: 1 }; },
    lol: (list, lag) => { feeds.adsblol = { ac: list, msg: 'No error', now: clock.t - (lag || 0), total: list.length, ctime: clock.t, ptime: 0 }; },
    // the aircraft entries with this address (as shown: upper case, without a "~")
    entries: hex => [...A.aircraft.values()].filter(e => e.info && e.info.hex.toUpperCase() === hex.toUpperCase()),
    one(hex) { const l = app.entries(hex); assert.equal(l.length, 1, 'one entry for ' + hex); return l[0]; },
    markersAt: () => [...layers].map(m => [m.ll[0], m.ll[1]]),
    // every marker on the map belongs to an aircraft entry, and no entry has two
    checkMarkers() {
      const owned = [...A.aircraft.values()].map(e => e.marker).filter(Boolean);
      assert.equal(new Set(owned).size, owned.length, 'no marker shared');
      assert.equal(layers.size, owned.length, 'no orphan markers on the map');
      owned.forEach(m => assert.ok(layers.has(m), 'every entry marker is on the map'));
    }
  };
  return app;
}

const ac = (hex, lat, lon, extra) => Object.assign({ hex, type: 'adsb_icao', lat, lon, seen_pos: 0.1, seen: 0.1, alt_baro: 10000, gs: 300, track: 90 }, extra || {});

/* ---------------------------------------------------------------- one marker per aircraft */

test('ADS-B: the same aircraft from three sources is one marker, whatever case or padding its address comes in', async () => {
  const app = makeAdsb();
  app.on('dump1090', 'adsbfi', 'adsblol');
  app.rx([ac('A1B2C3', 40.1, -73.1)]);
  app.fi([ac(' a1b2c3 ', 40.1001, -73.1)]);
  app.lol([ac('a1b2c3', 40.1002, -73.1)]);
  await app.poll('dump1090'); await app.poll('adsbfi'); await app.poll('adsblol');
  const e = app.one('a1b2c3');
  assert.deepEqual([...e.srcs].sort(), ['adsbfi', 'adsblol', 'dump1090'], 'every source counted for the one aircraft');
  assert.equal(app.layers.size, 1);
  app.checkMarkers();
});

test('ADS-B: a non-ICAO address (~) merges with itself across sources, never with the ICAO address of the same digits', async () => {
  const app = makeAdsb();
  app.on('dump1090', 'adsbfi', 'adsblol');
  app.rx([ac('~c0ffee', 41, -74, { type: 'tisb_other' })]);
  app.fi([ac('~C0FFEE', 41.001, -74, { type: 'tisb_other' })]);
  app.lol([ac('c0ffee', 35, -80)]); // a different aircraft, far away
  await app.poll('dump1090'); await app.poll('adsbfi'); await app.poll('adsblol');
  const l = app.entries('c0ffee');
  assert.equal(l.length, 2, 'two aircraft');
  const tisb = l.find(e => e.info.nonIcao), icao = l.find(e => !e.info.nonIcao);
  assert.ok(tisb && icao);
  assert.deepEqual([...tisb.srcs].sort(), ['adsbfi', 'dump1090']);
  assert.equal(icao.info.lat, 35, 'the ICAO aircraft stays where it is');
  assert.ok(Math.abs(tisb.info.lat - 41) < 0.01, 'the TIS-B target stays where it is');
  assert.equal(app.layers.size, 2);
  app.checkMarkers();
});

test('ADS-B: one source listing an aircraft twice still makes one marker, at its fresher position', async () => {
  const app = makeAdsb();
  app.on('adsbfi');
  app.fi([ac('abcdef', 40.2, -73, { seen_pos: 0.2 }), ac('ABCDEF', 40.1, -73, { seen_pos: 9 })]);
  await app.poll('adsbfi');
  assert.equal(app.one('abcdef').info.lat, 40.2);
  assert.equal(app.layers.size, 1);
});

/* ---------------------------------------------------------------- the freshest data wins */

test('ADS-B: the position shown is the freshest by the data\'s own age, not the source that answered last', async () => {
  const app = makeAdsb();
  app.on('dump1090', 'adsbfi', 'adsblol');
  app.fi([ac('a00001', 40.3, -73, { seen_pos: 0.3 })]);
  app.lol([ac('a00001', 40.25, -73, { seen_pos: 2 })]);
  app.rx([ac('a00001', 40.2, -73, { seen_pos: 6, seen: 0.2 })]); // the receiver last heard a position 6 s ago
  await app.poll('adsbfi'); await app.poll('adsblol'); await app.poll('dump1090');
  assert.equal(app.one('a00001').info.lat, 40.3);
  const [[lat, lon], ...more] = app.markersAt();
  assert.equal(more.length, 0);
  assert.equal(lat, 40.3, 'at the freshest report (heading east: carried on along its track, js/adsb.js place)');
  assert.ok(Math.abs(lon + 73) < 0.01);
});

test('ADS-B: a receiver that gives no position age (the original dump1090) does not pass an old position off as new', async () => {
  const app = makeAdsb();
  app.on('dump1090', 'adsbfi');
  app.fi([ac('a00002', 40.3, -73, { seen_pos: 1, seen: 1 })]);
  // data.json: a bare list, "seen" only
  app.feeds.dump1090 = [{ hex: 'a00002', lat: 40.1, lon: -73, validposition: 1, altitude: 9000, speed: 280, track: 90, validtrack: 1, seen: 25 }];
  await app.poll('adsbfi'); await app.poll('dump1090');
  assert.equal(app.one('a00002').info.lat, 40.3);
});

test('ADS-B: a snapshot served late (older than the last one from the same source) does not move the aircraft back', async () => {
  const app = makeAdsb();
  app.on('adsblol', 'adsbfi');
  app.lol([ac('a00003', 40.2, -73)]);
  await app.poll('adsblol');
  app.advance(5000);
  app.lol([ac('a00003', 40.1, -73)], 8000); // a lagging server: its snapshot is from before the one already shown
  await app.poll('adsblol');
  assert.equal(app.one('a00003').info.lat, 40.2, 'same source');
  // across sources: adsb.fi has a fresh position; adsb.lol answers after it, with a snapshot made 5 s before
  app.fi([ac('a00003', 40.3, -73)]);
  await app.poll('adsbfi');
  app.advance(1000);
  app.lol([ac('a00003', 40.25, -73)], 5000);
  await app.poll('adsblol');
  assert.equal(app.one('a00003').info.lat, 40.3, 'across sources');
  assert.equal(app.layers.size, 1);
});

test('ADS-B: a newer report with an older position keeps the position but updates the rest', async () => {
  const app = makeAdsb();
  app.on('adsbfi');
  app.fi([ac('a00008', 40.2, -73, { seen_pos: 0.1, alt_baro: 10000 })]);
  await app.poll('adsbfi');
  app.advance(1000);
  app.fi([ac('a00008', 40.1, -73, { seen_pos: 3, seen: 0.1, alt_baro: 11000 })]);
  await app.poll('adsbfi');
  const a = app.one('a00008').info;
  assert.equal(a.lat, 40.2);
  assert.equal(a.alt, 11000);
});

test('ADS-B: altitude, speed and callsign come from the freshest report that carries them', async () => {
  const app = makeAdsb();
  app.on('dump1090', 'adsbfi', 'adsblol');
  app.fi([ac('a00004', 40.1, -73, { seen_pos: 3, seen: 3, alt_baro: 12000, gs: 280, flight: 'AAA1    ', squawk: '1200', emergency: 'general' })]);
  app.lol([ac('a00004', 40.15, -73, { seen_pos: 5, seen: 1, alt_baro: 12100, flight: 'BBB2    ', squawk: '1201', emergency: 'none', gs: undefined })]);
  app.rx([{ hex: 'a00004', lat: 40.2, lon: -73, seen_pos: 0.2, seen: 0.2, gs: 310 }]); // freshest position, no altitude or callsign
  await app.poll('adsbfi'); await app.poll('adsblol'); await app.poll('dump1090');
  const a = app.one('a00004').info;
  assert.equal(a.lat, 40.2, 'position from the receiver');
  assert.equal(a.gs, 310, 'speed from the receiver');
  assert.equal(a.alt, 12100, 'altitude from adsb.lol (heard 1 s ago, adsb.fi 3 s ago)');
  assert.equal(a.flight, 'BBB2', 'callsign from adsb.lol');
  assert.equal(a.squawk, '1201');
  assert.equal(a.emergency, '', 'the newer "no emergency" stands');
});

/* ---------------------------------------------------------------- staleness */

test('ADS-B: one source dropping an aircraft another still reports: no jump back, then the other takes over', async () => {
  const app = makeAdsb();
  app.on('dump1090', 'adsbfi');
  app.rx([ac('a00005', 40.5, -73, { seen_pos: 0.1 }), ac('a00006', 41, -73)]);
  app.fi([ac('a00005', 40.4, -73, { seen_pos: 4 })]);
  await app.poll('adsbfi'); await app.poll('dump1090');
  assert.equal(app.one('a00005').info.lat, 40.5);
  assert.equal(app.layers.size, 2);
  // the receiver loses both: a00006 had no other source and goes; a00005 stays at its last (and freshest) position
  app.advance(1000);
  app.rx([]);
  await app.poll('dump1090');
  assert.equal(app.entries('a00006').length, 0);
  assert.equal(app.one('a00005').info.lat, 40.5, 'not moved back to adsb.fi\'s older position');
  assert.equal(app.layers.size, 1);
  // adsb.fi still has the older position: nothing changes
  app.fi([ac('a00005', 40.4, -73, { seen_pos: 5 })]);
  await app.poll('adsbfi');
  assert.equal(app.one('a00005').info.lat, 40.5);
  // then a fresher one from adsb.fi
  app.advance(1000);
  app.fi([ac('a00005', 40.6, -73, { seen_pos: 0.2 })]);
  await app.poll('adsbfi');
  const e = app.one('a00005');
  assert.equal(e.info.lat, 40.6);
  assert.deepEqual([...e.srcs], ['adsbfi'], 'only the source still reporting it');
  // adsb.fi drops it too: gone
  app.fi([]);
  await app.poll('adsbfi');
  assert.equal(app.entries('a00005').length, 0);
  assert.equal(app.layers.size, 0);
  app.checkMarkers();
});

test('ADS-B: an aircraft goes once every source\'s position for it is too old, a feed stuck on one snapshot included', async () => {
  const app = makeAdsb();
  app.on('dump1090', 'adsbfi');
  app.rx([ac('a00007', 40, -73)]);
  app.fi([ac('a00007', 40, -73.01, { seen_pos: 2 })]);
  await app.poll('dump1090'); await app.poll('adsbfi');
  assert.equal(app.layers.size, 1);
  // the receiver keeps serving the same snapshot (same "now"); adsb.fi stops answering with this aircraft's updates
  const stuck = app.feeds.dump1090;
  app.advance(30000);
  await app.poll('dump1090');
  assert.equal(app.layers.size, 1, 'still shown at 30 s');
  assert.ok(app.one('a00007').marker.getElement().classList.contains('stale'), 'faded');
  app.advance(31000);
  app.feeds.dump1090 = stuck;
  await app.poll('dump1090');
  assert.equal(app.entries('a00007').length, 0, 'removed after a minute');
  assert.equal(app.layers.size, 0);
});

/* ---------------------------------------------------------------- turning a source off */

test('ADS-B: turning a source off mid-flight leaves one marker per aircraft still reported, none for the rest', async () => {
  const app = makeAdsb();
  app.on('dump1090', 'adsbfi');
  app.rx([ac('b00001', 40.5, -73, { seen_pos: 0.1 }), ac('b00002', 41, -73)]);
  app.fi([ac('b00001', 40.4, -73, { seen_pos: 3 }), ac('b00003', 42, -73)]);
  await app.poll('dump1090'); await app.poll('adsbfi');
  assert.equal(app.layers.size, 3);
  // a receiver request still in flight when it is turned off
  let release;
  app.feeds.dump1090 = () => new Promise(r => { release = () => r({ now: app.clock.t / 1000, aircraft: [ac('b00001', 40.7, -73), ac('b00002', 41, -73)] }); });
  const inflight = app.poll('dump1090');
  app.A.disable('dump1090');
  release();
  await inflight;
  assert.equal(app.entries('b00002').length, 0, 'the receiver-only aircraft is gone');
  assert.equal(app.one('b00001').info.lat, 40.4, 'the shared one is now where adsb.fi has it');
  assert.deepEqual([...app.one('b00001').srcs], ['adsbfi']);
  assert.equal(app.layers.size, 2);
  app.checkMarkers();
  // and back on
  app.advance(1000);
  app.rx([ac('b00001', 40.8, -73), ac('b00002', 41, -73)]);
  app.on('dump1090');
  await app.poll('dump1090');
  assert.equal(app.one('b00001').info.lat, 40.8);
  assert.equal(app.layers.size, 3);
  app.checkMarkers();
  // the other off: only the receiver's
  app.A.disable('adsbfi');
  assert.equal(app.entries('b00003').length, 0);
  assert.equal(app.layers.size, 2);
  app.checkMarkers();
});

/* ---------------------------------------------------------------- cost */

test('ADS-B: merging hundreds of aircraft from three sources each second stays cheap', async () => {
  const app = makeAdsb();
  app.on('dump1090', 'adsbfi', 'adsblol');
  const list = (from, n, salt) => Array.from({ length: n }, (_, i) => ac((from + i).toString(16).padStart(6, '0'), 40 + i / 1000, -73 + salt / 1000, { seen_pos: (i % 7) / 2, seen: (i % 5) / 2, flight: 'F' + i }));
  const cycle = async k => {
    app.rx(list(0xa00000, 600, k)); app.fi(list(0xa00100, 600, k)); app.lol(list(0xa00200, 600, k));
    await app.poll('dump1090'); await app.poll('adsbfi'); await app.poll('adsblol');
    app.advance(1000);
  };
  await cycle(0);
  const t = process.hrtime.bigint(), n = 20;
  for (let k = 1; k <= n; k++) await cycle(k);
  const ms = Number(process.hrtime.bigint() - t) / 1e6 / n;
  assert.equal(app.A.aircraft.size, 1112, 'one entry per address');
  assert.equal(app.layers.size, 1112);
  app.checkMarkers();
  assert.ok(ms < 150, `a cycle of three polls took ${ms.toFixed(1)} ms`);
});
