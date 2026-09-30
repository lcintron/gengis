/* GenGIS - presenter mode: hides all editing UI, shows only the map with its layers */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  MB.presenter = {
    active: false, bar: null,

    enter() {
      if (this.active) return;
      MB.tools.set('select');
      MB.deselect();
      if (MB.contextMenu) MB.contextMenu.hide();
      MB.tools.current = 'present'; // feature clicks are ignored while presenting
      this.active = true;
      document.body.classList.add('presenting');
      if (!this.bar) {
        const bar = document.createElement('div');
        bar.id = 'presentBar';
        bar.innerHTML = '<span class="dim">Presenting</span>' +
          '<button class="btn small ghost" data-act="fs" title="Toggle full screen">Full screen</button>' +
          '<button class="btn small" data-act="exit" title="Exit presenter mode (Esc)">Exit</button>';
        bar.addEventListener('click', e => {
          const act = e.target.dataset && e.target.dataset.act;
          if (act === 'exit') this.exit();
          else if (act === 'fs') this.toggleFullscreen();
        });
        document.body.appendChild(bar);
        document.addEventListener('fullscreenchange', () => setTimeout(() => MB.map.invalidateSize(), 100));
        this.bar = bar;
      }
      setTimeout(() => MB.map.invalidateSize(), 50);
      MB.emit('presenter', true);
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
      if (!document.fullscreenElement) {
        const el = document.documentElement;
        if (el.requestFullscreen) el.requestFullscreen().catch(() => MB.toast('Full screen not available here'));
      } else if (document.exitFullscreen) document.exitFullscreen();
    }
  };
})(window.MB);
