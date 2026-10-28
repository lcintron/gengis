/* GenGIS desktop app - gengis:// links and project files handed over by the system.
 *   gengis://open?q=Eiffel%20Tower                 a place: the same parameters as the web app's address
 *   gengis://open?center=48.858,2.294&zoom=16      (js/search.js, MB.applyUrlParams); anything else is ignored
 *   gengis://C:/Maps/Trip.gengis                   a project file on this computer (.gengis, or the older .gengis.json)
 *   gengis:///home/me/Trip.gengis                  (never a network share: \\server\... is refused)
 *   gengis://https://example.com/maps/Trip.gengis  a project on the web
 * A file or web address from a link is opened only once the user says yes (the page asks): any web page can open a
 * link. A project file double-clicked or opened with GenGIS (its path on the command line, or macOS's open-file) needs
 * no question. The installer registers the scheme and the .gengis file type (package.json: build.protocols,
 * build.fileAssociations; installer/protocol.nsh on Windows); nothing here writes to the system.
 */
const SCHEME = 'gengis';
const KEYS = ['q', 'lat', 'lon', 'lng', 'zoom', 'z', 'center', 'poi', 'file']; // (file: gengis://open?file=<path>, as before)
const MAX = 2048; // characters per parameter
const PROJECT = /\.gengis(\.json)?$/i; // a project file's name: .gengis, and the older .gengis.json

// A link's place parameters ({ key: value }), or null when it is not a gengis:// link.
function params(link) {
  let u;
  try { u = new URL(String(link)); } catch (e) { return null; }
  if (u.protocol !== SCHEME + ':') return null;
  const out = {};
  KEYS.forEach(k => { const v = u.searchParams.get(k); if (v != null && v !== '' && v.length <= MAX) out[k] = v; });
  return out;
}

// What a link asks for: { params } (a place), { file } (a project file's path), { url } (a project on the web), or
// { refused } (a file that is not a project); null when it is not a gengis:// link.
function target(link) {
  const m = /^gengis:(?:\/\/)?([\s\S]*)$/i.exec(String(link || '').trim());
  if (!m) return null;
  const rest = m[1];
  if (!rest || /^(open\b|\?)/i.test(rest)) return { params: params(link) || {} };
  let v = rest;
  try { v = decodeURIComponent(rest); } catch (e) { /* not encoded */ }
  if (v.length > 4 * MAX) return { refused: 'too long' };
  if (/^https?:\/\//i.test(v)) return { url: v };
  // a path: C:/x or C:\x (also /C:/x, as gengis:///C:/x reads), or /home/x (gengis:///home/x). Not a network share
  // (\\server\x, //server/x): reaching it, Windows signs in to that server as the user, and a link may name any server.
  let file = v.replace(/^\/(?=[a-z]:[\\/])/i, '');
  if (/^([\\/]{2})/.test(file)) return { refused: 'a network path' };
  if (!/^([a-z]:[\\/]|\/)/i.test(file)) return { refused: 'not a path' };
  file = file.replace(/[?#].*$/, '');
  return PROJECT.test(file) ? { file } : { refused: 'not a project file' };
}

// The gengis:// link among a command line's arguments (how Windows and Linux hand one over), or null.
function inArgs(argv) {
  return (argv || []).find(a => typeof a === 'string' && a.toLowerCase().startsWith(SCHEME + ':')) || null;
}

// A project file among a command line's arguments (double-clicked, or "Open with" GenGIS), or null.
function fileInArgs(argv) {
  return (argv || []).find(a => typeof a === 'string' && !a.startsWith('-') && !a.toLowerCase().startsWith(SCHEME + ':') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(a) && PROJECT.test(a)) || null;
}

// This computer or a private network: loopback, link-local, private and unique-local addresses, and local names
// (where a redirect from a project's web address may not lead: electron/files.js).
function isLocalHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '0.0.0.0' || h === '::' || h === '::1') return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!h.includes(':')) return false; // a name: not looked up (an IP literal is what a redirect to here would use)
  return /^(fe[89ab]|f[cd])/.test(h) || h.startsWith('::ffff:'); // link-local, unique-local, IPv4-mapped
}

module.exports = { SCHEME, PROJECT, params, target, inArgs, fileInArgs, isLocalHost };
