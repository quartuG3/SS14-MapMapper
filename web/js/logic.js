// Geometry, rotation, smoothing and network logic shared by renderer and tools.
import { P, ent as protoOf, mirrorId } from './protos.js';
import { symOverride } from './symmetry.js';

export const HALF_PI = Math.PI / 2;
// Direction bits (same as WireVisDirFlags): N=1 S=2 E=4 W=8
export const N = 1, S = 2, E = 4, W = 8;
export const DIR_VEC = { [N]: [0, 1], [S]: [0, -1], [E]: [1, 0], [W]: [-1, 0] };
export const OPP = { [N]: S, [S]: N, [E]: W, [W]: E };
export const CARDINALS = [N, S, E, W];

export const key = (x, y) => x + ',' + y;
export const unkey = k => k.split(',').map(Number);
export const tileOf = (x, y) => [Math.floor(x), Math.floor(y)];

export function normAngle(r) {
  r = r % (2 * Math.PI);
  if (r > Math.PI + 1e-9) r -= 2 * Math.PI;
  if (r <= -Math.PI + 1e-9) r += 2 * Math.PI;
  for (const c of [0, HALF_PI, Math.PI, -HALF_PI]) if (Math.abs(r - c) < 1e-6) return c;
  return r;
}
/** rotation steps CCW, 0 = south facing. */
export const rotSteps = r => (((Math.round((r || 0) / HALF_PI)) % 4) + 4) % 4;
export const stepsToRot = k => normAngle(((k % 4) + 4) % 4 * HALF_PI);

/** rotate direction bitmask k steps CCW (S->E->N->W->S). */
export function rotateDirs(mask, k) {
  k = ((k % 4) + 4) % 4;
  for (let i = 0; i < k; i++) {
    let m = 0;
    if (mask & S) m |= E;
    if (mask & E) m |= N;
    if (mask & N) m |= W;
    if (mask & W) m |= S;
    mask = m;
  }
  return mask;
}
export function mirrorDirs(mask, axis) {
  let m = mask & (axis === 'x' ? (N | S) : (E | W));
  if (axis === 'x') { if (mask & E) m |= W; if (mask & W) m |= E; } else { if (mask & N) m |= S; if (mask & S) m |= N; }
  return m;
}
export const bitCount = m => ((m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1));

export function rotateVec(x, y, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

// ---------------------------------------------------------------- pipes
export const PLAIN_PIPES = {
  GasPipeHalf: S, GasPipeStraight: N | S, GasPipeBend: S | W, GasPipeTJunction: S | E | W, GasPipeFourway: 15,
};
const LAYER_NUM = { 0: 'Primary', 1: 'Secondary', 2: 'Tertiary' };
export function pipeLayerOf(e) {
  const c = (e.comps || []).find(c => c.type === 'AtmosPipeLayers');
  const v = (c && c.pipeLayer) || protoOf(e.proto)?.pipeLayer || 'Primary';
  return LAYER_NUM[v] || v;
}
/** plain pipe base id (GasPipeBendAlt2 -> GasPipeBend) or null. */
export function plainPipeBase(id) {
  const b = id.replace(/Alt\d$/, '');
  return PLAIN_PIPES[b] !== undefined ? b : null;
}
export function pipeColorOf(e) {
  const c = (e.comps || []).find(c => c.type === 'AtmosPipeColor');
  if (c && c.color) return c.color;
  const p = protoOf(e.proto);
  return (p && p.pipeColor) || null;
}
export function pipeDirsOf(e) {
  const p = protoOf(e.proto);
  if (!p || p.pipe === undefined) return 0;
  return rotateDirs(p.pipe, rotSteps(e.rot));
}
/** choose plain pipe proto + rotation for a connection mask. */
export function fitPipe(mask) {
  const n = bitCount(mask);
  let proto;
  if (n === 0) return null;
  if (n === 1) proto = 'GasPipeHalf';
  else if (n === 2) proto = (mask === (N | S) || mask === (E | W)) ? 'GasPipeStraight' : 'GasPipeBend';
  else if (n === 3) proto = 'GasPipeTJunction';
  else proto = 'GasPipeFourway';
  const base = PLAIN_PIPES[proto];
  for (let k = 0; k < 4; k++) if (rotateDirs(base, k) === mask) return { proto, rot: stepsToRot(k) };
  return { proto, rot: 0 };
}

// ---------------------------------------------------------------- disposals
// p.disp: connection mask at rotation 0, p.dispKind: transit | tagger | entry | bend | junction | router | signal | broken.
// Junction-like tubes route items out through their facing direction (the "exit"), rotateDirs(S, steps).
export const isDisposal = p => !!p && p.disp !== undefined;
export function dispDirsOf(e) {
  const p = protoOf(e.proto);
  return p && p.disp ? rotateDirs(p.disp, rotSteps(e.rot)) : 0;
}
export const dispExit = rot => rotateDirs(S, rotSteps(rot));
/** Junction families that can be cycled with T, in order. */
export const DISP_FAMILIES = ['junction', 'router', 'signal'];
let dispByKind = null;
/** Placeable prototypes of a disposal kind, the plain ones (DisposalJunction before ...Flipped) first. */
export function disposalProtos(kind) {
  if (!dispByKind) {
    dispByKind = {};
    for (const p of P.ents.values()) if (isDisposal(p) && !p.donotmap) (dispByKind[p.dispKind] ||= []).push(p);
    for (const l of Object.values(dispByKind)) l.sort((a, b) => !!a.hidden - !!b.hidden || a.id.length - b.id.length || a.id.localeCompare(b.id));
  }
  return dispByKind[kind] || [];
}
/** All {proto, rot, exit} of a kind whose connections equal mask. */
export function disposalVariants(kind, mask) {
  const out = [];
  for (const p of disposalProtos(kind)) {
    for (let k = 0; k < 4; k++) if (rotateDirs(p.disp, k) === mask) { out.push({ proto: p.id, rot: stepsToRot(k), exit: rotateDirs(S, k) }); break; }
  }
  return out;
}
/** Tube kind for a connection mask; keeps the kind of the old tube when it still fits (tagger, router…). */
export function disposalKindFor(mask, oldKind, junctionKind = 'junction') {
  const n = bitCount(mask);
  if (n === 1) return 'entry';
  if (n === 2) {
    if (mask !== (N | S) && mask !== (E | W)) return 'bend';
    return oldKind === 'tagger' ? 'tagger' : 'transit';
  }
  if (n === 3) return DISP_FAMILIES.includes(oldKind) ? oldKind : junctionKind;
  return null;   // no four-way disposal tube exists
}
/** Choose {proto, rot} for a disposal mask. exit: preferred exit direction for junctions. */
export function fitDisposal(mask, { oldKind = null, junctionKind = 'junction', exit = 0 } = {}) {
  const kind = disposalKindFor(mask, oldKind, junctionKind);
  if (!kind) return null;
  const vars = disposalVariants(kind, mask);
  return vars.find(v => v.exit === exit) || vars[0] || null;
}

// ---------------------------------------------------------------- mirroring / rotating entities
/** Mirror an entity's proto + rotation along axis. Returns {proto, rot}. */
export function mirrorEntity(protoId, rot, axis) {
  const generic = axis === 'x' ? -rot : Math.PI - rot;
  const o = symOverride('entity', protoId, rotSteps(rot), axis);
  if (o) return { proto: o.id, rot: o.rot === null ? normAngle(generic) : stepsToRot(o.rot) };
  const p = protoOf(protoId);
  const m = mirrorId('entity', protoId, axis);
  if (m.dirSwap) return { proto: m.id, rot };
  if (m.chiral) return { proto: m.id, rot: normAngle(generic) };
  if (p && p.sm && (p.sm.mode === 'Diagonal' || p.sm.mode === 'DiagonalNF')) {
    return { proto: protoId, rot: normAngle(axis === 'x' ? -rot - HALF_PI : HALF_PI - rot) };
  }
  const dirs = p && (p.pipe || p.disp);
  if (dirs) {
    const want = mirrorDirs(rotateDirs(dirs, rotSteps(rot)), axis);
    if (rotateDirs(dirs, rotSteps(generic)) === want) return { proto: protoId, rot: normAngle(generic) };
    for (let k = 0; k < 4; k++) if (rotateDirs(dirs, k) === want) return { proto: protoId, rot: stepsToRot(k) };
  }
  return { proto: protoId, rot: normAngle(generic) };
}

// ---------------------------------------------------------------- shaped tiles (by vertex geometry)
// Wedges, corners, half-tilts and the like are separate tile prototypes per orientation. Their counterpart
// after a rotation / mirror is the tile of the same family whose polygon matches the transformed one.
let shapeIndex = null;
const shapeKey = (fam, verts) => fam + '|' + verts.map(([x, y]) => `${+x.toFixed(3)},${+y.toFixed(3)}`).sort().join(';');
function shapeTileFor(id, fn) {
  const t = P.tiles.get(id);
  if (!t || !t.verts) return null;
  if (!shapeIndex) {
    shapeIndex = new Map();
    // debug duplicates last, so a real tile wins when two share one shape
    const tiles = [...P.tiles.values()].filter(x => x.verts).sort((a, b) => /debug/i.test(a.id) - /debug/i.test(b.id));
    for (const x of tiles) { const k = shapeKey(x.fam, x.verts); if (!shapeIndex.has(k)) shapeIndex.set(k, x.id); }
  }
  return shapeIndex.get(shapeKey(t.fam, t.verts.map(fn))) || null;
}
const SHAPE_FN = {
  x: ([x, y]) => [1 - x, y],
  y: ([x, y]) => [x, 1 - y],
  ccw: ([x, y]) => [1 - y, x],   // 90° CCW around the tile centre
};

function flipRotmir(rm, axis) {
  const r = rm % 4;
  return (axis === 'x' ? r : (r + 2) % 4) + (rm >= 4 ? 0 : 4);
}
/** Offset from the origin to the centre of a multi-tile footprint (e.g. 2×2 thrusters), rotated with the entity. */
export function footprintOffset(protoId, rot) {
  const fp = protoOf(protoId)?.fp;
  return fp ? rotateVec(fp[0], fp[1], rot || 0) : [0, 0];
}
const r6 = v => Math.round(v * 1e6) / 1e6;
/** Mirror a placed entity across the line x = a (axis 'x') or y = a (axis 'y').
 *  The footprint centre is mirrored, so multi-tile machines end up symmetric, not just their origin tile. */
export function mirrorPlacement(protoId, rot, x, y, axis, a) {
  const m = mirrorEntity(protoId, rot, axis);
  const [ox, oy] = footprintOffset(protoId, rot), [nx, ny] = footprintOffset(m.proto, m.rot);
  let cx = x + ox, cy = y + oy;
  if (axis === 'x') cx = 2 * a - cx; else cy = 2 * a - cy;
  return { proto: m.proto, rot: m.rot, x: r6(cx - nx), y: r6(cy - ny) };
}

export function mirrorTileVal(val, axis) {
  // val = [name, flags, variant, rotmir]
  const o = symOverride('tile', val[0], val[3] || 0, axis);
  if (o) {
    const t = P.tiles.get(o.id);
    const rm = !t || !t.rotmir ? 0 : o.rot === null ? flipRotmir(val[3] || 0, axis) : o.rot;
    return [o.id, val[1], t && val[2] >= (t.variants || 1) ? 0 : val[2], rm];
  }
  const shaped = shapeTileFor(val[0], SHAPE_FN[axis]);
  const m = shaped ? { id: shaped } : mirrorId('tile', val[0], axis);
  const t = P.tiles.get(m.id);
  let rm = val[3] || 0;
  if (t && t.rotmir) rm = flipRotmir(rm, axis);
  return [m.id, val[1], val[2], rm];
}
export function rotateTileVal(val, k) {
  const t = P.tiles.get(val[0]);
  if (!t || !t.rotmir) {
    if (t && t.verts) {
      let id = val[0];
      for (let i = 0; i < ((k % 4) + 4) % 4; i++) id = shapeTileFor(id, SHAPE_FN.ccw) || id;
      return [id, val[1], val[2], val[3]];
    }
    // 180° is a mirror along both axes, so symmetry presets apply to it
    if (((k % 4) + 4) % 4 === 2) return mirrorTileVal(mirrorTileVal(val, 'x'), 'y');
    // rotate corner tiles by name: NE -> NW -> SW -> SE (CCW)
    const ring = ['NE', 'NW', 'SW', 'SE'];
    for (let i = 0; i < 4; i++) {
      if (val[0].endsWith(ring[i])) {
        const cand = val[0].slice(0, -2) + ring[(i + k) % 4];
        if (P.tiles.has(cand)) return [cand, val[1], val[2], val[3]];
      }
    }
    return val.slice();
  }
  const rm = val[3] || 0;
  return [val[0], val[1], val[2], ((rm % 4) + k) % 4 + (rm >= 4 ? 4 : 0)];
}

export function mirrorDecal(d, axis, ax, ay) {
  const a = d.angle || 0;
  const o = symOverride('decal', d.id, rotSteps(a), axis);
  const m = o ? { id: o.id, dirSwap: false } : mirrorId('decal', d.id, axis);
  const out = { ...d, id: m.id };
  if (axis === 'x') { out.x = 2 * ax - d.x - 1; out.angle = m.dirSwap || !a ? a : normAngle(-a); }
  else { out.y = 2 * ay - d.y - 1; out.angle = m.dirSwap || !a ? a : normAngle(Math.PI - a); }
  if (o && o.rot !== null) out.angle = stepsToRot(o.rot);
  return out;
}

// ---------------------------------------------------------------- smoothing
/** angle -> cardinal (0=S,1=E,2=N,3=W) for a vector, SS14 style. */
function vecCardinal(x, y) {
  let a = Math.atan2(y, x) + HALF_PI;
  a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return Math.floor((a + Math.PI / 4) / HALF_PI) % 4;
}

function smoothOnEdge(target, tp, ox, oy) {
  const mode = tp.sm.mode;
  if (mode !== 'Diagonal' && mode !== 'DiagonalNF') return true;
  const [vx, vy] = rotateVec(-ox, -oy, -(target.rot || 0));
  const d = vecCardinal(vx, vy);
  return d === 0 || d === 1;
}

export function matchSmooth(model, smKey, x, y, ox, oy) {
  const ids = model.entsAt(x + ox, y + oy);
  for (const uid of ids) {
    const t = model.ents.get(uid);
    const tp = protoOf(t.proto);
    if (tp && tp.sm && tp.sm.key === smKey && smoothOnEdge(t, tp, ox, oy)) return true;
  }
  return false;
}

/** Compute the smoothing / cable state parameter for an entity's sprite request. */
export function visualParam(model, e, p) {
  const [x, y] = tileOf(e.x, e.y);
  if (p.cable) {
    let m = 0;
    for (const d of CARDINALS) {
      const [dx, dy] = DIR_VEC[d];
      for (const uid of model.entsAt(x + dx, y + dy)) {
        const o = protoOf(model.ents.get(uid).proto);
        if (o && o.cable === p.cable) { m |= d; break; }
      }
    }
    return String(m);
  }
  const sm = p.sm;
  if (!sm || !sm.key) return '';
  const k = sm.key;
  const mode = sm.mode || 'Corners';
  if (mode === 'Corners') {
    const n = matchSmooth(model, k, x, y, 0, 1), ne = matchSmooth(model, k, x, y, 1, 1),
      ee = matchSmooth(model, k, x, y, 1, 0), se = matchSmooth(model, k, x, y, 1, -1),
      s = matchSmooth(model, k, x, y, 0, -1), sw = matchSmooth(model, k, x, y, -1, -1),
      w = matchSmooth(model, k, x, y, -1, 0), nw = matchSmooth(model, k, x, y, -1, 1);
    let cNE = 0, cSE = 0, cSW = 0, cNW = 0;
    if (n) { cNE |= 1; cNW |= 4; }
    if (ne) cNE |= 2;
    if (ee) { cNE |= 4; cSE |= 1; }
    if (se) cSE |= 2;
    if (s) { cSE |= 4; cSW |= 1; }
    if (sw) cSW |= 2;
    if (w) { cSW |= 4; cNW |= 1; }
    if (nw) cNW |= 2;
    const st = rotSteps(e.rot);
    let r;
    if (st === 2) r = [cSW, cSE, cNE, cNW];       // North
    else if (st === 3) r = [cSE, cNE, cNW, cSW];  // West
    else if (st === 0) r = [cNE, cNW, cSW, cSE];  // South
    else r = [cNW, cSW, cSE, cNE];                // East
    return r.join(',');
  }
  if (mode === 'CardinalFlags') {
    let m = 0;
    if (matchSmooth(model, k, x, y, 0, 1)) m |= 1;
    if (matchSmooth(model, k, x, y, 0, -1)) m |= 2;
    if (matchSmooth(model, k, x, y, 1, 0)) m |= 4;
    if (matchSmooth(model, k, x, y, -1, 0)) m |= 8;
    // AME shielding surrounded by shielding on all 8 sides is a core (AmeNodeGroup)
    if (m === 15 && hasComp(p, 'AmeShield') && isAmeCore(model, x, y)) return '15|core';
    return String(m);
  }
  const rot = e.rot || 0;
  const rv = (vx, vy) => rotateVec(vx, vy, rot).map(Math.round);
  if (mode === 'Diagonal') {
    let ok = true;
    for (const [vx, vy] of [[1, 0], [1, -1], [0, -1]]) {
      const [ox, oy] = rv(vx, vy);
      ok = ok && matchSmooth(model, k, x, y, ox, oy);
    }
    return ok ? '1' : '0';
  }
  if (mode === 'DiagonalNF') {
    let v = 0;
    const nb = [[1, 0], [0, -1]];
    for (let i = 0; i < 2; i++) {
      const [ox, oy] = rv(...nb[i]);
      if (matchSmooth(model, k, x, y, ox, oy)) v |= 1 << i;
    }
    if (v === 3) {
      const [ox, oy] = rv(1, -1);
      if (matchSmooth(model, k, x, y, ox, oy)) v = 4;
    }
    return String(v);
  }
  return '';
}

// ---------------------------------------------------------------- AME
const isAmeShieldAt = (model, x, y) => model.entsAt(x, y).some(u => hasComp(protoOf(model.ents.get(u).proto), 'AmeShield'));

export function isAmeCore(model, x, y) {
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      if ((dx || dy) && !isAmeShieldAt(model, x + dx, y + dy)) return false;
  return true;
}

/** AmeNodeGroup.CalculatePower (Mono): output does not depend on the core count, only on fuel. */
export function amePower(fuel, cores) {
  if (cores <= 0 || fuel <= 0) return 0;
  return 200000 * Math.log10(fuel * fuel) * Math.pow(1.11111, fuel / 2 - 1);
}

/** AME assemblies: shielding and controllers joined by AdjacentNode (cardinal neighbours). */
export function ameGroups(model) {
  const isAme = p => hasComp(p, 'AmeShield') || hasComp(p, 'AmeController');
  const seen = new Set();
  const groups = [];
  for (const e of model.ents.values()) {
    if (seen.has(e.uid) || !isAme(protoOf(e.proto))) continue;
    const g = { shields: 0, cores: 0, controllers: [] };
    const stack = [e.uid];
    seen.add(e.uid);
    while (stack.length) {
      const cur = model.ents.get(stack.pop());
      const [x, y] = tileOf(cur.x, cur.y);
      const p = protoOf(cur.proto);
      if (hasComp(p, 'AmeController')) g.controllers.push(cur);
      else {
        g.shields++;
        if (isAmeCore(model, x, y)) g.cores++;
      }
      for (const [dx, dy] of [[0, 0], [0, 1], [0, -1], [1, 0], [-1, 0]]) {
        for (const u of model.entsAt(x + dx, y + dy)) {
          if (seen.has(u) || !isAme(protoOf(model.ents.get(u).proto))) continue;
          seen.add(u);
          stack.push(u);
        }
      }
    }
    const ctrl = g.controllers[0];
    const comp = ctrl && (ctrl.comps || []).find(c => c.type === 'AmeController');
    g.injection = comp && comp.injectionAmount !== undefined ? Number(comp.injectionAmount) || 0 : 2;
    g.safeFuel = g.cores * 2;
    g.power = ctrl ? amePower(g.injection, g.cores) : 0;
    g.safePower = ctrl ? amePower(g.safeFuel, g.cores) : 0;
    g.at = tileOf((ctrl || e).x, (ctrl || e).y);
    groups.push(g);
  }
  return groups;
}

// ---------------------------------------------------------------- networks
export function cableNetwork(model, startUid) {
  const start = model.ents.get(startUid);
  const kind = protoOf(start.proto)?.cable;
  if (!kind) return new Set();
  const seen = new Set([startUid]);
  const stack = [startUid];
  while (stack.length) {
    const e = model.ents.get(stack.pop());
    const [x, y] = tileOf(e.x, e.y);
    for (const d of CARDINALS) {
      const [dx, dy] = DIR_VEC[d];
      for (const uid of model.entsAt(x + dx, y + dy)) {
        if (seen.has(uid)) continue;
        if (protoOf(model.ents.get(uid).proto)?.cable === kind) { seen.add(uid); stack.push(uid); }
      }
    }
  }
  return seen;
}

export function pipesAt(model, x, y, layer) {
  const out = [];
  for (const uid of model.entsAt(x, y)) {
    const e = model.ents.get(uid);
    const p = protoOf(e.proto);
    if (p && p.pipe !== undefined && pipeLayerOf(e) === layer) out.push(e);
  }
  return out;
}

export function pipeNetwork(model, startUid) {
  const start = model.ents.get(startUid);
  const layer = pipeLayerOf(start);
  const seen = new Set([startUid]);
  const stack = [startUid];
  while (stack.length) {
    const e = model.ents.get(stack.pop());
    const [x, y] = tileOf(e.x, e.y);
    const dirs = pipeDirsOf(e);
    for (const d of CARDINALS) {
      if (!(dirs & d)) continue;
      const [dx, dy] = DIR_VEC[d];
      for (const o of pipesAt(model, x + dx, y + dy, layer)) {
        if (seen.has(o.uid)) continue;
        if (pipeDirsOf(o) & OPP[d]) { seen.add(o.uid); stack.push(o.uid); }
      }
    }
  }
  return seen;
}

/** Open pipe ends: list of {x, y, d} where a pipe points to nothing. */
export function openPipeEnds(model) {
  const out = [];
  for (const e of model.ents.values()) {
    const p = protoOf(e.proto);
    if (!p || p.pipe === undefined) continue;
    const layer = pipeLayerOf(e);
    const [x, y] = tileOf(e.x, e.y);
    const dirs = pipeDirsOf(e);
    for (const d of CARDINALS) {
      if (!(dirs & d)) continue;
      const [dx, dy] = DIR_VEC[d];
      if (!pipesAt(model, x + dx, y + dy, layer).some(o => pipeDirsOf(o) & OPP[d])) out.push({ x, y, d, uid: e.uid });
    }
  }
  return out;
}

export function disposalsAt(model, x, y) {
  return model.entsAt(x, y).map(u => model.ents.get(u)).filter(e => isDisposal(protoOf(e.proto)));
}
export function disposalNetwork(model, startUid) {
  const seen = new Set([startUid]);
  const stack = [startUid];
  while (stack.length) {
    const e = model.ents.get(stack.pop());
    const [x, y] = tileOf(e.x, e.y);
    // units sit on the trunk of their tile
    for (const u of model.entsAt(x, y)) if (!seen.has(u) && (hasComp(protoOf(model.ents.get(u).proto), 'DisposalUnit') || dispDirsOf(model.ents.get(u)))) { seen.add(u); stack.push(u); }
    const dirs = dispDirsOf(e);
    for (const d of CARDINALS) {
      if (!(dirs & d)) continue;
      const [dx, dy] = DIR_VEC[d];
      for (const o of disposalsAt(model, x + dx, y + dy)) {
        if (!seen.has(o.uid) && (dispDirsOf(o) & OPP[d])) { seen.add(o.uid); stack.push(o.uid); }
      }
    }
  }
  return seen;
}
/** Open disposal ends: {x, y, d, uid} where a tube points to nothing that connects back. */
export function openDisposalEnds(model) {
  const out = [];
  for (const e of model.ents.values()) {
    const dirs = dispDirsOf(e);
    if (!dirs) continue;
    const [x, y] = tileOf(e.x, e.y);
    for (const d of CARDINALS) {
      if (!(dirs & d)) continue;
      const [dx, dy] = DIR_VEC[d];
      if (!disposalsAt(model, x + dx, y + dy).some(o => dispDirsOf(o) & OPP[d])) out.push({ x, y, d, uid: e.uid });
    }
  }
  return out;
}

// ---------------------------------------------------------------- atmos exposure (client port of atmos.exposed_tiles)
const AIR_DIRS = { North: [0, 1], South: [0, -1], East: [1, 0], West: [-1, 0] };
export function exposedTiles(model) {
  const tiles = model.tiles;
  if (!tiles.size) return new Set();
  const full = new Set(), edges = new Map();
  for (const e of model.ents.values()) {
    const p = protoOf(e.proto);
    if (!p || !p.airtight) continue;
    const [x, y] = tileOf(e.x, e.y);
    const k = key(x, y);
    if (p.airtight === 'All') { full.add(k); continue; }
    const steps = rotSteps(e.rot);
    for (const d of p.airtight.split(',')) {
      const v = AIR_DIRS[d.trim()];
      if (!v) continue;
      let [dx, dy] = v;
      for (let i = 0; i < steps; i++) [dx, dy] = [-dy, dx];
      if (!edges.has(k)) edges.set(k, new Set());
      edges.get(k).add(dx + ',' + dy);
    }
  }
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const k of [...tiles.keys(), ...full, ...edges.keys()]) {
    const [x, y] = unkey(k);
    if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  minx--; miny--; maxx++; maxy++;
  const seen = new Set(), stack = [];
  const push = (x, y) => { const k = key(x, y); if (!tiles.has(k) && !full.has(k) && !seen.has(k)) { seen.add(k); stack.push([x, y]); } };
  for (let x = minx; x <= maxx; x++) { push(x, miny); push(x, maxy); }
  for (let y = miny; y <= maxy; y++) { push(minx, y); push(maxx, y); }
  const exposed = new Set();
  while (stack.length) {
    const [x, y] = stack.pop();
    const k0 = key(x, y);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < minx || nx > maxx || ny < miny || ny > maxy) continue;
      const k = key(nx, ny);
      if (seen.has(k) || full.has(k)) continue;
      if (edges.get(k0)?.has(dx + ',' + dy) || edges.get(k)?.has((-dx) + ',' + (-dy))) continue;
      seen.add(k);
      if (tiles.has(k)) exposed.add(k);
      stack.push([nx, ny]);
    }
  }
  return exposed;
}
/** Exposed tiles that look like real leaks: skips lattice/catwalk-style outer tiles and AtmosFix-marked tiles. */
export function leakTiles(model) {
  const out = new Set();
  for (const k of exposedTiles(model)) {
    const t = model.tiles.get(k);
    if (t && /Lattice/.test(t[0])) continue;
    const [x, y] = unkey(k);
    if (model.entsAt(x, y).some(u => /^AtmosFix|^Catwalk/.test(model.ents.get(u).proto))) continue;
    out.add(k);
  }
  return out;
}

// ---------------------------------------------------------------- misc
/** 4-connected line of tiles from a to b (inclusive). */
export function line4(x0, y0, x1, y1) {
  const out = [[x0, y0]];
  let x = x0, y = y0;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (x !== x1 || y !== y1) {
    const e2 = 2 * err;
    let mx = false, my = false;
    if (e2 >= dy) { err += dy; x += sx; mx = true; }
    if (e2 <= dx) { err += dx; y += sy; my = true; }
    if (mx && my) out.push([x, y - sy]);
    out.push([x, y]);
  }
  return out;
}
/** L-shaped path (horizontal first unless vertFirst). */
export function lpath(x0, y0, x1, y1, vertFirst) {
  const out = [];
  let x = x0, y = y0;
  out.push([x, y]);
  const stepX = () => { while (x !== x1) { x += Math.sign(x1 - x); out.push([x, y]); } };
  const stepY = () => { while (y !== y1) { y += Math.sign(y1 - y); out.push([x, y]); } };
  if (vertFirst) { stepY(); stepX(); } else { stepX(); stepY(); }
  return out;
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export function weightedPick(items, rnd) {
  const total = items.reduce((s, i) => s + (i.w > 0 ? i.w : 0), 0);
  if (total <= 0) return null;
  let r = rnd() * total;
  for (const i of items) { if (i.w <= 0) continue; r -= i.w; if (r <= 0) return i; }
  return items[items.length - 1];
}

/** Anchored "structure" (wall, window, machine, table, door…): static body, not pipes/cables/markers/wall-mounted/floor stuff. */
export function isStructure(p) {
  if (!p || !p.static || p.subfloor || p.cable || p.pipe !== undefined || isMarker(p)) return false;
  if ((p.c || []).includes('Item')) return false;
  if (p.dd === 2 || p.dd <= -10) return false;   // WallMountedItems, floor objects/tiles/puddles
  return true;
}
/** Structures that legitimately share a tile with another one (window on grille, firelock in doorway…). */
export const STACKABLE_RE = /Grille|Firelock|Catwalk|Railing|Directional|Shutter|BlastDoor|Windoor|Plastic[Ff]laps|Lattice|Shield/;
export function hasComp(p, c) { return !!(p && p.c && p.c.includes(c)); }

export function isMarker(p) {
  return !!p && (/Marker|SpawnPoint|Spawner|^Spawn/.test(p.id) || p.cat.startsWith('Markers'));
}
export function entLayer(p) {
  if (!p) return 'objects';
  if (p.cable) return 'wires';
  if (p.pipe !== undefined) return 'pipes';
  if (p.disp !== undefined) return 'disposal';
  if (isMarker(p)) return 'markers';
  if (p.dd === -2 || p.dd === -1 || (p.sm && (p.sm.key === 'walls' || p.sm.key === 'windows'))) return 'walls';
  if (p.subfloor) return 'subfloor';
  return 'objects';
}
