/* GenGIS - app settings: map providers (XYZ / WMS, with API keys) and search services */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const KEY = 'gengis.settings', OLD_KEY = 'map-builder.settings.v1';
  const esc = MB.escapeHtml;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  MB.settings = { providers: [], search: {}, keys: {} };

  MB.loadSettings = function () {
    try {
      const s = JSON.parse(MB.storedItem(KEY, OLD_KEY) || 'null');
      if (s && typeof s === 'object') MB.settings = Object.assign({ providers: [], search: {}, keys: {} }, s);
    } catch (e) { /* ignore */ }
    MB.settings.providers = MB.settings.providers || [];
    MB.settings.search = MB.settings.search || {};
    MB.settings.keys = MB.settings.keys || {};
  };

  MB.saveSettings = function () {
    try { localStorage.setItem(KEY, JSON.stringify(MB.settings)); } catch (e) { MB.toast('Could not save settings'); }
    MB.emit('providers');
  };

  MB.getProvider = id => (MB.settings.providers || []).find(p => p.id === id);

  // Presets for popular tile services. {key} is replaced with the API key you enter.
  MB.providerPresets = [
    { name: 'Custom XYZ tiles', type: 'xyz', url: 'https://example.com/tiles/{z}/{x}/{y}.png', attribution: '', maxZoom: 19 },
    { name: 'Custom WMS server', type: 'wms', url: 'https://example.com/geoserver/wms', layers: 'workspace:layer', format: 'image/png', attribution: '', maxZoom: 19 },
    { name: 'MapTiler Streets', type: 'xyz', url: 'https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key={key}', tileSize: 512, maxZoom: 20,
      attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
    { name: 'MapTiler Satellite', type: 'xyz', url: 'https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key={key}', maxZoom: 20,
      attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a>' },
    { name: 'Thunderforest Outdoors', type: 'xyz', url: 'https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey={key}', maxZoom: 22,
      attribution: '&copy; <a href="https://www.thunderforest.com/">Thunderforest</a>, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
    { name: 'Thunderforest Landscape', type: 'xyz', url: 'https://{s}.tile.thunderforest.com/landscape/{z}/{x}/{y}.png?apikey={key}', maxZoom: 22,
      attribution: '&copy; <a href="https://www.thunderforest.com/">Thunderforest</a>, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
    { name: 'Thunderforest Transport', type: 'xyz', url: 'https://{s}.tile.thunderforest.com/transport/{z}/{x}/{y}.png?apikey={key}', maxZoom: 22,
      attribution: '&copy; <a href="https://www.thunderforest.com/">Thunderforest</a>, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
    { name: 'Stadia Alidade Smooth', type: 'xyz', url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png?api_key={key}', maxZoom: 20,
      attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
    { name: 'Stadia Outdoors', type: 'xyz', url: 'https://tiles.stadiamaps.com/tiles/outdoors/{z}/{x}/{y}{r}.png?api_key={key}', maxZoom: 20,
      attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
    { name: 'Mapbox Streets', type: 'xyz', url: 'https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/{z}/{x}/{y}?access_token={key}', tileSize: 512, maxZoom: 22,
      attribution: '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
    { name: 'Mapbox Satellite Streets', type: 'xyz', url: 'https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/{z}/{x}/{y}?access_token={key}', tileSize: 512, maxZoom: 22,
      attribution: '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
    { name: 'Geoapify OSM Carto', type: 'xyz', url: 'https://maps.geoapify.com/v1/tile/osm-carto/{z}/{x}/{y}.png?apiKey={key}', maxZoom: 20,
      attribution: 'Powered by <a href="https://www.geoapify.com/">Geoapify</a> | &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }
  ];

  MB.geocoderPresets = [
    { name: 'Nominatim (OpenStreetMap, free)', searchUrl: 'https://nominatim.openstreetmap.org/search', reverseUrl: 'https://nominatim.openstreetmap.org/reverse', keyParam: '' },
    { name: 'LocationIQ (Nominatim-compatible, key)', searchUrl: 'https://us1.locationiq.com/v1/search', reverseUrl: 'https://us1.locationiq.com/v1/reverse', keyParam: 'key' },
    { name: 'geocode.maps.co (Nominatim-compatible, key)', searchUrl: 'https://geocode.maps.co/search', reverseUrl: 'https://geocode.maps.co/reverse', keyParam: 'api_key' },
    { name: 'Self-hosted Nominatim', searchUrl: 'http://localhost:8088/search', reverseUrl: 'http://localhost:8088/reverse', keyParam: '' }
  ];

  /* ---------- dialog ---------- */

  MB.settingsDialog = {
    el: null, editingId: null, tab: 'providers',

    open() {
      if (!this.el) this.build();
      this.render();
      this.el.classList.remove('hidden');
    },
    close() { if (this.el) this.el.classList.add('hidden'); this.editingId = null; },

    build() {
      const el = document.createElement('div');
      el.className = 'modal hidden';
      el.id = 'apiDialog';
      el.innerHTML = `<div class="modal-box wide" role="dialog" aria-modal="true" aria-labelledby="apiDialogTitle">
        ${MB.modalCloseHtml}<h2 id="apiDialogTitle">Map &amp; search APIs</h2>
        <div class="tabs" style="margin:10px 0 14px"><button data-t="providers" class="active">Map providers</button><button data-t="search">Search services</button></div>
        <div data-panel="providers"></div>
        <div data-panel="search" class="hidden"></div>
        <p class="note" style="margin-top:14px">Keys stay in this browser and go only to their provider.</p>
      </div>`;
      el.addEventListener('click', e => {
        if (e.target === el || e.target.closest('[data-act="close"]')) this.close();
        const tb = e.target.closest('.tabs button[data-t]');
        if (tb) { this.tab = tb.dataset.t; this.render(); }
      });
      document.body.appendChild(el);
      this.el = el;
    },

    render() {
      $$('.tabs button', this.el).forEach(b => b.classList.toggle('active', b.dataset.t === this.tab));
      $$('[data-panel]', this.el).forEach(p => p.classList.toggle('hidden', p.dataset.panel !== this.tab));
      if (this.tab === 'providers') this.renderProviders(); else this.renderSearch();
    },

    renderProviders() {
      const panel = $('[data-panel="providers"]', this.el);
      const list = MB.settings.providers;
      const editing = this.editingId ? MB.getProvider(this.editingId) : null;
      const p = editing || { type: 'xyz', maxZoom: 19, tileSize: 256, subdomains: 'abc', format: 'image/png' };
      const keyGroups = Object.keys(MB.builtinKeyGroups || {});
      panel.innerHTML = `
        <div class="section"><h3>Keys for built-in map providers</h3>
          ${keyGroups.map(gk => { const g = MB.builtinKeyGroups[gk]; const cur = MB.builtinKey(gk); return `
          <form class="form-grid builtin-key" data-group="${gk}">
            <label>${esc(g.name)}</label>
            <div class="row" style="margin:0"><input name="key" type="text" value="${esc(cur)}" placeholder="paste your ${esc(g.name)} key" autocomplete="off" spellcheck="false"><button class="btn small primary" type="submit">Save</button></div>
            ${(g.options || []).map(o => `<label>${esc(o.label)}</label><select name="opt_${o.key}">${o.choices.map(c => `<option value="${c[0]}"${MB.builtinOption(o.key, o.choices[0][0]) === c[0] ? ' selected' : ''}>${esc(c[1])}</option>`).join('')}</select>`).join('')}
            <span></span><p class="note" style="margin:0">${esc(g.note)} <a href="${g.signup}" target="_blank" rel="noopener">Get a key</a> · <b>${cur ? 'key set' : 'no key'}</b></p>
          </form>`; }).join('')}
        </div>
        <p class="note">XYZ tiles (<code>{z}/{x}/{y}</code>, optional <code>{s}</code>, <code>{r}</code>, <code>{key}</code>) or WMS.</p>
        <div class="section"><h3>Configured providers</h3>
          ${list.length ? '<div class="prov-list">' + list.map(x => `<div class="prov-item"><span class="pname">${esc(x.name)}</span><span class="badge">${x.type.toUpperCase()}</span>${x.url.includes('{key}') ? `<span class="badge${x.key ? '' : ' warn'}">${x.key ? 'key set' : 'needs key'}</span>` : ''}
            <span class="grow"></span><button class="btn small" data-use="${x.id}">Use</button><button class="btn small" data-edit="${x.id}">Edit</button><button class="btn small danger" data-del="${x.id}">Remove</button></div>`).join('') + '</div>'
          : '<p class="note">None yet.</p>'}
        </div>
        <div class="section"><h3>${editing ? 'Edit provider' : 'Add provider'}</h3>
          <form id="provForm" class="form-grid">
            <label>Preset</label><select name="preset"><option value="">— choose a preset to prefill —</option>${MB.providerPresets.map((x, i) => `<option value="${i}">${esc(x.name)}</option>`).join('')}</select>
            <label>Name</label><input name="name" type="text" required value="${esc(p.name || '')}">
            <label>Protocol</label><select name="type"><option value="xyz"${p.type === 'xyz' ? ' selected' : ''}>XYZ tiles</option><option value="wms"${p.type === 'wms' ? ' selected' : ''}>WMS</option></select>
            <label>URL</label><input name="url" type="text" required value="${esc(p.url || '')}" placeholder="https://…/{z}/{x}/{y}.png?key={key}">
            <label>API key</label><input name="key" type="text" value="${esc(p.key || '')}" placeholder="replaces {key} in the URL" autocomplete="off" spellcheck="false">
            <label>Attribution</label><input name="attribution" type="text" value="${esc(p.attribution || '')}" placeholder="HTML allowed">
            <label>Max zoom</label><input name="maxZoom" type="number" min="1" max="24" value="${p.maxZoom || 19}">
            <label>Subdomains</label><input name="subdomains" type="text" value="${esc(p.subdomains || 'abc')}" placeholder="for {s}, e.g. abc">
            <label>Tile size</label><select name="tileSize"><option value="256"${+p.tileSize !== 512 ? ' selected' : ''}>256 px</option><option value="512"${+p.tileSize === 512 ? ' selected' : ''}>512 px (MapTiler, Mapbox)</option></select>
            <label>WMS layers</label><input name="layers" type="text" value="${esc(p.layers || '')}" placeholder="comma-separated layer names (WMS only)">
            <label>WMS format</label><input name="format" type="text" value="${esc(p.format || 'image/png')}" placeholder="image/png">
            <span></span><div class="btn-row"><button class="btn primary" type="submit">${editing ? 'Save changes' : 'Add provider'}</button>${editing ? '<button class="btn ghost" type="button" data-cancel="1">Cancel</button>' : ''}</div>
          </form>
        </div>`;
      $$('form.builtin-key', panel).forEach(kf => kf.addEventListener('submit', e => {
        e.preventDefault();
        const gk = kf.dataset.group;
        MB.settings.keys[gk] = kf.elements.key.value.trim();
        (MB.builtinKeyGroups[gk].options || []).forEach(o => { MB.settings.keys[o.key] = kf.elements['opt_' + o.key].value; });
        MB.saveSettings();
        const cur = MB.basemaps[MB.state.basemap];
        if (cur && cur.keyGroup === gk) MB.setBasemap(MB.state.basemap); // reload tiles with the key
        MB.toast(MB.builtinKeyGroups[gk].name + ' key ' + (MB.settings.keys[gk] ? 'saved' : 'removed'));
        this.render();
      }));
      const form = $('#provForm', panel);
      $('select[name="preset"]', form).addEventListener('change', e => {
        const pr = MB.providerPresets[+e.target.value];
        if (!pr) return;
        ['name', 'type', 'url', 'attribution', 'maxZoom', 'layers', 'format'].forEach(k => { if (pr[k] != null) form.elements[k].value = pr[k]; });
        form.elements.tileSize.value = pr.tileSize === 512 ? '512' : '256';
        form.elements.subdomains.value = pr.subdomains || 'abc';
        form.elements.key.focus();
      });
      form.addEventListener('submit', e => {
        e.preventDefault();
        const f = form.elements;
        const data = {
          id: editing ? editing.id : MB.uid(), name: f.name.value.trim(), type: f.type.value, url: f.url.value.trim(), key: f.key.value.trim(),
          attribution: f.attribution.value.trim(), maxZoom: +f.maxZoom.value || 19, subdomains: f.subdomains.value.trim() || 'abc',
          tileSize: +f.tileSize.value, layers: f.layers.value.trim(), format: f.format.value.trim() || 'image/png'
        };
        if (!data.name || !data.url) return;
        if (editing) Object.assign(editing, data); else MB.settings.providers.push(data);
        MB.saveSettings();
        this.editingId = null;
        if (MB.state.basemap === 'custom:' + data.id) MB.setBasemap(MB.state.basemap);
        MB.toast('Provider saved');
        this.render();
      });
      const cancel = $('[data-cancel]', form);
      if (cancel) cancel.addEventListener('click', () => { this.editingId = null; this.render(); });
      panel.addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.edit) { this.editingId = b.dataset.edit; this.render(); }
        else if (b.dataset.del) {
          const x = MB.getProvider(b.dataset.del);
          if (x && confirm('Remove provider "' + x.name + '"?')) {
            MB.settings.providers = MB.settings.providers.filter(y => y.id !== x.id);
            if (MB.state.basemap === 'custom:' + x.id) MB.setBasemap('esriSat');
            MB.saveSettings(); this.render();
          }
        } else if (b.dataset.use) { MB.setBasemap('custom:' + b.dataset.use); MB.toast('Base map changed'); }
      });
    },

    renderSearch() {
      const panel = $('[data-panel="search"]', this.el);
      const d = MB.defaultSearchSettings, s = MB.settings.search;
      const v = k => s[k] != null ? s[k] : d[k];
      panel.innerHTML = `
        <p class="note">Nominatim-compatible geocoder; Overpass endpoints are tried in order.</p>
        <form id="searchForm" class="form-grid">
          <label>Preset</label><select name="preset"><option value="">— choose —</option>${MB.geocoderPresets.map((x, i) => `<option value="${i}">${esc(x.name)}</option>`).join('')}</select>
          <label>Search URL</label><input name="geocoderSearchUrl" type="text" value="${esc(v('geocoderSearchUrl'))}">
          <label>Reverse URL</label><input name="geocoderReverseUrl" type="text" value="${esc(v('geocoderReverseUrl'))}">
          <label>Key parameter</label><input name="geocoderKeyParam" type="text" value="${esc(v('geocoderKeyParam'))}" placeholder="e.g. key or api_key (empty if none)">
          <label>API key</label><input name="geocoderKey" type="text" value="${esc(v('geocoderKey'))}" autocomplete="off" spellcheck="false">
          <label>Overpass endpoints</label><textarea name="overpassUrls" rows="4">${esc((v('overpassUrls') || []).join('\n'))}</textarea>
          <span></span><div class="btn-row"><button class="btn primary" type="submit">Save</button><button class="btn ghost" type="button" data-reset="1">Reset to defaults</button></div>
        </form>`;
      const form = $('#searchForm', panel);
      $('select[name="preset"]', form).addEventListener('change', e => {
        const pr = MB.geocoderPresets[+e.target.value];
        if (!pr) return;
        form.elements.geocoderSearchUrl.value = pr.searchUrl;
        form.elements.geocoderReverseUrl.value = pr.reverseUrl;
        form.elements.geocoderKeyParam.value = pr.keyParam;
        if (pr.keyParam) form.elements.geocoderKey.focus();
      });
      form.addEventListener('submit', e => {
        e.preventDefault();
        const f = form.elements;
        MB.settings.search = {
          geocoderSearchUrl: f.geocoderSearchUrl.value.trim() || d.geocoderSearchUrl,
          geocoderReverseUrl: f.geocoderReverseUrl.value.trim() || d.geocoderReverseUrl,
          geocoderKeyParam: f.geocoderKeyParam.value.trim(),
          geocoderKey: f.geocoderKey.value.trim(),
          overpassUrls: f.overpassUrls.value.split(/\s+/).map(x => x.trim()).filter(Boolean)
        };
        if (!MB.settings.search.overpassUrls.length) MB.settings.search.overpassUrls = d.overpassUrls.slice();
        MB.saveSettings();
        MB.toast('Search settings saved');
      });
      $('[data-reset]', form).addEventListener('click', () => { MB.settings.search = {}; MB.saveSettings(); this.render(); MB.toast('Search settings reset'); });
    }
  };
})(window.MB);
