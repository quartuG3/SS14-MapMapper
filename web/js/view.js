// Canvas renderer: tiles, decals, entities, overlays, rulers; also used for baked export.
import { S, emit } from './state.js';
import { P } from './protos.js';
import * as A from './assets.js';
import {
  key, unkey, tileOf, rotSteps, HALF_PI, visualParam, pipeColorOf, pipeLayerOf, entLayer, openPipeEnds, DIR_VEC,
} from './logic.js';

const RULER = 20;
let canvas, ctx, rTop, rLeft, rtx, rlx;
let W = 0, H = 0, dpr = 1;
let pending = false;
let sorted = null, sortedVersion = -1;
export let toolOverlay = null;
export function setToolOverlay(fn) { toolOverlay = fn; requestDraw(); }

export function initView() {
  canvas = document.getElementById('view');
  ctx = canvas.getContext('2d');
  rTop = document.getElementById('rulerTop');
  rLeft = document.getElementById('rulerLeft');
  rtx = rTop.getContext('2d');
  rlx = rLeft.getContext('2d');
  new ResizeObserver(resize).observe(document.getElementById('stage'));
  A.setOnLoad(requestDraw);
  resize();
}

function resize() {
  const st = document.getElementById('stage');
  dpr = window.devicePixelRatio || 1;
  W = st.clientWidth - RULER; H = st.clientHeight - RULER;
  for (const [c, w, h] of [[canvas, W, H], [rTop, W, RULER], [rLeft, RULER, H]]) {
    c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.max(1, Math.round(h * dpr));
    c.style.width = w + 'px'; c.style.height = h + 'px';
  }
  requestDraw();
}

export const size = () => [W, H];
export function w2s(wx, wy, v = S.view, w = W, h = H) { return [(wx - v.cx) * v.z + w / 2, (v.cy - wy) * v.z + h / 2]; }
export function s2w(sx, sy, v = S.view, w = W, h = H) { return [(sx - w / 2) / v.z + v.cx, v.cy - (sy - h / 2) / v.z]; }

export function requestDraw() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; draw(); });
}

function sortedEnts(model) {
  if (sorted && sortedVersion === model.version && sorted.model === model) return sorted.list;
  const list = [...model.ents.values()];
  list.sort((a, b) => {
    const pa = P.ents.get(a.proto), pb = P.ents.get(b.proto);
    const da = pa ? pa.dd : 0, db = pb ? pb.dd : 0;
    return da - db || b.y - a.y || (a.x - b.x);
  });
  sorted = { list, model };
  sortedVersion = model.version;
  return list;
}

function hashColor(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360},35%,35%)`;
}

const grateCache = new Map();
/** Is subfloor (pipes, cables) visible on this tile? In game: only on isSubfloor tiles; optionally also on grate-like tiles. */
export function subfloorVisibleOn(t, grates) {
  if (!t) return true;
  const tp = P.tiles.get(t[0]);
  if (!tp || tp.subfloor) return true;
  if (!grates) return false;
  let re = grateCache.get(grates);
  if (re === undefined) { try { re = new RegExp(grates, 'i'); } catch { re = null; } grateCache.set(grates, re); }
  return !!(re && re.test(t[0]));
}

/** Render the map into ctx. opts: {view, w, h, bake, hideSubfloor, grid, bg, onlyLoaded} */
export function render(c, opts) {
  const model = S.model;
  const v = opts.view;
  const w = opts.w, h = opts.h;
  const z = v.z, sc = z / 32;
  c.imageSmoothingEnabled = false;
  if (opts.bg === 'transparent') c.clearRect(0, 0, w, h);
  else { c.fillStyle = opts.bg || '#0b0d12'; c.fillRect(0, 0, w, h); }
  if (!model) return;
  const [x0w, y1w] = s2w(0, 0, v, w, h), [x1w, y0w] = s2w(w, h, v, w, h);
  const minx = Math.floor(x0w) - 3, maxx = Math.ceil(x1w) + 3, miny = Math.floor(y0w) - 3, maxy = Math.ceil(y1w) + 3;
  const L = opts.layers || S.layers;
  const editor = !opts.bake;

  // tiles
  if (L.tiles) {
    for (const [k, t] of model.tiles) {
      const [x, y] = unkey(k);
      if (x < minx || x > maxx || y < miny || y > maxy) continue;
      const [sx, sy] = w2s(x, y + 1, v, w, h);
      const tp = P.tiles.get(t[0]);
      const img = A.tile(t[0], t[2] || 0);
      if (img) {
        const rm = t[3] || 0;
        if (rm) {
          c.save();
          c.translate(sx + z / 2, sy + z / 2);
          c.rotate(-(rm % 4) * HALF_PI);
          if (rm >= 4) c.scale(-1, 1);
          c.drawImage(img.img, -z / 2, -z / 2, z + 0.5, z + 0.5);
          c.restore();
        } else c.drawImage(img.img, sx, sy, z + 0.5, z + 0.5);
      } else {
        c.fillStyle = tp ? hashColor(t[0]) : '#7a1f5c';
        c.fillRect(sx, sy, z + 0.5, z + 0.5);
      }
    }
  }

  // decals
  if (L.decals) {
    const decals = [...model.decals.values()].sort((a, b) => (a.z || 0) - (b.z || 0));
    for (const d of decals) {
      if (d.x < minx || d.x > maxx || d.y < miny || d.y > maxy) continue;
      const img = A.decal(d.id, d.color);
      if (!img) continue;
      const [sx, sy] = w2s(d.x, d.y + 1, v, w, h);
      if (d.angle) {
        c.save();
        c.translate(sx + z / 2, sy + z / 2);
        c.rotate(-d.angle);
        c.drawImage(img.img, -z / 2, -z / 2, img.img.width * sc, img.img.height * sc);
        c.restore();
      } else c.drawImage(img.img, sx, sy + z - img.img.height * sc, img.img.width * sc, img.img.height * sc);
    }
  }

  // entities
  const mode = editor ? S.mode : 'normal';
  for (const e of sortedEnts(model)) {
    if (e.x < minx || e.x > maxx || e.y < miny || e.y > maxy) continue;
    const p = P.ents.get(e.proto);
    const lay = entLayer(p);
    if (!L[lay]) continue;
    if (p && p.pipe !== undefined && !S.pipeLayers[pipeLayerOf(e)] && editor) continue;
    if ((opts.hideSubfloor || (editor && S.layers.realSubfloor)) && p && p.subfloor) {
      const t = model.getTile(...tileOf(e.x, e.y));
      if (!subfloorVisibleOn(t, opts.grates ?? (S.subfloor.showOnGrates ? S.subfloor.grates : ''))) continue;
    }
    let alpha = 1;
    if (mode === 'wiring' && lay !== 'wires') alpha = (p && (p.c || []).some(x => x === 'Apc' || x === 'PowerNetworkBattery' || x === 'CableTerminal')) || (p && p.supply) ? 0.85 : 0.28;
    if (mode === 'atmos' && lay !== 'pipes') alpha = 0.28;
    if (mode === 'normal' && editor && (lay === 'pipes' || lay === 'wires')) alpha = 0.9;
    if (editor && lay === 'markers') alpha *= 0.55;
    const [sx, sy] = w2s(e.x, e.y, v, w, h);
    if (!p) {
      if (editor && L.placeholders) drawPlaceholder(c, sx, sy, z, e.proto, '#c03030');
      continue;
    }
    const steps = rotSteps(e.rot);
    const vp = visualParam(model, e, p);
    const col = p.pipe !== undefined ? pipeColorOf(e) : null;
    const pl = p.pipeLayers ? pipeLayerOf(e) : null;
    const img = A.sprite(e.proto, steps, vp, col, pl && pl !== 'Primary' ? pl : null);
    if (img === undefined) continue;
    if (img === null) {
      if (editor && L.placeholders) drawPlaceholder(c, sx, sy, z, e.proto, '#8060c0');
      continue;
    }
    c.globalAlpha = alpha;
    const resid = (e.rot || 0) - steps * HALF_PI;
    if (Math.abs(resid) > 0.01 && Math.abs(Math.abs(resid) - 2 * Math.PI) > 0.01) {
      c.save();
      c.translate(sx, sy);
      c.rotate(-resid);
      c.drawImage(img.img, -img.ox * sc, -img.oy * sc, img.img.width * sc, img.img.height * sc);
      c.restore();
    } else {
      c.drawImage(img.img, sx - img.ox * sc, sy - img.oy * sc, img.img.width * sc, img.img.height * sc);
    }
    c.globalAlpha = 1;
  }

  if (opts.grid && z >= 6) {
    c.strokeStyle = opts.bake ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.07)';
    c.lineWidth = 1;
    c.beginPath();
    for (let x = minx; x <= maxx; x++) { const [sx] = w2s(x, 0, v, w, h); c.moveTo(Math.round(sx) + 0.5, 0); c.lineTo(Math.round(sx) + 0.5, h); }
    for (let y = miny; y <= maxy; y++) { const [, sy] = w2s(0, y, v, w, h); c.moveTo(0, Math.round(sy) + 0.5); c.lineTo(w, Math.round(sy) + 0.5); }
    c.stroke();
  }
}

function drawPlaceholder(c, sx, sy, z, label, color) {
  const r = Math.max(4, z * 0.3);
  c.fillStyle = color;
  c.globalAlpha = 0.7;
  c.fillRect(sx - r, sy - r, r * 2, r * 2);
  c.globalAlpha = 1;
  if (z >= 24) {
    c.fillStyle = '#fff';
    c.font = '9px sans-serif';
    c.fillText(label.slice(0, 6), sx - r + 1, sy + 3);
  }
}

// ---------------------------------------------------------------- main draw
export function draw() {
  const v = S.view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render(ctx, { view: v, w: W, h: H, grid: S.layers.grid, bg: '#0b0d12' });
  if (S.model) drawOverlays(ctx);
  drawRulers();
  document.getElementById('stZoom').textContent = `масштаб ${Math.round(v.z)} px/тайл`;
}

function rectTile(c, x, y, fill, stroke) {
  const z = S.view.z;
  const [sx, sy] = w2s(x, y + 1);
  if (fill) { c.fillStyle = fill; c.fillRect(sx, sy, z, z); }
  if (stroke) { c.strokeStyle = stroke; c.strokeRect(sx + 0.5, sy + 0.5, z - 1, z - 1); }
}

function drawOverlays(c) {
  const z = S.view.z;
  const model = S.model;
  // chunk borders
  if (S.layers.chunks) {
    c.strokeStyle = 'rgba(255,200,80,0.25)';
    c.beginPath();
    const [x0, y1] = s2w(0, 0), [x1, y0] = s2w(W, H);
    for (let x = Math.floor(x0 / 16) * 16; x <= x1; x += 16) { const [sx] = w2s(x, 0); c.moveTo(sx, 0); c.lineTo(sx, H); }
    for (let y = Math.floor(y0 / 16) * 16; y <= y1; y += 16) { const [, sy] = w2s(0, y); c.moveTo(0, sy); c.lineTo(W, sy); }
    c.stroke();
  }
  // origin
  {
    const [ox, oy] = w2s(0, 0);
    c.strokeStyle = 'rgba(255,80,80,0.6)';
    c.beginPath(); c.moveTo(ox - 6, oy); c.lineTo(ox + 6, oy); c.moveTo(ox, oy - 6); c.lineTo(ox, oy + 6); c.stroke();
  }
  // leaks
  if (S.layers.leaks) for (const k of S.leaks) { const [x, y] = unkey(k); rectTile(c, x, y, 'rgba(255,60,60,0.28)'); }
  // open pipe ends
  if (S.mode === 'atmos' && S.layers.openEnds) {
    c.fillStyle = '#ff4d4d';
    for (const o of openPipeEnds(model)) {
      const [dx, dy] = DIR_VEC[o.d];
      const [sx, sy] = w2s(o.x + 0.5 + dx * 0.42, o.y + 0.5 + dy * 0.42);
      c.beginPath(); c.arc(sx, sy, Math.max(2, z * 0.09), 0, Math.PI * 2); c.fill();
    }
  }
  // selection
  if (S.selection.size) {
    c.fillStyle = 'rgba(78,161,255,0.18)';
    c.strokeStyle = 'rgba(120,190,255,0.95)';
    c.lineWidth = 1.5;
    c.beginPath();
    for (const k of S.selection) {
      const [x, y] = unkey(k);
      const [sx, sy] = w2s(x, y + 1);
      c.fillRect(sx, sy, z, z);
      if (!S.selection.has(key(x, y + 1))) { c.moveTo(sx, sy); c.lineTo(sx + z, sy); }
      if (!S.selection.has(key(x, y - 1))) { c.moveTo(sx, sy + z); c.lineTo(sx + z, sy + z); }
      if (!S.selection.has(key(x - 1, y))) { c.moveTo(sx, sy); c.lineTo(sx, sy + z); }
      if (!S.selection.has(key(x + 1, y))) { c.moveTo(sx + z, sy); c.lineTo(sx + z, sy + z); }
    }
    c.stroke();
    c.lineWidth = 1;
  }
  // network highlight
  if (S.highlight && S.highlight.size) {
    c.strokeStyle = '#ffe14d';
    c.lineWidth = 2;
    for (const uid of S.highlight) {
      const e = model.ents.get(uid);
      if (!e) continue;
      const [x, y] = tileOf(e.x, e.y);
      const [sx, sy] = w2s(x, y + 1);
      c.strokeRect(sx + 3, sy + 3, z - 6, z - 6);
    }
    c.lineWidth = 1;
  }
  // inspected
  if (S.inspected && model.ents.has(S.inspected)) {
    const e = model.ents.get(S.inspected);
    const [sx, sy] = w2s(e.x - 0.5, e.y + 0.5);
    c.setLineDash([4, 3]);
    c.strokeStyle = '#4ea1ff';
    c.lineWidth = 2;
    c.strokeRect(sx, sy, z, z);
    c.setLineDash([]);
    c.lineWidth = 1;
  }
  // validator markers
  for (const m of S.markers) {
    const [sx, sy] = w2s(m.x + 0.5, m.y + 0.5);
    c.strokeStyle = m.sev === 'err' ? '#ff5d5d' : '#ffb347';
    c.lineWidth = 2;
    c.beginPath(); c.arc(sx, sy, Math.max(6, z * 0.45), 0, Math.PI * 2); c.stroke();
    c.lineWidth = 1;
  }
  // mirror axes
  if (S.mirror.x) {
    const [sx] = w2s(S.mirror.ax, 0);
    c.strokeStyle = 'rgba(190,110,255,0.9)'; c.setLineDash([8, 4]);
    c.beginPath(); c.moveTo(sx, 0); c.lineTo(sx, H); c.stroke(); c.setLineDash([]);
  }
  if (S.mirror.y) {
    const [, sy] = w2s(0, S.mirror.ay);
    c.strokeStyle = 'rgba(190,110,255,0.9)'; c.setLineDash([8, 4]);
    c.beginPath(); c.moveTo(0, sy); c.lineTo(W, sy); c.stroke(); c.setLineDash([]);
  }
  // guides
  c.strokeStyle = 'rgba(60,220,230,0.8)';
  c.fillStyle = 'rgba(60,220,230,0.9)';
  c.font = '10px sans-serif';
  for (const g of S.guides) {
    c.beginPath();
    if (g.axis === 'x') { const [sx] = w2s(g.v, 0); c.moveTo(sx + 0.5, 0); c.lineTo(sx + 0.5, H); c.fillText('x=' + g.v, sx + 3, 12); }
    else { const [, sy] = w2s(0, g.v); c.moveTo(0, sy + 0.5); c.lineTo(W, sy + 0.5); c.fillText('y=' + g.v, 3, sy - 3); }
    c.stroke();
  }
  // tool overlay (ghosts etc.)
  if (S.layers.links && S.tool !== 'link' && S.linkOverlay) S.linkOverlay(c);
  if (toolOverlay) toolOverlay(c);
  // hover
  if (S.hoverTile) {
    const [x, y] = S.hoverTile;
    const b = S.tool === 'tile' || S.tool === 'erase' || S.tool === 'random' ? S.brush : 1;
    const o = Math.floor((b - 1) / 2);
    const [sx, sy] = w2s(x - o, y - o + b);
    c.strokeStyle = 'rgba(255,255,255,0.55)';
    c.strokeRect(sx + 0.5, sy + 0.5, z * b - 1, z * b - 1);
  }
}

function drawRulers() {
  const v = S.view;
  for (const [c, horiz] of [[rtx, true], [rlx, false]]) {
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const len = horiz ? W : H;
    c.fillStyle = '#1d2027';
    c.fillRect(0, 0, horiz ? W : RULER, horiz ? RULER : H);
    c.strokeStyle = '#4a5163';
    c.fillStyle = '#8a91a0';
    c.font = '10px sans-serif';
    const z = v.z;
    let step = 1;
    for (const s of [1, 2, 5, 10, 20, 50, 100]) { step = s; if (s * z >= 40) break; }
    const [a, b] = horiz ? [s2w(0, 0)[0], s2w(len, 0)[0]] : [s2w(0, len)[1], s2w(0, 0)[1]];
    c.beginPath();
    for (let t = Math.floor(a) - 1; t <= Math.ceil(b) + 1; t++) {
      const p = horiz ? w2s(t, 0)[0] : w2s(0, t)[1];
      const major = t % step === 0;
      const tl = major ? 9 : (z >= 8 ? 4 : 0);
      if (!tl) continue;
      if (horiz) { c.moveTo(Math.round(p) + 0.5, RULER); c.lineTo(Math.round(p) + 0.5, RULER - tl); }
      else { c.moveTo(RULER, Math.round(p) + 0.5); c.lineTo(RULER - tl, Math.round(p) + 0.5); }
      if (major) {
        if (horiz) c.fillText(String(t), p + 2, 9);
        else { c.save(); c.translate(9, p - 2); c.rotate(-Math.PI / 2); c.fillText(String(t), 0, 0); c.restore(); }
      }
    }
    c.stroke();
    // hover marker
    if (S.hoverWorld) {
      const p = horiz ? w2s(S.hoverWorld[0], 0)[0] : w2s(0, S.hoverWorld[1])[1];
      c.strokeStyle = '#4ea1ff';
      c.beginPath();
      if (horiz) { c.moveTo(p, 0); c.lineTo(p, RULER); } else { c.moveTo(0, p); c.lineTo(RULER, p); }
      c.stroke();
    }
    // selection extent
    if (S.selection.size) {
      let lo = Infinity, hi = -Infinity;
      for (const k of S.selection) { const [x, y] = unkey(k); const q = horiz ? x : y; lo = Math.min(lo, q); hi = Math.max(hi, q + 1); }
      const p0 = horiz ? w2s(lo, 0)[0] : w2s(0, hi)[1], p1 = horiz ? w2s(hi, 0)[0] : w2s(0, lo)[1];
      c.fillStyle = 'rgba(78,161,255,0.35)';
      if (horiz) c.fillRect(p0, RULER - 4, p1 - p0, 4); else c.fillRect(RULER - 4, p0, 4, p1 - p0);
    }
    // mirror axis marker
    c.fillStyle = '#b06cff';
    if (horiz && S.mirror.x) { const p = w2s(S.mirror.ax, 0)[0]; c.fillRect(p - 3, 0, 6, 6); }
    if (!horiz && S.mirror.y) { const p = w2s(0, S.mirror.ay)[1]; c.fillRect(0, p - 3, 6, 6); }
  }
}

// ---------------------------------------------------------------- navigation
export function zoomAt(sx, sy, factor) {
  const [wx, wy] = s2w(sx, sy);
  S.view.z = Math.min(256, Math.max(2, S.view.z * factor));
  const [wx2, wy2] = s2w(sx, sy);
  S.view.cx += wx - wx2;
  S.view.cy += wy - wy2;
  requestDraw();
}
export function centerOn(x, y, z) {
  S.view.cx = x; S.view.cy = y;
  if (z) S.view.z = z;
  requestDraw();
}
export function fitToContent() {
  const b = S.model && S.model.bounds();
  if (!b) { centerOn(0.5, 0.5, 32); return; }
  const w = b.maxx - b.minx + 3, h = b.maxy - b.miny + 3;
  const z = Math.max(4, Math.min(64, Math.floor(Math.min(W / w, H / h))));
  centerOn((b.minx + b.maxx + 1) / 2, (b.miny + b.maxy + 1) / 2, z);
  emit('view');
}

// ---------------------------------------------------------------- baked export
export async function bake(opts) {
  const model = S.model;
  const b = model.bounds();
  if (!b) throw new Error('пустая карта');
  const m = opts.margin ?? 1;
  const px = opts.px || 32;
  const wT = b.maxx - b.minx + 1 + m * 2, hT = b.maxy - b.miny + 1 + m * 2;
  let z = px;
  const maxDim = 16384;
  if (wT * z > maxDim || hT * z > maxDim) z = Math.floor(maxDim / Math.max(wT, hT));
  const w = wT * z, h = hT * z;
  const view = { cx: b.minx - m + wT / 2, cy: b.miny - m + hT / 2, z };
  const layers = { ...S.layers, tiles: opts.tiles !== false, decals: opts.decals !== false, walls: true, objects: true,
    subfloor: true, pipes: !opts.noUtilities, wires: !opts.noUtilities, markers: !!opts.markers };
  // preload every image the render needs
  const jobs = [];
  for (const t of model.tiles.values()) jobs.push(A.tileAsync(t[0], t[2] || 0));
  for (const d of model.decals.values()) jobs.push(A.decalAsync(d.id, d.color));
  for (const e of model.ents.values()) {
    const p = P.ents.get(e.proto);
    if (!p) continue;
    const pl = p.pipeLayers ? pipeLayerOf(e) : null;
    jobs.push(A.spriteAsync(e.proto, rotSteps(e.rot), visualParam(model, e, p), p.pipe !== undefined ? pipeColorOf(e) : null,
      pl && pl !== 'Primary' ? pl : null));
  }
  await Promise.all(jobs);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  render(c, { view, w, h, bake: true, layers, hideSubfloor: opts.hideSubfloor, grid: opts.grid, grates: opts.grates,
    bg: opts.bg === 'transparent' ? 'transparent' : (opts.bg || '#000000') });
  return cv;
}
