// A personal assistant: one agent that keeps notes and a short history per conversation, and
// answers through the harness's own model routing. The web page and the messaging channels
// (utils/assistantChannels.js) all go through `handle(conversation, text)`.
//
// State lives in one JSON file (ASSISTANT_FILE, default assistant.json): saved notes shared by every
// conversation, and the last turns of each conversation. Commands start with a slash:
// /help, /reset, /remember TEXT, /notes, /forget N. Anything else goes to the model.
const fs = require('fs');
const path = require('path');
const internalAuth = require('./internalAuth');

const MAX_HISTORY = 40; // messages kept per conversation
const MAX_NOTES = 200;
const MAX_NOTE_CHARS = 500;
const MAX_TEXT_CHARS = 8000;
const HELP = 'Commands: /reset (start a new conversation; notes are kept), /remember TEXT (save a note), '
    + '/notes (list notes), /forget N (drop note N), /help.';

const emptyState = () => ({ nextNoteId: 1, notes: [], conversations: {} });

/** A JSON file store. A file that exists but does not parse throws, so a save never replaces it with an empty state. */
function fileStore(file) {
    return {
        file,
        load() {
            let text;
            try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return emptyState(); throw err; }
            return { ...emptyState(), ...JSON.parse(text) };
        },
        save(state) {
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
            fs.renameSync(tmp, file);
        },
    };
}

/** An in-memory store, for tests and for running without a file. */
function memoryStore(initial) {
    let saved = JSON.stringify(initial ? { ...emptyState(), ...initial } : emptyState());
    return { load: () => JSON.parse(saved), save: (state) => { saved = JSON.stringify(state); } };
}

function systemPrompt({ name, owner, notes, today }) {
    const lines = [
        `You are ${name}, a personal assistant for ${owner}. ${owner} can reach you on the web page, Telegram or Slack.`,
        'Reply in plain text that reads well in a chat app: short paragraphs, few lists, no tables.',
        `Today is ${today}.`,
    ];
    if (notes.length) {
        lines.push(`Notes ${owner} asked you to keep (use them without repeating them back):`);
        for (const note of notes) lines.push(`- ${note.text}`);
    }
    return lines.join('\n');
}

/**
 * @param {object} opts
 * @param {object} opts.store      fileStore() or memoryStore()
 * @param {function} opts.ask      async (messages, { conversation, owner }) => reply text; owner is who to bill
 * @param {string} [opts.owner]    the person the assistant works for (their name in prompts)
 * @param {string} [opts.name]     what the assistant calls itself
 */
function createAssistant({ store, ask, owner = 'you', name = 'Assistant', now = () => Date.now(), maxHistory = MAX_HISTORY }) {
    let state = null;
    const queues = new Map(); // conversation -> last queued job, so one conversation's turns run in order
    const load = () => { if (!state) state = store.load(); return state; };
    const persist = () => store.save(state);

    function enqueue(key, job) {
        const run = (queues.get(key) || Promise.resolve()).catch(() => {}).then(job);
        const tail = run.catch(() => {});
        queues.set(key, tail);
        tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
        return run;
    }

    function command(key, cmd, arg) {
        const s = load();
        if (cmd === 'help') return HELP;
        if (cmd === 'reset') {
            delete s.conversations[key];
            persist();
            return 'Started a new conversation. Saved notes are kept.';
        }
        if (cmd === 'remember') {
            if (!arg) return 'Say what to remember, for example /remember I prefer metric units.';
            if (s.notes.length >= MAX_NOTES) return `Notes are full (${MAX_NOTES}). Use /forget N to drop one first.`;
            const note = { id: s.nextNoteId++, text: arg.slice(0, MAX_NOTE_CHARS), at: now() };
            s.notes.push(note);
            persist();
            return `Saved note ${note.id}.`;
        }
        if (cmd === 'notes') {
            return s.notes.length ? s.notes.map((note) => `${note.id}. ${note.text}`).join('\n') : 'No notes yet. Use /remember TEXT to add one.';
        }
        if (cmd === 'forget') {
            const id = Number(arg);
            const index = s.notes.findIndex((note) => note.id === id);
            if (!Number.isInteger(id) || index < 0) return 'Give the number of a note from /notes, for example /forget 2.';
            s.notes.splice(index, 1);
            persist();
            return `Forgot note ${id}.`;
        }
        return null;
    }

    async function chat(key, message, owner) {
        const s = load();
        const history = s.conversations[key] || [];
        const today = new Date(now()).toISOString().slice(0, 10);
        const messages = [
            { role: 'system', content: systemPrompt({ name, owner, notes: s.notes, today }) },
            ...history.map(({ role, content }) => ({ role, content })),
            { role: 'user', content: message },
        ];
        let reply;
        try {
            reply = String((await ask(messages, { conversation: key, owner })) || '').trim();
        } catch (err) {
            return `I could not get an answer just now (${err.message}). Try again in a moment.`;
        }
        if (!reply) return 'The model sent an empty answer. Try again, or send /reset.';
        const stamp = now();
        const turn = [...history, { role: 'user', content: message, at: stamp }, { role: 'assistant', content: reply, at: stamp }].slice(-maxHistory);
        while (turn.length && turn[0].role !== 'user') turn.shift(); // keep the window starting on a user turn
        s.conversations[key] = turn;
        persist();
        return reply;
    }

    /** Answers one message in `conversation` (any string: "web:Skyler", "telegram:123"). Resolves to the text to send back. */
    function handle(conversation, text, { owner: who } = {}) {
        const key = String(conversation || 'web').slice(0, 120);
        const message = String(text || '').trim().slice(0, MAX_TEXT_CHARS);
        if (!message) return Promise.resolve('');
        return enqueue(key, async () => {
            const cmd = message.match(/^\/([a-z]+)(?:@\S+)?\s*([\s\S]*)$/i);
            if (cmd) {
                const out = command(key, cmd[1].toLowerCase(), cmd[2].trim());
                if (out !== null) return out;
            }
            return chat(key, message, who || owner);
        });
    }

    return {
        handle,
        name,
        owner,
        notes: () => load().notes.slice(),
        history: (conversation) => (load().conversations[String(conversation)] || []).slice(),
        summary: () => {
            const s = load();
            return { name, owner, notes: s.notes.length, conversations: Object.keys(s.conversations).length };
        },
    };
}

/** The message inside an error body ({"error":{"message":...}} or plain text), short enough for a chat reply. */
function errorText(body) {
    let message = String(body || '');
    try {
        const parsed = JSON.parse(message);
        const err = parsed && parsed.error;
        message = (err && (err.message || err)) || message;
    } catch { /* plain text */ }
    message = String(message).replace(/\s+/g, ' ').trim();
    return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/**
 * The model call for the assistant: a loopback POST to this Interceptor's /v1/chat/completions, signed as the
 * the person it bills (the logged-in owner on the web page, else ASSISTANT_OWNER), so routing, usage and their credential apply as for any chat.
 */
function loopbackAsk({ owner, port = 3000, profile = '', fetchImpl = fetch, timeoutMs = Number(process.env.ASSISTANT_TIMEOUT_MS) || 300000 }) {
    return async (messages, { owner: who } = {}) => {
        const headers = { 'content-type': 'application/json', ...internalAuth.headersFor(who || owner) };
        if (profile) headers['x-harness-profile'] = profile;
        const res = await fetchImpl(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ messages, stream: false }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`the harness answered ${res.status}: ${errorText(text)}`);
        const body = JSON.parse(text);
        return (body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content) || '';
    };
}

module.exports = { createAssistant, fileStore, memoryStore, loopbackAsk, systemPrompt, HELP, MAX_HISTORY };
