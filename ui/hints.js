// Hover hints: any element with a data-hint attribute shows it in a small
// bubble after a short hover, or at once when it gets keyboard focus.
(() => {
  const tip = document.createElement('div');
  tip.className = 'hint-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(tip));
  if (document.body) document.body.appendChild(tip);

  let current = null, timer = null;

  function show(el) {
    const text = el.dataset.hint;
    if (!text || !el.isConnected) return;
    tip.textContent = text;
    tip.hidden = false;
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const x = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, innerWidth - t.width - 8));
    let y = r.bottom + 8;
    if (y + t.height > innerHeight - 8) y = Math.max(8, r.top - t.height - 8);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  function hide() {
    clearTimeout(timer);
    current = null;
    tip.hidden = true;
  }

  const target = (e) => (e.target.closest ? e.target.closest('[data-hint]') : null);

  document.addEventListener('pointerover', (e) => {
    const el = target(e);
    if (el === current) return;
    hide();
    if (!el || e.buttons || e.pointerType === 'touch') return; // not while dragging, nor on a tap
    current = el;
    timer = setTimeout(() => show(el), 400);
  });
  document.addEventListener('focusin', (e) => {
    const el = target(e);
    if (el && e.target.matches(':focus-visible')) { current = el; show(el); }
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  addEventListener('scroll', hide, true);
})();
