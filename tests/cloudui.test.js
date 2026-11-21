'use strict';
// The Cloud sync dialog (js/cloudui.js) follows the name typed in the top bar: the open project's row shows the
// name as it is now, not the one the last save wrote, and the rows are drawn again when that save lands.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const tick = ms => new Promise(r => setTimeout(r, ms || 0));

// A stand-in for the elements the dialog makes: it keeps the HTML it is given, and hands out the one box the
// dialog draws into. Nothing is parsed: the tests read the HTML. _els answers querySelectorAll, so a test that
// needs a button wired (the conflict choices) can put one there for the selector the dialog binds.
function fakeEl(tag) {
  const classes = new Set();
  const self = {
    tagName: String(tag || 'div').toUpperCase(), type: '', id: '', dataset: {}, style: {}, scrollTop: 0, hidden: false, textContent: '', title: '',
    _html: '', _box: null, _els: {},
    classList: {
      add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
      toggle: (c, on) => { if (on === undefined ? classes.has(c) : !on) classes.delete(c); else classes.add(c); }
    },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
    get innerHTML() { return self._html; },
    set innerHTML(h) { self._html = String(h); },
    setAttribute(k, v) { self.dataset['attr_' + k] = v; },
    appendChild: c => c, insertAdjacentElement: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    focus: () => {}, contains: () => false, remove: () => {},
    querySelector: sel => (sel === '.modal-box' ? (self._box = self._box || fakeEl('div')) : (self._els[sel] || [])[0] || null),
    querySelectorAll: sel => self._els[sel] || []
  };
  return self;
}

// A button in the drawn HTML, for the one selector the dialog binds it by: it keeps the handler it is given.
function fakeBtn(data) {
  const b = fakeEl('button');
  b.dataset = data;
  b.disabled = false;
  b.addEventListener = (type, fn) => { b._click = type === 'click' ? fn : b._click; };
  return b;
}

// isDraft as the project store has it (js/projectstore.js): still "Untitled map" and never saved to a file.
const isDraft = r => /^\s*untitled( map)?\s*$/i.test(r.name || '') && !r.fileBacked;

function load(o) {
  o = o || {};
  const log = [];
  const records = o.records || [{ id: 'p1', name: 'Untitled map', objects: 2, savedAt: 1, fileBacked: false }];
  const listeners = {};
  let flushResolve = null, resolveDone = null, resolveFailed = null;
  const flushed = new Promise(res => { flushResolve = res; });
  const resolved = new Promise((res, rej) => { resolveDone = res; resolveFailed = rej; });
  const projects = {
    fileBacked: !!o.fileBacked,
    isDraft,
    owns: () => o.owns !== false,
    list: () => { log.push('list'); return Promise.resolve(records.map(r => Object.assign({}, r))); },
    flush: () => { log.push('flush'); return o.flushNow === false ? flushed : Promise.resolve(true); },
    get: async () => null,
    open: async () => false
  };
  const cloud = {
    ready: true, links: {}, progress: {}, lastError: '',
    accounts: o.accounts || [{ id: 'a1', provider: 'onedrive', name: 'Tester', email: 't@example.com', kind: 'personal', state: 'ok', auto: false }],
    offered: () => ['onedrive'],
    status: id => (o.status || {})[id] || null,
    accountOf: () => null,
    resolve: () => { log.push('resolve'); return o.resolveNow === false ? resolved : Promise.resolve(); },
    pull() {}, syncNow: async () => {}, listCloud: async () => []
  };
  const MB = {
    escapeHtml: esc,
    modalCloseHtml: '<button type="button" class="modal-x" data-act="close"></button>',
    ICON: Object.fromEntries(['close', 'refresh', 'signin', 'logout', 'warn', 'copy', 'cloudDown', 'cloudUp'].map(k => [k, `<svg data-i="${k}"></svg>`])),
    iconBtn: (icon, title, attrs) => `<button type="button" class="icon-btn mini" title="${esc(title)}"${attrs ? ' ' + attrs : ''}><svg data-i="${esc(icon)}"></svg></button>`,
    state: { projectId: o.projectId || 'p1', projectName: o.projectName || 'Harbor survey' },
    projects, cloud,
    cloudProviders: { onedrive: { name: 'OneDrive', bin: 'It goes to the recycle bin.', preload() {} } },
    ui: {
      wireDialog() {}, openDialog(d) { d.classList.remove('hidden'); }, closeDialog(d) { d.classList.add('hidden'); },
      commitName() { log.push('commit'); if (o.onCommit) o.onCommit(MB); }
    },
    toast() {}, ask: async () => false,
    on: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    emit: (type, arg) => (listeners[type] || []).forEach(fn => fn(arg))
  };
  MB.btnInner = (icon, label) => (MB.ICON[icon] || '') + '<span class="btn-label">' + esc(label) + '</span>';
  const made = []; // every element the module makes: the dialog, and the two buttons beside the save status
  const document = {
    activeElement: null, body: fakeEl('body'),
    createElement: tag => { const el = fakeEl(tag); made.push(el); return el; },
    getElementById: id => (id === 'saveStatus' ? fakeEl('span') : null),
    querySelectorAll: () => []
  };
  const ctx = { window: { MB }, document, console, Date, Math, CSS: { escape: s => String(s) }, setTimeout, clearTimeout, Promise };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/cloudui.js'), 'utf8'), ctx, { filename: 'js/cloudui.js' });
  MB.cloudUI.init();
  return { MB, U: MB.cloudUI, log, records, document, made, flushResolve, resolveDone, resolveFailed };
}

// The HTML the dialog last drew into its box.
function boxHtml(U) {
  const dlg = U._testDlg;
  return dlg ? dlg.querySelector('.modal-box').innerHTML : '';
}
// One project's row in that HTML: the piece that holds its sync switch.
function rowOf(html, id) {
  const hit = html.split('<div class="cloud-row').find(p => p.includes(`data-sync="${id}"`));
  return hit ? '<div class="cloud-row' + hit : '';
}

// The module keeps its dialog to itself: the fake document notes the elements it makes, so the tests can read it.
function open(o) {
  const ld = load(o);
  ld.U.open();
  ld.U._testDlg = ld.made.find(el => el.id === 'cloudDialog');
  return ld;
}

test('the open project\'s row shows the name typed in the top bar, not the one the last save wrote', async () => {
  const ld = open({});
  await tick(20);
  const html = boxHtml(ld.U);
  const row = rowOf(html, 'p1');
  assert.match(row, /<b>Harbor survey<\/b>/, 'the live name');
  assert.doesNotMatch(row, /Untitled map/, 'not the stored one');
  assert.doesNotMatch(row, /Name it to sync/, 'a named project is no draft');
  assert.doesNotMatch(row, /data-sync="p1"[^>]*disabled/, 'its sync switch can be used');
});

test('opening takes the name as typed before it reads the projects, and draws again once the save has landed', async () => {
  const ld = open({ flushNow: false, projectName: 'Untitled map', onCommit: MB => { MB.state.projectName = 'Typed name'; } });
  await tick(20);
  assert.deepEqual(ld.log.slice(0, 2), ['commit', 'list'], 'the name is committed before the records are read');
  assert.ok(ld.log.includes('flush'), 'the pending save is flushed');
  assert.match(rowOf(boxHtml(ld.U), 'p1'), /<b>Typed name<\/b>/, 'the first draw already shows it');
  const reads = ld.log.filter(x => x === 'list').length;
  ld.records[0].name = 'Typed name'; // the save landed
  ld.flushResolve(true);
  await tick(20);
  assert.equal(ld.log.filter(x => x === 'list').length, reads + 1, 'the rows are drawn again from the saved records');
});

test('a save landing while the dialog is open draws the rows again', async () => {
  const ld = open({});
  await tick(20);
  const reads = ld.log.filter(x => x === 'list').length;
  ld.MB.state.projectName = 'Renamed later';
  ld.records[0].name = 'Renamed later';
  ld.MB.emit('saved', 'p1'); // no 'cloudsync': with "Sync all projects" off nothing else re-renders
  await tick(200); await tick(0);
  assert.ok(ld.log.filter(x => x === 'list').length > reads, 'the saved project is read again');
  assert.match(rowOf(boxHtml(ld.U), 'p1'), /<b>Renamed later<\/b>/);
});

test('a project still called "Untitled map" is a draft: it says so, and its sync switch is off and disabled', async () => {
  const ld = open({
    projectName: 'Untitled map',
    records: [{ id: 'p1', name: 'Untitled map', objects: 1, savedAt: 2, fileBacked: false }, { id: 'p2', name: 'Untitled', objects: 0, savedAt: 1, fileBacked: false }]
  });
  await tick(20);
  const html = boxHtml(ld.U);
  assert.match(rowOf(html, 'p1'), /Name it to sync/, 'the open one');
  assert.match(rowOf(html, 'p1'), /data-sync="p1"[^>]*disabled/);
  assert.match(rowOf(html, 'p2'), /Name it to sync/, 'another device-only draft is left as it is');
  assert.match(rowOf(html, 'p2'), /data-sync="p2"[^>]*disabled/);
});

test('an untitled map that was saved to a file is no draft: the row carries this tab\'s file state too', async () => {
  const ld = open({ projectName: 'Untitled map', fileBacked: true });
  await tick(20);
  const row = rowOf(boxHtml(ld.U), 'p1');
  assert.match(row, /<b>Untitled map<\/b>/);
  assert.doesNotMatch(row, /Name it to sync/, 'it has a file: it can sync');
  assert.doesNotMatch(row, /data-sync="p1"[^>]*disabled/);
});

test('a tab that only shows the project (another has it open) leaves every row as it was saved', async () => {
  const ld = open({ owns: false });
  await tick(20);
  const row = rowOf(boxHtml(ld.U), 'p1');
  assert.match(row, /<b>Untitled map<\/b>/, 'the record, not this tab\'s name');
  assert.match(row, /Name it to sync/);
});

// A conflict row with its three choices wired, the resolve left hanging: what the click starts.
async function conflictStarted(o) {
  const ld = open(Object.assign({ status: { p1: 'conflict' }, resolveNow: false }, o));
  await tick(20);
  assert.match(rowOf(boxHtml(ld.U), 'p1'), /data-resolve="both"(?![^>]*disabled)/, 'the choices are there to be made');
  const btns = ['both', 'cloud', 'mine'].map(k => fakeBtn({ resolve: k, id: 'p1' }));
  const box = ld.U._testDlg.querySelector('.modal-box');
  box._els['[data-resolve]'] = btns;
  box._els['[data-resolve][data-id="p1"]'] = btns;
  await ld.U.render();
  btns[0]._click();
  return { ld, btns };
}

test('a choice being carried out keeps the three conflict buttons disabled through every redraw', async () => {
  const { ld, btns } = await conflictStarted();
  assert.ok(btns.every(b => b.disabled), 'the buttons on screen go quiet at once');
  assert.ok(ld.log.includes('resolve'), 'the resolve was started');
  // the resolve flushes the project: the save emits 'saved', which draws the rows again
  ld.MB.emit('saved', 'p1');
  await tick(200);
  const row = rowOf(boxHtml(ld.U), 'p1');
  for (const k of ['both', 'cloud', 'mine']) assert.match(row, new RegExp(`data-resolve="${k}"[^>]*disabled`), k + ' stays disabled while it runs');
  // a second click while it runs starts nothing more
  const before = ld.log.filter(x => x === 'resolve').length;
  btns[1]._click();
  assert.equal(ld.log.filter(x => x === 'resolve').length, before);
  // it went through: the choices are live again (for as long as the row is still a conflict)
  ld.resolveDone();
  await tick(200);
  assert.match(rowOf(boxHtml(ld.U), 'p1'), /data-resolve="both"(?![^>]*disabled)/);
});

test('a resolve that fails gives the choices back, it does not leave the row stuck', async () => {
  const { ld } = await conflictStarted();
  ld.resolveFailed(new Error('offline'));
  await tick(200);
  assert.match(rowOf(boxHtml(ld.U), 'p1'), /data-resolve="mine"(?![^>]*disabled)/);
});

test('each of the three conflict choices leads with its own drawing', async () => {
  const ld = open({ status: { p1: 'conflict' } });
  await tick(20);
  const row = rowOf(boxHtml(ld.U), 'p1');
  assert.match(row, /<svg data-i="copy"><\/svg>Keep both/);
  assert.match(row, /<svg data-i="cloudDown"><\/svg>Use cloud/, 'the cloud\'s version comes down');
  assert.match(row, /<svg data-i="cloudUp"><\/svg>Use mine/, 'this version goes up');
  for (const k of ['both', 'cloud', 'mine']) assert.match(row, new RegExp(`data-resolve="${k}"[^>]*>\\s*<svg`), k + ': the icon is inside the button');
});

test('the button beside the save status keeps its icon: its words are written only when what it asks for changes', () => {
  const status = { p1: 'signin' };
  const ld = load({ status });
  const act = ld.made.find(el => el.id === 'cloudAction');
  assert.ok(act, '#cloudAction was made');
  assert.equal(act.innerHTML, '<svg data-i="signin"></svg><span class="btn-label">Sign in</span>', 'signed out: the door');
  assert.equal(act.textContent, '', 'the words are in the button\'s HTML, not written over its icon');
  assert.ok(act.className.split(' ').includes('with-icon'), 'the class that puts the icon beside the words');
  assert.equal(act.hidden, false);
  // the same state again: nothing is rebuilt (the icon would flicker on every sync message)
  act.innerHTML = 'kept';
  ld.MB.emit('cloudsync');
  assert.equal(act.innerHTML, 'kept');
  // a conflict instead: the warning triangle and Resolve
  status.p1 = 'conflict';
  ld.MB.emit('cloudsync');
  assert.equal(act.innerHTML, '<svg data-i="warn"></svg><span class="btn-label">Resolve</span>');
  assert.match(act.title, /^Edited here and in the cloud/);
});

test('a name with a quote or a tag in it is escaped in the row it is put into', async () => {
  const ld = open({ projectName: '<b>Bad</b> "name"' });
  await tick(20);
  const html = boxHtml(ld.U);
  assert.match(html, /&lt;b&gt;Bad&lt;\/b&gt; &quot;name&quot;/);
  assert.doesNotMatch(html, /<b>Bad<\/b>/);
});
