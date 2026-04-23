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
    streamingAssistant: null,
    busy: false,            // agent currently thinking (between user msg and result)
    busyIndicatorEl: null,  // DOM node for the "thinking" bubble
    busyIntervalId: null,
    attachments: [],        // pending attachments [{name, type, mediaType, data, isImage, objectUrl}]
  };

  // Playful status words cycled through while Claude is thinking. Echoes
  // the CLI's fun verbs ("Flibbertyjibbeting", etc.) so the web UI feels
  // like the same tool.
  const BUSY_WORDS = [
    'Thinking', 'Flibbertyjibbeting', 'Clauding', 'Pondering', 'Considering',
    'Cogitating', 'Ruminating', 'Contemplating', 'Hypothesizing', 'Mulling',
    'Ideating', 'Synthesizing', 'Weighing', 'Deducing', 'Brewing', 'Percolating',
    'Tinkering', 'Scheming', 'Puzzling', 'Reckoning', 'Doing the thing',
  ];

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

  // Server-side diagnostic sink (so we can debug on mobile without devtools).
  function dlog(tag, data) {
    try { console.log('[chat]', tag, data); } catch {}
    // Client log forwarding to server disabled now that we've debugged
    // the mobile flow. Re-enable if something goes pear-shaped.
  }

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
    // Keep the busy indicator pinned to the very bottom at all times.
    if (state.busyIndicatorEl && state.busyIndicatorEl.parentNode === el.messages) {
      el.messages.appendChild(state.busyIndicatorEl);
    }
    return wrap;
  }

  function clearMessages() {
    el.messages.innerHTML = '';
  }

  function showBusyIndicator() {
    if (state.busyIndicatorEl) return;
    const bar = document.createElement('div');
    bar.className = 'chat-busy-bar';
    bar.innerHTML =
      '<span class="chat-busy-bar-dots"><span></span><span></span><span></span></span>' +
      '<span class="chat-busy-bar-word">Thinking</span>';
    el.messages.appendChild(bar);
    state.busyIndicatorEl = bar;
    state.busy = true;
    scrollToBottomIfNear();
    const wordEl = bar.querySelector('.chat-busy-bar-word');
    let i = Math.floor(Math.random() * BUSY_WORDS.length);
    state.busyIntervalId = setInterval(() => {
      i = (i + 1) % BUSY_WORDS.length;
      if (wordEl) wordEl.textContent = BUSY_WORDS[i] + '…';
    }, 3000);
  }

  function hideBusyIndicator() {
    if (state.busyIntervalId) { clearInterval(state.busyIntervalId); state.busyIntervalId = null; }
    if (state.busyIndicatorEl && state.busyIndicatorEl.parentNode) {
      state.busyIndicatorEl.parentNode.removeChild(state.busyIndicatorEl);
    }
    state.busyIndicatorEl = null;
    state.busy = false;
  }

  // Returns true when the messages pane is scrolled within 80px of the
  // bottom — "close enough" that we should auto-follow new content.
  function isNearBottom() {
    if (!el.messages) return true;
    const { scrollTop, scrollHeight, clientHeight } = el.messages;
    return scrollHeight - scrollTop - clientHeight < 80;
  }

  function scrollToBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  // Only scroll if the user hasn't scrolled up to read history.
  function scrollToBottomIfNear() {
    if (isNearBottom()) scrollToBottom();
  }

  // ----------------------- Attachments -----------------------------------

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // result is "data:<mediaType>;base64,<data>" — strip the prefix
        const b64 = reader.result.split(',')[1];
        resolve(b64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  async function addFiles(files) {
    for (const file of files) {
      const isImage = file.type.startsWith('image/');
      const isText = file.type.startsWith('text/') ||
        /\.(js|ts|jsx|tsx|py|php|json|md|csv|xml|yaml|yml|sh|css|html|sql|rb|go|rs|java|c|cpp|h)$/i.test(file.name);

      let att;
      if (isImage) {
        const data = await readFileAsBase64(file);
        const objectUrl = URL.createObjectURL(file);
        att = { name: file.name, type: 'image', mediaType: file.type || 'image/jpeg', data, isImage: true, objectUrl };
      } else if (isText) {
        const text = await readFileAsText(file);
        att = { name: file.name, type: 'text', text, isImage: false };
      } else {
        // Binary non-image: save as base64, tell Claude the filename
        const data = await readFileAsBase64(file);
        att = { name: file.name, type: 'file', mediaType: file.type, data, isImage: false };
      }
      state.attachments.push(att);
    }
    renderAttachPreviews();
  }

  function removeAttachment(idx) {
    const att = state.attachments[idx];
    if (att && att.objectUrl) URL.revokeObjectURL(att.objectUrl);
    state.attachments.splice(idx, 1);
    renderAttachPreviews();
  }

  function clearAttachments() {
    state.attachments.forEach((a) => { if (a.objectUrl) URL.revokeObjectURL(a.objectUrl); });
    state.attachments = [];
    renderAttachPreviews();
  }

  function renderAttachPreviews() {
    if (!el.attachPreviews) return;
    el.attachPreviews.innerHTML = '';
    if (!state.attachments.length) {
      el.attachPreviews.style.display = 'none';
      return;
    }
    el.attachPreviews.style.display = 'flex';
    state.attachments.forEach((att, idx) => {
      if (att.isImage) {
        const thumb = document.createElement('div');
        thumb.className = 'chat-attach-thumb';
        thumb.innerHTML = '<img src="' + escapeHtml(att.objectUrl) + '" alt="' + escapeHtml(att.name) + '">';
        const rm = document.createElement('button');
        rm.className = 'chat-attach-remove';
        rm.type = 'button';
        rm.innerHTML = '×';
        rm.addEventListener('click', () => removeAttachment(idx));
        thumb.appendChild(rm);
        el.attachPreviews.appendChild(thumb);
      } else {
        const chip = document.createElement('div');
        chip.className = 'chat-attach-file';
        chip.innerHTML =
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
          '<span>' + escapeHtml(att.name) + '</span>' +
          '<button class="chat-attach-remove-inline" type="button" title="Remove">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
          '</button>';
        chip.querySelector('.chat-attach-remove-inline').addEventListener('click', () => removeAttachment(idx));
        el.attachPreviews.appendChild(chip);
      }
    });
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
    const proto = Object.getPrototypeOf(window.app);
    const orig = (proto && proto.handleMessage) || window.app.handleMessage;
    if (!orig) return setTimeout(installWSHook, 100);
    const boundOrig = orig.bind(window.app);
    window.app.handleMessage = function (message) {
      if (message && (message.type === 'chat_event' || message.type === 'chat_subscribed')) {
        dlog('ws_recv', {
          type: message.type,
          chatId: message.chatId,
          evType: message.event && message.event.type,
          stateChatId: state.chatId,
          match: state.chatId && message.chatId === state.chatId,
        });
      }
      if (message && message.type === 'chat_event') {
        handleChatEvent(message);
        return;
      }
      if (message && message.type === 'chat_subscribed') {
        state.live = !!message.live;
        updateStatus();
        return;
      }
      return boundOrig(message);
    };
    dlog('hook_installed', { hasApp: !!window.app, hasHandler: !!orig });
  }

  function handleChatEvent(msg) {
    if (!state.chatId || msg.chatId !== state.chatId) return;
    const ev = msg.event;
    if (!ev) return;

    switch (ev.type) {
      case 'system':
        // Init or config events — just note the session is alive.
        if (ev.subtype === 'init') {
          state.live = true;
          updateStatus();
        }
        break;
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
        // Don't hide the busy indicator here — more tool calls may follow.
        // It's hidden only when the 'result' event fires (turn complete).
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
          scrollToBottomIfNear();
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
              scrollToBottomIfNear();
            }
          }
        }
        break;
      }
      case 'result':
        hideBusyIndicator();
        break;
      case 'error':
        hideBusyIndicator();
        appendMessage({ role: 'meta', text: 'Error: ' + (ev.error || 'unknown') });
        scrollToBottomIfNear();
        break;
    }
  }

  // ------------------------- Actions -------------------------------------

  const LAST_SESSION_KEY = 'chatLastSession';

  function saveLastSession(projectSlug, sessionId, cwd) {
    try { localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ projectSlug, sessionId, cwd })); } catch {}
  }
  function clearLastSession() {
    try { localStorage.removeItem(LAST_SESSION_KEY); } catch {}
  }
  function restoreLastSession() {
    try {
      const raw = localStorage.getItem(LAST_SESSION_KEY);
      if (!raw) return;
      const { projectSlug, sessionId, cwd } = JSON.parse(raw);
      if (projectSlug && sessionId) open(projectSlug, sessionId, cwd);
    } catch {}
  }

  async function open(projectSlug, sessionId, cwd) {
    dlog('open', { projectSlug, sessionId, cwd });
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
    // Persist so a page reload reopens this session automatically.
    saveLastSession(projectSlug, sessionId, cwd);
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
    const hasAttachments = state.attachments.length > 0;
    if (!content && !hasAttachments) return;
    if (!state.chatId) return;
    dlog('send', { chatId: state.chatId, live: state.live, len: content.length, attachments: state.attachments.length });

    // Snapshot and clear attachments before async work.
    const attachments = state.attachments.map((a) => {
      if (a.type === 'image')  return { type: 'image', name: a.name, mediaType: a.mediaType, data: a.data };
      if (a.type === 'text')   return { type: 'text',  name: a.name, text: a.text };
      return { type: 'file', name: a.name, mediaType: a.mediaType, data: a.data };
    });
    clearAttachments();

    // Optimistically render the user message.
    const previewImgs = attachments.filter((a) => a.type === 'image')
      .map((a) => '<img src="data:' + a.mediaType + ';base64,' + a.data + '" class="chat-attach-inline-img" alt="' + escapeHtml(a.name) + '">');
    const previewFiles = attachments.filter((a) => a.type !== 'image')
      .map((a) => '<span class="chat-attach-file-inline">' + escapeHtml(a.name) + '</span>');
    const previewHtml = [...previewImgs, ...previewFiles].join('') + (content ? '<div class="chat-md">' + renderMarkdown(content) + '</div>' : '');
    const { wrap, bubble } = msgEl('user');
    bubble.innerHTML = previewHtml;
    el.messages.appendChild(wrap);
    if (state.busyIndicatorEl && state.busyIndicatorEl.parentNode === el.messages) {
      el.messages.appendChild(state.busyIndicatorEl);
    }
    scrollToBottom();

    el.input.value = '';
    autosize();
    showBusyIndicator();

    // Lazy-spawn happens server-side on first chat_message.
    const resumeId = state.live ? null : state.chatId;
    await sendWS({
      type: 'chat_message',
      chatId: state.chatId,
      content,
      attachments: attachments.length ? attachments : undefined,
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

    // Enter behaviour: desktop = send on Enter / new-line on Shift+Enter.
    //                  mobile  = new-line on Enter (use send button).
    const isMobile = () => window.matchMedia('(pointer: coarse)').matches;
    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (isMobile()) {
          // Mobile: Enter always inserts a newline; tap the send button to send.
          return;
        }
        if (!e.shiftKey) {
          e.preventDefault();
          sendCurrentInput();
        }
        // Shift+Enter falls through to default (new line).
      }
    });
    el.input.addEventListener('input', autosize);

    // Attach button
    el.attachBtn    = $('chatAttachBtn');
    el.attachMenu   = $('chatAttachMenu');
    el.attachPreviews = $('chatAttachPreviews');
    el.fileInput    = $('chatFileInput');
    el.cameraInput  = $('chatCameraInput');

    el.attachBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      el.attachMenu.hidden = !el.attachMenu.hidden;
    });
    document.addEventListener('click', () => { if (el.attachMenu) el.attachMenu.hidden = true; });

    $('chatAttachFile').addEventListener('click', () => {
      el.attachMenu.hidden = true;
      el.fileInput.value = '';
      el.fileInput.click();
    });
    $('chatAttachPhoto').addEventListener('click', () => {
      el.attachMenu.hidden = true;
      // Reuse fileInput but scoped to images/videos for the photo library
      el.fileInput.accept = 'image/*,video/*';
      el.fileInput.click();
      el.fileInput.accept = 'image/*,video/*,application/pdf,text/*,.js,.ts,.py,.php,.json,.md,.csv,.xml,.yaml,.yml,.sh';
    });
    $('chatAttachCamera').addEventListener('click', () => {
      el.attachMenu.hidden = true;
      el.cameraInput.value = '';
      el.cameraInput.click();
    });

    el.fileInput.addEventListener('change', () => {
      if (el.fileInput.files.length) addFiles(Array.from(el.fileInput.files));
    });
    el.cameraInput.addEventListener('change', () => {
      if (el.cameraInput.files.length) addFiles(Array.from(el.cameraInput.files));
    });

    const MODE_LABELS = {
      bypassPermissions: 'Bypass', default: 'Ask', acceptEdits: 'Accept edits',
      plan: 'Plan', auto: 'Auto', dontAsk: "Don't ask",
    };
    const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'xHigh', max: 'Max' };
    const MODEL_LABELS = { sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku' };

    function updateChipLabels() {
      const modeL = document.getElementById('chatModeLabel');
      const effortL = document.getElementById('chatEffortLabel');
      const modelL = document.getElementById('chatModelLabel');
      if (modeL) modeL.textContent = MODE_LABELS[state.permissionMode] || state.permissionMode;
      if (effortL) effortL.textContent = EFFORT_LABELS[state.effort] || state.effort;
      if (modelL) modelL.textContent = MODEL_LABELS[state.model] || state.model;
    }

    el.modeSelect.addEventListener('change', () => {
      state.permissionMode = el.modeSelect.value;
      updateChipLabels();
      if (state.live) sendWS({ type: 'chat_update_options', chatId: state.chatId, permissionMode: state.permissionMode });
    });
    el.effortSelect.addEventListener('change', () => {
      state.effort = el.effortSelect.value;
      updateChipLabels();
      if (state.live) sendWS({ type: 'chat_update_options', chatId: state.chatId, effort: state.effort });
    });
    el.modelSelect.addEventListener('change', () => {
      state.model = el.modelSelect.value;
      updateChipLabels();
      if (state.live) sendWS({ type: 'chat_update_options', chatId: state.chatId, model: state.model });
    });

    // Apply saved option defaults to the selects so state matches UI.
    el.modeSelect.value = state.permissionMode;
    el.effortSelect.value = state.effort;
    el.modelSelect.value = state.model;
    updateChipLabels();

    installWSHook();

    // Reopen the last session on page reload so the user lands straight
    // back in their chat rather than the empty-state screen.
    restoreLastSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.chatView = { open, hide: hideChatView, show: showChatView, _state: state };
})();
