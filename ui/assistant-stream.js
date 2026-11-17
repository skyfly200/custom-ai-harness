// Reading the assistant's streamed reply (POST api/assistant/stream), shared by the floating assistant
// (ui/assistant-dock.js) and the Assistant page (ui/assistant.js). The server sends server-sent events:
// {"step":true} when a model step starts (its text replaces the step before), {"delta":"..."} for each piece of
// text, and {"done":true, reply, pending} or {"done":true, error} at the end.
//
// Stop: pass an AbortSignal to fetch and abort it. The read then rejects with an AbortError; the server sees the
// connection close, stops the model call and keeps what was written so far (utils/assistant.js).
(() => {
'use strict';

/** Splits server-sent events into their JSON payloads. Returns the events and the unfinished tail to keep. */
function parseEvents(buffer) {
  const lines = String(buffer).split('\n');
  const rest = lines.pop();
  const events = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* a partial or foreign line */ }
  }
  return { events, rest };
}

/**
 * The words for a failed request: the server's own message when it sent one (JSON), else what the status means. A
 * proxy in front of the app (Fly, Cloudflare) answers 502 to a plain-text page, so that case gets a plain explanation.
 */
async function answerError(res) {
  const body = await res.json().catch(() => null);
  if (body && body.error) return String(body.error);
  if ([502, 503, 504].includes(res.status)) return `the server did not answer (HTTP ${res.status}). It may be restarting or waking from sleep; try again in a moment.`;
  return `HTTP ${res.status}`;
}

/**
 * Reads a fetch Response from the stream route (or, from a server without it, the plain JSON route) and resolves
 * to the final event: { reply, pending } or throws its error. `onText(text)` gets the current step's text each
 * time it grows or a new step starts.
 */
async function readReply(res, { onText = () => {} } = {}) {
  if (!res.ok) throw new Error(await answerError(res));
  const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
  if (!/event-stream/.test(type) || !res.body) {
    const body = await res.json();
    if (body.error) throw new Error(body.error);
    return body;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let done = null;
  const take = (events) => {
    for (const ev of events) {
      if (ev.step) { text = ''; onText(text); } else if (typeof ev.delta === 'string') { text += ev.delta; onText(text); } else if (ev.done) done = ev;
    }
  };
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    const parsed = parseEvents(buffer + (typeof value === 'string' ? value : decoder.decode(value, { stream: true })));
    buffer = parsed.rest;
    take(parsed.events);
  }
  take(parseEvents(`${buffer}\n`).events);
  if (!done) throw new Error('the reply stopped before it finished');
  if (done.error) throw new Error(done.error);
  return done;
}

/** True for the error a fetch or a read throws once its signal is aborted (the Stop button). */
const isAbort = (err) => Boolean(err && (err.name === 'AbortError' || err.code === 20));

const AssistantStream = { parseEvents, readReply, isAbort, answerError };
if (typeof module !== 'undefined') module.exports = AssistantStream;
if (typeof window !== 'undefined') window.AssistantStream = AssistantStream;
})();
