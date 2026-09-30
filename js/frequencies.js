/* GenGIS - airport radio frequencies (tower, ground, ATIS, CTAF, approach, ...)
 * Source: OurAirports "airport-frequencies.csv" (public domain, republishes the FAA NASR frequency data
 * plus worldwide entries). The file is downloaded once, indexed by airport ident and kept in IndexedDB.
 * A cheap HEAD request compares the server's Last-Modified stamp at most every few hours; the cached copy
 * is replaced only when the source has actually changed.
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const URL_CSV = 'https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv';
  const META_KEY = 'ourairports-frequencies';
  const DATA_KEY = 'ourairports-frequencies|index';
  const CHECK_MS = 6 * 3600 * 1000;

  // Display order and labels for the OurAirports type codes.
  const TYPES = [
    ['ATIS', 'ATIS'], ['AWOS', 'AWOS'], ['ASOS', 'ASOS'], ['AWIB', 'AWIB'], ['CTAF', 'CTAF'], ['UNIC', 'UNICOM'], ['UNICOM', 'UNICOM'], ['MULTICOM', 'MULTICOM'],
    ['CLD', 'Clearance'], ['CLNC', 'Clearance'], ['GND', 'Ground'], ['TWR', 'Tower'], ['APP', 'Approach'], ['DEP', 'Departure'],
    ['CNTR', 'Center'], ['CTR', 'Center'], ['FSS', 'FSS'], ['RDO', 'Radio'], ['EMERG', 'Emergency'], ['MISC', 'Other']
  ];
  const ORDER = {}; TYPES.forEach(([code], i) => { ORDER[code] = i; });
  const LABEL = {}; TYPES.forEach(([code, label]) => { LABEL[code] = label; });

  MB.freqs = {
    index: null, meta: null, loading: null, readyCallbacks: [],

    onReady(cb) { if (this.index) cb(); else this.readyCallbacks.push(cb); },

    db() { return MB.data && MB.data.db; },

    // Make sure the index is available (from cache or download) and check for a newer release when due.
    async ensure() {
      if (this.index) { this.maybeCheck(); return this.index; }
      if (this.loading) return this.loading;
      this.loading = (async () => {
        try {
          const db = this.db();
          const meta = db ? await db.get('meta', META_KEY) : null;
          const rec = db ? await db.get('cells', DATA_KEY) : null;
          if (meta && rec && rec.geojson) { this.meta = meta; this.index = rec.geojson; }
          if (!this.index) await this.download(null);
          else this.maybeCheck();
        } catch (e) { console.warn('frequencies', e); }
        this.loading = null;
        if (this.index) { const cbs = this.readyCallbacks; this.readyCallbacks = []; cbs.forEach(cb => { try { cb(); } catch (e) { /* ignore */ } }); }
        MB.emit('data');
        return this.index;
      })();
      return this.loading;
    },

    // HEAD request: download only when the source's Last-Modified stamp differs from the cached one.
    async maybeCheck(force) {
      const now = Date.now();
      if (!force && this.meta && this.meta.checkedAt && now - this.meta.checkedAt < CHECK_MS) return false;
      if (this.checking) return false;
      this.checking = true;
      try {
        const r = await fetch(URL_CSV, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(15000) });
        const lm = r.headers.get('last-modified') || '';
        const len = r.headers.get('content-length') || '';
        const stamp = lm + '|' + len;
        if (this.meta && this.meta.stamp === stamp) {
          this.meta.checkedAt = now;
          await this.saveMeta();
          return false;
        }
        await this.download(stamp);
        return true;
      } catch (e) {
        if (this.meta) { this.meta.checkedAt = now - CHECK_MS + 30 * 60 * 1000; await this.saveMeta(); } // retry in 30 min
        return false;
      } finally { this.checking = false; }
    },

    async download(stamp) {
      const r = await fetch(URL_CSV, { cache: 'no-store', signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      const lm = r.headers.get('last-modified') || '';
      const len = r.headers.get('content-length') || String(text.length);
      const index = parseCsv(text);
      const count = Object.values(index).reduce((n, a) => n + a.length, 0);
      this.index = index;
      this.meta = { stamp: stamp || (lm + '|' + len), lastModified: lm, fetchedAt: Date.now(), checkedAt: Date.now(), count, airports: Object.keys(index).length };
      const db = this.db();
      if (db) { await db.set('cells', DATA_KEY, { ts: Date.now(), lastEdit: this.meta.stamp, geojson: index }); await this.saveMeta(); }
      MB.emit('data');
      const cbs = this.readyCallbacks; this.readyCallbacks = []; cbs.forEach(cb => { try { cb(); } catch (e) { /* ignore */ } });
    },

    async saveMeta() { const db = this.db(); if (db && this.meta) await db.set('meta', META_KEY, this.meta); },

    async clear() { this.index = null; this.meta = null; const db = this.db(); if (db) { await db.del('meta', META_KEY); await db.del('cells', DATA_KEY); } },

    // Candidate idents for an FAA airport record: ICAO code, then the FAA identifier, then K + identifier.
    idents(p) {
      const out = [];
      const icao = (p.ICAO_ID || '').trim().toUpperCase(), id = (p.IDENT || '').trim().toUpperCase();
      if (icao) out.push(icao);
      if (id) { out.push(id); if (/^[A-Z0-9]{3}$/.test(id) && !icao) out.push('K' + id); } // FAA identifiers without an ICAO code appear as K + id (KHPN, K1B1)
      return out;
    },

    lookup(p) {
      if (!this.index) return null;
      for (const id of this.idents(p)) { const rows = this.index[id]; if (rows && rows.length) return { ident: id, rows: sortRows(rows) }; }
      return { ident: this.idents(p)[0] || '', rows: [] };
    },

    hasTower(p) {
      const r = this.lookup(p);
      return !!(r && r.rows.some(x => x.type === 'TWR'));
    },

    // HTML block for the airport popup.
    popupHtml(p) {
      const r = this.lookup(p);
      const faaLink = p.IDENT ? `<a href="https://nfdc.faa.gov/nfdcApps/services/ajv5/airportDisplay.jsp?airportId=${encodeURIComponent(p.IDENT)}" target="_blank" rel="noopener">FAA airport data</a>` : '';
      const asOf = this.meta && this.meta.lastModified ? new Date(this.meta.lastModified).toLocaleDateString() : '';
      if (!r) return `<div class="mb-freqs"><div class="mb-popup-title">Frequencies</div><div class="dim">Not available (frequency data not loaded).</div></div>`;
      if (!r.rows.length) return `<div class="mb-freqs"><div class="mb-popup-title">Frequencies</div><div class="dim">No published frequencies for ${MB.escapeHtml(r.ident || 'this airport')}.</div><div class="mb-freq-foot">${faaLink}</div></div>`;
      const rows = r.rows.map(x => `<tr><td class="ft">${MB.escapeHtml(LABEL[x.type] || x.type)}</td><td class="fd">${MB.escapeHtml(x.desc || '')}</td><td class="fm">${x.mhz.toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0')}</td></tr>`).join('');
      return `<div class="mb-freqs"><div class="mb-popup-title">Frequencies <span class="dim">(${MB.escapeHtml(r.ident)})</span></div>
        <table class="mb-freq-table">${rows}</table>
        <div class="mb-freq-foot">${asOf ? 'Data as of ' + asOf + ' · ' : ''}OurAirports (FAA NASR). Informational; verify with current charts. ${faaLink}</div></div>`;
    },

    statusLine() {
      if (!this.meta) return this.loading ? 'Frequencies: downloading…' : 'Frequencies: loaded on first use';
      const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };
      return `Frequencies: ${this.meta.count.toLocaleString()} for ${this.meta.airports.toLocaleString()} airports` + (this.meta.lastModified ? ' · source updated ' + new Date(this.meta.lastModified).toLocaleDateString() : '') + (this.meta.checkedAt ? ' · checked ' + ago(this.meta.checkedAt) : '');
    }
  };

  function sortRows(rows) {
    return rows.slice().sort((a, b) => ((ORDER[a.type] ?? 99) - (ORDER[b.type] ?? 99)) || a.desc.localeCompare(b.desc) || a.mhz - b.mhz);
  }

  // Minimal RFC-4180 parser for the OurAirports file: id,airport_ref,airport_ident,type,description,frequency_mhz
  function parseCsv(text) {
    const index = {};
    let i = 0, n = text.length, row = [], field = '', inQ = false, headerDone = false, cols = null;
    const pushRow = () => {
      if (!headerDone) { cols = row; headerDone = true; row = []; return; }
      if (row.length >= 6) {
        const ident = row[2].toUpperCase(), type = row[3].toUpperCase(), desc = row[4], mhz = parseFloat(row[5]);
        if (ident && !isNaN(mhz)) (index[ident] = index[ident] || []).push({ type, desc, mhz });
      }
      row = [];
    };
    while (i < n) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; pushRow(); }
      else field += c;
      i++;
    }
    if (field.length || row.length) { row.push(field); pushRow(); }
    return index;
  }
})(window.MB);
