/* GenGIS - my location: a map button that centers on the device's position (GPS or the browser's estimate)
 * and keeps a dot with its accuracy circle on the map. The browser (or the desktop app's OS) asks the user for
 * permission the first time. While the location is on, the map follows it (the wheel, a pinch or a double-click zoom
 * about the position) until it is moved some other way: a drag, the keys, a search, a popup opening at its edge. Then
 * it stays where it was put, the dot still moving, and a button under this one brings it back to following.
 * A press of the location button turns the location off.
 * A beam from the dot shows where the device points: its compass where it has one (corrected from magnetic to true
 * north with the World Magnetic Model, as the map is drawn), else the direction of travel while moving.
 * The dot, the heading and the position are never saved; the map view is, as after any pan, so a project saved
 * while centered on the position opens there. */
(function () {
  const MB = window.MB;
  const DEG = Math.PI / 180;
  const COMPASS_STALE = 3000; // ms without a compass reading before the direction of travel is used instead
  const MOVING = 0.5;         // m/s: slower than this, the GPS course means nothing

  // The compass direction a device points, from an absolute (north-referenced) orientation: its top edge, and as it
  // is raised toward upright (where the top edge points at the sky) more and more its back, the way its camera looks.
  // A sideways roll leaves the top edge's direction alone. alpha, beta, gamma in degrees; null if it cannot tell.
  function headingFrom(alpha, beta, gamma) {
    const sa = Math.sin(alpha * DEG), ca = Math.cos(alpha * DEG), sb = Math.sin(beta * DEG), cb = Math.cos(beta * DEG);
    const sg = Math.sin(gamma * DEG), cg = Math.cos(gamma * DEG);
    const w = sb > 0 ? sb ** 4 : 0; // the back counts only with the screen facing the user, and mostly near upright
    const east = -sa * cb + w * (-sg * ca - cg * sb * sa), north = ca * cb + w * (-sg * sa + cg * sb * ca);
    return Math.hypot(east, north) < 1e-6 ? null : (Math.atan2(east, north) / DEG + 360) % 360;
  }
  // How far the screen is turned from the device's natural (portrait) orientation: the heading is the screen's top.
  const screenAngle = () => (screen.orientation && typeof screen.orientation.angle === 'number' ? screen.orientation.angle : (typeof window.orientation === 'number' ? window.orientation : 0));
  const wrap = d => ((d % 360) + 540) % 360 - 180; // to -180..180
  // A beam from the center, pointing up (north), half-angle h degrees.
  function beamSvg(h, course) {
    const r = 44, x = (r * Math.sin(h * DEG)).toFixed(2), y = (-r * Math.cos(h * DEG)).toFixed(2), id = course ? 'mbBeamC' : 'mbBeam';
    return `<svg viewBox="-48 -48 96 96" aria-hidden="true"><defs><radialGradient id="${id}" cx="0" cy="0" r="44" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0" stop-color="#2f80ed" stop-opacity="${course ? 0.75 : 0.6}"/><stop offset="1" stop-color="#2f80ed" stop-opacity="0"/></radialGradient></defs>` +
      `<path d="M0 0L${-x} ${y}A${r} ${r} 0 0 1 ${x} ${y}Z" fill="url(#${id})"/></svg>`;
  }
  const ICON ='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/></svg>';
  const BACK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/></svg>'; // recenter: a point in a frame
  const BLUE = '#2f80ed';

  MB.locate = {
    watchId: null,   // navigator.geolocation watch while the location is on
    gen: 0,          // which watch is current: callbacks of an earlier one are ignored
    fix: null,       // last position: { latlng, accuracy (m), at }
    follow: false,   // the map is kept on the position (while the location is on, until the map is moved otherwise)
    own: false,      // the move under way is this module's own (following): its end does not stop the following
    zoomOpts: null,  // the map's own zoom options, put back when the location is turned off
    centered: false, // the next fix centers (and zooms to) the position
    btn: null, back: null, bar: null, dot: null, ring: null,
    heading: null,   // where the device points: { deg (true north), src: 'compass' | 'course', spread (deg) }
    beam: null, compassAt: 0, decl: 0, smooth: null, raf: 0, unlisten: null,
    rot: null,       // the beam's rotation as drawn: continuous, so turning through north does not spin it round

    init() {
      const pane = MB.map.createPane('mb-locate'); // above data and objects, never in the way of a click
      pane.style.zIndex = 640;
      pane.style.pointerEvents = 'none';
      const beams = MB.map.createPane('mb-locate-beam'); // the heading, under the dot
      beams.style.zIndex = 639;
      beams.style.pointerEvents = 'none';
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
          const b = self.back = L.DomUtil.create('a', 'mb-locate-back', bar); // shown while the map is off the position
          b.href = '#';
          b.setAttribute('role', 'button');
          b.title = 'Back to my location';
          b.setAttribute('aria-label', b.title);
          b.innerHTML = BACK;
          b.hidden = true;
          L.DomEvent.on(b, 'click', e => { L.DomEvent.preventDefault(e); self.recenter(); });
          self.render();
          return bar;
        }
      });
      new Ctl().addTo(MB.map);
      // The map moved some other way than following (a drag, the keys, a box zoom, a search, a popup's pan): it stays
      // there. A zoom about the position keeps it centered, so it follows on.
      const map = MB.map;
      map.on('dragstart', () => this.unfollow());
      map.on('moveend', () => {
        if (this.own) { this.own = false; return; }
        if (this.follow && this.fix && map.latLngToContainerPoint(this.near(this.fix.latlng)).distanceTo(map.getSize().divideBy(2)) > 3) this.unfollow();
      });
    },

    // The copy of a position nearest the map's center (the map wraps round the world: worldCopyJump).
    near(latlng) {
      const c = MB.map.getCenter();
      return L.latLng(latlng.lat, latlng.lng + Math.round((c.lng - latlng.lng) / 360) * 360);
    },

    unfollow() {
      if (!this.follow || !this.fix) return;
      this.follow = false;
      this.zoomAboutCenter(false); // the wheel and a pinch zoom about the pointer again
      this.render();
    },

    // Back to the position, following it again.
    recenter() {
      if (this.watchId == null || !this.fix) return;
      this.follow = true;
      this.zoomAboutCenter(true);
      this.pan(this.fix.latlng);
      this.render();
    },

    pan(latlng) { this.own = true; MB.map.panTo(this.near(latlng), { animate: true }); },

    press() {
      if (this.watchId == null) return this.start();
      this.stop(); // on (or still finding the position): the press turns it off
    },

    // Zooming by wheel, pinch or double-click about the map's center (the position) instead of the pointer.
    zoomAboutCenter(on) {
      const o = MB.map.options;
      if (on && !this.zoomOpts) {
        this.zoomOpts = { scrollWheelZoom: o.scrollWheelZoom, touchZoom: o.touchZoom, doubleClickZoom: o.doubleClickZoom };
        ['scrollWheelZoom', 'touchZoom', 'doubleClickZoom'].forEach(k => { if (o[k]) o[k] = 'center'; });
      } else if (!on && this.zoomOpts) { Object.assign(o, this.zoomOpts); this.zoomOpts = null; }
    },

    start() {
      if (!('geolocation' in navigator)) { MB.toast('This browser cannot tell the map your location.', 4000); return; }
      if (window.isSecureContext === false) { MB.toast('Your location is only available on a secure (https) page.', 4500); return; }
      this.follow = true;
      this.centered = false;
      this.zoomAboutCenter(true);
      const gen = ++this.gen;
      this.watchId = navigator.geolocation.watchPosition(p => { if (gen === this.gen) this.onFix(p); }, e => { if (gen === this.gen) this.onError(e); },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
      this.startCompass(gen);
      this.render();
    },

    // The device's orientation, where it has a compass. iOS asks for permission, and only from a tap: this runs
    // from the button press. Android gives an absolute event; iOS a heading of its own on the plain one.
    startCompass(gen) {
      const D = window.DeviceOrientationEvent;
      if (!D) return;
      const listen = () => {
        if (gen !== this.gen) return;
        const type = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
        const fn = e => { if (gen === this.gen) this.onOrientation(e); };
        window.addEventListener(type, fn);
        this.unlisten = () => window.removeEventListener(type, fn);
      };
      // (a request that fails, rather than being refused, listens anyway: without the permission no event comes)
      if (typeof D.requestPermission === 'function') D.requestPermission().then(s => { if (s === 'granted') listen(); }, listen);
      else listen();
    },

    onOrientation(e) {
      let mag = null, spread = 28;
      if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) { // iOS: its own compass heading
        mag = e.webkitCompassHeading;
        if (e.webkitCompassAccuracy > 0) spread = Math.max(15, Math.min(60, e.webkitCompassAccuracy));
      } else if ((e.absolute || e.type === 'deviceorientationabsolute') && e.alpha != null) mag = headingFrom(e.alpha, e.beta || 0, e.gamma || 0);
      if (mag == null) return; // relative to wherever the device started: no use as a compass
      const deg = (mag + screenAngle() + this.decl + 720) % 360; // magnetic to true north
      this.smooth = this.smooth == null ? deg : (this.smooth + wrap(deg - this.smooth) * 0.3 + 360) % 360; // steady, without lagging a turn
      this.compassAt = Date.now();
      this.setHeading({ deg: this.smooth, src: 'compass', spread });
    },

    setHeading(h) {
      this.heading = h;
      if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.drawBeam(); });
    },

    drawBeam() {
      const h = this.heading, fix = this.fix;
      if (!h || !fix) { if (this.beam) { MB.map.removeLayer(this.beam); this.beam = null; } this.render(); return; }
      const course = h.src === 'course', key = (course ? 'c' : 'm') + Math.round(h.spread);
      if (!this.beam || this.beam._key !== key) {
        if (this.beam) MB.map.removeLayer(this.beam);
        this.beam = L.marker(fix.latlng, { pane: 'mb-locate-beam', interactive: false, keyboard: false, pmIgnore: true,
          icon: L.divIcon({ className: 'mb-heading', iconSize: [96, 96], iconAnchor: [48, 48], html: `<div class="mb-heading-rot">${beamSvg(h.spread, course)}</div>` }) }).addTo(MB.map);
        this.beam.options.pmIgnore = true;
        this.beam._key = key;
      } else this.beam.setLatLng(fix.latlng);
      const el = this.beam.getElement();
      this.rot = this.rot == null ? h.deg : this.rot + wrap(h.deg - this.rot); // 359° to 1° is 2°, not -358°
      if (el) el.firstChild.style.transform = `rotate(${this.rot.toFixed(1)}deg)`;
      this.render();
    },

    stop() {
      if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
      this.gen++; // a callback still on its way from this watch is ignored
      this.fix = null;
      this.follow = false;
      this.own = false;
      this.zoomAboutCenter(false);
      if (this.unlisten) { this.unlisten(); this.unlisten = null; }
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
      this.heading = null; this.smooth = null; this.compassAt = 0; this.rot = null;
      if (this.beam) { MB.map.removeLayer(this.beam); this.beam = null; }
      if (this.dot) { MB.map.removeLayer(this.dot); this.dot = null; }
      if (this.ring) { MB.map.removeLayer(this.ring); this.ring = null; }
      this.render();
    },

    onFix(p) {
      if (this.watchId == null) return;
      const latlng = L.latLng(p.coords.latitude, p.coords.longitude), accuracy = Math.max(0, p.coords.accuracy || 0);
      this.fix = { latlng, accuracy, at: p.timestamp || Date.now() };
      this.decl = MB.declination ? MB.declination.declination(latlng.lat, latlng.lng) : 0; // a compass reads magnetic north
      // no compass (or not lately): the direction of travel, while moving
      if (Date.now() - this.compassAt > COMPASS_STALE) {
        const c = p.coords, moving = c.speed != null && c.speed >= MOVING && c.heading != null && !isNaN(c.heading);
        this.setHeading(moving ? { deg: c.heading, src: 'course', spread: 16 } : null);
      } else this.setHeading(this.heading); // the beam follows the dot
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
        this.own = true;
        MB.map.setView(latlng, Math.min(17, MB.map.getBoundsZoom(this.ring.getBounds(), false)));
        MB.toast('Your location, accurate to about ' + MB.formatDistance(accuracy), 3000);
      } else if (this.follow) this.pan(latlng);
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
      const h = this.heading, dir = h && this.fix ? ` · heading ${Math.round(h.deg) % 360}° (${h.src === 'compass' ? 'compass' : 'direction of travel'})` : '';
      if (this.back) this.back.hidden = !(on && this.fix && !this.follow);
      const title = !on ? 'Center on my location' : (waiting ? 'Finding your location… (press to cancel)' : (this.follow ? 'Following your location' : 'Showing your location') + dir + ': press to turn it off');
      if (this.btn.title !== title) { this.btn.title = title; this.btn.setAttribute('aria-label', title); } // the compass redraws many times a second
      this.btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };
})();
