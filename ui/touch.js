// Maths for finger gestures on the routing canvas: pinch and button zoom that
// keep the point under the fingers still, and telling a tap from a drag.
(function (root) {
  const TAP_SLOP = 8;     // px a finger may move and still count as a tap

  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const clampZoom = (z, { min = 0.05, max = 2 } = {}) => Math.min(max, Math.max(min, z));

  // Scale after fingers that started `startDist` apart are now `dist` apart
  function pinchZoom(startZoom, startDist, dist, limits) {
    if (!(startDist > 0) || !(dist > 0)) return clampZoom(startZoom, limits);
    return Math.round(clampZoom(startZoom * dist / startDist, limits) * 100) / 100;
  }

  // One step of the + / - buttons (dir 1 or -1)
  function stepZoom(z, dir, limits) {
    return Math.round(clampZoom(dir > 0 ? z * 1.25 : z / 1.25, limits) * 100) / 100;
  }

  // How far to scroll so the point `d` px from the world's edge (scrolled
  // distance included) stays under the fingers when the scale goes z0 -> z1
  const scrollDelta = (d, z0, z1) => z0 > 0 ? d * (z1 / z0 - 1) : 0;

  const isTap = (dx, dy) => Math.hypot(dx, dy) < TAP_SLOP;

  const api = { distance, midpoint, clampZoom, pinchZoom, stepZoom, scrollDelta, isTap, TAP_SLOP };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Gesture = api;
})(typeof window !== 'undefined' ? window : globalThis);
