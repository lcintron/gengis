/* GenGIS - bootstrap */
(function (MB) {
  'use strict';

  function init() {
    MB.map = L.map('map', {
      center: [40.7128, -74.006], zoom: 13, zoomControl: false, attributionControl: false,
      worldCopyJump: true, zoomSnap: 0.5, doubleClickZoom: true
    });
    L.control.zoom({ position: 'topright' }).addTo(MB.map);
    L.control.attribution({ position: 'bottomleft', prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>' }).addTo(MB.map);

    MB.map.pm.setGlobalOptions({ pmIgnore: false, allowSelfIntersection: true });
    MB.loadSettings();
    MB.initTooltipDelay(MB.map);
    MB.setBasemap('osm');

    MB.measure.init();
    MB.tools.init();
    MB.geometry.init();

    // restore previous session or start fresh
    if (!MB.loadAutosave()) {
      MB.createLayer('Layer 1');
      MB.resetHistory();
    }
    MB.map.on('moveend', () => MB.autosave());

    MB.ui.init();
    MB.data.init();
    MB.offline.init();
    MB.on('offline', () => MB.offline.renderSection());
    MB.data.applyState();
    MB.data.renderPanel();
    MB.on('data', () => { MB.data.renderPanelSoon(); MB.data.renderOverlaysSoon(); });
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
    const splash = document.getElementById('splash');
    if (splash) setTimeout(() => { splash.classList.add('hide'); setTimeout(() => splash.remove(), 400); }, 350);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') MB.saveNow(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window.MB);
