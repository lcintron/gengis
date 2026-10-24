#!/usr/bin/env node
/* GenGIS - the web app as the Android app carries it: the same files the site and the desktop app ship, copied into
 * www/ (Capacitor's webDir). Run before `npx cap sync android` (npm run android:sync does both). */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'www');
// what the app needs at run time (as in package.json build.files, without the desktop app's own code)
const FILES = ['index.html', 'sw.js', 'manifest.webmanifest', 'LICENSE'];
const DIRS = ['css', 'js', 'vendor', 'data', 'icons', 'branding/splash'];

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
FILES.forEach(f => fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f)));
DIRS.forEach(d => copyDir(path.join(ROOT, d), path.join(OUT, d)));
let n = 0;
(function count(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) count(path.join(d, e.name)); else n++; } })(OUT);
console.log('www/: ' + n + ' files');
