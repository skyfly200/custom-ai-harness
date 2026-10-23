// The scale that fits a layout of width x height inside a canvas, with some
// room left. Never above 1 (boxes are not enlarged) and never below `min`,
// where nothing is visible any more and the canvas scrolls instead.
(function (root) {
  function fitZoom(width, height, canvasWidth, canvasHeight, { pad = 30, min = 0.05 } = {}) {
    if (!(width > 0) || !(height > 0)) return 1;
    const z = Math.min(1, (canvasWidth - pad) / width, (canvasHeight - pad) / height);
    if (!(z > 0)) return min;
    return Math.max(min, Math.floor(z * 100) / 100);
  }
  if (typeof module === 'object' && module.exports) module.exports = { fitZoom };
  else root.Fit = { fitZoom };
})(typeof window !== 'undefined' ? window : globalThis);
