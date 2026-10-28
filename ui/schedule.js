// When a scheduled message runs next. The same code in the page (window.Schedule) and on the server
// (utils/serverSchedules.js), so both agree. Daily, weekday and weekly runs keep the same wall-clock
// time in the schedule's own time zone `tz` (an IANA name such as America/Denver), through daylight
// saving changes; with no `tz` this machine's own zone is used.
(function (root) {
  const DAY = 86400000;

  const dtf = new Map();
  function parts(ms, tz) {
    if (!tz) { const d = new Date(ms); return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), dow: d.getDay() }; }
    if (!dtf.has(tz)) dtf.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }));
    const p = Object.fromEntries(dtf.get(tz).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return { y: +p.year, m: +p.month - 1, d: +p.day, h: +p.hour, mi: +p.minute, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
  }

  // The instant at which the wall clock in `tz` reads y-m-d h:mi (month 0-based; the day may overflow)
  function zoned(y, m, d, h, mi, tz) {
    if (!tz) return new Date(y, m, d, h, mi).getTime();
    const guess = Date.UTC(y, m, d, h, mi);
    const off = (t) => { const p = parts(t, tz); return Date.UTC(p.y, p.m, p.d, p.h, p.mi) - t; };
    return guess - off(guess - off(guess));
  }

  function validZone(tz) {
    if (!tz) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
  }

  // The first run after `from` of a schedule that starts at `start`; null for a one-off already past
  function nextRun(start, repeat, from = Date.now(), tz) {
    if (tz && !validZone(tz)) tz = undefined;
    if (start > from) return start;
    if (repeat === 'once') return null;
    if (repeat === 'hourly') return start + Math.ceil((from + 1 - start) / 3600000) * 3600000;
    const s = parts(start, tz);
    const step = repeat === 'weekly' ? 7 : 1;
    let k = Math.max(0, Math.floor((from - start) / DAY) - 1);
    if (step === 7) k -= k % 7;
    for (let i = 0; i < 800; i++, k += step) {
      const t = zoned(s.y, s.m, s.d + k, s.h, s.mi, tz);
      if (t <= from) continue;
      if (repeat === 'weekdays' && [0, 6].includes(parts(t, tz).dow)) continue;
      return t;
    }
    return null;
  }

  const api = { nextRun, zoned, validZone };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Schedule = api;
})(typeof window !== 'undefined' ? window : globalThis);
