'use strict';
// File imports (js/fileimports.js): the KML, GeoJSON and shapefile readers, the projections a .prj names (against the
// worked examples of EPSG Guidance Note 7-2 and Snyder's Map Projections), and zips; the files are written here byte
// by byte.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..');

function load(extra) {
  const MB = { escapeHtml: s => String(s), toast: () => {}, emit: () => {} };
  const ctx = Object.assign({ window: { MB }, TextDecoder, Blob, DecompressionStream, console, Date, Math, setTimeout, clearTimeout }, extra || {});
  vm.createContext(ctx);
  for (const f of ['js/util.js', 'js/fileimports.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }); // (util.js: formatted text)
  return MB;
}
const MB = load(), IMP = MB.imports, R = IMP.read;
const plain = x => JSON.parse(JSON.stringify(x));
const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: ${got} is not within ${tol} of ${want}`);

/* ---------- writers ---------- */
function zip(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), raw = Buffer.from(e.data), data = e.store ? raw : zlib.deflateRawSync(raw), method = e.store ? 0 : 8;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    centrals.push(ch, name);
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

// A .shp: records { type: 'point', xy } | { type: 'line' | 'polygon', parts: [[[x, y], …], …] } | { type: 'null' }
// (no spread over the points: a record of 100,000 rings would overflow the argument limit here, before the reader)
const extent = pts => { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (const p of pts) { if (p[0] < b[0]) b[0] = p[0]; if (p[1] < b[1]) b[1] = p[1]; if (p[0] > b[2]) b[2] = p[0]; if (p[1] > b[3]) b[3] = p[1]; } return b; };
function shp(records) {
  const all = [], bufs = [];
  records.forEach((r, i) => {
    let c;
    if (r.type === 'null') { c = Buffer.alloc(4); c.writeInt32LE(0, 0); }
    else if (r.type === 'point') { c = Buffer.alloc(20); c.writeInt32LE(1, 0); c.writeDoubleLE(r.xy[0], 4); c.writeDoubleLE(r.xy[1], 12); all.push(r.xy); }
    else {
      const pts = r.parts.flat();
      c = Buffer.alloc(44 + 4 * r.parts.length + 16 * pts.length);
      c.writeInt32LE(r.type === 'line' ? 3 : 5, 0);
      extent(pts).forEach((v, k) => c.writeDoubleLE(v, 4 + 8 * k));
      c.writeInt32LE(r.parts.length, 36); c.writeInt32LE(pts.length, 40);
      let at = 0;
      r.parts.forEach((p, k) => { c.writeInt32LE(at, 44 + 4 * k); at += p.length; });
      pts.forEach((p, k) => { c.writeDoubleLE(p[0], 44 + 4 * r.parts.length + 16 * k); c.writeDoubleLE(p[1], 52 + 4 * r.parts.length + 16 * k); });
      for (const p of pts) all.push(p);
    }
    const rh = Buffer.alloc(8); rh.writeInt32BE(i + 1, 0); rh.writeInt32BE(c.length / 2, 4);
    bufs.push(rh, c);
  });
  const body = Buffer.concat(bufs), h = Buffer.alloc(100);
  h.writeInt32BE(9994, 0); h.writeInt32BE((100 + body.length) / 2, 24); h.writeInt32LE(1000, 28); h.writeInt32LE(5, 32);
  extent(all).forEach((v, k) => h.writeDoubleLE(v, 36 + 8 * k));
  return Buffer.concat([h, body]);
}

// A .dbf: fields [{ name, type, len }], rows [values…] or { deleted: [values…] }; text in the given Node encoding.
function dbf(fields, rows, enc) {
  const hl = 32 + 32 * fields.length + 1, rl = 1 + fields.reduce((s, f) => s + f.len, 0);
  const h = Buffer.alloc(hl);
  h[0] = 3; h.writeUInt32LE(rows.length, 4); h.writeUInt16LE(hl, 8); h.writeUInt16LE(rl, 10);
  fields.forEach((f, i) => { h.write(f.name, 32 + 32 * i, 'ascii'); h.write(f.type, 32 + 32 * i + 11, 'ascii'); h[32 + 32 * i + 16] = f.len; });
  h[hl - 1] = 0x0d;
  const recs = rows.map(r => {
    const vals = Array.isArray(r) ? r : r.deleted, b = Buffer.alloc(rl, 0x20);
    b[0] = Array.isArray(r) ? 0x20 : 0x2a;
    let at = 1;
    fields.forEach((f, i) => {
      const v = vals[i] == null ? '' : String(vals[i]), enc8 = Buffer.from(v, f.type === 'C' ? enc || 'utf8' : 'ascii');
      (f.type === 'N' ? Buffer.from(v.padStart(f.len)) : enc8).copy(b, at, 0, f.len);
      at += f.len;
    });
    return b;
  });
  return Buffer.concat([h, ...recs, Buffer.from([0x1a])]);
}

// Files as a file chooser hands them over.
const file = (name, data) => ({ name, text: async () => Buffer.from(data).toString('utf8'), arrayBuffer: async () => { const b = Buffer.from(data); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } });

/* ---------- KML ---------- */
const KML = `<?xml version="1.0" encoding="UTF-8"?>
<!-- written by hand -->
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document><name>Field day</name>
  <Style id="red"><LineStyle><color>ff0000ff</color><width>4</width></LineStyle><PolyStyle><color>7f00ff00</color><outline>0</outline></PolyStyle></Style>
  <Style id="blue-pin"><IconStyle><color>ffff0000</color></IconStyle></Style>
  <StyleMap id="pin"><Pair><key>normal</key><styleUrl>#blue-pin</styleUrl></Pair><Pair><key>highlight</key><styleUrl>#red</styleUrl></Pair></StyleMap>
  <Folder><name>Sites</name><Folder><name>North</name>
    <Placemark><name>Tower &amp; mast</name><styleUrl>#pin</styleUrl>
      <description><![CDATA[<b>Height</b>: 30&nbsp;m<br/>Built 1999<script>alert(1)</script>]]></description>
      <ExtendedData><Data name="owner"><value>County</value></Data><SchemaData schemaUrl="#s"><SimpleData name="id">T-7</SimpleData></SchemaData></ExtendedData>
      <Point><coordinates>-73.9857, 40.7484, 381</coordinates></Point></Placemark>
  </Folder></Folder>
  <Placemark><name>Lot</name><styleUrl>#red</styleUrl>
    <MultiGeometry>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,1 0,0</coordinates></LinearRing></outerBoundaryIs>
        <innerBoundaryIs><LinearRing><coordinates>.2,.2 .4,.2 .4,.4 .2,.2</coordinates></LinearRing></innerBoundaryIs></Polygon>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>2,2 3,2 3,3 2,2</coordinates></LinearRing></outerBoundaryIs></Polygon>
      <Point><coordinates>0.5,0.5</coordinates></Point>
    </MultiGeometry></Placemark>
  <Placemark><name>Flight</name><TimeSpan><begin>2026-05-01T10:00:00Z</begin></TimeSpan><Style><LineStyle><color>ff00ffff</color></LineStyle></Style>
    <gx:Track><when>2026-05-01T10:00:00Z</when><when>2026-05-01T10:00:05Z</when><gx:coord>-122.1 37.4 100</gx:coord><gx:coord>-122.2 37.5 120</gx:coord></gx:Track></Placemark>
  <Placemark><name>Statue</name><Model><Location><longitude>1</longitude><latitude>2</latitude></Location></Model></Placemark>
  <GroundOverlay><name>Scan</name></GroundOverlay><GroundOverlay/><NetworkLink><name>Live</name></NetworkLink>
</Document></kml>`;

test('KML: placemarks with their styles (shared, through a style map, or their own), folders, descriptions and data', () => {
  const { features, notes } = R.kml(KML);
  const byName = n => features.filter(f => f.properties.name === n);
  const [tower] = byName('Tower & mast');
  assert.deepEqual(plain(tower.geometry), { type: 'Point', coordinates: [-73.9857, 40.7484] }, 'longitude/latitude; the altitude dropped; spaces after commas forgiven');
  assert.equal(tower.properties.folder, 'Sites / North');
  assert.equal(tower.properties.description, '<b>Height</b>: 30&nbsp;m<br/>Built 1999<script>alert(1)</script>', 'a formatted description: kept as the file has it (popups show it made safe)');
  assert.equal(tower.properties.owner, 'County');
  assert.equal(tower.properties.id, 'T-7');
  assert.deepEqual(plain(tower.mbStyle), { marker: '#0000ff' }, 'the style map\'s normal style (KML colors are aabbggrr)');

  const lot = byName('Lot');
  assert.deepEqual(plain(lot.map(f => f.geometry.type)), ['MultiPolygon', 'Point'], 'parts of one kind together, other kinds features of their own');
  assert.equal(lot[0].geometry.coordinates[0].length, 2, 'the first polygon keeps its hole');
  assert.notEqual(lot[0].properties, lot[1].properties, 'each feature its own attributes (one style each on the map)');
  assert.deepEqual(plain(lot[0].properties), plain(lot[1].properties));
  assert.deepEqual(plain(lot[0].mbStyle), { stroke: '#ff0000', strokeOpacity: 1, strokeWidth: 4, fill: '#00ff00', fillOpacity: 0.5, outline: false });

  const [flight] = byName('Flight');
  assert.deepEqual(plain(flight.geometry), { type: 'LineString', coordinates: [[-122.1, 37.4], [-122.2, 37.5]] }, 'a gx:Track is its line');
  assert.equal(flight.properties.begin, '2026-05-01T10:00:00Z');
  assert.equal(flight.mbStyle.stroke, '#ffff00', 'its own style');

  assert.equal(byName('Statue').length, 0);
  assert.deepEqual(plain(notes), ['2 ground overlays, 1 network link, 1 placemark with no point, line or polygon (a 3D model, or empty) left out']);
});

test('KML: not KML, or not well-formed, says so', () => {
  assert.throws(() => R.kml('<gpx><trk/></gpx>'), /not a KML file/);
  assert.throws(() => R.kml('<kml><Document><name>x</name'), /not well-formed/);
});

/* ---------- GeoJSON ---------- */
test('GeoJSON: features, bare geometries and collections; simplestyle colors; bad coordinates dropped', () => {
  const gj = {
    type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { name: 'A', stroke: '#123456', 'stroke-width': 3, fill: 'abcdef', 'fill-opacity': '0.4' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
      { type: 'Feature', properties: null, geometry: { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [5, 5] }, { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, { type: 'Point', coordinates: [6, 6] }] } },
      { type: 'Feature', properties: { name: 'nowhere' }, geometry: null },
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [500, 900]] } },
      { type: 'Feature', properties: { style: { color: '#ff0000', weight: 5 } }, geometry: { type: 'Point', coordinates: [1, 2, 3] } }
    ]
  };
  const { features, notes } = R.geoJson(JSON.stringify(gj));
  assert.deepEqual(plain(features.map(f => f.geometry.type)), ['Polygon', 'LineString', 'MultiPoint', 'Point']);
  assert.deepEqual(plain(features[0].mbStyle), { stroke: '#123456', strokeWidth: 3, fill: '#abcdef', fillOpacity: 0.4 });
  assert.deepEqual(plain(features[2].geometry.coordinates), [[5, 5], [6, 6]]);
  assert.deepEqual(plain(features[3].mbStyle), { stroke: '#ff0000', strokeWidth: 5 }, 'the style GenGIS writes');
  assert.deepEqual(plain(notes), ['2 features with no usable geometry left out']);
  assert.equal(R.geoJson({ type: 'Point', coordinates: [1, 2] }).features.length, 1, 'a bare geometry');
});

test('GeoJSON: Web Mercator by its crs; another crs, TopoJSON or projected coordinates refused', () => {
  const merc = { type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3857' } },
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-11169055.58, 2800000.00] } }] };
  const [p] = R.geoJson(merc).features;
  near(p.geometry.coordinates[0], -100.3333333, 1e-6, 'longitude');
  near(p.geometry.coordinates[1], 24.3817869, 1e-6, 'latitude');
  assert.throws(() => R.geoJson(Object.assign({}, merc, { crs: { type: 'name', properties: { name: 'EPSG:27700' } } })), /coordinate system \(EPSG:27700\) is not supported/);
  assert.throws(() => R.geoJson({ type: 'Topology', objects: {} }), /TopoJSON/);
  assert.throws(() => R.geoJson('{"type":'), /not valid JSON/);
  assert.throws(() => R.geoJson({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [583960, 4507523] } }), /none of its coordinates are longitude\/latitude/);
});

/* ---------- projections ---------- */
const GEOG = (name, sph, a, invf) => `GEOGCS["${name}",DATUM["D_${name}",SPHEROID["${sph}",${a},${invf}]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]`;
const PROJ = (geog, method, params, unit) => `PROJCS["test",${geog},PROJECTION["${method}"],${Object.entries(params).map(([k, v]) => `PARAMETER["${k}",${v}]`).join(',')},${unit || 'UNIT["Meter",1.0]'}]`;
const inv = (wkt, x, y) => R.projection(wkt).inverse(x, y);

test('projections: transverse Mercator (British National Grid, EPSG GN 7-2)', () => {
  const wkt = PROJ(GEOG('OSGB_1936', 'Airy_1830', 6377563.396, 299.3249646), 'Transverse_Mercator',
    { False_Easting: 400000, False_Northing: -100000, Central_Meridian: -2, Scale_Factor: 0.9996012717, Latitude_Of_Origin: 49 });
  const [lon, lat] = inv(wkt, 577274.99, 69740.50);
  near(lat, 50.5, 2e-7, 'latitude'); near(lon, 0.5, 2e-7, 'longitude');
  const [l2, p2] = inv(PROJ(GEOG('WGS_1984', 'WGS_1984', 6378137, 298.257223563), 'Transverse_Mercator', { False_Easting: 500000, False_Northing: 0, Central_Meridian: 15, Scale_Factor: 0.9996, Latitude_Of_Origin: 0 }), 500000, 0);
  near(l2, 15, 1e-9, 'UTM 33N central meridian'); near(p2, 0, 1e-9, 'equator');
});

test('projections: Lambert conformal conic, two standard parallels, in US survey feet (Texas South Central, EPSG GN 7-2)', () => {
  const wkt = PROJ(GEOG('North_American_1927', 'Clarke_1866', 6378206.4, 294.9786982), 'Lambert_Conformal_Conic',
    { False_Easting: 2000000, False_Northing: 0, Central_Meridian: -99, Standard_Parallel_1: 28 + 23 / 60, Standard_Parallel_2: 30 + 17 / 60, Latitude_Of_Origin: 27 + 50 / 60 },
    'UNIT["Foot_US",0.3048006096012192]');
  const [lon, lat] = inv(wkt, 2963503.91, 254759.80);
  near(lat, 28.5, 2e-7, 'latitude'); near(lon, -96, 2e-7, 'longitude');
});

test('projections: Mercator (Makassar / NEIEZ, EPSG GN 7-2) and Web Mercator', () => {
  const wkt = PROJ(GEOG('Makassar', 'Bessel_1841', 6377397.155, 299.1528128), 'Mercator_1SP',
    { false_easting: 3900000, false_northing: 900000, central_meridian: 110, scale_factor: 0.997, latitude_of_origin: 0 });
  const [lon, lat] = inv(wkt, 5009726.58, 569150.82);
  near(lat, -3, 2e-7, 'latitude'); near(lon, 120, 2e-7, 'longitude');
  const web = PROJ(GEOG('WGS_1984', 'WGS_1984', 6378137, 298.257223563), 'Mercator_Auxiliary_Sphere',
    { False_Easting: 0, False_Northing: 0, Central_Meridian: 0, Standard_Parallel_1: 0, Auxiliary_Sphere_Type: 0 });
  const [l2, p2] = inv(web, -11169055.58, 2800000.00);
  near(p2, 24 + 22 / 60 + 54.433 / 3600, 2e-7, 'latitude'); near(l2, -100 - 20 / 60, 2e-7, 'longitude');
});

test('projections: Albers equal-area (Snyder\'s worked example)', () => {
  const wkt = PROJ(GEOG('North_American_1927', 'Clarke_1866', 6378206.4, 294.9786982), 'Albers',
    { False_Easting: 0, False_Northing: 0, Central_Meridian: -96, Standard_Parallel_1: 29.5, Standard_Parallel_2: 45.5, Latitude_Of_Origin: 23 });
  const [lon, lat] = inv(wkt, 1885472.7, 1535925.0);
  near(lat, 35, 2e-6, 'latitude'); near(lon, -75, 2e-6, 'longitude');
});

test('projections: geographic as it is; one it cannot read refused, with its name', () => {
  const g = R.projection(GEOG('WGS_1984', 'WGS_1984', 6378137, 298.257223563));
  assert.equal(g.geographic, true);
  assert.deepEqual(plain(g.inverse(-73.5, 45.25)).map(v => +v.toFixed(9)), [-73.5, 45.25]);
  assert.throws(() => R.projection(PROJ(GEOG('WGS_1984', 'WGS_1984', 6378137, 298.257223563), 'Polar_Stereographic', { False_Easting: 0 })), /Polar_Stereographic\) is not one GenGIS can read/);
  assert.throws(() => R.projection('nonsense'), /could not be read/);
});

/* ---------- shapefiles ---------- */
const FIELDS = [{ name: 'NAME', type: 'C', len: 12 }, { name: 'POP', type: 'N', len: 8 }, { name: 'OPEN', type: 'L', len: 1 }, { name: 'SINCE', type: 'D', len: 8 }];
const SQUARE = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];      // clockwise: an outline
const HOLE = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];             // counter-clockwise: a hole
const ISLAND = [[20, 20], [20, 21], [21, 21], [21, 20], [20, 20]]; // clockwise: a second outline

test('shapefile: points, lines and polygons (holes in the outline they are in), its attributes, deleted and null records left out', () => {
  const parts = {
    shp: shp([{ type: 'point', xy: [-73.5, 45.25] }, { type: 'line', parts: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }, { type: 'polygon', parts: [SQUARE, ISLAND, HOLE] }, { type: 'null' }, { type: 'point', xy: [1, 1] }]),
    dbf: dbf(FIELDS, [['Montréal', '1762949', 'T', '19990105'], ['Road', '', '?', ''], ['Park', '*****', 'F', '00000000'], ['Nothing', '1', 'T', ''], { deleted: ['Gone', '1', 'T', ''] }], 'latin1'),
    prj: GEOG('WGS_1984', 'WGS_1984', 6378137, 298.257223563), cpg: '1252'
  };
  const { features, notes } = R.shapefile(parts);
  assert.deepEqual(plain(features.map(f => f.geometry.type)), ['Point', 'MultiLineString', 'MultiPolygon']);
  assert.deepEqual(plain(features[0].properties), { NAME: 'Montréal', POP: 1762949, OPEN: true, SINCE: '1999-01-05' }, 'text in the .cpg\'s encoding; numbers, logicals and dates');
  assert.deepEqual(plain(features[1].properties), { NAME: 'Road' }, 'empty values left out');
  assert.deepEqual(plain(features[2].properties), { NAME: 'Park', OPEN: false });
  const polys = features[2].geometry.coordinates;
  assert.equal(polys.length, 2, 'two outlines');
  assert.equal(polys[0].length, 2, 'the hole in the square');
  assert.equal(polys[1].length, 1, 'none in the island');
  assert.deepEqual(plain(notes), []);
});

test('shapefile: projected by its .prj; without one, longitude/latitude only; without a .dbf, shapes alone', () => {
  const utm = PROJ(GEOG('WGS_1984', 'WGS_1984', 6378137, 298.257223563), 'Transverse_Mercator', { False_Easting: 500000, False_Northing: 0, Central_Meridian: -75, Scale_Factor: 0.9996, Latitude_Of_Origin: 0 });
  const one = shp([{ type: 'point', xy: [500000, 4500000] }]);
  const [f] = R.shapefile({ shp: one, prj: utm }).features;
  near(f.geometry.coordinates[0], -75, 1e-9, 'longitude');
  near(f.geometry.coordinates[1], 40.65086, 1e-4, 'latitude');
  assert.throws(() => R.shapefile({ shp: one }), /no \.prj, and its coordinates are not longitude\/latitude/);
  const bare = R.shapefile({ shp: shp([{ type: 'point', xy: [10, 20] }]) });
  assert.deepEqual(plain(bare.features[0].geometry.coordinates), [10, 20]);
  assert.deepEqual(plain(bare.notes), ['no .prj: read as longitude/latitude', 'no .dbf: shapes without attributes']);
  assert.throws(() => R.shapefile({ dbf: dbf(FIELDS, []) }), /\.shp is missing/);
  assert.throws(() => R.shapefile({ shp: Buffer.from('not a shapefile at all, not even close to one hundred bytes of header....................................') }), /not a shapefile/);
});

test('shapefile text: UTF-8 when it reads as UTF-8, Windows-1252 when not, the .cpg when it names one', () => {
  const f1 = [{ name: 'N', type: 'C', len: 10 }];
  assert.equal(R.dbf(dbf(f1, [['Zürich']], 'utf8'))[0].N, 'Zürich');
  assert.equal(R.dbf(dbf(f1, [['Zürich']], 'latin1'))[0].N, 'Zürich');
  assert.equal(R.dbf(dbf(f1, [['Zürich']], 'utf8'), 'UTF-8')[0].N, 'Zürich');
  // a field with a name every object already has is the record's own field, not the function behind it
  const odd = [{ name: '__proto__', type: 'C', len: 4 }, { name: 'toString', type: 'C', len: 4 }];
  const row = R.dbf(dbf(odd, [['x', 'y']]))[0];
  assert.equal(Object.hasOwn(row, '__proto__'), true, 'a field called "__proto__" is kept');
  assert.equal(Object.getOwnPropertyDescriptor(row, '__proto__').value, 'x', 'as a plain field of its own');
  assert.equal(row.toString, 'y');
});

test('a .dbf whose header cannot be right is refused, not read as four billion records', () => {
  // 66 bytes: a header saying 4,294,967,295 records of no length at all. Every record would start where the last
  // one did, so the loop would never reach the end of the file.
  const bad = Buffer.alloc(66);
  bad[0] = 3;
  bad.writeUInt32LE(0xffffffff, 4); // records
  bad.writeUInt16LE(65, 8);         // header length
  bad.writeUInt16LE(0, 10);         // record length: impossible
  bad.write('N', 32, 'ascii'); bad.write('C', 43, 'ascii'); bad[48] = 10;
  bad[64] = 0x0d; bad[65] = 0x1a;
  const t0 = process.hrtime.bigint();
  assert.throws(() => R.dbf(bad), /\.dbf is damaged/);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 200, 'it is refused at once (' + ms.toFixed(0) + ' ms)');
  const past = Buffer.from(bad); past.writeUInt16LE(10, 10); past.writeUInt16LE(5000, 8); // a header past the end of the file
  assert.throws(() => R.dbf(past), /\.dbf is damaged/);
  // and a header that claims more records than the file holds gives the records that are in it
  const some = dbf([{ name: 'N', type: 'C', len: 4 }], [['a'], ['b']]);
  some.writeUInt32LE(4000000000, 4);
  assert.deepEqual(plain(R.dbf(some).map(r => r.N)), ['a', 'b']);
});

test('a feature\'s own "__proto__" field survives the copies a record\'s parts and a layer written out make', () => {
  const gj = JSON.stringify({ type: 'Feature', properties: JSON.parse('{"__proto__":"p","name":"A"}'),
    geometry: { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [1, 2] }, { type: 'LineString', coordinates: [[0, 0], [1, 1]] }] } });
  const { features } = R.geoJson(gj);
  assert.deepEqual(plain(features.map(f => f.geometry.type)), ['LineString', 'Point'], 'two features, each with the attributes');
  const proto = Object.getPrototypeOf(features[0]); // a plain object's prototype, in the sandbox the reader runs in
  for (const f of features) {
    assert.equal(Object.hasOwn(f.properties, '__proto__'), true, 'the field is the feature\'s own, in the copy too');
    assert.equal(Object.getOwnPropertyDescriptor(f.properties, '__proto__').value, 'p');
    assert.equal(Object.getPrototypeOf(f.properties), proto, 'and the copy has no prototype of its own');
  }
  assert.equal(features[0].properties.name, 'A');
});

/* ---------- files and zips ---------- */
test('files: a shapefile\'s parts picked together (any order, any case), KML and GeoJSON beside them; what cannot be read says why', async () => {
  const res = await R.files([
    file('roads.DBF', dbf([{ name: 'REF', type: 'C', len: 4 }], [['A1']])),
    file('notes.txt', 'hello'),
    file('roads.shp', shp([{ type: 'line', parts: [[[0, 0], [1, 1]]] }])),
    file('sites.kml', KML),
    file('zones.geojson', JSON.stringify({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 1] } })),
    file('lonely.prj', GEOG('WGS_1984', 'WGS_1984', 6378137, 298.257223563))
  ]);
  assert.deepEqual(plain(res.layers.map(l => [l.name, l.kind, l.features.length])), [['sites', 'KML', 4], ['zones', 'GeoJSON', 1], ['roads', 'Shapefile', 1]]);
  assert.equal(res.layers[2].features[0].properties.REF, 'A1');
  assert.deepEqual(plain(res.fail), ['notes.txt: not a KML, KMZ, GeoJSON or shapefile', 'lonely.shp: its .shp is missing (pick the .shp with its .dbf, .prj and .cpg, or a .zip of them)']);
});

test('zips: each shapefile in a .zip a layer (folders kept apart, stored or deflated); a .kmz\'s KML; a zip with neither refused', async () => {
  const z = zip([
    { name: 'data/', data: '' , store: true },
    { name: 'data/parks.shp', data: shp([{ type: 'polygon', parts: [SQUARE] }]) },
    { name: 'data/parks.dbf', data: dbf([{ name: 'NAME', type: 'C', len: 8 }], [['Green']]), store: true },
    { name: 'data/parks.prj', data: GEOG('WGS_1984', 'WGS_1984', 6378137, 298.257223563) },
    { name: 'other/parks.shp', data: shp([{ type: 'point', xy: [1, 2] }, { type: 'point', xy: [3, 4] }]) },
    { name: '__MACOSX/data/._parks.shp', data: 'junk' },
    { name: 'readme.kml', data: KML }
  ]);
  const res = await R.files([file('bundle.zip', z)]);
  assert.deepEqual(plain(res.layers.map(l => [l.name, l.kind, l.features.length])), [['parks', 'Shapefile', 1], ['parks', 'Shapefile', 2], ['readme', 'KML', 4]]);
  assert.equal(res.layers[0].features[0].properties.NAME, 'Green');
  assert.deepEqual(plain(res.fail), []);

  const kmz = zip([{ name: 'files/icon.png', data: 'png', store: true }, { name: 'doc.kml', data: KML }]);
  const k = await R.files([file('trip.kmz', kmz)]);
  assert.deepEqual(plain(k.layers.map(l => [l.name, l.kind, l.features.length])), [['trip', 'KMZ', 4]]);

  const none = await R.files([file('maps.zip', zip([{ name: 'source.xml', data: '<customMapSource/>' }]))]);
  assert.deepEqual(plain(none.fail), ['maps.zip: there is no shapefile, KML or GeoJSON in it']);
  const bad = await R.files([file('broken.zip', 'PK not really')]);
  assert.deepEqual(plain(bad.fail), ['broken.zip: it is not a zip file']);
});

test('a dropped zip goes to the imports when it holds a shapefile, KML or GeoJSON, to the map sources when not', async () => {
  const geo = file('a.zip', zip([{ name: 'x.shp', data: shp([{ type: 'point', xy: [1, 1] }]) }]));
  const maps = file('b.zip', zip([{ name: 'source.xml', data: '<customMapSource/>' }]));
  const sorted = await IMP.sortZips([geo, maps]);
  assert.deepEqual(plain(sorted.geo.map(f => f.name)), ['a.zip']);
  assert.deepEqual(plain(sorted.other.map(f => f.name)), ['b.zip']);
});

test('styles on the map: the feature\'s own colors, the layer\'s color for the rest', () => {
  assert.deepEqual(plain(R.styleFor('#ff8a3d', 'polygon', null)), { color: '#ff8a3d', weight: 2, opacity: 1, fillColor: '#ff8a3d', fillOpacity: 0.25 });
  assert.deepEqual(plain(R.styleFor('#ff8a3d', 'polygon', { stroke: '#ff0000', fill: '#00ff00', fillOpacity: 0.5, outline: false })), { color: '#ff0000', weight: 2, opacity: 0, fillColor: '#00ff00', fillOpacity: 0.5 });
  assert.deepEqual(plain(R.styleFor('#ff8a3d', 'line', { strokeWidth: 40 })), { color: '#ff8a3d', weight: 12, opacity: 1 }, 'no fill on a line; a sane width');
  assert.equal(R.styleFor('#ff8a3d', 'point', { marker: '#0000ff' }).fillColor, '#0000ff');
});

test('wired in: the page loads it (offline too), the Data panel draws its block, a click finds its features, the map takes dropped files', () => {
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert.match(read('index.html'), /<script src="js\/datalayers\.js"><\/script>[\s\S]*<script src="js\/fileimports\.js"><\/script>[\s\S]*<script src="js\/app\.js">/);
  assert.match(read('sw.js'), /'\.\/js\/fileimports\.js'/);
  assert.match(read('js/app.js'), /MB\.data\.init\(\);\s*\n\s*MB\.imports\.init\(\);/, 'after the data layers\' panes exist');
  const dl = read('js/datalayers.js');
  assert.match(dl, /const impHtml = MB\.imports \? MB\.imports\.panelHtml\(q, ui\.filter\) : '';[^\n]*\n\s*html \+= impHtml;\s*\n\s*const adsbHtml/, 'first in the panel');
  assert.match(dl, /if \(MB\.imports\) MB\.imports\.bindPanel\(panel\);/);
  assert.match(dl, /MB\.imports\.sets\(\)[\s\S]{0,400}hitTest\(ds, c, lp, cp\)[\s\S]{0,100}hitTest\(ds, l, lp, cp\)[\s\S]{0,200}return imported\.concat\(hits\);/);
  assert.match(dl, /'data-imp'/, 'a row\'s layer decides whether the panel is patched or rebuilt');
  const ui = read('js/ui.js');
  assert.match(ui, /MB\.imports\.isImportFile\(f\)[\s\S]{0,200}MB\.imports\.openFiles\(imports\)/);
  assert.match(ui, /MB\.imports\.sortZips\(zips\)[\s\S]{0,300}MB\.mapSources\.importFiles\(other\)/, 'a zip of map sources still goes to the map sources');
});

test('review fixes: rings all one way nest by containment; WKT2 false-origin names; angles not in degrees refused; a white KML icon is untinted', () => {
  const ccw = r => r.slice().reverse();
  const { features } = R.shapefile({ shp: shp([{ type: 'polygon', parts: [ccw(SQUARE), HOLE] }]) }); // both counter-clockwise
  assert.equal(features[0].geometry.type, 'Polygon');
  assert.equal(features[0].geometry.coordinates.length, 2, 'the inner ring is the hole');
  const both = R.shapefile({ shp: shp([{ type: 'polygon', parts: [SQUARE, ccw(HOLE)] }]) }); // both clockwise
  assert.equal(both.features[0].geometry.coordinates.length, 2);

  const wkt2ish = PROJ(GEOG('North_American_1927', 'Clarke_1866', 6378206.4, 294.9786982), 'Lambert_Conformal_Conic_2SP',
    { 'Easting at false origin': 2000000, 'Northing at false origin': 0, 'Longitude of false origin': -99, 'Latitude of 1st standard parallel': 28 + 23 / 60, 'Latitude of 2nd standard parallel': 30 + 17 / 60, 'Latitude of false origin': 27 + 50 / 60 },
    'UNIT["US survey foot",0.3048006096012192]');
  const [lon, lat] = inv(wkt2ish, 2963503.91, 254759.80);
  near(lat, 28.5, 2e-7, 'latitude'); near(lon, -96, 2e-7, 'longitude');

  const grads = `PROJCS["NTF_Paris_Lambert",GEOGCS["NTF",DATUM["NTF",SPHEROID["Clarke 1880",6378249.2,293.4660213]],PRIMEM["Paris",2.33722917],UNIT["grad",0.01570796326794897]],PROJECTION["Lambert_Conformal_Conic_1SP"],PARAMETER["latitude_of_origin",52],PARAMETER["central_meridian",0],PARAMETER["scale_factor",0.99987742],PARAMETER["false_easting",600000],PARAMETER["false_northing",2200000],UNIT["metre",1]]`;
  assert.throws(() => R.projection(grads), /angles in grad, not degrees/);

  const white = R.kml('<kml><Style id="w"><IconStyle><color>ffffffff</color></IconStyle></Style><Placemark><styleUrl>#w</styleUrl><Point><coordinates>1,2</coordinates></Point></Placemark></kml>');
  assert.equal(white.features[0].mbStyle, undefined, 'no marker color: the layer\'s');
});


/* ---------- names every object has, crafted text, and writes that are not kept ---------- */
test('KML: a name every object already has is no field, no style, no entity and no note', () => {
  const kml = `<kml>
    <constructor/><toString/>
    <Placemark><name>With</name><ExtendedData><Data name="constructor"><value>ACME</value></Data><Data name="__proto__"><value>x</value></Data></ExtendedData><Point><coordinates>1,2</coordinates></Point></Placemark>
    <Placemark><name>Without</name><styleUrl>#constructor</styleUrl><Point><coordinates>3,4</coordinates></Point></Placemark>
  </kml>`;
  const { features, notes } = R.kml(kml);
  assert.deepEqual(plain(notes), [], 'a <constructor/> element is not one of the kinds left out ("1 undefined left out")');
  const [withIt, without] = features;
  assert.equal(withIt.properties.constructor, 'ACME', 'the file\'s own field');
  assert.equal(Object.hasOwn(withIt.properties, '__proto__'), true, 'a field called "__proto__" is the feature\'s own');
  assert.equal(Object.getOwnPropertyDescriptor(withIt.properties, '__proto__').value, 'x', 'a plain field of its own, not its prototype');
  assert.equal(Object.hasOwn(without.properties, 'constructor'), false, 'the other placemark has no such field');
  assert.equal(without.mbStyle, undefined, 'a styleUrl naming no Style in the file is no style');
  // an entity named after one of those is text, as any unknown entity is
  const ent = R.kml('<kml><Placemark><name>&constructor; &amp; &toString;</name><Point><coordinates>1,2</coordinates></Point></Placemark></kml>');
  assert.equal(ent.features[0].properties.name, '&constructor; & &toString;');
});

test('KML coordinates: tuples are split on every kind of space, not the ASCII ones alone', () => {
  const seps = [' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　', '﻿'];
  const text = '1,2' + seps.map((s, i) => s + (i + 3) + ',' + (i + 4)).join('');
  const g = R.kml(`<kml><Placemark><LineString><coordinates>${text}</coordinates></LineString></Placemark></kml>`).features[0].geometry;
  assert.equal(g.coordinates.length, seps.length + 1, 'one point per tuple');
  assert.deepEqual(plain(g.coordinates.slice(0, 3)), [[1, 2], [3, 4], [4, 5]]);
});

test('shapefile rings: the same nesting however they are wound, and thousands of separate outlines stay quick', () => {
  const ccw = r => r.slice().reverse();
  const ringsOf = parts => {
    const g = R.shapefile({ shp: shp([{ type: 'polygon', parts }]) }).features[0].geometry;
    return (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map(p => p.length); // rings in each polygon
  };
  assert.deepEqual(plain(ringsOf([SQUARE, HOLE])), [2], 'outline and hole, wound by the rule');
  assert.deepEqual(plain(ringsOf([SQUARE, ccw(HOLE)])), [2], 'both clockwise');
  assert.deepEqual(plain(ringsOf([ccw(SQUARE), HOLE])), [2], 'both counter-clockwise');
  assert.deepEqual(plain(ringsOf([SQUARE, ISLAND])), [1, 1], 'two outlines, neither inside the other');
  assert.deepEqual(plain(ringsOf([SQUARE])), [1], 'one ring: nothing to nest');

  // 4,000 separate clockwise outlines, 50 points each: no hole in the file, so the nesting runs, and it must not
  // test every ring against every other
  const many = [];
  for (let i = 0; i < 4000; i++) {
    const cx = (i % 100) * 1.5, cy = Math.floor(i / 100) * 2, r = [];
    for (let k = 0; k < 50; k++) { const a = -2 * Math.PI * k / 50; r.push([cx + 0.4 * Math.cos(a), cy + 0.4 * Math.sin(a)]); } // clockwise
    r.push(r[0]);
    many.push(r);
  }
  const t0 = process.hrtime.bigint();
  const [f] = R.shapefile({ shp: shp([{ type: 'polygon', parts: many }]) }).features;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(f.geometry.type, 'MultiPolygon');
  assert.equal(f.geometry.coordinates.length, 4000, 'every outline kept, none taken for a hole');
  assert.ok(f.geometry.coordinates.every(p => p.length === 1), 'and none given a hole');
  assert.ok(ms < 2000, '4,000 rings read in ' + ms.toFixed(0) + ' ms');
  // a record of 100,000 polygons: pushed one by one (spreading them would overflow the argument limit, and the
  // record would be dropped without a word)
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'js/fileimports.js'), 'utf8'), /parts\.push\(\.\.\.polygonOf/);
});

test('crafted text is read in one pass: attribute names with no value, a run of spaces in coordinates, markup that never closes', () => {
  const ms = fn => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
  const under = (what, n, limit) => assert.ok(n < (limit || 200), what + ' took ' + n.toFixed(0) + ' ms');
  // 200 kB of attribute names with no values in one tag (each searched for an '=' to the end of the tag: 0.8 s)
  const names = ('a'.repeat(5000) + ' ').repeat(40);
  const t1 = ms(() => assert.deepEqual(plain(R.parseXml(`<kml><Placemark ${names}><Point><coordinates>1,2</coordinates></Point></Placemark></kml>`).kids[0].kids[0].attrs), {}));
  under('a tag of names with no values', t1);
  // 200 kB of spaces inside one tag, with and without a stray '=' after them (the name's pattern used to eat the run
  // at every position and give it back again: 19 s for 160 kB)
  const run = ' '.repeat(200000);
  const attrs = s => R.parseXml(`<kml><Placemark ${s}><Point><coordinates>1,2</coordinates></Point></Placemark></kml>`).kids[0].kids[0].attrs;
  under('a tag ending in a run of spaces', ms(() => assert.deepEqual(plain(attrs('a="1"' + run)), { a: '1' })));
  under('a run of spaces and a stray =', ms(() => assert.deepEqual(plain(attrs('a="1"' + run + '= b="2"')), { a: '1', b: '2' })));
  // 200 kB of spaces in a coordinate list (each a search for the next comma: 0.5 s)
  const spaces = (' '.repeat(5000) + ' 3,4').repeat(40);
  const t2 = ms(() => assert.equal(R.kml(`<kml><Placemark><LineString><coordinates>1,2${spaces}</coordinates></LineString></Placemark></kml>`).features[0].geometry.coordinates.length, 41));
  under('a coordinate list of spaces', t2);
  // 200 kB of markup whose tags never close (each <br searched to the end of the text: 0.9 s)
  const marky = '<br'.repeat(6000) + '<'.repeat(182000);
  under('formatted text that never closes', ms(() => MB.htmlText(marky)));
  // and a description is read by that one alone (util.js is always loaded with fileimports.js: no second reading of
  // its own here to drift from it)
  assert.match(fs.readFileSync(path.join(ROOT, 'js/fileimports.js'), 'utf8'), /const htmlText = s => \(!s \? '' : MB\.htmlText \? MB\.htmlText\(s\) : String\(s\)\.trim\(\)\);/);
});

test('crafted markup is read in one pass too: stray closing tags are skipped at once', () => {
  const ms = fn => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
  // 999 tags left open and a million closing tags that match none of them: each used to be looked for down the whole
  // stack (0.8 s here, 3.3 s for 40,000 of each in a KML file)
  const stray = '<a>'.repeat(999) + '</b>'.repeat(1000000);
  const t = ms(() => assert.equal(R.parseXml('<kml>' + stray + '</kml>').kids[0].kids[0].name, 'a'));
  assert.ok(t < 200, 'stray closing tags took ' + t.toFixed(0) + ' ms');
  // and the tags still close what they name: the one named, and whatever was left open inside it
  const doc = R.parseXml('<kml><Document><Folder><Placemark/></b></Folder></unopened><Placemark/></Document></kml>');
  const kml = doc.kids[0], folder = kml.kids[0].kids[0];
  assert.deepEqual(plain(folder.kids.map(k => k.name)), ['Placemark'], '</b> and </unopened> closed nothing');
  assert.deepEqual(plain(kml.kids[0].kids.map(k => k.name)), ['Folder', 'Placemark'], 'and the Placemark after </Folder> is the Document\'s');
});

test('a deeply nested file is read, not refused: a description of raw <p> and <br> tags, and thousands of folders', () => {
  const ms = fn => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
  // a description written as markup without CDATA: every tag that never closes nests one deeper (600 of them here).
  // Its text is what the file has between the tags, as before.
  const desc = '<p>line<br>'.repeat(600);
  const kml = `<kml><Placemark><name>N</name><description>${desc}</description><Point><coordinates>1,2</coordinates></Point></Placemark></kml>`;
  const [f] = R.kml(kml).features;
  assert.equal(f.properties.name, 'N');
  assert.equal(f.properties.description, 'line'.repeat(600), 'the description is read, tags and all');
  assert.deepEqual(plain(f.geometry.coordinates), [1, 2], 'and so is the point after it');

  // 5,000 folders inside one another, each with a placemark: every one read, with its folder path
  const n = 5000;
  const nest = (i) => `<Folder><name>F${i}</name><Placemark><name>P${i}</name><Point><coordinates>${i % 100},1</coordinates></Point></Placemark>`;
  let body = '';
  for (let i = 0; i < n; i++) body += nest(i);
  const t = ms(() => {
    const res = R.kml('<kml><Document>' + body + '</Document></kml>'); // (the folders never close: the Document's end closes them)
    assert.equal(res.features.length, n, 'a placemark from every folder');
    assert.equal(res.features[0].properties.name, 'P0');
    assert.equal(res.features[n - 1].properties.folder.split(' / ').length, n, 'the deepest one knows every folder above it');
  });
  assert.ok(t < 5000, '5,000 deep read in ' + t.toFixed(0) + ' ms');
  // a MultiGeometry nested as deep still gives its parts
  const multi = '<MultiGeometry>'.repeat(3000) + '<Point><coordinates>3,4</coordinates></Point>';
  const [m] = R.kml('<kml><Placemark>' + multi + '</Placemark></kml>').features;
  assert.deepEqual(plain(m.geometry.coordinates), [3, 4]);
  // only a crafted file of nothing but open tags is refused, at once and by name (100,000 deep: no real file is near)
  const crafted = ms(() => assert.throws(() => R.kml('<kml>' + '<Folder>'.repeat(200000) + '</kml>'), /nested too deeply/));
  assert.ok(crafted < 500, 'refused in ' + crafted.toFixed(0) + ' ms');
});

// A stand-in IndexedDB: a request answers, and then the transaction either commits or, with abort, is rolled back
// (the quota reached, the disk full). What answered but never committed was not kept. A value is copied in, as a
// real store copies it: what is written later is not what was written before. out.abort turns writes to failures
// from then on.
function fakeIdb(opts) {
  opts = opts || {};
  const data = new Map(), soon = fn => setTimeout(fn, 0);
  const out = { stores: data, abort: !!opts.abort };
  const db = {
    objectStoreNames: { contains: n => data.has(n) },
    createObjectStore(n) { data.set(n, new Map()); },
    transaction(name, mode) {
      const m = data.get(name) || data.set(name, new Map()).get(name), write = mode === 'readwrite', queued = [];
      const req = run => { const r = {}; queued.push([r, run]); return r; };
      const store = {
        put: (v, k) => req(() => { if (!(write && out.abort)) m.set(k, structuredClone(v)); }),
        get: k => req(() => m.get(k)),
        getAll: () => req(() => Array.from(m.values())),
        getAllKeys: () => req(() => Array.from(m.keys())),
        delete: k => req(() => { m.delete(k); })
      };
      const tx = { error: null, objectStore: () => store };
      soon(() => {
        queued.forEach(([r, run]) => { r.result = run(); if (r.onsuccess) r.onsuccess(); }); // the request answers first
        if (write && out.abort) { tx.error = new Error('the quota is full'); if (tx.onabort) tx.onabort(); }
        else if (tx.oncomplete) tx.oncomplete();
      });
      return tx;
    }
  };
  out.open = () => { const r = { result: db }; soon(() => { if (r.onupgradeneeded) r.onupgradeneeded(); if (r.onsuccess) r.onsuccess(); }); return r; };
  return out;
}

test('a layer counts as imported only once its write went through: one that answers and then fails to commit is not "on the map"', async () => {
  const gj = JSON.stringify({ type: 'Feature', properties: { name: 'A' }, geometry: { type: 'Point', coordinates: [1, 2] } });
  const quiet = idb => { const m = load({ indexedDB: idb }); m.toast = () => {}; return m.imports; }; // (toast: util.js's writes to the page)
  const kept = fakeIdb(), ok = quiet(kept);
  const ids = await ok.openFiles([file('ok.geojson', gj)]);
  assert.equal(ids.length, 1);
  assert.deepEqual(plain(ok.notes.map(n => n.text)), ['ok: 1 feature on the map.']);
  assert.equal(kept.stores.get('meta').size, 1, 'kept on the device');
  assert.equal(kept.stores.get('geo').size, 1);

  const lost = fakeIdb({ abort: true }), bad = quiet(lost);
  assert.deepEqual(plain(await bad.openFiles([file('ok.geojson', gj)])), [], 'no layer');
  const said = bad.notes.map(n => n.text);
  assert.ok(said.some(t => /^ok: could not be kept \(/.test(t)), said.join(' | '));
  assert.ok(!said.some(t => /on the map/.test(t)), 'nothing says it is on the map: ' + said.join(' | '));
  assert.equal(lost.stores.get('meta').size, 0, 'and nothing was kept');
});

// One tab's file imports, with a stand-in page (its pagehide and visibilitychange listeners) and a store of its own.
function tab(idb) {
  const MB = {}, listeners = {}, events = [];
  const on = (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); };
  const win = { MB, addEventListener: on }, doc = { visibilityState: 'visible', addEventListener: on };
  const ctx = { window: win, document: doc, indexedDB: idb, TextDecoder, Blob, DecompressionStream, console: { warn() {}, log() {}, error() {} }, Date, Math, setTimeout, clearTimeout };
  vm.createContext(ctx);
  for (const f of ['js/util.js', 'js/importstyle.js', 'js/attrtable.js', 'js/fileimports.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  MB.toast = () => {}; MB.emit = e => events.push(e); // (util.js's own write to the page, and the app's events)
  MB.imports.saves.hook();
  return { MB, imp: MB.imports, events, doc, fire: t => (listeners[t] || []).forEach(fn => fn()) };
}
const tick = ms => new Promise(r => setTimeout(r, ms || 0));

test('an edit waiting to be kept is written when the page is hidden or closed, not lost with the tab', async () => {
  const gj = JSON.stringify({ type: 'Feature', properties: { name: 'A' }, geometry: { type: 'Point', coordinates: [1, 2] } });
  const store = fakeIdb(), t = tab(store);
  const [id] = await t.imp.openFiles([file('sites.geojson', gj)]);
  const rec = t.imp.record(id);
  const nameIn = () => store.stores.get('geo').get(id).features[0].properties.name;
  assert.equal(nameIn(), 'A');

  await t.imp.setValue(rec, rec.fc.features[0], 'name', 'B');
  assert.equal(nameIn(), 'A', 'kept 500 ms after the last change: not written yet');
  t.fire('pagehide'); // the tab (or the app) closing
  await tick(20);
  assert.equal(nameIn(), 'B', 'written now');
  assert.equal(rec.saveTimer, null, 'and nothing is left waiting');

  // the app sent to the background: the same (a phone may never come back to it)
  await t.imp.setValue(rec, rec.fc.features[0], 'name', 'C');
  t.doc.visibilityState = 'hidden';
  t.fire('visibilitychange');
  await tick(20);
  assert.equal(nameIn(), 'C');

  // a write that fails leaves the features dirty, to be written again, and says so in the panel
  await t.imp.setValue(rec, rec.fc.features[0], 'name', 'D');
  store.abort = true;
  t.fire('pagehide');
  await tick(20);
  assert.equal(rec.fcDirty, true, 'still owed');
  const failed = () => t.imp.notes.filter(n => /a change could not be kept/.test(n.text)).length;
  assert.equal(failed(), 1, t.imp.notes.map(n => n.text).join(' | '));
  assert.ok(t.events.includes('data'), 'the panel is drawn anew, so the note shows');
  // hidden again, and again: it is tried again each time, and said once
  t.fire('pagehide');
  await tick(20);
  t.fire('pagehide');
  await tick(20);
  assert.equal(failed(), 1, 'said once, however many times it was tried: ' + t.imp.notes.map(n => n.text).join(' | '));
  store.abort = false;
  t.fire('pagehide');
  await tick(20);
  assert.equal(nameIn(), 'D', 'and written when the store takes it again');
  assert.equal(rec.fcDirty, false);
});

test('a panel redraw waits for a press to end: its release, a context menu, the window losing focus, or 2 s', async () => {
  // a fresh copy, its own press state, with a stand-in page (util.js keeps it: Properties uses it for the project's
  // own fields, the imported layers' panel for theirs)
  const MB2 = { escapeHtml: s => String(s) };
  const doc = new EventTarget(), win = new EventTarget();
  win.MB = MB2;
  const ctx = { window: win, document: doc, TextDecoder, Blob, DecompressionStream, console, Date, Math, setTimeout, clearTimeout };
  vm.createContext(ctx);
  for (const f of ['js/util.js', 'js/fileimports.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  const P = { whenReleased: MB2.whenReleased, state: MB2.press.state };
  // listened to as soon as util.js loads: the first redraw asked for in a session comes from a change or focusout
  // event, which fires after the pointerdown that caused it - the press must already be known then
  assert.equal(P.state.hooked, true, 'hooked at load, not on the first whenReleased');
  P.state.giveUp = 60; // (2 s in the app)
  const fire = (t, init) => { const e = new Event(t); Object.assign(e, init || {}); (t === 'blur' ? win : doc).dispatchEvent(e); };
  const tick = ms => new Promise(r => setTimeout(r, ms || 0));
  const ran = [];

  P.whenReleased(() => ran.push('free')); // nothing pressed: on the next turn
  assert.deepEqual(ran, []);
  await tick();
  assert.deepEqual(ran, ['free']);

  fire('pointerdown', { button: 0 });
  P.whenReleased(() => ran.push('after up'));
  await tick(20);
  assert.deepEqual(ran, ['free'], 'held: waiting');
  fire('pointerup');
  assert.deepEqual(ran, ['free'], 'not in the release itself (its click comes first)');
  await tick();
  assert.deepEqual(ran, ['free', 'after up']);

  fire('pointerdown', { button: 0 }); // a second finger lifting does not end the first one's press
  P.whenReleased(() => ran.push('two fingers'));
  fire('pointerup', { isPrimary: false });
  await tick(20);
  assert.notEqual(ran.at(-1), 'two fingers');
  fire('pointerup', { isPrimary: true });
  await tick();
  assert.equal(ran.at(-1), 'two fingers');

  fire('pointerdown', { button: 2 }); // a right-click does not hold anything back
  P.whenReleased(() => ran.push('right'));
  await tick();
  assert.equal(ran.at(-1), 'right');

  for (const [end, label] of [['contextmenu', 'menu'], ['blur', 'blur']]) {
    fire('pointerdown', { button: 0 });
    P.whenReleased(() => ran.push(label));
    fire(end);
    await tick();
    assert.equal(ran.at(-1), label, end + ' ends a press');
  }

  fire('pointerdown', { button: 0 }); // a release that never comes
  P.whenReleased(() => ran.push('given up'));
  await tick(150);
  assert.equal(ran.at(-1), 'given up');
  assert.equal(P.state.down, false);
});
