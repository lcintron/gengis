/* A fake Microsoft (sign-in + Graph) for trying cloud sync in a browser on localhost, without an Entra app.
 * Never deployed (tests/ is excluded from the site). In the page's console:
 *   await import('/tests/browser/fake-microsoft.js'); await window.fakeMicrosoft.signIn();
 * Then: fakeMicrosoft.remote(fileId, text) edits a file "on another device"; fakeMicrosoft.fail = (method, url) => Response
 * injects failures; fakeMicrosoft.expire() ends the sign-in. */
const F = window.fakeMicrosoft = { files: new Map(), seq: 0, ids: 0, calls: [], fail: null, expired: false };
const json = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const etag = f => '"{' + f.id + '},' + f.v + '"';
const item = f => ({ id: f.id, name: f.name, eTag: etag(f), size: f.text.length, lastModifiedDateTime: new Date(f.mod).toISOString(), file: {} });
const touch = f => { f.v++; f.mod = Date.now(); f.seq = ++F.seq; };
const byName = n => [...F.files.values()].find(f => !f.deleted && f.name.toLowerCase() === n.toLowerCase());
const idToken = () => 'x.' + btoa(JSON.stringify({ oid: 'u1', tid: 'contoso', name: 'Pat Example', preferred_username: 'pat@contoso.com' })).replace(/=+$/, '') + '.s';
F.fetch = async (url, o = {}) => {
  url = String(url);
  const m = (o.method || 'GET').toUpperCase();
  F.calls.push(m + ' ' + url.replace('https://graph.microsoft.com/v1.0', ''));
  if (F.fail) { const r = F.fail(m, url); if (r) return r; }
  if (url.includes('/oauth2/v2.0/token')) {
    if (F.expired) return json(400, { error: 'invalid_grant', error_description: 'AADSTS700084: The refresh token was issued to a single page app (SPA), and therefore has a fixed, limited lifetime of 1.00:00:00' });
    return json(200, { access_token: 'at' + Math.random(), refresh_token: 'rt' + Math.random(), expires_in: 3600, id_token: idToken() });
  }
  if (!url.startsWith('https://graph.microsoft.com/')) return fetch(url, o);
  if (F.expired) return json(401, { error: { code: 'InvalidAuthenticationToken' } });
  const u = new URL(url), p = decodeURIComponent(u.pathname.replace('/v1.0', '')), im = o.headers && o.headers['If-Match'];
  let r;
  if (p.endsWith('/approot/delta')) {
    const from = +(u.searchParams.get('token') || 0);
    return json(200, { value: [...F.files.values()].filter(f => f.seq > from).map(f => (f.deleted ? { id: f.id, deleted: {} } : item(f))), '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/drive/special/approot/delta?token=' + F.seq });
  }
  if (p.endsWith('/approot/children')) return json(200, { value: [...F.files.values()].filter(f => !f.deleted).map(item) });
  if ((r = /approot:\/(.+):\/content$/.exec(p)) && m === 'PUT') {
    if (byName(r[1])) return json(409, { error: { code: 'nameAlreadyExists' } });
    const f = { id: 'F' + (++F.ids), name: r[1], text: await new Response(o.body).text(), v: 0 };
    F.files.set(f.id, f); touch(f);
    return json(201, item(f));
  }
  if ((r = /\/items\/([^/]+)\/content$/.exec(p))) {
    const f = F.files.get(r[1]);
    if (!f || f.deleted) return json(404, { error: { code: 'itemNotFound' } });
    if (m === 'GET') return new Response(f.text);
    if (im && im !== etag(f)) return json(412, { error: { code: 'resourceModified' } });
    f.text = await new Response(o.body).text(); touch(f);
    return json(200, item(f));
  }
  if ((r = /\/items\/([^/]+)$/.exec(p))) {
    const f = F.files.get(r[1]);
    if (!f || f.deleted) return json(404, { error: { code: 'itemNotFound' } });
    if (m === 'PATCH') { const b = JSON.parse(o.body), other = byName(b.name); if (other && other !== f) return json(409, { error: { code: 'nameAlreadyExists' } }); f.name = b.name; touch(f); }
    if (m === 'DELETE') { f.deleted = true; touch(f); return json(204, null); }
    return json(200, item(f));
  }
  return json(400, { error: { code: 'unexpected', message: m + ' ' + p } });
};
F.remote = (id, text) => { const f = F.files.get(id); f.text = text; touch(f); };
F.add = (name, text) => { const f = { id: 'F' + (++F.ids), name, text, v: 0 }; F.files.set(f.id, f); touch(f); return f; };
F.expire = () => { F.expired = true; };
// The sign-in round trip, with the provider's page skipped.
F.signIn = async () => {
  F.expired = false;
  MB.cloud.env.fetch = F.fetch;
  MB.cloud.env.go = () => {};
  await MB.cloud.connect('onedrive');
  const pending = JSON.parse(localStorage.getItem('gengis.oauth.pending'));
  history.replaceState(null, '', location.pathname + '?code=FAKE&state=' + pending.state);
  MB.cloud.takeRedirect();
  await MB.cloud.init();
};
MB.cloud.env.fetch = F.fetch;
export default F;
