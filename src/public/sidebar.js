/**
 * Session sidebar: lists running (live PTY) sessions and saved sessions
 * (Claude CLI's on-disk ~/.claude/projects transcripts). Owns the new-session
 * flow (folder pick + mode/effort dropdowns) and per-item actions (attach,
 * stop, resume, delete).
 *
 * Depends on window.app (ClaudeCodeWebUI instance) for folder-browser reuse
 * and session creation. Loads lazily once window.app is ready.
 */
(function () {
  'use strict';

  const SIDEBAR_PINNED_MEDIA = window.matchMedia('(min-width: 1024px)');

  let uiReady = false;
  let refreshTimer = null;

  const $ = (id) => document.getElementById(id);

  const el = {
    sidebar: null,
    scrim: null,
    toggleBtn: null,
    closeBtn: null,
    newBtn: null,
    runningList: null,
    savedList: null,
    runningCount: null,
    savedCount: null,
    startModal: null,
    startModalDir: null,
    startModalResumeWrap: null,
    startModalResumeId: null,
    permissionModeSelect: null,
    effortSelect: null,
    sessionStartGoBtn: null,
    sessionStartCancelBtn: null,
    closeSessionStartBtn: null,
  };

  // ------------------------- sidebar open/close -----------------------------

  function updatePinnedState() {
    if (SIDEBAR_PINNED_MEDIA.matches) {
      document.body.classList.add('sidebar-pinned');
      el.sidebar.classList.add('open');
      el.scrim.classList.remove('open');
    } else {
      document.body.classList.remove('sidebar-pinned');
      // Leave current open state; user decides.
    }
  }

  function openSidebar() {
    el.sidebar.classList.add('open');
    if (!SIDEBAR_PINNED_MEDIA.matches) {
      el.scrim.classList.add('open');
    }
    refresh();
  }

  function closeSidebar() {
    if (SIDEBAR_PINNED_MEDIA.matches) {
      document.body.classList.remove('sidebar-pinned');
      el.scrim.classList.remove('open');
      // Keep sidebar element visible? No — unpin means hidden.
      el.sidebar.classList.remove('open');
    } else {
      el.sidebar.classList.remove('open');
      el.scrim.classList.remove('open');
    }
  }

  function toggleSidebar() {
    if (el.sidebar.classList.contains('open')) closeSidebar();
    else openSidebar();
  }

  // ------------------------- data fetching ----------------------------------

  async function fetchJson(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }

  async function refreshRunning() {
    try {
      const data = await fetchJson('/api/sessions/list');
      // Only surface sessions with a live PTY. Zombie metadata (active:false)
      // persists after a server restart and is useless to the user — it
      // cannot be attached to, just re-started, which is what New Session
      // / Resume is for.
      const live = (data.sessions || []).filter((s) => s.active);
      renderRunning(live);
    } catch (err) {
      console.warn('[sidebar] failed to load running sessions', err);
    }
  }

  async function refreshSaved() {
    try {
      const data = await fetchJson('/api/saved-sessions');
      renderSaved(data.sessions || []);
    } catch (err) {
      console.warn('[sidebar] failed to load saved sessions', err);
      el.savedList.innerHTML = '<div class="sidebar-empty">Failed to load saved sessions</div>';
    }
  }

  function refresh() {
    refreshRunning();
    refreshSaved();
  }

  // ------------------------- rendering --------------------------------------

  function formatRelative(ms) {
    if (!ms) return '';
    const diff = Date.now() - ms;
    if (diff < 60 * 1000) return 'just now';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + 'h ago';
    const days = Math.floor(diff / (24 * 3600000));
    if (days < 30) return days + 'd ago';
    return new Date(ms).toLocaleDateString();
  }

  function basename(p) {
    if (!p) return '';
    const clean = String(p).replace(/\/+$/, '');
    const idx = clean.lastIndexOf('/');
    return idx >= 0 ? clean.slice(idx + 1) : clean;
  }

  function svg(path) {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + path + '</svg>';
  }

  const ICON_STOP = svg('<rect x="6" y="6" width="12" height="12" rx="1"/>');
  const ICON_PLAY = svg('<polygon points="6 4 20 12 6 20 6 4"/>');
  const ICON_TRASH = svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>');
  // Circular-arrow swap icon for "take over"
  const ICON_TAKEOVER = svg('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>');

  function renderRunning(sessions) {
    el.runningCount.textContent = String(sessions.length);
    if (!sessions.length) {
      el.runningList.innerHTML = '<div class="sidebar-empty">No running sessions</div>';
      return;
    }
    el.runningList.innerHTML = '';
    const activeId = (window.app && window.app.sessionTabManager && window.app.sessionTabManager.activeTabId) || null;
    for (const s of sessions) {
      const item = document.createElement('div');
      item.className = 'sidebar-item' + (s.id === activeId ? ' active' : '');
      item.dataset.sessionId = s.id;
      const workingDir = s.workingDir || '';
      const name = s.name || basename(workingDir) || s.id.slice(0, 8);
      const lastMs = s.lastActivity ? new Date(s.lastActivity).getTime() : null;
      item.innerHTML =
        '<div class="sidebar-item-top">' +
          '<span class="sidebar-running-dot" title="Running"></span>' +
          '<div class="sidebar-item-title">' + escapeHtml(name) + '</div>' +
          '<div class="sidebar-item-actions">' +
            '<button class="sidebar-item-action stop-btn" title="Stop session">' + ICON_STOP + '</button>' +
          '</div>' +
        '</div>' +
        (workingDir ? '<div class="sidebar-item-project">' + escapeHtml(workingDir) + '</div>' : '') +
        (lastMs ? '<div class="sidebar-item-meta"><span>' + formatRelative(lastMs) + '</span></div>' : '');

      item.addEventListener('click', (e) => {
        if (e.target.closest('.sidebar-item-action')) return;
        attachToRunning(s.id);
      });
      item.querySelector('.stop-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        stopRunning(s.id);
      });
      el.runningList.appendChild(item);
    }
  }

  // Expanded-project state persists across refreshes (and reloads via LS).
  const LS_OPEN_KEY = 'ccw-sidebar-open-projects';
  const openProjects = new Set(loadOpenProjects());

  function loadOpenProjects() {
    try {
      const raw = localStorage.getItem(LS_OPEN_KEY);
      if (!raw) return [];
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }

  function saveOpenProjects() {
    try { localStorage.setItem(LS_OPEN_KEY, JSON.stringify(Array.from(openProjects))); } catch {}
  }

  const ICON_CHEVRON = svg('<polyline points="9 18 15 12 9 6"/>');

  function groupByProject(sessions) {
    const groups = new Map();
    for (const s of sessions) {
      const key = s.projectDir || s.projectSlug || '(unknown)';
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label: s.projectDir ? basename(s.projectDir) : s.projectSlug,
          projectDir: s.projectDir || '',
          sessions: [],
          lastActiveMs: 0,
        });
      }
      const g = groups.get(key);
      g.sessions.push(s);
      if (s.lastActiveMs > g.lastActiveMs) g.lastActiveMs = s.lastActiveMs;
    }
    // Newest project first; sessions within a project also newest first.
    return Array.from(groups.values())
      .sort((a, b) => b.lastActiveMs - a.lastActiveMs)
      .map((g) => {
        g.sessions.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
        return g;
      });
  }

  function buildSessionItem(s) {
    const item = document.createElement('div');
    const external = !!s.externalPid;
    item.className = 'sidebar-item' + (external ? ' external' : '');
    item.dataset.sessionId = s.sessionId;
    item.dataset.projectSlug = s.projectSlug;
    item.dataset.projectDir = s.projectDir || '';
    const title = (s.title || '').replace(/\s+/g, ' ').slice(0, 80) || '(no title)';

    const primaryBtn = external
      ? '<button class="sidebar-item-action takeover-btn" title="Take over external session (kills pid ' + s.externalPid + ', resumes here)">' + ICON_TAKEOVER + '</button>'
      : '<button class="sidebar-item-action resume-btn" title="Resume session">' + ICON_PLAY + '</button>';

    const runningBadge = external
      ? '<span class="sidebar-item-badge" title="Running externally in another terminal (pid ' + s.externalPid + ')">● live</span>'
      : '';

    item.innerHTML =
      '<div class="sidebar-item-top">' +
        '<div class="sidebar-item-title">' + escapeHtml(title) + '</div>' +
        '<div class="sidebar-item-actions">' +
          primaryBtn +
          '<button class="sidebar-item-action danger delete-btn" title="Delete session">' + ICON_TRASH + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="sidebar-item-meta">' +
        runningBadge +
        '<span>' + formatRelative(s.lastActiveMs) + '</span>' +
        '<span>' + (s.messageCount || 0) + ' msgs</span>' +
      '</div>';

    const actionFn = external
      ? () => takeoverExternal(s)
      : () => openStartModal({ workingDir: s.projectDir, resumeSessionId: s.sessionId });

    const primary = item.querySelector('.resume-btn') || item.querySelector('.takeover-btn');
    primary.addEventListener('click', (e) => { e.stopPropagation(); actionFn(); });
    item.querySelector('.delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSaved(s.projectSlug, s.sessionId, title);
    });
    item.addEventListener('click', (e) => {
      if (e.target.closest('.sidebar-item-action')) return;
      actionFn();
    });
    return item;
  }

  async function takeoverExternal(s) {
    const msg = 'Take over this session?\n\n' +
      'Pid ' + s.externalPid + ' is currently holding the session in another terminal. ' +
      'It will be terminated (SIGTERM, then SIGKILL after 2s if needed) and a fresh ' +
      'claude --resume will start here. The transcript is unaffected.';
    if (!confirm(msg)) return;
    try {
      const r = await fetch('/api/saved-sessions/' + encodeURIComponent(s.projectSlug) + '/' + encodeURIComponent(s.sessionId) + '/takeover', {
        method: 'POST'
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || r.statusText);
      }
      // Give the process a beat to die, then spawn a fresh resume.
      setTimeout(() => {
        openStartModal({ workingDir: s.projectDir, resumeSessionId: s.sessionId });
      }, 600);
    } catch (err) {
      alert('Takeover failed: ' + err.message);
    }
  }

  function buildProjectGroup(group) {
    const wrap = document.createElement('div');
    wrap.className = 'sidebar-project-group' + (openProjects.has(group.key) ? ' open' : '');

    const header = document.createElement('div');
    header.className = 'sidebar-project-header';
    header.innerHTML =
      '<span class="sidebar-project-chevron">' + ICON_CHEVRON + '</span>' +
      '<span class="sidebar-project-name" title="' + escapeHtml(group.projectDir || group.key) + '">' +
        escapeHtml(group.label) +
      '</span>' +
      '<span class="sidebar-project-count">' + group.sessions.length + '</span>';
    header.addEventListener('click', () => {
      wrap.classList.toggle('open');
      if (wrap.classList.contains('open')) openProjects.add(group.key);
      else openProjects.delete(group.key);
      saveOpenProjects();
    });
    wrap.appendChild(header);

    const children = document.createElement('div');
    children.className = 'sidebar-project-children';
    for (const s of group.sessions) {
      children.appendChild(buildSessionItem(s));
    }
    wrap.appendChild(children);
    return wrap;
  }

  function renderSaved(sessions) {
    el.savedCount.textContent = String(sessions.length);
    if (!sessions.length) {
      el.savedList.innerHTML = '<div class="sidebar-empty">No saved sessions</div>';
      return;
    }
    el.savedList.innerHTML = '';
    const groups = groupByProject(sessions);
    for (const g of groups) el.savedList.appendChild(buildProjectGroup(g));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ------------------------- actions ----------------------------------------

  function attachToRunning(sessionId) {
    const app = window.app;
    if (!app || !app.sessionTabManager) return;
    if (app.sessionTabManager.activeTabId !== sessionId) {
      // session-manager exposes switchToTab; also call back into app's
      // hideOverlay in case the empty-state was showing.
      app.sessionTabManager.switchToTab(sessionId);
      if (typeof app.hideOverlay === 'function') app.hideOverlay();
    }
    if (!SIDEBAR_PINNED_MEDIA.matches) closeSidebar();
    // Re-fit terminal to the newly visible main area.
    setTimeout(() => {
      if (typeof app.fitTerminal === 'function') app.fitTerminal();
    }, 50);
  }

  async function stopRunning(sessionId) {
    if (!confirm('Stop this session? The process will be terminated.')) return;
    try {
      const r = await fetch('/api/sessions/' + encodeURIComponent(sessionId), { method: 'DELETE' });
      if (!r.ok) throw new Error(await r.text());
      refresh();
    } catch (err) {
      alert('Failed to stop session: ' + err.message);
    }
  }

  async function deleteSaved(projectSlug, sessionId, title) {
    if (!confirm('Delete saved session "' + (title || sessionId) + '"? This removes the transcript from ~/.claude/projects/.')) return;
    try {
      const r = await fetch('/api/saved-sessions/' + encodeURIComponent(projectSlug) + '/' + encodeURIComponent(sessionId), {
        method: 'DELETE'
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || r.statusText);
      }
      refreshSaved();
    } catch (err) {
      alert('Failed to delete: ' + err.message);
    }
  }

  // ------------------------- new-session flow -------------------------------

  async function handleNewSessionClick() {
    const app = window.app;
    if (!app || !app.showFolderBrowser) {
      alert('Folder browser not ready');
      return;
    }
    // Stash the original handler so we can intercept.
    const originalHandler = app.onFolderSelected;
    app.onFolderSelected = (path) => {
      app.onFolderSelected = originalHandler;
      openStartModal({ workingDir: path });
    };
    app.showFolderBrowser();
  }

  function openStartModal({ workingDir, resumeSessionId }) {
    el.startModalDir.textContent = workingDir || '(none)';
    if (resumeSessionId) {
      el.startModalResumeWrap.style.display = '';
      el.startModalResumeId.textContent = resumeSessionId;
    } else {
      el.startModalResumeWrap.style.display = 'none';
    }
    el.startModal.dataset.workingDir = workingDir || '';
    el.startModal.dataset.resumeSessionId = resumeSessionId || '';
    el.startModal.classList.add('active');
  }

  function closeStartModal() {
    el.startModal.classList.remove('active');
  }

  async function startSessionFromModal() {
    const app = window.app;
    if (!app || !app.startClaudeSessionWithOptions) {
      alert('App not ready');
      return;
    }
    const workingDir = el.startModal.dataset.workingDir || undefined;
    const resumeSessionId = el.startModal.dataset.resumeSessionId || undefined;
    const permissionMode = el.permissionModeSelect.value;
    const effort = el.effortSelect.value;
    // If Bypass is selected we still want the CLI to actually bypass; other
    // modes go via --permission-mode.
    const dangerouslySkipPermissions = permissionMode === 'bypassPermissions';
    const pmForBridge = dangerouslySkipPermissions ? null : permissionMode;

    closeStartModal();
    if (!SIDEBAR_PINNED_MEDIA.matches) closeSidebar();

    try {
      await app.startClaudeSessionWithOptions({
        workingDir,
        options: {
          dangerouslySkipPermissions,
          permissionMode: pmForBridge,
          effort,
          resumeSessionId,
        }
      });
      // Give the server a moment to register the session before refreshing.
      setTimeout(refresh, 400);
    } catch (err) {
      alert('Failed to start session: ' + err.message);
    }
  }

  // ------------------------- init ------------------------------------------

  function init() {
    el.sidebar = $('sessionSidebar');
    el.scrim = $('sidebarScrim');
    el.toggleBtn = $('sidebarToggleBtn');
    el.closeBtn = $('sidebarCloseBtn');
    el.newBtn = $('sidebarNewSessionBtn');
    el.runningList = $('runningSessionList');
    el.savedList = $('savedSessionList');
    el.runningCount = $('runningCount');
    el.savedCount = $('savedCount');
    el.startModal = $('sessionStartModal');
    el.startModalDir = $('sessionStartDir');
    el.startModalResumeWrap = $('sessionStartResumeInfo');
    el.startModalResumeId = $('sessionStartResumeId');
    el.permissionModeSelect = $('permissionModeSelect');
    el.effortSelect = $('effortSelect');
    el.sessionStartGoBtn = $('sessionStartGoBtn');
    el.sessionStartCancelBtn = $('sessionStartCancelBtn');
    el.closeSessionStartBtn = $('closeSessionStartBtn');

    if (!el.sidebar) return; // HTML not updated yet

    el.toggleBtn && el.toggleBtn.addEventListener('click', toggleSidebar);
    el.closeBtn && el.closeBtn.addEventListener('click', closeSidebar);
    el.scrim && el.scrim.addEventListener('click', closeSidebar);
    const emptyOpenBtn = $('emptyStateOpenSidebarBtn');
    if (emptyOpenBtn) emptyOpenBtn.addEventListener('click', openSidebar);
    el.newBtn && el.newBtn.addEventListener('click', handleNewSessionClick);
    el.sessionStartGoBtn && el.sessionStartGoBtn.addEventListener('click', startSessionFromModal);
    el.sessionStartCancelBtn && el.sessionStartCancelBtn.addEventListener('click', closeStartModal);
    el.closeSessionStartBtn && el.closeSessionStartBtn.addEventListener('click', closeStartModal);

    SIDEBAR_PINNED_MEDIA.addEventListener('change', updatePinnedState);
    updatePinnedState();

    // Poll saved sessions periodically so changes made elsewhere show up.
    refreshTimer = setInterval(refresh, 15000);
    refresh();
  }

  // Wait for app.js to boot then init.
  function waitForApp(cb) {
    if (window.app) return cb();
    setTimeout(() => waitForApp(cb), 50);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => waitForApp(init));
  } else {
    waitForApp(init);
  }

  // Expose for app.js integration
  window.sessionSidebar = {
    refresh,
    open: openSidebar,
    close: closeSidebar,
  };
})();
