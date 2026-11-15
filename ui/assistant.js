// The assistant page: a conversation with the owner's assistant (utils/assistant.js), its notes and its channels.
// Replies are drawn as Markdown with ui/markdown.js, which escapes every piece of model text before it adds a tag
// (links open only http(s) and mailto); your own messages and the notes stay plain text.
(() => {
    const $ = (id) => document.getElementById(id);
    const log = $('log');
    const form = $('form');
    const text = $('text');
    const send = $('send');
    const status = $('status');

    const api = async (path, options) => {
        const res = await fetch(path, { credentials: 'same-origin', ...options });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            // a proxy in front of the app answers 502 with a plain page: say what that usually means
            if (body && body.error) throw new Error(body.error);
            if ([502, 503, 504].includes(res.status)) throw new Error(`the server did not answer (HTTP ${res.status}). It may be restarting or waking from sleep; try again in a moment.`);
            throw new Error(`HTTP ${res.status}`);
        }
        return body || {};
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
        for (const m of messages) bubble(m.role === 'user' ? 'user' : 'assistant', m.content);
        if (!messages.length) bubble('assistant', 'Hello. Ask me anything, or send /help for the commands.');
        setPending(pending);
    }

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const message = text.value.trim();
        if (!message) return;
        text.value = '';
        sendMessage(message);
    });
    $('allow').addEventListener('click', () => sendMessage('/yes'));
    $('decline').addEventListener('click', () => sendMessage('/no'));

    async function sendMessage(message) {
        send.disabled = true;
        $('allow').disabled = true;
        $('decline').disabled = true;
        bubble('user', message);
        const pending = bubble('assistant', 'Thinking…', 'pending');
        status.textContent = '';
        try {
            const { reply, pending: waiting } = await api('api/assistant/message', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text: message }),
            });
            pending.classList.remove('pending');
            draw(pending, reply);
            setPending(waiting);
            if (/^Saved note|^Forgot note|^Started a new/.test(reply)) refresh().catch(() => {});
        } catch (err) {
            pending.classList.add('error');
            draw(pending, `Could not send: ${err.message}`);
        } finally {
            send.disabled = false;
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
