'use strict';
// The time on the map (js/clock.js): off unless chosen, local time / UTC / both, the local time's zone (the device's
// or one chosen), and while off or hidden no widget and no timer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..');

// A stand-in for the few elements the widget makes: its lines come from the HTML it is given.
function fakeEl(cls) {
  let html = '', lines = [];
  return {
    className: cls, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    set innerHTML(h) {
      html = h;
      lines = [...h.matchAll(/class="mb-clock-line" data-kind="(\w+)" title="([^"]*)"/g)].map(m => {
        const t = { textContent: '' }, z = { textContent: '' };
        return { kind: m[1], title: m[2], t, z, querySelector: s => (s === '.t' ? t : z) };
      });
    },
    get innerHTML() { return html; },
    querySelectorAll: () => lines,
    get lines() { return lines.map(l => ({ kind: l.kind, title: l.title, time: l.t.textContent, zone: l.z.textContent })); }
  };
}

function load(clockSettings) {
  const timers = new Map(); let ids = 0, saves = 0;
  const listeners = {};
  const map = { controls: [] };
  const L = {
    DomUtil: { create: cls => fakeEl(cls) },
    DomEvent: { disableClickPropagation() {} },
    Control: {
      extend(proto) {
        class Control {
          constructor(options) { this.options = options; }
          addTo(m) { this._map = m; this._container = this.onAdd(m); m.controls.push(this); return this; }
          remove() { this._map.controls = this._map.controls.filter(c => c !== this); }
        }
        Object.assign(Control.prototype, proto);
        return Control;
      }
    }
  };
  const document = { hidden: false, addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); } };
  const MB = {
    map,
    settings: clockSettings === undefined ? {} : { clock: clockSettings },
    saveSettings() { saves++; },
    escapeHtml: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    ICON: { clock: '<svg></svg>' }
  };
  const ctx = {
    window: { MB }, L, document, Intl, Date,
    setTimeout: (fn, ms) => { const id = ++ids; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => { timers.delete(id); }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/clock.js'), 'utf8'), ctx, { filename: 'clock.js' });
  const fire = type => (listeners[type] || []).forEach(fn => fn());
  return { C: MB.clock, MB, map, timers, document, fire, saves: () => saves };
}
const plain = x => JSON.parse(JSON.stringify(x)); // (the sandbox's objects, as this realm's)
const AT = new Date(Date.UTC(2026, 0, 15, 18, 32, 5)); // 18:32:05 UTC; 03:32:05 the next day in Tokyo

test('the clock is off until it is turned on: local time and the device\'s zone are its first choices', () => {
  assert.deepEqual(plain(load().C.config()), { show: false, mode: 'local', zone: '' });
  assert.deepEqual(plain(load({}).C.config()), { show: false, mode: 'local', zone: '' });
  assert.deepEqual(plain(load({ show: 'yes', mode: 'sideways', zone: 'Mars/Olympus_Mons' }).C.config()), { show: false, mode: 'local', zone: '' }, 'anything else is the default');
  assert.deepEqual(plain(load({ show: true, mode: 'both', zone: 'Asia/Tokyo' }).C.config()), { show: true, mode: 'both', zone: 'Asia/Tokyo' });
});

test('off, nothing is drawn and no timer runs, even when the page comes back into view', () => {
  const { C, map, timers, fire } = load();
  C.init();
  assert.equal(map.controls.length, 0);
  assert.equal(timers.size, 0);
  fire('visibilitychange');
  assert.equal(map.controls.length, 0);
  assert.equal(timers.size, 0);
});

test('local time, UTC, or both', () => {
  const { C } = load();
  const kinds = mode => C.lines(AT, { show: true, mode, zone: 'Europe/London' }).map(l => l.kind).join(',');
  assert.equal(kinds('local'), 'local');
  assert.equal(kinds('utc'), 'utc');
  assert.equal(kinds('both'), 'local,utc');
  const [utc] = C.lines(AT, { show: true, mode: 'utc', zone: '' });
  assert.match(utc.time, /^18.32.05$/, 'UTC on a 24-hour clock');
  assert.equal(utc.zone, 'UTC');
});

test('the local time in a chosen zone, named beside it (its offset where the language has no name for it)', () => {
  const { C } = load();
  const [tokyo] = C.lines(AT, { show: true, mode: 'local', zone: 'Asia/Tokyo' });
  assert.match(tokyo.time, /\b0?3.32.05\b/);
  assert.match(tokyo.zone, /^(UTC\+9|JST)$/);
  assert.match(tokyo.title, /Asia \/ Tokyo/);
  const [sp] = C.lines(AT, { show: true, mode: 'local', zone: 'America/Sao_Paulo' });
  assert.match(sp.time, /\b0?3.32.05\b/);
  assert.match(sp.zone, /^(UTC−3|BRT)$/, 'a real minus sign, and UTC rather than GMT');
  assert.match(sp.title, /America \/ Sao Paulo/);
});

test('a local zone of UTC is still a local line, its zone named (not the UTC line\'s 24-hour, nameless format)', () => {
  const { C } = load();
  const [local, utc] = C.lines(AT, { show: true, mode: 'both', zone: 'UTC' });
  assert.equal(local.kind, 'local');
  assert.equal(local.zone, 'UTC');
  assert.match(utc.time, /^18.32.05$/);
});

test('turned on it shows and ticks on each second; turned off it goes, its timer with it', () => {
  const { C, MB, map, timers, saves } = load();
  C.init();
  C.set({ show: true, mode: 'both', zone: 'Asia/Tokyo' });
  assert.equal(saves(), 1, 'kept in the settings');
  assert.deepEqual(plain(MB.settings.clock), { show: true, mode: 'both', zone: 'Asia/Tokyo' });
  assert.equal(map.controls.length, 1);
  assert.equal(map.controls[0].options.position, 'bottomleft');
  const shown = map.controls[0]._container.lines;
  assert.deepEqual(shown.map(l => l.kind), ['local', 'utc']);
  assert.ok(shown.every(l => l.time && l.zone), 'each line has its time and zone');
  assert.equal(timers.size, 1);
  const [{ ms }] = timers.values();
  assert.ok(ms > 0 && ms <= 1005, 'the next tick at the start of the next second');

  C.set({ mode: 'utc' });
  assert.equal(map.controls.length, 1, 'the same widget');
  assert.deepEqual(map.controls[0]._container.lines.map(l => l.kind), ['utc']);
  assert.equal(timers.size, 1, 'one timer, not one per change');

  C.set({ show: false });
  assert.equal(map.controls.length, 0);
  assert.equal(timers.size, 0);
  assert.equal(C.control, null);
});

test('while the page is hidden it rests, and catches up at once when it is back', () => {
  const { C, timers, document, fire } = load({ show: true, mode: 'local', zone: '' });
  C.init();
  assert.equal(timers.size, 1);
  document.hidden = true; fire('visibilitychange');
  assert.equal(timers.size, 0);
  document.hidden = false; fire('visibilitychange');
  assert.equal(timers.size, 1);
});
