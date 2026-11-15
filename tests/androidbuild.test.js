'use strict';
// scripts/android-build.js (make apk): which JDK it builds with, how it reads `adb devices`, and when the emulator
// counts as failed; scripts/android-prepare.js: the versionCode each version gets, and scripts/release.js never
// tagging a version that has none.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..');
const { chooseJdk, gradleRunsOn, parseDevices, cmdQuote, javaHomePaths, emulatorStopped, emulatorFailure } = require(path.join(ROOT, 'scripts', 'android-build.js'));
const { versionCode } = require(path.join(ROOT, 'scripts', 'android-prepare.js'));

const jdks = (...list) => list.map(([dir, version]) => ({ dir, version }));

test('the build takes JAVA_HOME when it is 21 or newer and the project\'s Gradle runs on it', () => {
  const found = jdks(['/jdk17', 17], ['/studio', 21], ['/jdk25', 25], ['/jdk23', 23]);
  assert.equal(chooseJdk(found, '/jdk23', '8.14.3'), '/jdk23');
  assert.equal(chooseJdk(found, '/jdk25', null), '/studio', 'no wrapper known: 21 rather than a newer JAVA_HOME');
  assert.equal(chooseJdk(found, '/jdk23', null), '/studio');
  assert.equal(chooseJdk(jdks(['/jdk21', 21], ['/studio', 21]), '/jdk21', null), '/jdk21', 'a JAVA_HOME of 21 still wins');
  assert.equal(chooseJdk(jdks(['/jdk17', 17], ['/jdk25', 25]), '/jdk25', null), '/jdk25', 'the only one 21+ is used');
  assert.equal(chooseJdk(found, '/jdk25', '8.14.3'), '/studio', 'Gradle 8.14 does not run on Java 25');
  assert.equal(chooseJdk(found, '/jdk25', '9.1.0'), '/jdk25');
  assert.equal(chooseJdk(found, '/jdk17', '8.14.3'), '/studio', 'a JAVA_HOME below 21 is passed over');
});

test('without a usable JAVA_HOME the build prefers exactly 21, then the lowest above it', () => {
  assert.equal(chooseJdk(jdks(['/jdk25', 25], ['/studio', 21], ['/jdk23', 23]), undefined, '8.14.3'), '/studio');
  assert.equal(chooseJdk(jdks(['/jdk25', 25], ['/jdk23', 23], ['/jdk17', 17]), '', '8.14.3'), '/jdk23');
  assert.equal(chooseJdk(jdks(['/jdk26', 26]), undefined, '8.14.3'), '/jdk26', 'the only one, even if too new');
  assert.equal(chooseJdk(jdks(['/jdk17', 17], ['/none', 0]), '/jdk17', null), null);
});

test('which Gradle runs on which Java', () => {
  assert.ok(gradleRunsOn('8.14.3', 24));
  assert.ok(!gradleRunsOn('8.13', 24));
  assert.ok(gradleRunsOn('8.10', 23));
  assert.ok(!gradleRunsOn('8.9', 23));
  assert.ok(!gradleRunsOn('9.4.0', 30), 'a Java newer than the table is not known to work');
});

test('`adb devices` is read as serials and states', () => {
  const text = 'List of devices attached\r\nR58M12345\tdevice\r\nemulator-5554\toffline\r\nZY22\tunauthorized\r\n\r\n';
  assert.deepEqual(parseDevices(text), [
    { serial: 'R58M12345', state: 'device' }, { serial: 'emulator-5554', state: 'offline' }, { serial: 'ZY22', state: 'unauthorized' }]);
  assert.deepEqual(parseDevices('* daemon started successfully\nList of devices attached\n'), []);
  assert.deepEqual(parseDevices(null), []);
});

test('on macOS the JDKs java_home knows are read from its output, whichever way it was asked', () => {
  const list = 'Matching Java Virtual Machines (3):\n'
    + '    25.0.1 (arm64) "Homebrew" - "OpenJDK 25.0.1" /opt/homebrew/Cellar/openjdk/25.0.1/libexec/openjdk.jdk/Contents/Home\n'
    + '    21.0.5 (arm64) "Eclipse Adoptium" - "OpenJDK 21.0.5" /Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home\n'
    + '    1.8.0_412, x86_64:\t"Java SE 8"\t/Library/Java/JavaVirtualMachines/jdk1.8.0_412.jdk/Contents/Home\n';
  assert.deepEqual(javaHomePaths(list), ['/opt/homebrew/Cellar/openjdk/25.0.1/libexec/openjdk.jdk/Contents/Home',
    '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home', '/Library/Java/JavaVirtualMachines/jdk1.8.0_412.jdk/Contents/Home']);
  assert.deepEqual(javaHomePaths('/Users/me/Library/Java/JavaVirtualMachines/jdk-21 one/Contents/Home\n'),
    ['/Users/me/Library/Java/JavaVirtualMachines/jdk-21 one/Contents/Home'], '`-v 21`: the path alone, spaces in it kept');
  assert.deepEqual(javaHomePaths('Unable to find any JVMs matching version "21".'), [], 'an error message holds none');
  assert.deepEqual(javaHomePaths(null), []);
});

test('an emulator that stops before Android starts says so at once, with what it exited with', () => {
  assert.match(emulatorStopped('Pixel_7', { code: 1, signal: null }), /^the emulator \(Pixel_7\) stopped before Android finished starting \(exit 1\)\./);
  assert.match(emulatorStopped('Pixel_7', { code: null, signal: 'SIGKILL' }), /\(killed by SIGKILL\)/);
  assert.match(emulatorStopped('Pixel_7', { error: new Error('spawn ENOENT') }), /\(spawn ENOENT\)/);
  assert.match(emulatorStopped('Pixel_7', { code: 1 }), /Device Manager/, 'and where to look');
});

test('a launcher that exits cleanly is no failure: only a code, a signal or a spawn error is', () => {
  assert.equal(emulatorFailure(0, null, null), null, 'exit 0: it may have handed the emulator over, so the wait goes on');
  assert.equal(emulatorFailure(null, null, null), null);
  assert.deepEqual(emulatorFailure(1, null, null), { code: 1 });
  assert.deepEqual(emulatorFailure(null, 'SIGKILL', null), { signal: 'SIGKILL' });
  const e = new Error('spawn ENOENT');
  assert.deepEqual(emulatorFailure(null, null, e), { error: e });
  assert.match(emulatorStopped('Pixel_7', emulatorFailure(2, null, null)), /\(exit 2\)/, 'and it is what the message is made of');
  assert.match(emulatorStopped('Pixel_7', emulatorFailure(null, 'SIGTERM', null)), /\(killed by SIGTERM\)/);
});

test('every Android versionCode grows with the version, and a pre-release comes before its release', () => {
  assert.equal(versionCode('0.19.0-Beta.0'), 1900030);
  assert.equal(versionCode('0.19.0-Beta.1'), 1900031);
  assert.equal(versionCode('0.19.0'), 1900099);
  assert.equal(versionCode('0.19.1'), 1900199);
  const order = ['0.19.0-alpha.0', '0.19.0-Beta.0', '0.19.0-Beta.1', '0.19.0-rc.0', '0.19.0-rc.1', '0.19.0', '0.19.1', '0.20.0-Beta.0', '1.0.0'].map(versionCode);
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, 'in order, and never two the same');
  assert.ok(versionCode('0.19.0') > 18003, 'above the codes of the releases up to 0.18.3 (Play refuses one that is not)');
  assert.equal(versionCode('0.19.0-rc'), 1900060, 'a label without a number');
  assert.equal(versionCode('0.19.0-BETA.2'), 1900032, 'however the label is written');
  assert.equal(versionCode('0.19.0-Beta.2+sha.5'), 1900032, 'build metadata orders nothing');
  assert.equal(versionCode('0.19.0+sha.5'), 1900099);
});

test('an Android versionCode that could not keep its order is refused, never quietly wrong (android-prepare exits)', () => {
  // the label changed part way through a cycle used to go backwards (Beta.3 -> 1900003, then rc.0 -> 1900000)
  assert.ok(versionCode('0.19.0-rc.0') > versionCode('0.19.0-Beta.3'), 'a later label still counts up');
  assert.throws(() => versionCode('0.19'), /not MAJOR\.MINOR\.PATCH/, 'a version of two numbers (it used to give NaN)');
  assert.throws(() => versionCode('0.19.0.1'), /not MAJOR\.MINOR\.PATCH/);
  assert.throws(() => versionCode(''), /not MAJOR\.MINOR\.PATCH/);
  assert.throws(() => versionCode('0.19.0-Beta.30'), /goes up to 29/, 'past its band: it would reach the next label');
  assert.throws(() => versionCode('0.19.0-preview.1'), /must be one of alpha, beta, rc/, 'a label this does not know how to order');
  for (const k of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.throws(() => versionCode('0.19.0-' + k + '.1'), /must be one of alpha, beta, rc/, 'a label every object has is no band: ' + k);
  }
  assert.throws(() => versionCode('0.19.0-Beta.1.2'), /a label and a number/);
  assert.throws(() => versionCode('0.19.1000'), /up to 999/);
  assert.throws(() => versionCode('0.1000.0'), /up to 999/, 'a number that would run into the one above it');
  assert.throws(() => versionCode('21.0.0'), /major versions stop at 20/, 'Play takes no code above 2100000000');
  assert.ok(versionCode('20.999.999') < 2100000000);
  // and the script stops rather than writing that code into build.gradle
  const prep = fs.readFileSync(path.join(ROOT, 'scripts', 'android-prepare.js'), 'utf8');
  assert.match(prep, /try \{ code = versionCode\(pkg\.version\); \} catch \(e\) \{ fail\(e\.message\); \}/);
});

test('every version a release can lead to has an Android versionCode: the release script checks before it tags', () => {
  const { nextVersion } = require(path.join(ROOT, 'scripts', 'release.js'));
  // the version the workflow's own flows lead to, from a release and from a pre-release of each label
  const from = ['0.18.3', '0.19.0-Beta.0', '0.19.0-rc.2', '0.19.0-alpha.9'];
  for (const cur of from) {
    for (const kind of ['patch', 'minor', 'major', 'prerelease']) {
      for (const pre of [null, 'Beta', 'rc', 'alpha', 'rc.1']) {
        const next = nextVersion(cur, kind, pre);
        assert.doesNotThrow(() => versionCode(next), `${cur} + ${kind} ${pre || '(no label)'} -> ${next}`);
      }
    }
  }
  assert.equal(nextVersion('0.18.3', 'prerelease', 'rc.1'), '0.18.4-rc.1', 'a label with its number in it keeps it (it used to become rc.1.0)');
  assert.equal(nextVersion('0.18.3', 'prerelease', 'rc'), '0.18.4-rc.0');
  assert.equal(nextVersion('0.18.3', 'prerelease', null), '0.18.4-Beta.0');
  assert.equal(nextVersion('0.18.4-rc.1', 'prerelease', null), '0.18.4-rc.2', 'the next one counts up');
  assert.equal(nextVersion('0.18.4-rc.2', 'patch', null), '0.18.4', 'and the release it leads to');
  // a label while on a pre-release of another one starts that label's own number, rather than being ignored
  assert.equal(nextVersion('0.19.1-Beta.0', 'prerelease', 'rc'), '0.19.1-rc.0');
  assert.equal(nextVersion('0.19.1-Beta.0', 'prerelease', 'Beta'), '0.19.1-Beta.1', 'the same label still counts up');
  assert.equal(nextVersion('0.19.1-Beta.0', 'prerelease', 'BETA'), '0.19.1-Beta.1', 'however it is written');
  assert.equal(nextVersion('0.19.1-Beta.0', 'prerelease', 'Beta.5'), '0.19.1-Beta.5', 'a number asked for by name');
  assert.ok(versionCode(nextVersion('0.19.1-Beta.0', 'prerelease', 'rc')) > versionCode('0.19.1-Beta.0'));
});

// scripts/release.js in a copy of its own (a fixed package.json and the files it rewrites), so that what the repo's
// version happens to be — a release or a pre-release — changes nothing here.
function fakeRepo(version) {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gengis-release-'));
  fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(path.join(dir, 'js'));
  for (const f of ['scripts/release.js', 'scripts/android-prepare.js']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'gengis', version }, null, 2));
  fs.writeFileSync(path.join(dir, 'js', 'util.js'), `MB.APP = { name: 'GenGIS', version: '${version}' };\n`);
  fs.writeFileSync(path.join(dir, 'sw.js'), `const VERSION = 'gengis-${version}'; // app version\n`);
  fs.writeFileSync(path.join(dir, 'index.html'), `<div class="ver">Version ${version}</div>\n`);
  const env = { ...process.env };
  delete env.GITHUB_OUTPUT; // (never append to the step's own output file)
  const run = (...a) => {
    const o = { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    try { return { status: 0, out: require('child_process').execFileSync(process.execPath, [path.join(dir, 'scripts', 'release.js'), ...a], o) }; }
    catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
  };
  return { dir, run, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a release of a version the Android app could not be built from stops before anything is written', () => {
  const repo = fakeRepo('0.19.0');
  try {
    const bad = repo.run('prerelease', '--pre=preview', '--dry');
    assert.equal(bad.status, 1, 'a dry run fails too, so the workflow never reaches the tag');
    assert.match(bad.out, /Not a version the Android app can be built from/);
    assert.match(bad.out, /must be one of alpha, beta, rc/);
    assert.ok(!/updated package\.json/.test(bad.out), 'and no file was even considered');
    const ok = repo.run('prerelease', '--pre=rc', '--dry');
    assert.equal(ok.status, 0);
    assert.match(ok.out, /0\.19\.0 -> 0\.19\.1-rc\.0/);
    assert.match(ok.out, /Dry run: nothing written, committed or tagged\./);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo.dir, 'package.json'), 'utf8')).version, '0.19.0', 'a dry run writes nothing');
  } finally { repo.clean(); }
});

test('a release whose Android versionCode would not grow is refused (a label that goes backwards, a number dropped)', () => {
  const repo = fakeRepo('0.19.0-Beta.3');
  try {
    // 0.19.0-Beta.3 is 1900033; these all come out at or below it
    for (const args of [['patch', '--pre=Beta'], ['patch', '--pre=alpha'], ['prerelease', '--pre=alpha']]) {
      const r = repo.run(...args, '--dry');
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.out, /The Android versionCode would not grow: 0\.19\.0-Beta\.3 is 1900033/, args.join(' '));
      assert.match(r.out, /Choose another bump, or a pre-release label that comes after this one/);
    }
    // the ways on from a Beta: the next Beta, an rc, or the release itself
    for (const [args, want] of [[['prerelease'], '0.19.0-Beta.4'], [['prerelease', '--pre=rc'], '0.19.0-rc.0'], [['patch'], '0.19.0'], [['minor'], '0.20.0']]) {
      const r = repo.run(...args, '--dry');
      assert.equal(r.status, 0, args.join(' ') + ': ' + r.out);
      assert.ok(r.out.startsWith('0.19.0-Beta.3 -> ' + want), args.join(' ') + ' -> ' + want + ', got: ' + r.out.split('\n')[0]);
    }
  } finally { repo.clean(); }
});

test('the Android project is not published with the site', () => {
  for (const wf of ['.github/workflows/pages.yml', '.github/workflows/release.yml']) {
    const yml = fs.readFileSync(path.join(ROOT, wf), 'utf8');
    const rsync = /rsync[\s\S]*?\.\/ site\//.exec(yml);
    assert.ok(rsync, wf + ': the rsync that assembles the site');
    assert.match(rsync[0], /--exclude 'android-src'/, wf);
    assert.match(rsync[0], /--exclude 'capacitor\.config\.json'/, wf);
  }
});

test('arguments for cmd.exe are quoted when they need it', () => {
  assert.equal(cmdQuote('assembleDebug'), 'assembleDebug');
  assert.equal(cmdQuote('C:\\Program Files\\x\\gradlew.bat'), '"C:\\Program Files\\x\\gradlew.bat"');
  assert.equal(cmdQuote("C:\\it's & more\\"), '"C:\\it\'s & more\\\\"');
});
