/* GenGIS - icons (the toolbar's Icon button, or I)
 * - a picker over the Lucide icons (data/icons.js, built by scripts/build-icons.js; ISC license): search by name and
 *   tags, a color, and an outline that keeps the icon readable on imagery
 * - the icon chosen arms the Icon tool (js/tools.js) and the map's next click places it as a marker, which takes the
 *   next color of the palette like every new object (its color, size, outline and angle: Properties)
 * - pick(): the same picker choosing an icon for something else (an imported layer's symbols, a marker in
 *   Properties): { name, color, halo, colorChosen }, or null when closed without one; svg(name, color, halo) draws one
 * - need(): the set loaded because something has to draw an icon (a project opened with icon markers in it)
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = MB.escapeHtml;
  const SHOWN = 240; // icons drawn at once; a search narrows them down
  const SWATCHES = ['#ffffff', '#0b1118', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa'];
  const HALO = '#0b1118';

  // An icon as a standalone SVG: its outline in the color, over a wider dark copy when outlined.
  function iconSvg(inner, color, halo) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 26 26" width="26" height="26" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
      (halo ? `<g stroke="${HALO}" stroke-opacity=".6" stroke-width="4.5">${inner}</g>` : '') + `<g stroke="${color}" stroke-width="2">${inner}</g></svg>`;
  }

  // An object's own color as the picker can show it: '#rrggbb', a 3-digit hex expanded, an 8-digit one without its
  // alpha. A named or rgb() color (a file's own, or GeoJSON's marker-color) is none of those: '' — the picker keeps
  // the color it had, and the object keeps its own unless a color is picked here (MB.icons.pick, js/ui.js).
  function seedColor(c) {
    const s = String(c == null ? '' : c).trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s.slice(1).replace(/./g, x => x + x);
    if (/^#[0-9a-f]{8}$/.test(s)) return s.slice(0, 7);
    return '';
  }
  MB.iconSeedColor = seedColor;

  MB.icons = {
    dlg: null, loading: null, color: '#ffffff', halo: true, pickHalo: true, colorChosen: false, query: '',

    init() {
      const dlg = this.dlg = document.getElementById('iconDialog');
      const btn = document.getElementById('iconBtn');
      if (!dlg || !btn) return;
      btn.addEventListener('click', () => { this.settle(null); this.open(); });
      dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-act="close"]')) setTimeout(() => { if (dlg.classList.contains('hidden')) this.settle(null); }); });
      dlg.addEventListener('keydown', e => { if (e.key === 'Escape') setTimeout(() => { if (dlg.classList.contains('hidden')) this.settle(null); }); });
      MB.ui.wireDialog(dlg);
      const search = dlg.querySelector('#iconSearch');
      search.addEventListener('input', MB.debounce(() => { this.query = search.value; this.render(); }, 120));
      search.addEventListener('keydown', e => { if (e.key === 'ArrowDown') { const first = dlg.querySelector('#iconGrid [data-icon]'); if (first) { e.preventDefault(); first.focus(); } } });
      dlg.querySelector('#iconSwatches').addEventListener('click', e => { const b = e.target.closest('[data-color]'); if (b) this.setColor(b.dataset.color, true); });
      dlg.querySelector('#iconColor').addEventListener('input', e => this.setColor(e.target.value, true));
      dlg.querySelector('#iconHalo').addEventListener('change', e => this.setHalo(e.target.checked));
      const grid = dlg.querySelector('#iconGrid');
      grid.addEventListener('click', e => { const b = e.target.closest('[data-icon]'); if (b) this.choose(b.dataset.icon); });
      grid.addEventListener('keydown', e => this.gridKeys(e));
    },

    // The icons are read the first time the picker opens (a few hundred KB).
    load() {
      if (MB.iconData) return Promise.resolve(MB.iconData);
      if (!this.loading) this.loading = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'data/icons.js';
        s.onload = () => (MB.iconData ? res(MB.iconData) : rej(new Error('no icons')));
        s.onerror = () => { this.loading = null; rej(new Error('The icons could not be loaded')); };
        document.head.appendChild(s);
      });
      return this.loading;
    },

    // The set, loaded because something has to draw an icon now (a saved project's icon markers, opened long before
    // the picker ever is): the markers are drawn again once it is there, and a failed load is tried again by the
    // next draw. This runs before init() too (MB.loadAutosave, app.js), so it touches no dialog.
    need() {
      if (MB.iconData || this.needing) return;
      this.needing = true;
      this.load().then(() => { if (MB.refreshIconMarkers) MB.refreshIconMarkers(); }).catch(() => { this.needing = false; });
    },

    open() {
      MB.ui.openDialog(this.dlg);
      // the search takes the keyboard, except on a touch screen, where its keyboard would cover half the icons
      if (!matchMedia('(pointer: coarse)').matches) this.dlg.querySelector('#iconSearch').focus();
      this.dlg.querySelector('#iconHalo').checked = this.haloNow();
      // Placing a marker, the color here would only mislead: the marker takes the next color of the palette, as
      // every new object does, so the icons preview in that color and the color control is out of the way. Picking
      // an icon for something else, its own color is chosen here.
      this.dlg.classList.toggle('icon-placing', !this.picking);
      this.renderSwatches();
      const grid = this.dlg.querySelector('#iconGrid');
      if (!MB.iconData) grid.innerHTML = '<p class="note">Loading icons…</p>';
      grid.style.color = this.tint();
      this.load().then(() => this.render()).catch(e => { grid.innerHTML = `<p class="note">${esc(e.message)}</p>`; });
    },

    // The color the grid previews the icons in: the one chosen while picking for an object; while placing, the color
    // the new marker will really take.
    tint() {
      if (this.picking || !MB.newShapeStyle) return this.color;
      return MB.markerColor(MB.newShapeStyle());
    },
    // A color for the picker; `byUser` when it was picked here (a swatch or the color box), which is what lets an
    // object take it (an object's own color is only seeded: see seedColor).
    setColor(c, byUser) {
      const ok = /^#[0-9a-f]{6}$/i.test(c);
      if (ok) this.color = String(c).toLowerCase();
      if (ok && byUser) this.colorChosen = true;
      this.dlg.querySelector('#iconColor').value = this.color;
      this.renderSwatches();
      this.dlg.querySelector('#iconGrid').style.color = this.tint(); // the icons draw in currentColor: no redraw
    },
    // The outline: while picking for an object, the object's own (so the placing default is left alone); otherwise
    // the default the next placed marker takes, kept from one placement to the next.
    haloNow() { return this.picking ? this.pickHalo !== false : this.halo !== false; },
    setHalo(v) {
      if (this.picking) this.pickHalo = !!v; else this.halo = !!v;
      this.render();
    },
    renderSwatches() {
      this.dlg.querySelector('#iconSwatches').innerHTML = SWATCHES.map(c => `<button type="button" data-color="${c}" class="${c === this.color ? 'active' : ''}" style="--c:${c}" title="${c}" aria-label="Color ${c}" aria-pressed="${c === this.color}"></button>`).join('');
    },

    // The icons matching every word of the search (in their names or tags), most fitting first.
    matches() {
      const words = this.query.toLowerCase().split(/\s+/).filter(Boolean), list = MB.iconData.icons;
      if (!words.length) return list;
      return list.filter(([n, t]) => words.every(w => n.includes(w) || t.includes(w)))
        .map(i => [i, words.every(w => i[0].includes(w)) ? (i[0].startsWith(words[0]) ? 0 : 1) : 2])
        .sort((a, b) => a[1] - b[1]).map(x => x[0]);
    },

    render() {
      if (!MB.iconData || this.dlg.classList.contains('hidden')) return;
      const grid = this.dlg.querySelector('#iconGrid'), all = this.matches(), list = all.slice(0, SHOWN);
      grid.style.color = this.tint();
      grid.innerHTML = list.length ? list.map(([n, , svg], i) => `<button type="button" role="option" data-icon="${esc(n)}" title="${esc(n)}" aria-label="${esc(n)}" tabindex="${i ? -1 : 0}">${iconSvg(svg, 'currentColor', this.haloNow())}</button>`).join('')
        : '<p class="note">No icon matches. Try another word.</p>';
      this.dlg.querySelector('#iconCount').textContent = all.length > list.length
        ? `${list.length} of ${all.length} icons shown: type to narrow them down.` : `${all.length} icon${all.length === 1 ? '' : 's'}.`;
    },

    // Arrow keys move through the grid (one tab stop: the icon last moved to).
    gridKeys(e) {
      const items = Array.from(this.dlg.querySelectorAll('#iconGrid [data-icon]')), i = items.indexOf(document.activeElement);
      if (i < 0) return;
      const cols = Math.max(1, items.filter(b => b.offsetTop === items[0].offsetTop).length);
      const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, Home: -i, End: items.length - 1 - i }[e.key];
      if (d === undefined) return;
      e.preventDefault();
      if (e.key === 'ArrowUp' && i < cols) { this.dlg.querySelector('#iconSearch').focus(); return; }
      const next = items[Math.max(0, Math.min(items.length - 1, i + d))];
      items[i].tabIndex = -1; next.tabIndex = 0; next.focus();
    },

    // The Icon tool, armed with it, so the map's next click places it as a marker (nothing is added until then); or,
    // picking for something else, handed to it.
    choose(name) {
      const color = this.color, halo = this.haloNow(), colorChosen = this.colorChosen;
      if (this.picking) { MB.ui.closeDialog(this.dlg); this.settle({ name, color, halo, colorChosen }); return; }
      MB.ui.closeDialog(this.dlg);
      MB.iconPlace.arm({ name, halo });
      if (MB.tools.current !== 'icon') MB.tools.set('icon'); else MB.emit('tool', 'icon'); // (setting the tool it is on would toggle back to Select)
    },

    // An icon as SVG markup ('' when unknown, or before the icons are loaded: load() first).
    svg(name, color, halo) {
      const icon = MB.iconData && MB.iconData.icons.find(i => i[0] === name);
      return icon ? iconSvg(icon[2], color || '#ffffff', halo !== false) : '';
    },
    // The picker, choosing an icon: a promise of { name, color, halo, colorChosen }, or null when closed without
    // one. The object's own color and outline seed it, without touching what a placed marker takes; colorChosen
    // says whether the color that comes back was picked here (so it can be put on the object) or is only the seed.
    // It shows above the dialog that asked.
    pick(opts) {
      this.settle(null);
      const p = new Promise(res => { this.picking = res; });
      this.pickHalo = opts && 'halo' in opts ? opts.halo !== false : this.halo;
      this.colorChosen = false;
      this.dlg.style.zIndex = 4100;
      this.dlg.querySelector('#iconTitle').textContent = 'Choose an icon';
      this.open();
      this.setColor(seedColor(opts && opts.color) || this.color); // (a color the picker cannot show: it keeps the one it had)
      return p;
    },
    settle(v) {
      const res = this.picking;
      this.picking = null;
      if (this.dlg) { this.dlg.style.zIndex = ''; this.dlg.querySelector('#iconTitle').textContent = 'Add an icon'; }
      if (res) res(v);
    }
  };
})(window.MB);
