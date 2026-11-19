'use strict';
// A text's Size row in Properties keeps up with the Scale tool: the handles resize the text (js/scaletool.js), and
// the row shows the size it shows at now (js/ui.js) - the slider, its readout and the number box beside it - without
// applying or saving anything of its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ui = read('js/ui.js'), features = read('js/features.js'), scale = read('js/scaletool.js');

// The sync itself, as js/ui.js writes it, driven over a fake size row: the slider, its readout, the real sliders with
// their number boxes, and the real MB.textShownSize (the very formula the row is built from, out of js/features.js).
const SYNC = ui.match(/const sizeInp = \$\('\[data-k="textSize"\]', form\)[\s\S]*?\n      \};/)[0];
const SHOWN = features.match(/const zoomNow = \(\) => [\s\S]*?MB\.textShownSize = st => Math\.round\(shown\(st\)\);/)[0];
const STEPPER = ui.slice(ui.indexOf('function stepper(range)'), ui.indexOf('function enhanceSliders(root)'));

// One Size row of Properties: the slider with its px readout, and (opts.stepper) the number box the real stepper
// puts beside it.
function row(opts) {
  const L = { divIcon: o => ({ options: o }) };
  const ctx = { window: {}, L, console, Math, Date, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.createContext(ctx);
  vm.runInContext(read('js/util.js'), ctx, { filename: 'util.js' });
  const MB = ctx.window.MB, calls = [], dispatched = [];
  ctx.MB = MB;
  MB.ui = {};
  MB.map = { getZoom: () => (opts.zoom == null ? 12 : opts.zoom) };
  vm.runInContext(SHOWN, ctx, { filename: 'textShownSize' });
  MB.applyStyle = () => calls.push('applyStyle');
  MB.commit = () => calls.push('commit');
  MB.commitDebounced = () => calls.push('commitDebounced');
  MB.setLabel = () => calls.push('setLabel');
  // the few DOM pieces a size row and the stepper around it use
  const el = (tag, attrs) => Object.assign({
    tagName: tag.toUpperCase(), dataset: {}, style: {}, title: '', hidden: false, disabled: false, children: [], handlers: {},
    classList: { toggle() {}, contains: () => false },
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); },
    dispatchEvent(ev) { dispatched.push(ev.type); (this.handlers[ev.type] || []).forEach(fn => fn(ev)); return true; },
    fire(t) { this.dispatchEvent({ type: t }); },
    after() {}, closest: () => null, select() {}, focus() {}, blur() {},
    querySelector(sel) { return this.children.find(c => c.tagName === sel.toUpperCase()) || null; },
    querySelectorAll(sel) { return this.children.filter(c => c.tagName === sel.toUpperCase()); }
  }, attrs || {});
  const out = el('span', { textContent: opts.value + 'px', classList: { toggle() {}, contains: c => c === 'val' } });
  const inp = el('input', { type: 'range', value: String(opts.value), min: String(opts.min), max: String(opts.max), step: '1',
    dataset: { softMax: '400' }, nextElementSibling: out }); // as styleForm builds it: data-soft-max="400"
  const num = el('input'), up = el('button', { dataset: { d: '1' } }), down = el('button', { dataset: { d: '-1' } });
  const box = el('span', { children: [num, up, down] });
  Object.assign(ctx, { document: { createElement: () => box }, MutationObserver: class { observe() {} },
    Event: class { constructor(t) { this.type = t; } }, esc: s => String(s) });
  vm.runInContext(STEPPER, ctx, { filename: 'stepper' });
  if (opts.stepper) vm.runInContext('stepper(range);', Object.assign(ctx, { range: inp }), { filename: 'stepper-run' });
  ctx.m = { style: opts.style };
  ctx.form = {};
  ctx.$ = sel => (sel === '[data-k="textSize"]' ? inp : sel === '[data-val="textSize"]' ? out : null);
  const sync = vm.runInContext('(() => { let textSizeSync = null;\n' + SYNC + '\nreturn textSizeSync; })()', ctx, { filename: 'textSizeSync' });
  return { MB, inp, out, num, up, down, calls, dispatched, sync, shown: () => MB.textShownSize(opts.style) };
}

test('the Size row shows the size a text shows at now: the slider and its px readout, set outright', () => {
  // the Scale tool's handles grew the text from 24 px to 60 (js/scaletool.js applies the style, with no commit)
  const r = row({ value: 24, min: 8, max: 64, style: { textSize: 60, textScale: 'screen' } });
  assert.equal(r.shown(), 60);
  r.sync();
  assert.equal(r.inp.value, '60', 'the slider is where the text is now');
  assert.equal(r.out.textContent, '60px', 'and so is its readout');
  assert.deepEqual(r.calls, [], 'nothing applied, nothing saved');
  assert.deepEqual(r.dispatched, [], 'and no event dispatched');
  assert.equal(r.inp.max, '64', 'the slider keeps the end it had');
  assert.equal(r.inp.min, '8');
});

test('the number box beside the slider follows the sync too, with no input or change event dispatched', () => {
  const r = row({ value: 24, min: 8, max: 64, stepper: true, style: { textSize: 60, textScale: 'screen' } });
  assert.equal(+r.num.value, 24, 'the box as the row was built');
  assert.equal(r.out.hidden, true, 'the plain readout is hidden: the box is what is on screen');
  r.sync();
  assert.equal(r.inp.value, '60');
  assert.equal(+r.num.value, 60, 'the number on screen is the size the text is now');
  assert.equal(+r.num.min, 8);
  assert.equal(+r.num.max, 400, 'typed sizes still go to the end data-soft-max allows');
  assert.deepEqual(r.dispatched, [], 'the slider fired nothing: nothing behind it re-applied or saved the size');
  assert.deepEqual(r.calls, []);
  // and the box arrows step on from the size it is now
  r.up.dispatchEvent({ type: 'pointerdown', button: 0, preventDefault() {} });
  r.up.fire('pointerup'); // (held down it would repeat)
  assert.equal(r.inp.value, '61');
  assert.equal(+r.num.value, 61);
});

test('a text resized past the end of its slider widens it; one shrunk below its low end lowers it (never under 1)', () => {
  let r = row({ value: 24, min: 8, max: 64, stepper: true, style: { textSize: 120, textScale: 'screen' } });
  r.sync();
  assert.equal(r.inp.max, '120', 'the slider reaches the size the text is now');
  assert.equal(r.inp.value, '120');
  assert.equal(r.out.textContent, '120px');
  assert.equal(+r.num.value, 120);
  // a text that scales with the map, zoomed out: 12 px at zoom 10 shows at 3 px at zoom 8
  r = row({ value: 12, min: 8, max: 64, zoom: 8, stepper: true, style: { textSize: 12, textScale: 'map', textRefZoom: 10 } });
  assert.equal(r.shown(), 3);
  r.sync();
  assert.equal(r.inp.min, '3', 'the low end follows it down');
  assert.equal(r.inp.value, '3');
  assert.equal(r.out.textContent, '3px');
  assert.equal(+r.num.value, 3);
  assert.equal(+r.num.min, 3, 'and the box takes the end the slider has now');
  // zoomed right out it shows at a fraction of a pixel: the slider's end stays a size of its own (as a label's does)
  r = row({ value: 12, min: 8, max: 64, zoom: 0, style: { textSize: 12, textScale: 'map', textRefZoom: 10 } });
  assert.equal(r.shown(), 0);
  r.sync();
  assert.equal(r.inp.min, '1');
});

test('the size it already shows is no change at all: the row is left untouched', () => {
  const r = row({ value: 32, min: 8, max: 64, stepper: true, style: { textSize: 32, textScale: 'screen' } });
  r.out.textContent = 'untouched';
  r.sync();
  assert.equal(r.inp.value, '32');
  assert.equal(r.out.textContent, 'untouched', 'no readout rewritten');
  assert.equal(+r.num.value, 32);
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.dispatched, []);
});

test('a size slider with no number box yet is set all the same: nothing throws', () => {
  const r = row({ value: 24, min: 8, max: 64, style: { textSize: 48, textScale: 'screen' } }); // (no stepper: a row just built)
  assert.doesNotThrow(() => r.sync());
  assert.equal(r.inp.value, '48');
  assert.match(ui, /MB\.ui\.showSlider = range => \{ if \(range && range\._mbShow\) range\._mbShow\(\); \};/);
  assert.match(ui, /range\._mbShow = show; \/\/ for MB\.ui\.showSlider/, 'every slider keeps the one hand its box needs');
  assert.match(SYNC, /MB\.ui\.showSlider\(sizeInp\);/);
});

test('the Size row reads the text\'s style afresh each time, and changes nothing in it', () => {
  const style = { textSize: 40, textScale: 'screen' };
  const r = row({ value: 24, min: 8, max: 64, stepper: true, style });
  r.sync();
  assert.equal(r.inp.value, '40');
  style.textSize = 90; // another drag of the handles
  r.sync();
  assert.equal(r.inp.value, '90', 'never a size captured when the panel was drawn');
  assert.equal(+r.num.value, 90);
  assert.deepEqual(style, { textSize: 90, textScale: 'screen' }, 'the style is as the drag left it');
  assert.doesNotMatch(SYNC, /applyStyle|setLabel|commit|dispatchEvent/, 'the sync applies nothing and saves nothing');
});

test('the Size row belongs to the selected text alone, and goes with every redraw of Properties', () => {
  assert.match(ui, /let textSizeSync = null; \/\/ and a text's Size row, so the Scale tool's handles can/);
  assert.match(ui, /textSizeSync = null;\s*\/\/ \(and the text form its size row\)/, 'cleared whenever the panel is drawn anew');
  assert.equal((ui.match(/textSizeSync/g) || []).length, 5, 'one declaration, one clearing, one row, and the call (guarded)');
  // the row is set in the text branch only: not by the "New shapes" default style form, nor a measure style
  const txt = ui.slice(ui.indexOf("if (m.type === 'text') {"), ui.indexOf("} else if (m.type === 'svg') {"));
  assert.match(txt, /if \(sizeInp\) textSizeSync = \(\) => \{/);
  const defaults = ui.slice(ui.indexOf('<h3>New shapes</h3>'), ui.indexOf('const m = f.mb;'));
  assert.doesNotMatch(defaults, /textSizeSync/, 'the defaults form has a size slider of its own and syncs nothing');
  // and only the object shown in Properties has its row refreshed
  assert.match(ui, /MB\.on\('featurechange', l => \{ if \(l === MB\.selected\) \{ MB\.ui\.renderMeasureBox\(\); if \(rotSync\) rotSync\(\); if \(textSizeSync\) textSizeSync\(\); \} \}\);/);
});

test('a Scale drag of a text is what refreshes the row: once at the end, never per frame', () => {
  // the drag resizes the text with nothing committed, and the end of it emits featurechange and commits once
  assert.match(scale, /MB\.applyStyle\(layer, \{ textSize: Math\.max\(4, Math\.min\(400, Math\.round\(sn\.size \* s\)\)\) \}, \{ noCommit: true \}\);/);
  const end = scale.match(/\n    end\(\) \{[\s\S]*?\n    \},/)[0];
  assert.match(end, /this\.targets\.forEach\(l => MB\.emit\('featurechange', l\)\);/);
  assert.match(end, /MB\.commit\(\(d\.rot \? 'rotate' : 'scale'\)/);
  const transform = scale.match(/function transform\(sn, to, s, ax, ay\) \{[\s\S]*?\n  \}/)[0];
  assert.doesNotMatch(transform, /featurechange/, 'nothing per frame of the drag: the row follows when it is let go');
  // Esc puts the size back and emits none: the row was never touched during the drag, so it shows that size already
  const cancel = scale.match(/\n    cancel\(\) \{[\s\S]*?\n    \},/)[0];
  assert.match(cancel, /this\.drag\.snaps\.forEach\(restore\);/);
  assert.doesNotMatch(cancel, /featurechange/);
  assert.match(scale, /function restore\(sn\) \{[\s\S]*?else if \(t === 'text'\) \{ Object\.assign\(layer\.mb\.style, o\.style\);/, 'the style it had: the size the row still shows');
});

test('undo and redo draw Properties anew, so no stale Size row is left pointing at the old slider', () => {
  const store = read('js/store.js'), project = read('js/project.js');
  for (const fn of ['MB.undo', 'MB.redo']) {
    const body = store.match(new RegExp(fn.replace('.', '\\.') + ' = function \\(\\) \\{[\\s\\S]*?\\n  \\};'))[0];
    assert.match(body, /MB\.loadProject\(JSON\.parse\(snap\.json\), \{ keepView: true, keepHistory: true \}\);/, fn);
  }
  const load = project.match(/function loadProject\(p, opts\) \{[\s\S]*?\n  \}/)[0];
  assert.match(load, /MB\.clearAll\(\);/, 'every object is rebuilt: the old layers (and their style objects) are gone');
  assert.match(load, /MB\.emit\('units', MB\.state\.units\);/);
  assert.match(read('js/features.js'), /MB\.clearAll = function \(\) \{\s*\n\s*MB\.deselect\(\);/);
  assert.match(ui, /MB\.on\('units', u => \{[\s\S]*?MB\.ui\.renderProps\(\);/, 'which draws Properties anew');
  assert.match(ui, /MB\.on\('selection', l => \{[\s\S]*?MB\.ui\.renderProps\(\);/, 'as a selection change does');
  // renderProps empties the panel and drops the row before building anything
  const head = ui.slice(ui.indexOf('MB.ui.renderProps = function ()'), ui.indexOf("$('#propsSub')"));
  assert.match(head, /panel\.innerHTML = '';[\s\S]*textSizeSync = null;/);
});
