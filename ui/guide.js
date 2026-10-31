'use strict';
// The page guide: a book button opens the guide's text in a dialog. The text is a <template> in the page:
// <button class="guide-btn" data-guide="guide-text">…</button> and <template id="guide-text" data-title="…">
(() => {
  document.querySelectorAll('.guide-btn[data-guide]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tpl = document.getElementById(btn.dataset.guide);
      if (!tpl) return;
      window.ui.dialog((box, close) => {
        box.classList.add('guide-dialog');
        box.setAttribute('aria-labelledby', 'guide-title');
        const h = document.createElement('h3');
        h.id = 'guide-title';
        h.textContent = tpl.dataset.title || 'Guide';
        box.append(h, tpl.content.cloneNode(true));
        const row = document.createElement('div');
        row.className = 'ui-actions';
        const ok = document.createElement('button');
        ok.type = 'button';
        ok.className = 'primary';
        ok.textContent = 'Close';
        ok.addEventListener('click', () => close(null));
        row.append(ok);
        box.append(row);
        return ok;
      });
    });
  });
})();
