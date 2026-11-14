// The assistant page: a conversation with the owner's assistant (utils/assistant.js), its notes and its channels.
// Replies are shown as plain text, never as HTML.
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
        el.textContent = content;
        log.appendChild(el);
        log.scrollTop = log.scrollHeight;
        return el;
    }

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

    async function loadHistory() {
        const { messages } = await api('api/assistant/history');
        log.replaceChildren();
        for (const m of messages) bubble(m.role === 'user' ? 'user' : 'assistant', m.content);
        if (!messages.length) bubble('assistant', 'Hello. Ask me anything, or send /help for the commands.');
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const message = text.value.trim();
        if (!message) return;
        text.value = '';
        send.disabled = true;
        bubble('user', message);
        const pending = bubble('assistant', 'Thinking…', 'pending');
        status.textContent = '';
        try {
            const { reply } = await api('api/assistant/message', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text: message }),
            });
            pending.textContent = reply;
            pending.classList.remove('pending');
            if (/^Saved note|^Forgot note|^Started a new/.test(reply)) refresh().catch(() => {});
        } catch (err) {
            pending.textContent = `Could not send: ${err.message}`;
            pending.classList.add('error');
        } finally {
            send.disabled = false;
            text.focus();
        }
    });

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
