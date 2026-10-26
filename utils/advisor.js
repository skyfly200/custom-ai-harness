// The advisor: a better model a chat's cheaper model can call for a second
// opinion. Set one with "/advisor MODEL" in the chat page (the model is any name
// the Gateway serves, short or full; "opus" finds the newest Opus). From then on
// that chat's model gets an "ask_advisor" tool and can hand it the part it is
// unsure about. The advisor answers once, in words, with no tools of its own: it
// reads what the cheaper model sends and says what it would do. That keeps the
// expensive model's part small, so the cost stays near the cheap one's.
//
// The advisor is stored with the chat in the browser (like a skill or a command),
// and each call goes through the Interceptor like any other request, so routing
// headers name the advisor's model and its cost shows up in the chat's totals.
//
// This module only shapes the request and the answer; the page makes the call.

const MAX_CHARS = 12000;   // how much of the cheaper model's question the advisor reads
const MAX_REPLY = 8000;    // how much of the advisor's answer goes back to the model

const DEFINITION = {
    type: 'function',
    function: {
        name: 'ask_advisor',
        description: 'Ask a stronger model for a second opinion on a hard part of this task: a design choice, a bug you cannot find, a piece of code you are unsure about. Send the question and the code or error text it needs. The advisor answers in words and cannot run tools or change files. Ask once or twice, not for every step.',
        parameters: {
            type: 'object',
            properties: {
                question: { type: 'string', description: 'What you want the advisor to weigh in on, as a clear question' },
                context: { type: 'string', description: 'The code, error message or notes the advisor needs to answer. Paste it rather than naming a file: the advisor cannot read the repo.' },
            },
            required: ['question'],
        },
    },
};

/** The advisor's system prompt: a reviewer that answers in words, briefly. */
function system(advisor) {
    const note = String(advisor?.note || '').trim();
    return `You are an advisor to another AI agent that is doing the actual work in a code repository. It asks you about the part it is unsure of. Answer as a careful senior engineer: say what is wrong, missing or risky first, then what you would do instead. Be brief and concrete, name the exact change or the next check to run, and say plainly when it looks fine. You cannot read the repo or run anything: work from what the agent sends you, and say what you would need to know if that is not enough.${note ? `\n\nHow this person wants advice: ${note}` : ''}`;
}

/** What the agent sends, as one user message: the question first, then its context. */
function prompt(args) {
    const question = String(args?.question || '').trim();
    const context = String(args?.context || '').trim();
    if (!question) throw new Error('question is required');
    let text = question;
    if (context) {
        const cut = context.length > MAX_CHARS ? `${context.slice(0, MAX_CHARS)}\n… (cut at ${MAX_CHARS} characters)` : context;
        text += `\n\nContext the agent sent:\n${cut}`;
    }
    return text;
}

/** The request the page makes to the Interceptor for one advisor call. */
function request(advisor, args, { history = [] } = {}) {
    if (!advisor?.model) throw new Error('no advisor is set: use /advisor MODEL first');
    return {
        model: advisor.model,
        stream: false,
        messages: [
            { role: 'system', content: system(advisor) },
            ...(Array.isArray(history) ? history.slice(-2) : []),
            { role: 'user', content: prompt(args) },
        ],
        headers: { 'x-harness-model': advisor.model, ...(advisor.effort ? { 'x-harness-effort': advisor.effort } : {}) },
    };
}

/** The advisor's answer as the tool result the agent reads. */
function answer(body) {
    const text = body?.choices?.[0]?.message?.content;
    const said = typeof text === 'string' ? text.trim() : '';
    const cost = body?.usage?.cost ?? body?.cost;
    const spent = typeof cost === 'number' ? cost : null;
    if (!said) return { text: 'The advisor answered with nothing. Work it out yourself, or ask again with the question in one sentence.', isError: true, cost: spent };
    return { text: said.length > MAX_REPLY ? `${said.slice(0, MAX_REPLY)}\n… (cut at ${MAX_REPLY} characters)` : said, isError: false, cost: spent };
}

/** "/advisor MODEL" -> the advisor setting; throws with a readable message. */
function setFrom(name, models = []) {
    const model = String(name || '').trim();
    if (!model) throw new Error('name a model to advise this chat, e.g. /advisor opus');
    return { model };
}

module.exports = { DEFINITION, system, prompt, request, answer, setFrom, MAX_CHARS, MAX_REPLY };
