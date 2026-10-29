// Dictation text handling, kept pure so it can be tested without a browser.
//
// Chrome on desktop hands each SpeechRecognition event only the results that
// changed (resultIndex), but Chrome on Android re-sends the whole utterance:
// results arrive cumulative ("hello", "hello how", "hello how are you") and
// often all marked final. Adding every final result to the box repeats the
// text, so a session's text is rebuilt from the full result list each time and
// a result that extends or repeats the one before it replaces it.
(function (root) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const key = (s) => norm(s).toLowerCase();

  /**
   * @param {Array<{transcript:string,isFinal:boolean}>} results  event.results, flattened to the best alternative
   * @returns {{final:string, interim:string}} everything said in this recognition session
   */
  function sessionText(results) {
    const finals = [];
    let interim = '';
    for (const r of results) {
      const t = norm(r.transcript);
      if (!t) continue;
      if (!r.isFinal) { interim = joinText(interim, t, true); continue; }
      const last = finals[finals.length - 1];
      if (last !== undefined) {
        if (key(t).startsWith(key(last))) { finals[finals.length - 1] = t; continue; }  // extends the one before
        if (key(last).startsWith(key(t))) continue;                                    // stale shorter repeat
      }
      finals.push(t);
    }
    let final = finals.join(' ');
    // interim text that merely repeats the end of what is final is dropped
    interim = norm(interim);
    if (interim && key(final).endsWith(key(interim))) interim = '';
    else if (interim && final && key(interim).startsWith(key(final))) interim = norm(interim.slice(final.length));
    return { final, interim };
  }

  // Interim results of one utterance are often several partials; the longest
  // one that extends the others wins, otherwise they are joined
  function joinText(a, b, interim) {
    if (!a) return b;
    if (interim && key(b).startsWith(key(a))) return b;
    return norm(a + ' ' + b);
  }

  // The composer's text: what was there before this session plus what was said
  function compose(base, session) {
    const spoken = [session.final, session.interim].filter(Boolean).join(' ');
    if (!spoken) return base;
    return (base && !/\s$/.test(base) ? base + ' ' : base) + spoken;
  }

  // Message and what to do about each SpeechRecognition error code
  const ERRORS = {
    'not-allowed': { stop: true, text: 'The microphone is blocked. Click the lock icon next to the address, allow the microphone for this page, then try again (it needs https or http://localhost).' },
    'service-not-allowed': { stop: true, text: 'The browser will not run speech recognition here. Pick “Speech model” under Options → Voice, or allow it in the browser settings.' },
    'audio-capture': { stop: true, text: 'No microphone found, or another app is using it. Plug one in or close the other app, then try again.' },
    'language-not-supported': { stop: true, text: 'The browser does not support that dictation language. Change it under Options → Voice.' },
    'bad-grammar': { stop: true, text: 'Dictation failed: the browser rejected its settings.' },
    network: { stop: true, text: 'The browser could not reach its speech service (check the internet connection, or pick “Speech model” under Options → Voice).' },
    'no-speech': { stop: false, text: '' },
    aborted: { stop: false, text: '' },
  };
  const describeError = (code) => ERRORS[code] || { stop: true, text: `Dictation stopped: ${code || 'unknown error'}.` };

  // Android's recogniser mishandles continuous mode (the repeats above, and it
  // can stop delivering results), so there one phrase at a time is requested
  // and onend restarts it
  const wantsContinuous = (ua) => !/android/i.test(String(ua || ''));

  // A readable message from whatever failed: a string, an Error, a DOMException,
  // or a server reply such as {error:"..."} or {error:{message:"..."}}
  // (never "[object Object]")
  function errText(x, status) {
    const pick = (v) => {
      if (!v) return '';
      if (typeof v === 'string') return v;
      if (typeof v.message === 'string' && v.message) return v.message;
      if (v.error) return pick(v.error);
      if (typeof v.name === 'string' && v.name) return v.name;
      if (typeof v.type === 'string' && v.type && v.type !== 'error') return v.type;
      try { const j = JSON.stringify(v); return j && j !== '{}' ? j.slice(0, 200) : ''; } catch { return ''; }
    };
    return pick(x) || (status ? `HTTP ${status}` : 'unknown error');
  }

  const api = { errText, sessionText, compose, describeError, wantsContinuous };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DictationText = api;
})(typeof window !== 'undefined' ? window : globalThis);
