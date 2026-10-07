/* GenGIS - presenter mode: hides all editing UI, shows only the map with its layers */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const ICONS = {
    full: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    unfull: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    exit: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>'
  };

  MB.presenter = {
    active: false, ctl: null, fsBtn: null,

    enter() {
      if (this.active) return;
      MB.tools.set('select');
      MB.deselect();
      if (MB.contextMenu) MB.contextMenu.hide();
      MB.tools.current = 'present'; // feature clicks are ignored while presenting
      this.active = true;
      document.body.classList.add('presenting');
      if (!this.ctl) this.build();
      this.renderFs();
      setTimeout(() => MB.map.invalidateSize(), 50);
      MB.emit('presenter', true);
    },

    // The presenter's controls: exit and full screen, as map buttons under the location button (css shows them
    // only while presenting), the app's logo for full screen, and, in the desktop app, a strip at the top to move
    // the window by (its title bar is hidden while presenting).
    build() {
      const self = this;
      const Ctl = L.Control.extend({
        options: { position: 'topright' },
        onAdd() {
          const bar = L.DomUtil.create('div', 'leaflet-bar leaflet-control mb-present-ctl');
          const button = (act, html, title) => {
            const a = L.DomUtil.create('a', '', bar);
            a.href = '#'; a.setAttribute('role', 'button'); a.dataset.act = act; a.innerHTML = html;
            a.title = title; a.setAttribute('aria-label', title);
            L.DomEvent.on(a, 'click', e => { L.DomEvent.preventDefault(e); if (act === 'exit') self.exit(); else self.toggleFullscreen(); });
            return a;
          };
          button('exit', ICONS.exit, 'Exit presenter mode (Esc)'); // right under the location button
          self.fsBtn = button('fs', ICONS.full, 'Full screen');
          L.DomEvent.disableClickPropagation(bar);
          return bar;
        }
      });
      this.ctl = new Ctl().addTo(MB.map); // added after the location button: under it
      const logo = document.createElement('img');
      logo.className = 'present-logo'; logo.src = 'icons/logo-on-dark.svg'; logo.alt = MB.APP.name;
      document.body.appendChild(logo);
      const drag = document.createElement('div');
      drag.id = 'presentDrag';
      document.body.appendChild(drag);
      document.addEventListener('fullscreenchange', () => { this.renderFs(); setTimeout(() => MB.map.invalidateSize(), 100); });
    },

    // Full screen: the page's own (the button) or, in the desktop app, the window's (F11), marked on <html> for css.
    isFull() { return !!document.fullscreenElement || document.documentElement.classList.contains('win-fullscreen'); },

    // The full screen button: enter or leave, as it is now.
    renderFs() {
      if (!this.fsBtn) return;
      const full = this.isFull(), title = full ? 'Exit full screen' : 'Full screen';
      this.fsBtn.innerHTML = full ? ICONS.unfull : ICONS.full;
      this.fsBtn.title = title; this.fsBtn.setAttribute('aria-label', title);
    },

    exit() {
      if (!this.active) return;
      this.active = false;
      document.body.classList.remove('presenting');
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
      MB.tools.current = 'select';
      MB.tools.set('select');
      setTimeout(() => MB.map.invalidateSize(), 50);
      MB.emit('presenter', false);
    },

    toggleFullscreen() {
      if (document.fullscreenElement) { if (document.exitFullscreen) document.exitFullscreen(); return; }
      if (document.documentElement.classList.contains('win-fullscreen') && window.gengisDesktop) { window.gengisDesktop.leaveFullScreen(); return; }
      const el = document.documentElement;
      if (el.requestFullscreen) el.requestFullscreen().catch(() => MB.toast('Full screen not available here'));
    }
  };

  // The desktop app's window full screen (F11): marked on <html>, so the logo, the controls and the drag strip
  // follow it as they follow the page's own.
  if (window.gengisDesktop && window.gengisDesktop.onFullScreen) {
    window.gengisDesktop.onFullScreen(on => {
      document.documentElement.classList.toggle('win-fullscreen', on);
      MB.presenter.renderFs();
      if (MB.map) setTimeout(() => MB.map.invalidateSize(), 100);
    });
  }
})(window.MB);
