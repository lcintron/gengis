'use strict';
// Switching projects never waits forever on the open project's file, and an open that fails says so.
// The real js/projectstore.js and js/browserfiles.js run in a sandbox: an in-memory IndexedDB, a clock the test
// moves by hand (so "8 seconds without an answer" takes no time), and file handles that can stall.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..');
const src = f => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
const never = () => new Promise(() => {});
// let everything that can run without the clock moving run (promise chains, the fake database's answers)
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

// A clock moved by hand: setTimeout and clearTimeout for the sandbox.
function fakeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { timers.set(++seq, { at: now + (ms || 0), fn }); return seq; },
    clearTimeout: id => { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = end;
      await settle();
    }
  };
}

// IndexedDB, as much of it as the two modules use: stores keyed by a key path, requests answered a moment later, a
// transaction complete once its requests are answered and nothing more was asked.
const copy = v => (v && typeof v === 'object' ? Object.assign({}, v) : v);
function fakeIndexedDB(seed) {
  const dbs = {};
  const request = (tx, compute) => {
    const q = {};
    tx.open++;
    setImmediate(() => { q.result = compute(); tx.open--; if (q.onsuccess) q.onsuccess(); });
    return q;
  };
  const store = (tx, s) => ({
    // (a copy out and a copy in, as the real one: what is read is never the object that was stored)
    get: k => request(tx, () => copy(s.rows.get(k))),
    getAll: () => request(tx, () => [...s.rows.values()].map(copy)),
    put: v => request(tx, () => { s.rows.set(v[s.keyPath], copy(v)); }),
    delete: k => request(tx, () => { s.rows.delete(k); }),
    index: () => ({ getAll: () => request(tx, () => []) })
  });
  return {
    open(name) {
      const r = {};
      setImmediate(() => {
        const fresh = !dbs[name];
        const d = dbs[name] = dbs[name] || { stores: {} };
        const api = {
          objectStoreNames: { contains: n => !!d.stores[n] },
          createObjectStore: (n, o) => { d.stores[n] = { keyPath: o.keyPath, rows: new Map() }; return { createIndex() {} }; },
          transaction(names) {
            const tx = { open: 0, objectStore: n => store(tx, d.stores[n]) };
            let idle = 0;
            const tick = () => { if (tx.open) idle = 0; else if (++idle >= 3) { if (tx.oncomplete) tx.oncomplete(); return; } setImmediate(tick); };
            setImmediate(tick);
            return tx;
          }
        };
        r.result = api;
        if (fresh && r.onupgradeneeded) r.onupgradeneeded();
        if (fresh && seed && seed[name]) Object.keys(seed[name]).forEach(n => seed[name][n].forEach(row => d.stores[n].rows.set(row[d.stores[n].keyPath], row)));
        if (r.onsuccess) r.onsuccess();
      });
      return r;
    }
  };
}

// A page with the modules asked for. opts.files: the browser offers the file pickers (browserfiles.js is live).
function sandbox(opts) {
  opts = opts || {};
  const clock = fakeClock();
  const toasts = [], asks = [], warnings = [], events = {};
  const MB = {
    state: { projectId: 'A', projectName: 'Alpha' },
    featureLayers: {},
    escapeHtml: s => String(s),
    toast: (msg, ms) => { toasts.push({ msg, ms }); },
    ask: (...a) => { asks.push(a); return Promise.resolve(opts.answer !== false); },
    on: (ev, fn) => { (events[ev] = events[ev] || []).push(fn); },
    emit: (ev, v) => { (events[ev] || []).forEach(fn => fn(v)); },
    serializeProject: () => ({ id: MB.state.projectId, name: MB.state.projectName, features: [], savedAt: 'now' }),
    isProject: () => true,
    // (opts.keepHistory: a step of undo or redo; anything else is a project opened, and says so)
    loadProject: (p, o) => { MB.state.projectId = p.id; MB.state.projectName = p.name; MB.emit('project'); if (!(o && o.keepHistory)) MB.emit('project-opened'); },
    storedItem: () => null,
    PROJECT_EXT: '.gengis'
  };
  // the page, as much as the read-only banner needs (one element, found again by its id)
  const els = {};
  const document = {
    addEventListener() {}, visibilityState: 'visible',
    getElementById: id => els[id] || null,
    createElement: () => { const el = { setAttribute() {}, querySelector: () => ({ addEventListener() {} }), remove() { delete els[el.id]; } }; return el; },
    body: { appendChild: el => { els[el.id] = el; } }
  };
  MB.ICON = new Proxy({}, { get: () => '' });
  const window = {
    addEventListener() {},
    MB, indexedDB: opts.noDatabase ? undefined : fakeIndexedDB(opts.seed),
    showSaveFilePicker: opts.files ? () => Promise.resolve(opts.files.handle) : undefined,
    showOpenFilePicker: opts.files ? () => Promise.resolve([opts.files.handle]) : undefined
  };
  const ctx = vm.createContext({
    window, indexedDB: window.indexedDB,
    document,
    navigator: { userAgent: 'test' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console: { warn: (...a) => { warnings.push(a); }, log() {}, error: (...a) => { warnings.push(a); } },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    IDBKeyRange: { only: v => v }
  });
  (opts.modules || ['projectstore.js']).forEach(f => vm.runInContext(src(f), ctx, { filename: f }));
  return { MB, P: MB.projects, F: MB.browserFiles, clock, toasts, asks, warnings, banner: () => (els['mb-readonly'] || {}).innerHTML || '' };
}

// A promise's outcome so far: { done, value } (without waiting for it).
function watch(promise) {
  const w = { done: false };
  promise.then(v => { w.done = true; w.value = v; }, e => { w.done = true; w.error = e; });
  return w;
}

// A file handle whose calls answer as told: opts[name] is a function, or 'stall' for a call that never answers.
function fakeHandle(name, opts) {
  opts = opts || {};
  const calls = [], log = n => { calls.push(n); };
  const answer = (n, normal) => (...a) => { log(n); return opts[n] === 'stall' ? never() : (opts[n] ? opts[n](...a) : normal(...a)); };
  const writable = { written: null, closed: false, aborted: false };
  writable.write = answer('write', async text => { writable.written = text; });
  writable.close = answer('close', async () => { writable.closed = true; });
  writable.abort = async () => { log('abort'); writable.aborted = true; };
  return {
    name, calls, writable,
    queryPermission: answer('queryPermission', async () => 'granted'),
    requestPermission: answer('requestPermission', async () => 'granted'),
    getFile: answer('getFile', async () => ({ lastModified: 1000, text: async () => writable.written || '{}' })),
    createWritable: answer('createWritable', async () => writable),
    isSameEntry: async () => false
  };
}

/* ---------- projectstore.js: the switch ---------- */

test('replacing a project does not wait forever for its file: a write that never answers is given up on, and said', async () => {
  const s = sandbox();
  let asked = 0;
  s.MB.browserFiles = { available: true, writePending: () => { asked++; return never(); } };
  const out = watch(s.P.confirmReplace('Open the other project'));
  await settle();
  assert.equal(asked, 1, 'the file is asked to take the last changes');
  assert.equal(out.done, false, 'waiting for the file');
  await s.clock.advance(7900);
  assert.equal(out.done, false, 'still within the wait');
  await s.clock.advance(200);
  assert.equal(out.done, true, 'given up on after 8 seconds');
  assert.equal(out.value, true, 'the project is safe in the database: the switch goes ahead');
  assert.deepEqual(s.toasts.map(t => t.msg), ['Could not finish saving the project file first; it is still saved in the app.']);
  assert.equal(s.asks.length, 0, 'nothing to ask');
  assert.equal(s.clock.pending(), 0, 'no timer left behind');
});

test('replacing a project: a file write that fails (browser or desktop) is said and does not stop the switch', async () => {
  const s = sandbox();
  s.MB.desktopFiles = { available: true, writePending: () => Promise.reject(new Error('disk gone')) };
  s.MB.browserFiles = { available: true, writePending: () => { throw new Error('no handle'); } };
  const out = watch(s.P.confirmReplace('Open the other project'));
  await settle();
  assert.equal(out.done, true);
  assert.equal(out.value, true);
  assert.equal(s.toasts.length, 2, 'each failure said');
  assert.equal(s.warnings.length, 2, 'and in the console');
  assert.equal(s.clock.pending(), 0, 'the wait\'s timer is cleared');
});

test('replacing a project: a file that takes the changes in time says nothing', async () => {
  const s = sandbox();
  s.MB.browserFiles = { available: true, writePending: () => Promise.resolve(true) };
  s.MB.desktopFiles = { available: false, writePending: () => never() }; // (not this app: never asked)
  const out = watch(s.P.confirmReplace('Open the other project'));
  await settle();
  assert.deepEqual([out.done, out.value], [true, true]);
  assert.equal(s.toasts.length, 0);
  assert.equal(s.clock.pending(), 0);
});

test('replacing a project that could not be saved here still asks first, stalled file or not', async () => {
  for (const answer of [true, false]) {
    const s = sandbox({ answer });
    s.P.flush = async () => false; // the database refused it
    s.MB.browserFiles = { available: true, writePending: never };
    const out = watch(s.P.confirmReplace('Open the other project'));
    await settle();
    assert.equal(s.asks.length, 0, 'not before the file had its chance');
    await s.clock.advance(8000);
    assert.equal(s.asks.length, 1, 'asked');
    assert.match(s.asks[0][0], /"Alpha" could not be saved in this browser's project storage/);
    assert.equal(s.asks[0][1], 'Open the other project');
    assert.deepEqual([out.done, out.value], [true, answer], 'the answer decides');
  }
});

const B = { id: 'B', name: 'Bravo', objects: 2, savedAt: 5, fileBacked: true, data: { id: 'B', name: 'Bravo', features: [] } };
const seed = () => ({ 'gengis-projects': { projects: [Object.assign({}, B)] } });
const both = () => ({ 'gengis-projects': { projects: [Object.assign({}, B), { id: 'A', name: 'Alpha', objects: 0, savedAt: 9, fileBacked: false, data: { id: 'A', name: 'Alpha', features: [] } }] } }); // (Alpha the latest: start-up keeps it open)

test('opening a saved project: opened, true; one that does not load is said and false, never thrown', async () => {
  const s = sandbox({ seed: seed() });
  assert.equal(await s.P.open('B'), true);
  assert.equal(s.MB.state.projectId, 'B');
  assert.equal(s.P.fileBacked, true);
  assert.equal(s.toasts.length, 0);

  const f = sandbox({ seed: seed() });
  f.MB.loadProject = () => { throw new Error('bad layer'); };
  assert.equal(await f.P.open('B'), false);
  assert.deepEqual(f.toasts, [{ msg: 'Could not open "Bravo": bad layer', ms: 6000 }]);
  assert.equal(f.P.fileBacked, false, 'the open project\'s flag is left alone');
  assert.equal(f.MB.state.projectId, 'A');
  assert.equal(f.P.readOnly, true, 'what is on the map may be half a project: nothing is saved from it');

  // the database failing to read (here: a browser that keeps none) is said too
  const d = sandbox({ noDatabase: true });
  assert.equal(await d.P.open('B'), false);
  assert.deepEqual(d.toasts, [{ msg: 'Could not open "the project": this browser keeps no database for the app', ms: 6000 }]);
  assert.equal(d.P.readOnly, false, 'nothing was loaded: the open project is as it was');

  // gone from the database: said, false
  const g = sandbox({ seed: seed() });
  assert.equal(await g.P.open('nope'), false);
  assert.deepEqual(g.toasts.map(t => t.msg), ['That project is no longer saved here.']);
});

test('opening a saved project when its file write never answers: it opens after the wait', async () => {
  const s = sandbox({ seed: seed() });
  s.MB.browserFiles = { available: true, writePending: never };
  const out = watch(s.P.open('B'));
  await settle();
  assert.equal(out.done, false);
  assert.equal(s.MB.state.projectId, 'A');
  await s.clock.advance(8000);
  assert.deepEqual([out.done, out.value], [true, true]);
  assert.equal(s.MB.state.projectId, 'B', 'the other project is open');
});

test('a project that failed while opening is not saved from: read-only until a project opens whole again', async () => {
  const s = sandbox({ seed: both() });
  await s.P.start();
  assert.equal(s.MB.state.projectId, 'A', 'start-up left the open project open');
  await settle();
  assert.equal(s.P.owns(), true, 'this tab edits the open project');
  const real = s.MB.loadProject;
  // (the map already cleared and the new id in place when it fails, as a load that breaks half-way leaves it)
  s.MB.loadProject = p => { s.MB.loadProject = real; s.MB.state.projectId = p.id; throw new Error('bad layer'); };
  assert.equal(await s.P.open('B'), false);
  assert.equal(s.P.readOnly, true);
  assert.equal(s.P.owns(), false, 'no autosave of the half');
  assert.match(s.banner(), /A project did not open completely, so what is shown may be part of it\. Changes made here are not saved\./);
  s.P.schedule();
  await s.clock.advance(5000);
  assert.equal((await s.P.get('B')).name, 'Bravo', 'what is saved for it is untouched');
  assert.deepEqual((await s.P.get('B')).data.features, []);
  // it then opens whole: editing (and saving) is back
  assert.equal(await s.P.open('B'), true);
  await settle();
  assert.equal(s.P.readOnly, false);
  assert.equal(s.P.owns(), true);
  assert.equal(s.banner(), '');

  // the same project again (no new claim to settle it): a restore that failed, then the open project reopened
  const r = sandbox({ seed: both() });
  await r.P.start();
  await settle();
  assert.equal(r.MB.state.projectId, 'A');
  const load = r.MB.loadProject;
  r.MB.loadProject = () => { r.MB.loadProject = load; throw new Error('bad layer'); };
  assert.equal(await r.P.open('B'), false);
  assert.equal(r.P.readOnly, true);
  assert.equal(await r.P.open('A'), true);
  assert.equal(r.P.readOnly, false, 'opened whole: no longer read-only');
  assert.equal(r.P.owns(), true);
});

/* ---------- browserfiles.js: the write ---------- */

// A project linked to a file through Save as (the picker hands back the handle).
async function linked(handleOpts) {
  const handle = fakeHandle('alpha.gengis', handleOpts);
  const files = { handle }; // (files.handle: what the file picker answers with, for a later Save as)
  const s = sandbox({ modules: ['projectstore.js', 'browserfiles.js'], files });
  s.P.flush = async () => true;
  s.P.markFileBacked = () => { s.P.fileBacked = true; };
  await settle();
  assert.equal(s.F.available, true, 'the module is live');
  const saved = watch(s.F.saveAs());
  await settle();
  return Object.assign(s, { handle, saved, files });
}

test('a project file is written and the wait for it settles', async () => {
  const s = await linked();
  assert.deepEqual([s.saved.done, s.saved.error], [true, undefined]);
  assert.equal(JSON.parse(s.handle.writable.written).name, 'Alpha');
  assert.equal(s.handle.writable.closed, true);
  assert.equal(s.F.state, 'saving');
  assert.equal(await s.F.writePending(), true);
  assert.equal(s.clock.pending(), 0, 'no time limit left running after a write that answered');
});

for (const [call, label] of [['getFile', 'reading the file'], ['createWritable', 'opening the file for writing'], ['write', 'writing the file'], ['close', 'saving the file']]) {
  test('a project file whose ' + call + '() never answers: the write gives up after 8 seconds, says so, and nothing waits on it after', async () => {
    const s = await linked({ [call]: 'stall' });
    assert.equal(s.saved.done, false, 'the write is waiting');
    const pending = watch(s.F.writePending());
    await settle();
    assert.equal(pending.done, false, 'and so is whoever waits for the file');
    await s.clock.advance(8000);
    assert.equal(pending.done, true, 'the wait is over');
    assert.equal(pending.value, false, 'not written');
    assert.equal(s.saved.done, true, 'Save as returned');
    assert.deepEqual(s.toasts.map(t => t.msg), ['Could not save to "alpha.gengis" (' + label + ' timed out). The project is still saved in this browser.']);
    assert.equal(s.F.error, label + ' timed out');
    // not poisoned: the next wait answers at once, and a later write runs
    const again = watch(s.F.writePending());
    await settle();
    assert.equal(again.done, true, 'a later project switch is not held up');
    assert.equal(s.clock.pending(), 0, 'no timer left behind');
  });
}

test('a file opened for writing only after the write gave up is dropped, not left half-written beside the file', async () => {
  let open;
  const s = await linked({ createWritable: () => new Promise(r => { open = r; }) });
  await s.clock.advance(8000);
  assert.equal(s.saved.done, true);
  open(s.handle.writable);
  await settle();
  assert.equal(s.handle.writable.aborted, true);
  assert.equal(s.handle.writable.written, null);
});

test('a file whose permission question never answers counts as not allowed: paused, nothing written, nothing stuck', async () => {
  const s = await linked({ queryPermission: 'stall' });
  assert.equal(s.saved.done, false);
  await s.clock.advance(8000);
  assert.equal(s.saved.done, true);
  assert.equal(s.F.state, 'paused');
  assert.ok(!s.handle.calls.includes('createWritable'), 'not written without leave');
  assert.ok(!s.handle.calls.includes('requestPermission'), 'the user is not asked from a background write');
  const again = watch(s.F.writePending());
  await s.clock.advance(8000);
  assert.equal(again.done, true);
});

test('a stalled project file does not stop another project opening (the two modules together)', async () => {
  const handle = fakeHandle('alpha.gengis', { createWritable: 'stall' });
  const s = sandbox({ modules: ['projectstore.js', 'browserfiles.js'], files: { handle }, seed: seed() });
  await settle();
  const flush = s.P.flush;
  s.P.flush = async () => true;
  s.P.markFileBacked = () => { s.P.fileBacked = true; };
  const saved = watch(s.F.saveAs());
  await settle();
  assert.equal(saved.done, false, 'the file write is stuck');
  s.P.flush = flush;
  const out = watch(s.P.open('B'));
  await s.clock.advance(8000);
  assert.deepEqual([out.done, out.value], [true, true], 'the other project opened');
  assert.equal(s.MB.state.projectId, 'B');
  assert.ok(s.toasts.length >= 1, 'and the file trouble was said');
  assert.equal(handle.writable.written, null, 'nothing of the other project went into the first one\'s file');
  // and from the project now open (no file), the next switch does not wait at all
  await s.clock.advance(8000);
  assert.equal(handle.calls.filter(c => c === 'createWritable').length, 1, 'the write queued behind the stalled one was not made into that file');
  const next = watch(s.P.confirmReplace('Start a new project'));
  await settle();
  assert.equal(next.done, true, 'nothing left over from the stalled write');
});

/* ---------- a switch overtaking a write ---------- */

const written = h => h.writable.written && JSON.parse(h.writable.written);

test('a write overtaken by a switch never puts the other project into this project\'s file', async () => {
  // the permission answer lands after the other project opened, before its (missing) link was looked up
  let answer;
  const s = await linked();
  assert.equal(s.saved.done, true);
  const h = s.handle, before = h.calls.length;
  h.queryPermission = () => new Promise(r => { answer = r; });
  s.MB.state.projectName = 'Alpha edited';
  s.MB.emit('saved');
  await s.clock.advance(2000);
  assert.ok(answer, 'the background write is waiting for the permission answer');
  s.MB.loadProject({ id: 'B', name: 'Bravo' }); // (as P.open does once it stops waiting for the file)
  answer('granted');
  await settle();
  await s.clock.advance(100);
  assert.equal(written(h).name, 'Alpha', 'the file still holds its own project');
  assert.equal(written(h).id, 'A');
  assert.deepEqual(h.calls.slice(before), [], 'and was not touched');
  assert.equal(s.F.state, 'none', 'the project now open has no file');

  // the same when the other project opens before the write even starts (it was queued behind another)
  let open;
  const q = await linked({ createWritable: () => new Promise(r => { open = r; }) });
  const second = watch(q.F.save()); // a second write, queued behind the first (stalled)
  await settle();
  q.MB.loadProject({ id: 'B', name: 'Bravo' });
  await q.clock.advance(8000); // the first gives up; the second's turn
  await q.clock.advance(8000);
  assert.equal(q.saved.done, true);
  assert.equal(second.done, true);
  assert.equal(q.handle.calls.filter(c => c === 'createWritable').length, 1, 'no second write into the first project\'s file');
  assert.equal(q.handle.writable.written, null);
});

test('a write of the project left behind that fails late leaves the open project\'s file status alone, and still says so', async () => {
  const s = await linked({ createWritable: 'stall' });
  s.MB.loadProject({ id: 'B', name: 'Bravo' });
  await settle();
  assert.equal(s.F.state, 'none');
  await s.clock.advance(8000);
  assert.deepEqual(s.toasts.map(t => t.msg), ['Could not save to "alpha.gengis" (opening the file for writing timed out). The project is still saved in this browser.']);
  assert.equal(s.F.state, 'none', 'the open project has no file, and no file trouble');
  assert.equal(s.F.error, '');

  // a file changed elsewhere, found out after the switch: said (it names the file), the status not touched
  let file;
  const c = await linked();
  c.handle.getFile = () => new Promise(r => { file = r; });
  c.MB.state.projectName = 'Alpha edited';
  c.MB.emit('saved');
  await c.clock.advance(2000);
  assert.ok(file, 'the write is reading the file');
  c.MB.loadProject({ id: 'B', name: 'Bravo' });
  await settle();
  file({ lastModified: 999999 });
  await settle();
  assert.match(c.toasts[c.toasts.length - 1].msg, /^"alpha\.gengis" was changed outside GenGIS/);
  assert.equal(c.F.state, 'none');
});

test('a close given up on that completes late: the file is written again with the project as it is now', async () => {
  const s = await linked();
  const h = s.handle;
  // each writable its own text, in the file once closed; the first one's close answers only when told
  let file = h.writable.written, n = 0, lateClose;
  h.createWritable = async () => {
    const mine = { text: null, k: ++n };
    return {
      write: async t => { mine.text = t; }, abort: async () => {},
      close: () => (mine.k === 1 ? new Promise(r => { lateClose = () => { file = mine.text; r(); }; }) : (file = mine.text, Promise.resolve()))
    };
  };
  s.MB.state.projectName = 'Edit one'; s.MB.emit('saved');
  await s.clock.advance(2000); // the first write: its close stalls
  await s.clock.advance(8000); // given up on
  s.MB.state.projectName = 'Edit two'; s.MB.emit('saved');
  await s.clock.advance(2000); // the second write completes
  assert.equal(JSON.parse(file).name, 'Edit two');
  lateClose(); // the first close lands after all: over the newer write
  await settle();
  assert.equal(JSON.parse(file).name, 'Edit one', '(the file went back)');
  await s.clock.advance(2000); // no edit, no save: the file is caught up on its own
  assert.equal(JSON.parse(file).name, 'Edit two', 'written again with what the app holds');
  assert.equal(n, 3);
  assert.equal(s.F.state, 'saving', 'and no conflict was made of GenGIS\'s own writing');
});

// A file on a slow disk: each writable has its own text, in the file (and its time moved on) once closed. close(k)
// says how the k-th writable's close answers: nothing (at once), a number (after that many ms), or 'held' (when
// f.release() is called).
function slowFile(s, close) {
  const f = { text: s.handle.writable.written, mtime: 1000, writes: 0, release: null };
  s.handle.getFile = async () => ({ lastModified: f.mtime });
  s.handle.createWritable = async () => {
    const mine = { text: null }, k = ++f.writes;
    const land = () => { f.text = mine.text; f.mtime += 5000; };
    return {
      write: async t => { mine.text = t; }, abort: async () => {},
      close: () => {
        const how = f.fast ? 0 : close(k);
        if (how === 'held') return new Promise(r => { f.release = () => { land(); r(); }; });
        if (how) return new Promise(r => { s.clock.setTimeout(() => { land(); r(); }, how); });
        land();
        return Promise.resolve();
      }
    };
  };
  f.name = () => JSON.parse(f.text).name;
  return f;
}
const edit = (s, name) => { s.MB.state.projectName = name; s.MB.emit('saved'); };

test('a file that is only slow to close (longer than the wait) is saved once, not written again and again', async () => {
  const s = await linked();
  const f = slowFile(s, () => 9000);
  edit(s, 'Edit one');
  await s.clock.advance(2000);  // the write starts
  await s.clock.advance(8000);  // given up on, and said
  assert.equal(s.F.error, 'saving the file timed out');
  await s.clock.advance(1000);  // the close answers after all
  assert.equal(f.name(), 'Edit one');
  assert.equal(s.F.error, '', 'it was saved: no longer a failure');
  assert.equal(s.F.state, 'saving');
  await s.clock.advance(300000);
  assert.equal(f.writes, 1, 'one edit, one write');
  assert.equal(s.clock.pending(), 0, 'and nothing scheduled');
  // the next edit is written as usual, and is no "changed outside GenGIS"
  edit(s, 'Edit two');
  await s.clock.advance(2000 + 9000 + 2000);
  assert.equal(f.name(), 'Edit two');
  assert.equal(f.writes, 2);
  assert.equal(s.F.state, 'saving');
  assert.ok(!s.toasts.some(t => /changed outside GenGIS/.test(t.msg)));
  // a file that is always this slow says so once, not at every edit (each of them is saved, after all)
  edit(s, 'Edit three');
  await s.clock.advance(2000 + 9000 + 2000);
  assert.equal(f.name(), 'Edit three');
  assert.equal(f.writes, 3);
  const timeouts = () => s.toasts.filter(t => /timed out/.test(t.msg)).map(t => t.msg);
  assert.deepEqual(timeouts(), ['Could not save to "alpha.gengis" (saving the file timed out). The project is still saved in this browser.'], 'said once');
  assert.equal(s.F.error, '');
  // and a save that answers in time ends that: a later failure is said again
  f.fast = true;
  edit(s, 'Edit four');
  await s.clock.advance(2000);
  assert.equal(f.name(), 'Edit four');
  f.fast = false;
  edit(s, 'Edit five');
  await s.clock.advance(2000 + 9000 + 2000);
  assert.equal(timeouts().length, 2, 'said again after a save that went well');
});

// A project linked to one.gengis whose edit's close stalls and is given up on (said). s.f.release() lands it.
async function heldClose() {
  const s = await linked();
  s.f = slowFile(s, k => (k === 1 ? 'held' : 0));
  edit(s, 'Edit one');
  await s.clock.advance(2000);
  await s.clock.advance(8000);
  assert.equal(s.toasts.filter(t => /timed out/.test(t.msg)).length, 1, 'the write was given up on, and said');
  s.undo = async () => { s.MB.loadProject({ id: 'A', name: s.MB.state.projectName }, { keepHistory: true }); await settle(); };
  return s;
}

test('Save as while a close of the old file is stalled: the late close never brings the old file back as the project\'s', async () => {
  const s = await heldClose();
  const two = s.files.handle = fakeHandle('two.gengis');
  const saved = watch(s.F.saveAs());
  await settle();
  assert.equal(saved.done, true);
  assert.equal(s.F.name, 'two.gengis');
  assert.equal(JSON.parse(two.writable.written).name, 'Edit one');
  s.f.release(); // the stalled close of the old file lands
  await settle();
  await s.clock.advance(2000);
  assert.deepEqual((await s.F.recent()).map(r => r.name), ['two.gengis'], 'the database still says two.gengis');
  assert.equal((await s.F.recent())[0].handle, two);
  // an undo reads the link again: still the new file, and it is the one written from now on
  await s.undo();
  assert.equal(s.F.name, 'two.gengis');
  assert.equal(s.F.state, 'saving');
  edit(s, 'Edit two');
  await s.clock.advance(2000);
  assert.equal(JSON.parse(two.writable.written).name, 'Edit two');
  assert.equal(s.f.writes, 1, 'the old file is not written again');
  assert.equal(s.f.name(), 'Edit one');
});

test('Stop saving to the file while a close of it is stalled: the late close does not link it again', async () => {
  const s = await heldClose();
  const off = watch(s.F.unlink());
  await settle();
  assert.equal(off.done, true);
  assert.equal(s.F.state, 'none');
  s.f.release();
  await settle();
  await s.clock.advance(2000);
  assert.deepEqual(await s.F.recent(), [], 'no link in the database');
  await s.undo();
  assert.equal(s.F.name, null, 'and none after an undo');
  assert.equal(s.F.state, 'none');
  edit(s, 'Edit two');
  await s.clock.advance(2000);
  assert.equal(s.f.writes, 1, 'the file is left as it is');
});

test('another project linked to a file meanwhile does not stop a late close being noted for its own project', async () => {
  const conflict = s => s.toasts.some(t => /changed outside GenGIS/.test(t.msg));
  const rowOf = async (s, id) => (await s.F.recent()).find(r => r.id === id);
  // each: what happens to the other project (B) while the first one's close is stalled
  const other = {
    'Save as': async s => { s.files.handle = fakeHandle('bravo.gengis'); const w = watch(s.F.saveAs()); await settle(); assert.equal(w.done, true); assert.equal(s.F.name, 'bravo.gengis'); },
    'Save as, then Stop saving': async s => { await other['Save as'](s); const w = watch(s.F.unlink()); await settle(); assert.equal(w.done, true); }
  };
  for (const how of Object.keys(other)) {
    // the close lands while the other project is open
    const s = await heldClose();
    s.MB.loadProject({ id: 'B', name: 'Bravo' });
    await settle();
    await other[how](s);
    s.f.release();
    await settle();
    assert.equal((await rowOf(s, 'A')).lastWritten, s.f.mtime, how + ': the first project\'s row takes the time of its own late close');
    assert.equal((await rowOf(s, 'A')).name, 'alpha.gengis');
    s.MB.loadProject({ id: 'A', name: 'Edit one' });
    await settle();
    await s.clock.advance(2000);
    edit(s, 'Edit two');
    await s.clock.advance(2000);
    assert.equal(s.F.state, 'saving', how + ': still saved to its file');
    assert.equal(s.f.name(), 'Edit two');
    assert.equal(conflict(s), false, how + ': no false conflict');

    // the close lands after the first project was opened again
    const t = await heldClose();
    t.MB.loadProject({ id: 'B', name: 'Bravo' });
    await settle();
    await other[how](t);
    t.MB.loadProject({ id: 'A', name: 'Edit one' });
    await settle();
    t.f.release();
    await settle();
    await t.clock.advance(2000);
    assert.equal((await rowOf(t, 'A')).lastWritten, t.f.mtime, how + ' (opened again first): noted');
    edit(t, 'Edit two');
    await t.clock.advance(2000);
    assert.equal(t.F.state, 'saving', how + ' (opened again first): still saved to its file');
    assert.equal(t.f.name(), 'Edit two');
    assert.equal(conflict(t), false, how + ' (opened again first): no false conflict');
  }
});

test('an undo in the same moment a late close lands: the link in memory takes the time, and the next edit is no conflict', async () => {
  const s = await heldClose();
  s.f.release(); // the close lands...
  s.MB.loadProject({ id: 'A', name: 'Edit one' }, { keepHistory: true }); // ...as Ctrl+Z reads the link again
  await settle();
  await s.clock.advance(2000);
  edit(s, 'Edit two');
  await s.clock.advance(2000);
  assert.equal(s.F.state, 'saving');
  assert.equal(s.f.name(), 'Edit two');
  assert.ok(!s.toasts.some(t => /changed outside GenGIS/.test(t.msg)), 'no false conflict');
  assert.equal((await s.F.recent())[0].lastWritten, s.f.mtime);

  // the same for a write that answers in time, with an undo as it finishes
  const q = await linked();
  const f = slowFile(q, () => 0);
  edit(q, 'Edit one');
  await q.clock.advance(1999);
  q.clock.setTimeout(() => q.MB.loadProject({ id: 'A', name: 'Edit one' }, { keepHistory: true }), 1); // (with the write's start)
  await q.clock.advance(1);
  await q.clock.advance(2000);
  edit(q, 'Edit two');
  await q.clock.advance(2000);
  assert.equal(q.F.state, 'saving');
  assert.equal(f.name(), 'Edit two');
  assert.ok(!q.toasts.some(t => /changed outside GenGIS/.test(t.msg)));
});

test('a close that lands after another project opened is still noted as GenGIS\'s own writing of that file', async () => {
  const s = await heldClose();
  s.MB.loadProject({ id: 'B', name: 'Bravo' });
  await settle();
  s.f.release();
  await settle();
  const rows = await s.F.recent();
  assert.deepEqual(rows.map(r => [r.id, r.name, r.lastWritten]), [['A', 'alpha.gengis', s.f.mtime]], 'its time is kept: no "changed outside GenGIS" when it is opened again');
  assert.equal(s.F.state, 'none', 'and nothing of it on the project now open');
  // opened again: its file is caught up without a conflict
  s.MB.loadProject({ id: 'A', name: 'Edit one' });
  await settle();
  edit(s, 'Edit two');
  await s.clock.advance(2000);
  assert.equal(s.f.name(), 'Edit two');
  assert.ok(!s.toasts.some(t => /changed outside GenGIS/.test(t.msg)));
});

test('an undo while a close is stalled: the late close does not leave the file with what was undone, nor make a conflict of it', async () => {
  const s = await linked();
  const f = slowFile(s, k => (k === 1 ? 'held' : 0));
  edit(s, 'Edit one');
  await s.clock.advance(2000); // the write of the edit: its close stalls
  assert.equal(f.writes, 1);
  // Ctrl+Z: the project is opened again as it was (and its link read again from the database: a copy of it)
  s.MB.loadProject({ id: 'A', name: 'Alpha' }, { keepHistory: true });
  await settle();
  await s.clock.advance(2000); // the write of the undone project waits its turn
  await s.clock.advance(8000); // the first is given up on; the second completes
  assert.equal(f.name(), 'Alpha');
  f.release();                 // the first close lands after all, over it
  await settle();
  assert.equal(f.name(), 'Edit one', '(the file went back to what was undone)');
  await s.clock.advance(2000);
  assert.equal(f.name(), 'Alpha', 'written again with the project as it is');
  assert.equal(s.F.state, 'saving');
  // and the next edit is saved: the late close was GenGIS's own writing, not a change made elsewhere
  edit(s, 'Edit three');
  await s.clock.advance(2000);
  assert.equal(f.name(), 'Edit three');
  assert.equal(s.F.state, 'saving');
  assert.ok(!s.toasts.some(t => /changed outside GenGIS/.test(t.msg)), 'no false conflict');
});

test('a half-open project stays unsaved through an undo on it, and any project opened whole ends that', async () => {
  const half = async () => {
    const s = sandbox({ seed: both() });
    s.MB.newProject = () => s.MB.loadProject({ id: 'N', name: 'Untitled map' });
    await s.P.start();
    await settle();
    const real = s.MB.loadProject;
    s.MB.loadProject = p => { s.MB.loadProject = real; s.MB.state.projectId = p.id; throw new Error('bad layer'); };
    assert.equal(await s.P.open('B'), false);
    assert.equal(s.P.readOnly, true);
    return s;
  };
  // edits on the half, then Ctrl+Z: the half is "opened" again under the other project's id, and this tab gets to
  // edit that project. Still nothing is saved from it.
  const s = await half();
  s.MB.loadProject({ id: 'B', name: 'Half of Bravo' }, { keepHistory: true });
  await settle();
  assert.equal(s.P.readOnly, true, 'still read-only');
  assert.equal(s.P.owns(), false);
  assert.match(s.banner(), /A project did not open completely/);
  s.P.schedule();
  await s.clock.advance(5000);
  assert.equal(await s.P.save(), false, 'a save asked for is refused too');
  assert.equal((await s.P.get('B')).name, 'Bravo', 'what is saved for it is untouched');

  // each way a project is opened whole ends it: a new map, a file or a cloud copy (they call MB.loadProject)
  for (const [how, act] of [['new map', x => x.P.startFresh()], ['file or cloud', x => x.MB.loadProject({ id: 'C', name: 'Charlie' })], ['Recent projects', x => x.P.open('A')]]) {
    const x = await half();
    await act(x);
    await settle();
    assert.equal(x.P.readOnly, false, how + ': editable again');
    assert.equal(x.P.owns(), true, how + ': and saved from');
    assert.equal(x.banner(), '', how + ': the banner is gone');
  }
});

/* ---------- a file or a cloud copy that does not load ---------- */

test('a project file that fails while loading: said, read-only, nothing saved from the half, until a project opens whole', async () => {
  const s = sandbox({ seed: both(), modules: ['projectstore.js', 'storage.js'] });
  await s.P.start();
  await settle();
  assert.equal(s.P.owns(), true);
  const real = s.MB.loadProject;
  // (the map already cleared and the file's id in place when it fails, as a load that breaks half-way leaves it)
  s.MB.loadProject = p => { s.MB.loadProject = real; s.MB.state.projectId = p.id; s.MB.state.projectName = 'Half of it'; throw new Error('layers is not a list'); };
  const marked = [];
  const mark = s.P.markFileBacked;
  s.P.markFileBacked = () => { marked.push(s.MB.state.projectId); mark(); };
  assert.equal(await s.MB.openText(JSON.stringify({ id: 'B', name: 'Bravo from a file', layers: 5 }), 'bravo.gengis'), null, 'not opened');
  assert.deepEqual(s.toasts.map(t => t.msg), ['Could not open file: layers is not a list']);
  assert.deepEqual(marked, [], 'and not a file-backed project');
  assert.equal(s.P.readOnly, true);
  assert.equal(s.P.owns(), false);
  assert.match(s.banner(), /A project did not open completely/);
  // an edit on the half, an undo of it (the half "opened" again, under the file's id): still nothing is saved
  s.P.schedule();
  s.MB.loadProject({ id: 'B', name: 'Half of it' }, { keepHistory: true });
  await settle();
  await s.clock.advance(5000);
  assert.equal(await s.P.save(), false);
  assert.equal(s.P.readOnly, true);
  assert.equal((await s.P.get('B')).name, 'Bravo', 'what is saved for that project is untouched');
  // a file that loads ends it
  assert.equal(await s.MB.openText(JSON.stringify({ id: 'C', name: 'Charlie' }), 'charlie.gengis'), 'project');
  await settle();
  assert.equal(s.P.readOnly, false);
  assert.equal(s.P.owns(), true);
  assert.equal(s.banner(), '');
  assert.deepEqual(marked, ['C']);

  // a file that cannot even be read as one never got as far as the map: said, and the open project stays editable
  const t = sandbox({ seed: both(), modules: ['projectstore.js', 'storage.js'] });
  await t.P.start();
  await settle();
  assert.equal(await t.MB.openText('{ not json', 'x.gengis'), null);
  assert.equal(t.toasts.length, 1);
  assert.equal(t.P.readOnly, false);
  assert.equal(t.P.owns(), true);
});

test('source: a project opened from a file or from the cloud that fails while loading is not saved from either', () => {
  const st = src('storage.js'), cs = src('cloudsync.js');
  const guarded = /try \{ MB\.loadProject\((p|data|data, \{ keepView: true, keepHistory: false \})\); \}\s*catch \(e\) \{ MB\.projects\.loadFailed\(\); throw e; \}/g;
  assert.equal((st.match(guarded) || []).length, 1, 'the file open');
  assert.equal((cs.match(guarded) || []).length, 2, 'the cloud open, and a cloud copy taken into the open project');
  // no other way in: every MB.loadProject outside project.js is guarded, or is undo and redo (store.js), which open
  // the project the map already holds
  for (const f of fs.readdirSync(path.join(ROOT, 'js')).filter(x => x.endsWith('.js') && x !== 'project.js')) {
    const calls = src(f).split('\n').filter(l => /MB\.loadProject\(/.test(l) && !/^\s*\/\//.test(l));
    calls.forEach(l => assert.ok(/try \{|keepHistory: true|^\s*MB\.loadProject\(rec\.data\);$|if \(rec && \(!mirrorOpened|^\s*MB\.loadProject\(p\);$/.test(l), f + ': ' + l.trim()));
  }
  // on the failure nothing goes on as if it had opened: no file-backed mark, no cloud link saved
  const open = st.split('MB.openText = async function (txt, name) {')[1].split('\n  };')[0];
  assert.ok(open.indexOf('MB.projects.loadFailed(); throw e;') < open.indexOf('MB.projects.markFileBacked();'));
  assert.match(open, /\} catch \(e\) \{ MB\.toast\('Could not open file: ' \+ e\.message\); return null; \}/, 'said');
  const remote = cs.split('C.openRemote = async function (accId, fileId) {')[1].split('\n  };')[0];
  const fail = remote.lastIndexOf('MB.projects.loadFailed(); throw e;');
  assert.ok(fail > 0 && fail < remote.lastIndexOf('MB.projects.markFileBacked();') && fail < remote.lastIndexOf('saveLink(l)'));
  assert.match(src('projectstore.js'), /P\.loadFailed = loadFailed;/);
  assert.match(src('cloudui.js'), /try \{ ok = await C\(\)\.openRemote\(accId, fileId\); \}\s*catch \(e\) \{[^\n]*MB\.toast\('Could not open it: '/, 'the cloud dialog says why');
});

/* ---------- the source: what the behavior above rests on ---------- */

test('source: every wait for a project file on the way to another project is bounded', () => {
  const ps = src('projectstore.js');
  const confirm = ps.split('P.confirmReplace = async function (what, icon) {')[1].split('\n  };')[0];
  assert.match(confirm, /what, 'Cancel', \{ yesIcon: icon \}\);/, 'the question keeps its icon');
  assert.doesNotMatch(confirm, /writePending\(\)/, 'no bare wait in confirmReplace');
  assert.match(confirm, /await fileCaughtUp\(MB\.desktopFiles\);[^\n]*\n\s*await fileCaughtUp\(MB\.browserFiles\);/, 'both files go through the bounded wait');
  const caught = ps.split('async function fileCaughtUp(files) {')[1].split('\n  }')[0];
  assert.match(caught, /Promise\.race\(\[files\.writePending\(\), new Promise\(\(res, rej\) => \{ t = setTimeout\([^\n]*FILE_WAIT\); \}\)\]\)/);
  assert.match(caught, /catch \(e\) \{\s*console\.warn\([^\n]*\n\s*MB\.toast\('Could not finish saving the project file first; it is still saved in the app\.', 5000\);/);
  assert.match(caught, /finally \{ clearTimeout\(t\); \}/);
  assert.equal((ps.match(/writePending\(\)/g) || []).length, 1, 'the only wait for a file in the project store');
  assert.match(ps, /const FILE_WAIT = 8000;/);
});

test('source: the browser\'s file calls in a background write all carry a time limit', () => {
  const bf = src('browserfiles.js');
  assert.match(bf, /const WRITE_TIMEOUT = 8000;/);
  assert.match(bf, /function withTimeout\(promise, ms, label\) \{[\s\S]*?Promise\.race\(\[promise, [\s\S]*?new Error\(\(label \|\| 'file operation'\) \+ ' timed out'\)[\s\S]*?\.finally\(\(\) => clearTimeout\(t\)\);/);
  const write = bf.split('async function write(force) {')[1].split('\n  }')[0];
  for (const call of ['e.handle.getFile()', 'opening', 'w.write(JSON.stringify(p, null, 1))', 'closing', 'note()']) {
    assert.ok(write.includes('bound(' + call + ','), call + ' is bounded');
  }
  // every await in the write is one of: the permission check (bounded itself) or a bounded call
  const awaits = write.split('} catch (err) {')[0].match(/await [^;]*/g) || [];
  awaits.forEach(a => assert.match(a, /^await (allowed\(false\)|bound\()/, a));
  // the file takes its own project only: checked on the open project's id, before serializing and on what was serialized
  assert.match(write, /const mine = \(\) => entry === e && MB\.state\.projectId === e\.id;[\s\S]*?\n    if \(!mine\(\)\) return false;\s*const ok = await allowed\(false\);\s*if \(!mine\(\)\) return false;/);
  assert.match(write, /const \{ p, text, unchanged \} = current\(\);\s*if \(p\.id !== e\.id\) return false;/);
  // a write of a project no longer open changes nothing of the open one's status
  // (the open project's link by its id and its file, not by the object: an undo reads the link again, a copy)
  assert.match(write, /const linked = linkCount\(e\.id\), same = \(\) => linkCount\(e\.id\) === linked;/, 'its own project\'s link changes, no other project\'s');
  assert.match(write, /open = \(\) => \(entry && entry\.id === e\.id && same\(\) \? entry : null\);/);
  assert.match(bf, /const links = new Map\(\);/);
  assert.match(bf, /relinked\(entry\.id\);[\s\S]*relinked\(entry\.id\);\s*entry = null;/, 'counted on a link made (adopt) and on one removed (unlink), for that project');
  assert.match(write, /const now = open\(\);\s*if \(!now\) return;[\s\S]*?now\.lastWritten = e\.lastWritten;\s*lastId = p\.id; lastText = text;/, 'the link in memory takes the time too');
  assert.match(write, /if \(open\(\)\) show\('conflict'\);/);
  assert.match(write, /if \(open\(\)\) \{ failed = true; show\(F\.state === 'saving' \? 'saving' : F\.state, msg\); \}/);
  assert.doesNotMatch(write, /^ {4,8}(show\(|failed = )/m, 'no status change outside a check of the open project');
  // a close that lands late: noted as the save it is (not written again for nothing), and a write scheduled that
  // only writes if the project differs from it
  assert.match(write, /closing\.then\(async \(\) => \{\s*e\.lastWritten = [^\n]*\n\s*await note\(\);\s*if \(!open\(\)\) return;\s*landed\(true\);\s*F\.schedule\(\);/);
  assert.match(write, /lastId = p\.id; lastText = text;\s*if \(!late\) failed = false;/, 'a late save keeps the failure said (once, for a file that is always slow)');
  // the database row is the project's link as it is now, never the write's own (maybe replaced or removed since)
  assert.match(write, /const row = open\(\) \|\| \(same\(\) \? e : null\);\s*if \(!row\) return null;\s*row\.lastWritten = e\.lastWritten;\s*return putEntry\(row\);/);
  assert.equal((write.match(/putEntry\(/g) || []).length, 1, 'the only write of the link from a file write');
  assert.doesNotMatch(write, /lastText = null/, 'never forgotten: that made a slow file write itself forever');
  const allowed = bf.split('async function allowed(ask) {')[1].split('\n  }')[0];
  assert.match(allowed, /await withTimeout\(e\.handle\.queryPermission\(RW\), WRITE_TIMEOUT, [^)]*\)\.catch\(\(\) => 'prompt'\)/, 'the question is bounded');
  assert.match(allowed, /if \(s !== 'granted' && ask\) s = await e\.handle\.requestPermission\(RW\);/, 'asking the user is not: it waits for them');
  assert.doesNotMatch(allowed, /withTimeout\([^)]*requestPermission/);
});

test('source: Recent projects closes once the project is open, not before, and an open that fails is said', () => {
  const ps = src('projectstore.js');
  const handler = ps.split("box.querySelectorAll('[data-open]')")[1].split('\n    }));')[0];
  const open = handler.indexOf('ok = await P.open(b.dataset.open);'), hide = handler.indexOf("dlg.classList.add('hidden')");
  assert.ok(open > 0 && hide > open, 'opened first, hidden after');
  assert.match(handler, /if \(ok\) dlg\.classList\.add\('hidden'\);\s*else \{ held\.forEach\(x => \{ x\.disabled = false; \}\);/);
  // one open at a time: every button of the lists (the other rows' Open, Delete, Restore) is off meanwhile
  assert.match(handler, /if \(b\.disabled\) return;\s*const held = Array\.from\(box\.querySelectorAll\('\.recent-list button'\)\)\.filter\(x => !x\.disabled\);\s*held\.forEach\(x => \{ x\.disabled = true; \}\);/);
  assert.ok(handler.indexOf('x.disabled = true') < open, 'before the open starts');
  assert.match(ps, /confirmReplace\('Open the other project', 'open'\)/);
  assert.match(ps, /confirmReplace\('Restore the earlier copy', 'history'\)/);
  const p = ps.split('P.open = async function (id) {')[1].split('\n  };')[0];
  assert.match(p, /try \{[\s\S]*MB\.loadProject\(rec\.data\);\s*\} catch \(e\) \{[\s\S]*?MB\.toast\('Could not open "' \+ [\s\S]*?, 6000\);[\s\S]*?return false;\s*\}/);
  assert.ok(p.indexOf('P.fileBacked = !!rec.fileBacked;') > p.indexOf('return false;\n    }'), 'the flag only once it opened');
  // the other ways a saved project replaces the open one
  const restore = ps.split('P.restore = async function (key) {')[1].split('\n  };')[0];
  assert.match(restore, /try \{ MB\.loadProject\(snap\.data\); \}\s*catch \(e\) \{[\s\S]*?MB\.toast\([\s\S]*?return false;/);
  const take = ps.split('async function takeOverNow() {')[1].split('\n  };')[0];
  assert.match(take, /try \{ MB\.loadProject\(saved\.data\); \}\s*catch \(e\) \{[\s\S]*?MB\.toast\([\s\S]*?owned = false;\s*loadFailed\(\);\s*return;/, 'nothing half-opened is saved from here');
  // a load that failed may have left half a project: read-only, in the open and the restore too
  assert.match(p, /if \(rec\) loadFailed\(\);[^\n]*\n\s*return false;\s*\}/);
  assert.match(restore, /loadFailed\(\);\s*return false;\s*\}/);
  assert.match(ps, /function loadFailed\(\) \{ broken = true; setReadOnly\(true, 'failed'\); \}/);
  // and it stays read-only, whoever asks, until a project opens whole (any way one is opened: project.js says so)
  assert.match(ps, /const canWrite = \(\) => P\.ready && !P\.readOnly && !broken && /);
  assert.match(ps, /function setReadOnly\(on, why\) \{\s*if \(broken\) \{ on = true; why = 'failed'; \}/);
  assert.match(ps, /MB\.on\('project-opened', loadedWhole\);/);
  assert.equal((ps.match(/^ +broken = false;/gm) || []).length, 1, 'ended in one place only: loadedWhole');
  assert.match(src('project.js'), /if \(!opts\.keepHistory\) \{ MB\.resetHistory\(\); MB\.emit\('project-opened'\); \}/);
  for (const f of ['storage.js', 'cloudsync.js']) assert.doesNotMatch(src(f), /loadProject\([^)]*keepHistory: true/, f + ' opens projects whole (so they end it too)');
  assert.match(handler, /else \{ held\.forEach\(x => \{ x\.disabled = false; \}\); b\.focus\(\); \}/, 'the focus back on the button pressed');
});

test('source: a project\'s extras (base map, opacity, live sources, view) cannot stop it being announced', () => {
  const pj = src('project.js');
  const load = pj.match(/function loadProject\(p, opts\) \{[\s\S]*?\n  \}/)[0];
  assert.ok(load.indexOf('p = migrate(p || {});') < load.indexOf('MB.clearAll();'), 'a file that cannot be read leaves the open project alone');
  const tail = load.split('MB.applyZOrder();')[1];
  assert.match(tail, /const extra = \(what, fn\) => \{ try \{ fn\(\); \} catch \(e\) \{ console\.warn\(/);
  // between the objects and the events, every statement of the function's own is an extra(...)
  const own = tail.split("MB.emit('units'")[0].split(/\r?\n/).filter(l => /^ {4}\S/.test(l) && !/^ {4}(\/\/|\}\);)/.test(l));
  assert.ok(own.length >= 7, 'the extras found');
  own.forEach(l => assert.match(l, /^ {4}(const extra = |extra\(')/, l));
  for (const call of ['MB.setBasemap(key)', 'MB.data.applyOpacity()', 'applyTraffic(p.liveTraffic)', 'applyVessels(p.vesselTraffic)', 'applyDrones(p.drones)', 'MB.map.setView(']) {
    const at = tail.indexOf(call);
    assert.ok(at > 0 && at < tail.indexOf("MB.emit('units'"), call + ' is before the events');
  }
  assert.match(tail, /Number\.isFinite\(v\.lat\) && Number\.isFinite\(v\.lng\) && Number\.isFinite\(v\.zoom\)\) MB\.map\.setView\(\[v\.lat, v\.lng\], v\.zoom\);/);
  assert.match(tail, /MB\.emit\('units', MB\.state\.units\);\s*MB\.emit\('layers'\);\s*MB\.emit\('features'\);\s*MB\.emit\('project'\);\s*\/\/[^\n]*\n\s*if \(!opts\.keepHistory\) \{ MB\.resetHistory\(\); MB\.emit\('project-opened'\); \}\s*\}$/);
});
