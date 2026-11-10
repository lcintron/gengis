#!/usr/bin/env node
/* GenGIS - the Android test APK built on this machine (CI builds the same one in .github/workflows/android.yml).
 *   node scripts/android-build.js              build out/gengis-debug.apk
 *   node scripts/android-build.js --install    ... then install it on the running emulator or phone (adb) and open it
 *   node scripts/android-build.js --emulator   start an emulator (AVD=<name>, or the first one Android Studio has)
 *   node scripts/android-build.js --clean      stop Gradle and remove the generated android/ and www/ (make android-clean)
 * Steps: the web files into www/, the android/ project added the first time (cap add android), synced and made
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
const WIN = process.platform === 'win32';
const OUT = path.join(ROOT, 'out', 'gengis-debug.apk');
const GRADLEW = path.join(ANDROID, WIN ? 'gradlew.bat' : 'gradlew');
const CAP = path.join(ROOT, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');   // Capacitor's CLI, run by node

const fail = msg => { console.error('\nandroid-build: ' + msg); process.exit(1); };
const step = msg => console.log('\n> ' + msg);
const exe = name => (WIN ? name + '.exe' : name);
// one argument for cmd.exe (only .bat files go through it): quoted when needed, with the backslashes before a quote
// doubled as the program's own argument parsing expects (inside quotes cmd still expands %NAME% of a set variable)
const cmdQuote = a => (/[\s"&|<>^()%!,;=']/.test(a) ? '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"' : a);

// one command, started directly (no shell) except a .bat on Windows, which needs cmd
const exec = (cmd, list, opts = {}) => (WIN && /\.(bat|cmd)$/i.test(cmd)
  ? spawnSync([cmd, ...list].map(cmdQuote).join(' '), { stdio: 'inherit', shell: true, cwd: ROOT, ...opts })
  : spawnSync(cmd, list, { stdio: 'inherit', cwd: ROOT, ...opts }));
// ... that stops the build when it fails
function run(cmd, list, opts = {}) {
  const { hint, ...o } = opts;
  const r = exec(cmd, list, o);
  if (r.status !== 0) fail(`${path.basename(cmd)} ${list.join(' ')} failed (${r.error ? r.error.message : 'exit ' + r.status})`
    + (hint ? '\n' + hint : ''));
}
const output = (cmd, list, env) => {
  const r = spawnSync(cmd, list, { encoding: 'utf8', env: env || process.env });
  return r.error ? null : (r.stdout || '') + (r.stderr || '');
};
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/* ---------- JDK 21+ ---------- */
// the newest Java each Gradle version runs on (docs.gradle.org/current/userguide/compatibility.html)
const GRADLE_FOR_JAVA = { 21: '8.5', 22: '8.8', 23: '8.10', 24: '8.14', 25: '9.1' };
const versionAtLeast = (v, min) => {
  const a = v.split('.').map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
  return true;
};
// whether that Gradle runs on that Java (a Java newer than the table: not known to, so no)
const gradleRunsOn = (gradle, java) => !gradle || (GRADLE_FOR_JAVA[java] ? versionAtLeast(gradle, GRADLE_FOR_JAVA[java]) : false);

/* The JDK to build with, from [{ dir, version }]: JAVA_HOME when it is 21 or newer and the project's Gradle (when known)
 * runs on it; else exactly 21, else the lowest above 21 (a newer one is likelier to be too new for Gradle). */
function chooseJdk(candidates, javaHome, gradle) {
  const ok = candidates.filter(j => j.version >= 21);
  const home = javaHome && ok.find(j => path.resolve(j.dir) === path.resolve(javaHome));
  if (home && gradleRunsOn(gradle, home.version)) return home.dir;
  const best = ok.slice().sort((a, b) => a.version - b.version)[0];
  return best ? best.dir : null;
}

function javaMajor(home) {
  const java = path.join(home, 'bin', exe('java'));
  if (!fs.existsSync(java)) return 0;
  const m = /version "(\d+)(?:\.(\d+))?/.exec(output(java, ['-version']) || '');
  return m ? Number(m[1] === '1' ? m[2] : m[1]) : 0;
}
// the Gradle version the android/ project's wrapper uses (none before the project is made)
function wrapperGradle() {
  try {
    const p = fs.readFileSync(path.join(ANDROID, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf8');
    return (/gradle-([\d.]+)-(?:all|bin)\.zip/.exec(p) || [])[1] || null;
  } catch { return null; }
}
// the JDK folders on this machine: JAVA_HOME, Android Studio's own (every install), the usual JDK folders, the java on PATH
function jdkDirs() {
  const dirs = [];
  const under = (parent, sub = '') => { try { for (const d of fs.readdirSync(parent)) dirs.push(path.join(parent, d, sub)); } catch {} };
  if (process.env.JAVA_HOME) dirs.push(process.env.JAVA_HOME);
  if (WIN) {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    under(path.join(pf, 'Android'), 'jbr');   // Android Studio, Android Studio2, ...
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Android Studio', 'jbr'));   // Toolbox
    for (const v of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'Amazon Corretto']) under(path.join(pf, v));
  } else if (process.platform === 'darwin') {
    dirs.push('/Applications/Android Studio.app/Contents/jbr/Contents/Home');
    under('/Library/Java/JavaVirtualMachines', path.join('Contents', 'Home'));
  } else {
    dirs.push('/opt/android-studio/jbr', path.join(os.homedir(), 'android-studio', 'jbr'));
    under('/usr/lib/jvm');
  }
  const home = /java\.home = (.+)/.exec(output('java', ['-XshowSettings:properties', '-version']) || '');
  if (home) dirs.push(home[1].trim());
  const seen = new Set();
  return dirs.filter(d => { const k = WIN ? path.resolve(d).toLowerCase() : path.resolve(d); return !seen.has(k) && seen.add(k); });
}
function findJdk() {
  return chooseJdk(jdkDirs().map(dir => ({ dir, version: javaMajor(dir) })), process.env.JAVA_HOME, wrapperGradle());
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
// `adb devices` as [{ serial, state }] (state: device, offline, unauthorized, ...)
const parseDevices = text => (text || '').split(/\r?\n/)
  .map(l => /^(\S+)\t(\S+)/.exec(l)).filter(Boolean).map(m => ({ serial: m[1], state: m[2] }));
let SDK, ADB, EMULATOR;
function sdkTools() {
  SDK = findSdk();
  ADB = path.join(SDK, 'platform-tools', exe('adb'));
  EMULATOR = path.join(SDK, 'emulator', exe('emulator'));
}
const devices = () => parseDevices(output(ADB, ['devices']));

/* ---------- emulator ---------- */
function startEmulator() {
  if (!fs.existsSync(EMULATOR)) fail('no emulator in the SDK: add it in Android Studio (SDK Manager > SDK Tools)');
  if (devices().some(d => d.serial.startsWith('emulator-'))) { console.log('An emulator is already running.'); return; }
  const avds = (output(EMULATOR, ['-list-avds']) || '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('INFO'));
  const avd = process.env.AVD || avds[0];
  if (!avd) fail('no virtual device: make one in Android Studio (Device Manager)');
  if (!avds.includes(avd)) fail(`no virtual device called ${avd}. There are: ${avds.join(', ') || 'none'}`);
  step(`Starting the emulator (${avd})`);
  spawn(EMULATOR, ['-avd', avd], { detached: true, stdio: 'ignore' }).unref();
  // only the new emulator is asked (by its serial, which also overrides ANDROID_SERIAL), never a phone plugged in
  for (let i = 0; i < 180; i++) {   // up to 3 minutes for it to appear and Android to finish starting
    const emu = devices().find(d => d.serial.startsWith('emulator-'));
    if (emu && emu.state === 'device'
      && (output(ADB, ['-s', emu.serial, 'shell', 'getprop', 'sys.boot_completed']) || '').trim() === '1') {
      console.log(`Ready (${emu.serial}).`); return;
    }
    pause(1000);
  }
  fail('the emulator did not finish starting in 3 minutes');
}

/* ---------- build ---------- */
function build() {
  const jdk = findJdk();
  if (!jdk) fail('no JDK 21 or newer found (the Android build needs it). Install the current Android Studio, which '
    + 'brings one, or a JDK 21 (Windows: winget install Microsoft.OpenJDK.21), or set JAVA_HOME to one.');
  if (!fs.existsSync(CAP)) fail('Capacitor is not installed: run npm install (make apk does)');
  const env = { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: SDK };
  console.log(`JDK: ${env.JAVA_HOME}\nSDK: ${SDK}`);
  step('Web files');
  run(process.execPath, [path.join('scripts', 'build-web.js')]);
  if (!fs.existsSync(path.join(ANDROID, 'app'))) {
    step('Android project (first build)');
    run(process.execPath, [CAP, 'add', 'android'], { env,
      hint: fs.existsSync(ANDROID) ? 'android/ is there without its app: remove it with make android-clean, then build again' : '' });
  }
  step('Android project sync');
  run(process.execPath, [CAP, 'sync', 'android'], { env });
  run(process.execPath, [path.join('scripts', 'android-prepare.js')]);
  step('Debug APK (Gradle)');
  run(GRADLEW, ['assembleDebug'], { cwd: ANDROID, env });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.copyFileSync(path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'), OUT);
  console.log(`\nBuilt ${path.relative(ROOT, OUT)}`);
}

function install() {
  const appId = JSON.parse(fs.readFileSync(path.join(ROOT, 'capacitor.config.json'), 'utf8')).appId;
  const list = devices().filter(d => d.state === 'device');
  if (!list.length) fail('no emulator or phone connected: run `make emulator`, or plug in a phone with USB debugging on');
  if (list.length > 1 && !process.env.ANDROID_SERIAL)
    fail('more than one device connected: set ANDROID_SERIAL to one of\n' + list.map(d => '  ' + d.serial).join('\n'));
  step('Installing on ' + (process.env.ANDROID_SERIAL || list[0].serial));
  run(ADB, ['install', '-r', OUT]);
  run(ADB, ['shell', 'am', 'start', '-n', `${appId}/.MainActivity`]);
  console.log('Opened. Its console: chrome://inspect in desktop Chrome. Native errors: adb logcat');
}

// make android-clean: Gradle's daemon keeps files in android/ open (on Windows they can't be removed then), so it stops first
function clean() {
  if (fs.existsSync(GRADLEW)) {
    const jdk = findJdk();
    exec(GRADLEW, ['--stop'], { cwd: ANDROID, env: jdk ? { ...process.env, JAVA_HOME: jdk } : process.env });
  }
  for (const d of ['android', 'www']) {
    try { fs.rmSync(path.join(ROOT, d), { recursive: true, force: true, maxRetries: 3 }); } catch (e) {
      fail(`could not remove ${d}/ (${e.code || e.message}): a program still has files in it open (Android Studio, `
        + 'a Gradle daemon, an editor). Close it and run make android-clean again.');
    }
  }
}

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  if (args.has('--clean')) clean();
  else {
    sdkTools();
    if (args.has('--emulator')) startEmulator();
    else {
      build();
      if (args.has('--install')) install();
    }
  }
}

module.exports = { chooseJdk, gradleRunsOn, parseDevices, cmdQuote };
