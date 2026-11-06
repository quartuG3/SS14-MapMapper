// Editor tools. Each tool receives pointer info {wx, wy, tx, ty, ev, button}.
import { S, emit, toast, savePrefs } from './state.js';
import { P, ent as protoOf } from './protos.js';
import * as A from './assets.js';
import * as O from './ops.js';
import { w2s, requestDraw, setToolOverlay } from './view.js';
import * as L from './links.js';
import {
  key, unkey, tileOf, line4, lpath, rotSteps, stepsToRot, normAngle, HALF_PI, cableNetwork, pipeNetwork,
  pipeLayerOf, entLayer, rotateTileVal, disposalNetwork, isDisposal, plainPipeBase,
} from './logic.js';

const M = () => S.model;
let lastPaint = null;   // last painted tile for Shift-lines

export const TOOLS = {};
function tool(def) { TOOLS[def.id] = def; return def; }

function brushCells(tx, ty, size) {
  const o = Math.floor((size - 1) / 2);
  const out = [];
  for (let dx = 0; dx < size; dx++) for (let dy = 0; dy < size; dy++) out.push([tx - o + dx, ty - o + dy]);
  return out;
}
function rectCells(a, b) {
  const out = [];
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([x, y]);
  return out;
}
function rectOutline(a, b) {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  return rectCells(a, b).filter(([x, y]) => x === x0 || x === x1 || y === y0 || y === y1);
}
function drawRectOverlay(c, a, b, color = 'rgba(255,255,255,0.8)', fill = 'rgba(255,255,255,0.08)') {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]) + 1, y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]) + 1;
  const [sx0, sy0] = w2s(x0, y1), [sx1, sy1] = w2s(x1, y0);
  c.fillStyle = fill; c.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
  c.strokeStyle = color; c.setLineDash([5, 3]); c.strokeRect(sx0 + 0.5, sy0 + 0.5, sx1 - sx0 - 1, sy1 - sy0 - 1); c.setLineDash([]);
  c.fillStyle = '#fff'; c.font = '11px sans-serif';
  c.fillText(`${x1 - x0}×${y1 - y0}`, sx1 + 4, sy1 + 12);
}
function ghostSprite(c, proto, x, y, rot, alpha = 0.55) {
  const p = protoOf(proto);
  if (!p) return;
  const img = A.sprite(proto, rotSteps(rot), '', p.pipeColor || null, null);
  if (!img) return;
  const sc = S.view.z / 32;
  const [sx, sy] = w2s(x, y);
  c.globalAlpha = alpha;
  c.drawImage(img.img, sx - img.ox * sc, sy - img.oy * sc, img.img.width * sc, img.img.height * sc);
  c.globalAlpha = 1;
}
function ghostTile(c, name, x, y, alpha = 0.6, rm = 0) {
  const img = A.tile(name, 0);
  const z = S.view.z;
  const [sx, sy] = w2s(x, y + 1);
  c.globalAlpha = alpha;
  if (!img) { c.fillStyle = '#556'; c.fillRect(sx, sy, z, z); }
  else if (rm) {
    c.save();
    c.translate(sx + z / 2, sy + z / 2);
    c.rotate(-(rm % 4) * HALF_PI);
    if (rm >= 4) c.scale(-1, 1);
    c.drawImage(img.img, -z / 2, -z / 2, z, z);
    c.restore();
  } else c.drawImage(img.img, sx, sy, z, z);
  c.globalAlpha = 1;
}

/** R / Shift+R in the tile brush: shaped tiles switch to the rotated prototype, rotmir tiles change rotation. */
export function rotateBrushTile(k) {
  if (!S.sel.tile) return;
  const rm = P.tiles.get(S.sel.tile)?.rotmir ? S.tileOpts.rm || 0 : 0;
  const v = rotateTileVal([S.sel.tile, 0, 0, rm], k);
  if (v[0] === S.sel.tile && (v[3] || 0) === rm) { toast(`У тайла ${S.sel.tile} нет других поворотов`); return; }
  S.tileOpts.rm = v[3] || 0;
  if (v[0] !== S.sel.tile) { S.sel.tile = v[0]; emit('pick', 'tile'); }
  savePrefs();
  emit('tileRot');
  requestDraw();
}

export function drawClipGhost(c, clip, ox, oy) {
  const z = S.view.z, sc = z / 32;
  c.globalAlpha = 0.6;
  for (const [x, y, v] of clip.tiles) {
    const img = A.tile(v[0], v[2] || 0);
    const [sx, sy] = w2s(ox + x, oy + y + 1);
    if (img) c.drawImage(img.img, sx, sy, z, z); else { c.fillStyle = '#445'; c.fillRect(sx, sy, z, z); }
  }
  for (const d of clip.decals) {
    const img = A.decal(d.id, d.color);
    if (!img) continue;
    const [sx, sy] = w2s(ox + d.x, oy + d.y + 1);
    c.drawImage(img.img, sx, sy, z, z);
  }
  const ents = [...clip.ents].sort((a, b) => (protoOf(a.e.proto)?.dd ?? 0) - (protoOf(b.e.proto)?.dd ?? 0));
  for (const { e } of ents) {
    const p = protoOf(e.proto);
    if (!p) continue;
    const img = A.sprite(e.proto, rotSteps(e.rot), '', null, null);
    if (!img) continue;
    const [sx, sy] = w2s(ox + e.x, oy + e.y);
    c.drawImage(img.img, sx - img.ox * sc, sy - img.oy * sc, img.img.width * sc, img.img.height * sc);
  }
  c.globalAlpha = 1;
  const [sx0, sy0] = w2s(ox, oy + clip.h), [sx1, sy1] = w2s(ox + clip.w, oy);
  c.strokeStyle = '#b06cff'; c.setLineDash([5, 3]); c.strokeRect(sx0, sy0, sx1 - sx0, sy1 - sy0); c.setLineDash([]);
}

function remember(kind, id) {
  const r = S.recent[kind];
  const i = r.indexOf(id);
  if (i >= 0) r.splice(i, 1);
  r.unshift(id);
  if (r.length > 18) r.length = 18;
  emit('recent');
}

// ===================================================================== select
let selDrag = null;
tool({
  id: 'select', icon: 'select', hotkey: 'm', title: 'Выделение (M). Shift — добавить, Alt — вычесть, перетаскивание выделения — перемещение',
  down(i) {
    const inside = S.selection.has(key(i.tx, i.ty));
    if (inside && !i.ev.shiftKey && !i.ev.altKey && i.button === 0) {
      selDrag = { mode: 'move', start: [i.tx, i.ty], cur: [i.tx, i.ty], clip: null };
    } else selDrag = { mode: 'rect', start: [i.tx, i.ty], cur: [i.tx, i.ty], add: i.ev.shiftKey, sub: i.ev.altKey };
  },
  move(i) {
    if (!selDrag) return;
    selDrag.cur = [i.tx, i.ty];
    if (selDrag.mode === 'move' && !selDrag.clip && (i.tx !== selDrag.start[0] || i.ty !== selDrag.start[1])) {
      selDrag.clip = O.extract(S.selection);
      if (!selDrag.clip) { selDrag = null; return; }
      M().begin('Перемещение');
      O.deleteSelection(S.selection);
    }
    requestDraw();
  },
  up(i) {
    if (!selDrag) return;
    const d = selDrag;
    selDrag = null;
    if (d.mode === 'move') {
      if (d.clip) {
        const dx = d.cur[0] - d.start[0], dy = d.cur[1] - d.start[1];
        O.pasteClip(d.clip, d.clip.minx + dx, d.clip.miny + dy, false);
        M().commit();
        S.selection = new Set([...S.selection].map(k => { const [x, y] = unkey(k); return key(x + dx, y + dy); }));
      } else if (!i.ev.shiftKey) S.selection = new Set([key(i.tx, i.ty)]);
    } else {
      const cells = rectCells(d.start, d.cur).map(([x, y]) => key(x, y));
      if (!d.add && !d.sub) S.selection = new Set(cells);
      else for (const k of cells) d.sub ? S.selection.delete(k) : S.selection.add(k);
    }
    emit('selection');
    requestDraw();
  },
  overlay(c) {
    if (!selDrag) return;
    if (selDrag.mode === 'rect') drawRectOverlay(c, selDrag.start, selDrag.cur, '#7fc0ff', 'rgba(78,161,255,0.12)');
    else if (selDrag.clip) drawClipGhost(c, selDrag.clip, selDrag.clip.minx + selDrag.cur[0] - selDrag.start[0], selDrag.clip.miny + selDrag.cur[1] - selDrag.start[1]);
  },
});

// ===================================================================== wand
tool({
  id: 'wand', icon: 'wand', hotkey: 'w', title: 'Волшебная палочка (W): связная область одного тайла. Ctrl — по прототипу под курсором. Shift/Alt — добавить/вычесть',
  down(i) {
    let cells;
    if (i.ev.ctrlKey) {
      const top = O.visibleEntsAt(i.tx, i.ty)[0];
      if (!top) return;
      cells = O.flood(i.tx, i.ty, { byProto: top.proto });
    } else cells = O.flood(i.tx, i.ty, { stopAtWalls: S.fillOpts.stopAtWalls });
    if (!i.ev.shiftKey && !i.ev.altKey) S.selection = new Set(cells);
    else for (const k of cells) i.ev.altKey ? S.selection.delete(k) : S.selection.add(k);
    emit('selection');
    requestDraw();
  },
});

// ===================================================================== inspect / move
let inspDrag = null;
function inspectPick(e) { S.inspected = e.uid; emit('inspect'); requestDraw(); }
tool({
  id: 'inspect', icon: 'pointer', hotkey: 'v', options: ['step'], title: 'Инспектор (V): клик — выбрать сущность (если в тайле несколько — появится список для выбора; ПКМ — всегда список), перетаскивание — переместить по шагу привязки (Shift — свободно), стрелки — сдвиг на 1 px (Shift — ¼ тайла, Ctrl — тайл), R — повернуть, Del — удалить',
  down(i) {
    const stack = O.visibleEntsAt(i.tx, i.ty);
    if (i.button === 2) { emit('stackMenu', { ev: i.ev, ents: M().entsAt(i.tx, i.ty).map(u => M().ents.get(u)), onPick: inspectPick }); return; }
    if (!stack.length) { S.inspected = null; emit('inspect'); requestDraw(); return; }
    // keep the current pick if it is in this tile, otherwise take the top-most one
    const e = stack.find(x => x.uid === S.inspected) || stack[0];
    S.inspected = e.uid;
    inspDrag = { uid: e.uid, sx: i.wx, sy: i.wy, ox: e.x, oy: e.y, moved: false, stack: stack.length, ev: i.ev, tx: i.tx, ty: i.ty };
    emit('inspect');
    requestDraw();
  },
  move(i) {
    if (!inspDrag) return;
    const e = M().ents.get(inspDrag.uid);
    if (!e) return;
    let nx = inspDrag.ox + (i.wx - inspDrag.sx), ny = inspDrag.oy + (i.wy - inspDrag.sy);
    [nx, ny] = placePos(nx, ny, i.ev.shiftKey);
    if (nx === e.x && ny === e.y) return;
    if (!inspDrag.moved) { M().begin('Перемещение сущности'); inspDrag.moved = true; }
    M().updateEnt(inspDrag.uid, { x: nx, y: ny });
    emit('inspect');
  },
  up() {
    if (inspDrag && inspDrag.moved) M().commit();
    else if (inspDrag && inspDrag.stack > 1) emit('stackMenu', { ev: inspDrag.ev, ents: O.visibleEntsAt(inspDrag.tx, inspDrag.ty), onPick: inspectPick });
    inspDrag = null;
  },
  onKey(ev) {
    const uid = S.inspected;
    if (!uid || !M().ents.has(uid)) return false;
    if (ev.key === 'r' || ev.key === 'R' || ev.key === 'к' || ev.key === 'К') {
      const e = M().ents.get(uid);
      M().begin('Поворот');
      M().updateEnt(uid, { rot: normAngle((e.rot || 0) + (ev.shiftKey ? -HALF_PI : HALF_PI)) });
      M().commit();
      emit('inspect');
      return true;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (arrows[ev.key]) {
      const e = M().ents.get(uid);
      const st = ev.ctrlKey ? 1 : ev.shiftKey ? 0.25 : 1 / 32;
      M().begin('Сдвиг');
      M().updateEnt(uid, { x: Math.round((e.x + arrows[ev.key][0] * st) * 32) / 32, y: Math.round((e.y + arrows[ev.key][1] * st) * 32) / 32 });
      M().commit();
      emit('inspect');
      return true;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      M().begin('Удаление'); M().removeEnt(uid); M().commit();
      S.inspected = null; emit('inspect');
      return true;
    }
    return false;
  },
});

// ===================================================================== tile brush
let tileDrag = null;
tool({
  id: 'tile', icon: 'tiles', hotkey: 'b', title: 'Кисть тайлов (B): ЛКМ — рисовать, ПКМ — стереть, Shift — линия от прошлой точки, Ctrl+тянуть — прямоугольник. [ ] — размер',
  options: ['brush', 'variant', 'tileRot'],
  down(i) {
    const name = S.sel.tile;
    const erase = i.button === 2;
    if (!name && !erase) { toast('Выберите тайл в палитре'); return; }
    if (i.ev.ctrlKey) { tileDrag = { rect: true, start: [i.tx, i.ty], cur: [i.tx, i.ty], erase }; return; }
    M().begin(erase ? 'Стирание тайлов' : 'Тайлы');
    tileDrag = { erase, last: [i.tx, i.ty] };
    const pts = i.ev.shiftKey && lastPaint ? line4(lastPaint[0], lastPaint[1], i.tx, i.ty) : [[i.tx, i.ty]];
    for (const [x, y] of pts) this.stamp(x, y, erase);
    lastPaint = [i.tx, i.ty];
    if (!erase) remember('tile', name);
  },
  stamp(x, y, erase) {
    for (const [cx, cy] of brushCells(x, y, S.brush)) O.paintTile(cx, cy, erase ? null : O.brushTileValue());
  },
  move(i) {
    if (!tileDrag) return;
    if (tileDrag.rect) { tileDrag.cur = [i.tx, i.ty]; requestDraw(); return; }
    for (const [x, y] of line4(tileDrag.last[0], tileDrag.last[1], i.tx, i.ty).slice(1)) this.stamp(x, y, tileDrag.erase);
    tileDrag.last = [i.tx, i.ty];
    lastPaint = [i.tx, i.ty];
  },
  up() {
    if (!tileDrag) return;
    if (tileDrag.rect) {
      M().begin('Прямоугольник тайлов');
      for (const [x, y] of rectCells(tileDrag.start, tileDrag.cur)) O.paintTile(x, y, tileDrag.erase ? null : O.brushTileValue());
    }
    M().commit();
    tileDrag = null;
  },
  overlay(c) {
    if (tileDrag && tileDrag.rect) drawRectOverlay(c, tileDrag.start, tileDrag.cur);
    else if (S.hoverTile && S.sel.tile && !tileDrag) {
      for (const t of O.tileTargets(...S.hoverTile)) {
        const v = O.xformTile(O.brushTileValue(), t);
        for (const [x, y] of brushCells(t.x, t.y, S.brush)) ghostTile(c, v[0], x, y, 0.45, v[3] || 0);
      }
    }
  },
});

// ===================================================================== entity placement
let entDrag = null;
export function reportPlaceWarnings() {
  if (!O.placeWarnings.length) return;
  const n = O.placeWarnings.length;
  toast(`Несколько структур в тайле: ${O.placeWarnings[0]}${n > 1 ? ` (и ещё ${n - 1})` : ''}. Включите «заменять структуры», если нужна замена.`, 'err', 6000);
  O.placeWarnings.length = 0;
}
function placePos(wx, wy, shift) {
  if (shift || S.entOpts.free) return O.snapPos(wx, wy, 1 / 32);
  return O.snapPos(wx, wy);
}
function placeAt(i, x, y) {
  // while dragging along a line use the tile under the line, keeping the sub-tile offset of the cursor
  const [cx, cy] = placePos(i.wx, i.wy, i.ev.shiftKey);
  const px = cx + (x - i.tx), py = cy + (y - i.ty);
  const comps = specialContext() === 'atmos' ? O.atmosComps(S.sel.entity) : [];
  O.placeEnt({ proto: S.sel.entity, x: px, y: py, rot: stepsToRot(S.rotSteps), comps });
}
tool({
  id: 'entity', icon: 'entity', hotkey: 'e', title: 'Размещение прототипов (E): ЛКМ — поставить/вести, ПКМ — удалить верхний, R — поворот, шаг привязки в панели (Shift — свободно, 1 px), Ctrl+тянуть — прямоугольник, Ctrl+Shift — контур',
  options: ['rot', 'step', 'replace', 'dup', 'underlay', 'devices'],
  down(i) {
    if (i.button === 2) { M().begin('Удаление'); O.removeTopEnt(i.tx, i.ty); entDrag = { erase: true, last: [i.tx, i.ty] }; return; }
    if (!S.sel.entity) { toast('Выберите прототип в палитре'); return; }
    if (i.ev.ctrlKey) { entDrag = { rect: true, outline: i.ev.shiftKey, start: [i.tx, i.ty], cur: [i.tx, i.ty] }; return; }
    M().begin('Размещение ' + S.sel.entity);
    placeAt(i, i.tx, i.ty);
    entDrag = { last: [i.tx, i.ty], free: S.entOpts.free || i.ev.shiftKey || S.entOpts.step !== 'center' };
    remember('entity', S.sel.entity);
  },
  move(i) {
    if (!entDrag) return;
    if (entDrag.rect) { entDrag.cur = [i.tx, i.ty]; requestDraw(); return; }
    if (entDrag.free) return;
    if (i.tx === entDrag.last[0] && i.ty === entDrag.last[1]) return;
    for (const [x, y] of line4(entDrag.last[0], entDrag.last[1], i.tx, i.ty).slice(1)) {
      if (entDrag.erase) O.removeTopEnt(x, y); else placeAt(i, x, y);
    }
    entDrag.last = [i.tx, i.ty];
  },
  up() {
    if (!entDrag) return;
    if (entDrag.rect) {
      M().begin('Прямоугольник ' + S.sel.entity);
      const cells = entDrag.outline ? rectOutline(entDrag.start, entDrag.cur) : rectCells(entDrag.start, entDrag.cur);
      for (const [x, y] of cells) O.placeEnt({ proto: S.sel.entity, x: x + 0.5, y: y + 0.5, rot: stepsToRot(S.rotSteps) });
      remember('entity', S.sel.entity);
    }
    M().commit();
    reportPlaceWarnings();
    entDrag = null;
  },
  overlay(c) {
    if (entDrag && entDrag.rect) { drawRectOverlay(c, entDrag.start, entDrag.cur); return; }
    if (!S.hoverWorld || !S.sel.entity) return;
    const [px, py] = placePos(S.hoverWorld[0], S.hoverWorld[1], S.shiftDown);
    for (const t of O.entTargets(S.sel.entity, stepsToRot(S.rotSteps), px, py)) ghostSprite(c, t.proto, t.x, t.y, t.rot);
  },
});

// ===================================================================== decals
let decDrag = null;
function decalAt(i, x, y) {
  const free = !S.decal.snap || i.ev.shiftKey;
  const dx = free ? Math.round((i.wx - 0.5) * 32) / 32 : x;
  const dy = free ? Math.round((i.wy - 0.5) * 32) / 32 : y;
  O.placeDecal({ id: S.sel.decal, color: S.decal.color, angle: S.decal.angle, z: S.decal.z, cleanable: S.decal.cleanable, x: dx, y: dy });
}
tool({
  id: 'decal', icon: 'decal', hotkey: 'd', title: 'Декали (D): ЛКМ — поставить, ПКМ — удалить с тайла, R — поворот на 90°, Shift — без привязки',
  options: ['decal'],
  down(i) {
    if (i.button === 2) { M().begin('Удаление декалей'); O.removeDecalsAt(i.tx, i.ty); decDrag = { erase: true, last: [i.tx, i.ty] }; return; }
    if (!S.sel.decal) { toast('Выберите декаль в палитре'); return; }
    M().begin('Декали');
    decalAt(i, i.tx, i.ty);
    decDrag = { last: [i.tx, i.ty] };
    remember('decal', S.sel.decal);
  },
  move(i) {
    if (!decDrag) return;
    if (i.tx === decDrag.last[0] && i.ty === decDrag.last[1]) return;
    for (const [x, y] of line4(decDrag.last[0], decDrag.last[1], i.tx, i.ty).slice(1)) {
      if (decDrag.erase) O.removeDecalsAt(x, y); else decalAt(i, x, y);
    }
    decDrag.last = [i.tx, i.ty];
  },
  up() { if (decDrag) M().commit(); decDrag = null; },
  overlay(c) {
    if (!S.hoverTile || !S.sel.decal || decDrag) return;
    const img = A.decal(S.sel.decal, S.decal.color);
    if (!img) return;
    const z = S.view.z;
    const [sx, sy] = w2s(S.hoverTile[0], S.hoverTile[1] + 1);
    c.globalAlpha = 0.6;
    c.save(); c.translate(sx + z / 2, sy + z / 2); c.rotate(-S.decal.angle); c.drawImage(img.img, -z / 2, -z / 2, z, z); c.restore();
    c.globalAlpha = 1;
  },
});

// ===================================================================== fill
tool({
  id: 'fill', icon: 'bucket', hotkey: 'g', title: 'Заливка (G): заливает связную область текущим элементом палитры (тайл / прототип / декаль). Ограничивается стенами (опция)',
  options: ['fill'],
  down(i) {
    const cells = O.flood(i.tx, i.ty, { stopAtWalls: S.fillOpts.stopAtWalls });
    if (!cells.length) return;
    if (cells.length >= 40000) { toast('Слишком большая область — заливка ограничена', 'err'); }
    fillCells(cells, i.button === 2);
  },
});
export function fillCells(cells, erase = false, label = 'Заливка', mirror = false) {
  const kind = S.palKind;
  M().begin(label);
  for (const k of cells) {
    const [x, y] = unkey(k);
    if (kind === 'tile') O.paintTile(x, y, erase ? null : O.brushTileValue(), mirror);
    else if (kind === 'entity' && S.sel.entity) erase ? O.removeEntsAt(x, y, mirror, e => e.proto === S.sel.entity) : O.placeEnt({ proto: S.sel.entity, x: x + 0.5, y: y + 0.5, rot: stepsToRot(S.rotSteps), mirror });
    else if (kind === 'decal' && S.sel.decal) erase ? O.removeDecalsAt(x, y, mirror) : O.placeDecal({ id: S.sel.decal, color: S.decal.color, angle: S.decal.angle, z: S.decal.z, cleanable: S.decal.cleanable, x, y }, mirror);
  }
  M().commit();
}

// ===================================================================== shapes
export const SHAPES = { rect: 'Прямоугольник', ellipse: 'Эллипс', line: 'Линия' };
let shapeDrag = null;
/** Corners of the shape: Shift — square / circle / line at 0°, 45°, 90°; Ctrl — drawn from the center. */
function shapeCorners(d, ev) {
  let [x0, y0] = d.start, [x1, y1] = d.cur;
  let dx = x1 - x0, dy = y1 - y0;
  if (ev.shiftKey) {
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (S.shapeOpts.kind !== 'line') { const m = Math.max(ax, ay); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m; }
    else if (ax > 2 * ay) dy = 0;
    else if (ay > 2 * ax) dx = 0;
    else { const m = Math.max(ax, ay); dx = Math.sign(dx) * m; dy = Math.sign(dy) * m; }
  }
  x1 = x0 + dx; y1 = y0 + dy;
  if (ev.ctrlKey) { x0 -= dx; y0 -= dy; }
  return [[x0, y0], [x1, y1]];
}
/** Tile keys of a shape. Outlines are 4-connected (airtight walls), thickness grows inward. */
export function shapeCells(kind, a, b, filled, width = 1) {
  const out = new Set();
  if (kind === 'line') {
    for (const [lx, ly] of line4(a[0], a[1], b[0], b[1])) for (const [x, y] of brushCells(lx, ly, width)) out.add(key(x, y));
    return out;
  }
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2, rx = (x1 - x0 + 1) / 2, ry = (y1 - y0 + 1) / 2;
  const inside = kind === 'rect'
    ? (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1
    : (x, y) => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;
  const edge = (x, y) => {
    for (let ox = -width; ox <= width; ox++) {
      const r = width - Math.abs(ox);
      for (let oy = -r; oy <= r; oy++) if (!inside(x + ox, y + oy)) return true;
    }
    return false;
  };
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) if (inside(x, y) && (filled || edge(x, y))) out.add(key(x, y));
  return out;
}
function currentShape(d, ev) {
  const [a, b] = shapeCorners(d, ev);
  return { a, b, cells: shapeCells(S.shapeOpts.kind, a, b, S.shapeOpts.filled, S.brush) };
}
tool({
  id: 'shape', icon: 'shapes', hotkey: 'o', options: ['shape', 'brush'],
  title: 'Фигуры (O): прямоугольник, эллипс, линия текущим элементом палитры (тайл / прототип / декаль). ЛКМ тянуть — нарисовать, ПКМ — стереть. Shift — квадрат / круг / линия под 45°, Ctrl — от центра, Esc — отмена. Размер кисти — толщина контура',
  down(i) {
    const erase = i.button === 2;
    const kind = S.palKind;
    if (!erase && !S.sel[kind]) { toast('Выберите элемент в палитре'); return; }
    shapeDrag = { start: [i.tx, i.ty], cur: [i.tx, i.ty], erase, ev: i.ev };
    requestDraw();
  },
  move(i) {
    if (!shapeDrag) return;
    shapeDrag.cur = [i.tx, i.ty];
    shapeDrag.ev = i.ev;
    requestDraw();
  },
  up(i) {
    if (!shapeDrag) return;
    const d = shapeDrag;
    shapeDrag = null;
    const { cells } = currentShape(d, i.ev);
    fillCells(cells, d.erase, (d.erase ? 'Стирание: ' : '') + SHAPES[S.shapeOpts.kind], true);
    if (S.palKind === 'entity') reportPlaceWarnings();
    if (!d.erase) remember(S.palKind, S.sel[S.palKind]);
    requestDraw();
  },
  onKey(ev) {
    if (ev.key === 'Escape' && shapeDrag) { shapeDrag = null; requestDraw(); return true; }
    return false;
  },
  overlay(c) {
    if (!shapeDrag) return;
    const ev = { shiftKey: S.shiftDown, ctrlKey: shapeDrag.ev.ctrlKey };
    const { a, b, cells } = currentShape(shapeDrag, ev);
    const z = S.view.z;
    const targets = new Map();
    for (const k of cells) for (const t of O.tileTargets(...unkey(k))) targets.set(key(t.x, t.y), t);
    const ghosts = !shapeDrag.erase && targets.size <= (S.palKind === 'entity' ? 800 : 3000);
    c.fillStyle = shapeDrag.erase ? 'rgba(255,80,80,0.35)' : 'rgba(255,255,255,0.18)';
    for (const t of targets.values()) {
      if (ghosts && S.palKind === 'tile') { const v = O.xformTile(O.brushTileValue(), t); ghostTile(c, v[0], t.x, t.y, 0.5, v[3] || 0); continue; }
      const [sx, sy] = w2s(t.x, t.y + 1);
      c.fillRect(sx, sy, z, z);
    }
    if (ghosts && S.palKind === 'entity')
      for (const k of cells) { const [x, y] = unkey(k); for (const t of O.entTargets(S.sel.entity, stepsToRot(S.rotSteps), x + 0.5, y + 0.5)) ghostSprite(c, t.proto, t.x, t.y, t.rot, 0.45); }
    const [sx1, sy1] = w2s(Math.max(a[0], b[0]) + 1, Math.min(a[1], b[1]));
    const w = Math.abs(b[0] - a[0]) + 1, h = Math.abs(b[1] - a[1]) + 1;
    const txt = S.shapeOpts.kind === 'line' ? `${Math.max(w, h)} (${cells.size} тайлов)` : `${w}×${h} (${cells.size} тайлов)`;
    c.font = '11px sans-serif';
    c.fillStyle = 'rgba(0,0,0,0.7)'; c.fillRect(sx1 + 2, sy1 + 1, c.measureText(txt).width + 6, 15);
    c.fillStyle = '#fff'; c.fillText(txt, sx1 + 5, sy1 + 12);
  },
});

// ===================================================================== erase
let eraseDrag = null;
function eraseCell(x, y) {
  for (const [cx, cy] of brushCells(x, y, S.brush)) {
    if (S.eraseOpts.ents) S.eraseOpts.top ? O.removeTopEnt(cx, cy) : O.removeEntsAt(cx, cy);
    if (S.eraseOpts.decals) O.removeDecalsAt(cx, cy);
    if (S.eraseOpts.tiles) O.paintTile(cx, cy, null);
  }
}
tool({
  id: 'erase', icon: 'eraser', hotkey: 'x', title: 'Ластик (X): удаляет выбранные слои (тайлы / сущности / декали) кистью',
  options: ['brush', 'erase'],
  down(i) { M().begin('Ластик'); eraseCell(i.tx, i.ty); eraseDrag = [i.tx, i.ty]; },
  move(i) {
    if (!eraseDrag) return;
    for (const [x, y] of line4(eraseDrag[0], eraseDrag[1], i.tx, i.ty).slice(1)) eraseCell(x, y);
    eraseDrag = [i.tx, i.ty];
  },
  up() { if (eraseDrag) M().commit(); eraseDrag = null; },
});

// ===================================================================== pick
tool({
  id: 'pick', icon: 'pipette', hotkey: 'i', title: 'Пипетка (I): ЛКМ — взять верхний прототип (Shift — тайл, Alt — декаль). Также Alt+клик в любом инструменте',
  down(i) { pickAt(i.tx, i.ty, i.ev); },
});
export function pickAt(tx, ty, ev) {
  const t = M().getTile(tx, ty);
  if (ev.altKey && !ev.shiftKey) {
    const d = M().decalsAt(tx, ty)[0];
    if (d) { S.sel.decal = d.id; S.decal.color = d.color || '#FFFFFFFF'; S.decal.angle = d.angle || 0; emit('pick', 'decal'); setTool('decal'); }
    return;
  }
  const top = !ev.shiftKey && O.visibleEntsAt(tx, ty)[0];
  if (top) {
    S.sel.entity = top.proto;
    S.rotSteps = rotSteps(top.rot);
    emit('pick', 'entity');
    setTool('entity');
  } else if (t) {
    S.sel.tile = t[0];
    S.tileOpts.rm = t[3] || 0;
    emit('pick', 'tile');
    setTool('tile');
  }
}

// ===================================================================== pipes
let pipeDrag = null;
tool({
  id: 'pipe', icon: 'pipe', hotkey: 'p', title: 'Трубы (P): тяните ЛКМ — прокладка с автоподбором фитингов; ПКМ — удалить; Shift — L-путь от прошлой точки. Наведение подсвечивает сеть',
  options: ['pipe', 'devices'],
  down(i) {
    if (S.mode !== 'atmos') setMode('atmos', true);
    if (i.button === 2) { M().begin('Удаление труб'); O.erasePipe(i.tx, i.ty, S.pipe.layer); pipeDrag = { erase: true, last: [i.tx, i.ty] }; return; }
    M().begin('Трубы');
    if (i.ev.shiftKey && lastPaint) {
      const path = lpath(lastPaint[0], lastPaint[1], i.tx, i.ty, false);
      for (let k = 1; k < path.length; k++) O.connectPipe(path[k - 1][0], path[k - 1][1], path[k][0], path[k][1], S.pipe.layer, S.pipe.color);
    }
    pipeDrag = { last: [i.tx, i.ty] };
    lastPaint = [i.tx, i.ty];
  },
  move(i) {
    if (!pipeDrag) { hoverNetwork(i, 'pipe'); return; }
    if (i.tx === pipeDrag.last[0] && i.ty === pipeDrag.last[1]) return;
    const path = line4(pipeDrag.last[0], pipeDrag.last[1], i.tx, i.ty);
    for (let k = 1; k < path.length; k++) {
      if (pipeDrag.erase) O.erasePipe(path[k][0], path[k][1], S.pipe.layer);
      else O.connectPipe(path[k - 1][0], path[k - 1][1], path[k][0], path[k][1], S.pipe.layer, S.pipe.color);
    }
    pipeDrag.last = [i.tx, i.ty];
    lastPaint = [i.tx, i.ty];
  },
  up() { if (pipeDrag) M().commit(); pipeDrag = null; },
});

// ===================================================================== disposals
let dispDrag = null;
function reportDispWarnings() {
  if (!O.dispWarnings.size) return;
  toast(`Крестовин у утилизационных труб нет, соединение пропущено: ${[...O.dispWarnings].slice(0, 3).join(', ')}`, 'err', 5000);
  O.dispWarnings.clear();
}
tool({
  id: 'disposal', icon: 'disposal', hotkey: 'u', options: ['disposal', 'devices'],
  title: 'Утилизационные трубы (U): тяните ЛКМ — прокладка с автоподбором (конец — DisposalTrunk, прямая, изгиб, развилка), ПКМ — удалить; Shift — L-путь от прошлой точки. Над развилкой: R / Shift+R — выход, T — тип (развилка / маршрутизатор / сигнальный), над прямой T — сортировщик (Tagger). Наведение подсвечивает сеть',
  down(i) {
    if (S.mode !== 'disposal') setMode('disposal', true);
    if (i.button === 2) { M().begin('Удаление утилизации'); O.eraseDisposal(i.tx, i.ty); dispDrag = { erase: true, last: [i.tx, i.ty] }; return; }
    M().begin('Утилизация');
    if (i.ev.shiftKey && lastPaint) {
      const path = lpath(lastPaint[0], lastPaint[1], i.tx, i.ty, false);
      for (let k = 1; k < path.length; k++) O.connectDisposal(path[k - 1][0], path[k - 1][1], path[k][0], path[k][1]);
    }
    dispDrag = { last: [i.tx, i.ty] };
    lastPaint = [i.tx, i.ty];
  },
  move(i) {
    if (!dispDrag) { hoverNetwork(i, 'disposal'); return; }
    if (i.tx === dispDrag.last[0] && i.ty === dispDrag.last[1]) return;
    const path = line4(dispDrag.last[0], dispDrag.last[1], i.tx, i.ty);
    for (let k = 1; k < path.length; k++) {
      if (dispDrag.erase) O.eraseDisposal(path[k][0], path[k][1]);
      else O.connectDisposal(path[k - 1][0], path[k - 1][1], path[k][0], path[k][1]);
    }
    dispDrag.last = [i.tx, i.ty];
    lastPaint = [i.tx, i.ty];
  },
  up() { if (dispDrag) { M().commit(); reportDispWarnings(); } dispDrag = null; },
  onKey(ev) {
    if (!S.hoverTile || ev.ctrlKey || ev.altKey) return false;
    const k = ev.key.toLowerCase();
    const how = k === 'r' || k === 'к' ? 'exit' : k === 't' || k === 'е' ? 'kind' : null;
    if (!how || !O.disposalAt(...S.hoverTile)) return false;
    M().begin(how === 'exit' ? 'Выход развилки' : 'Тип трубы');
    const e = O.cycleDisposal(...S.hoverTile, how, ev.shiftKey);
    M().commit();
    if (e) toast(`${e.proto}, выход ${['↓ юг', '→ восток', '↑ север', '← запад'][rotSteps(e.rot)]}`);
    else toast(how === 'exit' ? 'У этой трубы нет других вариантов выхода' : 'У этой трубы нет других типов');
    return true;
  },
});

// ===================================================================== wires
let wireDrag = null;
tool({
  id: 'wire', icon: 'zap', hotkey: 'c', title: 'Проводка (C): тяните ЛКМ — кабель выбранного типа, ПКМ — удалить; Shift — L-путь. Наведение подсвечивает сеть',
  options: ['wire', 'devices'],
  down(i) {
    if (S.mode !== 'wiring') setMode('wiring', true);
    const kind = S.wire.kind;
    if (i.button === 2) { M().begin('Удаление кабеля'); O.removeCable(i.tx, i.ty, kind); wireDrag = { erase: true, last: [i.tx, i.ty] }; return; }
    M().begin('Кабель ' + kind);
    const pts = i.ev.shiftKey && lastPaint ? lpath(lastPaint[0], lastPaint[1], i.tx, i.ty, false) : [[i.tx, i.ty]];
    for (const [x, y] of pts) O.addCable(x, y, kind);
    wireDrag = { last: [i.tx, i.ty] };
    lastPaint = [i.tx, i.ty];
  },
  move(i) {
    if (!wireDrag) { hoverNetwork(i, 'wire'); return; }
    if (i.tx === wireDrag.last[0] && i.ty === wireDrag.last[1]) return;
    for (const [x, y] of line4(wireDrag.last[0], wireDrag.last[1], i.tx, i.ty).slice(1)) {
      if (wireDrag.erase) O.removeCable(x, y, S.wire.kind); else O.addCable(x, y, S.wire.kind);
    }
    wireDrag.last = [i.tx, i.ty];
    lastPaint = [i.tx, i.ty];
  },
  up() { if (wireDrag) M().commit(); wireDrag = null; },
});

function hoverNetwork(i, kind) {
  const model = M();
  let found = null;
  for (const uid of model.entsAt(i.tx, i.ty)) {
    const e = model.ents.get(uid);
    const p = protoOf(e.proto);
    if (kind === 'wire' && p?.cable === S.wire.kind) { found = cableNetwork(model, uid); break; }
    if (kind === 'pipe' && p?.pipe !== undefined && pipeLayerOf(e) === S.pipe.layer) { found = pipeNetwork(model, uid); break; }
    if (kind === 'disposal' && (isDisposal(p) || (p?.c || []).includes('DisposalUnit'))) { found = disposalNetwork(model, uid); break; }
  }
  const prev = S.highlight;
  S.highlight = found;
  if (prev !== found) requestDraw();
}

// ===================================================================== random brush
let rndDrag = null;
tool({
  id: 'random', icon: 'dice', hotkey: 'n', title: 'Случайная кисть (N): рисует случайными элементами активного набора (вкладка «Рандом») с плотностью',
  options: ['brush', 'random'],
  down(i) {
    const set = O.activeSet();
    if (!set || !set.items.length) { toast('Создайте набор на вкладке «Рандом»'); emit('tab', 'random'); return; }
    rndDrag = { rnd: O.rng(), last: [i.tx, i.ty] };
    M().begin('Случайная кисть');
    for (const [x, y] of brushCells(i.tx, i.ty, S.brush)) O.applyRandomAt(x, y, set, rndDrag.rnd, S.random.density);
  },
  move(i) {
    if (!rndDrag) return;
    if (i.tx === rndDrag.last[0] && i.ty === rndDrag.last[1]) return;
    const set = O.activeSet();
    for (const [lx, ly] of line4(rndDrag.last[0], rndDrag.last[1], i.tx, i.ty).slice(1))
      for (const [x, y] of brushCells(lx, ly, S.brush)) O.applyRandomAt(x, y, set, rndDrag.rnd, S.random.density);
    rndDrag.last = [i.tx, i.ty];
  },
  up() { if (rndDrag) M().commit(); rndDrag = null; },
});

// ===================================================================== measure
let meas = null;
tool({
  id: 'measure', icon: 'ruler', hotkey: 'l', title: 'Линейка (L): тяните для измерения расстояния и площади. Shift — привязка к центрам тайлов',
  down(i) { meas = { a: [i.wx, i.wy], b: [i.wx, i.wy], ta: [i.tx, i.ty], tb: [i.tx, i.ty], active: true }; },
  move(i) { if (meas && meas.active) { meas.b = [i.wx, i.wy]; meas.tb = [i.tx, i.ty]; requestDraw(); } },
  up() { if (meas) meas.active = false; },
  overlay(c) {
    if (!meas) return;
    const snap = S.shiftDown;
    const a = snap ? [meas.ta[0] + 0.5, meas.ta[1] + 0.5] : meas.a, b = snap ? [meas.tb[0] + 0.5, meas.tb[1] + 0.5] : meas.b;
    drawRectOverlay(c, meas.ta, meas.tb, 'rgba(255,225,77,0.6)', 'rgba(255,225,77,0.06)');
    const [sx0, sy0] = w2s(...a), [sx1, sy1] = w2s(...b);
    c.strokeStyle = '#ffe14d'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(sx0, sy0); c.lineTo(sx1, sy1); c.stroke(); c.lineWidth = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const tw = Math.abs(meas.tb[0] - meas.ta[0]) + 1, th = Math.abs(meas.tb[1] - meas.ta[1]) + 1;
    const txt = `Δx ${dx.toFixed(2)}  Δy ${dy.toFixed(2)}  L ${Math.hypot(dx, dy).toFixed(2)}  | тайлы ${tw}×${th} = ${tw * th}`;
    c.font = '12px sans-serif';
    const w = c.measureText(txt).width + 10;
    c.fillStyle = 'rgba(0,0,0,0.75)'; c.fillRect(sx1 + 10, sy1 + 6, w, 18);
    c.fillStyle = '#ffe14d'; c.fillText(txt, sx1 + 15, sy1 + 19);
  },
});

// ===================================================================== paste (transient)
export const paste = { clip: null, xf: { rot: 0, flipX: false, flipY: false }, prevTool: 'select' };
tool({
  id: 'paste', icon: 'clipboard', title: 'Вставка: ЛКМ — поставить, R — поворот, H/J — отражение, Esc/ПКМ — выход', hidden: true,
  current() { return O.transformClip(paste.clip, paste.xf); },
  anchor(c) { return S.hoverTile ? [S.hoverTile[0] - Math.floor((c.w - 1) / 2), S.hoverTile[1] - Math.floor((c.h - 1) / 2)] : null; },
  down(i) {
    if (i.button === 2) { setTool(paste.prevTool); return; }
    const c = this.current();
    const [ox, oy] = this.anchor(c);
    M().begin('Вставка');
    const covered = O.pasteClip(c, ox, oy, true);
    M().commit();
    S.selection = new Set([...covered]);
    emit('selection');
  },
  onKey(ev) {
    const k = ev.key.toLowerCase();
    if (k === 'r' || k === 'к') { paste.xf.rot = (paste.xf.rot + (ev.shiftKey ? 3 : 1)) % 4; requestDraw(); return true; }
    if (k === 'h' || k === 'р') { paste.xf.flipX = !paste.xf.flipX; requestDraw(); return true; }
    if (k === 'j' || k === 'о') { paste.xf.flipY = !paste.xf.flipY; requestDraw(); return true; }
    if (k === 'escape') { setTool(paste.prevTool); return true; }
    return false;
  },
  overlay(c) {
    if (!paste.clip || !S.hoverTile) return;
    const cl = this.current();
    const [ox, oy] = this.anchor(cl);
    drawClipGhost(c, cl, ox, oy);
  },
});
export function startPaste(clip) {
  if (!clip) return;
  if (S.tool !== 'paste') paste.prevTool = S.tool;
  paste.clip = clip;
  paste.xf = { rot: 0, flipX: false, flipY: false };
  setTool('paste');
}

// ===================================================================== device links
export const link = { holder: null, mode: 'list' };   // mode: 'list' (DeviceList) | 'signal' (ports)
function pickFrom(i, cands, cb) {
  if (cands.length === 1) cb(cands[0]);
  else if (cands.length > 1) emit('stackMenu', { ev: i.ev, ents: cands, onPick: cb });
}
tool({
  id: 'link', icon: 'link', hotkey: 'k', options: ['link'],
  title: 'Связи (K): «Сеть устройств» — клик по воздушной/пожарной сигнализации, затем по устройствам (вентиляции, скрубберы, датчики, пожарные шлюзы) — добавить/убрать. «Сигналы» — клик по источнику (кнопка, рычаг, датчик), затем по приёмнику — выбор портов. ПКМ / Esc — сброс',
  down(i) {
    const model = M();
    if (i.button === 2) { link.holder = null; emit('link'); requestDraw(); return; }
    const ents = model.entsAt(i.tx, i.ty).map(u => model.ents.get(u));
    const holder = link.holder && model.ents.get(link.holder);
    if (holder) {
      if (ents.some(e => e.uid === holder.uid)) { link.holder = null; emit('link'); requestDraw(); return; }
      if (link.mode === 'list') {
        const cands = ents.filter(e => L.isNetDevice(e) && e.uid !== holder.uid);
        if (!cands.length) { toast('Здесь нет устройств с DeviceNetwork'); return; }
        pickFrom(i, cands, d => {
          if (!L.suitsHolder(holder, d)) toast(`${d.proto} обычно не подключают к ${holder.proto}, но связь добавлена`, '', 4000);
          M().begin('Сеть устройств');
          const on = L.setListMember(holder.uid, d.uid);
          M().commit();
          toast(`${d.proto}: ${on ? 'добавлен в' : 'убран из'} ${holder.proto} (${L.listDevices(M().ents.get(holder.uid)).length} устройств)`);
          emit('link'); requestDraw();
        });
      } else {
        const cands = ents.filter(e => L.sinkPorts(e).length && e.uid !== holder.uid);
        if (!cands.length) { toast('Здесь нет приёмников сигнала (DeviceLinkSink)'); return; }
        pickFrom(i, cands, d => emit('portsDialog', { src: holder.uid, sink: d.uid }));
      }
      return;
    }
    const cands = ents.filter(e => link.mode === 'list' ? L.canHoldList(e) : L.sourcePorts(e).length);
    if (!cands.length) {
      toast(link.mode === 'list' ? 'Кликните по сигнализации (AirAlarm / FireAlarm) или другому держателю DeviceList' : 'Кликните по источнику сигнала (кнопка, рычаг, сенсор…)');
      return;
    }
    pickFrom(i, cands, e => { link.holder = e.uid; emit('link'); requestDraw(); });
  },
  onKey(ev) {
    if (ev.key === 'Escape' && link.holder) { link.holder = null; emit('link'); requestDraw(); return true; }
    return false;
  },
  overlay(c) { drawLinks(c, link.holder); },
});
S.linkOverlay = c => drawLinks(c, S.inspected && L.allConnections(S.inspected).length ? S.inspected : null);
export function drawLinks(c, focus) {
  const model = M();
  const conns = L.allConnections(focus || null);
  const z = S.view.z;
  c.lineWidth = 2;
  c.font = '10px sans-serif';
  for (const k of conns) {
    const a = model.ents.get(k.a), b = model.ents.get(k.b);
    if (!a || !b) continue;
    const [ax, ay] = w2s(a.x, a.y), [bx, by] = w2s(b.x, b.y);
    c.strokeStyle = k.kind === 'list' ? 'rgba(93,220,138,0.85)' : 'rgba(255,170,60,0.9)';
    c.setLineDash(k.kind === 'list' ? [] : [6, 3]);
    c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke();
    c.beginPath(); c.arc(bx, by, Math.max(3, z * 0.12), 0, Math.PI * 2); c.stroke();
    if (k.label && z >= 16) { c.fillStyle = '#ffcf80'; c.fillText(k.label, (ax + bx) / 2 + 3, (ay + by) / 2 - 3); }
  }
  c.setLineDash([]);
  if (focus && model.ents.has(focus)) {
    const e = model.ents.get(focus);
    const [sx, sy] = w2s(e.x - 0.5, e.y + 0.5);
    c.strokeStyle = link.mode === 'list' ? '#5ddc8a' : '#ffaa3c';
    c.lineWidth = 3;
    c.strokeRect(sx, sy, z, z);
  }
  c.lineWidth = 1;
}

// ===================================================================== pan
let panDrag = null;
tool({
  id: 'pan', icon: 'hand', hotkey: 'h', title: 'Перемещение вида (H, или пробел / средняя кнопка)',
  down(i) { panDrag = [i.sx, i.sy, S.view.cx, S.view.cy]; },
  move(i) {
    if (!panDrag) return;
    S.view.cx = panDrag[2] - (i.sx - panDrag[0]) / S.view.z;
    S.view.cy = panDrag[3] + (i.sy - panDrag[1]) / S.view.z;
    requestDraw();
  },
  up() { panDrag = null; },
});

// ===================================================================== tool switching / modes
const SPECIAL_CTX = { wire: 'wiring', pipe: 'atmos', disposal: 'disposal' };
let specialTool = null; // wire/pipe/disposal tool the entity tool was reached from
// 'wiring' | 'atmos' | 'disposal' or null: the special mode whose options (pipe colour/layer, wire kind,
// junction type, device bar) stay active, also for the entity tool after leaving a special tool
export function specialContext() {
  if (S.mode !== 'normal') return S.mode;
  if (SPECIAL_CTX[S.tool]) return SPECIAL_CTX[S.tool];
  return S.tool === 'entity' && specialTool ? SPECIAL_CTX[specialTool] : null;
}
export function setTool(id) {
  if (!TOOLS[id]) return;
  if (SPECIAL_CTX[id]) specialTool = id;
  else if (id !== 'entity') specialTool = null;
  S.tool = id;
  S.highlight = null;
  const t = TOOLS[id];
  setToolOverlay(t.overlay ? c => t.overlay(c) : null);
  emit('tool', id);
  requestDraw();
}
/** Plain pipe / tube / cable prototypes are laid by their routing tool (auto-fitted), not placed one by one:
 *  returns 'pipe' | 'disposal' | 'wire' (and switches the cable kind) or null. */
export function routingToolFor(id) {
  const p = P.ents.get(id);
  if (!p) return null;
  if (plainPipeBase(id)) return 'pipe';
  if (['transit', 'bend', 'entry'].includes(p.dispKind)) return 'disposal';
  if (p.cable && ['HV', 'MV', 'LV'].includes(p.cable)) { S.wire.kind = p.cable; return 'wire'; }
  return null;
}
// keepTool: called by the wire/pipe/disposal tools themselves, which must stay active
export function setMode(m, keepTool) {
  S.mode = m;
  if (!keepTool && S.tool !== 'entity') setTool('entity');
  emit('mode', m);
  requestDraw();
}
export const TOOL_ORDER = ['select', 'wand', 'inspect', null, 'tile', 'entity', 'decal', 'fill', 'shape', 'erase', 'pick', null, 'wire', 'pipe', 'disposal', 'link', null, 'random', 'measure', 'pan'];
export { entLayer };
