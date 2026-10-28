# Dashboard, settings and usage

The Bright Chat dashboard, the Settings page and the Usage page. Back to the [README](../README.md).

## Control UI

The web app is called **Bright Chat**. Its pages draw a slowly turning "embedding space" in the background: words with similar meanings sit in clusters, and the mouse acts as a query that lights up its nearest neighbours. The dots-and-lines button at the end of the page links turns it off (your choice is kept in the browser). On the Chat page it starts off so chats stay fast; the same button turns it on there, and it stays still when Windows or your browser asks for reduced motion (Windows: Settings → Accessibility → Visual effects → Animation effects).

With the Interceptor running, open <http://localhost:3000/> (the pages are also at `/ui/…`, so older links keep working; on a server, use its site root, e.g. `https://agents.example.com/`). The dashboard refreshes every 3 seconds and shows:

- **Components**: whether the Router, Gateway, local engine (port 8000), Ollama (11434) and a local Laya (8001) answer, and which classifier the Router is using. The last three are optional and show as "not running" rather than down.
- **Counters** since the Interceptor started: requests, times the Router couldn't be reached, Gateway fallbacks, errors, rate-limited requests and timeouts.
- **Recent chats**: the latest chats saved in this browser, with their project; click one to open it on the chat page.
- **Usage, last 7 days**: spend, requests (and how many were free), tokens, and the models that used the most, from the same totals as the Usage page.
- **Recent routing decisions**: the model each request went to and why (win rate against threshold, tool requests, a pinned model, or the Router being down), the Gateway's status and time to first byte, how many fallbacks LiteLLM tried and which model group answered (from LiteLLM's `x-litellm-attempted-fallbacks` and `x-litellm-model-group` headers, when your LiteLLM version sends them), and the start of the typed request. A failed request shows why: **rate limit** (a 429 or a provider quota message, quoted), **timeout**, **gateway down**, or **stopped** when the client cancelled it.

<http://localhost:3000/ui/settings.html> (**Settings** in the menu) holds the settings that used to sit on the dashboard:

- **Interceptor settings**: pin every request to one model (skipping the Router), replace the keyword threshold with a fixed one, the output-token cap, the Router timeout, the Gateway timeout and the stalled-reply timeout (after which a request fails with an error instead of hanging), the models used when the Router is down, and switches for the caveman prompt, Headroom and the context anchor. They apply on the next request and are saved to `harness-settings.json` (gitignored); delete it or press "Reset to defaults" to go back.
- **Router settings**: the strong, weak, tool and overflow models, the weak model's size limit, the classifier backend and its settings (base URL, model, API key variable name, timeout, and so on). **Apply** lasts until the Router restarts; **Apply and save to file** also writes them to `routellm-config.yaml`, editing only those lines and keeping your comments (a cleared setting is commented out); **Reload from file** picks up edits you made by hand. A change that fails to build the classifier leaves the running one in place.

Model fields suggest the names from the Gateway's `/v1/models` (or `config.yaml` when the Gateway is down). The Gateway's own fallback chain still lives in `config.yaml`.

### Usage

<http://localhost:3000/ui/usage.html> shows how many tokens went where, for today, the last 7 or 30 days, or all time:

- **Flow through the harness**: clients (Claude Code, the chat page, Aider, other API clients) into the Interceptor, how the model was picked (the Router, a pinned model, the client's choice, or the Router being down), then the Gateway and the service that answered (OpenRouter, Groq, Ollama, the local engine...). Line widths follow the tokens.
- **Sankey diagram**: client → model asked for → model that served it (after any Gateway fallbacks) → service, coloured by service.
- **Costs**: spend for the range, the 30-day pace it is on, the cost per request and per million tokens, and how many requests went to free or local models. Prices come from the Gateway's price list (`/v1/model/info`) for the model that answered; models with no listed price show `?` and are left out of the totals. Cached input is counted at the full input price, so the figures can run a little high for Anthropic models.
- **Over time**: a bar per day, split by the service that answered.
- **Bars and a table** of input, cached input and output tokens, requests and cost by model and by service. A switch sizes every chart by all tokens, input, output, request counts or cost.

The counts are the ones each reply reports (`usage` in OpenAI replies, `input_tokens`/`output_tokens` in Anthropic ones, streamed or not), read one way everywhere by `ui/tokens.js`, so the chat page, this page and the dashboard always agree. A stream reports usage in pieces, so the largest of each count is kept. Replies without any, such as OpenAI streams that don't ask for `stream_options.include_usage`, are estimated from the request that was sent and the text that came back (about 4 characters a token) and marked ~. The chat page counts a reply as it arrives, not only when it ends. The service for each model comes from its `litellm_params` in `config.yaml`. Totals are kept per day in `harness-usage.json` (gitignored) so they survive a restart; **Clear totals** on the page empties it. The page updates live as requests finish, and the dashboard's routing log shows the same in/out counts per request.

History is kept in memory (the last 200 requests) and starts fresh when the Interceptor restarts. Override the probed addresses with `LOCAL_ENGINE_URL`, `OLLAMA_URL` and `LAYA_URL` in `.env`. The pages have no login. The Interceptor listens on every network interface, so other machines that can reach port 3000 can view them and chat, but settings only change from requests made on this machine.
