'use strict';
// The macOS build: a universal app that is ad-hoc signed without an Apple certificate (scripts/mac-adhoc.js), and
// signed with a Developer ID + notarized once the APPLE_* secrets are set (package.json). Without a signature
// Apple Silicon refuses to open the app at all ("damaged"), so the two paths are checked here, in release.yml and
// in the manual mac-build.yml, from the files themselves.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const adhoc = require(path.join(ROOT, 'scripts', 'mac-adhoc.js'));

// The jobs of a workflow as text, keyed by name (a job starts at two spaces of indent under jobs:)
function workflowJobs(file) {
  const yml = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const body = yml.slice(yml.indexOf('\njobs:') + 1);
  const jobs = {};
  let name = null;
  for (const line of body.split('\n')) {
    const start = /^ {2}([\w-]+):\s*$/.exec(line);
    if (start) { name = start[1]; jobs[name] = ''; } else if (name) jobs[name] += line + '\n';
  }
  return jobs;
}

// The steps of a job as text (a step starts at six spaces and a dash)
const steps = job => job.split(/\n(?= {6}- )/).filter(s => /^ {6}- /.test(s));

// One key of a step (run:, env:, if:) with its block, as text: what two workflows have to keep identical, and
// what a comment that happens to contain the word cannot stand in for (the key is at eight spaces, its block at ten)
function stepPart(step, key) {
  const lines = step.split('\n');
  const at = lines.findIndex(l => l.startsWith('        ' + key + ':'));
  if (at < 0) return null;
  const first = lines[at].slice(key.length + 9).trim();
  const body = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() && !lines[i].startsWith('          ')) break;
    body.push(lines[i].slice(10));
  }
  return ((first === '|' ? '' : first) + '\n' + body.join('\n')).trim();
}

test('the macOS app is built universal, hardened and notarized, with an appId of its own', () => {
  const mac = pkg.build.mac;
  assert.equal(pkg.build.appId, 'local.gengis', 'the top-level appId drives the Windows installer: unchanged');
  assert.equal(mac.appId, 'com.luiscintron.gengis', 'the mac bundle id matches the Android package');
  assert.deepEqual(mac.target.map(t => t.target), ['dmg', 'zip']);
  for (const t of mac.target) assert.deepEqual(t.arch, ['universal'], t.target + ': one download for Apple Silicon and Intel');
  assert.equal(mac.hardenedRuntime, true, 'notarization needs the hardened runtime');
  assert.equal(mac.notarize, true);
  assert.ok(!('identity' in mac), 'no identity: the Developer ID certificate is discovered from CSC_LINK');
  // the entitlements the hardened runtime needs, shipped next to the NSIS script and not packed into the app
  for (const key of ['entitlements', 'entitlementsInherit']) {
    assert.equal(mac[key], 'installer/entitlements.mac.plist', key);
    assert.ok(fs.existsSync(path.join(ROOT, mac[key])), mac[key] + ' exists');
  }
  const plist = fs.readFileSync(path.join(ROOT, mac.entitlements), 'utf8');
  for (const key of ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation']) assert.ok(plist.includes(key), 'entitlement ' + key);
  assert.ok(!pkg.build.files.some(f => f === mac.entitlements || f.split('/')[0] === 'installer'),
    'the entitlements are a build input, not a file of the app');
});

test('without an Apple certificate the macOS app is ad-hoc signed, and nothing else changes', () => {
  assert.equal(adhoc.mac.identity, '-', 'ad-hoc signed: what Apple Silicon needs to run it at all');
  assert.equal(adhoc.mac.hardenedRuntime, false, 'an ad-hoc signature cannot satisfy the hardened runtime');
  assert.equal(adhoc.mac.notarize, false, 'only Apple notarizes, and only a Developer ID signature');
  assert.equal(adhoc.mac.timestamp, 'none', 'no timestamp server for an ad-hoc signature');
  assert.equal(adhoc.mac.appId, 'com.luiscintron.gengis', 'the same bundle id as the signed build');
  assert.deepEqual(adhoc.mac.target, pkg.build.mac.target, 'the same universal dmg and zip');
  // --config replaces package.json's build key rather than merging, so the rest has to be carried over as it is
  const { mac: _skipA, ...restOfConfig } = adhoc;
  const { mac: _skipB, ...restOfBuild } = pkg.build;
  assert.deepEqual(restOfConfig, restOfBuild, 'the config is package.json\'s build with only mac changed');
  // a mac built by hand has no Developer ID either, so it takes the same config (an unsigned app will not open)
  assert.match(pkg.scripts['dist:mac'], /^electron-builder --mac --publish never --config scripts\/mac-adhoc\.js$/);
  const make = fs.readFileSync(path.join(ROOT, 'Makefile'), 'utf8');
  assert.match(make, /build-mac: install\n\t\$\(NPX\) electron-builder --mac --publish never --config scripts\/mac-adhoc\.js/,
    'make build-mac builds it the same way as npm run dist:mac');
});

test('the release builds macOS one way or the other, never signing the Windows build by accident', () => {
  const build = workflowJobs('.github/workflows/release.yml').build;
  assert.match(build, /MAC_SIGNED: \$\{\{ secrets\.APPLE_CERTIFICATE_BASE64 != '' \}\}/, 'the certificate decides the path');
  const builders = steps(build).filter(s => s.includes('electron-builder'));
  assert.equal(builders.length, 3, 'Windows/Linux, macOS ad-hoc, macOS Developer ID');
  // each build step is gated, and on one of exactly these three conditions: no run builds macOS twice or not at all
  assert.deepEqual(builders.map(s => stepPart(s, 'if')).sort(), [
    "runner.os != 'macOS'",
    "runner.os == 'macOS' && env.MAC_SIGNED != 'true'",
    "runner.os == 'macOS' && env.MAC_SIGNED == 'true'"
  ].sort());
  const other = builders.find(s => s.includes("if: runner.os != 'macOS'"));
  assert.ok(other, 'the Windows and Linux step');
  assert.match(other, /CSC_IDENTITY_AUTO_DISCOVERY: "false"/, 'those installers stay unsigned');
  assert.ok(!other.includes('--config'), 'Windows and Linux build from package.json');
  const ad = builders.find(s => s.includes('--config scripts/mac-adhoc.js'));
  assert.ok(ad, 'the ad-hoc macOS step');
  assert.match(ad, /if: runner\.os == 'macOS' && env\.MAC_SIGNED != 'true'/);
  const signed = builders.filter(s => s.includes('CSC_LINK:'));
  assert.equal(signed.length, 1, 'CSC_LINK reaches the macOS step only (the Windows build would use it too)');
  assert.match(signed[0], /if: runner\.os == 'macOS' && env\.MAC_SIGNED == 'true'/);
  for (const secret of ['CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'])
    assert.ok(signed[0].includes(secret + ':'), 'the signed build gets ' + secret);
  assert.ok(!signed[0].includes('CSC_IDENTITY_AUTO_DISCOVERY'),
    'the Developer ID certificate is not found with discovery turned off');
  assert.match(signed[0], /APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID/, 'half the secrets fails the build');
  // what came out is checked on the runner: universal, and signed the way this run meant to sign it
  const check = steps(build).find(s => s.includes('- name: Check the macOS signature'));
  assert.ok(check, 'the signature check');
  assert.match(check, /if: runner\.os == 'macOS'/);
  assert.match(check, /lipo -archs/, 'the app carries both architectures');
  assert.match(check, /grep -q 'Signature=adhoc'/);
  assert.match(check, /grep -q 'Authority=Developer ID Application'/);
  assert.match(check, /xcrun stapler validate/, 'the notarization ticket is stapled');
});

test('the release note tells macOS users how to open an app Apple has not notarized', () => {
  const publish = workflowJobs('.github/workflows/release.yml').publish;
  const note = /\n      - name: Android release note\n([\s\S]*?)\n      - uses:/.exec(publish);
  assert.ok(note, 'the step that writes the note');
  assert.match(note[1], /MAC_SIGNED: \$\{\{ secrets\.APPLE_CERTIFICATE_BASE64 != '' \}\}/, 'the step sees the certificate');
  assert.match(note[1], /dmg=\$\(ls installers\/GenGIS-\*-mac-\*\.dmg/, 'only when a macOS app was really attached');
  assert.match(note[1], /if \[ -n "\$dmg" \] && \[ "\$MAC_SIGNED" != "true" \]; then/, 'and only while it is ad-hoc signed');
  assert.match(note[1], /xattr -dr com\.apple\.quarantine/, 'the Terminal way out');
  assert.match(note[1], /Privacy & Security/, 'and the one without a Terminal');
  // after the Android branch, inside the heredoc the body is written to
  const mac = note[1].indexOf('**macOS:**');
  assert.ok(mac > note[1].indexOf('\n            fi\n'), 'the macOS note comes after the Android branch');
  assert.ok(mac < note[1].indexOf('echo APKNOTE_EOF'), 'and inside the body');
  assert.equal(publish.split('**macOS:**').length - 1, 1, 'the note lives in that step, not in the release body');
});

test('the macOS app can be built on demand, the same way, without cutting a release', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/mac-build.yml'), 'utf8');
  assert.match(yml, /\non:\n {2}workflow_dispatch:/, 'started by hand only');
  assert.match(yml, /runs-on: macos-latest/);
  assert.match(yml, /MAC_SIGNED: \$\{\{ secrets\.APPLE_CERTIFICATE_BASE64 != '' \}\}/);
  const builders = steps(workflowJobs('.github/workflows/mac-build.yml').build).filter(s => s.includes('electron-builder'));
  assert.equal(builders.length, 2, 'the same two paths as the release');
  const ad = builders.find(s => s.includes('--config scripts/mac-adhoc.js'));
  assert.ok(ad, 'the unsigned path builds ad-hoc signed, like the release');
  assert.match(ad, /if: env\.MAC_SIGNED != 'true'/, 'no matrix here, so no runner.os clause');
  assert.ok(builders.some(s => s.includes('CSC_LINK:') && s.includes("if: env.MAC_SIGNED == 'true'")), 'the signed path');
  assert.match(yml, /- name: Check the macOS signature/, 'the app is checked here too');
});

test('the manual build and the release build the macOS app with the same steps, which cannot drift apart', () => {
  const release = steps(workflowJobs('.github/workflows/release.yml').build);
  const manual = steps(workflowJobs('.github/workflows/mac-build.yml').build);
  // the manual workflow is a dry run of the release: a change to the build or the check belongs in both
  for (const name of ['Build macOS app (ad-hoc signed)', 'Build macOS app (Developer ID, notarized)', 'Check the macOS signature']) {
    const a = release.find(s => s.includes('- name: ' + name));
    const b = manual.find(s => s.includes('- name: ' + name));
    assert.ok(a, 'release.yml has "' + name + '"');
    assert.ok(b, 'mac-build.yml has "' + name + '"');
    assert.equal(stepPart(b, 'run'), stepPart(a, 'run'), name + ': the same script in both workflows');
    assert.equal(stepPart(b, 'env'), stepPart(a, 'env'), name + ': the same certificate and Apple secrets in both');
  }
  // only the gate differs: the release picks the macOS runner out of its matrix, the manual workflow has none
  const adhoc = manual.find(s => s.includes('--config scripts/mac-adhoc.js'));
  assert.equal(stepPart(adhoc, 'if'), "env.MAC_SIGNED != 'true'");
  assert.equal(stepPart(manual.find(s => s.includes('CSC_LINK:')), 'if'), "env.MAC_SIGNED == 'true'");
});
