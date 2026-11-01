// Mirror-aware editing primitives used by tools and panels.
import { S } from './state.js';
import { P, ent as protoOf } from './protos.js';
import {
  key, unkey, tileOf, rotSteps, normAngle, HALF_PI, mirrorPlacement, mirrorTileVal, rotateTileVal, mirrorDecal,
  PLAIN_PIPES, plainPipeBase, pipeLayerOf, pipeColorOf, pipeDirsOf, fitPipe, CARDINALS, DIR_VEC, OPP, mulberry32, weightedPick,
  entLayer, isStructure, isMarker, hasComp, STACKABLE_RE,
} from './logic.js';

const M = () => S.model;
const near = (a, b) => Math.abs(a - b) < 1e-3;

// ---------------------------------------------------------------- mirror targets
export function tileTargets(x, y, mirror = true) {
  const out = [{ x, y, mx: false, my: false }];
  if (mirror && S.mirror.x) out.push({ x: Math.round(2 * S.mirror.ax - x - 1), y, mx: true, my: false });
  if (mirror && S.mirror.y) out.push({ x, y: Math.round(2 * S.mirror.ay - y - 1), mx: false, my: true });
  if (mirror && S.mirror.x && S.mirror.y) out.push({ x: Math.round(2 * S.mirror.ax - x - 1), y: Math.round(2 * S.mirror.ay - y - 1), mx: true, my: true });
  const seen = new Set();
  return out.filter(t => { const k = key(t.x, t.y); if (seen.has(k)) return false; seen.add(k); return true; });
}
/** Entity placements for all active mirror axes: [{proto, rot, x, y}], original first. */
export function entTargets(proto, rot, x, y, mirror = true) {
  const out = [{ proto, rot, x, y }];
  if (mirror && S.mirror.x) out.push(mirrorPlacement(proto, rot, x, y, 'x', S.mirror.ax));
  if (mirror && S.mirror.y) out.push(mirrorPlacement(proto, rot, x, y, 'y', S.mirror.ay));
  if (mirror && S.mirror.x && S.mirror.y) { const m = out[1]; out.push(mirrorPlacement(m.proto, m.rot, m.x, m.y, 'y', S.mirror.ay)); }
  const seen = new Set();
  return out.filter(t => { const k = t.x.toFixed(3) + ',' + t.y.toFixed(3); if (seen.has(k)) return false; seen.add(k); return true; });
}
export function xformTile(val, t) {
  let v = val;
  if (t.mx) v = mirrorTileVal(v, 'x');
  if (t.my) v = mirrorTileVal(v, 'y');
  return v;
}

/** Snap a world position according to the placement step ('center' | number). */
export function snapPos(wx, wy, step = S.entOpts.step) {
  if (step === 'center' || !step) return [Math.floor(wx) + 0.5, Math.floor(wy) + 0.5];
  const st = +step;
  return [Math.round(wx / st) * st, Math.round(wy / st) * st];
}

/** Extra components for a pipe device placed in atmos mode (current layer + colour). */
export function atmosComps(protoId) {
  const p = protoOf(protoId);
  if (!p || p.pipe === undefined || !p.pipeLayers) return [];
  const out = [];
  if (S.pipe.layer !== 'Primary' && S.pipe.layer !== (p.pipeLayer || 'Primary')) out.push({ type: 'AtmosPipeLayers', pipeLayer: S.pipe.layer });
  if (S.pipe.color) out.push({ type: 'AtmosPipeColor', color: S.pipe.color });
  return out;
}

// ---------------------------------------------------------------- tiles
export function tileValue(name, rnd = Math.random) {
  const t = P.tiles.get(name);
  const variant = t && t.variants > 1 && S.tileOpts.randomVariant ? Math.floor(rnd() * t.variants) : 0;
  return [name, 0, variant, 0];
}
export function paintTile(x, y, val, mirror = true) {
  for (const t of tileTargets(x, y, mirror)) M().setTile(t.x, t.y, val ? xformTile(val, t) : null);
}

// ---------------------------------------------------------------- entities
export const placeWarnings = [];
export function placeEnt({ proto, x, y, rot = 0, comps = [], src = null, contents = null, mirror = true, replace = S.entOpts.replace,
  allowDup = S.entOpts.allowDup, underlay = !src && S.entOpts.underlay, replaceStructs = !src && S.entOpts.replaceStructs }) {
  const model = M();
  const placed = [];
  for (const t of entTargets(proto, rot, x, y, mirror)) {
    const { proto: pr, rot: r } = t;
    const [tx, ty] = tileOf(t.x, t.y);
    const p = protoOf(pr);
    if (replaceStructs && isStructure(p)) {
      // new structure replaces whatever other structures stood on this tile (wall over window+grille, etc.)
      for (const uid of model.entsAt(tx, ty)) {
        const o = model.ents.get(uid);
        if (o.proto !== pr && isStructure(protoOf(o.proto))) model.removeEnt(uid);
      }
    }
    let dup = false;
    if (!allowDup) for (const uid of model.entsAt(tx, ty)) {
      const o = model.ents.get(uid);
      if (o.proto === pr && near(o.x, t.x) && near(o.y, t.y) && rotSteps(o.rot) === rotSteps(r)) { dup = true; break; }
    }
    if (dup) continue;
    if (replace && p && p.replace) {
      for (const uid of model.entsAt(tx, ty)) {
        const op = protoOf(model.ents.get(uid).proto);
        if (op && op.replace === p.replace) model.removeEnt(uid);
      }
    }
    if (!replaceStructs && isStructure(p) && !STACKABLE_RE.test(pr)) {
      const others = model.entsAt(tx, ty).map(u => model.ents.get(u).proto)
        .filter(id => id !== pr && isStructure(protoOf(id)) && !STACKABLE_RE.test(id));
      if (others.length) placeWarnings.push(`(${tx}, ${ty}): ${pr} поверх ${others.join(', ')}`);
    }
    if (underlay && p && !model.getTile(tx, ty) && !isMarker(p) && !hasComp(p, 'Item')) {
      model.setTile(tx, ty, tileValue(S.entOpts.underlayTile || 'Plating'));
    }
    if (src) placed.push(model.cloneEnt(src, t.x, t.y, normAngle(r), pr, contents));
    else placed.push(model.addEnt({ proto: pr, x: t.x, y: t.y, rot: normAngle(r), comps: structuredClone(comps) }));
  }
  return placed;
}

export function visibleEntsAt(x, y) {
  const model = M();
  return model.entsAt(x, y).map(u => model.ents.get(u)).filter(e => {
    const p = protoOf(e.proto);
    const lay = entLayer(p);
    if (!S.layers[lay]) return false;
    if (p && p.pipe !== undefined && !S.pipeLayers[pipeLayerOf(e)]) return false;
    if (S.mode === 'wiring' && lay !== 'wires' && S.tool === 'wire') return false;
    if (S.mode === 'atmos' && lay !== 'pipes' && S.tool === 'pipe') return false;
    return true;
  }).sort((a, b) => ((protoOf(b.proto)?.dd ?? 0) - (protoOf(a.proto)?.dd ?? 0)));
}

export function removeTopEnt(x, y, mirror = true) {
  for (const t of tileTargets(x, y, mirror)) {
    const top = visibleEntsAt(t.x, t.y)[0];
    if (top) M().removeEnt(top.uid);
  }
}
export function removeEntsAt(x, y, mirror = true, pred = null) {
  for (const t of tileTargets(x, y, mirror)) {
    for (const e of visibleEntsAt(t.x, t.y)) if (!pred || pred(e)) M().removeEnt(e.uid);
  }
}

// ---------------------------------------------------------------- decals
export function placeDecal(d, mirror = true) {
  const list = [d];
  if (mirror && S.mirror.x) list.push(mirrorDecal(d, 'x', S.mirror.ax, S.mirror.ay));
  if (mirror && S.mirror.y) list.push(mirrorDecal(d, 'y', S.mirror.ax, S.mirror.ay));
  if (mirror && S.mirror.x && S.mirror.y) list.push(mirrorDecal(mirrorDecal(d, 'x', S.mirror.ax, S.mirror.ay), 'y', S.mirror.ax, S.mirror.ay));
  const seen = new Set();
  for (const x of list) {
    const k = x.x.toFixed(3) + ',' + x.y.toFixed(3) + x.id;
    if (seen.has(k)) continue;
    seen.add(k);
    // skip exact duplicates
    if (M().decalsAt(Math.floor(x.x + 0.5), Math.floor(x.y + 0.5)).some(o => o.id === x.id && near(o.x, x.x) && near(o.y, x.y) && o.color === x.color)) continue;
    M().addDecal({ id: x.id, color: x.color, angle: x.angle || 0, z: x.z || 0, cleanable: !!x.cleanable, x: x.x, y: x.y });
  }
}
export function removeDecalsAt(x, y, mirror = true) {
  for (const t of tileTargets(x, y, mirror)) for (const d of M().decalsAt(t.x, t.y)) M().removeDecal(d._id);
}

// ---------------------------------------------------------------- pipes
export function plainPipeAt(x, y, layer) {
  const model = M();
  for (const uid of model.entsAt(x, y)) {
    const e = model.ents.get(uid);
    if (plainPipeBase(e.proto) && pipeLayerOf(e) === layer) return e;
  }
  return null;
}
export function devicePipeAt(x, y, layer) {
  const model = M();
  for (const uid of model.entsAt(x, y)) {
    const e = model.ents.get(uid);
    const p = protoOf(e.proto);
    if (p && p.pipe !== undefined && !plainPipeBase(e.proto) && pipeLayerOf(e) === layer) return e;
  }
  return null;
}
export function setPipeMask(x, y, layer, mask, color) {
  const model = M();
  const old = plainPipeAt(x, y, layer);
  if (old) {
    if (pipeDirsOf(old) === mask && (color === undefined || pipeColorOf(old) === color)) return;
    if (color === undefined) color = pipeColorOf(old);
    model.removeEnt(old.uid);
  }
  if (!mask) return;
  if (devicePipeAt(x, y, layer)) return;
  const f = fitPipe(mask);
  const comps = [];
  if (layer !== 'Primary') comps.push({ type: 'AtmosPipeLayers', pipeLayer: layer });
  if (color) comps.push({ type: 'AtmosPipeColor', color });
  model.addEnt({ proto: f.proto, x: x + 0.5, y: y + 0.5, rot: f.rot, comps });
}
function pipeMaskAt(x, y, layer) { const p = plainPipeAt(x, y, layer); return p ? pipeDirsOf(p) : 0; }
function dirBetween(ax, ay, bx, by) {
  for (const d of CARDINALS) { const [dx, dy] = DIR_VEC[d]; if (ax + dx === bx && ay + dy === by) return d; }
  return 0;
}
/** connect two adjacent tiles with pipe (mirror aware). */
export function connectPipe(ax, ay, bx, by, layer, color, mirror = true) {
  const A = tileTargets(ax, ay, mirror), B = tileTargets(bx, by, mirror);
  for (let i = 0; i < A.length && i < B.length; i++) {
    const a = A[i], b = B[i];
    const d = dirBetween(a.x, a.y, b.x, b.y);
    if (!d) continue;
    if (!devicePipeAt(a.x, a.y, layer)) setPipeMask(a.x, a.y, layer, pipeMaskAt(a.x, a.y, layer) | d, color);
    if (!devicePipeAt(b.x, b.y, layer)) setPipeMask(b.x, b.y, layer, pipeMaskAt(b.x, b.y, layer) | OPP[d], color);
  }
}
export function erasePipe(x, y, layer, mirror = true) {
  for (const t of tileTargets(x, y, mirror)) {
    const p = plainPipeAt(t.x, t.y, layer) || devicePipeAt(t.x, t.y, layer);
    if (!p) continue;
    M().removeEnt(p.uid);
    for (const d of CARDINALS) {
      const [dx, dy] = DIR_VEC[d];
      const n = plainPipeAt(t.x + dx, t.y + dy, layer);
      if (n && (pipeDirsOf(n) & OPP[d])) setPipeMask(t.x + dx, t.y + dy, layer, pipeDirsOf(n) & ~OPP[d]);
    }
  }
}

// ---------------------------------------------------------------- cables
export const CABLE_PROTO = { HV: 'CableHV', MV: 'CableMV', LV: 'CableApcExtension' };
export function cableAt(x, y, kind) {
  const model = M();
  for (const uid of model.entsAt(x, y)) { const e = model.ents.get(uid); if (protoOf(e.proto)?.cable === kind) return e; }
  return null;
}
export function addCable(x, y, kind, mirror = true) {
  for (const t of tileTargets(x, y, mirror)) {
    if (cableAt(t.x, t.y, kind)) continue;
    M().addEnt({ proto: CABLE_PROTO[kind], x: t.x + 0.5, y: t.y + 0.5, rot: 0, comps: [] });
  }
}
export function removeCable(x, y, kind, mirror = true) {
  for (const t of tileTargets(x, y, mirror)) { const c = cableAt(t.x, t.y, kind); if (c) M().removeEnt(c.uid); }
}

// ---------------------------------------------------------------- flood fill
export function flood(x, y, { stopAtWalls = true, byProto = null, limit = 40000 } = {}) {
  const model = M();
  const start = model.getTile(x, y);
  const name = start ? start[0] : null;
  const b = model.bounds() || { minx: x, maxx: x, miny: y, maxy: y };
  const minx = Math.min(b.minx, x) - 1, maxx = Math.max(b.maxx, x) + 1, miny = Math.min(b.miny, y) - 1, maxy = Math.max(b.maxy, y) + 1;
  const isWall = (tx, ty) => model.entsAt(tx, ty).some(u => protoOf(model.ents.get(u).proto)?.airtight === 'All');
  const match = (tx, ty) => {
    if (byProto) return model.entsAt(tx, ty).some(u => model.ents.get(u).proto === byProto);
    const t = model.getTile(tx, ty);
    if ((t ? t[0] : null) !== name) return false;
    if (stopAtWalls && isWall(tx, ty)) return false;
    return true;
  };
  if (!match(x, y)) return [];
  const out = [], seen = new Set([key(x, y)]), stack = [[x, y]];
  while (stack.length && out.length < limit) {
    const [cx, cy] = stack.pop();
    out.push(key(cx, cy));
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (!name && !byProto && (nx < minx || nx > maxx || ny < miny || ny > maxy)) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      seen.add(k);
      if (match(nx, ny)) stack.push([nx, ny]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- clipboard
export function extract(sel, filter = S.selFilter) {
  const model = M();
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const k of sel) { const [x, y] = unkey(k); minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); }
  if (minx === Infinity) return null;
  const clip = { w: maxx - minx + 1, h: maxy - miny + 1, minx, miny, tiles: [], ents: [], decals: [] };
  for (const k of sel) {
    const [x, y] = unkey(k);
    if (filter.tiles) { const t = model.getTile(x, y); if (t) clip.tiles.push([x - minx, y - miny, t.slice()]); }
    if (filter.ents) {
      for (const uid of model.entsAt(x, y)) {
        const e = model.ents.get(uid);
        const c = structuredClone(e);
        c.x -= minx; c.y -= miny;
        clip.ents.push({ e: c, contents: model.contentsOf(uid) });
      }
    }
    if (filter.decals) for (const d of model.decalsAt(x, y)) { const c = { ...d }; delete c._id; c.x -= minx; c.y -= miny; clip.decals.push(c); }
  }
  return clip;
}

export function deleteSelection(sel, filter = S.selFilter) {
  const model = M();
  for (const k of sel) {
    const [x, y] = unkey(k);
    if (filter.ents) for (const uid of model.entsAt(x, y)) model.removeEnt(uid);
    if (filter.decals) for (const d of model.decalsAt(x, y)) model.removeDecal(d._id);
    if (filter.tiles) model.setTile(x, y, null);
  }
}

/** Return a transformed copy of the clip: k CCW rotations, then flips. */
export function transformClip(clip, { rot = 0, flipX = false, flipY = false }) {
  let c = structuredClone(clip);
  for (let i = 0; i < ((rot % 4) + 4) % 4; i++) {
    const w = c.w, h = c.h;
    c.tiles = c.tiles.map(([x, y, v]) => [h - 1 - y, x, rotateTileVal(v, 1)]);
    c.ents = c.ents.map(o => { const e = o.e; const nx = h - e.y, ny = e.x; return { ...o, e: { ...e, x: nx, y: ny, rot: normAngle((e.rot || 0) + HALF_PI) } }; });
    c.decals = c.decals.map(d => ({ ...d, x: h - 1 - d.y, y: d.x, angle: normAngle((d.angle || 0) + HALF_PI) }));
    c.w = h; c.h = w;
  }
  if (flipX) {
    c.tiles = c.tiles.map(([x, y, v]) => [c.w - 1 - x, y, mirrorTileVal(v, 'x')]);
    c.ents = c.ents.map(o => ({ ...o, e: { ...o.e, ...mirrorPlacement(o.e.proto, o.e.rot || 0, o.e.x, o.e.y, 'x', c.w / 2) } }));
    c.decals = c.decals.map(d => mirrorDecal(d, 'x', c.w / 2, c.h / 2));
  }
  if (flipY) {
    c.tiles = c.tiles.map(([x, y, v]) => [x, c.h - 1 - y, mirrorTileVal(v, 'y')]);
    c.ents = c.ents.map(o => ({ ...o, e: { ...o.e, ...mirrorPlacement(o.e.proto, o.e.rot || 0, o.e.x, o.e.y, 'y', c.h / 2) } }));
    c.decals = c.decals.map(d => mirrorDecal(d, 'y', c.w / 2, c.h / 2));
  }
  return c;
}

/** Paste clip with its bottom-left at (ox, oy). Returns the set of covered tile keys. */
export function pasteClip(clip, ox, oy, mirror = true) {
  const covered = new Set();
  for (const [x, y, v] of clip.tiles) { paintTile(ox + x, oy + y, v, mirror); covered.add(key(ox + x, oy + y)); }
  for (const o of clip.ents) {
    const e = o.e;
    placeEnt({ proto: e.proto, x: ox + e.x, y: oy + e.y, rot: e.rot || 0, src: e, contents: o.contents, mirror, replace: false });
    covered.add(key(...tileOf(ox + e.x, oy + e.y)));
  }
  for (const d of clip.decals) placeDecal({ ...d, x: ox + d.x, y: oy + d.y }, mirror);
  return covered;
}

// ---------------------------------------------------------------- randomization
export function rng() {
  return mulberry32(S.random.fixedSeed ? S.random.seed | 0 : (Math.random() * 2 ** 31) | 0);
}
export function activeSet() { return S.random.sets[S.random.active] || null; }

export function applyRandomAt(x, y, set, rnd, density) {
  if (!set || !set.items.length) return;
  if (rnd() * 100 >= density) return;
  const it = weightedPick(set.items, rnd);
  if (!it) return;
  if (set.kind === 'tile') {
    const t = P.tiles.get(it.id);
    const variant = t && t.variants > 1 ? Math.floor(rnd() * t.variants) : 0;
    paintTile(x, y, [it.id, 0, variant, 0]);
  } else if (set.kind === 'entity') {
    const rot = set.randRot ? (Math.floor(rnd() * 4) * HALF_PI) : 0;
    let px = x + 0.5, py = y + 0.5;
    if (set.jitter) { px += (rnd() - 0.5) * 0.6; py += (rnd() - 0.5) * 0.6; }
    placeEnt({ proto: it.id, x: px, y: py, rot: normAngle(rot), replace: false });
  } else if (set.kind === 'decal') {
    const ang = set.randRot ? Math.floor(rnd() * 4) * HALF_PI : 0;
    let dx = x, dy = y;
    if (set.jitter) { dx += (rnd() - 0.5) * 0.6; dy += (rnd() - 0.5) * 0.6; }
    placeDecal({ id: it.id, color: set.color || '#FFFFFFFF', angle: normAngle(ang), x: dx, y: dy, cleanable: true });
  }
}

export function randomizeVariants(sel, rnd) {
  const model = M();
  for (const k of sel) {
    const [x, y] = unkey(k);
    const t = model.getTile(x, y);
    if (!t) continue;
    const tp = P.tiles.get(t[0]);
    if (!tp || tp.variants <= 1) continue;
    model.setTile(x, y, [t[0], t[1], Math.floor(rnd() * tp.variants), t[3]]);
  }
}
export function randomRotation(sel, rnd) {
  const model = M();
  for (const k of sel) {
    const [x, y] = unkey(k);
    for (const uid of model.entsAt(x, y)) {
      const e = model.ents.get(uid);
      const p = protoOf(e.proto);
      if (!p || p.sm || p.cable || p.pipe !== undefined) continue;
      model.updateEnt(uid, { rot: normAngle(Math.floor(rnd() * 4) * HALF_PI) });
    }
  }
}
