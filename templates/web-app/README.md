# {{name}}

{{description}}

Audience: {{audience}}

## Run it

```
npm install
npm start
```

Then open http://localhost:3200. The page talks to `/api/chat`, which calls the harness.

## Settings

| Variable | What it does |
| --- | --- |
| `PORT` | The port to listen on (default 3200) |
| `HARNESS_URL` | Where the harness is (default http://127.0.0.1:3000) |
| `HARNESS_APP_KEY` | The key the chat route sends to the harness. Keep it in `.env`, never in the page. |
| `HARNESS_PROFILE` | A routing profile name to send as `x-harness-profile` (optional) |

## Tests

```
npm test
```
