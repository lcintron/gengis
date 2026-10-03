/* GenGIS - my location: a map button that centers on the device's position (GPS or the browser's estimate)
 * and keeps a dot with its accuracy circle on the map. The browser (or the desktop app's OS) asks the user for
 * permission the first time. The map follows the position until it is panned by hand; the button then re-centers,
 * and a press while centered turns the location off. Nothing about the position is saved. */
(function () {
  const MB = window.MB;
  const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/></svg>';
  const BLUE = '#2f80ed';

  MB.locate = {
    watchId: null,   // navigator.geolocation watch while the location is on
    fix: null,       // last position: { latlng, accuracy (m), at }
    follow: false,   // the map pans with the position until the user moves it
    centered: false, // the next fix centers (and zooms to) the position
    btn: null, bar: null, dot: null, ring: null,

    init() {
      const pane = MB.map.createPane('mb-locate'); // above data and objects, never in the way of a click
      pane.style.zIndex = 640;
      pane.style.pointerEvents = 'none';
      const self = this;
      const Ctl = L.Control.extend({
        options: { position: 'topright' },
        onAdd() {
          const bar = self.bar = L.DomUtil.create('div', 'leaflet-bar leaflet-control mb-locate');
          const a = self.btn = L.DomUtil.create('a', '', bar);
          a.href = '#';
          a.setAttribute('role', 'button');
          a.innerHTML = ICON;
          L.DomEvent.disableClickPropagation(bar);
          L.DomEvent.on(a, 'click', e => { L.DomEvent.preventDefault(e); self.press(); });
          self.render();
          return bar;
        }
      });
      new Ctl().addTo(MB.map);
      // a pan by hand ends following (a programmatic pan has no dragstart)
      MB.map.on('dragstart', () => { if (this.follow) { this.follow = false; this.render(); } });
    },

    press() {
      if (this.watchId == null) return this.start();
      if (!this.fix) return; // still waiting for the first position
      const off = MB.map.latLngToContainerPoint(this.fix.latlng).distanceTo(MB.map.getSize().divideBy(2));
      if (this.follow && off < 30) return this.stop(); // already on it: the press turns the location off
      this.follow = true;
      MB.map.panTo(this.fix.latlng);
      this.render();
    },

    start() {
      if (!('geolocation' in navigator)) { MB.toast('This browser cannot tell the map your location.', 4000); return; }
      if (window.isSecureContext === false) { MB.toast('Your location is only available on a secure (https) page.', 4500); return; }
      this.follow = true;
      this.centered = false;
      this.watchId = navigator.geolocation.watchPosition(p => this.onFix(p), e => this.onError(e),
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
      this.render();
    },

    stop() {
      if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
      this.fix = null;
      this.follow = false;
      if (this.dot) { MB.map.removeLayer(this.dot); this.dot = null; }
      if (this.ring) { MB.map.removeLayer(this.ring); this.ring = null; }
      this.render();
    },

    onFix(p) {
      if (this.watchId == null) return;
      const latlng = L.latLng(p.coords.latitude, p.coords.longitude), accuracy = Math.max(0, p.coords.accuracy || 0);
      this.fix = { latlng, accuracy, at: p.timestamp || Date.now() };
      if (!this.ring) {
        this.ring = L.circle(latlng, { radius: accuracy, pane: 'mb-locate', interactive: false, pmIgnore: true, color: BLUE, weight: 1, opacity: .6, fillColor: BLUE, fillOpacity: .12 }).addTo(MB.map);
        this.dot = L.circleMarker(latlng, { radius: 7, pane: 'mb-locate', interactive: false, pmIgnore: true, color: '#fff', weight: 2.5, fillColor: BLUE, fillOpacity: 1 }).addTo(MB.map);
      } else {
        this.ring.setLatLng(latlng).setRadius(accuracy);
        this.dot.setLatLng(latlng);
      }
      if (!this.centered) {
        // first position: center on it, close enough to see the accuracy circle whole (a city block or a town)
        this.centered = true;
        MB.map.setView(latlng, Math.min(17, MB.map.getBoundsZoom(this.ring.getBounds(), false)));
        MB.toast('Your location, accurate to about ' + MB.formatDistance(accuracy), 3000);
      } else if (this.follow) MB.map.panTo(latlng, { animate: true });
      this.render();
    },

    onError(e) {
      const waiting = !this.fix;
      if (e.code === 1) { // PERMISSION_DENIED
        this.stop();
        MB.toast('Location access is blocked. Allow it for this site in the browser settings (and in the system\'s location settings), then press the button again.', 6000);
      } else if (waiting) { // no position yet: unavailable or too slow
        this.stop();
        MB.toast(e.code === 3 ? 'Finding your location took too long. Try again; outdoors or with Wi-Fi on is faster.' : 'Your location is not available right now (no GPS or network position).', 5000);
      }
      // after a first fix, a missed update keeps the last position on the map
    },

    render() {
      if (!this.btn) return;
      const on = this.watchId != null, waiting = on && !this.fix;
      this.bar.classList.toggle('locating', waiting);
      this.bar.classList.toggle('active', on && !!this.fix);
      this.bar.classList.toggle('following', on && !!this.fix && this.follow);
      const title = !on ? 'Center on my location' : (waiting ? 'Finding your location…' : (this.follow ? 'Following your location: press to turn it off' : 'Center on my location again'));
      this.btn.title = title;
      this.btn.setAttribute('aria-label', title);
      this.btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };
})();
