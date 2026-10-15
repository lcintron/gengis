/* GenGIS - fill patterns for shapes: instead of a flat fill, a shape can be hatched, cross-hatched, dotted or
 * gridded. Each is an SVG <pattern> drawn in the fill colour; the shape's fill opacity still dims the whole thing.
 * The patterns live in one <defs> inside the map container, so they are captured by the image/PDF export too.
 * A pattern tile is 8x8 user units; the strokes keep their width whatever the shape's size (userSpaceOnUse).
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  // id -> label, in the order the picker shows them. 'solid' is the plain fill (no pattern).
  MB.fillPatterns = {
    solid: 'Solid', hachure: 'Diagonal', cross: 'Cross-hatch', horizontal: 'Horizontal',
    vertical: 'Vertical', grid: 'Grid', dots: 'Dots'
  };

  // The tile's innards for each pattern, drawn in `c` (the fill colour). Lines are 1.3 wide; dots are filled.
  function shapes(pattern, c) {
    const line = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="1.3"/>`;
    switch (pattern) {
      case 'horizontal': return { body: line(0, 4, 8, 4) };
      case 'vertical': return { body: line(4, 0, 4, 8) };
      case 'grid': return { body: line(0, 4, 8, 4) + line(4, 0, 4, 8) };
      case 'dots': return { body: `<circle cx="4" cy="4" r="1.3" fill="${c}"/>` };
      case 'cross': return { body: line(0, 4, 8, 4) + line(4, 0, 4, 8), rotate: 45 }; // a diagonal cross-hatch
      case 'hachure': default: return { body: line(4, 0, 4, 8), rotate: 45 }; // diagonal lines
    }
  }

  let defs = null;
  const made = {}; // id -> true, so each pattern+colour is built once
  function defsEl() {
    if (defs && defs.isConnected) return defs;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'mb-patterns'); svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svg.appendChild(defs);
    (MB.map ? MB.map.getContainer() : document.body).appendChild(svg);
    return defs;
  }

  // Make sure the <pattern> for this pattern+colour exists, and return its id (for fill="url(#id)").
  MB.fillPattern = {
    ensure(pattern, color) {
      const col = String(color || '#000000').toLowerCase();
      const id = 'mb-pat-' + pattern + '-' + col.replace(/[^0-9a-z]/g, '');
      if (made[id]) return id;
      const d = defsEl(), { body, rotate } = shapes(pattern, col);
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
      p.setAttribute('id', id);
      p.setAttribute('patternUnits', 'userSpaceOnUse');
      p.setAttribute('width', '8'); p.setAttribute('height', '8');
      if (rotate) p.setAttribute('patternTransform', 'rotate(' + rotate + ')');
      p.innerHTML = body;
      d.appendChild(p);
      made[id] = true;
      return id;
    },
    // Apply (or clear) a pattern on a path's fill. Returns true when a pattern was set. Leaflet rebuilds the <path>
    // (and resets its fill to the flat colour) every time the layer is added to the map - on a layer or object being
    // shown, a zoom rule revealing it, a move to another layer - so the pattern is re-applied on each 'add' too.
    apply(layer, style) {
      if (!layer) return false;
      if (!layer._mbPatHook) {
        layer._mbPatHook = true;
        layer.on('add', () => { const m = layer.mb; MB.fillPattern.apply(layer, m && m.style && m.style.fill ? m.style : null); });
      }
      if (!layer._path) return false;
      const on = style && style.fill && style.fillPattern && style.fillPattern !== 'solid';
      if (on) layer._path.setAttribute('fill', 'url(#' + this.ensure(style.fillPattern, style.fillColor) + ')');
      return !!on;
    }
  };
})(window.MB);
