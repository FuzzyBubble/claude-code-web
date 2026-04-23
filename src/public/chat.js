/**
 * Chat-mode renderer: vanilla JS + <marked> for markdown. Renders a
 * transcript loaded from /api/chat/:slug/:id/transcript and handles
 * live streaming via WebSocket messages of type chat_event.
 *
 * Interaction model:
 *   - Tapping a session in the sidebar calls window.chatView.open(slug, id, cwd)
 *   - That loads the transcript (read-only until the user types)
 *   - Sending the first message lazily spawns a claude process and
 *     subscribes the current WS connection to its stream
 *   - Subsequent messages reuse the same process
 *   - The exit button closes the process gracefully
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const state = {
    chatId: null,       // UUID of the currently loaded session (also used as server-side chatId)
    projectSlug: null,
    cwd: null,
    live: false,        // true once a claude process is attached server-side
    permissionMode: 'bypassPermissions',
    effort: 'xhigh',
    model: 'sonnet',
    streamingAssistant: null, // DOM node of the currently-streaming assistant bubble
  };

  const el = {
    root: null,
    messages: null,
    empty: null,
    input: null,
    sendBtn: null,
    stopBtn: null,
    modeSelect: null,
    effortSelect: null,
    modelSelect: null,
    statusDot: null,
    statusText: null,
    titleEl: null,
  };

  // ------------------------- Markdown rendering ---------------------------

  function renderMarkdown(text) {
    if (!text) return '';
    if (typeof window.marked === 'undefined') {
      return escapeHtml(text).replace(/\n/g, '<br>');
    }
    try {
      // Use marked.parse; disable raw HTML for safety.
      return window.marked.parse(text, { breaks: true, gfm: true });
    } catch {
      return escapeHtml(text).replace(/\n/g, '<br>');
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ------------------------- DOM builders --------------------------------

  function msgEl(role) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg chat-msg--' + role;
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    wrap.appendChild(bubble);
    return { wrap, bubble };
  }

  function renderToolUses(toolUses) {
    if (!toolUses || !toolUses.length) return '';
    return toolUses.map((t) => (
      '<details class="chat-tool">' +
        '<summary><span class="chat-tool-name">' + escapeHtml(t.name) + '</span>' +
          '<span class="chat-tool-summary">' + summariseToolInput(t) + '</span>' +
        '</summary>' +
        '<pre class="chat-tool-input">' + escapeHtml(JSON.stringify(t.input, null, 2)) + '</pre>' +
      '</details>'
    )).join('');
  }

  function summariseToolInput(t) {
    const i = t.input || {};
    if (t.name === 'Bash' && i.command) return escapeHtml(String(i.command).slice(0, 80));
    if (t.name === 'Read' && i.file_path) return escapeHtml(String(i.file_path));
    if (t.name === 'Edit' && i.file_path) return escapeHtml(String(i.file_path));
    if (t.name === 'Write' && i.file_path) return escapeHtml(String(i.file_path));
    if (t.name === 'Grep' && i.pattern) return escapeHtml(String(i.pattern).slice(0, 60));
    if (t.name === 'Glob' && i.pattern) return escapeHtml(String(i.pattern).slice(0, 60));
    if (t.name === 'WebFetch' && i.url) return escapeHtml(String(i.url));
    if (t.name === 'WebSearch' && i.query) return escapeHtml(String(i.query).slice(0, 80));
    return '';
  }

  function appendMessage(m) {
    const { wrap, bubble } = msgEl(m.role);
    if (m.role === 'assistant') {
      bubble.innerHTML =
        (m.text ? '<div class="chat-md">' + renderMarkdown(m.text) + '</div>' : '') +
        renderToolUses(m.toolUses);
    } else if (m.role === 'user') {
      bubble.innerHTML = '<div class="chat-md">' + renderMarkdown(m.text || '') + '</div>';
    } else if (m.role === 'tool_result') {
      const truncated = (m.text || '').length > 4000;
      const preview = (m.text || '').slice(0, 4000);
      bubble.innerHTML =
        '<details class="chat-tool chat-tool-result' + (m.error ? ' error' : '') + '">' +
          '<summary>' + (m.error ? 'Tool error' : 'Tool result') +
            (truncated ? ' <span class="chat-tool-summary">(truncated)</span>' : '') +
          '</summary>' +
          '<pre>' + escapeHtml(preview) + '</pre>' +
        '</details>';
    } else {
      bubble.textContent = m.text || '';
    }
    el.messages.appendChild(wrap);
    return wrap;
  }

  function clearMessages() {
    el.messages.innerHTML = '';
  }

  function scrollToBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  // ------------------------- Transcript loading --------------------------

  async function loadTranscript(projectSlug, sessionId) {
    clearMessages();
    el.empty.style.display = 'none';
    try {
      const r = await fetch('/api/chat/' + encodeURIComponent(projectSlug) + '/' + encodeURIComponent(sessionId) + '/transcript');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      const messages = data.messages || [];
      if (!messages.length) {
        el.empty.style.display = '';
      }
      for (const m of messages) appendMessage(m);
      scrollToBottom();
    } catch (err) {
      appendMessage({ role: 'meta', text: 'Failed to load transcript: ' + err.message });
    }
  }

  // ------------------------- WebSocket streaming -------------------------

  function getSocket() {
    return window.app && window.app.socket ? window.app.socket : null;
  }

  function sendWS(payload) {
    const s = getSocket();
    if (!s || s.readyState !== WebSocket.OPEN) {
      // Try to establish a connection first; app.js handles reconnection.
      if (window.app && window.app.connect) {
        return window.app.connect().then(() => {
          window.app.socket.send(JSON.stringify(payload));
        });
      }
      return;
    }
    s.send(JSON.stringify(payload));
  }

  // Hook into the existing WebSocket message handler — chat events come
  // down the same connection as terminal events.
  function installWSHook() {
    if (!window.app) return setTimeout(installWSHook, 100);
    const orig = window.app.handleMessage && window.app.handleMessage.bind(window.app);
    if (!orig) return setTimeout(installWSHook, 100);
    window.app.handleMessage = function (message) {
      if (message && message.type === 'chat_event') {
        handleChatEvent(message);
        return;
      }
      if (message && message.type === 'chat_subscribed') {
        state.live = !!message.live;
        updateStatus();
        return;
      }
      return orig(message);
    };
  }

  function handleChatEvent(msg) {
    if (!state.chatId || msg.chatId !== state.chatId) return;
    const ev = msg.event;
    if (!ev) return;

    switch (ev.type) {
      case 'started':
        state.live = true;
        updateStatus();
        break;
      case 'closed':
        state.live = false;
        updateStatus();
        if (state.streamingAssistant) state.streamingAssistant = null;
        break;
      case 'user_message':
        // Already rendered optimistically on send; nothing to do.
        break;
      case 'assistant': {
        // SDK emits a full assistant message per turn — render the text
        // and any tool_use blocks.
        const msgInner = ev.message || {};
        const content = msgInner.content;
        let text = '';
        const toolUses = [];
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
          for (const b of content) {
            if (b && b.type === 'text') text += (text ? '\n\n' : '') + b.text;
            else if (b && b.type === 'tool_use') toolUses.push({ id: b.id, name: b.name, input: b.input });
          }
        }
        if (text || toolUses.length) {
          appendMessage({ role: 'assistant', text, toolUses });
          scrollToBottom();
        }
        break;
      }
      case 'user': {
        // Tool results flow back as user-type messages from the SDK.
        const msgInner = ev.message || {};
        const content = msgInner.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b && b.type === 'tool_result') {
              let text = '';
              if (typeof b.content === 'string') text = b.content;
              else if (Array.isArray(b.content)) {
                for (const inner of b.content) if (inner && inner.type === 'text') text += inner.text;
              }
              appendMessage({ role: 'tool_result', text, error: !!b.is_error });
              scrollToBottom();
            }
          }
        }
        break;
      }
      case 'result':
        // End-of-turn marker; no UI needed beyond status.
        break;
      case 'error':
        appendMessage({ role: 'meta', text: 'Error: ' + (ev.error || 'unknown') });
        scrollToBottom();
        break;
    }
  }

  // ------------------------- Actions -------------------------------------

  async function open(projectSlug, sessionId, cwd) {
    state.projectSlug = projectSlug;
    state.chatId = sessionId;
    state.cwd = cwd || null;
    state.streamingAssistant = null;
    el.titleEl.textContent = cwd ? basename(cwd) : sessionId.slice(0, 8);
    // Leave empty state behind.
    document.body.classList.remove('view-empty-shown');
    if (projectSlug) {
      await loadTranscript(projectSlug, sessionId);
    } else {
      clearMessages();
      el.empty.style.display = '';
    }
    // Subscribe so we receive live events if someone else is already
    // chatting in this session (or if takeover happens).
    sendWS({ type: 'chat_subscribe', chatId: sessionId });
    el.input.focus();
    showChatView();
  }

  function showChatView() {
    document.body.classList.add('view-chat');
  }
  function hideChatView() {
    document.body.classList.remove('view-chat');
  }

  async function sendCurrentInput() {
    const content = el.input.value.trim();
    if (!content || !state.chatId) return;
    // Optimistically render the user message.
    appendMessage({ role: 'user', text: content });
    scrollToBottom();
    el.input.value = '';
    autosize();

    // Lazy-spawn happens server-side on first chat_message.
    const resumeId = state.live ? null : state.chatId;
    await sendWS({
      type: 'chat_message',
      chatId: state.chatId,
      content,
      cwd: state.cwd,
      permissionMode: state.permissionMode,
      effort: state.effort,
      model: state.model,
      resumeSessionId: resumeId,
    });
  }

  async function stopCurrent() {
    if (!state.chatId) return;
    if (!confirm('Stop this session? The claude process will be terminated. You can resume later.')) return;
    try {
      await fetch('/api/chat/live/' + encodeURIComponent(state.chatId), { method: 'DELETE' });
    } catch {}
  }

  function updateStatus() {
    if (!el.statusDot) return;
    if (state.live) {
      el.statusDot.classList.add('live');
      el.statusText.textContent = 'Connected';
      el.stopBtn.disabled = false;
    } else {
      el.statusDot.classList.remove('live');
      el.statusText.textContent = 'Idle';
      el.stopBtn.disabled = true;
    }
  }

  function basename(p) {
    if (!p) return '';
    const clean = String(p).replace(/\/+$/, '');
    const idx = clean.lastIndexOf('/');
    return idx >= 0 ? clean.slice(idx + 1) : clean;
  }

  // Textarea autosize — stays a single line up to 6 lines.
  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 180) + 'px';
  }

  // ------------------------- init ---------------------------------------

  function init() {
    el.root = $('chatView');
    el.messages = $('chatMessages');
    el.empty = $('chatEmpty');
    el.input = $('chatInput');
    el.sendBtn = $('chatSendBtn');
    el.stopBtn = $('chatStopBtn');
    el.modeSelect = $('chatPermissionMode');
    el.effortSelect = $('chatEffort');
    el.modelSelect = $('chatModel');
    el.statusDot = $('chatStatusDot');
    el.statusText = $('chatStatusText');
    el.titleEl = $('chatTitle');
    if (!el.root) return;

    el.sendBtn.addEventListener('click', sendCurrentInput);
    el.stopBtn.addEventListener('click', stopCurrent);
    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendCurrentInput();
      }
    });
    el.input.addEventListener('input', autosize);

    el.modeSelect.addEventListener('change', () => {
      state.permissionMode = el.modeSelect.value;
      if (state.live) sendWS({ type: 'chat_update_options', chatId: state.chatId, permissionMode: state.permissionMode });
    });
    el.effortSelect.addEventListener('change', () => {
      state.effort = el.effortSelect.value;
      if (state.live) sendWS({ type: 'chat_update_options', chatId: state.chatId, effort: state.effort });
    });
    el.modelSelect.addEventListener('change', () => {
      state.model = el.modelSelect.value;
      if (state.live) sendWS({ type: 'chat_update_options', chatId: state.chatId, model: state.model });
    });

    // Apply saved option defaults to the selects so state matches UI.
    el.modeSelect.value = state.permissionMode;
    el.effortSelect.value = state.effort;
    el.modelSelect.value = state.model;

    installWSHook();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.chatView = { open, hide: hideChatView, show: showChatView, _state: state };
})();
