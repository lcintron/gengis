/* GenGIS - icons (the toolbar's Icon button, or I)
 * - a picker over the Lucide icons (data/icons.js, built by scripts/build-icons.js; ISC licence): search by name and
 *   tags, a color, and a dark outline that keeps a light icon readable on imagery
 * - the icon chosen goes into the image library as an SVG (the same icon in the same color is used again) and the
 *   map's next click places it, as an SVG from the Images panel is placed
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

  MB.icons = {
    dlg: null, loading: null, color: '#ffffff', halo: true, query: '',

    init() {
      const dlg = this.dlg = document.getElementById('iconDialog');
      const btn = document.getElementById('iconBtn');
      if (!dlg || !btn) return;
      btn.addEventListener('click', () => this.open());
      MB.ui.wireDialog(dlg);
      const search = dlg.querySelector('#iconSearch');
      search.addEventListener('input', MB.debounce(() => { this.query = search.value; this.render(); }, 120));
      search.addEventListener('keydown', e => { if (e.key === 'ArrowDown') { const first = dlg.querySelector('#iconGrid [data-icon]'); if (first) { e.preventDefault(); first.focus(); } } });
      dlg.querySelector('#iconSwatches').addEventListener('click', e => { const b = e.target.closest('[data-color]'); if (b) this.setColor(b.dataset.color); });
      dlg.querySelector('#iconColor').addEventListener('input', e => this.setColor(e.target.value));
      dlg.querySelector('#iconHalo').addEventListener('change', e => { this.halo = e.target.checked; this.render(); });
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

    open() {
      MB.ui.openDialog(this.dlg);
      // the search takes the keyboard, except on a touch screen, where its keyboard would cover half the icons
      if (!matchMedia('(pointer: coarse)').matches) this.dlg.querySelector('#iconSearch').focus();
      this.renderSwatches();
      const grid = this.dlg.querySelector('#iconGrid');
      if (!MB.iconData) grid.innerHTML = '<p class="note">Loading icons…</p>';
      this.load().then(() => this.render()).catch(e => { grid.innerHTML = `<p class="note">${esc(e.message)}</p>`; });
    },

    setColor(c) {
      this.color = /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : this.color;
      this.dlg.querySelector('#iconColor').value = this.color;
      this.renderSwatches();
      this.dlg.querySelector('#iconGrid').style.color = this.color; // the icons draw in currentColor: no redraw
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
      grid.style.color = this.color;
      grid.innerHTML = list.length ? list.map(([n, , svg], i) => `<button type="button" role="option" data-icon="${esc(n)}" title="${esc(n)}" aria-label="${esc(n)}" tabindex="${i ? -1 : 0}">${iconSvg(svg, 'currentColor', this.halo)}</button>`).join('')
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

    // Into the library (once per icon and look), then placed with the map's next click.
    choose(name) {
      const icon = MB.iconData.icons.find(i => i[0] === name);
      if (!icon) return;
      const key = `lucide:${name}:${this.color}:${this.halo ? 1 : 0}`;
      let entry = Object.values(MB.state.svgLibrary).find(l => l.iconKey === key);
      if (!entry) {
        const id = MB.uid();
        entry = MB.state.svgLibrary[id] = { id, name, dataUrl: MB.svgDataUrl(iconSvg(icon[2], this.color, this.halo)), aspect: 1, width: 26, height: 26, iconKey: key };
        MB.emit('svglibrary');
        MB.commit('add icon');
      }
      MB.ui.closeDialog(this.dlg);
      MB.svgPlace.svgId = entry.id;
      if (MB.tools.current !== 'svg') MB.tools.set('svg'); else MB.emit('tool', 'svg');
    }
  };
})(window.MB);
