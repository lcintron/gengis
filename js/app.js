/* GenGIS - bootstrap */
(function (MB) {
  'use strict';

  // The splash covers start-up only. It is always taken down, also when start-up fails, so an error cannot leave
  // the app hidden behind it.
  function hideSplash() {
    const splash = document.getElementById('splash');
    if (splash) setTimeout(() => { splash.classList.add('hide'); setTimeout(() => splash.remove(), 400); }, 150);
  }

  // The splash stays up until the saved project has been read from the database (3 s at most), so nothing can be
  // edited in a project that is about to be replaced by its newer saved copy.
  function init() {
    try { start(); } finally {
      const settled = MB.projects && MB.projects.started ? MB.projects.started.catch(() => {}) : Promise.resolve();
      Promise.race([settled, new Promise(r => setTimeout(r, 3000))]).then(hideSplash);
    }
  }

  // A new release installs in the background while the page keeps running the version it loaded. Say so once it
  // has taken over; the project is saved continuously, so reloading loses nothing.
  function watchForUpdate() {
    const sw = navigator.serviceWorker;
    const hadController = !!sw.controller; // the very first install also takes control: that is not an update
    sw.addEventListener('controllerchange', () => {
      if (!hadController || document.getElementById('mb-update')) return;
      const el = document.createElement('div');
      el.id = 'mb-update';
      el.setAttribute('role', 'status');
      el.innerHTML = '<span>A new version of GenGIS is ready.</span><button type="button" class="btn small primary">Reload</button><button type="button" class="icon-btn mini" title="Later" aria-label="Later">&times;</button>';
      el.querySelector('.primary').addEventListener('click', () => { MB.projects.flush().finally(() => location.reload()); }); // saved first, also a large project
      el.querySelector('.icon-btn').addEventListener('click', () => el.remove());
      document.body.appendChild(el);
    });
  }

  function start() {
    MB.map = L.map('map', {
      center: [40.7128, -74.006], zoom: 13, zoomControl: false, attributionControl: false,
      worldCopyJump: true, zoomSnap: 0.5, doubleClickZoom: true
    });
    L.control.zoom({ position: 'topright' }).addTo(MB.map);
    L.control.attribution({ position: 'bottomleft', prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>' }).addTo(MB.map);

    MB.map.pm.setGlobalOptions({ pmIgnore: false, allowSelfIntersection: true });
    MB.loadSettings();
    MB.initTooltipDelay(MB.map);
    MB.setBasemap(MB.state.basemap); // the default until the autosaved project says otherwise

    MB.measure.init();
    MB.tools.init();
    MB.scaler.init();
    MB.geometry.init();

    // restore previous session or start fresh
    if (!MB.loadAutosave()) {
      MB.state.projectId = MB.uid(); // a project of its own from the start
      MB.createLayer('Layer 1');
      MB.resetHistory();
    }
    MB.map.on('moveend', () => MB.autosave('view'));

    MB.ui.init();
    MB.projects.start(); // the saved copy in the database, if newer; saving starts once it has settled
    MB.data.init();
    MB.adsb.init();
    MB.locate.init();
    MB.offline.init();
    MB.busy.init();
    MB.tilePrefetch.init();
    MB.on('offline', () => MB.offline.renderSection());
    MB.data.applyState();
    MB.data.renderPanel();
    MB.on('data', () => { MB.data.renderPanelSoon(); MB.data.renderOverlaysSoon(); });
    MB.freqs.onReady(() => MB.data.restyle('airports')); // towered airports get their color once frequencies are known
    MB.ui.renderSettings();
    MB.on('project', () => MB.data.applyState());
    if (window.innerWidth < 640) document.getElementById('sidebar').classList.add('collapsed');
    MB.emit('units', MB.state.units);
    MB.emit('history');
    MB.tools.set('select');

    // name tooltips for named features
    Object.keys(MB.featureLayers).forEach(id => { const f = MB.featureLayers[id]; if (f.mb.name) MB.ui.bindNameTip(f); });

    // URL parameters (?q=, ?lat=&lon=, ?center=, ?poi=)
    MB.applyUrlParams();

    // PWA
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      watchForUpdate();
      navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker not registered', e));
    }
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      MB.installPrompt = e;
      document.getElementById('installBtn').classList.remove('hidden');
    });
    window.addEventListener('online', () => MB.toast('Back online'));
    window.addEventListener('offline', () => MB.toast('Offline: cached map tiles only, search unavailable'));
    window.addEventListener('resize', () => MB.map.invalidateSize());
    window.addEventListener('pagehide', () => MB.saveNow());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') MB.saveNow(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window.MB);
