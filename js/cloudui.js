/* GenGIS - cloud sync, what the user sees (cloudsync.js does the work):
 * - Project → Cloud sync…: the accounts (connect, sign in again, disconnect, sync all named projects), each project's
 *   state and where it syncs, a conflict's three choices, and every project in each account's cloud folder: open any
 *   of them, or delete one from the cloud (to the provider's recycle bin; a copy on this device stays, sync off)
 * - a cloud beside the save status: the open project's sync state; a click opens the dialog, and a conflict or an
 *   expired sign-in adds a button there
 * - Settings → Project: one line with the account and the open project's state
 * Nothing shows until a provider is offered (cloud-onedrive.js or cloud-gdrive.js has a client id).
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = s => MB.escapeHtml(String(s == null ? '' : s));
  const C = () => MB.cloud;
  // short words for each state (an icon's tooltip; a problem also shows them as a chip)
  const LABEL = { synced: 'Synced', pending: 'Waiting to sync', syncing: 'Syncing…', offline: 'Offline · syncs when back online', conflict: 'Edited in two places', error: 'Not synced', signin: 'Signed out' };
  const PROBLEM = { conflict: 1, error: 1, signin: 1 };
  const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = svg('<path d="M7 18h10.5a4.5 4.5 0 0 0 .6-8.96A6 6 0 0 0 6.3 9.5 4.25 4.25 0 0 0 7 18z"/>');
  const I = {
    synced: svg('<path d="M7 18h10.5a4.5 4.5 0 0 0 .6-8.96A6 6 0 0 0 6.3 9.5 4.25 4.25 0 0 0 7 18z"/><path d="M9.5 13l2 2 3.5-3.5"/>'),
    syncing: svg('<path d="M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>'),
    pending: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/>'),
    offline: svg('<path d="M7 18h10.5a4.5 4.5 0 0 0 1.7-.3M20.5 13.5a4.5 4.5 0 0 0-2.4-4.46A6 6 0 0 0 9 5.6M6.3 9.5A4.25 4.25 0 0 0 7 18"/><path d="M3 3l18 18"/>'),
    conflict: svg('<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v.5"/>'),
    error: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.5"/>'),
    signin: svg('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'),
    off: svg('<path d="M7 18h10.5a4.5 4.5 0 0 0 .6-8.96A6 6 0 0 0 6.3 9.5 4.25 4.25 0 0 0 7 18z" stroke-dasharray="2.5 2.5"/>'),
    file: svg('<path d="M6 3h8l4 4v14H6z M14 3v4h4"/>')
  };
  // A provider's own mark, in its own colors (never restyled: css .cloud-logo takes the dialog's line style off it).
  // No ids in them: one can be drawn several times in the dialog.
  const logoSvg = (box, d) => `<svg class="cloud-logo" viewBox="${box}" aria-hidden="true">${d}</svg>`;
  const LOGO = {
    onedrive: logoSvg('0 0 32 32',
      '<path fill="#0364b8" d="M12.20245,11.19292l.00031-.0011,6.71765,4.02379,4.00293-1.68451.00018.00068A6.4768,6.4768,0,0,1,25.5,13c.14764,0,.29358.0067.43878.01639a10.00075,10.00075,0,0,0-18.041-3.01381C7.932,10.00215,7.9657,10,8,10A7.96073,7.96073,0,0,1,12.20245,11.19292Z"/>' +
      '<path fill="#0078d4" d="M12.20276,11.19182l-.00031.0011A7.96073,7.96073,0,0,0,8,10c-.0343,0-.06805.00215-.10223.00258A7.99676,7.99676,0,0,0,1.43732,22.57277l5.924-2.49292,2.63342-1.10819,5.86353-2.46746,3.06213-1.28859Z"/>' +
      '<path fill="#1490df" d="M25.93878,13.01639C25.79358,13.0067,25.64764,13,25.5,13a6.4768,6.4768,0,0,0-2.57648.53178l-.00018-.00068-4.00293,1.68451,1.16077.69528L23.88611,18.19l1.66009.99438,5.67633,3.40007a6.5002,6.5002,0,0,0-5.28375-9.56805Z"/>' +
      '<path fill="#28a8ea" d="M25.5462,19.18437l-1.66009-.99438-3.80505-2.2791-1.16077-.69528L15.85828,16.5042,9.99475,18.97166,7.36133,20.07985l-5.924,2.49292A7.98889,7.98889,0,0,0,8,26H25.5a6.49837,6.49837,0,0,0,5.72253-3.41556Z"/>'),
    gdrive: logoSvg('0 0 87.3 78',
      '<path fill="#0066da" d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z"/>' +
      '<path fill="#00ac47" d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z"/>' +
      '<path fill="#ea4335" d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z"/>' +
      '<path fill="#00832d" d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z"/>' +
      '<path fill="#2684fc" d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"/>' +
      '<path fill="#ffba00" d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"/>')
  };
  // (an own key only: a provider id is never a name on Object.prototype's side)
  const logo = id => (Object.prototype.hasOwnProperty.call(LOGO, id) ? LOGO[id] : '');
  const when = ts => { if (!ts) return ''; const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'now' : (m < 60 ? m + ' min' : (m < 1440 ? Math.round(m / 60) + ' h' : new Date(ts).toLocaleDateString())); };
  const size = n => (!n ? '' : (n < 1024 ? n + ' B' : (n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB')));
  const provName = id => ((MB.cloudProviders || {})[id] || {}).name || id;
  const accLabel = a => a ? provName(a.provider) + (a.email ? ' (' + a.email + ')' : '') : '';
  const tip = text => `<span class="ds-info" tabindex="0" role="img" aria-label="${esc(text)}">i</span><span class="ds-tip" role="tooltip">${esc(text)}</span>`;
  const iconBtn = (attr, icon, title) => `<button type="button" class="icon-btn mini" ${attr} title="${esc(title)}" aria-label="${esc(title)}">${icon}</button>`;
  const toggle = (attr, on, label, disabled) => `<label class="mb-switch" title="${esc(label)}"><input type="checkbox" role="switch" ${attr}${on ? ' checked' : ''}${disabled ? ' disabled' : ''} aria-label="${esc(label)}"><span aria-hidden="true"></span></label>`;

  const U = MB.cloudUI = {};
  let dlg = null, renderTimer = null;
  const remote = {}; // accountId -> { files, loading, error, seq }: the account's cloud folder as last listed
  const busy = {};   // fileId -> 'open' | 'delete' while that is under way (kept here: every render rebuilds the rows)
  // projectId -> true from the choice made until the resolve settles: its three choices stay disabled through the
  // redraws meanwhile (the resolve flushes the project, and that save draws the rows again)
  const resolving = {};

  /* ---------- the dialog ---------- */
  U.open = function () {
    if (MB.ui.commitName) MB.ui.commitName(); // a name typed in the top bar and not left yet is the project's name here too
    if (!dlg) {
      dlg = document.createElement('div');
      dlg.id = 'cloudDialog'; dlg.className = 'modal hidden';
      dlg.innerHTML = '<div class="modal-box cloud-box" role="dialog" aria-modal="true" aria-labelledby="cloudTitle"></div>';
      document.body.appendChild(dlg);
      MB.ui.wireDialog(dlg);
    }
    query = '';
    preload(C().offered());
    U.render();
    MB.ui.openDialog(dlg);
    // the pending save, so the rows read the record as it is now; not awaited before showing (claiming the lock
    // can take up to 5 s)
    MB.projects.flush().then(() => { if (isOpen()) U.render(); }).catch(() => { /* the rows show the live name anyway */ });
    C().pull(false);
    loadAll();
  };
  const isOpen = () => dlg && !dlg.classList.contains('hidden');
  // A render a moment from now: several events landing together (a save, a sync) are one redraw.
  const renderSoon = () => { if (isOpen()) { clearTimeout(renderTimer); renderTimer = setTimeout(U.render, 150); } };
  // A provider that signs in in a pop-up loads its sign-in beforehand (a pop-up opened after a wait is blocked).
  const preload = ids => ids.forEach(id => { const p = MB.cloudProviders[id]; if (p && p.preload) p.preload(); });

  // The projects in an account's cloud folder, listed again (the last list stays shown meanwhile; an answer overtaken
  // by a newer request is dropped).
  async function loadRemote(accId) {
    const seq = ((remote[accId] && remote[accId].seq) || 0) + 1;
    remote[accId] = Object.assign({}, remote[accId], { loading: true, error: '', seq });
    if (isOpen()) U.render();
    let out;
    try { out = { files: await C().listCloud(accId), loading: false }; }
    catch (e) { out = { loading: false, error: e.code === 'network' ? 'offline' : (e.message || 'error') }; }
    if (!remote[accId] || remote[accId].seq !== seq) return;
    remote[accId] = Object.assign({}, remote[accId], out);
    if (isOpen()) U.render();
  }
  const loadAll = () => C().accounts.filter(a => a.state !== 'signin').forEach(a => loadRemote(a.id));

  U.render = async function () {
    if (!dlg) return;
    const box = dlg.querySelector('.modal-box'), c = C();
    const offered = c.offered(), accs = c.accounts;
    const list = accs.length ? await MB.projects.list() : [];
    // The open project as it is now: its record was last written a save ago, so a name just typed in the top bar
    // is not in it yet and the row would still offer to name it. Only this tab's own project, the one it saves.
    const live = MB.projects.owns() ? list.findIndex(r => r.id === MB.state.projectId) : -1;
    if (live >= 0) list[live] = Object.assign({}, list[live], { name: MB.state.projectName, fileBacked: !!MB.projects.fileBacked });
    const active = document.activeElement && box.contains(document.activeElement) ? document.activeElement : null;
    if (active && active.tagName === 'SELECT') { clearTimeout(renderTimer); renderTimer = setTimeout(U.render, 600); return; } // a list being chosen from: after
    const focusKey = active ? active.dataset.key : null, scroll = box.scrollTop;
    let html = `${MB.modalCloseHtml}<div class="cloud-head"><span class="cloud-head-ic">${ICON}</span><h2 id="cloudTitle">Cloud sync</h2>
        ${tip('Your named projects in your own cloud storage, on all your devices. They stay saved here too and work offline. No GenGIS server; API keys never leave this device.')}</div>
      ${c.lastError ? `<div class="cloud-error" role="alert">${I.error}<span>${esc(c.lastError)}</span>${iconBtn('data-act="dismiss"', MB.ICON.close, 'Dismiss')}</div>` : ''}`;
    offered.forEach(pid => {
      const p = MB.cloudProviders[pid], mine = accs.filter(a => a.provider === pid);
      if (!mine.length) {
        html += `<button type="button" class="cloud-connect" data-connect="${esc(pid)}" data-key="c-${esc(pid)}">${logo(pid) || ICON}<span><b>Connect ${esc(p.name)}</b><small>Personal or work account</small></span></button>`;
        return;
      }
      mine.forEach(a => {
        const initial = (a.name || a.email || '?').trim().charAt(0).toUpperCase();
        html += `<div class="cloud-acc${a.state === 'signin' ? ' out' : ''}">
          <span class="cloud-avatar" aria-hidden="true">${esc(initial)}${logo(a.provider)}</span>
          <div class="cloud-acc-main"><b>${esc(a.name || a.email)}</b><small>${esc(p.name)} · ${a.kind === 'personal' ? 'Personal' : 'Work or school'}</small>${a.pullError && a.state !== 'signin' ? `<small class="cloud-warn" title="${esc(a.pullError)}">${I.error} Can't check for changes</small>` : ''}</div>
          ${a.state === 'signin' ? `<button type="button" class="btn small primary with-icon" data-signin="${esc(a.id)}" data-key="s-${esc(a.id)}" title="${esc(a.error || 'Signed out')}">${MB.ICON.signin}Sign in</button>` : iconBtn('data-act="syncnow" data-key="sync"', MB.ICON.refresh, 'Sync now')}
          ${iconBtn(`data-disconnect="${esc(a.id)}" data-key="d-${esc(a.id)}"`, MB.ICON.logout, 'Disconnect')}
        </div>${accs.length === 1 ? `
        <div class="cloud-auto"><span>Sync all projects</span>${tip('Named projects sync automatically. Switch one off below to keep it on this device only.')}${toggle(`data-auto="${esc(a.id)}" data-key="a-${esc(a.id)}"`, a.auto, 'Sync all projects')}</div>` : ''}`;
      });
    });
    // more than one account: "sync all" goes to one of them (or none), so it is one choice, not a switch per account
    if (accs.length > 1) {
      const auto = accs.find(a => a.auto);
      html += `<div class="cloud-auto"><span>Sync all projects to</span>${tip('Named projects without their own choice below sync to this account. Off: only the projects you choose.')}
        <select data-autoto data-key="autoto" aria-label="Sync all projects to"><option value="">Off</option>${accs.map(a => `<option value="${esc(a.id)}"${auto && auto.id === a.id ? ' selected' : ''}>${esc(provName(a.provider))} · ${esc(a.email || a.name)}</option>`).join('')}</select></div>`;
    }
    if (accs.length) {
      const rmFiles = accs.reduce((n, a) => n + ((remote[a.id] && remote[a.id].files) || []).length, 0);
      const searchable = list.length + rmFiles > SEARCH_FROM;
      if (!searchable) query = ''; // (no search box: no row stays hidden by a search no longer shown)
      html += `<div class="cloud-h-row"><h3 class="cloud-h">Projects <span class="dim">${list.length}</span></h3>${searchable
        ? `<div class="search-wrap">${SEARCH_ICON}<input class="search-input" type="text" inputmode="search" enterkeyhint="search" data-search data-key="search" placeholder="Search projects" aria-label="Search projects" spellcheck="false" value="${esc(query)}">${CLEAR_BTN}</div>` : ''}</div>
        <div class="cloud-sec"><div class="cloud-list cloud-scroll" data-list="projects">${list.length ? sortRows(list).map(r => projectRow(r, accs)).join('') : '<p class="note">Nothing here yet.</p>'}</div>
        <p class="note cloud-nomatch" hidden>No project matches.</p></div>`;
      const byId = new Map(list.map(r => [r.id, r]));
      accs.forEach(a => { if (a.state !== 'signin') html += remoteSection(a, accs, byId); });
    }
    // what the user was doing survives the refresh: the scroll of each list, the field typed in and its caret
    const lists = {};
    box.querySelectorAll('[data-list]').forEach(l => { lists[l.dataset.list] = l.scrollTop; });
    const caret = active && active.tagName === 'INPUT' ? [active.selectionStart, active.selectionEnd] : null;
    box.innerHTML = html;
    box.querySelectorAll('[data-list]').forEach(l => { if (lists[l.dataset.list]) l.scrollTop = lists[l.dataset.list]; });
    box.scrollTop = scroll;
    bind(box);
    filter(box);
    if (focusKey) {
      const el = box.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      if (el) { el.focus(); if (caret && el.setSelectionRange) try { el.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text field */ } }
    }
  };

  // Many projects: what needs the user first (a conflict, an error, signed out), then the open project, then the rest as
  // they were last saved; a search narrows the lists (it stays while they refresh).
  const SEARCH_FROM = 6;
  // (the top bar's search box, the same look: index.html)
  const SEARCH_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" class="search-icon" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16.5 16.5L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const CLEAR_BTN = '<button type="button" class="search-clear" data-search-clear hidden aria-label="Clear search" title="Clear"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>';
  let query = '';
  const URGENT = { conflict: 0, error: 1, signin: 2 };
  function sortRows(list) {
    const rank = r => { const st = C().status(r.id); return st in URGENT ? URGENT[st] : (r.id === MB.state.projectId ? 3 : 4); };
    return list.map((r, i) => [rank(r), i, r]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);
  }
  function filter(box) {
    const q = query.trim().toLowerCase();
    box.querySelectorAll('.cloud-sec').forEach(sec => {
      let shown = 0;
      sec.querySelectorAll('.cloud-row[data-name]').forEach(row => { const hit = !q || row.dataset.name.includes(q); row.hidden = !hit; if (hit) shown++; });
      const none = !!q && !shown;
      if (sec.hasAttribute('data-remote')) sec.hidden = none && !sec.querySelector('.note'); // (one saying loading, offline... stays, with its Check again)
      else { const nm = sec.querySelector('.cloud-nomatch'); if (nm) nm.hidden = !none; }
    });
  }

  function projectRow(r, accs) {
    const c = C(), l = c.links[r.id], st = c.status(r.id), draft = MB.projects.isDraft(r), prog = c.progress[r.id];
    const accId = l && !l.excluded ? (l.accountId || '') : (l && l.excluded ? '' : ((accs.find(a => a.auto) || {}).id || ''));
    const on = !!accId, state = draft ? 'off' : (st || (on ? 'pending' : 'off'));
    const label = draft ? 'Name it to sync' : (prog ? 'Uploading ' + Math.round(100 * prog.done / prog.total) + '%' : (on ? LABEL[state] || state : 'This device only'));
    const sub = draft ? esc(label) : (PROBLEM[state] ? `<span class="cloud-chip ${esc(state)}">${esc(LABEL[state])}</span>` : esc(prog ? label : (state === 'synced' && l && l.syncedAt ? when(l.syncedAt) : (on ? label : ''))));
    const where = accs.length > 1
      ? `<select data-sync="${esc(r.id)}" data-key="p-${esc(r.id)}" aria-label="Sync ${esc(r.name)} to"${draft ? ' disabled' : ''}><option value="">Off</option>${accs.map(a => `<option value="${esc(a.id)}"${accId === a.id ? ' selected' : ''}>${esc(provName(a.provider))} · ${esc(a.email)}</option>`).join('')}</select>`
      : toggle(`data-sync="${esc(r.id)}" data-acc="${esc(accs[0].id)}" data-key="p-${esc(r.id)}"`, on, 'Sync ' + r.name, draft);
    const off = resolving[r.id] ? ' disabled' : ''; // the choice is being carried out: not a second time
    const conflict = state === 'conflict' ? `<div class="cloud-conflict" role="group" aria-label="Choose which version to keep">
        <button type="button" class="btn small primary with-icon" data-resolve="both" data-id="${esc(r.id)}" title="Keep this version, and save the cloud version as a separate project"${off}>${MB.ICON.copy}Keep both</button>
        <button type="button" class="btn small with-icon" data-resolve="cloud" data-id="${esc(r.id)}" title="Replace this version with the cloud version (this one is kept in Recent projects → earlier copies)"${off}>${MB.ICON.cloudDown}Use cloud</button>
        <button type="button" class="btn small with-icon" data-resolve="mine" data-id="${esc(r.id)}" title="Replace the cloud version with this one (the cloud keeps the old one in its version history)"${off}>${MB.ICON.cloudUp}Use mine</button></div>` : '';
    const why = l && l.error && state === 'error' ? l.error : label;
    return `<div class="cloud-row${r.id === MB.state.projectId ? ' current' : ''}${on ? '' : ' off'}" data-name="${esc(String(r.name || '').toLowerCase())}">
        <span class="cloud-st ${esc(state)}" role="img" aria-label="${esc(why)}" title="${esc(why)}">${I[state] || I.off}</span>
        <div class="cloud-main"><b>${esc(r.name)}</b><small>${sub}</small></div>${where}${conflict}</div>`;
  }

  // An account's cloud folder: every project in it, whether on this device or not, to open or to delete from the cloud.
  const fileTitle = f => f.name.replace(/\.gengis\.json$|\.json$/i, '');
  const linkTo = (accId, fileId) => Object.values(C().links).find(l => l.accountId === accId && l.fileId === fileId);
  function remoteSection(a, accs, byId) {
    const p = provName(a.provider), rm = remote[a.id] || { loading: true }, files = rm.files || [];
    const note = rm.error === 'offline' ? `Offline. The projects in ${p} show when you are back online.`
      : (rm.error ? `Could not list the projects in ${p}.` : (!rm.files ? (rm.loading ? 'Loading…' : '') : (files.length ? '' : `No projects in ${p} yet.`)));
    return `<div class="cloud-sec" data-remote><div class="cloud-h-row"><h3 class="cloud-h">In ${esc(p)}${accs.length > 1 ? ' · ' + esc(a.email || a.name) : ''} <span class="dim">${rm.files ? files.length : ''}</span></h3>
        ${MB.iconBtn('refresh', 'Check again', `data-reload="${esc(a.id)}" data-key="r-${esc(a.id)}"`, rm.loading ? 'spin' : '', 'Check ' + p + ' again')}</div>
      ${note ? `<p class="note"${rm.error && rm.error !== 'offline' ? ` title="${esc(rm.error)}"` : ''}>${esc(note)}</p>` : ''}
      ${files.length ? `<div class="cloud-list cloud-scroll" data-list="r-${esc(a.id)}">${files.map(f => remoteRow(a, f, byId)).join('')}</div>` : ''}</div>`;
  }
  function remoteRow(a, f, byId) {
    const p = provName(a.provider), name = fileTitle(f), l = linkTo(a.id, f.fileId), rec = l && byId.get(l.projectId);
    const here = !!rec, current = here && rec.id === MB.state.projectId, b = busy[f.fileId], off = b ? ' disabled' : '';
    const info = [when(f.modified), size(f.size), here ? (l.excluded ? 'On this device · sync off' : 'On this device') : 'Not on this device'].filter(Boolean).join(' · ');
    const ids = `data-acc="${esc(a.id)}" data-file="${esc(f.fileId)}"`;
    return `<div class="cloud-row${current ? ' current' : ''}" data-name="${esc(name.toLowerCase())}">
        <span class="cloud-st">${I.file}</span><div class="cloud-main"><b title="${esc(name)}">${esc(name)}</b><small>${esc(info)}</small></div>
        ${current ? '<span class="badge">open</span>' : MB.iconBtn('open', 'Open', `data-openremote ${ids} data-key="o-${esc(f.fileId)}"${off}`, b === 'open' ? 'loading' : '', 'Open ' + name)}
        ${MB.iconBtn('trash', 'Delete from ' + p, `data-delremote ${ids} data-key="x-${esc(f.fileId)}"${off}`, 'danger', 'Delete ' + name + ' from ' + p)}</div>`;
  }

  async function openRemote(accId, fileId) {
    const l = linkTo(accId, fileId);
    // here already: the dialog closes once it is open, so an open the user calls off (what is open now cannot be
    // kept) leaves them where they were, with the dialog still up
    if (l && await MB.projects.get(l.projectId)) { if (await MB.projects.open(l.projectId)) MB.ui.closeDialog(dlg); return; }
    if (busy[fileId]) return;
    busy[fileId] = 'open'; U.render();
    let ok = false;
    try { ok = await C().openRemote(accId, fileId); }
    catch (e) { console.warn('Cloud sync: opening', e); MB.toast('Could not open it: ' + (e.message || e), 6000); }
    finally { delete busy[fileId]; }
    if (ok) MB.ui.closeDialog(dlg); else if (isOpen()) U.render();
  }

  const rowButton = (accId, fileId, sel) => dlg.querySelector(`${sel || ''}[data-acc="${CSS.escape(accId)}"][data-file="${CSS.escape(fileId)}"]`);
  // A row whose buttons are disabled (a delete under way) cannot take the focus back after the render, and it would
  // fall to the page behind the dialog: the dialog's close button holds it until the row's turn comes again.
  function holdFocus() {
    if (!isOpen() || dlg.contains(document.activeElement)) return;
    const el = dlg.querySelector('.modal-x');
    if (el) el.focus();
  }
  async function deleteRemote(accId, fileId) {
    const a = C().accounts.find(x => x.id === accId), f = a && ((remote[accId] || {}).files || []).find(x => x.fileId === fileId);
    if (!f || busy[fileId]) return;
    busy[fileId] = 'delete'; // (before the question: a second click asks nothing more)
    const p = MB.cloudProviders[a.provider], name = fileTitle(f);
    let gone = false, at = -1;
    try {
      const l = linkTo(accId, fileId), here = !!(l && await MB.projects.get(l.projectId));
      const conflict = here && !l.excluded && (l.state === 'conflict' || (l.remoteEtag && l.remoteEtag !== l.etag));
      const msg = 'Delete "' + name + '" from ' + accLabel(a) + '?\n\n' + p.bin + '\n\n' +
        (here ? 'The copy on this device is kept and stops syncing.' + (conflict ? ' The cloud version has changes that are not on this device.' : '') : 'It is not on this device.') +
        ' Other devices that have it keep their copy.';
      if (await MB.ask(msg, 'Delete from ' + p.name, 'Cancel', { danger: true })) {
        await U.render(); // the row's buttons go quiet while it is deleted: the focus would fall out of the dialog
        holdFocus();
        await C().deleteRemote(accId, fileId);
        gone = true;
        const rm = remote[accId] || {}, files = rm.files || [];
        at = files.findIndex(x => x.fileId === fileId);
        // (a listing already under way may still hold it: its answer is dropped)
        remote[accId] = Object.assign({}, rm, { files: files.filter(x => x.fileId !== fileId), loading: false, seq: (rm.seq || 0) + 1 });
        MB.toast('Deleted "' + name + '" from ' + p.name + '.' + (here ? ' Kept on this device, sync off.' : ''), 5000);
      }
    } catch (e) {
      MB.toast('Could not delete "' + name + '" from ' + p.name + ': ' + (e.code === 'network' ? 'you are offline' : (e.message || 'error')) + '.', 6000);
    } finally { delete busy[fileId]; }
    if (!isOpen()) return;
    await U.render();
    // the focus stays in the list: on the next row (its Open, else its Delete), else the one before, else Check again
    const left = (remote[accId] || {}).files || [], near = gone ? left[at] || left[at - 1] : f;
    const el = near ? rowButton(accId, near.fileId, gone ? '' : '[data-delremote]') : dlg.querySelector(`[data-reload="${CSS.escape(accId)}"]`);
    if (el) el.focus();
  }

  const connect = (pid, acc) => C().connect(pid, acc).catch(e => MB.toast('Could not start the sign-in: ' + (e.message || e), 6000));

  function bind(box) {
    const on = (sel, fn) => box.querySelectorAll(sel).forEach(el => el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'click', () => fn(el)));
    on('[data-connect]', b => connect(b.dataset.connect));
    on('[data-signin]', b => { const a = C().accounts.find(x => x.id === b.dataset.signin); connect(a.provider, a); });
    on('[data-disconnect]', async b => {
      const a = C().accounts.find(x => x.id === b.dataset.disconnect);
      if (await MB.ask('Disconnect ' + accLabel(a) + '?\n\nNothing is deleted: files stay in ' + provName(a.provider) + ', projects stay here.', 'Disconnect', 'Cancel', { yesIcon: 'logout' })) C().disconnect(a.id);
    });
    on('[data-auto]', cb => C().setAuto(cb.dataset.auto, cb.checked));
    on('[data-autoto]', sel => {
      const was = C().accounts.find(a => a.auto);
      if (sel.value) C().setAuto(sel.value, true); else if (was) C().setAuto(was.id, false);
    });
    on('[data-sync]', el => C().setSync(el.dataset.sync, el.type === 'checkbox' ? (el.checked ? el.dataset.acc : null) : (el.value || null)));
    on('[data-resolve]', b => {
      const id = b.dataset.id;
      if (resolving[id]) return;
      resolving[id] = true; // (a redraw while it runs keeps them disabled; the DOM's own are for right now)
      box.querySelectorAll(`[data-resolve][data-id="${CSS.escape(id)}"]`).forEach(x => { x.disabled = true; });
      const done = () => { delete resolving[id]; renderSoon(); };
      Promise.resolve(C().resolve(id, b.dataset.resolve)).then(done, done); // settled either way: the row says what came of it
    });
    on('[data-act="syncnow"]', b => { b.disabled = true; b.classList.add('spin'); C().syncNow().finally(() => { U.render(); loadAll(); }); });
    on('[data-reload]', b => loadRemote(b.dataset.reload));
    on('[data-act="dismiss"]', () => { C().lastError = ''; U.render(); });
    const search = box.querySelector('[data-search]');
    if (search) {
      const clear = box.querySelector('[data-search-clear]'), showClear = () => { clear.hidden = !search.value; };
      showClear();
      search.addEventListener('input', () => { query = search.value; filter(box); showClear(); });
      clear.addEventListener('click', () => { search.value = query = ''; filter(box); showClear(); search.focus(); });
      // Esc empties the search first (and only then closes the dialog)
      search.addEventListener('keydown', e => { if (e.key === 'Escape' && search.value) { e.preventDefault(); e.stopPropagation(); search.value = query = ''; filter(box); showClear(); } });
    }
    on('[data-openremote]', b => openRemote(b.dataset.acc, b.dataset.file));
    on('[data-delremote]', b => deleteRemote(b.dataset.acc, b.dataset.file));
  }

  /* ---------- the cloud beside the save status ---------- */
  function initStatus() {
    const save = document.getElementById('saveStatus');
    if (!save) return;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.id = 'cloudStatus'; btn.className = 'cloud-status'; btn.hidden = true;
    btn.innerHTML = ICON;
    const act = document.createElement('button');
    act.type = 'button'; act.id = 'cloudAction'; act.className = 'btn small file-resume with-icon'; act.hidden = true;
    save.insertAdjacentElement('afterend', btn);
    btn.insertAdjacentElement('afterend', act);
    btn.addEventListener('click', U.open);
    act.addEventListener('click', () => {
      const a = C().accountOf(MB.state.projectId);
      if (act.dataset.do === 'signin' && a) connect(a.provider, a); else U.open();
    });
    const paint = () => {
      const c = C(), st = c.ready && c.accounts.length ? c.status(MB.state.projectId) : null, a = c.accountOf(MB.state.projectId);
      btn.hidden = !st;
      if (st) {
        if (btn.dataset.state !== st) btn.innerHTML = I[st] || ICON;
        btn.dataset.state = st;
        const prog = c.progress[MB.state.projectId];
        const t = (prog ? 'Uploading ' + Math.round(100 * prog.done / prog.total) + '%' : LABEL[st] || st) + (a ? ' · ' + accLabel(a) : '') + (st === 'synced' && c.links[MB.state.projectId].syncedAt ? ' · ' + when(c.links[MB.state.projectId].syncedAt) : '');
        btn.title = t; btn.setAttribute('aria-label', 'Cloud: ' + t);
      }
      const need = st === 'conflict' ? 'conflict' : (st === 'signin' ? 'signin' : '');
      act.hidden = !need;
      // (its words and its icon are written only when what it is for changes: the icon is not rebuilt on every paint)
      if (act.dataset.do !== need || !act.innerHTML) act.innerHTML = MB.btnInner(need === 'conflict' ? 'warn' : 'signin', need === 'conflict' ? 'Resolve' : 'Sign in');
      act.dataset.do = need;
      act.title = need === 'conflict' ? 'Edited here and in the cloud: choose which to keep' : 'Signed out of the cloud: sign in to sync';
      renderSettings();
      preload([...new Set(c.accounts.map(x => x.provider))]); // (a connected account's "Sign in" button beside the save status)
      renderSoon();
    };
    MB.on('cloudsync', paint);
    MB.on('cloud-return', () => U.open());
    MB.on('project', paint);
    MB.on('saved', renderSoon); // the renamed project landed in the database: its row says so
    paint();
  }

  /* ---------- Settings → Project ---------- */
  function renderSettings() {
    const box = document.getElementById('cloudBox');
    if (!box) return;
    const c = C();
    if (!c.offered().length) { box.innerHTML = ''; return; }
    const st = c.status(MB.state.projectId), a = c.accountOf(MB.state.projectId) || c.accounts[0];
    const text = !c.accounts.length ? '<span class="dim">Cloud sync is off</span>'
      : esc(accLabel(a)) + (st ? ` <span class="cloud-chip ${esc(st)}">${esc(LABEL[st] || st)}</span>` : ' <span class="dim">· off for this project</span>');
    const html = `<div class="info-line cloud-line-set"><span class="file-ic cloud-ic">${ICON}</span><span class="file-name">${text}</span>
      ${MB.iconBtn('gear', 'Manage cloud sync', 'id="cloudOpenBtn"')}</div>`;
    if (box._html === html) return;
    box.innerHTML = html; box._html = html;
    box.querySelector('#cloudOpenBtn').addEventListener('click', U.open);
  }
  U.renderSettings = renderSettings;

  U.init = function () {
    if (!C().offered().length) return;
    document.querySelectorAll('[data-act="cloud"]').forEach(b => b.classList.remove('hidden'));
    initStatus();
    renderSettings();
  };
})(window.MB);
