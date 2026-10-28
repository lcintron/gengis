/* GenGIS desktop app - gengis:// links: a place or a project from a link, a shortcut or another app.
 *   gengis://open?q=Eiffel%20Tower
 *   gengis://open?center=48.858,2.294&zoom=16      (or lat=..&lon=..)
 *   gengis://open?poi=cafe
 *   gengis://open?file=C:\Maps\Trip.gengis.json    (a project file GenGIS has opened or saved before: files.js decides)
 * The same parameters as the web app's address (js/search.js, MB.applyUrlParams); anything else in a link is ignored.
 * The installer registers the scheme (package.json: build.protocols); nothing here writes to the system.
 */
const SCHEME = 'gengis';
const KEYS = ['q', 'lat', 'lon', 'lng', 'zoom', 'z', 'center', 'poi', 'file'];
const MAX = 2048; // characters per parameter

// A link's parameters ({ key: value }), or null when it is not a gengis:// link.
function params(link) {
  let u;
  try { u = new URL(String(link)); } catch (e) { return null; }
  if (u.protocol !== SCHEME + ':') return null;
  const out = {};
  KEYS.forEach(k => { const v = u.searchParams.get(k); if (v != null && v !== '' && v.length <= MAX) out[k] = v; });
  return out;
}

// The gengis:// link among a command line's arguments (how Windows and Linux hand one over), or null.
function inArgs(argv) {
  return (argv || []).find(a => typeof a === 'string' && a.toLowerCase().startsWith(SCHEME + ':')) || null;
}

module.exports = { SCHEME, params, inArgs };
