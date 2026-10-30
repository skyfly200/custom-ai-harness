// Skills page: the pure part. No DOM here, so the test can check it.
//
// A skill is { id, name, description, body, disabled? } in this browser's localStorage ('harness-skills'),
// the same list the chat page reads. A project keeps the ids of its skills. An agent keeps a copy of each
// skill it uses ({ id, name, body }, see runner/agents.js), so it is changed only when this page sends it again.
//
// Loaded by the page with a plain <script>, and by Node (module.exports) in the tests.
(function (root) {
  'use strict';

  const NAME_MAX = 60;
  const BODY_MAX = 20000;

  // A name is what the model types to load a skill, so it is a short word with dashes, and unique.
  const cleanName = (s) => String(s ?? '').trim().replace(/\s+/g, '-').slice(0, NAME_MAX);

  // The skill's own name and description come from its SKILL.md frontmatter: "key: value" lines between --- lines.
  function parseSkillFile(text, fallbackName = '') {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text || ''));
    const meta = {};
    if (m) {
      for (const line of m[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
        if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
      }
    }
    const body = (m ? m[2] : String(text || '')).trim();
    return {
      name: cleanName(meta.name || fallbackName),
      description: String(meta.description || '').trim().slice(0, 200),
      body,
    };
  }

  // Null when the skill can be saved, else the reason in a sentence.
  function problem(skill, all = []) {
    const name = cleanName(skill.name);
    if (!name) return 'A skill needs a name.';
    if (!/^[\w.-]+$/.test(name)) return 'Use letters, numbers, dashes, dots or underscores in the name.';
    const clash = all.some((k) => k.id !== skill.id && k.name.toLowerCase() === name.toLowerCase());
    if (clash) return `Another skill is already called ${name}.`;
    if (!String(skill.body || '').trim()) return 'A skill needs its instructions.';
    if (String(skill.body).length > BODY_MAX) return `The instructions are longer than ${BODY_MAX.toLocaleString()} characters.`;
    return null;
  }

  // A name that is not taken yet: "name", then "name-2", "name-3"...
  function freeName(name, all = []) {
    const taken = new Set(all.map((k) => k.name.toLowerCase()));
    const base = cleanName(name) || 'skill';
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`.slice(0, NAME_MAX);
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  // The copy an agent keeps: what it needs to follow the skill, and nothing about whether it is on the page.
  const copyFor = (k) => ({ id: k.id, name: k.name, body: k.body });

  // The list an agent should have, from its current list. `change` = { id, on } flips one skill.
  // Skills that are gone or switched off drop out, and the rest are refreshed to the current text.
  // Returns null when nothing would change, so the page sends no update for it.
  function agentSkillsAfter(agent, skills, change = null) {
    const ids = new Set((agent.skills || []).map((s) => s.id));
    if (change) {
      if (change.on) ids.add(change.id);
      else ids.delete(change.id);
    }
    const byId = new Map(skills.map((k) => [k.id, k]));
    const next = [...ids].map((id) => byId.get(id)).filter((k) => k && !k.disabled).map(copyFor);
    return JSON.stringify(next) === JSON.stringify(agent.skills || []) ? null : next;
  }

  // Projects: the ids a project keeps. `change` = { id, on } as above; ids of skills that are gone are dropped.
  function projectSkillsAfter(project, skills, change = null) {
    const alive = new Set(skills.map((k) => k.id));
    const ids = new Set((project.skills || []).filter((id) => alive.has(id)));
    if (change) {
      if (change.on) ids.add(change.id);
      else ids.delete(change.id);
    }
    return [...ids];
  }

  // Skills that may be used now: switched on. Chat and agents only see these.
  const enabled = (skills) => skills.filter((k) => !k.disabled);

  const api = { parseSkillFile, problem, freeName, cleanName, agentSkillsAfter, projectSkillsAfter, enabled, NAME_MAX, BODY_MAX };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SkillsModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
