# Personal assistant

A personal assistant is one agent that keeps notes and remembers each conversation. You can reach it on the **Assistant** page (`/ui/assistant.html`), on Telegram, and in Slack. Every channel goes through the same routing, so the model it uses is whatever your routing picks. On the web page the logged-in owner's key pays; on Telegram and Slack the configured `ASSISTANT_OWNER` pays.

## Commands

| Send | Does |
|---|---|
| `/remember TEXT` | Saves a note. Notes go into the assistant's instructions in every conversation. |
| `/notes` | Lists the notes with their numbers. |
| `/forget N` | Drops note N. |
| `/reset` | Starts a new conversation. Notes are kept. |
| `/help` | Lists the commands. |

Anything else goes to the model with the last 40 messages of that conversation. Each channel is its own conversation: the web page, each Telegram chat and each Slack channel or direct message.

## Setup

1. Pick the owner. Set `ASSISTANT_OWNER` to the login name whose key and routing the assistant uses (logins on: `HARNESS_REQUIRE_LOGIN=1`). Without logins it can stay as the default. Only that person, or an admin, can use the Assistant page when logins are on.
2. Set `ASSISTANT_FILE` if the state should live somewhere specific. It is one JSON file (`assistant.json` by default, git-ignored), written atomically. A file that cannot be read is reported as an error and is never overwritten.
3. Add a channel (below) and restart the Interceptor (`npm run all`, or the server process).

Startup prints `Assistant channels: Telegram polling, Slack off` and warns about anything missing.

### Telegram

1. Make a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token into `TELEGRAM_BOT_TOKEN`.
2. Send the bot any message. The server log then names the chat id of a stranger it refused, which you put in `TELEGRAM_ALLOWED_CHAT_IDS`. An empty list means the bot answers nobody.
3. By default the server **polls** Telegram, so it works from a laptop with no public address. Polling does not count as activity for the idle stop, so on a hosted machine that sleeps when idle use the webhook (step 4): polling stops with the process.
4. On a server with a public https address, set `TELEGRAM_WEBHOOK_SECRET` to a random string and point the webhook there:
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR-ADDRESS/ui/api/assistant/telegram&secret_token=<SECRET>`.

### Slack

1. Create a Slack app with a bot user. Add the bot scopes `chat:write`, `im:history`, `app_mentions:read`.
2. Turn on **Event Subscriptions** with the request URL `https://YOUR-ADDRESS/ui/api/assistant/slack` (Slack checks it at once; it needs the server reachable, e.g. through the Cloudflare tunnel in [Run it on a server](server-docker.md)). Subscribe to the bot events `message.im` and `app_mention`.
3. Install the app to the workspace. Put the bot token (`xoxb-…`) in `SLACK_BOT_TOKEN`, the signing secret in `SLACK_SIGNING_SECRET`, and the user ids of the people who may talk to it in `SLACK_ALLOWED_USER_IDS`.

The bot answers direct messages, and in channels it answers when mentioned (`@assistant …`). Slack resends an event it thinks was missed; the copy is acknowledged and not answered twice.

## Security

- Channel routes sit before the login gate, and each checks its own proof: Telegram a secret header, Slack a signature over the raw body with a five-minute clock window. Messages from anyone else are ignored.
- The model call is a loopback request signed with the per-process secret in `utils/internalAuth.js`, so it cannot be forged from outside.
- Notes and replies are plain text in the web page; nothing a model writes is rendered as HTML.

## Not built yet

- The assistant cannot yet use the harness's tools (MCP, repos, agents) on its own. It answers from its model and its notes.
- Telegram and Slack are stub-tested only; they have not been run against the real APIs.
- Notes are one shared list for the owner; there is no per-channel separation or search.

Code: `utils/assistant.js` (notes, conversations, loopback call), `utils/assistantChannels.js` (Telegram and Slack), `ui/assistant.html`, and the routes in `server.js` (`/ui/api/assistant*`). Tests: `test/assistant.test.js`, `test/assistantChannels.test.js`.
