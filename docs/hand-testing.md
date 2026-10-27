# Hand testing checklist

Use this for a quick manual validation pass on a real phone or tablet. It is intentionally focused on the live behavior that is easy to miss in automated tests.

1. Open the tunnel address at `/ui/chat.html`.
   - Expect a password prompt, then Bright Chat.
   - A wrong password must be refused.
2. Send a short message.
   - Expect a streamed reply and the routing note under it naming the model.
3. Install it.
   - Android Chrome menu → Install app.
   - iPhone Safari Share → Add to Home Screen.
   - Expect an icon with the orb, and it opens full screen with no browser bar.
   - On an iPhone, the message box should clear the home bar.
4. Turn on airplane mode and open the installed app.
   - Expect the page to load and show an error when you send a message, not a blank screen.
   - Turn airplane mode off again after the check.
5. Open Dashboard, Usage and Routing from the top bar.
   - Expect them to fit the screen and scroll sideways only inside tables.
6. Try voice.
   - Allow the microphone, dictate a message, and use read-aloud on a reply.
   - Safari and Chrome differ here, so note which browser you used.
7. Hold a long chat request, lock the phone for a minute, then unlock it.
   - Expect the chat to resume or show a clear error, not hang.
8. From a computer, open `https://YOUR-ADDRESS/ui/api/status` with no password.
   - Expect a 401, never data.

This checklist is also referenced from the main README under the phone setup section.
