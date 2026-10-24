#!/usr/bin/env node
/* GenGIS - the generated Android project (npx cap add android) made GenGIS's own. Idempotent: run after every
 * `npx cap sync android` (npm run android:sync does).
 * - permissions: location (the locate button), and plain-HTTP requests to receivers on the local network (dump1090,
 *   AIS-catcher), which Android refuses by default
 * - version: versionName from package.json, versionCode derived from it (0.16.3 -> 16003)
 * - release signing from environment variables, when they are set (CI: the upload key from GitHub secrets):
 *   GENGIS_KEYSTORE (path), GENGIS_KEYSTORE_PASSWORD, GENGIS_KEY_ALIAS, GENGIS_KEY_PASSWORD
 * - GenGIS's icons (launcher, round, adaptive) and splash screens instead of Capacitor's */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'android', 'app');
const RES = path.join(APP, 'src', 'main', 'res');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function edit(file, fn) {
  const before = fs.readFileSync(file, 'utf8'), after = fn(before);
  if (after !== before) fs.writeFileSync(file, after);
}
const fail = msg => { console.error('android-prepare: ' + msg); process.exit(1); };
if (!fs.existsSync(APP)) fail('no android/ project: run `npx cap add android` first');

/* ---------- manifest: permissions and plain HTTP ---------- */
edit(path.join(APP, 'src', 'main', 'AndroidManifest.xml'), s => {
  for (const p of ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION']) {
    const line = `<uses-permission android:name="android.permission.${p}" />`;
    if (!s.includes(line)) s = s.replace('</manifest>', `    ${line}\n</manifest>`);
  }
  if (!s.includes('android:usesCleartextTraffic')) s = s.replace('<application', '<application\n        android:usesCleartextTraffic="true"');
  return s;
});

/* ---------- version and signing ---------- */
const gradle = path.join(APP, 'build.gradle');
if (!fs.existsSync(gradle)) fail('android/app/build.gradle not found (a Kotlin DSL template?): update this script');
const [maj, min, pat] = String(pkg.version).split(/[.-]/).map(n => parseInt(n, 10) || 0);
const versionCode = maj * 1000000 + min * 1000 + pat;
edit(gradle, s => {
  s = s.replace(/versionCode\s+\d+/, 'versionCode ' + versionCode).replace(/versionName\s+"[^"]*"/, `versionName "${pkg.version}"`);
  if (!s.includes('signingConfigs')) {
    s = s.replace(/(\n\s*)buildTypes\s*\{/, `$1signingConfigs {
        release {
            def ks = System.getenv("GENGIS_KEYSTORE")
            if (ks) {
                storeFile file(ks)
                storePassword System.getenv("GENGIS_KEYSTORE_PASSWORD")
                keyAlias System.getenv("GENGIS_KEY_ALIAS")
                keyPassword System.getenv("GENGIS_KEY_PASSWORD")
            }
        }
    }$1buildTypes {`);
    // the release build type (the first "release {" after "buildTypes {") signs with it when it is set
    const at = s.indexOf('buildTypes {'), rel = s.indexOf('release {', at);
    if (at < 0 || rel < 0) fail('no buildTypes.release in build.gradle');
    const end = rel + 'release {'.length;
    s = s.slice(0, end) + '\n            if (System.getenv("GENGIS_KEYSTORE")) signingConfig signingConfigs.release' + s.slice(end);
  }
  return s;
});
const g = fs.readFileSync(gradle, 'utf8');
if (!/versionCode \d+/.test(g) || !g.includes('signingConfig signingConfigs.release')) fail('build.gradle was not patched as expected');

/* ---------- icons and splash ---------- */
const copyTo = (src, name, test) => {
  let n = 0;
  for (const d of fs.readdirSync(RES)) {
    if (!test(d)) continue;
    const f = path.join(RES, d, name);
    if (fs.existsSync(f)) { fs.copyFileSync(path.join(ROOT, src), f); n++; }
  }
  return n;
};
const mip = d => d.startsWith('mipmap');
const icons = copyTo('icons/icon-512.png', 'ic_launcher.png', mip) + copyTo('icons/icon-512.png', 'ic_launcher_round.png', mip) +
  copyTo('icons/icon-512-maskable.png', 'ic_launcher_foreground.png', mip);
const bg = path.join(RES, 'values', 'ic_launcher_background.xml');
if (fs.existsSync(bg)) edit(bg, s => s.replace(/(<color name="ic_launcher_background">)[^<]*(<\/color>)/, '$1#0B1118$2'));
const splash = copyTo('branding/splash/splash-1080x1920.png', 'splash.png', d => d.startsWith('drawable') && !d.includes('land')) +
  copyTo('branding/splash/splash-1920x1080.png', 'splash.png', d => d.startsWith('drawable') && d.includes('land'));
console.log(`android-prepare: version ${pkg.version} (${versionCode}), ${icons} icons, ${splash} splash images, permissions and signing set`);
