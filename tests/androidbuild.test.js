'use strict';
// scripts/android-build.js (make apk): which JDK it builds with, and how it reads `adb devices`.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..');
const { chooseJdk, gradleRunsOn, parseDevices, cmdQuote, javaHomePaths, emulatorStopped } = require(path.join(ROOT, 'scripts', 'android-build.js'));

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

test('arguments for cmd.exe are quoted when they need it', () => {
  assert.equal(cmdQuote('assembleDebug'), 'assembleDebug');
  assert.equal(cmdQuote('C:\\Program Files\\x\\gradlew.bat'), '"C:\\Program Files\\x\\gradlew.bat"');
  assert.equal(cmdQuote("C:\\it's & more\\"), '"C:\\it\'s & more\\\\"');
});
