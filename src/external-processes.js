/**
 * Detect live `claude` processes that this web UI does NOT own, and link
 * them to on-disk saved sessions so the UI can badge them "Running
 * externally" and offer a takeover.
 *
 * Strategy: walk /proc, pick processes whose executable/comm is `claude`,
 * then inspect their open file descriptors for paths containing a session
 * UUID. Claude Code keeps ~/.claude/tasks/<uuid>/ open per session, which
 * gives a reliable match even when the .jsonl itself is opened/closed
 * per-write.
 *
 * We only inspect processes we can stat (same uid + /proc permissions) —
 * running the web UI as the `claude` user gives full visibility for its
 * own processes.
 */

const fs = require('fs');
const path = require('path');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function readLinkSafe(p) {
  try { return fs.readlinkSync(p); } catch { return null; }
}

// /proc/<pid>/comm holds the executable basename (15-char truncated).
// /proc/<pid>/exe resolves to the real path; we fall back to cmdline.
function isClaudeProcess(pid) {
  const comm = (readFileSafe(`/proc/${pid}/comm`) || '').trim();
  if (comm === 'claude') return true;
  const exe = readLinkSafe(`/proc/${pid}/exe`);
  if (exe && path.basename(exe) === 'claude') return true;
  return false;
}

function readCwd(pid) {
  return readLinkSafe(`/proc/${pid}/cwd`);
}

function readCmdline(pid) {
  const raw = readFileSafe(`/proc/${pid}/cmdline`);
  if (!raw) return '';
  return raw.split('\0').filter(Boolean).join(' ');
}

// Find a session UUID referenced by any open file descriptor of the
// process (excluding the process's own /proc/self noise, pids of other
// processes, and anything where the UUID appears only by coincidence).
function findSessionUuidFromFds(pid) {
  let entries;
  try { entries = fs.readdirSync(`/proc/${pid}/fd`); } catch { return null; }
  for (const fd of entries) {
    const target = readLinkSafe(`/proc/${pid}/fd/${fd}`);
    if (!target) continue;
    // We want paths rooted under ~/.claude/ that contain a UUID — the
    // tasks/<uuid>/ directory is the most reliable, followed by
    // projects/<slug>/<uuid>.jsonl.
    if (!target.includes('/.claude/')) continue;
    const m = target.match(UUID_RE);
    if (m) return m[0].toLowerCase();
  }
  return null;
}

function listClaudeProcesses() {
  let pids;
  try { pids = fs.readdirSync('/proc'); } catch { return []; }
  const result = [];
  for (const entry of pids) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = parseInt(entry, 10);
    if (!isClaudeProcess(pid)) continue;
    const cwd = readCwd(pid);
    const sessionId = findSessionUuidFromFds(pid);
    const cmdline = readCmdline(pid);
    // Reading start time from /proc/<pid>/stat (field 22) — used to break
    // ties if multiple processes claim the same session.
    let startTicks = 0;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      const rest = stat.slice(closeParen + 2).split(' ');
      startTicks = parseInt(rest[19], 10) || 0;
    } catch {}
    result.push({ pid, cwd, sessionId, cmdline, startTicks });
  }
  return result;
}

// Build a map: sessionId → pid for quick lookup by the UI.
function externalSessionPidMap() {
  const procs = listClaudeProcesses();
  const map = new Map();
  for (const p of procs) {
    if (!p.sessionId) continue;
    const existing = map.get(p.sessionId);
    // Prefer the earliest-started process if duplicates exist.
    if (!existing || p.startTicks < existing.startTicks) {
      map.set(p.sessionId, p);
    }
  }
  return map;
}

// Gracefully terminate a claude process, falling back to SIGKILL if it
// hasn't exited after a short grace period.
function terminateProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (err.code === 'ESRCH') return { ok: true, alreadyGone: true };
    return { ok: false, error: err.message };
  }
  // Best-effort SIGKILL after 2s — fire-and-forget since the caller
  // returns immediately.
  setTimeout(() => {
    try { process.kill(pid, 0); } catch { return; } // already gone
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }, 2000);
  return { ok: true };
}

module.exports = {
  listClaudeProcesses,
  externalSessionPidMap,
  terminateProcess,
};
