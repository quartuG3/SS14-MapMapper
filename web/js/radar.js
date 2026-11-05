// Mass scanner simulation: draws the grid the way ShuttleNavControl / BaseShuttleControl do in game
// (grid edges, range rings, azimuth scale, docks with labels, radar blips, ship shield).
import { S } from './state.js';
import { P, ent as protoOf } from './protos.js';
import { key, unkey, rotateVec } from './logic.js';

const SELF_DEFAULT_SHIELD = 'rgba(0,170,255,0.92)';   // ShipShieldVisualsComponent.ShieldColor
const SHIELD_PADDING = 50;                            // ShipShieldVisualsComponent.Padding
const DOCK_SCALE = 0.6;
const SQUARE = [[0, 0], [1, 0], [1, 1], [0, 1]];
const DIRS = { W: [-1, 0], E: [1, 0], S: [0, -1], N: [0, 1] };
const OPP = { W: 'E', E: 'W', S: 'N', N: 'S' };

// ---------------------------------------------------------------- colours
const probe = document.createElement('canvas').getContext('2d');
/** CSS colour for a Robust colour string (#RRGGBBAA, names like CornflowerBlue), with alpha override. */
export function cssColor(c, alpha = null) {
  probe.fillStyle = '#000';
  probe.fillStyle = String(c || '');
  let v = probe.fillStyle;   // '#rrggbb' or 'rgba(r, g, b, a)'
  if (v === '#000000' && !/^(#0{3,8}|black)$/i.test(String(c).trim())) v = '#ff4500';   // unknown -> OrangeRed
  if (alpha === null) return v;
  const m = v.startsWith('#') ? [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)] : v.match(/[\d.]+/g).slice(0, 3).map(Number);
  return `rgba(${m[0]},${m[1]},${m[2]},${alpha})`;
}
function withAlphaIfOpaque(c, a) {
  probe.fillStyle = '#000';
  probe.fillStyle = c;
  return probe.fillStyle.startsWith('#') ? cssColor(c, a) : probe.fillStyle;
}

// ---------------------------------------------------------------- geometry
function edgeDir(a, b) {
  if (a[0] === 0 && b[0] === 0) return 'W';
  if (a[0] === 1 && b[0] === 1) return 'E';
  if (a[1] === 0 && b[1] === 0) return 'S';
  if (a[1] === 1 && b[1] === 1) return 'N';
  return null;
}
const tileVerts = name => P.tiles.get(name)?.verts || SQUARE;

/** Outline segments [[x0, y0], [x1, y1]] of the grid: tile edges not covered by the neighbour (BaseShuttleControl.DrawGrid). */
export function gridEdges(model) {
  const tiles = [], dirEdges = new Map();
  for (const [k, t] of model.tiles) {
    if (P.tiles.get(t[0])?.space) continue;
    const [x, y] = unkey(k);
    const v = tileVerts(t[0]);
    tiles.push({ x, y, v });
    const de = {};
    let prev = v[v.length - 1];
    for (const vert of v) { const d = edgeDir(prev, vert); if (d) de[d] = [prev, vert]; prev = vert; }
    dirEdges.set(k, de);
  }
  const out = [];
  const seg = (x, y, a, b) => out.push([[x + a[0], y + a[1]], [x + b[0], y + b[1]]]);
  for (const { x, y, v } of tiles) {
    let prev = v[v.length - 1];
    for (const vert of v) {
      const wasPrev = prev;
      prev = vert;
      const d = edgeDir(wasPrev, vert);
      const other = d && dirEdges.get(key(x + DIRS[d][0], y + DIRS[d][1]))?.[OPP[d]];
      if (other) {
        const [dx, dy] = DIRS[d];
        const oP = [other[0][0] + dx, other[0][1] + dy], oV = [other[1][0] + dx, other[1][1] + dy];
        const ev = [oV[0] - oP[0], oV[1] - oP[1]];
        const l2 = ev[0] * ev[0] + ev[1] * ev[1];
        const at = p => ((p[0] - oP[0]) * ev[0] + (p[1] - oP[1]) * ev[1]) / l2;
        const pt = t => [oP[0] + ev[0] * t, oP[1] + ev[1] * t];
        let a = at(wasPrev), b = at(vert);
        if (a > b) [a, b] = [b, a];
        if (a >= 0 && b <= 1) continue;          // fully inside the neighbour's edge
        if (!(a >= 1 || b <= 0)) {                // overlapping: draw what sticks out
          if (a >= 0 || b <= 1) {
            if (b <= 1) b = 0;
            if (a >= 0) a = 1;
            seg(x, y, pt(a), pt(b));
          } else {
            seg(x, y, pt(a), oP);
            seg(x, y, oV, pt(b));
          }
          continue;
        }
      }
      seg(x, y, wasPrev, vert);
    }
  }
  // GridEdgeMarker entities add their own edges (RadarGridEdgesSystem), also inside the grid
  for (const e of model.ents.values()) {
    const em = protoOf(e.proto)?.edgeMark;
    if (!em) continue;
    const [bx, by] = rotateVec(em[0], em[1], e.rot || 0), [ex, ey] = rotateVec(em[2], em[3], e.rot || 0);
    out.push([[e.x + bx, e.y + by], [e.x + ex, e.y + ey]]);
  }
  return out;
}

function tileBounds(model) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [k, t] of model.tiles) {
    if (P.tiles.get(t[0])?.space) continue;
    const [x, y] = unkey(k);
    minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x + 1); maxy = Math.max(maxy, y + 1);
  }
  return minx === Infinity ? null : { minx, miny, maxx, maxy };
}

/** Radar origin candidates: shuttle consoles first. */
export function radarCenters(model) {
  const out = [];
  for (const e of model.ents.values()) {
    const p = protoOf(e.proto);
    if (p && (p.c || []).includes('ShuttleConsole')) out.push({ uid: e.uid, label: `${e.proto} (${Math.floor(e.x)}, ${Math.floor(e.y)})`, x: e.x, y: e.y });
  }
  return out;
}
export function resolveCenter(model, o) {
  const b = tileBounds(model);
  const gridCenter = b ? [(b.minx + b.maxx) / 2, (b.miny + b.maxy) / 2] : [0, 0];
  if (o.center === 'grid') return gridCenter;
  const list = radarCenters(model);
  const c = (o.center !== 'console' && list.find(x => x.uid === o.center)) || list[0];
  return c ? [c.x, c.y] : gridCenter;
}
/** View radius that fits the whole grid around the centre. */
export function fitRange(model, center) {
  const b = tileBounds(model);
  if (!b) return 32;
  let r = 0;
  for (const [x, y] of [[b.minx, b.miny], [b.maxx, b.miny], [b.minx, b.maxy], [b.maxx, b.maxy]]) r = Math.max(r, Math.hypot(x - center[0], y - center[1]));
  return Math.max(16, Math.ceil(r * 1.15));
}
export function shieldColor(model) {
  for (const e of model.ents.values()) {
    const c = protoOf(e.proto)?.shield;
    if (c) return withAlphaIfOpaque(c, 0.92);   // ShipShieldsSystem: opaque emitter colours get alpha 0.92
  }
  return SELF_DEFAULT_SHIELD;
}

// ---------------------------------------------------------------- blips (ShuttleNavControl.DrawBlipShape)
function blipPolygons(shape, bounds, rot, scale) {
  let [l, b, r, t] = bounds;
  if (scale !== 1) { l *= scale; b *= scale; r *= scale; t *= scale; }
  const R = p => rotateVec(p[0], p[1], rot);
  const TL = R([l, t]), TR = R([r, t]), BR = R([r, b]), BL = R([l, b]);
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const off = mid(TR, BL), top = mid(TL, TR), left = mid(TL, BL);
  const T = [top[0] - off[0], top[1] - off[1]], L = [left[0] - off[0], left[1] - off[1]];
  const at = (u, v) => [off[0] + u * L[0] + v * T[0], off[1] + u * L[1] + v * T[1]];
  switch (shape) {
    case 'Square': return [TL, TR, BR, BL];
    case 'Triangle': return [R(mid(TL, TR)), BL, BR];   // the game rotates the already rotated apex once more
    case 'Diamond': return [at(0, 1), at(1, 0), at(0, -1), at(-1, 0)];
    case 'Circle': return Array.from({ length: 64 }, (_, i) => { const a = i * Math.PI * 2 / 64; return at(Math.sin(a), Math.cos(a)); });
    case 'Star': return Array.from({ length: 10 }, (_, i) => { const a = i * Math.PI / 5, k = i % 2 ? 0.4 : 1; return at(k * Math.sin(a), -k * Math.cos(a)); });
    case 'Hexagon': return Array.from({ length: 6 }, (_, i) => { const a = i * Math.PI / 3; return at(-Math.cos(a), Math.sin(a)); });
    case 'Arrow': return [at(0, -1), at(1, 0.5), at(0, 1), at(-1, 0.5)];
    default: return null;   // GridAlignedBox / Ring are not drawn by the nav control either
  }
}

// ---------------------------------------------------------------- azimuth (BaseShuttleControl.DrawAzimuthScale)
function edgePoint(origin, dir, W, H, inset) {
  const min = [inset, inset], max = [W - inset, H - inset];
  const tx = dir[0] > 0 ? (max[0] - origin[0]) / dir[0] : dir[0] < 0 ? (min[0] - origin[0]) / dir[0] : Infinity;
  const ty = dir[1] > 0 ? (max[1] - origin[1]) / dir[1] : dir[1] < 0 ? (min[1] - origin[1]) / dir[1] : Infinity;
  const t = Math.min(tx, ty);
  if (!isFinite(t) || t <= 0) return null;
  const p = [origin[0] + dir[0] * t, origin[1] + dir[1] * t];
  const n = tx < ty ? (dir[0] > 0 ? [-1, 0] : [1, 0]) : (dir[1] > 0 ? [0, -1] : [0, 1]);
  return { p, n };
}
function drawAzimuth(c, W, H) {
  const origin = [W / 2, H / 2];
  const gray = a => `rgba(103,103,103,${a})`;
  for (let step = 0; step < 36; step++) {
    const deg = step * 10;
    const a = deg * Math.PI / 180 - Math.PI / 2;
    const ep = edgePoint(origin, [Math.cos(a), Math.sin(a)], W, H, 10);
    if (!ep) continue;
    const cardinal = step % 9 === 0, major = step % 3 === 0;
    const len = cardinal ? 12 : major ? 9 : 5;
    const outer = [ep.p[0] + ep.n[0] * 4, ep.p[1] + ep.n[1] * 4], inner = [outer[0] + ep.n[0] * len, outer[1] + ep.n[1] * len];
    c.strokeStyle = deg === 0 ? 'rgba(127,116,66,0.58)' : deg === 90 ? 'rgba(69,98,115,0.58)' : gray(cardinal ? 0.68 : major ? 0.5 : 0.34);
    c.beginPath(); c.moveTo(outer[0], outer[1]); c.lineTo(inner[0], inner[1]); c.stroke();
    if (!major) continue;
    const label = String(deg);
    c.font = `${cardinal ? 12 : 11}px "Noto Sans", "Segoe UI", sans-serif`;
    const tw = c.measureText(label).width, th = cardinal ? 12 : 11;
    const off = 4 + 12 + 3, anchor = [ep.p[0] + ep.n[0] * off, ep.p[1] + ep.n[1] * off];
    let pos = Math.abs(ep.n[0]) > Math.abs(ep.n[1])
      ? (ep.n[0] > 0 ? [anchor[0], anchor[1] - th / 2] : [anchor[0] - tw, anchor[1] - th / 2])
      : (ep.n[1] > 0 ? [anchor[0] - tw / 2, anchor[1]] : [anchor[0] - tw / 2, anchor[1] - th]);
    pos = [Math.min(Math.max(pos[0], off), W - tw - off), Math.min(Math.max(pos[1], off), H - th - off)];
    c.textBaseline = 'top';
    c.fillStyle = 'rgba(0,0,0,0.36)'; c.fillText(label, pos[0] + 1, pos[1] + 1);
    c.fillStyle = deg === 90 ? 'rgba(69,98,115,0.76)' : gray(cardinal ? 0.9 : 0.76);
    c.fillText(label, pos[0], pos[1]);
  }
  c.textBaseline = 'alphabetic';
}

// ---------------------------------------------------------------- main
/** Draw the scanner into a W×H canvas context. o: radar options (S.radar). */
export function drawRadar(c, W, H, o, model = S.model) {
  const center = resolveCenter(model, o);
  const range = o.range || fitRange(model, center);
  const radius = Math.min(W, H) / 2;
  const scale = radius / range;
  const mid = [W / 2, H / 2];
  const toV = (x, y) => [mid[0] + (x - center[0]) * scale, mid[1] - (y - center[1]) * scale];
  const font = px => `${px}px "Noto Sans", "Segoe UI", sans-serif`;
  c.save();
  c.fillStyle = o.bg; c.fillRect(0, 0, W, H);
  c.lineWidth = 1;

  // grid fill: the outline colour blended 1% into the backing
  c.fillStyle = mixColor(o.bg, o.color, 0.01);
  for (const [k, t] of model.tiles) {
    if (P.tiles.get(t[0])?.space) continue;
    const [x, y] = unkey(k);
    const v = tileVerts(t[0]);
    c.beginPath();
    v.forEach(([vx, vy], i) => { const [sx, sy] = toV(x + vx, y + vy); i ? c.lineTo(sx, sy) : c.moveTo(sx, sy); });
    c.fill();
  }

  // range rings (2^3 .. 2^12 m) and radial lines
  if (o.rings) {
    const corner = Math.SQRT2 * range;
    c.font = font(12);
    for (let r = 8; r <= 4096; r *= 2) {
      if (r > corner) continue;
      c.strokeStyle = c.fillStyle = 'rgba(211,211,211,0.16)';
      c.beginPath(); c.arc(mid[0], mid[1], r * scale, 0, Math.PI * 2); c.stroke();
      c.fillText(`${r}m`, mid[0], mid[1] - r * scale - 2);
    }
    c.strokeStyle = 'rgba(0,250,154,0.07)';
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 * i, ex = Math.cos(a) * radius * 1.42, ey = Math.sin(a) * radius * 1.42;
      c.beginPath(); c.moveTo(mid[0] - ex, mid[1] - ey); c.lineTo(mid[0] + ex, mid[1] + ey); c.stroke();
    }
  }

  // shield: oval around the grid bounds plus padding (ShipShieldsSystem.GenerateOvalFixture)
  const b = tileBounds(model);
  if (o.shield && b) {
    const cx = (b.minx + b.maxx) / 2, cy = (b.miny + b.maxy) / 2;
    const rx = (b.maxx - b.minx + SHIELD_PADDING) / 2, ry = (b.maxy - b.miny + SHIELD_PADDING) / 2;
    c.strokeStyle = o.shieldColor ? cssColor(o.shieldColor, 0.92) : shieldColor(model);
    c.beginPath();
    for (let i = 0; i <= 64; i++) {
      const a = Math.PI * 2 * i / 64;
      const [sx, sy] = toV(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
      i ? c.lineTo(sx, sy) : c.moveTo(sx, sy);
    }
    c.stroke();
  }

  // north line + azimuth scale
  c.strokeStyle = 'rgba(255,0,0,0.3)';
  c.beginPath(); c.moveTo(mid[0], mid[1]); c.lineTo(mid[0], mid[1] - radius * 1.42); c.stroke();
  if (o.azimuth) drawAzimuth(c, W, H);

  // own grid outline
  c.strokeStyle = o.color;
  c.beginPath();
  for (const [a, e] of gridEdges(model)) {
    const [x0, y0] = toV(...a), [x1, y1] = toV(...e);
    c.moveTo(x0, y0); c.lineTo(x1, y1);
  }
  c.stroke();

  // docks: highlighted radar colour squares, labels on top (Frontier)
  if (o.docks) {
    const labels = [];
    for (const e of model.ents.values()) {
      const p = protoOf(e.proto);
      if (!p?.dock) continue;
      const comp = (e.comps || []).find(x => x.type === 'Docking') || {};
      const color = comp.highlightedRadarColor || p.dock.color;
      const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([dx, dy]) => toV(e.x + dx * DOCK_SCALE, e.y + dy * DOCK_SCALE));
      c.beginPath(); pts.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.closePath();
      c.fillStyle = cssColor(color, 0.8); c.fill();
      c.strokeStyle = cssColor(color); c.stroke();
      const name = comp.name || p.dock.name;
      if (name) labels.push([P.dockLabels[name] || name, toV(e.x, e.y)]);
    }
    if (o.labels) {
      c.font = font(11); c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
      const seen = new Set();
      for (const [text, [x, y]] of labels) { if (seen.has(text)) continue; seen.add(text); c.fillText(text, x, y); }
      c.textAlign = 'start'; c.textBaseline = 'alphabetic';
    }
  }

  // radar position
  c.fillStyle = '#00ff00';
  c.beginPath();
  [[0, -2], [1, 0], [0, 2], [-1, 0]].forEach(([x, y], i) => { const px = mid[0] + x * scale, py = mid[1] + y * scale; i ? c.lineTo(px, py) : c.moveTo(px, py); });
  c.fill();

  // signatures
  if (o.blips) {
    for (const e of model.ents.values()) {
      const bl = protoOf(e.proto)?.blip;
      if (!bl) continue;
      const poly = blipPolygons(bl.shape, bl.bounds, bl.rot ? -(e.rot || 0) : 0, bl.zoom ? scale : 1);
      if (!poly) continue;
      const [px, py] = toV(e.x, e.y);
      c.fillStyle = cssColor(bl.color, 0.8);
      c.beginPath(); poly.forEach(([x, y], i) => i ? c.lineTo(px + x, py + y) : c.moveTo(px + x, py + y)); c.closePath(); c.fill();
    }
  }
  c.restore();
  return { range, center };
}

function mixColor(a, b, t) {
  const rgb = s => { probe.fillStyle = s; const v = probe.fillStyle; return v.startsWith('#') ? [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16)) : v.match(/[\d.]+/g).slice(0, 3).map(Number); };
  const x = rgb(a), y = rgb(b);
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`;
}
