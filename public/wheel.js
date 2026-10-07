// The spinning wheel. Drawn on a canvas so it stays smooth with up to 500 segments (NF4).
// The wheel face is pre-rendered once per set of segments; each animation frame only rotates that image.
// The server decides the result; this only animates to it.

const COLORS = [
  { fill: '#ffc93c', text: '#1b1530' },
  { fill: '#ff4f79', text: '#ffffff' },
  { fill: '#2bb3a3', text: '#ffffff' },
  { fill: '#8f7cf7', text: '#ffffff' },
  { fill: '#fbf8ff', text: '#1b1530' },
  { fill: '#ff8a3d', text: '#1b1530' },
];
const TAU = Math.PI * 2;
const LABEL_LIMIT = 48; // above this many segments, names are shown in the ticker instead of on the wheel
const easeOut = (t) => 1 - (1 - t) ** 4;
// With many characters, neighbours are coloured in bands so the wheel reads as ~72 bold slices
// instead of a flickering stripe pattern. The pointer and ticker still track each character.
const MAX_BANDS = 72;
const bandSize = (n) => (n > MAX_BANDS ? Math.ceil(n / MAX_BANDS) : 1);
// Neighbouring bands never share a colour, including where the wheel wraps round.
function colorFor(i, n) {
  const size = bandSize(n);
  const band = Math.floor(i / size);
  const bands = Math.ceil(n / size);
  return bands % COLORS.length === 1 && band === bands - 1 ? COLORS[2] : COLORS[band % COLORS.length];
}

export class Wheel {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'wheel-wrap';
    this.el.innerHTML = `
      <div class="wheel-stage">
        <canvas class="wheel-canvas" aria-hidden="true"></canvas>
        <div class="wheel-pointer" aria-hidden="true"></div>
        <div class="wheel-hub"><span class="hub-count"></span><small>on the wheel</small></div>
      </div>
      <p class="wheel-ticker" aria-live="off"></p>`;
    this.canvas = this.el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.ticker = this.el.querySelector('.wheel-ticker');
    this.hubCount = this.el.querySelector('.hub-count');
    this.ids = [];
    this.names = new Map();
    this.key = '';
    this.rotation = 0;
    this.anim = null;
    this.size = 0;
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    new ResizeObserver(() => this.#resize()).observe(this.el);
  }

  // ids: segment order; names: Map id -> name
  setSegments(ids, names) {
    const key = `${ids.length}:${ids[0]}:${ids[ids.length - 1]}:${ids.join('').length}`;
    this.names = names;
    this.hubCount.textContent = String(ids.length);
    if (key === this.key) return;
    this.key = key;
    this.ids = ids;
    this.#prerender();
    this.#draw();
  }

  // Index of the segment under the pointer (top) at a given rotation.
  indexAt(rotation = this.rotation) {
    const n = this.ids.length;
    if (!n) return -1;
    const a = (((-rotation) % TAU) + TAU) % TAU;
    return Math.min(n - 1, Math.floor(a / (TAU / n)));
  }

  // Animate so that `landedId` ends under the pointer. `elapsed` lets late joiners catch up.
  spinTo(landedId, { duration = 3500, elapsed = 0, seed = 1, onDone } = {}) {
    const idx = this.ids.indexOf(landedId);
    if (idx === -1) { onDone?.(); return; }
    cancelAnimationFrame(this.anim?.raf);
    const seg = TAU / this.ids.length;
    // A small offset inside the winning segment so it doesn't always stop dead centre (same on every screen).
    const jitter = ((Math.sin(seed * 12.9898) * 43758.5453) % 1) * 0.4 * seg;
    const target = -(idx + 0.5) * seg + jitter;
    const start = this.rotation;
    const base = start + (((target - start) % TAU) + TAU) % TAU; // next matching angle, clockwise
    const end = base + TAU * 6; // plus six full turns
    const total = this.reduced ? 1 : duration;
    const t0 = performance.now() - Math.min(elapsed, total);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / total);
      this.rotation = start + (end - start) * easeOut(t);
      this.#draw();
      this.#tick();
      if (t < 1) this.anim.raf = requestAnimationFrame(step);
      else { this.rotation = ((end % TAU) + TAU) % TAU; this.anim = null; onDone?.(); }
    };
    this.anim = { raf: requestAnimationFrame(step) };
  }

  get spinning() { return Boolean(this.anim); }

  showName(text) { this.ticker.textContent = text; }

  #tick() {
    const id = this.ids[this.indexAt()];
    this.ticker.textContent = this.names.get(id) ?? '';
  }

  #resize() {
    const css = Math.round(this.canvas.getBoundingClientRect().width);
    if (!css || css === this.size) return;
    this.size = css;
    const px = Math.round(css * (window.devicePixelRatio || 1));
    this.canvas.width = px;
    this.canvas.height = px;
    this.#prerender();
    this.#draw();
  }

  #prerender() {
    const px = this.canvas.width;
    if (!px) return;
    const off = this.off || (this.off = document.createElement('canvas'));
    off.width = px; off.height = px;
    const c = off.getContext('2d');
    const r = px / 2;
    const n = this.ids.length;
    c.clearRect(0, 0, px, px);
    c.translate(r, r);
    if (!n) {
      c.fillStyle = '#2a2147'; c.beginPath(); c.arc(0, 0, r - 2, 0, TAU); c.fill();
      c.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }
    const seg = TAU / n;
    const lineW = Math.max(1, px / 260);
    // Each band (one segment on smaller wheels) is filled as a single shape, so there are no seams.
    const size = bandSize(n);
    for (let i = 0; i < n; i += size) {
      const a0 = i * seg - Math.PI / 2;
      const a1 = Math.min(n, i + size) * seg - Math.PI / 2;
      c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, r - lineW, a0, a1); c.closePath();
      c.fillStyle = colorFor(i, n).fill; c.fill();
      c.beginPath(); c.moveTo(0, 0); c.lineTo(Math.cos(a0) * (r - lineW), Math.sin(a0) * (r - lineW));
      c.strokeStyle = '#1b1530'; c.lineWidth = lineW; c.stroke();
    }
    if (n <= LABEL_LIMIT) {
      const fontPx = Math.max(10, Math.min(px / 22, (seg * r * 0.55)));
      c.font = `700 ${fontPx}px 'Zen Kaku Gothic New', system-ui, sans-serif`;
      c.textAlign = 'right'; c.textBaseline = 'middle';
      for (let i = 0; i < n; i += 1) {
        const color = colorFor(i, n);
        c.save();
        c.rotate(i * seg + seg / 2 - Math.PI / 2);
        c.fillStyle = color.text;
        let label = this.names.get(this.ids[i]) ?? '';
        const maxW = r * 0.62;
        while (label.length > 3 && c.measureText(label).width > maxW) label = `${label.slice(0, -2)}…`;
        c.fillText(label, r - lineW * 6, 0);
        c.restore();
      }
    }
    c.lineWidth = lineW * 3; c.strokeStyle = '#1b1530';
    c.beginPath(); c.arc(0, 0, r - lineW * 1.5, 0, TAU); c.stroke();
    c.setTransform(1, 0, 0, 1, 0, 0);
  }

  #draw() {
    const px = this.canvas.width;
    if (!px || !this.off) return;
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, px, px);
    c.translate(px / 2, px / 2);
    c.rotate(this.rotation);
    c.drawImage(this.off, -px / 2, -px / 2);
    c.setTransform(1, 0, 0, 1, 0, 0);
  }
}
