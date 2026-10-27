// Saving a chat page's reply on the server, so it survives the tab closing mid-answer.
//
// The chat page sends x-harness-chat-id and x-harness-message-id (the id of the assistant message it is
// writing) on a reply's first request. When the reply ends, or the connection to the page drops, the
// Interceptor has the text and saves it as that message. The page saves its own, richer copy as it goes;
// the server's only lands if the page's last save of that message still says "streaming", and a few
// seconds after the reply ends so a page that is still there has finished its own save first.
const db = require('./db');

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MSG_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const DELAY_MS = Number(process.env.HARNESS_REPLY_SAVE_DELAY_MS) >= 0 ? Number(process.env.HARNESS_REPLY_SAVE_DELAY_MS) : 4000;

const SAVE = `
WITH chat AS (SELECT 1 FROM chats WHERE owner = $1 AND id = $2 AND deleted_at IS NULL),
ins AS (
  INSERT INTO chat_messages (owner, chat_id, id, data, updated)
  SELECT $1, $2, $3, $4::jsonb, $5::bigint WHERE EXISTS (SELECT 1 FROM chat)
  ON CONFLICT (owner, chat_id, id) DO UPDATE SET data = EXCLUDED.data, updated = EXCLUDED.updated
    WHERE chat_messages.data->>'streaming' = 'true'
  RETURNING 1)
UPDATE chats SET
  msg_order = CASE WHEN jsonb_exists(msg_order, $3) THEN msg_order ELSE msg_order || to_jsonb($3::text) END,
  updated = $5::bigint, version = version + 1
WHERE owner = $1 AND id = $2 AND EXISTS (SELECT 1 FROM ins)
RETURNING version`;

let pending = 0;
const busy = () => pending > 0;

async function save({ owner, chatId, messageId, text, model, aborted }) {
    const now = Date.now();
    const content = aborted ? `${text}\n\n*(cut off: the page closed before the reply finished)*` : text;
    const message = { id: messageId, role: 'assistant', content, time: now, model, serverSaved: true };
    const { rows } = await db.query(SAVE, [owner, chatId, messageId, JSON.stringify(message), now]);
    return rows.length > 0;
}

/**
 * Called when a reply has ended. `req` is the request that asked for it; does nothing unless it carried the ids,
 * the reply said something, and there is a database.
 */
function afterReply(req, { text, model, aborted }) {
    if (!db.enabled() || !text || !String(text).trim()) return;
    const chatId = String(req.headers['x-harness-chat-id'] || '');
    const messageId = String(req.headers['x-harness-message-id'] || '');
    if (!ID.test(chatId) || !MSG_ID.test(messageId)) return;
    const owner = (req.harnessUser && req.harnessUser.name) || 'local';
    pending++;
    setTimeout(() => {
        save({ owner, chatId, messageId, text: String(text), model, aborted })
            .catch((err) => console.error(`[reply-save] ${chatId}/${messageId}: ${err.message}`))
            .finally(() => { pending--; });
    }, DELAY_MS);
}

module.exports = { afterReply, save, busy };
