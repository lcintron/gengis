/* GenGIS - "Cast to a screen": put the map on a TV or projector.
 * A page cannot start the device's screen mirroring on its own, so this does the part it can — enter presenter mode
 * (map, layers and logo, full screen, no controls) — and shows the steps to mirror this screen on the device at hand
 * (Android's Screen cast / Smart View, a computer's Cast… menu, AirPlay). The steps are chosen from what the device
 * looks like; all of them are offered under "Other device".
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';
  const esc = MB.escapeHtml;

  // Which set of steps to show first. Only a hint from the user agent; the dialog lists the rest too.
  function platform() {
    const ua = navigator.userAgent || '', app = !!window.gengisDesktop;
    if (/Android/.test(ua)) return 'android';
    if (/iPhone|iPad|iPod|Macintosh/.test(ua) && 'ontouchend' in document) return 'ios'; // iPad reports as Macintosh
    if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
    if (/Macintosh/.test(ua)) return app ? 'macapp' : 'mac';
    if (app) return 'windowsapp'; // the desktop app on Windows/Linux: no browser to cast a tab
    return 'desktop'; // Chrome/Edge on Windows or Linux
  }

  const CHROME_CAST = 'the browser menu (<b>⋮</b>) → <b>Cast, save and share</b> → <b>Cast…</b> (in Edge, <b>Settings and more (⋯)</b> → <b>Cast media to device</b>), then pick your TV; under <b>Sources</b> choose <b>Cast tab</b>';
  const STEPS = {
    android: { name: 'Android phone or tablet', items: [
      'Open quick settings (swipe down from the top with two fingers).',
      'Tap <b>Screen cast</b> (or <b>Smart View</b> on Samsung, <b>Cast</b> on some phones).',
      'Pick your TV or Chromecast.'
    ], note: 'If you do not see it, add the Screen cast tile from the quick-settings edit screen.' },
    desktop: { name: 'Chrome or Edge (Windows, Linux)', items: [
      'For a Chromecast or cast-ready TV: open ' + CHROME_CAST + '.',
      'For a Miracast / wireless display: press <b>Win+K</b> (or open quick settings → <b>Cast</b>) and pick the display.'
    ], note: 'Both need the TV or display on the same Wi-Fi.' },
    windowsapp: { name: 'This app on Windows', items: [
      'Press <b>Win+K</b> (or open quick settings → <b>Cast</b>).',
      'Pick your wireless display or Miracast-ready TV.'
    ], note: 'To cast to a Chromecast, open GenGIS in Chrome or Edge instead, then use ' + CHROME_CAST + '.' },
    mac: { name: 'Mac (Chrome or Edge)', items: [
      'For an AirPlay TV or Apple TV: open <b>Control Center</b> → <b>Screen Mirroring</b>, then pick the screen.',
      'For a Chromecast: open ' + CHROME_CAST + '.'
    ] },
    macapp: { name: 'This app on Mac', items: [
      'Open <b>Control Center</b> → <b>Screen Mirroring</b>, then pick your Apple TV or AirPlay-ready TV.'
    ], note: 'To cast to a Chromecast, open GenGIS in Chrome or Edge instead, then use ' + CHROME_CAST + '.' },
    ios: { name: 'iPhone or iPad', items: [
      'Open <b>Control Center</b> (swipe down from the top-right corner, or up from the bottom on an iPhone with a Home button).',
      'Tap <b>Screen Mirroring</b>.',
      'Pick your Apple TV or an AirPlay-ready TV.'
    ], note: 'A Chromecast needs the Google Home app to mirror the screen on iPhone and iPad.' }
  };
  const ORDER = ['android', 'desktop', 'windowsapp', 'mac', 'macapp', 'ios'];

  MB.cast = {
    dlg: null,
    open() {
      if (!this.dlg) this.build();
      this.render(platform());
      MB.ui.openDialog(this.dlg);
    },
    build() {
      const dlg = this.dlg = document.createElement('div');
      dlg.id = 'castDialog'; dlg.className = 'modal hidden';
      dlg.innerHTML = `<div class="modal-box cast-box" role="dialog" aria-modal="true" aria-labelledby="castTitle">
        ${MB.modalCloseHtml}<h2 id="castTitle">Cast to a screen</h2>
        <p class="note">Mirror this screen on a TV or projector, then start presenter mode so only the map, its layers and the GenGIS logo show.</p>
        <div class="cast-actions"><button type="button" class="btn primary" data-act="present">Start presenter mode</button></div>
        <div class="field"><label class="field-label" for="castWhich">Your device</label>
          <select id="castWhich">${ORDER.map(k => `<option value="${k}">${esc(STEPS[k].name)}</option>`).join('')}</select></div>
        <div class="cast-steps"></div>
      </div>`;
      document.body.appendChild(dlg);
      MB.ui.wireDialog(dlg);
      dlg.querySelector('[data-act="present"]').addEventListener('click', () => {
        MB.ui.closeDialog(dlg);
        MB.presenter.enter();
        if (MB.presenter.toggleFullscreen && !MB.presenter.isFull()) MB.presenter.toggleFullscreen();
      });
      dlg.querySelector('#castWhich').addEventListener('change', e => this.renderSteps(e.target.value));
    },
    render(which) {
      this.dlg.querySelector('#castWhich').value = which;
      this.renderSteps(which);
    },
    renderSteps(which) {
      const s = STEPS[which] || STEPS.desktop, box = this.dlg.querySelector('.cast-steps');
      box.innerHTML = `<ol class="cast-list">${s.items.map(i => `<li>${i}</li>`).join('')}</ol>` +
        (s.note ? `<p class="note cast-tip">${s.note}</p>` : '');
    }
  };
})(window.MB);
