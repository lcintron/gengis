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

function load() {
  const MB = { escapeHtml: s => String(s) };
  const ctx = { window: { MB }, TextDecoder, Blob, DecompressionStream, console, Date, Math };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/fileimports.js'), 'utf8'), ctx, { filename: 'fileimports.js' });
  return MB.imports;
}
const IMP = load(), R = IMP.read;
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
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, k) => c.writeDoubleLE(v, 4 + 8 * k));
      c.writeInt32LE(r.parts.length, 36); c.writeInt32LE(pts.length, 40);
      let at = 0;
      r.parts.forEach((p, k) => { c.writeInt32LE(at, 44 + 4 * k); at += p.length; });
      pts.forEach((p, k) => { c.writeDoubleLE(p[0], 44 + 4 * r.parts.length + 16 * k); c.writeDoubleLE(p[1], 52 + 4 * r.parts.length + 16 * k); });
      all.push(...pts);
    }
    const rh = Buffer.alloc(8); rh.writeInt32BE(i + 1, 0); rh.writeInt32BE(c.length / 2, 4);
    bufs.push(rh, c);
  });
  const body = Buffer.concat(bufs), h = Buffer.alloc(100);
  h.writeInt32BE(9994, 0); h.writeInt32BE((100 + body.length) / 2, 24); h.writeInt32LE(1000, 28); h.writeInt32LE(5, 32);
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, k) => h.writeDoubleLE(v, 36 + 8 * k));
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
  assert.equal(tower.properties.description, 'Height: 30 m\nBuilt 1999', 'the description as text: no markup, no script');
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
