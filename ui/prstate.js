// The state of a run's pull request, as one icon and label: open, draft, merged, closed, or with merge conflicts,
// plus what its checks say. The runner keeps the state (runner/prWatch.js); this only shows it. No DOM here, so the
// tests can read it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PrState = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  // GitHub's pull request glyph (16 px grid), drawn in the state's colour
  const GLYPH = '<path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/>';
  const NAMES = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed', unknown: 'Unknown' };
  const CHECKS = { passing: 'checks pass', failing: 'checks fail', pending: 'checks running', none: '' };

  /** { key, label, tone, checks, title } for a run's prState; null when there is no state yet. */
  function view(prState) {
    if (!prState) return null;
    const status = prState.status || 'unknown';
    const key = prState.conflict === true && (status === 'open' || status === 'draft') ? 'conflict' : status;
    const label = key === 'conflict' ? 'Merge conflicts' : NAMES[status] || NAMES.unknown;
    const checks = CHECKS[prState.checks] || '';
    const tone = key === 'conflict' ? 'warn' : key === 'merged' ? 'merged' : key === 'closed' ? 'closed' : key === 'open' ? 'open' : key === 'draft' ? 'draft' : 'unknown';
    const when = prState.checkedAt ? `Checked ${new Date(prState.checkedAt).toLocaleString()}` : 'Not checked yet';
    const title = [prState.error ? prState.error : `Pull request #${prState.number}: ${NAMES[status] || status}`, key === 'conflict' ? 'It cannot merge cleanly into its base' : '', checks, when].filter(Boolean).join('. ');
    return { key, label, tone, checks, title };
  }

  /** The HTML for the state: an icon, the label and the checks. Empty when there is nothing to show. */
  function chip(prState, { href = '' } = {}) {
    const v = view(prState);
    if (!v) return '';
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const icon = v.key === 'conflict'
      ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1Zm0 4v4.2m0 2.3v.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : `<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">${GLYPH}</svg>`;
    const inner = `<span class="prst prst-${v.tone}" title="${esc(v.title)}">${icon}<span>${esc(v.label)}</span>${v.checks ? `<span class="prst-checks prst-${prState.checks}">${esc(v.checks)}</span>` : ''}</span>`;
    return href ? `<a class="prst-link" href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>` : inner;
  }

  return { view, chip };
}));
