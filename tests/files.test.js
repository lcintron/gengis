'use strict';
// The desktop app's project files on disk (electron/files.js), in Node with a stand-in Electron: writing a file so
// that it is either the old one or the new one, even while another process holds it open for a moment (on Windows an
// antivirus, the search indexer or another copy of the app).
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp-files-')); // (a folder of this run's own; removed afterwards)
const electron = {
  app: { getPath: () => TMP },
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: {}, shell: {}, net: {}, BrowserWindow: {}
};
const load = Module._load;
Module._load = function (req) { if (req === 'electron') return electron; return load.apply(this, arguments); };
const files = require('../electron/files');
Module._load = load;

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

// The rename refused the first `times` tries, as Windows refuses it while the file is held open.
function holdOff(times, code) {
  const real = fs.renameSync;
  let left = times, tries = 0;
  fs.renameSync = (a, b) => { tries++; if (left-- > 0) throw Object.assign(new Error(code + ': busy'), { code }); return real(a, b); };
  return { tries: () => tries, undo: () => { fs.renameSync = real; } };
}
const temps = () => fs.readdirSync(TMP).filter(f => /\.tmp$/.test(f));

test('a project is written whole: the file is the new one, and no temporary file stays behind', () => {
  const file = path.join(TMP, 'sub', 'a.gengis');
  files.writeAtomic(file, 'one');
  files.writeAtomic(file, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  assert.deepEqual(fs.readdirSync(path.join(TMP, 'sub')).filter(f => /\.tmp$/.test(f)), []);
});

test('the file held open for a moment: the rename is tried again, and the old content is never lost', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const file = path.join(TMP, 'held.gengis');
    fs.writeFileSync(file, 'old');
    const h = holdOff(3, code);
    try { files.writeAtomic(file, 'new ' + code); } finally { h.undo(); }
    assert.equal(fs.readFileSync(file, 'utf8'), 'new ' + code, code);
    assert.equal(h.tries(), 4, code + ': tried again until it went through');
    assert.deepEqual(temps(), [], code + ': no temporary file left');
  }
});

test('held all the way: the file is written over in place rather than the save being lost', () => {
  const file = path.join(TMP, 'stubborn.gengis');
  fs.writeFileSync(file, 'old');
  const h = holdOff(99, 'EPERM');
  const started = Date.now();
  try { files.writeAtomic(file, 'new'); } finally { h.undo(); }
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.ok(h.tries() > 1 && h.tries() <= 8, 'a few tries, not an endless loop: ' + h.tries());
  assert.ok(Date.now() - started < 5000, 'and a short wait between them');
  assert.deepEqual(temps(), []);
});

test('an error that is not a file held open throws at once, and the temporary file goes', () => {
  const file = path.join(TMP, 'broken.gengis');
  const h = holdOff(99, 'ENOSPC');
  try { assert.throws(() => files.writeAtomic(file, 'new'), e => e.code === 'ENOSPC'); } finally { h.undo(); }
  assert.equal(h.tries(), 1, 'not tried again');
  assert.ok(!fs.existsSync(file));
  assert.deepEqual(temps(), []);
});
