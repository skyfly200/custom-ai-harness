// The assistant page: a conversation with the owner's assistant (utils/assistant.js), its notes and its channels.
// Replies are drawn as Markdown with ui/markdown.js, which escapes every piece of model text before it adds a tag
// (links open only http(s) and mailto); your own messages and the notes stay plain text. Replies stream in as the
// model writes them (ui/assistant-stream.js), and Stop ends one where it is.
(() => {
    const $ = (id) => document.getElementById(id);
    const log = $('log');
    const form = $('form');
    const text = $('text');
    const send = $('send');
    const status = $('status');

    const api = async (path, options) => {
        const res = await fetch(path, { credentials: 'same-origin', ...options });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        return body;
    };

    function bubble(role, content, extra) {
        const el = document.createElement('div');
        el.className = `bubble ${role}${extra ? ` ${extra}` : ''}`;
        draw(el, content);
        log.appendChild(el);
        log.scrollTop = log.scrollHeight;
        return el;
    }

    function draw(el, content) {
        const md = window.Markdown;
        const asMd = md && el.classList.contains('assistant') && !el.classList.contains('pending') && !el.classList.contains('error');
        el.classList.toggle('md', Boolean(asMd));
        if (asMd) el.innerHTML = md.render(content);
        else el.textContent = content;
    }

    // the Copy button on a code block in a reply
    log.addEventListener('click', async (event) => {
        const b = event.target.closest('.copy-code');
        if (!b) return;
        const code = b.closest('.code')?.querySelector('pre')?.textContent || '';
        try { await navigator.clipboard.writeText(code); b.textContent = 'Copied'; } catch { b.textContent = 'Could not copy'; }
        setTimeout(() => { b.textContent = 'Copy'; }, 1500);
    });

    function renderNotes(notes) {
        const list = $('notes');
        list.replaceChildren(...notes.map((note) => {
            const li = document.createElement('li');
            li.textContent = note.text;
            return li;
        }));
        $('empty').classList.toggle('hidden', notes.length > 0);
    }

    function renderChannels(channels, problems) {
        const labels = { telegram: { webhook: 'Telegram (webhook)', polling: 'Telegram (polling)', off: 'Telegram: off' }, slack: { events: 'Slack', off: 'Slack: off' }, discord: { gateway: 'Discord', off: 'Discord: off' } };
        const items = [
            labels.telegram[channels.telegram] || `Telegram: ${channels.telegram}`,
            labels.slack[channels.slack] || `Slack: ${channels.slack}`,
            labels.discord[channels.discord] || `Discord: ${channels.discord}`,
            ...problems,
        ];
        $('channels').replaceChildren(...items.map((label) => {
            const li = document.createElement('li');
            li.textContent = label;
            return li;
        }));
    }

    async function refresh() {
        const info = await api('api/assistant');
        renderNotes(info.notes || []);
        renderChannels(info.channels || {}, info.problems || []);
        return info;
    }

    // A tool call waiting for /yes or /no: show the question with Allow and Decline, so nobody has to type /yes
    const ask = $('ask');
    function setPending(question) {
        ask.classList.toggle('hidden', !question);
        $('askText').textContent = question || '';
        if (question) log.scrollTop = log.scrollHeight;
    }

    async function loadHistory() {
        const { messages, pending } = await api('api/assistant/history');
        log.replaceChildren();
        for (const m of messages) bubble(m.role === 'user' ? 'user' : 'assistant', m.content, m.stopped ? 'stopped' : '');
        if (!messages.length) bubble('assistant', 'Hello. Ask me anything, or send /help for the commands.');
        setPending(pending);
    }

    // While a reply streams, Send is a Stop button; Enter waits, so a half-typed next message is not lost.
    let controller = null;
    function setStreaming(on) {
        send.textContent = on ? 'Stop' : 'Send';
        send.setAttribute('aria-label', on ? 'Stop the reply' : 'Send');
    }
    send.addEventListener('click', (event) => {
        if (!controller) return;
        event.preventDefault();
        controller.abort();
    });
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (controller) return;
        const message = text.value.trim();
        if (!message) return;
        text.value = '';
        sendMessage(message);
    });
    $('allow').addEventListener('click', () => sendMessage('/yes'));
    $('decline').addEventListener('click', () => sendMessage('/no'));

    // Streams the reply into its bubble (ui/assistant-stream.js reads the events; a server without the stream route
    // gets the plain one). The final text replaces what streamed, since a step that ended in a tool call can leave
    // text the answer does not keep. Stop keeps what streamed, as the server does.
    const post = (route, message, signal) => fetch(route, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: message }),
        signal,
    });
    async function sendMessage(message) {
        if (controller) return;
        const lib = window.AssistantStream;
        controller = new AbortController();
        setStreaming(true);
        $('allow').disabled = true;
        $('decline').disabled = true;
        bubble('user', message);
        const pending = bubble('assistant', 'Thinking…', 'pending');
        status.textContent = '';
        let streamed = '';
        let queued = false;
        let finished = false; // a late frame must not paint the streamed text over the final reply
        const paint = () => {
            queued = false;
            if (finished) return;
            const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
            pending.classList.toggle('pending', !streamed);
            draw(pending, streamed || 'Thinking…');
            if (follow) log.scrollTop = log.scrollHeight;
        };
        try {
            const { signal } = controller;
            let res = await post('api/assistant/stream', message, signal);
            if (res.status === 404) res = await post('api/assistant/message', message, signal);
            const { reply, pending: waiting } = await lib.readReply(res, {
                onText: (t) => { streamed = t; if (!queued) { queued = true; requestAnimationFrame(paint); } },
            });
            finished = true;
            pending.classList.remove('pending');
            draw(pending, String(reply ?? ''));
            log.scrollTop = log.scrollHeight;
            setPending(waiting);
            if (/^Saved note|^Forgot note|^Started a new/.test(reply)) refresh().catch(() => {});
        } catch (err) {
            finished = true;
            pending.classList.remove('pending');
            if (lib.isAbort(err)) {
                if (streamed) { draw(pending, streamed); pending.classList.add('stopped'); } else pending.remove();
                setPending(null); // a stopped /yes or /no is answered; the history has the rest
            } else {
                pending.classList.add('error');
                draw(pending, `Could not send: ${err.message}`);
            }
        } finally {
            controller = null;
            setStreaming(false);
            $('allow').disabled = false;
            $('decline').disabled = false;
            text.focus();
        }
    }

    text.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            form.requestSubmit();
        }
    });

    (async () => {
        try {
            await refresh();
            await loadHistory();
        } catch (err) {
            status.textContent = err.message === 'the assistant is for its owner'
                ? 'The assistant is for its owner. Sign in as them to use it here.'
                : `Could not load the assistant: ${err.message}`;
        }
    })();
})();
