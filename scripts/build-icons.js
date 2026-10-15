#!/usr/bin/env node
/* Builds data/icons.js, the icons of the icon picker (js/icons.js), from Lucide (ISC licence, lucide.dev). The icon
 * outlines and their search tags are read from the lucide-static package on jsDelivr into memory; only the trimmed
 * result is written. It is a script (not JSON) because the desktop app opens the page from disk, where fetch()
 * cannot read local files.
 *
 *   node scripts/build-icons.js [version]
 *
 * Output: MB.iconData = { source, version, icons: [[name, tags, svg elements], ...] } (24 x 24, drawn with stroke).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const VERSION = process.argv[2] || '0.544.0';
const BASE = `https://cdn.jsdelivr.net/npm/lucide-static@${VERSION}/`;
const OUT = path.join(__dirname, '..', 'data', 'icons.js');

async function get(name, json) {
  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(name + ': HTTP ' + res.status);
  return json ? res.json() : res.text();
}
const attr = v => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

(async () => {
  const [nodes, tags, license] = await Promise.all([get('icon-nodes.json', true), get('tags.json', true), get('LICENSE')]);
  const icons = Object.keys(nodes).sort().map(name => {
    const svg = nodes[name].map(([tag, a]) => `<${tag} ${Object.keys(a).map(k => `${k}="${attr(a[k])}"`).join(' ')}/>`).join('');
    return [name, (tags[name] || []).join(' '), svg];
  });
  const out = { source: 'Lucide (lucide.dev), ISC licence', version: VERSION, icons };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // the licence asks for its notice in every copy
  fs.writeFileSync(OUT, '/* GenGIS icons, built by scripts/build-icons.js from Lucide ' + VERSION + '.\n\n' + license.trim().replace(/\*\//g, '* /') +
    '\n*/\n(window.MB = window.MB || {}).iconData = ' + JSON.stringify(out).replace(/\],\[/g, '],\n[') + ';\n');
  console.log(`${path.relative(process.cwd(), OUT)}: ${icons.length} icons, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
})().catch(e => { console.error(e); process.exit(1); });
