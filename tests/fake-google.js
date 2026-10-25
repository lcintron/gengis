// A fake Google (Drive API v3, the token endpoint and userinfo), in memory, with fault injection: what js/cloud-gdrive.js
// talks to. Only what GenGIS uses, as Drive answers it (versions as strings, trashed files, a change feed of page tokens).
'use strict';
const crypto = require('crypto');

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SESSION = 'https://www.googleapis.com/upload/session/';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const FOLDER = 'application/vnd.google-apps.folder';
const CHUNK_UNIT = 256 * 1024;

class Res {
  constructor(status, body, headers) { this.status = status; this.ok = status >= 200 && status < 300; this._body = body; const h = new Map(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v])); this.headers = { get: k => (h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null) }; }
  async json() { if (Buffer.isBuffer(this._body)) return JSON.parse(this._body.toString('utf8')); if (typeof this._body === 'string') return JSON.parse(this._body); return this._body; }
  async text() { if (Buffer.isBuffer(this._body)) return this._body.toString('utf8'); return typeof this._body === 'string' ? this._body : JSON.stringify(this._body); }
}
const json = (status, body, headers) => new Res(status, body, headers);
const gerr = (status, reason, message) => json(status, { error: { code: status, message: message || reason, errors: [{ reason, message: message || reason }] } });

function makeGoogle(opts) {
  opts = opts || {};
  const S = {
    files: new Map(),     // id -> { id, name, mimeType, parents, content, version, modified, created, trashed, appProperties }
    log: [],              // { seq, id }
    seq: 1, ids: 0,
    tokens: new Map(),    // access token -> expires (ms)
    refresh: new Map(),
    revoked: [],
    calls: [],
    sessions: new Map(),
    fail: null,           // (req) => Res | 'network' | null
    latency: opts.latency || 0,
    pageSize: opts.pageSize || 50,
    now: () => Date.now(),
    user: { sub: 'g-user-1', email: 'test@gmail.com', name: 'Test G' },
    chunkSizes: [],
    lagFolders: 0         // folder listings that still miss a folder just made (Drive's search index lags a moment)
  };
  const touch = f => { f.version++; f.modified = S.now() + (S.ids++); S.log.push({ seq: ++S.seq, id: f.id }); };
  const meta = f => ({ id: f.id, name: f.name, mimeType: f.mimeType, version: String(f.version), modifiedTime: new Date(f.modified).toISOString(), createdTime: new Date(f.created).toISOString(), size: f.mimeType === FOLDER ? undefined : String(f.content.length), trashed: !!f.trashed, parents: f.parents.slice() });
  S.add = (name, content, o) => {
    o = o || {};
    const f = { id: 'G' + (++S.ids) + crypto.randomBytes(2).toString('hex'), name, mimeType: o.mimeType || 'application/json', parents: o.parents || ['myDrive'], content: Buffer.from(content || ''), version: 0, modified: S.now(), created: S.now() + S.ids, trashed: false, appProperties: o.appProperties || {} };
    S.files.set(f.id, f); touch(f); return f;
  };
  S.folders = () => [...S.files.values()].filter(f => f.mimeType === FOLDER && f.appProperties.gengis === 'root' && !f.trashed);
  S.inFolder = id => [...S.files.values()].filter(f => !f.trashed && f.parents.includes(id) && f.mimeType !== FOLDER);
  S.byName = name => { const fo = S.folders()[0]; return fo && S.inFolder(fo.id).find(f => f.name === name); };
  // another device or the user, in Drive
  S.writeRemote = (id, content) => { const f = S.files.get(id); f.content = Buffer.from(content); touch(f); return f; };
  S.trash = id => { const f = S.files.get(id); f.trashed = true; touch(f); };
  S.trashFolder = () => { for (const fo of S.folders()) { S.trash(fo.id); S.inFolder(fo.id).forEach(f => S.trash(f.id)); } };
  S.purge = id => { S.files.delete(id); S.log.push({ seq: ++S.seq, id, removed: true }); };
  S.issue = () => { const t = 'ya29.' + crypto.randomBytes(8).toString('hex'); S.tokens.set(t, S.now() + 3600 * 1000); return t; };
  S.expireAccessTokens = () => { for (const k of S.tokens.keys()) S.tokens.set(k, 0); };

  // A Drive query, as far as GenGIS writes them.
  function matches(f, q) {
    if (/trashed=false/.test(q) && f.trashed) return false;
    if (/mimeType='application\/vnd\.google-apps\.folder'/.test(q) && f.mimeType !== FOLDER) return false;
    if (/mimeType!='application\/vnd\.google-apps\.folder'/.test(q) && f.mimeType === FOLDER) return false;
    if (/appProperties has \{ key='gengis' and value='root' \}/.test(q) && f.appProperties.gengis !== 'root') return false;
    let m;
    if ((m = /'([^']+)' in parents/.exec(q)) && !f.parents.includes(m[1])) return false;
    if ((m = /name='((?:[^'\\]|\\.)*)'/.exec(q)) && f.name !== m[1].replace(/\\(.)/g, '$1')) return false;
    return true;
  }
  function multipart(body, type) {
    const boundary = /boundary=([^;]+)/.exec(type)[1], text = Buffer.from(body).toString('utf8');
    const parts = text.split('--' + boundary).slice(1, -1).map(p => p.replace(/^\r\n/, '').replace(/\r\n$/, ''));
    const [h1, ...m1] = parts[0].split('\r\n\r\n'), [h2, ...c2] = parts[1].split('\r\n\r\n');
    if (!/application\/json/.test(h1) || !h2) throw new Error('bad multipart');
    return { meta: JSON.parse(m1.join('\r\n\r\n')), content: Buffer.from(c2.join('\r\n\r\n')) };
  }
  function create(m, content) {
    m.parents = m.parents || ['myDrive']; // (none given: My Drive)
    if (!m.parents || !m.parents.every(p => p === 'myDrive' || (S.files.has(p) && !S.files.get(p).trashed))) return gerr(404, 'notFound', 'File not found: ' + (m.parents || []).join());
    return json(200, meta(S.add(m.name, content, { mimeType: m.mimeType, parents: m.parents, appProperties: m.appProperties })));
  }

  async function handle(url, o) {
    o = o || {};
    const method = (o.method || 'GET').toUpperCase(), h = o.headers || {};
    S.calls.push({ method, url });
    if (S.latency) await new Promise(r => setTimeout(r, S.latency));
    if (S.fail) { const f = S.fail({ method, url, headers: h }); if (f === 'network') throw new TypeError('Failed to fetch'); if (f) return f; }
    if (url.startsWith(REVOKE)) { S.revoked.push(new URL(url).searchParams.get('token')); return json(200, {}); }
    const auth = (h.Authorization || '').replace(/^Bearer /, '');
    if (!S.tokens.has(auth) || S.tokens.get(auth) < S.now()) return json(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } });
    if (url === USERINFO) return json(200, S.user);
    const u = new URL(url);
    let m;
    // ---- resumable session chunks
    if (url.startsWith(SESSION)) {
      const s = S.sessions.get(url.slice(SESSION.length));
      if (!s) return gerr(404, 'notFound');
      const r = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(h['Content-Range'] || '');
      if (!r) return gerr(400, 'badRange');
      const [a, b, total] = [+r[1], +r[2], +r[3]], body = Buffer.from(o.body);
      if (a !== s.received || body.length !== b - a + 1) return gerr(400, 'badRange', 'expected ' + s.received);
      if (b + 1 < total && body.length % CHUNK_UNIT) return gerr(400, 'badRange', 'chunk not a multiple of 256 KiB');
      S.chunkSizes.push(body.length);
      s.parts.push(body); s.received = b + 1;
      if (s.received < total) return new Res(308, '', { Range: 'bytes=0-' + b });
      S.sessions.delete(url.slice(SESSION.length));
      const content = Buffer.concat(s.parts);
      if (s.fileId) { const f = S.files.get(s.fileId); if (!f) return gerr(404, 'notFound'); f.content = content; touch(f); return json(200, meta(f)); }
      return create(s.meta, content);
    }
    if (url.startsWith(UPLOAD)) {
      const type = u.searchParams.get('uploadType');
      m = /^\/upload\/drive\/v3\/files(?:\/([^/?]+))?$/.exec(u.pathname);
      if (!m) return gerr(400, 'badRequest');
      const id = m[1] && decodeURIComponent(m[1]);
      if (id && (!S.files.has(id) || S.files.get(id).trashed)) return gerr(404, 'notFound', 'File not found: ' + id);
      if (type === 'resumable') {
        const sid = 'U' + (++S.ids);
        S.sessions.set(sid, { fileId: id || null, meta: id ? null : JSON.parse(o.body), parts: [], received: 0 });
        return json(200, null, { Location: SESSION + sid });
      }
      if (type === 'multipart' && !id) { const p = multipart(o.body, h['Content-Type']); return create(p.meta, p.content); }
      if (type === 'media' && id) { const f = S.files.get(id); f.content = Buffer.from(o.body); touch(f); return json(200, meta(f)); }
      return gerr(400, 'badRequest', 'upload ' + type);
    }
    if (!url.startsWith(API)) return json(404, 'not here');
    const p = u.pathname.replace('/drive/v3', '');
    if (p === '/files' && method === 'GET') {
      const q = u.searchParams.get('q') || '', page = +(u.searchParams.get('pageToken') || 0);
      let all = [...S.files.values()].filter(f => matches(f, q)).sort((a, b) => a.id.localeCompare(b.id));
      if (S.lagFolders > 0 && /appProperties has/.test(q)) { S.lagFolders--; all = []; }
      const out = { files: all.slice(page * S.pageSize, (page + 1) * S.pageSize).map(meta) };
      if ((page + 1) * S.pageSize < all.length) out.nextPageToken = String(page + 1);
      return json(200, out);
    }
    if (p === '/files' && method === 'POST') return create(JSON.parse(o.body), '');
    if (p === '/changes/startPageToken') return json(200, { startPageToken: String(S.seq) });
    if (p === '/changes') {
      const token = +u.searchParams.get('pageToken');
      if (!(token >= 1) || token > S.seq + 1) return gerr(400, 'invalid', 'Invalid page token');
      const upTo = S.seq, size = +(u.searchParams.get('pageSize') || 100);
      const entries = S.log.filter(e => e.seq > token && e.seq <= upTo), slice = entries.slice(0, Math.min(size, S.pageSize));
      const changes = [...new Set(slice.map(e => e.id))].map(id => { const f = S.files.get(id); return f ? { fileId: id, removed: false, file: meta(f) } : { fileId: id, removed: true }; });
      const out = { changes };
      if (entries.length > slice.length) out.nextPageToken = String(slice[slice.length - 1].seq);
      else out.newStartPageToken = String(upTo);
      return json(200, out);
    }
    if ((m = /^\/files\/([^/]+)$/.exec(p))) {
      const f = S.files.get(decodeURIComponent(m[1]));
      if (!f) return gerr(404, 'notFound', 'File not found: ' + m[1]);
      if (method === 'GET') return u.searchParams.get('alt') === 'media' ? new Res(200, Buffer.from(f.content)) : json(200, meta(f));
      if (method === 'PATCH') { const b = JSON.parse(o.body); if (b.name) f.name = b.name; touch(f); return json(200, meta(f)); }
      if (method === 'DELETE') { S.purge(f.id); return json(204, null); }
    }
    return gerr(400, 'badRequest', method + ' ' + p);
  }
  S.fetch = (url, o) => handle(String(url), o);
  return S;
}

module.exports = { makeGoogle, API, UPLOAD, TOKEN, USERINFO, CHUNK_UNIT, FOLDER };
