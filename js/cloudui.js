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
    logout: svg('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/>'),
    file: svg('<path d="M6 3h8l4 4v14H6z M14 3v4h4"/>')
  };
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

  /* ---------- the dialog ---------- */
  U.open = function () {
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
    C().pull(false);
    loadAll();
  };
  const isOpen = () => dlg && !dlg.classList.contains('hidden');
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
    const active = document.activeElement && box.contains(document.activeElement) ? document.activeElement : null;
    if (active && active.tagName === 'SELECT') { clearTimeout(renderTimer); renderTimer = setTimeout(U.render, 600); return; } // a list being chosen from: after
    const focusKey = active ? active.dataset.key : null, scroll = box.scrollTop;
    let html = `${MB.modalCloseHtml}<div class="cloud-head"><span class="cloud-head-ic">${ICON}</span><h2 id="cloudTitle">Cloud sync</h2>
        ${tip('Your named projects in your own cloud storage, on all your devices. They stay saved here too and work offline. No GenGIS server; API keys never leave this device.')}</div>
      ${c.lastError ? `<div class="cloud-error" role="alert">${I.error}<span>${esc(c.lastError)}</span>${iconBtn('data-act="dismiss"', MB.ICON.close, 'Dismiss')}</div>` : ''}`;
    offered.forEach(pid => {
      const p = MB.cloudProviders[pid], mine = accs.filter(a => a.provider === pid);
      if (!mine.length) {
        html += `<button type="button" class="cloud-connect" data-connect="${esc(pid)}" data-key="c-${esc(pid)}">${ICON}<span><b>Connect ${esc(p.name)}</b><small>Personal or work account</small></span></button>`;
        return;
      }
      mine.forEach(a => {
        const initial = (a.name || a.email || '?').trim().charAt(0).toUpperCase();
        html += `<div class="cloud-acc${a.state === 'signin' ? ' out' : ''}">
          <span class="cloud-avatar" aria-hidden="true">${esc(initial)}</span>
          <div class="cloud-acc-main"><b>${esc(a.name || a.email)}</b><small>${esc(p.name)} · ${a.kind === 'personal' ? 'Personal' : 'Work or school'}</small>${a.pullError && a.state !== 'signin' ? `<small class="cloud-warn" title="${esc(a.pullError)}">${I.error} Can't check for changes</small>` : ''}</div>
          ${a.state === 'signin' ? `<button type="button" class="btn small primary" data-signin="${esc(a.id)}" data-key="s-${esc(a.id)}" title="${esc(a.error || 'Signed out')}">Sign in</button>` : iconBtn('data-act="syncnow" data-key="sync"', MB.ICON.refresh, 'Sync now')}
          ${iconBtn(`data-disconnect="${esc(a.id)}" data-key="d-${esc(a.id)}"`, I.logout, 'Disconnect')}
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
      if (sec.hasAttribute('data-remote')) sec.hidden = none;
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
    const conflict = state === 'conflict' ? `<div class="cloud-conflict" role="group" aria-label="Choose which version to keep">
        <button type="button" class="btn small primary" data-resolve="both" data-id="${esc(r.id)}" title="Keep this version, and save the cloud version as a separate project">Keep both</button>
        <button type="button" class="btn small" data-resolve="cloud" data-id="${esc(r.id)}" title="Replace this version with the cloud version (this one is kept in Recent projects → earlier copies)">Use cloud</button>
        <button type="button" class="btn small" data-resolve="mine" data-id="${esc(r.id)}" title="Replace the cloud version with this one (the cloud keeps the old one in its version history)">Use mine</button></div>` : '';
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
        ${current ? '<span class="badge">open</span>' : MB.iconBtn('open', 'Open', `data-openremote ${ids} data-key="o-${esc(f.fileId)}"${off}`, b === 'open' ? 'spin' : '', 'Open ' + name)}
        ${MB.iconBtn('trash', 'Delete from ' + p, `data-delremote ${ids} data-key="x-${esc(f.fileId)}"${off}`, 'danger', 'Delete ' + name + ' from ' + p)}</div>`;
  }

  async function openRemote(accId, fileId) {
    const l = linkTo(accId, fileId);
    if (l && await MB.projects.get(l.projectId)) { MB.ui.closeDialog(dlg); await MB.projects.open(l.projectId); return; } // here already
    busy[fileId] = 'open'; U.render();
    let ok = false;
    try { ok = await C().openRemote(accId, fileId); } finally { delete busy[fileId]; }
    if (ok) MB.ui.closeDialog(dlg); else if (isOpen()) U.render();
  }

  async function deleteRemote(accId, fileId) {
    const a = C().accounts.find(x => x.id === accId), f = a && ((remote[accId] || {}).files || []).find(x => x.fileId === fileId);
    if (!f) return;
    const p = MB.cloudProviders[a.provider], name = fileTitle(f), l = linkTo(accId, fileId);
    const here = !!(l && await MB.projects.get(l.projectId));
    const conflict = here && !l.excluded && (l.state === 'conflict' || (l.remoteEtag && l.remoteEtag !== l.etag));
    const msg = 'Delete "' + name + '" from ' + accLabel(a) + '?\n\n' + p.bin + '\n\n' +
      (here ? 'The copy on this device is kept and stops syncing.' + (conflict ? ' The cloud version has changes that are not on this device.' : '') : 'It is not on this device.') +
      ' Other devices that have it keep their copy.';
    if (!(await MB.ask(msg, 'Delete from ' + p.name, 'Cancel', { danger: true }))) return;
    busy[fileId] = 'delete'; U.render();
    try {
      await C().deleteRemote(accId, fileId);
      const rm = remote[accId] || {};
      // (a listing already under way may still hold it: its answer is dropped)
      remote[accId] = Object.assign({}, rm, { files: (rm.files || []).filter(x => x.fileId !== fileId), loading: false, seq: (rm.seq || 0) + 1 });
      MB.toast('Deleted "' + name + '" from ' + p.name + '.' + (here ? ' Kept on this device, sync off.' : ''), 5000);
    } catch (e) {
      MB.toast('Could not delete "' + name + '" from ' + p.name + ': ' + (e.code === 'network' ? 'you are offline' : (e.message || 'error')) + '.', 6000);
    } finally { delete busy[fileId]; }
    if (isOpen()) U.render();
  }

  const connect = (pid, acc) => C().connect(pid, acc).catch(e => MB.toast('Could not start the sign-in: ' + (e.message || e), 6000));

  function bind(box) {
    const on = (sel, fn) => box.querySelectorAll(sel).forEach(el => el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'click', () => fn(el)));
    on('[data-connect]', b => connect(b.dataset.connect));
    on('[data-signin]', b => { const a = C().accounts.find(x => x.id === b.dataset.signin); connect(a.provider, a); });
    on('[data-disconnect]', async b => {
      const a = C().accounts.find(x => x.id === b.dataset.disconnect);
      if (await MB.ask('Disconnect ' + accLabel(a) + '?\n\nNothing is deleted: files stay in ' + provName(a.provider) + ', projects stay here.', 'Disconnect', 'Cancel')) C().disconnect(a.id);
    });
    on('[data-auto]', cb => C().setAuto(cb.dataset.auto, cb.checked));
    on('[data-autoto]', sel => {
      const was = C().accounts.find(a => a.auto);
      if (sel.value) C().setAuto(sel.value, true); else if (was) C().setAuto(was.id, false);
    });
    on('[data-sync]', el => C().setSync(el.dataset.sync, el.type === 'checkbox' ? (el.checked ? el.dataset.acc : null) : (el.value || null)));
    on('[data-resolve]', b => { box.querySelectorAll(`[data-resolve][data-id="${b.dataset.id}"]`).forEach(x => { x.disabled = true; }); C().resolve(b.dataset.id, b.dataset.resolve); });
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
    act.type = 'button'; act.id = 'cloudAction'; act.className = 'btn small file-resume'; act.hidden = true;
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
      act.dataset.do = need;
      act.textContent = need === 'conflict' ? 'Resolve' : 'Sign in';
      act.title = need === 'conflict' ? 'Edited here and in the cloud: choose which to keep' : 'Signed out of the cloud: sign in to sync';
      renderSettings();
      preload([...new Set(c.accounts.map(x => x.provider))]); // (a connected account's "Sign in" button beside the save status)
      if (isOpen()) { clearTimeout(renderTimer); renderTimer = setTimeout(U.render, 150); }
    };
    MB.on('cloudsync', paint);
    MB.on('cloud-return', () => U.open());
    MB.on('project', paint);
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
