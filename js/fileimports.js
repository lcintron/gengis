/* GenGIS - file imports: KML, KMZ, GeoJSON and shapefiles as layers over the map (the Data panel's "File imports")
 * - a file opened from the panel, or dropped on it or on the map, becomes a layer drawn with the data layers (the same
 *   canvas, the same Data opacity setting); a click on one of its features lists its attributes with the data's
 * - KML and KMZ: placemarks (points, lines, polygons, multi-geometries, tracks) with their styles, names, descriptions,
 *   extended data and folders; ground overlays, network links and 3D models are left out, and said so
 * - GeoJSON: features with their simplestyle colors (or the style GenGIS writes); WGS 84, or Web Mercator when its
 *   "crs" says so
 * - shapefiles: the .shp with its .dbf (attributes), .prj (projection) and .cpg (text encoding), picked together or in
 *   a .zip (each .shp in it a layer). Geographic coordinates, Web Mercator, Mercator, transverse Mercator (UTM, many
 *   state planes), Lambert conformal conic and Albers are turned back into longitude/latitude, with no datum shift:
 *   NAD 83, ETRS 89, GDA 94 and the like are within a meter or two of WGS 84; older datums can be off by more.
 * - kept on this device (IndexedDB) for every project until removed, not in the project file; "Copy into the project"
 *   adds a layer's features to the project as objects that can be edited and that travel with it
 *
 * API: MB.imports.init(), openFiles(files), list(), setVisible(id, on), setColor(id, color), zoomTo(id), remove(id),
 *   toProject(id), enabledCount(), sets() (the shown layers, for datalayers.js's identify), isImportFile(file),
 *   sortZips(files) -> { geo, other } (the dropped .zip files that hold shapefiles, KML or GeoJSON, and the rest)
 *   panelHtml(q, filter) / bindPanel(panel): the Data panel's block
 *   Readers (no map needed): MB.imports.read = { parseXml, kml, geoJson, shapefile, shp, dbf, projection, zip }
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = s => (MB.escapeHtml ? MB.escapeHtml(s) : String(s));
  const PALETTE = ['#ff8a3d', '#3fd0f0', '#c792ff', '#8fd14f', '#ff5c8a', '#f7c12b', '#4f8cff', '#2fd6a0'];
  const MAX_FEATURES = 250000;          // per layer; more are left out (and said so)
  const MAX_UNZIPPED = 1024 * 1048576;  // bytes inflated from one .zip or .kmz, at most
  const COPY_WARN = 5000;               // features: copying more into the project asks first
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const round = v => Math.round(v * 1e7) / 1e7; // ~1 cm
  const okLonLat = (x, y) => isFinite(x) && isFinite(y) && Math.abs(x) <= 180.0000001 && Math.abs(y) <= 90.0000001;
  const bytes = b => (b instanceof Uint8Array ? b : new Uint8Array(b));
  const view = u8 => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const extOf = name => ((/\.([a-z0-9]+)$/i.exec(name || '') || [])[1] || '').toLowerCase();
  const baseOf = name => String(name || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const plural = (n, one, many) => n.toLocaleString() + ' ' + (n === 1 ? one : (many || one + 's'));

  /* ---------- XML (KML) ----------
   * A small, forgiving reader: elements by their local name (gx:Track is Track), attributes, and text (CDATA as it
   * is, entities decoded). Comments, processing instructions and a DOCTYPE are skipped; a stray closing tag is
   * ignored. Faster than DOMParser on large files, and it works without a DOM (the tests). */
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function decode(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return String.fromCodePoint(n); } catch (x) { return m; }
      }
      return ENT[e] !== undefined ? ENT[e] : m;
    });
  }
  const localName = n => { const i = n.indexOf(':'); return i < 0 ? n : n.slice(i + 1); };
  function attrsOf(s) {
    const a = {}, re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(s))) a[localName(m[1])] = decode(m[2] != null ? m[2] : m[3]);
    return a;
  }
  function parseXml(s) {
    const root = { name: '#document', attrs: {}, kids: [], text: '' };
    const stack = [root], n = s.length;
    const bad = () => new Error('it is not well-formed XML');
    let i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
    while (i < n) {
      const top = stack[stack.length - 1], lt = s.indexOf('<', i);
      if (lt < 0) { top.text += decode(s.slice(i)); break; }
      if (lt > i) top.text += decode(s.slice(i, lt));
      const c = s.charCodeAt(lt + 1);
      if (c === 33) { // <!
        if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); if (e < 0) throw bad(); i = e + 3; continue; }
        if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt + 9); if (e < 0) throw bad(); top.text += s.slice(lt + 9, e); i = e + 3; continue; }
        let e = lt + 2, depth = 0; // a DOCTYPE, perhaps with an internal subset
        for (; e < n; e++) { const ch = s[e]; if (ch === '[') depth++; else if (ch === ']') depth--; else if (ch === '>' && depth <= 0) break; }
        i = e + 1; continue;
      }
      if (c === 63) { const e = s.indexOf('?>', lt + 2); if (e < 0) throw bad(); i = e + 2; continue; } // <?xml …?>
      let e = lt + 1, q = 0; // the tag's end, outside quoted attribute values
      for (; e < n; e++) { const ch = s.charCodeAt(e); if (q) { if (ch === q) q = 0; } else if (ch === 34 || ch === 39) q = ch; else if (ch === 62) break; }
      if (e >= n) throw bad();
      const body = s.slice(lt + 1, e);
      i = e + 1;
      if (body[0] === '/') {
        const name = localName(body.slice(1).trim());
        for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
        continue;
      }
      const m = /^[^\s/>]+/.exec(body);
      if (!m) throw bad();
      const selfClose = body.charCodeAt(body.length - 1) === 47;
      const node = { name: localName(m[0]), attrs: attrsOf(body.slice(m[0].length, selfClose ? body.length - 1 : body.length)), kids: [], text: '' };
      top.kids.push(node);
      if (!selfClose) stack.push(node);
    }
    return root;
  }
  const kid = (n, name) => (n ? n.kids.find(k => k.name === name) : undefined);
  const kidsOf = (n, name) => (n ? n.kids.filter(k => k.name === name) : []);
  function textOf(n) { if (!n) return ''; let t = n.text; for (const k of n.kids) t += textOf(k); return t; }
  const val = (n, name) => textOf(kid(n, name)).trim();
  function findDeep(n, name) { if (n.name === name) return n; for (const k of n.kids) { const f = findDeep(k, name); if (f) return f; } return null; }

  // A description written as HTML, as plain text (the popup shows text, never the file's markup).
  function htmlText(s) {
    if (!s) return '';
    if (!/[<&]/.test(s)) return s.trim();
    return decode(s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)\s*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' '))
      .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ---------- geometry, as the layers keep it ----------
   * Simple parts (Point, LineString, Polygon) in longitude/latitude, rounded to ~1 cm; parts of one kind are put
   * together again as a Multi… geometry, parts of different kinds become features of their own (the same attributes). */
  function pt(c, tx) {
    if (!Array.isArray(c) && !(c && c.length)) return null;
    const p = tx ? tx(+c[0], +c[1]) : [+c[0], +c[1]];
    return p && okLonLat(p[0], p[1]) ? [round(p[0]), round(p[1])] : null;
  }
  function line(cs, tx, min) {
    if (!Array.isArray(cs)) return null;
    const out = [];
    for (const c of cs) { const p = pt(c, tx); if (p) out.push(p); }
    return out.length >= min ? out : null;
  }
  function rings(rs, tx) {
    if (!Array.isArray(rs)) return null;
    const out = [];
    for (let i = 0; i < rs.length; i++) { const r = line(rs[i], tx, 3); if (r) out.push(r); else if (i === 0) return null; }
    return out.length ? out : null;
  }
  // A GeoJSON geometry as simple parts (bad coordinates and empty parts dropped).
  function simple(g, tx, out) {
    if (!g || typeof g !== 'object') return out;
    const c = g.coordinates, each = (list, type) => { if (Array.isArray(list)) list.forEach(x => simple({ type, coordinates: x }, tx, out)); };
    switch (g.type) {
      case 'Point': { const p = pt(c, tx); if (p) out.push({ type: 'Point', coordinates: p }); break; }
      case 'LineString': { const l = line(c, tx, 2); if (l) out.push({ type: 'LineString', coordinates: l }); break; }
      case 'Polygon': { const r = rings(c, tx); if (r) out.push({ type: 'Polygon', coordinates: r }); break; }
      case 'MultiPoint': each(c, 'Point'); break;
      case 'MultiLineString': each(c, 'LineString'); break;
      case 'MultiPolygon': each(c, 'Polygon'); break;
      case 'GeometryCollection': if (Array.isArray(g.geometries)) g.geometries.forEach(x => simple(x, tx, out)); break;
    }
    return out;
  }
  function combine(parts) {
    const by = { Polygon: [], LineString: [], Point: [] };
    parts.forEach(g => by[g.type].push(g.coordinates));
    const out = [];
    for (const t of ['Polygon', 'LineString', 'Point']) {
      const list = by[t];
      if (list.length) out.push(list.length === 1 ? { type: t, coordinates: list[0] } : { type: 'Multi' + t, coordinates: list });
    }
    return out;
  }
  // Features for one record: its parts combined, each with the attributes (copies past the first) and its style.
  function featuresFor(parts, props, style, out) {
    combine(parts).forEach((geometry, i) => {
      const f = { type: 'Feature', properties: i ? Object.assign({}, props) : props, geometry };
      if (style && Object.keys(style).length) f.mbStyle = style;
      out.push(f);
    });
  }
  const kindOf = g => (/Point/.test(g.type) ? 'point' : /LineString/.test(g.type) ? 'line' : 'polygon');

  /* ---------- KML ---------- */
  // KML colors are aabbggrr.
  function kmlColor(s) {
    s = String(s || '').trim().replace(/^#/, '');
    if (/^[0-9a-f]{8}$/i.test(s)) return { color: '#' + s.slice(6, 8) + s.slice(4, 6) + s.slice(2, 4), opacity: Math.round(parseInt(s.slice(0, 2), 16) / 255 * 100) / 100 };
    if (/^[0-9a-f]{6}$/i.test(s)) return { color: '#' + s.slice(4, 6) + s.slice(2, 4) + s.slice(0, 2), opacity: 1 };
    return null;
  }
  function kmlStyle(node) {
    const st = {};
    if (!node) return st;
    const ls = kid(node, 'LineStyle'), ps = kid(node, 'PolyStyle'), is = kid(node, 'IconStyle');
    if (ls) {
      const c = kmlColor(val(ls, 'color')), w = parseFloat(val(ls, 'width'));
      if (c) { st.stroke = c.color; st.strokeOpacity = c.opacity; }
      if (isFinite(w)) st.strokeWidth = w;
    }
    if (ps) {
      const c = kmlColor(val(ps, 'color'));
      if (c) { st.fill = c.color; st.fillOpacity = c.opacity; }
      if (val(ps, 'fill') === '0') st.fillOpacity = 0;
      if (val(ps, 'outline') === '0') st.outline = false;
    }
    if (is) { const c = kmlColor(val(is, 'color')); if (c) st.marker = c.color; }
    return st;
  }
  function kmlCoords(s) {
    const out = [];
    for (const tok of String(s || '').replace(/\s*,\s*/g, ',').trim().split(/\s+/)) {
      if (!tok) continue;
      const p = tok.split(',');
      const q = pt([+p[0], +p[1]]);
      if (q) out.push(q);
    }
    return out;
  }
  function kmlGeom(n, out) {
    switch (n.name) {
      case 'Point': { const c = kmlCoords(val(n, 'coordinates')); if (c.length) out.push({ type: 'Point', coordinates: c[0] }); break; }
      case 'LineString': case 'LinearRing': { const c = kmlCoords(val(n, 'coordinates')); if (c.length > 1) out.push({ type: 'LineString', coordinates: c }); break; }
      case 'Polygon': {
        const ob = kid(n, 'outerBoundaryIs'), outer = kmlCoords(val(kid(ob, 'LinearRing'), 'coordinates'));
        if (outer.length < 3) break;
        const holes = [];
        for (const ib of kidsOf(n, 'innerBoundaryIs')) for (const lr of kidsOf(ib, 'LinearRing')) { const h = kmlCoords(val(lr, 'coordinates')); if (h.length >= 3) holes.push(h); }
        out.push({ type: 'Polygon', coordinates: [outer].concat(holes) });
        break;
      }
      case 'Track': {
        const c = kidsOf(n, 'coord').map(k => textOf(k).trim().split(/\s+/)).map(p => pt(p)).filter(Boolean);
        if (c.length > 1) out.push({ type: 'LineString', coordinates: c });
        else if (c.length) out.push({ type: 'Point', coordinates: c[0] });
        break;
      }
      case 'MultiGeometry': case 'MultiTrack': n.kids.forEach(k => kmlGeom(k, out)); break;
    }
    return out;
  }
  const KML_SKIP = { GroundOverlay: ['ground overlay'], ScreenOverlay: ['screen overlay'], PhotoOverlay: ['photo overlay'], NetworkLink: ['network link'] };
  function readKml(text) {
    const doc = parseXml(text);
    const kml = findDeep(doc, 'kml');
    if (!kml) throw new Error('it is not a KML file');
    const styles = {}, maps = {};
    (function collect(n) {
      for (const k of n.kids) {
        if (k.name === 'Style' && k.attrs.id) styles[k.attrs.id] = kmlStyle(k);
        else if (k.name === 'StyleMap' && k.attrs.id) {
          const pair = kidsOf(k, 'Pair').find(p => val(p, 'key') === 'normal') || kid(k, 'Pair');
          if (pair) maps[k.attrs.id] = { url: val(pair, 'styleUrl'), inline: kid(pair, 'Style') };
        }
        if (k.kids.length && k.name !== 'Placemark') collect(k);
      }
    })(kml);
    const styleAt = (url, depth) => {
      const id = String(url || '').split('#').pop();
      if (!id) return null;
      if (styles[id]) return styles[id];
      const m = maps[id];
      return m && depth < 4 ? Object.assign({}, m.url ? styleAt(m.url, depth + 1) : null, m.inline ? kmlStyle(m.inline) : null) : null;
    };
    const features = [], skipped = {};
    let bare = 0;
    const placemark = (pm, folders) => {
      const props = {};
      const name = val(pm, 'name'), desc = htmlText(val(pm, 'description'));
      if (name) props.name = name;
      if (desc) props.description = desc;
      if (folders.length) props.folder = folders.join(' / ');
      const ext = kid(pm, 'ExtendedData');
      if (ext) {
        for (const d of kidsOf(ext, 'Data')) if (d.attrs.name) { const v = val(d, 'value'); if (v !== '') props[d.attrs.name] = v; }
        for (const sd of kidsOf(ext, 'SchemaData')) for (const s of kidsOf(sd, 'SimpleData')) if (s.attrs.name) { const v = textOf(s).trim(); if (v !== '') props[s.attrs.name] = v; }
      }
      const ts = kid(pm, 'TimeStamp'), span = kid(pm, 'TimeSpan');
      if (ts && val(ts, 'when')) props.time = val(ts, 'when');
      if (span && val(span, 'begin')) props.begin = val(span, 'begin');
      if (span && val(span, 'end')) props.end = val(span, 'end');
      const style = Object.assign({}, styleAt(val(pm, 'styleUrl'), 0), kmlStyle(kid(pm, 'Style')));
      const parts = [];
      pm.kids.forEach(k => kmlGeom(k, parts));
      if (!parts.length) { bare++; return; }
      featuresFor(parts, props, style, features);
    };
    (function walk(n, folders) {
      for (const k of n.kids) {
        if (k.name === 'Placemark') placemark(k, folders);
        else if (k.name === 'Folder') { const nm = val(k, 'name'); walk(k, nm ? folders.concat(nm) : folders); }
        else if (k.name === 'Document' || k.name === 'kml') walk(k, folders);
        else if (KML_SKIP[k.name]) skipped[k.name] = (skipped[k.name] || 0) + 1;
      }
    })(kml, []);
    const notes = Object.keys(skipped).map(k => plural(skipped[k], KML_SKIP[k][0]));
    if (bare) notes.push(plural(bare, 'placemark') + ' with no point, line or polygon (a 3D model, or empty)');
    return { features, notes: notes.length ? [notes.join(', ') + ' left out'] : [] };
  }

  /* ---------- GeoJSON ---------- */
  const GEOM_TYPES = { Point: 1, MultiPoint: 1, LineString: 1, MultiLineString: 1, Polygon: 1, MultiPolygon: 1, GeometryCollection: 1 };
  // The colors a GeoJSON feature brings: simplestyle properties, or the style GenGIS writes.
  function simpleStyle(p) {
    const s = {}, st = p.style && typeof p.style === 'object' ? p.style : {};
    const col = v => { v = typeof v === 'string' ? v.trim() : ''; return /^#?([0-9a-f]{3}){1,2}$/i.test(v) ? (v[0] === '#' ? v : '#' + v) : null; };
    const num = v => (v != null && v !== '' && isFinite(+v) ? +v : null);
    const put = (k, v) => { if (v != null) s[k] = v; };
    put('stroke', col(p.stroke) || col(st.color));
    put('strokeWidth', num(p['stroke-width']) != null ? num(p['stroke-width']) : num(st.weight));
    put('strokeOpacity', num(p['stroke-opacity']) != null ? num(p['stroke-opacity']) : num(st.opacity));
    put('fill', col(p.fill) || col(st.fillColor));
    put('fillOpacity', num(p['fill-opacity']) != null ? num(p['fill-opacity']) : num(st.fillOpacity));
    put('marker', col(p['marker-color']));
    return s;
  }
  // Web Mercator meters (EPSG:3857) back to degrees.
  const unMerc = (x, y) => [x / 6378137 * R2D, (Math.PI / 2 - 2 * Math.atan(Math.exp(-y / 6378137))) * R2D];
  function crsOf(gj) {
    const name = gj.crs && gj.crs.properties && gj.crs.properties.name;
    if (!name) return null;
    if (/(3857|900913|102100|102113)$/.test(name)) return unMerc;
    if (/CRS:?84$|EPSG:+(4326|4269|4258|4283|4617|4152|4167|4019)$/i.test(name)) return null;
    throw new Error('its coordinate system (' + name + ') is not supported: save it as WGS 84 longitude/latitude');
  }
  function readGeoJson(input) {
    let gj = input;
    if (typeof gj === 'string') {
      try { gj = JSON.parse(gj.charCodeAt(0) === 0xfeff ? gj.slice(1) : gj); } catch (e) { throw new Error('it is not valid JSON'); }
    }
    if (!gj || typeof gj !== 'object') throw new Error('it is not GeoJSON');
    if (gj.type === 'Topology') throw new Error('it is TopoJSON: convert it to GeoJSON first');
    const tx = crsOf(gj);
    let list;
    if (gj.type === 'FeatureCollection') list = Array.isArray(gj.features) ? gj.features : [];
    else if (gj.type === 'Feature') list = [gj];
    else if (GEOM_TYPES[gj.type]) list = [{ type: 'Feature', properties: {}, geometry: gj }];
    else throw new Error('it is not GeoJSON (no FeatureCollection, Feature or geometry in it)');
    const features = [];
    let withGeometry = 0, empty = 0;
    for (const f of list) {
      if (!f || !f.geometry) { empty++; continue; }
      withGeometry++;
      const props = f.properties && typeof f.properties === 'object' && !Array.isArray(f.properties) ? f.properties : {};
      const parts = simple(f.geometry, tx, []);
      if (!parts.length) { empty++; continue; }
      featuresFor(parts, props, simpleStyle(props), features);
    }
    if (withGeometry && !features.length) throw new Error('none of its coordinates are longitude/latitude (GeoJSON is WGS 84)');
    return { features, notes: empty ? [plural(empty, 'feature') + ' with no usable geometry left out'] : [] };
  }

  /* ---------- shapefiles ---------- */
  const SHP_KIND = { 1: 'point', 11: 'point', 21: 'point', 8: 'multipoint', 18: 'multipoint', 28: 'multipoint', 3: 'line', 13: 'line', 23: 'line', 5: 'polygon', 15: 'polygon', 25: 'polygon', 31: 'patch' };
  function area(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return a / 2; } // > 0 counter-clockwise
  function inRing(p, r) {
    let into = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) into = !into;
    }
    return into;
  }
  // A shapefile polygon's rings: clockwise ones are outlines, counter-clockwise ones holes (in the outline they are
  // in, the smallest). Files that ignore the rule (all one way) have outlines only.
  function polygonOf(parts, tx) {
    const rs = parts.filter(r => r.length >= 3).map(r => ({ r, a: area(r) }));
    let outers = rs.filter(x => x.a < 0), holes = rs.filter(x => x.a >= 0);
    if (!outers.length) { outers = holes; holes = []; }
    const polys = outers.map(o => ({ o, holes: [] }));
    for (const h of holes) {
      let best = null;
      for (const p of polys) if (inRing(h.r[0], p.o.r) && (!best || Math.abs(p.o.a) < Math.abs(best.o.a))) best = p;
      if (best) best.holes.push(h); else polys.push({ o: h, holes: [] });
    }
    const out = [];
    for (const p of polys) {
      const outer = line(p.o.r, tx, 3);
      if (!outer) continue;
      out.push({ type: 'Polygon', coordinates: [outer].concat(p.holes.map(h => line(h.r, tx, 3)).filter(Boolean)) });
    }
    return out;
  }
  // The records of a .shp, in order: each record's simple parts in longitude/latitude (an empty list for a null or
  // unreadable shape). patches: MultiPatch records (3D surfaces), not read.
  function readShp(buf, tx) {
    const u8 = bytes(buf), dv = view(u8), n = u8.length;
    if (n < 100 || dv.getInt32(0) !== 9994) throw new Error('its .shp is not a shapefile');
    const f64 = o => dv.getFloat64(o, true), i32 = o => dv.getInt32(o, true);
    const records = [];
    let at = 100, patches = 0;
    while (at + 8 <= n) {
      const len = dv.getInt32(at + 4) * 2, c = at + 8, end = c + len;
      at = end;
      if (len < 4 || end > n) { if (end > n) break; records.push([]); continue; }
      const kind = SHP_KIND[i32(c)], parts = [];
      try {
        if (kind === 'point' && len >= 20) { const p = pt([f64(c + 4), f64(c + 12)], tx); if (p) parts.push({ type: 'Point', coordinates: p }); }
        else if (kind === 'multipoint' && len >= 40) {
          const np = i32(c + 36);
          for (let k = 0; k < np && c + 56 + 16 * k <= end; k++) { const p = pt([f64(c + 40 + 16 * k), f64(c + 48 + 16 * k)], tx); if (p) parts.push({ type: 'Point', coordinates: p }); }
        } else if ((kind === 'line' || kind === 'polygon') && len >= 44) {
          const nParts = i32(c + 36), nPts = i32(c + 40), pp = c + 44 + 4 * nParts;
          if (nParts > 0 && nPts > 0 && pp + 16 * nPts <= end) {
            const raw = [];
            for (let k = 0; k < nParts; k++) {
              const s = i32(c + 44 + 4 * k), e = k + 1 < nParts ? i32(c + 48 + 4 * k) : nPts, r = [];
              for (let j = Math.max(0, s); j < Math.min(e, nPts); j++) r.push([f64(pp + 16 * j), f64(pp + 16 * j + 8)]);
              raw.push(r);
            }
            if (kind === 'line') raw.forEach(r => { const l = line(r, tx, 2); if (l) parts.push({ type: 'LineString', coordinates: l }); });
            else parts.push(...polygonOf(raw, tx));
          }
        } else if (kind === 'patch') patches++;
      } catch (e) { /* a damaged record: none of it */ }
      records.push(parts);
    }
    return { records, patches, bbox: [f64(36), f64(44), f64(52), f64(60)] };
  }

  // The text encoding a .cpg names, as TextDecoder knows it ('' when it names none).
  function encodingOf(cpg) {
    const s = String(cpg || '').trim().toLowerCase();
    if (!s) return '';
    if (/utf-?8|^65001$/.test(s)) return 'utf-8';
    let m = /8859-?(\d+)/.exec(s);
    if (m) return 'iso-8859-' + m[1];
    m = /(\d{3,5})/.exec(s);
    if (m) {
      const n = m[1];
      if (/^125\d$/.test(n) || n === '874') return 'windows-' + n;
      return { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 866: 'ibm866', 437: 'windows-1252', 850: 'windows-1252' }[n] || '';
    }
    return s;
  }
  function decoderFor(cpg, sample) {
    const label = encodingOf(cpg);
    if (label) { try { return new TextDecoder(label); } catch (e) { /* not one this browser knows: guess */ } }
    try { new TextDecoder('utf-8', { fatal: true }).decode(sample); return new TextDecoder('utf-8'); } catch (e) { /* not UTF-8 */ }
    try { return new TextDecoder('windows-1252'); } catch (e) { return new TextDecoder('utf-8'); }
  }
  // A .dbf's records, in order: each its attributes (empty ones left out), or null for a deleted record.
  function readDbf(buf, cpg) {
    const u8 = bytes(buf), dv = view(u8);
    if (u8.length < 33) throw new Error('its .dbf is not a dBASE file');
    const count = dv.getUint32(4, true), hl = dv.getUint16(8, true), rl = dv.getUint16(10, true);
    const fields = [];
    for (let p = 32; p + 32 <= hl && u8[p] !== 0x0d; p += 32) {
      let name = '';
      for (let i = 0; i < 11 && u8[p + i]; i++) name += String.fromCharCode(u8[p + i]);
      fields.push({ name: name.trim() || 'field' + (fields.length + 1), type: String.fromCharCode(u8[p + 11]).toUpperCase(), len: u8[p + 16] });
    }
    const dec = decoderFor(cpg, u8.subarray(hl, Math.min(u8.length, hl + count * rl)));
    const ascii = raw => { let s = ''; for (let i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i]); return s.trim(); };
    const value = (f, raw) => {
      if (f.type === 'M' || f.type === 'G' || f.type === 'B' || f.type === 'P') return null; // memo, binary: kept in a .dbt this does not read
      if (f.type === 'C' || f.type === 'V') { const s = dec.decode(raw).replace(/\0+$/, '').trim(); return s === '' ? null : s; }
      if (f.type === 'I' && raw.length === 4) return view(raw).getInt32(0, true);
      if (f.type === 'O' && raw.length === 8) return view(raw).getFloat64(0, true);
      const s = ascii(raw).replace(/\0+$/, '');
      if (f.type === 'N' || f.type === 'F') {
        if (!s || /^\*+$/.test(s)) return null;
        if (/^-?\d{16,}$/.test(s)) return s; // an id longer than a number holds exactly
        const v = parseFloat(s);
        return isFinite(v) ? v : null;
      }
      if (f.type === 'L') return /^[TtYy]/.test(s) ? true : /^[FfNn]/.test(s) ? false : null;
      if (f.type === 'D') return /^\d{8}$/.test(s) && s !== '00000000' ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : null;
      return s || null;
    };
    const rows = [];
    for (let r = 0; r < count; r++) {
      const s = hl + r * rl;
      if (s + rl > u8.length) break;
      if (u8[s] === 0x2a) { rows.push(null); continue; } // '*': deleted
      const row = {};
      let at = s + 1;
      for (const f of fields) { const v = value(f, u8.subarray(at, at + f.len)); at += f.len; if (v !== null) row[f.name] = v; }
      rows.push(row);
    }
    return rows;
  }

  /* ---------- projections (a .prj's WKT) ---------- */
  function parseWkt(s) {
    let i = 0;
    const bad = () => new Error('its .prj could not be read');
    const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
    function node() {
      ws();
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      if (!m) throw bad();
      i += m[0].length; ws();
      if (s[i] !== '[' && s[i] !== '(') return m[0]; // a bare keyword (AXIS["X",EAST])
      i++;
      const args = [];
      for (;;) {
        ws();
        const c = s[i];
        if (c === undefined) throw bad();
        if (c === '"') {
          let str = '', e = i + 1;
          for (;;) { const q = s.indexOf('"', e); if (q < 0) throw bad(); str += s.slice(e, q); if (s[q + 1] === '"') { str += '"'; e = q + 2; } else { i = q + 1; break; } }
          args.push(str);
        } else if (/[-+.\d]/.test(c)) {
          const n = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(s.slice(i));
          if (!n) throw bad();
          args.push(+n[0]); i += n[0].length;
        } else if (c === ']' || c === ')') { i++; break; } else args.push(node());
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']' || s[i] === ')') { i++; break; }
        throw bad();
      }
      return { name: m[0].toUpperCase(), args };
    }
    const t = node();
    if (typeof t !== 'object') throw bad();
    return t;
  }
  // Latitude from the isometric t of the conformal projections (Snyder 7-9), by iteration.
  function phiFromT(t, e) {
    let p = Math.PI / 2 - 2 * Math.atan(t);
    for (let k = 0; k < 20; k++) {
      const es = e * Math.sin(p), q = Math.PI / 2 - 2 * Math.atan(t * Math.pow((1 - es) / (1 + es), e / 2));
      if (Math.abs(q - p) < 1e-12) return q;
      p = q;
    }
    return p;
  }
  // Each inverse takes meters from the false origin and gives [longitude, latitude] in radians.
  function tmInverse(a, e2, lon0, lat0, k0) { // EPSG Guidance Note 7-2, transverse Mercator (JHS formulas' series)
    const e4 = e2 * e2, e6 = e4 * e2, ep2 = e2 / (1 - e2);
    const c0 = 1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256, c2 = 3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024, c4 = 15 * e4 / 256 + 45 * e6 / 1024, c6 = 35 * e6 / 3072;
    const M = p => a * (c0 * p - c2 * Math.sin(2 * p) + c4 * Math.sin(4 * p) - c6 * Math.sin(6 * p));
    const M0 = M(lat0), se = Math.sqrt(1 - e2), e1 = (1 - se) / (1 + se);
    return (x, y) => {
      const mu = (M0 + y / k0) / (a * c0);
      const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) +
        (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
      const s = Math.sin(p1), c = Math.cos(p1), tn = Math.tan(p1);
      const nu = a / Math.sqrt(1 - e2 * s * s), rho = a * (1 - e2) / Math.pow(1 - e2 * s * s, 1.5);
      const T = tn * tn, C = ep2 * c * c, D = x / (nu * k0);
      const lat = p1 - (nu * tn / rho) * (D * D / 2 - (5 + 3 * T + 10 * C - 4 * C * C - 9 * ep2) * D ** 4 / 24 +
        (61 + 90 * T + 298 * C + 45 * T * T - 252 * ep2 - 3 * C * C) * D ** 6 / 720);
      const lon = lon0 + (D - (1 + 2 * T + C) * D ** 3 / 6 + (5 - 2 * C + 28 * T - 3 * C * C + 8 * ep2 + 24 * T * T) * D ** 5 / 120) / c;
      return [lon, lat];
    };
  }
  function mercInverse(a, e2, lon0, k0) {
    const e = Math.sqrt(e2);
    return (x, y) => [lon0 + x / (a * k0), phiFromT(Math.exp(-y / (a * k0)), e)];
  }
  function lccInverse(a, e2, lon0, lat0, sp1, sp2, k0) {
    const e = Math.sqrt(e2);
    const m = p => Math.cos(p) / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
    const t = p => Math.tan(Math.PI / 4 - p / 2) / Math.pow((1 - e * Math.sin(p)) / (1 + e * Math.sin(p)), e / 2);
    const n = Math.abs(sp1 - sp2) > 1e-10 ? (Math.log(m(sp1)) - Math.log(m(sp2))) / (Math.log(t(sp1)) - Math.log(t(sp2))) : Math.sin(sp1);
    const F = m(sp1) / (n * Math.pow(t(sp1), n)), r0 = a * F * k0 * Math.pow(t(lat0), n), sg = Math.sign(n);
    return (x, y) => {
      const dy = r0 - y, r = sg * Math.hypot(x, dy);
      if (!r) return [lon0, sg * Math.PI / 2];
      return [lon0 + Math.atan2(sg * x, sg * dy) / n, phiFromT(Math.pow(r / (a * k0 * F), 1 / n), e)];
    };
  }
  function aeaInverse(a, e2, lon0, lat0, sp1, sp2) { // Snyder 14
    const e = Math.sqrt(e2);
    const q = p => { const s = Math.sin(p); return e < 1e-10 ? 2 * s : (1 - e2) * (s / (1 - e2 * s * s) - Math.log((1 - e * s) / (1 + e * s)) / (2 * e)); };
    const m = p => Math.cos(p) / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
    const m1 = m(sp1), m2 = m(sp2);
    const n = Math.abs(sp1 - sp2) > 1e-10 ? (m1 * m1 - m2 * m2) / (q(sp2) - q(sp1)) : Math.sin(sp1);
    const C = m1 * m1 + n * q(sp1), r0 = a * Math.sqrt(C - n * q(lat0)) / n, sg = Math.sign(n);
    return (x, y) => {
      const dy = r0 - y, r = Math.hypot(x, dy), qq = (C - r * r * n * n / (a * a)) / n;
      let p = Math.asin(Math.max(-1, Math.min(1, qq / 2)));
      if (e >= 1e-10) {
        for (let k = 0; k < 25; k++) {
          const s = Math.sin(p), w = 1 - e2 * s * s;
          const dp = w * w / (2 * Math.cos(p)) * (qq / (1 - e2) - s / w + Math.log((1 - e * s) / (1 + e * s)) / (2 * e));
          p += dp;
          if (Math.abs(dp) < 1e-12) break;
        }
      }
      return [lon0 + Math.atan2(sg * x, sg * dy) / n, p];
    };
  }
  // A .prj's coordinate system: { name, geographic, inverse(x, y) -> [lon, lat] in degrees }. Throws for one it
  // cannot turn back into longitude/latitude.
  function projection(wkt) {
    const t = parseWkt(String(wkt || '').trim());
    const all = (n, name) => (n && n.args ? n.args.filter(x => x && x.name === name) : []), one = (n, name) => all(n, name)[0];
    if (t.name === 'GEOGCS') {
      const u = one(t, 'UNIT'), k = u && +u.args[1] > 0 ? +u.args[1] * R2D : 1;
      return { name: String(t.args[0]), geographic: true, inverse: (x, y) => [x * k, y * k] };
    }
    if (t.name !== 'PROJCS') throw new Error('its .prj (' + t.name + ') is not a coordinate system GenGIS can read');
    const sph = one(one(one(t, 'GEOGCS'), 'DATUM'), 'SPHEROID');
    const a = sph && +sph.args[1] > 0 ? +sph.args[1] : 6378137, invf = sph ? +sph.args[2] : 298.257223563;
    const f = invf > 0 ? 1 / invf : 0, e2 = f * (2 - f);
    const P = {};
    all(t, 'PARAMETER').forEach(p => { P[String(p.args[0]).toLowerCase().replace(/[\s-]+/g, '_')] = +p.args[1]; });
    const par = (...names) => { for (const nm of names) if (isFinite(P[nm])) return P[nm]; return undefined; };
    const u = one(t, 'UNIT'), k = u && +u.args[1] > 0 ? +u.args[1] : 1; // meters in the linear unit
    const proj = one(t, 'PROJECTION'), method = String(proj ? proj.args[0] : '').toLowerCase().replace(/[\s-]+/g, '_');
    const fe = par('false_easting') || 0, fn = par('false_northing') || 0;
    const lon0 = (par('central_meridian', 'longitude_of_center', 'longitude_of_origin', 'longitude_of_natural_origin', 'longitude_of_false_origin') || 0) * D2R;
    const lat0 = (par('latitude_of_origin', 'latitude_of_center', 'latitude_of_natural_origin', 'latitude_of_false_origin') || 0) * D2R;
    const k0 = par('scale_factor', 'scale_factor_at_natural_origin') || 1;
    const sp1 = par('standard_parallel_1', 'latitude_of_1st_standard_parallel'), sp2 = par('standard_parallel_2', 'latitude_of_2nd_standard_parallel');
    let inv;
    if (/^(transverse_mercator|gauss_kruger)$/.test(method)) inv = tmInverse(a, e2, lon0, lat0, k0);
    else if (/^(mercator_auxiliary_sphere|popular_visualisation_pseudo_mercator)$/.test(method)) inv = mercInverse(a, 0, lon0, 1);
    else if (/^mercator(_1sp|_2sp)?$/.test(method)) {
      const ts = sp1 !== undefined && par('scale_factor') === undefined ? sp1 * D2R : null; // true scale at a standard parallel
      inv = mercInverse(a, e2, lon0, ts == null ? k0 : Math.cos(ts) / Math.sqrt(1 - e2 * Math.sin(ts) ** 2));
    } else if (/^lambert_conformal_conic(_1sp|_2sp)?$/.test(method)) {
      const s1 = sp1 === undefined ? lat0 : sp1 * D2R, s2 = sp2 === undefined ? s1 : sp2 * D2R;
      inv = lccInverse(a, e2, lon0, lat0, s1, s2, k0);
    } else if (/^albers(_conic_equal_area)?$/.test(method)) {
      const s1 = sp1 === undefined ? lat0 : sp1 * D2R, s2 = sp2 === undefined ? s1 : sp2 * D2R;
      inv = aeaInverse(a, e2, lon0, lat0, s1, s2);
    } else throw new Error('its projection (' + (proj ? proj.args[0] : 'none named') + ') is not one GenGIS can read: save it in WGS 84 or UTM');
    return { name: String(t.args[0]), geographic: false, inverse: (x, y) => { const r = inv((x - fe) * k, (y - fn) * k); return [r[0] * R2D, r[1] * R2D]; } };
  }

  // A shapefile's parts as features: { features, notes }. parts: { shp, dbf, prj, cpg } (bytes; .prj and .cpg text).
  function readShapefile(parts) {
    if (!parts.shp) throw new Error('its .shp is missing (pick the .shp with its .dbf, .prj and .cpg, or a .zip of them)');
    const notes = [], dv = view(bytes(parts.shp));
    if (dv.byteLength < 100 || dv.getInt32(0) !== 9994) throw new Error('its .shp is not a shapefile');
    let tx = null;
    if (parts.prj && String(parts.prj).trim()) tx = projection(parts.prj).inverse;
    else {
      const b = [36, 44, 52, 60].map(o => dv.getFloat64(o, true)); // the file's extent
      if (!(okLonLat(b[0], b[1]) && okLonLat(b[2], b[3]))) throw new Error('it has no .prj, and its coordinates are not longitude/latitude: add its .prj file');
      notes.push('no .prj: read as longitude/latitude');
    }
    const shp = readShp(parts.shp, tx);
    const rows = parts.dbf ? readDbf(parts.dbf, parts.cpg) : null;
    if (!rows) notes.push('no .dbf: shapes without attributes');
    if (shp.patches) notes.push(plural(shp.patches, 'MultiPatch (3D) shape') + ' left out');
    const features = [];
    shp.records.forEach((list, i) => {
      if (!list.length || (rows && rows[i] === null)) return;
      featuresFor(list, rows && rows[i] ? rows[i] : {}, null, features);
    });
    return { features, notes };
  }

  /* ---------- .zip and .kmz ---------- */
  async function inflate(data, room) {
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > room) { reader.cancel().catch(() => {}); throw new Error('it is too large unzipped'); }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    chunks.forEach(v => { out.set(v, at); at += v.byteLength; });
    return out;
  }
  // A zip's files: { names, read(name) -> bytes }. Folders and macOS's __MACOSX copies are left out.
  function readZip(buf) {
    const u8 = bytes(buf), dv = view(u8), n = u8.length;
    let eocd = -1;
    for (let i = n - 22; i >= Math.max(0, n - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('it is not a zip file');
    const count = dv.getUint16(eocd + 10, true), entries = new Map(), dec = new TextDecoder();
    let p = dv.getUint32(eocd + 16, true), used = 0;
    for (let k = 0; k < count && p + 46 <= n && dv.getUint32(p, true) === 0x02014b50; k++) {
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const e = { flags: dv.getUint16(p + 8, true), method: dv.getUint16(p + 10, true), csize: dv.getUint32(p + 20, true), local: dv.getUint32(p + 42, true) };
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (!name.endsWith('/') && !/(^|\/)__MACOSX\//.test(name)) entries.set(name, e);
    }
    return {
      names: Array.from(entries.keys()),
      async read(name) {
        const e = entries.get(name);
        if (!e) throw new Error(name + ' is not in it');
        if (e.flags & 1) throw new Error(name + ' is encrypted');
        if (e.csize === 0xffffffff || e.local === 0xffffffff) throw new Error('it is too large (zip64)');
        if (e.local + 30 > n || dv.getUint32(e.local, true) !== 0x04034b50) throw new Error('it is damaged');
        const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
        const data = u8.subarray(start, Math.min(n, start + e.csize));
        let out;
        if (e.method === 0) { if (used + data.length > MAX_UNZIPPED) throw new Error('it is too large unzipped'); out = data.slice(); }
        else if (e.method === 8) out = await inflate(data, MAX_UNZIPPED - used);
        else throw new Error(name + ' uses a compression GenGIS cannot read');
        used += out.length;
        return out;
      }
    };
  }
  const utf8 = u8 => new TextDecoder().decode(u8);

  /* ---------- files to layers ---------- */
  const SHP_PARTS = ['shp', 'dbf', 'prj', 'cpg', 'shx'];
  const KINDS = { kml: 'KML', kmz: 'KMZ', geojson: 'GeoJSON', json: 'GeoJSON', shp: 'Shapefile' };
  // One file's or one zip entry's text or bytes, read as a layer.
  function layerOf(name, kind, res) {
    if (!res.features.length) throw new Error('nothing in it to show on the map' + (res.notes.length ? ' (' + res.notes.join('; ') + ')' : ''));
    const notes = res.notes.slice();
    let features = res.features;
    if (features.length > MAX_FEATURES) { notes.push('only the first ' + MAX_FEATURES.toLocaleString() + ' of its ' + features.length.toLocaleString() + ' features'); features = features.slice(0, MAX_FEATURES); }
    return { name, kind, features, notes };
  }
  // Shapefile parts by name (folder and base name, any case), each group one layer.
  function groupShp(list, add) {
    const groups = new Map();
    for (const it of list) {
      const key = it.path.replace(/\.[^./]+$/, '').toLowerCase();
      if (!groups.has(key)) groups.set(key, { name: baseOf(it.path) });
      groups.get(key)[it.ext] = it;
    }
    return Array.from(groups.values()).filter(g => add || g.shp);
  }
  async function shpLayer(g, readBytes, readText) {
    return layerOf(g.name, 'Shapefile', readShapefile({
      shp: g.shp && await readBytes(g.shp), dbf: g.dbf && await readBytes(g.dbf),
      prj: g.prj ? await readText(g.prj) : '', cpg: g.cpg ? await readText(g.cpg) : ''
    }));
  }
  // A .zip: each shapefile, KML and GeoJSON in it a layer. A .kmz: its KML (doc.kml, or the first at the top).
  async function zipLayers(fileName, buf, kmz) {
    const z = readZip(buf), out = [], fail = [];
    const kmls = z.names.filter(nm => /\.kml$/i.test(nm));
    if (kmz) {
      const main = kmls.find(nm => /^doc\.kml$/i.test(nm)) || kmls.find(nm => !nm.includes('/')) || kmls[0];
      if (!main) throw new Error('there is no KML in it');
      out.push(layerOf(baseOf(fileName), 'KMZ', readKml(utf8(await z.read(main)))));
      return { layers: out, fail };
    }
    const items = z.names.map(path => ({ path, ext: extOf(path) }));
    const take = async (label, fn) => { try { out.push(await fn()); } catch (e) { fail.push(fileName + ' › ' + label + ': ' + e.message); } };
    for (const g of groupShp(items.filter(it => SHP_PARTS.includes(it.ext)))) {
      await take(g.name + '.shp', () => shpLayer(g, it => z.read(it.path), async it => utf8(await z.read(it.path))));
    }
    for (const it of items.filter(x => x.ext === 'kml' || x.ext === 'geojson')) {
      await take(baseOf(it.path) + '.' + it.ext, async () => {
        const text = utf8(await z.read(it.path));
        return layerOf(baseOf(it.path), KINDS[it.ext], it.ext === 'kml' ? readKml(text) : readGeoJson(text));
      });
    }
    if (!out.length && !fail.length) throw new Error('there is no shapefile, KML or GeoJSON in it');
    return { layers: out, fail };
  }
  // Files (from a chooser or a drop) as layers: { layers, fail: [why, …] }. A shapefile's parts are put together by
  // name, whatever their order.
  async function readFiles(files) {
    const layers = [], fail = [], shp = [];
    for (const f of files) {
      const ext = extOf(f.name);
      try {
        if (ext === 'kml') layers.push(layerOf(baseOf(f.name), 'KML', readKml(await f.text())));
        else if (ext === 'geojson' || ext === 'json') layers.push(layerOf(baseOf(f.name), 'GeoJSON', readGeoJson(await f.text())));
        else if (ext === 'kmz' || ext === 'zip') { const r = await zipLayers(f.name, await f.arrayBuffer(), ext === 'kmz'); layers.push(...r.layers); fail.push(...r.fail); }
        else if (SHP_PARTS.includes(ext)) shp.push({ path: f.name, ext, file: f });
        else fail.push(f.name + ': not a KML, KMZ, GeoJSON or shapefile');
      } catch (e) { fail.push(f.name + ': ' + (e.message || e)); }
    }
    for (const g of groupShp(shp, true)) {
      try { layers.push(await shpLayer(g, async it => bytes(await it.file.arrayBuffer()), it => it.file.text())); } catch (e) { fail.push(g.name + '.shp: ' + (e.message || e)); }
    }
    return { layers, fail };
  }

  /* ---------- kept on this device ---------- */
  const DB = {
    name: 'gengis-imports', db: null, mem: { meta: new Map(), geo: new Map() },
    open() {
      if (this.db) return Promise.resolve(this.db);
      if (typeof indexedDB === 'undefined') return Promise.resolve(null);
      return new Promise(res => {
        let r;
        try { r = indexedDB.open(this.name, 1); } catch (e) { res(null); return; }
        r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta'); if (!d.objectStoreNames.contains('geo')) d.createObjectStore('geo'); };
        r.onsuccess = () => { this.db = r.result; res(this.db); };
        r.onerror = () => res(null);
      });
    },
    async req(store, mode, fn) {
      const db = await this.open();
      if (!db) { const m = this.mem[store]; return fn(null, m); }
      return new Promise((res, rej) => {
        const q = fn(db.transaction(store, mode).objectStore(store));
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
    },
    get(store, key) { return this.req(store, 'readonly', (s, m) => (s ? s.get(key) : m.get(key))); },
    all(store) { return this.req(store, 'readonly', (s, m) => (s ? s.getAll() : Array.from(m.values()))); },
    set(store, key, v) { return this.req(store, 'readwrite', (s, m) => (s ? s.put(v, key) : m.set(key, v))); },
    del(store, key) { return this.req(store, 'readwrite', (s, m) => (s ? s.delete(key) : m.delete(key))); }
  };

  /* ---------- on the map ---------- */
  // A feature's style: its own colors where it has them, the layer's color for the rest.
  function styleFor(color, kind, s) {
    s = s || {};
    const op = (v, d) => (v == null || !isFinite(v) ? d : Math.max(0, Math.min(1, v)));
    if (kind === 'point') return { radius: 6, color: '#ffffff', weight: 1.5, opacity: 1, fillColor: s.marker || s.fill || s.stroke || color, fillOpacity: 0.95 };
    const w = s.strokeWidth == null || !isFinite(s.strokeWidth) ? (kind === 'line' ? 2.5 : 2) : Math.max(0, Math.min(12, s.strokeWidth));
    const st = { color: s.stroke || color, weight: w, opacity: !w || (kind === 'polygon' && s.outline === false) ? 0 : op(s.strokeOpacity, 1) };
    if (kind === 'polygon') { st.fillColor = s.fill || s.stroke || color; st.fillOpacity = op(s.fillOpacity, 0.25); }
    return st;
  }
  function labelOf(p) {
    for (const k of ['name', 'NAME', 'Name', 'title', 'TITLE', 'label', 'LABEL']) if (p[k] != null && p[k] !== '') return String(p[k]);
    return '';
  }
  function boundsOf(features) {
    let s = 90, w = 180, n = -90, e = -180;
    const walk = c => { if (typeof c[0] === 'number') { if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0]; if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1]; } else c.forEach(walk); };
    features.forEach(f => walk(f.geometry.coordinates));
    return n >= s ? [[s, w], [n, e]] : null;
  }
  function fieldsOf(features) {
    const keys = new Set();
    for (let i = 0; i < features.length && i < 500 && keys.size < 18; i++) for (const k of Object.keys(features[i].properties)) { keys.add(k); if (keys.size >= 18) break; }
    return Array.from(keys);
  }
  function typesOf(features) {
    const t = new Set(features.map(f => kindOf(f.geometry)));
    return ['point', 'line', 'polygon'].filter(k => t.has(k)).map(k => k + 's').join(', ');
  }

  const layers = new Map(); // id -> { meta, fc (when loaded), group (when drawn), styles: WeakMap props -> kind/style }

  MB.imports = {
    job: null,     // what is being read: { name }
    notes: [],     // what the files opened came to: [{ text, warn }]
    read: { parseXml, kml: readKml, geoJson: readGeoJson, shapefile: readShapefile, shp: readShp, dbf: readDbf, projection, zip: readZip, files: readFiles, styleFor },

    async init() {
      let metas = [];
      try { metas = await DB.all('meta'); } catch (e) { console.warn('File imports', e); }
      metas.sort((a, b) => (a.added || 0) - (b.added || 0)).forEach(meta => layers.set(meta.id, { meta }));
      for (const l of layers.values()) if (l.meta.visible) await this.draw(l);
      this.changed();
    },

    list() { return Array.from(layers.values()).map(l => l.meta); },
    enabledCount() { return this.list().filter(m => m.visible).length; },
    // The shown layers as the identify popup takes a dataset (datalayers.js).
    sets() { return Array.from(layers.values()).filter(l => l.meta.visible && l.group && l.ds).map(l => l.ds); },
    isImportFile: f => ['kml', 'kmz', 'shp', 'dbf', 'prj', 'cpg', 'shx'].includes(extOf(f.name)),
    // Dropped .zip files: those with a shapefile, KML or GeoJSON in them, and the others (map sources, say).
    async sortZips(files) {
      const geo = [], other = [];
      for (const f of files) {
        let names = [];
        try { names = readZip(await f.arrayBuffer()).names; } catch (e) { /* not a zip it can read: the other reader says why */ }
        (names.some(nm => /\.(shp|kml|geojson)$/i.test(nm)) ? geo : other).push(f);
      }
      return { geo, other };
    },

    // Read the files, each layer to the map and kept; a message says what came of them, the panel's notes the rest.
    async openFiles(files) {
      const list = Array.from(files || []);
      if (!list.length) return [];
      this.job = { name: list.length === 1 ? list[0].name : plural(list.length, 'file') };
      if (MB.busy) MB.busy.set('imports', 'imported files');
      this.changed();
      const ids = [];
      let res = { layers: [], fail: [] };
      try {
        res = await readFiles(list);
        for (const l of res.layers) {
          try { ids.push(await this.add(l)); } catch (e) { res.fail.push(l.name + ': could not be kept (' + (e.message || e) + ')'); }
          this.note(`${l.name}: ${plural(l.features.length, 'feature')} on the map${l.notes.length ? '; ' + l.notes.join('; ') : ''}.`, l.notes.length > 0);
        }
        res.fail.forEach(t => this.note(t + '.', true));
      } finally {
        this.job = null;
        if (MB.busy) MB.busy.clear('imports');
        this.changed();
      }
      if (ids.length) this.zoomTo(ids.length === 1 ? ids[0] : null, ids);
      if (MB.toast) {
        const n = res.layers.reduce((s, l) => s + l.features.length, 0);
        if (ids.length && !res.fail.length) MB.toast(ids.length === 1 ? `${res.layers[0].name}: ${plural(n, 'feature')} imported` : `${ids.length} layers imported (${plural(n, 'feature')})`, 3500);
        else if (res.fail.length) MB.toast(res.fail.length === 1 && !ids.length ? 'Not imported: ' + res.fail[0] : `${ids.length} imported, ${res.fail.length} not: see File imports in the Data panel`, 6000);
      }
      return ids;
    },

    async add(l) {
      const id = MB.uid ? MB.uid() : 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const fc = { type: 'FeatureCollection', features: l.features };
      const meta = { id, name: l.name, kind: l.kind, color: PALETTE[layers.size % PALETTE.length], visible: true, count: l.features.length,
        bounds: boundsOf(l.features), fields: fieldsOf(l.features), types: typesOf(l.features), added: Date.now() };
      await DB.set('geo', id, fc);
      await DB.set('meta', id, meta);
      const rec = { meta, fc };
      layers.set(id, rec);
      await this.draw(rec);
      return id;
    },

    async load(rec) {
      if (!rec.fc) rec.fc = await DB.get('geo', rec.meta.id);
      return rec.fc;
    },
    // The layer on the map (built the first time it shows).
    async draw(rec) {
      if (typeof L === 'undefined' || !MB.map) return;
      if (!rec.group) {
        const fc = await this.load(rec);
        if (!fc) return;
        const styles = rec.styles = new WeakMap(), renderer = MB.data && MB.data.dataRenderer ? MB.data.dataRenderer() : undefined;
        const style = f => { const s = styleFor(rec.meta.color, kindOf(f.geometry), f.mbStyle); styles.set(f.properties, { kind: kindOf(f.geometry), own: f.mbStyle }); return s; };
        rec.group = L.geoJSON(fc, {
          pane: 'mb-data', pmIgnore: true, renderer,
          style,
          pointToLayer: (f, ll) => L.circleMarker(ll, Object.assign({ pane: 'mb-data', pmIgnore: true, renderer }, style(f))),
          onEachFeature: (f, layer) => {
            layer.options.pmIgnore = true;
            const lbl = labelOf(f.properties || {});
            if (lbl) layer.bindTooltip(lbl, { sticky: true, className: 'mb-name-tip', direction: 'top', opacity: 0.95 });
            layer.on('click', e => {
              const t = MB.tools && MB.tools.current;
              if (t && t !== 'select' && t !== 'move' && t !== 'present') return;
              L.DomEvent.stopPropagation(e);
              if (MB.data && MB.data.identify) MB.data.identify(e.latlng, e.containerPoint, layer);
            });
          }
        });
        rec.ds = {
          imp: true, enabled: true, group: rec.group, meta: null, feats: new Map(),
          def: { id: 'import:' + rec.meta.id, name: rec.meta.name, group: rec.meta.kind + ' file', publisher: 'File import (this device)',
            fields: rec.meta.fields, label: labelOf,
            style: p => { const s = styles.get(p) || { kind: 'polygon' }; return styleFor(rec.meta.color, s.kind, s.own); } }
        };
      }
      if (rec.meta.visible && !MB.map.hasLayer(rec.group)) rec.group.addTo(MB.map);
    },

    async setVisible(id, on) {
      const rec = layers.get(id);
      if (!rec) return;
      rec.meta.visible = !!on;
      if (on) await this.draw(rec);
      else {
        if (rec.group && MB.map) MB.map.removeLayer(rec.group);
        if (MB.data && MB.data.picked && rec.ds && MB.data.picked.ds === rec.ds) MB.data.pick(null);
      }
      await DB.set('meta', id, rec.meta);
      this.changed();
    },
    async setColor(id, color) {
      const rec = layers.get(id);
      if (!rec || !/^#[0-9a-f]{6}$/i.test(color)) return;
      rec.meta.color = color;
      if (rec.group) rec.group.eachLayer(l => { if (l.feature && l.setStyle) l.setStyle(styleFor(color, kindOf(l.feature.geometry), l.feature.mbStyle)); });
      await DB.set('meta', id, rec.meta);
      this.changed();
    },
    // Fit the map to one layer, or to several (ids).
    zoomTo(id, ids) {
      if (typeof L === 'undefined' || !MB.map) return;
      let b = null;
      (ids || [id]).forEach(i => { const r = layers.get(i); if (r && r.meta.bounds) { const x = L.latLngBounds(r.meta.bounds); b = b ? b.extend(x) : x; } });
      if (!b || !b.isValid()) return;
      if (b.getNorth() - b.getSouth() < 1e-6 && b.getEast() - b.getWest() < 1e-6) MB.map.setView(b.getCenter(), Math.max(MB.map.getZoom(), 16));
      else MB.map.fitBounds(b.pad(0.1), { maxZoom: 18 });
    },
    async remove(id) {
      const rec = layers.get(id);
      if (!rec) return;
      if (rec.group && MB.map) MB.map.removeLayer(rec.group);
      if (MB.data && MB.data.picked && rec.ds && MB.data.picked.ds === rec.ds) MB.data.pick(null);
      layers.delete(id);
      await DB.del('meta', id);
      await DB.del('geo', id);
      this.changed();
    },
    // The layer's features into the project as its own objects (a layer of the same name): names and colors carry
    // over; the attributes stay with the import.
    async toProject(id) {
      const rec = layers.get(id);
      if (!rec || !MB.importGeoJSON) return;
      if (rec.meta.count > COPY_WARN && typeof confirm === 'function' && !confirm(`Copy ${rec.meta.count.toLocaleString()} features into the project? Projects this large are slower to edit and save.`)) return;
      const fc = await this.load(rec);
      if (!fc) return;
      const features = fc.features.map(f => {
        const st = styleFor(rec.meta.color, kindOf(f.geometry), f.mbStyle), p = { name: labelOf(f.properties) };
        if (kindOf(f.geometry) === 'point') { p.stroke = st.fillColor; p['marker-color'] = st.fillColor; }
        else { p.stroke = st.color; p['stroke-width'] = st.weight; p['stroke-opacity'] = st.opacity; if (st.fillColor) { p.fill = st.fillColor; p['fill-opacity'] = st.fillOpacity; } }
        return { type: 'Feature', properties: p, geometry: f.geometry };
      });
      MB.importGeoJSON({ type: 'FeatureCollection', features }, rec.meta.name);
    },

    note(text, warn) { this.notes.push({ text, warn: !!warn }); this.notes = this.notes.slice(-20); },
    changed() { if (MB.emit) MB.emit('data'); },

    /* ---------- the panel (datalayers.js draws it at the top of the Data panel) ---------- */
    dot() {
      const all = this.list(), shown = all.filter(m => m.visible).length;
      if (!all.length) return ['off', 'No files imported'];
      return shown ? ['on', shown + ' of ' + all.length + ' shown'] : ['off', 'All hidden'];
    },
    matches(q, filter) {
      const on = this.dot()[0] === 'on';
      if (filter === 'on' && !on) return false;
      if (filter === 'off' && on) return false;
      return !q || ('file imports import kml kmz geojson json shapefile shp zip google earth ' + this.list().map(m => m.name).join(' ')).toLowerCase().includes(q);
    },
    rowHtml(m) {
      const meta = [m.kind, plural(m.count, 'feature'), m.types].filter(Boolean).join(' · ');
      return `<div class="data-item trk-item imp-item${m.visible ? ' on' : ''}" data-imp="${esc(m.id)}">
          <div class="trk-head"><label class="check"><input type="checkbox" data-imp-act="vis"${m.visible ? ' checked' : ''}> <span class="dname" title="${esc(m.name)}">${esc(m.name)}</span></label>
            <span class="trk-acts"><label class="imp-sw" title="Color for features without their own"><input type="color" value="${esc(m.color)}" data-imp-act="color" aria-label="Color of ${esc(m.name)}"></label>${MB.iconBtn('goto', 'Zoom to the layer', 'data-imp-act="zoom"', '', 'Zoom to ' + m.name)}${MB.iconBtn('copy', 'Copy into the project', 'data-imp-act="copy"', '', 'Copy ' + m.name + ' into the project')}${MB.iconBtn('trash', 'Remove', 'data-imp-act="remove"', 'danger', 'Remove ' + m.name)}</span></div>
          <div class="dstatus">${esc(meta)}</div>
        </div>`;
    },
    panelHtml(q, filter) {
      if (!this.matches(q, filter)) return '';
      const job = this.job;
      return `<details class="ds-source" id="impSource" data-src="imports"${MB.data.sourceOpen('imports') ? ' open' : ''}><summary class="ds-source-head"><h3>File imports</h3>${MB.data.dotHtml('impDot', ...this.dot())}</summary>
        <div class="section"><div class="data-item adsb-display" id="impItem">
          <div class="ds-head"><button type="button" class="btn small with-icon" data-imp-act="open">${MB.ICON.upload.replace('<svg ', '<svg class="mi" ')}Import files</button><span class="dim trk-kinds">.kml · .kmz · .geojson · .shp · .zip</span>${MB.data.infoIcon('KML or KMZ (Google Earth), GeoJSON, or a shapefile: pick its .shp with the .dbf, .prj and .cpg beside it, or a .zip of them. Each file is a layer over the map, kept on this device (not in the project) until you remove it. Click a feature for its attributes; Copy into the project makes them objects you can edit. You can also drop files here or on the map.')}</div>
          <div class="dstatus" id="impJob"${job ? '' : ' hidden'}>${job ? 'Reading ' + esc(job.name) + '…' : ''}</div>
          <div id="impNotes">${this.notes.slice(-3).map(n => `<div class="dstatus${n.warn ? ' err' : ''}">${esc(n.text)}</div>`).join('')}</div>
          <div id="impList" class="trk-list">${this.list().map(m => this.rowHtml(m)).join('')}</div>
        </div></div></details>`;
    },
    bindPanel(panel) {
      const item = panel.querySelector('#impItem');
      if (!item) return;
      const idOf = el => { const r = el.closest('[data-imp]'); return r ? r.dataset.imp : null; };
      item.addEventListener('click', e => {
        const b = e.target.closest('button[data-imp-act]');
        if (!b) return;
        const act = b.dataset.impAct, id = idOf(b);
        if (act === 'open') this.input().click();
        else if (act === 'zoom') this.zoomTo(id);
        else if (act === 'copy') this.toProject(id);
        else if (act === 'remove') {
          const m = layers.get(id);
          if (m && (typeof confirm !== 'function' || confirm(`Remove ${m.meta.name} from this device? Open the file again to bring it back.`))) this.remove(id);
        }
      });
      item.addEventListener('change', e => {
        const act = e.target.dataset.impAct, id = idOf(e.target);
        if (act === 'vis') this.setVisible(id, e.target.checked);
        else if (act === 'color') this.setColor(id, e.target.value);
      });
      item.addEventListener('dragover', e => { e.preventDefault(); item.classList.add('over'); });
      item.addEventListener('dragleave', () => item.classList.remove('over'));
      item.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); item.classList.remove('over'); this.openFiles(e.dataTransfer.files); });
    },
    // The file chooser: one for the page, outside the panel (which is redrawn while it is open).
    input() {
      if (this._input) return this._input;
      const el = this._input = document.createElement('input');
      el.type = 'file'; el.multiple = true; el.hidden = true;
      el.accept = '.kml,.kmz,.geojson,.json,.shp,.dbf,.prj,.cpg,.shx,.zip,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/geo+json,application/zip';
      el.addEventListener('change', () => { const files = Array.from(el.files || []); el.value = ''; this.openFiles(files); });
      document.body.appendChild(el);
      return el;
    }
  };
})(window.MB);
