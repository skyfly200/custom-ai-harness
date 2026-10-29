# Named logins and API keys

Turn on named logins with admins, and give each program its own key. Back to the [README](../README.md).

## Named logins with admins (`HARNESS_REQUIRE_LOGIN`)

For more than one person, or to give each program its own key, turn on logins. This replaces the single shared password: every page, `/ui/api` and `/v1` request then needs a signed-in user.

1. Make a hash for each admin's password (the password is typed hidden, and only the hash is stored):

   ```powershell
   npm run hash
   ```

2. Put the admins in `.env`, as `name:hash` pairs separated by commas, and turn logins on:

   ```
   HARNESS_REQUIRE_LOGIN=1
   HARNESS_ADMINS=alice:scrypt.16384.AbC...,bob:scrypt.16384.XyZ...
   ```

3. Start the harness. Browsers are sent to a sign-in page and stay signed in for 7 days. If logins are on and `HARNESS_ADMINS` is empty or malformed, the harness refuses to start rather than run open.

Admins open **Users** (the name at the top right of every page, or Settings → Users and API keys) to add and remove users, reset passwords, make other users admins, and make API keys. Only admins can open Settings or use the controls (settings, routing, runs); other users get chat, the dashboard, usage, and the API. Usage is counted per person: everyone sees only their own on the Usage page and dashboard, and admins see everyone's on the All users usage page (see [Dashboard, settings and usage](control-ui.md)). Programs sign in with a key instead of a password: set Claude Code's `ANTHROPIC_AUTH_TOKEN` (or an OpenAI-style app's API key) to a key made on the Users page. HTTP Basic with a user name and password also works for programs that can't send a key. Keys and passwords are never passed on to the Gateway.

Users and keys are kept in `users.json` (`HARNESS_USERS_FILE`, in `./data` with Docker; it is gitignored and written private). Passwords and keys are stored only as hashes: a password with scrypt, a key with SHA-256 (keys are long random strings, shown once). Admins from `HARNESS_ADMINS` are changed in `.env`, not in the app. After 5 wrong passwords from one address or for one user name, sign-in waits 15 minutes. The session cookie is HttpOnly and SameSite=Lax, and Secure when the request came in over https (a tunnel or proxy). `HARNESS_PASSWORD`, if also set, keeps working as an admin key.
