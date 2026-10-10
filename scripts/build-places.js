#!/usr/bin/env node
/* Builds data/places.js, the place names drawn by "Map overlays → Place names" (js/places.js), from Natural Earth
 * (public domain, https://www.naturalearthdata.com). The source files are read straight from the Natural Earth
 * GitHub repository into memory; only the trimmed result is written. It is a script (not JSON) because the desktop
 * app opens the page from disk, where fetch() cannot read local files.
 *
 *   node scripts/build-places.js
 *
 * Output: MB.placeData = { countries: [[name, lon, lat, minZoom, maxZoom]], cities: [[name, lon, lat, minZoom, capital]],
 *           marine: [[name, lon, lat, minZoom, kind]] } with kind 0 ocean, 1 sea, 2 gulf / bay, 3 strait / channel / sound.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const OUT = path.join(__dirname, '..', 'data', 'places.js');
const CITY_MAX_ZOOM = 7;   // cities Natural Earth labels from this zoom or earlier: the larger towns and up
const MARINE = { ocean: 0, sea: 1, gulf: 2, bay: 2, strait: 3, channel: 3, sound: 3 };

const r3 = v => Math.round(v * 1000) / 1000;
const r1 = v => Math.round(v * 10) / 10;

async function load(name) {
  const res = await fetch(BASE + name + '.geojson');
  if (!res.ok) throw new Error(name + ': HTTP ' + res.status);
  return (await res.json()).features;
}

// "SOUTHERN OCEAN" -> "Southern Ocean"; names already in mixed case are kept.
const tidy = s => (s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s\-'(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\b(Of|The|And|De|Du|Del|La|Le)\b/g, w => w.toLowerCase()) : s).trim();

/* ----- a label point inside a polygon: the sampled point farthest from its edges ----- */
function ringsOf(geom) {
  // the polygon with the largest outer ring (by bounding box area) of a (multi)polygon
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  let best = null, bestArea = -1;
  polys.forEach(p => {
    const b = bbox(p[0]), a = (b[2] - b[0]) * (b[3] - b[1]);
    if (a > bestArea) { bestArea = a; best = p; }
  });
  return best;
}
function bbox(ring) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  ring.forEach(([x, y]) => { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); });
  return b;
}
function inside(rings, x, y) {
  let ins = false;
  rings.forEach(ring => {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins;
    }
  });
  return ins;
}
function edgeDist(rings, x, y) {
  const k = Math.cos(y * Math.PI / 180); // degrees of longitude are shorter away from the equator
  let d = Infinity;
  rings.forEach(ring => {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = ring[j][0] * k, ay = ring[j][1], bx = ring[i][0] * k, by = ring[i][1], px = x * k;
      const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (y - ay) * dy) / l)) : 0;
      const ex = ax + t * dx - px, ey = ay + t * dy - y;
      d = Math.min(d, ex * ex + ey * ey);
    }
  });
  return Math.sqrt(d);
}
function labelPoint(geom) {
  const rings = ringsOf(geom);
  if (!rings) return null;
  let [x0, y0, x1, y1] = bbox(rings[0]);
  let best = null;
  for (let pass = 0; pass < 4; pass++) {
    const n = 24, sx = (x1 - x0) / n, sy = (y1 - y0) / n;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
      const x = x0 + i * sx, y = y0 + j * sy;
      if (!inside(rings, x, y)) continue;
      const d = edgeDist(rings, x, y);
      if (!best || d > best.d) best = { x, y, d };
    }
    if (!best) return null;
    x0 = best.x - 2 * sx; x1 = best.x + 2 * sx; y0 = best.y - 2 * sy; y1 = best.y + 2 * sy; // refine around it
  }
  return [r3(best.x), r3(best.y)];
}

(async () => {
  const [countries, cities, marine] = await Promise.all([
    load('ne_50m_admin_0_countries'), load('ne_10m_populated_places_simple'), load('ne_10m_geography_marine_polys')
  ]);
  const out = { source: 'Natural Earth (public domain), naturalearthdata.com', countries: [], cities: [], marine: [] };

  countries.forEach(f => {
    const p = f.properties;
    if (!p.NAME || p.LABEL_X == null || p.LABEL_Y == null) return;
    out.countries.push([p.NAME, r3(p.LABEL_X), r3(p.LABEL_Y), r1(p.MIN_LABEL || 3), r1(p.MAX_LABEL || 10)]);
  });
  out.countries.sort((a, b) => a[3] - b[3]);

  cities.forEach(f => {
    const p = f.properties, [lon, lat] = f.geometry.coordinates;
    if (!p.name || p.min_zoom == null || p.min_zoom > CITY_MAX_ZOOM) return;
    out.cities.push([p.name, r3(lon), r3(lat), r1(p.min_zoom), /Admin-0 capital/.test(p.featurecla || '') ? 1 : 0, p.pop_max || 0]);
  });
  // most important first: the order labels are placed in when they would overlap
  out.cities.sort((a, b) => a[3] - b[3] || b[4] - a[4] || b[5] - a[5]);
  out.cities.forEach(c => c.pop());

  marine.forEach(f => {
    const p = f.properties, kind = MARINE[p.featurecla];
    if (kind === undefined || !p.name) return;
    const pt = labelPoint(f.geometry);
    if (pt) out.marine.push([tidy(p.name), pt[0], pt[1], r1(p.min_label || 4), kind]);
  });
  out.marine.sort((a, b) => a[4] - b[4] || a[3] - b[3]);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, '/* GenGIS place names, built by scripts/build-places.js from Natural Earth (public domain). */\n' +
    '(window.MB = window.MB || {}).placeData = ' + JSON.stringify(out).replace(/\],\[/g, '],\n[') + ';\n');
  console.log(`${path.relative(process.cwd(), OUT)}: ${out.countries.length} countries, ${out.cities.length} cities, ${out.marine.length} marine names, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
})().catch(e => { console.error(e); process.exit(1); });
