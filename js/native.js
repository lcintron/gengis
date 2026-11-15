/* GenGIS - running as the Android app (Capacitor): what a phone app does differently from the web page.
 * - HTTP through Android itself (CapacitorHttp) for the data sources a web page may not read: the ADS-B networks
 *   (no CORS headers) and receivers on the local network over plain HTTP. MB.getText is used for those everywhere:
 *   in the web app and the desktop app it is plain fetch.
 * - saving a file (project, GeoJSON, an exported image or PDF): written to the app's cache and handed to Android's
 *   share sheet (Save to Files, Drive, email...), since a download link does nothing in an app
 * - picking a file: an accept naming anything but images (.gengis, the shapefile parts, the Betaflight logs, map
 *   sources) is dropped, since Android's picker greys out every file it has no matching MIME type for; the image
 *   picker keeps its filter
 * - the back button: closes what is open (a dialog, the menu, the side panel, presenter mode, a selection) before
 *   leaving the app
 * - cloud sync's sign-in, kept by the app (MB.native.cloud: android-src/CloudPlugin.java)
 * Elsewhere this module only defines MB.getText. Nothing here is bundled: Capacitor's own bridge provides
 * window.Capacitor and its plugins in the app (GenGISCloud is GenGIS's own, added by scripts/android-prepare.js). */
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
    // true once the share sheet has taken the file; false when it was cancelled or could not be written (said then),
    // so that the page only reports "saved" after the sheet answers.
    MB.download = async function (filename, text, mime) {
      try {
        const blob = text instanceof Blob ? text : new Blob([text], { type: mime || 'application/json' });
        const out = await fsys.writeFile({ path: filename, data: await asBase64(blob), directory: 'CACHE' });
        await share.share({ title: filename, url: out.uri, dialogTitle: filename });
        return true;
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (!/cancel/i.test(msg)) MB.toast('Could not save "' + filename + '": ' + msg, 6000);
        return false;
      }
    };
  }

  /* ---------- picking files: Android's own picker ----------
   * Capacitor's bridge turns an <input accept> into MIME types and leaves out the extensions Android does not know
   * (.gengis, .shp, .dbf, .prj, .cpg, .shx, .bbl, .bfl, .kml, .geojson…), so the picker greys those files out. Such
   * an accept is dropped before the picker opens, and the opener checks the file it is given by its name and its
   * content anyway. Only the image picker keeps its filter: its list is MIME types and the image extensions Android
   * maps to those same types, so nothing is lost in the crossing. A picker for other kinds (map sources: .xml, .zip)
   * drops it, since a file's type there is Android's guess as well — a zip is as often application/x-zip-compressed
   * or application/octet-stream — and a filter would grey it out. (capture, which asks Android for a camera or a
   * microphone instead of a file, is not touched: GenGIS has no such input.) */
  const ANDROID_EXT = /^\.(svg|png|jpe?g|webp|gif|bmp)$/i; // the image extensions Android maps to a MIME type itself
  const MIME = /^[\w.+-]+\/[\w.*+-]+$/;
  const keepsFilter = a => a.split(',').map(s => s.trim()).filter(Boolean).every(t => (t[0] === '.' ? ANDROID_EXT.test(t) : MIME.test(t)));
  const dropAccept = el => {
    if (!el || el.tagName !== 'INPUT' || el.type !== 'file' || !el.hasAttribute('accept')) return;
    if (!keepsFilter(el.getAttribute('accept') || '')) el.removeAttribute('accept');
  };
  const Input = window.HTMLInputElement;
  if (Input && Input.prototype && Input.prototype.click) {
    const click = Input.prototype.click;
    Input.prototype.click = function () { dropAccept(this); return click.apply(this, arguments); }; // the openers click their input themselves
  }
  document.addEventListener('click', e => { // and a label opens the input it is for
    const el = e.target && e.target.closest ? e.target.closest('input[type="file"], label') : null;
    if (!el) return;
    if (el.tagName === 'INPUT') dropAccept(el);
    else dropAccept(el.htmlFor ? document.getElementById(el.htmlFor) : el.querySelector('input[type="file"]'));
  }, true);

  /* ---------- cloud sync: the app's own sign-in (android-src/CloudPlugin.java) ----------
   * The desktop app's bridge (window.gengisDesktop.cloud), the same calls: OneDrive signs in in a browser tab that
   * comes back to the app, its refresh token kept encrypted by Android's keystore; Google Drive signs in with
   * Android's own account picker, and Google keeps the sign-in. The page only gets access tokens, for an hour. Its
   * requests are the web app's (fetch: the cloud APIs answer CORS for the app's https://localhost). */
  const cloud = plugin('GenGISCloud');
  if (cloud) {
    const ask = (method, o) => cloud[method](o).catch(e => ({ error: 'failed', message: String((e && e.message) || e) }));
    MB.native.cloud = {
      providers: ['onedrive', 'gdrive'],
      signIn: (provider, hint) => ask('signIn', { provider, hint: hint || '' }),
      token: accountId => ask('token', { accountId }),
      signOut: accountId => ask('signOut', { accountId })
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
