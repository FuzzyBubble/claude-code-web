/**
 * Parse Claude Code .jsonl transcripts into chat messages suitable for
 * the web chat UI. Claude CLI and the Agent SDK both write to the same
 * format, so this module is the read-side for historical sessions.
 *
 * We deliberately keep the output shape flat and frontend-friendly:
 *
 *   { role: 'user' | 'assistant' | 'tool_result' | 'system' | 'meta',
 *     text?: string,              // already-decoded text content
 *     toolUses?: [...]            // only on assistant messages with tool calls
 *     toolResult?: {...}          // only on tool_result messages
 *     ts?: number                 // epoch ms
 *   }
 */

const fs = require('fs');
const path = require('path');

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

function extractToolUses(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b && b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
}

function extractToolResult(content) {
  // Tool results only arrive as a content array that contains a
  // tool_result block. Plain-string content is a normal user message.
  if (!Array.isArray(content)) return null;
  const parts = [];
  let error = false;
  let found = false;
  for (const b of content) {
    if (!b || b.type !== 'tool_result') continue;
    found = true;
    if (b.is_error) error = true;
    if (typeof b.content === 'string') parts.push(b.content);
    else if (Array.isArray(b.content)) {
      for (const inner of b.content) {
        if (inner && inner.type === 'text') parts.push(inner.text);
      }
    }
  }
  return found ? { text: parts.join('\n\n'), error } : null;
}

// Boilerplate-only user messages should not clutter the transcript.
// (System reminders, slash-command envelopes, etc.)
function isBoilerplateUserText(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('<local-command-caveat>')) return true;
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

function parseTranscript(jsonlPath) {
  let raw;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  } catch (err) {
    return { messages: [], error: err.message };
  }
  const lines = raw.split('\n');
  const messages = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    const ts = rec.timestamp ? Date.parse(rec.timestamp) : undefined;

    if (rec.type === 'user') {
      const msg = rec.message || {};
      // Tool results come in as user messages with tool_result content blocks.
      const tool = extractToolResult(msg.content);
      if (tool) {
        messages.push({ role: 'tool_result', text: tool.text, error: tool.error, ts });
        continue;
      }
      if (rec.isMeta) continue;
      const text = extractText(msg.content);
      if (isBoilerplateUserText(text)) continue;
      messages.push({ role: 'user', text, ts });
      continue;
    }

    if (rec.type === 'assistant') {
      const msg = rec.message || {};
      const text = extractText(msg.content);
      const toolUses = extractToolUses(msg.content);
      if (!text && toolUses.length === 0) continue;
      messages.push({ role: 'assistant', text, toolUses, ts });
      continue;
    }

    // Ignore file-history-snapshot, ai-title, system hooks, etc. They
    // aren't user-facing conversation turns.
  }

  return { messages };
}

module.exports = { parseTranscript };
