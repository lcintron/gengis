/* GenGIS - electron-builder config for the macOS build without a Developer ID certificate: package.json's build,
 * ad-hoc signed ("-") so Apple Silicon runs the app instead of calling it damaged. --config replaces package.json's
 * build key rather than merging into it, hence the spread. Used by the release workflow until the APPLE_* secrets
 * are set; after that it builds signed and notarized from package.json instead. */
'use strict';
const build = require('../package.json').build;

// An ad-hoc signature cannot satisfy the hardened runtime (nor a timestamp server), and only Apple notarizes.
module.exports = {
  ...build,
  mac: { ...build.mac, identity: '-', hardenedRuntime: false, notarize: false, timestamp: 'none' }
};
