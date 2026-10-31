'use strict';
// The pages bar, one copy for every page. A page only says where the bar goes:
//   <nav data-site-nav></nav>   (inside its <header>; the chat page's <header class="top"> too)
// and this script builds the brand, the page links with the current one marked, and the
// account menu (signed-in name, Users, background, install, sign out). On the other pages the
// bar moves out to a sticky strip at the top of the window; on phones the links fold into a menu.
// The chat page keeps its own pages menu (chat.js) and gets the same links as a flat list.
// Pure helpers run in Node tests (require); the rest runs in the page (window.SiteNav).
(function (root) {
  const ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.7 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    usage: '<path d="M5 20V11M12 20V4M19 20v-6"/>',
    routing: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M8.2 6H12a3 3 0 0 1 3 3v0l1 1.5M8.2 18H12a3 3 0 0 0 3-3v0l1-1.5"/>',
    apps: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><path d="M17 13.5v7M13.5 17h7"/>',
    agents: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V4.5M9 13v1M15 13v1"/><circle cx="12" cy="3.6" r="1"/>',
    workflows: '<rect x="3" y="3" width="7" height="5" rx="1.2"/><rect x="14" y="16" width="7" height="5" rx="1.2"/><rect x="3" y="16" width="7" height="5" rx="1.2"/><path d="M10 5.5h2a2 2 0 0 1 2 2v7a2 2 0 0 0 2 2M6.5 8v8"/>',
    prompts: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
    tools: '<path d="M14.5 6.5a4 4 0 0 0 4.9 5.2L10 21l-3-3 9.3-9.4a4 4 0 0 0-1.8-2.1z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    skills: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-6.1-5.1-1.9 5.1-1.9z"/><path d="M19 16.5v4M17 18.5h4"/>',
    user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    bg: '<circle cx="5" cy="7" r="1.6"/><circle cx="17" cy="5" r="1.6"/><circle cx="12" cy="13" r="1.6"/><circle cx="19" cy="18" r="1.6"/><circle cx="6" cy="18" r="1.6"/><path d="M6.4 7.7 10.8 12M13.4 12.2l2.6-5.6M13.3 13.9l4.4 3.1M10.6 13.8 7.3 17"/>',
    install: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/>',
    out: '<path d="M9 4H5v16h4M15 8l4 4-4 4M19 12H9"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    chevron: '<path d="m7 10 5 5 5-5"/>',
  };
  const icon = (name) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  // The fixed order of the bar. `files` are the pages that count as being on that link.
  const PAGES = [
    // the brand on the bar links here, so on desktop Dashboard is not a link of its own (phones and the chat menu list it)
    { id: 'dashboard', label: 'Dashboard', href: './', files: ['', 'index.html'], inBrand: true, hint: 'Health of each part, recent chats, usage and requests' },
    { id: 'chat', label: 'Chat', href: 'chat', files: ['chat.html'], hint: 'Talk to the models through the harness' },
    { id: 'apps', label: 'Apps', href: 'apps', files: ['apps.html'], hint: 'Apps you started from a template or registered: ask one for a change, or build a new one' },
    { id: 'agents', label: 'Agents', href: 'agents', files: ['agents.html', 'runs.html'], hint: 'Named agents that keep working on your repos, and one-off runs' },
    // the less-used pages sit under More on desktop; the phone menu lists every page flat
    { id: 'workflows', label: 'Workflows', href: 'workflows', files: ['workflows.html'], group: 'more', hint: 'The plan each agent follows, as stages you can edit' },
    { id: 'prompts', label: 'Prompts', href: 'prompts', files: ['prompts.html'], group: 'more', hint: 'Saved prompts for agents: write, improve and reuse them' },
    { id: 'skills', label: 'Skills', href: 'skills', files: ['skills.html'], group: 'more', hint: 'Named instructions you switch on in chat: write, edit and import them' },
    { id: 'tools', label: 'Tools', href: 'tools', files: ['tools.html'], group: 'more', hint: 'The MCP servers the chat page can use' },
    { id: 'usage', label: 'Usage', href: 'usage', files: ['usage.html', 'usage-users.html'], group: 'more', hint: 'Tokens used, by client, model and service' },
    { id: 'routing', label: 'Routing', href: 'routing', files: ['routing.html'], group: 'more', hint: 'Where requests go, as connected boxes you can edit' },
    // on desktop the gear stands alone (the label is its title and accessible name); phones keep the words
    { id: 'settings', label: 'Settings', href: 'settings', files: ['settings.html'], admin: true, iconOnly: true, hint: 'Interceptor and Router settings' },
  ];
  const USERS = { id: 'users', href: 'users', files: ['users.html'] };

  // `me` is /ui/api/me, or null when logins are off (then it is your own machine: everything shows).
  const isAdmin = (me) => !me || me.role === 'admin';
  const linksFor = (me) => PAGES.filter((p) => !p.admin || isAdmin(me));
  // the links on the desktop bar: not under More, and not already the brand
  const primaryLinks = (me) => linksFor(me).filter((p) => !p.group && !p.inBrand);
  const moreLinks = (me) => linksFor(me).filter((p) => p.group === 'more');
  const currentId = (pathname) => {
    const file = String(pathname || '').split('/').pop().replace(/\.html$/, '');
    const named = file === '' ? file : `${file}.html`;
    const hit = [...PAGES, USERS].find((p) => p.files.includes(named));
    return hit ? hit.id : null;
  };
  // What the account menu offers; `state` = { me, canInstall }
  const accountItems = ({ me, canInstall }) => {
    const items = [];
    if (me && me.name) items.push({ id: 'users', kind: 'link', href: USERS.href, icon: 'user', label: isAdmin(me) ? 'Users and API keys' : 'Your password and API keys' });
    items.push({ id: 'bg', kind: 'toggle', icon: 'bg', label: 'Moving background' });
    if (canInstall) items.push({ id: 'install', kind: 'button', icon: 'install', label: 'Install app' });
    if (me && me.name) items.push({ id: 'signout', kind: 'button', icon: 'out', label: 'Sign out' });
    return items;
  };

  const api = { PAGES, ICONS, linksFor, primaryLinks, moreLinks, currentId, accountItems, isAdmin };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  // ---- in the page ----------------------------------------------------------
  const ME_KEY = 'harness-nav-me';
  const chat = document.body.classList.contains('chat-page');
  const here = currentId(location.pathname);
  let me = null;
  try { me = JSON.parse(sessionStorage.getItem(ME_KEY) || 'null'); } catch {}
  let installEvent = null;
  let bar = null, panel = null;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const brandHtml = '<span class="logo" aria-hidden="true"><i></i><i></i><i></i></span><span class="brand-name">Bright Chat</span>';
  const bgOn = () => (window.Bright?.background ? window.Bright.background() : false);

  // a link in the bar (desktop); iconOnly pages show their icon and keep the label as title and aria-label
  function linkHtml(p) {
    const cur = p.id === here;
    const iconOnly = p.iconOnly ? ' icon-only' : '';
    const name = p.iconOnly ? ` aria-label="${esc(p.label)}" title="${esc(p.label)}"` : '';
    return `<a class="${iconOnly.trim()}${cur ? ' here' : ''}" href="${p.href}" data-hint="${esc(p.hint)}"${name}${cur ? ' aria-current="page"' : ''}>${icon(p.id)}<span>${esc(p.label)}</span></a>`;
  }
  // a link inside a menu (phone panel, More, the chat page's pages menu): always labelled
  function menuLink(p) {
    const cur = p.id === here;
    return `<a role="menuitem" class="menu-item${cur ? ' here' : ''}" href="${p.href}"${cur ? ' aria-current="page"' : ''}>${icon(p.id)}<span>${esc(p.label)}</span></a>`;
  }
  // the More button and its menu of the less-used pages
  function moreHtml(links) {
    const inside = links.some((p) => p.id === here);
    return `<div class="more-wrap"><button type="button" class="more-btn${inside ? ' here' : ''}" id="moreBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="moreMenu">More${icon('chevron')}</button>`
      + `<div class="more-menu" id="moreMenu" role="menu" aria-labelledby="moreBtn" hidden>${links.map(menuLink).join('')}</div></div>`;
  }
  function itemHtml(it) {
    const role = it.kind === 'toggle' ? 'menuitemcheckbox' : 'menuitem';
    const checked = it.kind === 'toggle' ? ` aria-checked="${bgOn()}"` : '';
    const body = `${icon(it.icon)}<span>${esc(it.label)}</span>${it.kind === 'toggle' ? '<i class="sw" aria-hidden="true"></i>' : ''}`;
    if (it.kind === 'link') {
      const cur = it.id === here;
      return `<a class="menu-item${cur ? ' here' : ''}" role="menuitem" href="${it.href}"${cur ? ' aria-current="page"' : ''}>${body}</a>`;
    }
    return `<button type="button" class="menu-item" role="${role}"${checked} data-act="${it.id}">${body}</button>`;
  }
  const items = () => accountItems({ me, canInstall: !!installEvent });

  async function act(id) {
    if (id === 'bg') { window.Bright?.setBackground?.(!bgOn()); return; }
    if (id === 'install') {
      const event = installEvent;
      installEvent = null;
      closeAll();
      render();
      try { await event.prompt(); } catch {}
      return;
    }
    if (id === 'signout') {
      try { await fetch('/logout', { method: 'POST' }); } catch {}
      location.href = '/login';
    }
  }

  // ---- the chat page: the same links as a flat list inside its pages menu ----
  function renderChat(nav) {
    nav.innerHTML = `<h1 class="brand">${brandHtml}</h1>${linksFor(me).filter((p) => !p.group).map(menuLink).join('')}`
      + `<span class="nav-sep" role="separator"></span><span class="nav-label" aria-hidden="true">More</span>${moreLinks(me).map(menuLink).join('')}`
      + `<span class="nav-sep" role="separator"></span>${items().map(itemHtml).join('')}`;
  }

  // ---- every other page: a sticky bar ------------------------------------------
  function build(nav) {
    const header = nav.parentElement;
    bar = document.createElement('div');
    bar.className = 'site-bar';
    bar.id = 'siteBar';
    bar.innerHTML = `<div class="site-bar-in"><nav class="site-nav" aria-label="Pages">
      <a class="brand-link" href="./" aria-label="Bright Chat, dashboard"><span class="brand">${brandHtml}</span></a>
      <div class="site-links" data-slot="links"></div>
      <div class="site-account" data-slot="account"></div>
      <button type="button" class="site-burger" id="siteBurger" aria-label="Pages menu" aria-expanded="false" aria-controls="sitePanel" aria-haspopup="true"></button>
    </nav><div class="site-panel" id="sitePanel" role="menu" aria-label="Pages" hidden></div></div>`;
    panel = bar.querySelector('#sitePanel');
    const skip = document.createElement('a');
    skip.className = 'skip-link'; skip.href = '#main'; skip.textContent = 'Skip to content';
    const main = document.querySelector('main');
    if (main && !main.id) main.id = 'main';
    document.body.prepend(bar);
    document.body.prepend(skip);
    nav.remove();
    // a header left with no controls of its own is just empty space
    if (header && !header.children.length) header.remove();
    if (main && !main.querySelector('h1')) {
      const h = document.createElement('h1');
      h.className = 'sr-only';
      h.textContent = (PAGES.find((p) => p.id === here) || { label: document.title.replace(/^Bright Chat · /, '') }).label;
      main.prepend(h);
    }
    bar.addEventListener('click', onClick);
    bar.addEventListener('keydown', onKey);
    document.addEventListener('click', (e) => { if (!e.composedPath().includes(bar)) closeAll(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenu()) { const b = openMenu(); closeAll(); b.focus(); e.stopPropagation(); } }, true);
    matchMedia('(min-width: 761px)').addEventListener?.('change', (e) => { if (e.matches) closeAll(); });
    watchScroll();
  }

  function renderBar() {
    const links = linksFor(me);
    const more = moreLinks(me);
    bar.querySelector('[data-slot=links]').innerHTML = primaryLinks(me).map((p) => linkHtml(p)).join('') + (more.length ? moreHtml(more) : '');
    const label = me && me.name ? `<span class="who">${esc(me.name)}</span>` : '';
    bar.querySelector('[data-slot=account]').innerHTML = `<button type="button" class="account-btn" id="accountBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="accountMenu"
      aria-label="${me && me.name ? esc(me.name) + ', account menu' : 'Menu'}" title="${me && me.name ? esc(me.name) + (isAdmin(me) ? ' (admin)' : '') : 'Menu'}">${icon('user')}${label}${icon('chevron')}</button>
      <div class="account-menu" id="accountMenu" role="menu" aria-labelledby="accountBtn" hidden>${me && me.name ? `<div class="menu-head"><b>${esc(me.name)}</b><small>${esc(me.role || 'user')}</small></div>` : ''}${items().map(itemHtml).join('')}</div>`;
    panel.innerHTML = `${links.map(menuLink).join('')}<span class="nav-sep" role="separator"></span>${me && me.name ? `<div class="menu-head"><b>${esc(me.name)}</b><small>${esc(me.role || 'user')}</small></div>` : ''}${items().map(itemHtml).join('')}`;
    const burger = bar.querySelector('#siteBurger');
    burger.innerHTML = icon(panel.hidden ? 'menu' : 'close');
  }

  const TOGGLES = '#accountBtn, #siteBurger, #moreBtn';
  // each toggle names its menu in aria-controls
  const menuOf = (btn) => bar.querySelector('#' + btn.getAttribute('aria-controls'));
  const openMenu = () => (bar && [...bar.querySelectorAll('[aria-expanded=true]')][0]) || null;
  function setOpen(btn, on) {
    closeAll(btn);
    btn.setAttribute('aria-expanded', String(on));
    menuOf(btn).hidden = !on;
    bar.classList.toggle('open', on);
    if (btn.id === 'siteBurger') btn.innerHTML = icon(on ? 'close' : 'menu');
    if (on) { syncToggle(); }
  }
  function closeAll(except) {
    if (!bar) return;
    for (const b of bar.querySelectorAll(TOGGLES)) {
      if (b === except) continue;
      b.setAttribute('aria-expanded', 'false');
      menuOf(b).hidden = true;
      if (b.id === 'siteBurger') b.innerHTML = icon('menu');
    }
    if (!except) bar.classList.remove('open');
  }
  function syncToggle() {
    for (const t of bar.querySelectorAll('[data-act=bg]')) t.setAttribute('aria-checked', String(bgOn()));
  }
  function onClick(e) {
    const toggle = e.target.closest(TOGGLES);
    if (toggle) {
      const on = toggle.getAttribute('aria-expanded') !== 'true';
      setOpen(toggle, on);
      if (on && e.detail === 0) menuItems(toggle)[0]?.focus();
      return;
    }
    const b = e.target.closest('[data-act]');
    if (b) { act(b.dataset.act); if (b.dataset.act !== 'bg') closeAll(); return; }
    if (e.target.closest('a.menu-item')) closeAll();
  }
  const menuItems = (btn) => [...menuOf(btn).querySelectorAll('[role^=menuitem]')];
  function onKey(e) {
    const btn = openMenu();
    if (!btn) return;
    const list = menuItems(btn);
    const i = list.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? -1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
    else if (e.key === 'Tab' && !bar.contains(document.activeElement)) closeAll();
  }

  // On phones the bar slides away while you read down the page and comes back when you scroll up
  function watchScroll() {
    let lastY = scrollY, ticking = false;
    addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = scrollY, dy = y - lastY;
        if (matchMedia('(max-width: 760px)').matches && !bar.classList.contains('open') && !bar.contains(document.activeElement)) {
          if (dy > 6 && y > 90) bar.classList.add('away');
          else if (dy < -4 || y < 40) bar.classList.remove('away');
        } else bar.classList.remove('away');
        lastY = y;
        ticking = false;
      });
    }, { passive: true });
    bar.addEventListener('focusin', () => bar.classList.remove('away'));
  }

  function render() {
    const nav = document.querySelector('[data-site-nav]');
    if (chat) { if (nav) renderChat(nav); return; }
    if (bar) { const open = openMenu()?.id; renderBar(); if (open) { const b = bar.querySelector('#' + open); if (b) setOpen(b, true); } }
  }

  async function loadMe() {
    let next = null;
    try {
      const r = await fetch('/ui/api/me', { credentials: 'same-origin' });
      if (r.ok) { const j = await r.json(); if (j && j.name) next = { name: j.name, role: j.role }; }
    } catch {}
    try { next ? sessionStorage.setItem(ME_KEY, JSON.stringify(next)) : sessionStorage.removeItem(ME_KEY); } catch {}
    if (JSON.stringify(next) !== JSON.stringify(me)) { me = next; render(); }
  }

  const nav = document.querySelector('[data-site-nav]');
  if (nav) {
    if (!chat) { build(nav); renderBar(); }
    render();
    loadMe();
  }
  // Chat's flat list handles its own clicks here, since chat.js only opens and closes the menu
  if (chat && nav) nav.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) act(b.dataset.act); });
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; render(); });
  addEventListener('appinstalled', () => { installEvent = null; render(); });
  document.addEventListener('bright:background', () => { if (bar) syncToggle(); else render(); });
  root.SiteNav = { ...api, render };
})(typeof window !== 'undefined' ? window : globalThis);
