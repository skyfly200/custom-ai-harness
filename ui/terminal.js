// The Runs page terminal: what the agent ran and what came back, drawn in xterm.js.
//
// transcript() is pure. It turns a run's events into terminal text (ANSI colours,
// \r\n line ends), and `after` lets the page ask for only what is new since the
// last draw, so the screen is appended to as the run goes on, not redrawn. It is a
// replay of the run's record, not a shell: nothing typed here reaches the sandbox.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RunTerminal = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const C = { dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m', off: '\x1b[0m' };
  const crlf = (s) => String(s ?? '').replace(/\r?\n/g, '\r\n');
  // the identity of an event, so the page can find where it left off
  const keyOf = (e) => `${e.t}|${e.type}|${e.name || ''}|${String(e.text || '').length}`;

  /** The text for one event; `ctx.tool` remembers the tool a result belongs to. */
  function lineFor(e, ctx) {
    switch (e.type) {
      case 'stage': return `${C.bold}${C.cyan}== ${e.text} ==${C.off}\r\n`;
      case 'note': return `${C.dim}# ${crlf(e.text)}${C.off}\r\n`;
      case 'warning': return `${C.yellow}! ${crlf(e.text)}${C.off}\r\n`;
      case 'plan': return `${C.dim}# plan${C.off}\r\n${crlf(e.text)}\r\n`;
      case 'approval_needed': return `${C.yellow}? waiting for you: ${crlf(e.text)} (${e.reason || 'risky'})${C.off}\r\n`;
      case 'approval': return `${e.allowed ? C.green : C.red}${e.allowed ? 'allowed' : 'declined'}: ${crlf(e.text)}${C.off}\r\n`;
      case 'tool': {
        ctx.tool = e.name;
        const a = e.args || {};
        const why = e.why ? `${C.dim}# ${crlf(e.why)}${C.off}\r\n` : '';
        if (e.name === 'run_command') return `${why}${C.green}$ ${crlf(a.command ?? '')}${C.off}\r\n`;
        if (e.name === 'finish') return '';
        return `${why}${C.dim}> ${e.name} ${crlf(a.path ?? '')}${C.off}\r\n`;
      }
      case 'result': {
        const tool = ctx.tool;
        ctx.tool = null;
        if (tool === 'run_command') {
          const m = /^(exit code (-?\d+)|timed out[^\n]*)\n?/.exec(e.text || '');
          const ok = m?.[2] === '0';
          const body = m ? e.text.slice(m[0].length) : e.text;
          return `${body ? `${crlf(body.replace(/\n+$/, ''))}\r\n` : ''}${ok ? C.dim : C.red}[${m ? m[1] : 'done'}]${C.off}\r\n`;
        }
        // a read, a listing or a write: one dim line, not the whole file
        return `${C.dim}  ${crlf(String(e.text || '').split('\n')[0].slice(0, 120))}${C.off}\r\n`;
      }
      default: return '';
    }
  }

  /**
   * Terminal text for the events after the one keyed `after` (all of them when it is
   * null or no longer in the list). Returns { text, last, reset }: `reset` is true when
   * the old position was lost (the list was trimmed) and the screen should be cleared first.
   */
  function transcript(events, after = null) {
    const list = events || [];
    let from = 0;
    let reset = false;
    if (after) {
      const at = list.map(keyOf).lastIndexOf(after);
      if (at >= 0) from = at + 1; else reset = true;
    }
    // the tool a result answers may sit just before `from`
    const ctx = { tool: null };
    for (let i = Math.max(0, from - 1); i < from; i++) if (list[i].type === 'tool') ctx.tool = list[i].name;
    const text = list.slice(from).map((e) => lineFor(e, ctx)).join('');
    return { text, last: list.length ? keyOf(list[list.length - 1]) : null, reset };
  }

  /** Draws the transcript of the selected run into `host`, creating xterm on first use. */
  function mount(host) {
    let term = null;
    let fit = null;
    let runId = null;
    let last = null;
    const make = () => {
      const dark = !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
      term = new window.Terminal({ convertEol: false, disableStdin: true, cursorBlink: false, cursorStyle: 'underline', fontSize: 13, scrollback: 5000,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        theme: dark ? { background: '#0b0a14', foreground: '#e6e3f5' } : { background: '#14121f', foreground: '#ece9fa' } });
      fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(host);
      const refit = () => { try { if (host.offsetWidth) fit.fit(); } catch { /* hidden */ } };
      if (window.ResizeObserver) new ResizeObserver(refit).observe(host);
      window.addEventListener('resize', refit);
      host._refit = refit;
      refit();
    };
    return {
      /** Show `run`'s events; pass null to clear. */
      update(run) {
        if (!window.Terminal || !window.FitAddon) return;
        if (!term) make();
        if (!run) { term.reset(); runId = last = null; return; }
        const different = run.id !== runId;
        if (different) { term.reset(); last = null; runId = run.id; }
        const t = transcript(run.events, last);
        if (t.reset) term.reset();
        if (t.text) term.write(t.text);
        last = t.last;
      },
      refit() { host._refit?.(); },
      get term() { return term; },
    };
  }

  return { transcript, lineFor, mount, keyOf };
}));
