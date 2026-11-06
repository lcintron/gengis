#!/usr/bin/env node
/* GenGIS - the Android test APK built on this machine (CI builds the same one in .github/workflows/android.yml).
 *   node scripts/android-build.js              build out/gengis-debug.apk
 *   node scripts/android-build.js --install    ... then install it on the running emulator or phone (adb) and open it
 *   node scripts/android-build.js --emulator   start an emulator (AVD=<name>, or the first one Android Studio has)
 * Steps: the web files into www/, the android/ project added the first time (npx cap add android), synced and made
 * GenGIS's own (scripts/android-prepare.js), then Gradle's debug build. Needs JDK 21+ (Android Studio's own, or
 * JAVA_HOME) and the Android SDK (ANDROID_HOME, or where Android Studio puts it). Local debug builds are signed with
 * this machine's debug key (~/.android/debug.keystore), which stays the same between builds. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ANDROID = path.join(ROOT, 'android');
const APP_ID = JSON.parse(fs.readFileSync(path.join(ROOT, 'capacitor.config.json'), 'utf8')).appId;
const WIN = process.platform === 'win32';
const OUT = path.join(ROOT, 'out', 'gengis-debug.apk');
const args = new Set(process.argv.slice(2));

const fail = msg => { console.error('\nandroid-build: ' + msg); process.exit(1); };
const step = msg => console.log('\n> ' + msg);
const exe = name => (WIN ? name + '.exe' : name);
const quote = a => (/[\s"&|<>^()]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a);

// one command, run through the shell (npx and gradlew are scripts on Windows); stops the build when it fails
function run(cmd, list, opts = {}) {
  const r = spawnSync([cmd, ...list].map(quote).join(' '), { stdio: 'inherit', shell: true, cwd: ROOT, ...opts });
  if (r.status !== 0) fail(`${path.basename(cmd)} ${list.join(' ')} failed (exit ${r.status})`);
}
const output = (cmd, list) => {
  const r = spawnSync(cmd, list, { encoding: 'utf8' });
  return r.error ? null : (r.stdout || '') + (r.stderr || '');
};

/* ---------- JDK 21+ ---------- */
function javaMajor(home) {
  const java = path.join(home, 'bin', exe('java'));
  if (!fs.existsSync(java)) return 0;
  const m = /version "(\d+)(?:\.(\d+))?/.exec(output(java, ['-version']) || '');
  return m ? Number(m[1] === '1' ? m[2] : m[1]) : 0;
}
function findJdk() {
  const dirs = [];
  const under = parent => { try { for (const d of fs.readdirSync(parent)) dirs.push(path.join(parent, d)); } catch {} };
  if (process.env.JAVA_HOME) dirs.push(process.env.JAVA_HOME);
  if (WIN) {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    dirs.push(path.join(pf, 'Android', 'Android Studio', 'jbr'));
    for (const v of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'Amazon Corretto']) under(path.join(pf, v));
  } else if (process.platform === 'darwin') {
    dirs.push('/Applications/Android Studio.app/Contents/jbr/Contents/Home');
    for (const d of fs.existsSync('/Library/Java/JavaVirtualMachines') ? fs.readdirSync('/Library/Java/JavaVirtualMachines') : [])
      dirs.push(path.join('/Library/Java/JavaVirtualMachines', d, 'Contents', 'Home'));
  } else {
    dirs.push('/opt/android-studio/jbr', path.join(os.homedir(), 'android-studio', 'jbr'));
    under('/usr/lib/jvm');
  }
  const best = dirs.map(d => ({ d, v: javaMajor(d) })).filter(j => j.v >= 21).sort((a, b) => b.v - a.v)[0];
  if (!best) fail('no JDK 21 or newer found (the Android build needs it). Install the current Android Studio, which '
    + 'brings one, or a JDK 21 (Windows: winget install Microsoft.OpenJDK.21), or set JAVA_HOME to one.');
  return best.d;
}

/* ---------- Android SDK and its tools ---------- */
function findSdk() {
  const dirs = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    WIN ? path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk') : null,
    path.join(os.homedir(), 'Library', 'Android', 'sdk'), path.join(os.homedir(), 'Android', 'Sdk')].filter(Boolean);
  const sdk = dirs.find(d => fs.existsSync(path.join(d, 'platform-tools')));
  if (!sdk) fail('no Android SDK found. Install Android Studio (it sets one up), or set ANDROID_HOME to it.');
  return sdk;
}
const SDK = findSdk();
const ADB = path.join(SDK, 'platform-tools', exe('adb'));
const EMULATOR = path.join(SDK, 'emulator', exe('emulator'));
const devices = () => (output(ADB, ['devices']) || '').split('\n').slice(1).filter(l => /\tdevice\b/.test(l));

/* ---------- emulator ---------- */
function startEmulator() {
  if (!fs.existsSync(EMULATOR)) fail('no emulator in the SDK: add it in Android Studio (SDK Manager > SDK Tools)');
  if (devices().some(l => l.startsWith('emulator-'))) { console.log('An emulator is already running.'); return; }
  const avds = (output(EMULATOR, ['-list-avds']) || '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('INFO'));
  const avd = process.env.AVD || avds[0];
  if (!avd) fail('no virtual device: make one in Android Studio (Device Manager)');
  if (!avds.includes(avd)) fail(`no virtual device called ${avd}. There are: ${avds.join(', ') || 'none'}`);
  step(`Starting the emulator (${avd})`);
  spawn(EMULATOR, ['-avd', avd], { detached: true, stdio: 'ignore' }).unref();
  run(ADB, ['wait-for-device']);
  for (let i = 0; i < 120; i++) {   // up to 2 minutes for Android to finish starting
    if ((output(ADB, ['shell', 'getprop', 'sys.boot_completed']) || '').trim() === '1') { console.log('Ready.'); return; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);   // a second's pause
  }
  fail('the emulator did not finish starting in 2 minutes');
}

/* ---------- build ---------- */
function build() {
  const env = { ...process.env, JAVA_HOME: findJdk(), ANDROID_HOME: SDK };
  console.log(`JDK: ${env.JAVA_HOME}\nSDK: ${SDK}`);
  step('Web files');
  run(process.execPath, [path.join('scripts', 'build-web.js')]);
  if (!fs.existsSync(path.join(ANDROID, 'app'))) { step('Android project (first build)'); run('npx', ['cap', 'add', 'android'], { env }); }
  step('Android project sync');
  run('npx', ['cap', 'sync', 'android'], { env });
  run(process.execPath, [path.join('scripts', 'android-prepare.js')]);
  step('Debug APK (Gradle)');
  run(WIN ? 'gradlew.bat' : './gradlew', ['assembleDebug'], { cwd: ANDROID, env });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.copyFileSync(path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'), OUT);
  console.log(`\nBuilt ${path.relative(ROOT, OUT)}`);
}

function install() {
  const list = devices();
  if (!list.length) fail('no emulator or phone connected: run `make emulator`, or plug in a phone with USB debugging on');
  if (list.length > 1 && !process.env.ANDROID_SERIAL)
    fail('more than one device connected: set ANDROID_SERIAL to one of\n' + list.map(l => '  ' + l.split('\t')[0]).join('\n'));
  step('Installing on ' + (process.env.ANDROID_SERIAL || list[0].split('\t')[0]));
  run(ADB, ['install', '-r', OUT]);
  run(ADB, ['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);
  console.log('Opened. Its console: chrome://inspect in desktop Chrome. Native errors: adb logcat');
}

if (args.has('--emulator')) startEmulator();
else {
  build();
  if (args.has('--install')) install();
}
