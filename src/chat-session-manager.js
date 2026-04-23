/**
 * Chat-mode session manager backed by @anthropic-ai/claude-agent-sdk.
 *
 * One ChatSession per conversation. Each wraps a long-lived query() from
 * the SDK, fed by a MessageQueue the user pushes messages into. Output
 * streams out via onEvent callbacks — server.js bridges those to
 * WebSocket subscribers.
 *
 * Sessions are stored on disk by the SDK in ~/.claude/projects/, in the
 * same .jsonl format the CLI uses, so chat-mode and terminal-mode
 * sessions are fully interoperable.
 */

const path = require('path');
const os = require('os');

// The SDK is ESM-only; resolve it via dynamic import on first use.
let sdkModulePromise = null;
function loadSdk() {
  if (!sdkModulePromise) {
    sdkModulePromise = import('@anthropic-ai/claude-agent-sdk');
  }
  return sdkModulePromise;
}

class MessageQueue {
  constructor() {
    this.queued = [];
    this.waiting = null;
    this.closed = false;
  }
  push(content) {
    const msg = { type: 'user', message: { role: 'user', content } };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(msg);
    } else {
      this.queued.push(msg);
    }
  }
  close() {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(undefined);
    }
  }
  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      if (this.queued.length > 0) {
        yield this.queued.shift();
      } else {
        const next = await new Promise((resolve) => { this.waiting = resolve; });
        if (!next) break;
        yield next;
      }
    }
  }
}

class ChatSession {
  /**
   * @param {object} options
   * @param {string} options.chatId      - stable client-side id (web-UI scope)
   * @param {string} [options.sessionId] - CLI session UUID if resuming an existing one
   * @param {string} options.cwd         - working directory the agent runs in
   * @param {string} [options.model]     - 'sonnet' | 'opus' | 'haiku' | full id
   * @param {string} [options.permissionMode] - default | acceptEdits | bypassPermissions | plan
   * @param {string} [options.effort]    - low | medium | high | xhigh | max
   * @param {function} options.onEvent   - fires for every SDK message (text, tool_use, result, etc.)
   * @param {function} options.onClose   - fires when the stream ends
   */
  constructor(opts) {
    this.chatId = opts.chatId;
    this.sessionId = opts.sessionId || null; // populated from first SDK event
    this.requestedResume = opts.sessionId || null;
    this.cwd = opts.cwd;
    this.model = opts.model || 'sonnet';
    this.permissionMode = opts.permissionMode || 'default';
    this.effort = opts.effort || 'xhigh';
    this.onEvent = opts.onEvent || (() => {});
    this.onClose = opts.onClose || (() => {});

    this.queue = new MessageQueue();
    this.started = false;
    this.closed = false;
    this.lastActivityMs = Date.now();
  }

  async start() {
    if (this.started) return;
    this.started = true;
    const { query } = await loadSdk();

    const queryOpts = {
      maxTurns: 500,
      cwd: this.cwd,
      model: this.model,
      permissionMode: this.permissionMode,
      effort: this.effort,
    };
    if (this.permissionMode === 'bypassPermissions') {
      queryOpts.allowDangerouslySkipPermissions = true;
    }
    if (this.requestedResume) {
      queryOpts.resume = this.requestedResume;
    }

    const iterator = query({
      prompt: this.queue,
      options: queryOpts,
    })[Symbol.asyncIterator]();

    // Run the event pump in the background — each SDK message fans out
    // via onEvent; the caller never awaits this loop directly.
    (async () => {
      try {
        while (true) {
          const { value, done } = await iterator.next();
          if (done) break;
          this.lastActivityMs = Date.now();
          if (value && value.session_id && !this.sessionId) {
            this.sessionId = value.session_id;
          }
          this.onEvent(value);
        }
      } catch (err) {
        this.onEvent({ type: 'error', error: err.message });
      } finally {
        this.closed = true;
        this.onClose();
      }
    })();
  }

  sendMessage(content) {
    if (this.closed) return;
    this.lastActivityMs = Date.now();
    this.queue.push(content);
  }

  setModel(model) { this.model = model; }
  setPermissionMode(mode) { this.permissionMode = mode; }
  setEffort(effort) { this.effort = effort; }

  close() {
    this.closed = true;
    this.queue.close();
  }
}

/**
 * Registry of live chat sessions. One per chatId (stable id supplied by
 * the client). Lookup-by-sessionId is also provided so HTTP endpoints
 * can route by UUID.
 */
class ChatSessionManager {
  constructor() {
    this.byChatId = new Map();
  }

  has(chatId) { return this.byChatId.has(chatId); }
  get(chatId) { return this.byChatId.get(chatId); }
  all() { return Array.from(this.byChatId.values()); }

  ensure(chatId, factoryOpts) {
    let s = this.byChatId.get(chatId);
    if (!s) {
      s = new ChatSession({ ...factoryOpts, chatId });
      this.byChatId.set(chatId, s);
    }
    return s;
  }

  close(chatId) {
    const s = this.byChatId.get(chatId);
    if (s) {
      s.close();
      this.byChatId.delete(chatId);
    }
  }
}

module.exports = { ChatSession, ChatSessionManager };
