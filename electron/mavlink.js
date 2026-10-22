/* GenGIS desktop app - MAVLink links for live drones (js/mavlink.js). A web page cannot open TCP or UDP, so the
 * page names the link (TCP to a server, UDP to a server, or UDP listening here), a host and a port; this side opens
 * it and passes on the bytes that arrive. Receive only: the page cannot send anything through it. The one thing ever
 * sent is, over UDP to a server, a keepalive built here (keepalive()), so the server keeps sending to this address.
 * One link per window; it closes when the window reloads, navigates or closes. */
const { ipcMain } = require('electron');
const net = require('net');
const dgram = require('dgram');
const { trusted } = require('./files');

const KINDS = ['tcp', 'udp', 'listen'];
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const FLUSH_MS = 40;            // bytes are passed on in batches, not a message per datagram
const MAX_PENDING = 4 << 20;    // bytes held for a page that is not keeping up: older ones are dropped
const CONNECT_TIMEOUT = 10000;  // ms for a TCP connection to open
const KEEPALIVE_MS = 1000;      // UDP to a server: how often it is reminded of this address

const links = new Map();        // webContents id -> the open link
const watched = new WeakSet();  // windows whose reload and close end their link

// MAVLink 2 HEARTBEAT from system 254, component 25 (MAV_COMP_ID_USER1): type MAV_TYPE_GENERIC, autopilot
// MAV_AUTOPILOT_INVALID. Not a ground station's (MAV_TYPE_GCS), so no vehicle counts on it for a link-loss failsafe,
// and not an autopilot's, so no ground station shows it as a vehicle. It asks nothing of anyone.
let seq = 0;
function keepalive() {
  const f = Buffer.alloc(21);
  f.set([0xFD, 9, 0, 0, seq = (seq + 1) & 0xff, 254, 25, 0, 0, 0], 0);
  f.set([0, 0, 0, 0, 0, 8, 0, 0, 3], 10); // custom_mode u32, type, autopilot, base_mode, system_status, mavlink_version
  let crc = 0xffff;
  const acc = b => { let t = (b ^ crc) & 0xff; t = (t ^ (t << 4)) & 0xff; crc = ((crc >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 0xffff; };
  for (let i = 1; i < 19; i++) acc(f[i]);
  acc(50); // HEARTBEAT's CRC extra
  f.writeUInt16LE(crc, 19);
  return f;
}

function validate(o) {
  if (!o || typeof o !== 'object') return 'bad request';
  const { token, kind, host, port } = o;
  if (!Number.isSafeInteger(token) || token < 1) return 'bad request';
  if (!KINDS.includes(kind)) return 'Unknown connection type';
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'The port must be between 1 and 65535';
  if (typeof host !== 'string' || !host) return 'Enter an address';
  if (kind === 'listen' ? !net.isIP(host) : !(net.isIP(host) || HOSTNAME.test(host))) return 'That is not a valid address';
  return null;
}

function close(id, only) {
  const link = links.get(id);
  if (!link || (only && link !== only)) return;
  links.delete(id);
  link.closed = true;
  clearTimeout(link.flushTimer); clearInterval(link.keepTimer);
  try { if (link.sock.destroy) link.sock.destroy(); else link.sock.close(); } catch (e) { /* closed already */ }
}

function open(sender, { token, kind, host, port }) {
  close(sender.id); // one link per window
  const link = { token, sender, sock: null, closed: false, chunks: [], size: 0, flushTimer: null, keepTimer: null };
  links.set(sender.id, link);
  const send = (channel, ...args) => { if (!link.closed && !sender.isDestroyed()) sender.send(channel, token, ...args); };
  const flush = () => {
    link.flushTimer = null;
    if (!link.size) return;
    const bytes = link.chunks.length === 1 ? link.chunks[0] : Buffer.concat(link.chunks, link.size);
    link.chunks = []; link.size = 0;
    send('mavlink:data', bytes);
  };
  const data = buf => {
    if (link.closed) return;
    link.chunks.push(buf); link.size += buf.length;
    while (link.size > MAX_PENDING && link.chunks.length > 1) link.size -= link.chunks.shift().length;
    if (!link.flushTimer) link.flushTimer = setTimeout(flush, FLUSH_MS);
  };
  const ended = code => { if (link.closed) return; send('mavlink:status', { state: 'closed', code: String(code || 'CLOSED') }); close(sender.id, link); };

  if (kind === 'tcp') {
    const sock = link.sock = net.connect({ host, port });
    sock.setTimeout(CONNECT_TIMEOUT, () => sock.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    sock.on('connect', () => { sock.setTimeout(0); sock.setNoDelay(true); send('mavlink:status', { state: 'open' }); });
    sock.on('data', data);
    sock.on('error', err => ended(err.code));
    sock.on('close', () => ended('CLOSED'));
    return;
  }
  const family = net.isIPv6(host) ? 'udp6' : 'udp4';
  const sock = link.sock = dgram.createSocket({ type: family });
  sock.on('message', data);
  sock.on('error', err => ended(err.code));
  sock.on('close', () => ended('CLOSED'));
  if (kind === 'listen') {
    sock.on('listening', () => send('mavlink:status', { state: 'open' }));
    sock.bind(port, host);
    return;
  }
  // UDP to a server: connected to it (only its datagrams are taken), and reminded of this address every second
  sock.connect(port, host, () => {
    if (link.closed) return;
    send('mavlink:status', { state: 'open' });
    const ping = () => { if (!link.closed) sock.send(keepalive(), () => {}); };
    ping();
    link.keepTimer = setInterval(ping, KEEPALIVE_MS);
  });
}

function register() {
  ipcMain.handle('mavlink:open', (e, o) => {
    if (!trusted(e)) throw new Error('not allowed from this page');
    const bad = validate(o);
    if (bad) return { error: bad };
    const wc = e.sender;
    if (!watched.has(wc)) {
      watched.add(wc);
      wc.on('did-start-navigation', d => { if (d.isMainFrame && !d.isSameDocument) close(wc.id); }); // a reload too
      wc.once('destroyed', () => close(wc.id));
    }
    try { open(wc, o); } catch (err) { close(wc.id); return { error: err.message || 'Could not open the connection' }; }
    return { ok: true };
  });
  ipcMain.on('mavlink:close', (e, token) => {
    if (!trusted(e)) return;
    const link = links.get(e.sender.id);
    if (link && link.token === token) close(e.sender.id);
  });
}

module.exports = { register, keepalive, validate };
