/* GenGIS - running as the Android app (Capacitor): what a phone app does differently from the web page.
 * - HTTP through Android itself (CapacitorHttp) for the data sources a web page may not read: the ADS-B networks
 *   (no CORS headers) and receivers on the local network over plain HTTP. MB.getText is used for those everywhere:
 *   in the web app and the desktop app it is plain fetch.
 * - saving a file (project, GeoJSON, an exported image or PDF): written to the app's cache and handed to Android's
 *   share sheet (Save to Files, Drive, email...), since a download link does nothing in an app
 * - the back button: closes what is open (a dialog, the menu, the side panel, presenter mode, a selection) before
 *   leaving the app
 * Elsewhere this module only defines MB.getText. Nothing here is bundled: Capacitor's own bridge provides
 * window.Capacitor and its plugins in the app. */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const cap = window.Capacitor;
  const app = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  const plugin = name => (app && cap.Plugins && cap.Plugins[name]) || null;
  MB.native = { app, platform: app && cap.getPlatform ? cap.getPlatform() : 'web' };
  if (app) document.documentElement.classList.add('native-app');

  // A GET answered as text: { ok, status, text }. In the app, Android's own HTTP (a failure is a TypeError and a
  // timeout an AbortError, as with fetch); elsewhere fetch, not cached.
  MB.getText = async function (url, timeout) {
    const http = plugin('CapacitorHttp');
    if (http) {
      let r;
      try {
        r = await http.request({ url, method: 'GET', headers: { Accept: 'application/json, text/plain, */*' }, connectTimeout: timeout, readTimeout: timeout, responseType: 'text' });
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/time ?out|timed out/i.test(msg)) { const t = new Error(msg); t.name = 'AbortError'; throw t; }
        throw new TypeError(msg);
      }
      const text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text };
    }
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
      return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : '' };
    } finally { clearTimeout(timer); }
  };

  if (!app) return;

  /* ---------- saving files: the share sheet ---------- */
  const fsys = plugin('Filesystem'), share = plugin('Share');
  if (fsys && share) {
    const asBase64 = blob => new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1] || '');
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(blob);
    });
    MB.download = async function (filename, text, mime) {
      try {
        const blob = text instanceof Blob ? text : new Blob([text], { type: mime || 'application/json' });
        const out = await fsys.writeFile({ path: filename, data: await asBase64(blob), directory: 'CACHE' });
        await share.share({ title: filename, url: out.uri, dialogTitle: filename });
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (!/cancel/i.test(msg)) MB.toast('Could not save "' + filename + '": ' + msg, 6000);
      }
    };
  }

  /* ---------- the back button ---------- */
  const appPlugin = plugin('App');
  if (appPlugin) appPlugin.addListener('backButton', () => {
    const shown = el => el && !el.classList.contains('hidden') && el.getClientRects().length;
    const dialogs = Array.from(document.querySelectorAll('.modal')).filter(shown);
    if (dialogs.length) {
      const top = dialogs[dialogs.length - 1], x = top.querySelector('.modal-x, [data-act="close"]');
      if (x) x.click(); else top.classList.add('hidden');
      return;
    }
    if (shown(document.getElementById('moreMenu')) && MB.ui && MB.ui.closeMore) { MB.ui.closeMore(); return; }
    if (shown(document.getElementById('menu'))) { document.getElementById('menu').classList.add('hidden'); return; }
    if (MB.presenter && MB.presenter.active) { MB.presenter.exit(); return; }
    const sheet = document.getElementById('sidebar'), close = document.getElementById('sheetClose');
    if (sheet && !sheet.classList.contains('collapsed') && shown(close)) { close.click(); return; }
    if (MB.selected && MB.deselect) { MB.deselect(); return; }
    appPlugin.minimizeApp(); // the map stays as it is for the next time
  });
})(window.MB);
