// Saved sessions: Claude CLI's on-disk session transcripts under
// ~/.claude/projects/<slug>/<uuid>.jsonl.
//
// This module reads those files to surface historical sessions in the web UI
// (alongside live PTY sessions tracked in memory). The web UI stays read-only
// for the transcript itself; resume/delete operate at the file level.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

// Boilerplate wrappers Claude Code injects around real user input. A message
// made up only of these tags has no useful title content.
function isBoilerplateUserText(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.startsWith('<local-command-caveat>')) return true;
  // Strip recognised tag envelopes and see if anything meaningful is left.
  const stripped = trimmed
    .replace(/<command-name>.*?<\/command-name>/gs, '')
    .replace(/<command-message>.*?<\/command-message>/gs, '')
    .replace(/<command-args>.*?<\/command-args>/gs, '')
    .replace(/<local-command-stdout>.*?<\/local-command-stdout>/gs, '')
    .replace(/<local-command-stderr>.*?<\/local-command-stderr>/gs, '')
    .replace(/<system-reminder>.*?<\/system-reminder>/gs, '')
    .trim();
  return stripped.length < 3;
}

function extractUserText(message) {
  if (!message) return null;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
    }
  }
  return null;
}

// Read the first ~32 lines of a jsonl to extract:
//   - cwd (original project directory)
//   - aiTitle (if the CLI has produced one)
//   - first non-meta user message text (fallback title)
// This avoids slurping multi-MB files just to get a label.
function peekHeader(jsonlPath) {
  let cwd = null;
  let aiTitle = null;
  let firstUserText = null;

  let fd;
  try {
    fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(64 * 1024); // 64KB is more than enough for first few records
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.slice(0, bytesRead).toString('utf8');
    const lines = text.split('\n');

    for (const line of lines) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!cwd && rec.cwd) cwd = rec.cwd;
      if (!aiTitle && rec.type === 'ai-title' && typeof rec.aiTitle === 'string') {
        aiTitle = rec.aiTitle.trim();
      }
      if (!firstUserText && rec.type === 'user' && !rec.isMeta) {
        const text = extractUserText(rec.message);
        if (text && !isBoilerplateUserText(text)) {
          firstUserText = text.trim();
        }
      }
      if (cwd && aiTitle && firstUserText) break;
    }
  } catch {
    // File may have been deleted mid-read; return what we have.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  return { cwd, aiTitle, firstUserText };
}

// Approximate message count by counting lines. Cheap compared to parsing JSON.
function countLines(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return 0;
    // For small files just read + split; for big files use a streaming count.
    if (stat.size < 1024 * 1024) {
      const data = fs.readFileSync(filePath, 'utf8');
      let n = 0;
      for (let i = 0; i < data.length; i++) if (data.charCodeAt(i) === 10) n++;
      return n;
    }
    // Streaming path.
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    let n = 0;
    let bytes;
    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < bytes; i++) if (buf[i] === 10) n++;
    }
    fs.closeSync(fd);
    return n;
  } catch {
    return 0;
  }
}

function listSavedSessions() {
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(CLAUDE_PROJECTS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const projectSlug = entry.name;
    const projectPath = path.join(CLAUDE_PROJECTS_ROOT, projectSlug);

    let files;
    try {
      files = fs.readdirSync(projectPath);
    } catch {
      continue;
    }

    for (const fname of files) {
      if (!fname.endsWith('.jsonl')) continue;
      const sessionId = fname.slice(0, -'.jsonl'.length);
      if (!isUuid(sessionId)) continue;

      const filePath = path.join(projectPath, fname);
      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }

      // Skip obvious stubs (no real conversation).
      if (stat.size < 200) continue;

      const { cwd, aiTitle, firstUserText } = peekHeader(filePath);
      const messageCount = countLines(filePath);

      const title = aiTitle || (firstUserText
        ? firstUserText.replace(/\s+/g, ' ').slice(0, 80)
        : '(no title)');

      out.push({
        sessionId,
        projectSlug,
        projectDir: cwd || null,
        title,
        lastActiveMs: stat.mtimeMs,
        messageCount,
        sizeBytes: stat.size,
      });
    }
  }

  out.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
  return out;
}

function deleteSavedSession(projectSlug, sessionId) {
  if (!isUuid(sessionId)) {
    return { ok: false, error: 'Invalid session ID' };
  }
  // Guard against path traversal in the slug.
  if (typeof projectSlug !== 'string' || projectSlug.includes('/') || projectSlug.includes('..')) {
    return { ok: false, error: 'Invalid project slug' };
  }

  const filePath = path.join(CLAUDE_PROJECTS_ROOT, projectSlug, `${sessionId}.jsonl`);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(CLAUDE_PROJECTS_ROOT) + path.sep)) {
    return { ok: false, error: 'Path outside projects root' };
  }
  try {
    fs.unlinkSync(resolved);
    // The CLI also keeps a sibling directory of file-history snapshots;
    // remove it too if present so /resume doesn't find stale state.
    const siblingDir = path.join(CLAUDE_PROJECTS_ROOT, projectSlug, sessionId);
    try {
      fs.rmSync(siblingDir, { recursive: true, force: true });
    } catch {}
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  listSavedSessions,
  deleteSavedSession,
  isUuid,
  CLAUDE_PROJECTS_ROOT,
};
