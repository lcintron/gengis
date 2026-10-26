/* GenGIS - signing in to a cloud account from the web app (OAuth 2.0 authorization code with PKCE, RFC 7636).
 * - no server and no client secret: the page asks the provider for a code (a full-page redirect, which works in an
 *   installed app and on phones where pop-ups do not), and trades it for tokens itself
 * - what the redirect must carry across (the PKCE verifier, the state) waits in localStorage for a few minutes: an
 *   installed app on a phone can come back in a new page, which still finds it
 * - the code arrives once in the address, is checked against the state and removed from the address at once
 * Provider details (endpoints, client id, scopes) come from the provider modules (cloud-onedrive.js). Tokens are kept
 * by cloudsync.js, never here, never in a project and never in the address.
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const PENDING = 'gengis.oauth.pending';
  const PENDING_MAX_AGE = 10 * 60 * 1000; // a sign-in left unfinished longer than this is forgotten

  const b64url = bytes => btoa(String.fromCharCode.apply(null, Array.from(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const random = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); };

  // The PKCE pair: a random verifier, and its SHA-256 as the challenge.
  async function challenge(verifier) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return b64url(new Uint8Array(hash));
  }

  // The claims of an id token (not verified: it came straight from the provider's token endpoint over TLS, and is
  // used only to show who is signed in).
  function idClaims(idToken) {
    try {
      const part = String(idToken).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(Array.from(atob(part.padEnd(part.length + (4 - part.length % 4) % 4, '=')), c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
      return JSON.parse(json);
    } catch (e) { return {}; }
  }

  function readPending() {
    try {
      const p = JSON.parse(localStorage.getItem(PENDING) || 'null');
      if (p && Date.now() - p.at < PENDING_MAX_AGE) return p;
    } catch (e) { /* none */ }
    return null;
  }

  // The address the provider sends the code back to: this page, without its parameters or "index.html" (registered as
  // is: "https://site/" serves the same page as "https://site/index.html").
  const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/i, '');
  const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  MB.oauth = {
    challenge, idClaims, random, redirectUri,

    // The provider's sign-in page for cfg ({ authorize, clientId, scopes, extra }), with a new state and verifier.
    // Resolves { url, pending } without going there (begin() goes).
    async prepare(cfg, info) {
      const verifier = random(48), state = random(24);
      // (the page's own parameters, ?lat=… or ?q=…, come back with it)
      const pending = Object.assign({ state, verifier, provider: cfg.provider, redirectUri: cfg.redirectUri || redirectUri(), search: typeof location !== 'undefined' ? location.search : '', at: Date.now() }, info || {});
      const q = new URLSearchParams(Object.assign({
        client_id: cfg.clientId, response_type: 'code', redirect_uri: pending.redirectUri, scope: cfg.scopes.join(' '),
        state, code_challenge: await challenge(verifier), code_challenge_method: 'S256'
      }, cfg.extra || {}));
      return { url: cfg.authorize + '?' + q.toString(), pending };
    },

    // Go to the provider's sign-in page; the page comes back with ?code=&state= (see take()).
    async begin(cfg, info, go) {
      const { url, pending } = await MB.oauth.prepare(cfg, info);
      try { localStorage.setItem(PENDING, JSON.stringify(pending)); } catch (e) { throw new Error('this browser keeps no storage for the sign-in'); }
      (go || (u => location.assign(u)))(url);
    },

    // At start-up, before anything reads the address: a sign-in coming back. Removes its parameters from the address
    // and resolves nothing itself: returns { pending, code } or { pending, error } for cloudsync to finish, or null.
    take(search) {
      const params = new URLSearchParams(search == null ? location.search : search);
      if (!params.has('state') || !(params.has('code') || params.has('error'))) return null;
      const out = { code: params.get('code'), error: params.get('error'), description: params.get('error_description') || '', state: params.get('state') };
      ['code', 'state', 'error', 'error_description', 'error_uri', 'session_state', 'client_info', 'iss', 'scope', 'authuser', 'prompt', 'hd']
        .forEach(k => params.delete(k));
      if (search == null) {
        const rest = params.toString();
        try { history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch (e) { /* ignore */ }
      }
      const pending = readPending();
      try { localStorage.removeItem(PENDING); } catch (e) { /* ignore */ }
      if (!pending) return { pending: null, error: 'no_pending', description: ios() ? 'Sign-in did not come back to the app it started in. On iPhone and iPad, connect from Safari (not the Home Screen app).' : 'This sign-in was not started in this browser (or took too long). Connect again.' };
      if (pending.state !== out.state) return { pending: null, error: 'state_mismatch', description: 'The sign-in answer did not match the request. Connect again.' };
      // the page's own parameters, as they were when the sign-in started
      if (search == null && pending.search && !params.toString()) {
        try { history.replaceState(history.state, '', location.pathname + pending.search + location.hash); } catch (e) { /* ignore */ }
      }
      return out.error ? { pending, error: out.error, description: out.description } : { pending, code: out.code };
    },

    // Trade the code for tokens at cfg.token. Resolves the provider's answer ({ access_token, refresh_token,
    // expires_in, id_token, ... }) or throws an Error carrying .code and .description.
    exchange(cfg, code, pending, fetchFn) {
      return post(cfg, { grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier, client_id: cfg.clientId, scope: cfg.scopes.join(' ') }, fetchFn);
    },

    // A new access token from a refresh token (a provider may send a new refresh token too: keep that one).
    refresh(cfg, refreshToken, fetchFn) {
      return post(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: cfg.clientId, scope: cfg.scopes.join(' ') }, fetchFn);
    }
  };

  async function post(cfg, body, fetchFn) {
    let res;
    try {
      res = await (fetchFn || fetch)(cfg.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
    } catch (e) { const err = new Error('offline'); err.code = 'network'; throw err; }
    let json = {};
    try { json = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok || !json.access_token) {
      const err = new Error(json.error_description || json.error || ('HTTP ' + res.status));
      err.code = json.error || ('http_' + res.status);
      err.description = json.error_description || '';
      err.status = res.status;
      throw err;
    }
    return json;
  }
})(window.MB);
