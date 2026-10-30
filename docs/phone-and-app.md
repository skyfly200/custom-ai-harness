# Phone and installable app

Install Bright Chat as an app and reach it from your phone over https with a Cloudflare tunnel. Back to the [README](../README.md).

### Install Bright Chat as an app

Bright Chat can be installed so it opens in its own window, with its own icon, like any other app. It needs the page to be opened at `http://localhost:3000/ui/chat.html` or over `https://` (a server behind a tunnel or Tailscale `serve`; see [Reach it from your phone](#reach-it-from-your-phone)); a plain `http://` address on your network can't be installed.

| Where | How |
|---|---|
| Chrome or Edge on a computer | Click the **Install app** button in the top bar, or the install icon at the right end of the address bar |
| Chrome on Android | Menu (⋮) → **Install app** (or **Add to Home screen**) |
| Safari on iPhone or iPad | Share → **Add to Home Screen** |

The installed app opens the chat page, and the Dashboard, Usage, Routing and Settings pages are shortcuts on its icon. It still needs the harness running: the app keeps a copy of the pages so it opens when the harness is slow or off, but chats and answers come from the harness and are never stored by the app. If you set `HARNESS_PASSWORD`, the app asks for it the same way the browser does.

**Phone layout.** `ui/mobile.css` (loaded last on every page) makes the pages fit a small screen: the pages bar is one row that scrolls sideways instead of vanishing, buttons and fields are sized for a finger, dialogs and drawers fit the visible screen (with safe-area insets), and the chat is one full-height column. On a touch screen the help text under a field is folded away until you tap into it, so forms stay short.

## Reach it from your phone

To use Bright Chat from a phone, or any device that isn't yours, over `https://`, run a **Cloudflare tunnel**. It is a small program next to the harness that connects out to Cloudflare, which gives you a normal `https://` address that reaches the harness. Nothing on your router or server needs opening, and the address works for installing the app. [Tailscale](server-docker.md#run-it-on-a-server-docker) is the more private option, but the phone needs the Tailscale app; a tunnel only needs a browser.

**Set a password first.** A tunnel puts the harness on the internet, and anyone who finds the address could spend your API credit. Put `HARNESS_PASSWORD=` followed by a password of your own in `.env` before starting it. As a safety net the harness refuses requests that come through a Cloudflare tunnel while no password is set, and its controls (settings, clearing usage) never count a tunnelled request as "this machine".

### Try it with no account (a random address)

This gives an address like `https://random-words.trycloudflare.com` that changes each time you start it, which is enough to test from a phone.

- **Docker server:** add `COMPOSE_PROFILES=tunnel-quick` to `.env` (or `local,tunnel-quick` next to local models), run `docker compose up -d`, then `docker compose logs tunnel-quick` and look for the `trycloudflare.com` address.
- **Your Windows PC:** with the harness running (`npm run all`), install the tunnel program once with `winget install Cloudflare.cloudflared`, then run `cloudflared tunnel --url http://localhost:3000` in another PowerShell window and copy the `trycloudflare.com` address it prints. Close the window to close the tunnel.

Cloudflare doesn't promise quick tunnels stay up, so use a named tunnel for anything you rely on.

### A permanent address (free Cloudflare account and a domain)

1. In the Cloudflare dashboard go to **Zero Trust → Networks → Tunnels → Create a tunnel** and choose **Cloudflared**. Name it, then copy the **token** from the install command it shows (the long text after `--token`). Keep it private, like a password.
2. Under **Public hostname**, add a hostname on your domain (for example `chat.example.com`) and set the service to `HTTP` and `harness:3000` (use `localhost:3000` if the tunnel program runs on your PC instead of in Docker).
3. Add to `.env`: `TUNNEL_TOKEN=` followed by the token, and `COMPOSE_PROFILES=tunnel`. Then run `docker compose up -d`.
4. Open `https://chat.example.com/ui/chat.html` on your phone. The browser asks for a user name (anything) and your `HARNESS_PASSWORD`.

**Cloudflare Access (optional, recommended).** In **Zero Trust → Access → Applications**, add a self-hosted application for the same hostname and allow only your own email. Cloudflare then asks you to sign in before the harness's own password prompt, so strangers never reach it. The catch: Claude Code and other tools can't sign in through that page, so either leave Access off and rely on the password for them, or give them a service token (Cloudflare's docs call this a "service token" policy) and set it with `ANTHROPIC_CUSTOM_HEADERS`.

### Phone test checklist

For the full manual validation checklist, see [docs/hand-testing.md](hand-testing.md). It covers the real phone checks for password flow, installability, offline behavior, dashboard fit, voice, resume-after-lock, and unauthenticated status access.
