/* GenGIS - busy indicator: a small pill at the top of the map listing what is still loading */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  MB.busy = {
    tasks: new Map(), el: null, hideTimer: null,

    init() {
      const el = document.createElement('div');
      el.className = 'mb-busy hidden';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.innerHTML = '<span class="spin" aria-hidden="true"></span><span class="txt"></span>';
      // Right under the coordinates readout in the bottom-left corner.
      const host = (MB.statusControl && MB.statusControl._div) || document.getElementById('mapwrap');
      host.appendChild(el);
      this.el = el;

      // Base-map tiles
      const hookTiles = layer => {
        if (!layer) return;
        layer.on('loading', () => this.set('tiles', 'map tiles'));
        layer.on('load', () => this.clear('tiles'));
      };
      hookTiles(MB.baseLayer);
      MB.on('basemap', () => { this.clear('tiles'); hookTiles(MB.baseLayer); });

      // Data layers (FAA, boundaries, custom) and their update checks
      MB.on('data', () => {
        const sets = MB.data ? MB.data.catalog().filter(d => d.enabled) : [];
        const loading = sets.filter(d => d.loading.size).map(d => shortName(d.def));
        const checking = sets.filter(d => d.checking && !d.loading.size).map(d => shortName(d.def));
        if (loading.length) this.set('data', (loading.length > 2 ? loading.length + ' data layers' : loading.join(', ')));
        else this.clear('data');
        if (checking.length) this.set('check', 'checking updates'); else this.clear('check');
        if (MB.freqs && MB.freqs.loading) this.set('freqs', 'airport frequencies'); else this.clear('freqs');
      });
    },

    set(key, label) {
      this.tasks.set(key, label);
      this.render();
    },
    clear(key) {
      if (!this.tasks.delete(key)) return;
      this.render();
    },
    // Wrap a promise: shows the label until it settles.
    track(key, label, promise) {
      this.set(key, label);
      return Promise.resolve(promise).finally(() => this.clear(key));
    },

    render() {
      if (!this.el) return;
      clearTimeout(this.hideTimer);
      if (this.tasks.size) {
        const labels = Array.from(new Set(this.tasks.values()));
        this.el.querySelector('.txt').textContent = 'Loading ' + labels.join(' · ');
        this.el.classList.remove('hidden');
      } else {
        // short grace period so quick successive loads don't flicker
        this.hideTimer = setTimeout(() => this.el.classList.add('hidden'), 300);
      }
    }
  };

  function shortName(def) {
    return { fria: 'FRIA', uasfm: 'LAANC grid', classAirspace: 'airspace', sua: 'special use airspace', prohibited: 'prohibited areas', nsufr: 'flight restrictions',
      nsufrPart: 'flight restrictions', nsufrPending: 'flight restrictions', ndaTfr: 'TFR areas', recSites: 'fixed sites', stadiums: 'stadiums', airports: 'airports',
      countries: 'countries', admin1: 'state boundaries' }[def.id] || def.name.toLowerCase();
  }
})(window.MB);
