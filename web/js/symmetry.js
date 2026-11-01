// Symmetry presets: explicit mirror counterparts for tiles / prototypes / decals.
//
// A preset holds groups. A group has four cells indexed by i = mx + 2 * my:
//   0 = original, 1 = mirrored across the X axis (vertical line), 2 = across Y, 3 = both.
// Mirroring along 'x' maps cell i -> i ^ 1, along 'y' -> i ^ 2, so any cell can be the source.
// cell = { id, rot } | null; rot = null (any rotation, default transform) or
//   rotation steps 0..3 for prototypes/decals, rotmir value 0..7 for tiles.
import { S } from './state.js';

export const SYM_FILE_TYPE = 'ss14mapper-symmetry';
export const RANDOM_FILE_TYPE = 'ss14mapper-random';

export function activePreset() {
  const sy = S.symmetry;
  return sy.active >= 0 ? sy.presets[sy.active] || null : null;
}

export function newGroup(kind = 'tile', id = '') {
  return { name: id || 'Группа', kind, on: true, cells: [id ? { id, rot: null } : null, null, null, null] };
}

/** Counterpart from the active symmetry preset, or null to use the built-in rules. */
export function symOverride(kind, id, rot, axis) {
  const p = activePreset();
  if (!p) return null;
  const flip = axis === 'x' ? 1 : 2;
  let loose = null;
  for (const g of p.groups) {
    if (!g.on || g.kind !== kind) continue;
    for (let i = 0; i < 4; i++) {
      const c = g.cells[i];
      if (!c || c.id !== id) continue;
      const t = g.cells[i ^ flip];
      if (!t || !t.id) continue;
      if (c.rot === null || c.rot === undefined) { loose ||= t; continue; }
      if (c.rot === rot) return { id: t.id, rot: t.rot ?? null };
    }
  }
  return loose && { id: loose.id, rot: loose.rot ?? null };
}

// ---------------------------------------------------------------- (de)serialisation
export function symToFile(p) {
  return { type: SYM_FILE_TYPE, version: 1, name: p.name, groups: p.groups };
}
export function symFromFile(j, fallbackName = 'Пресет') {
  if (!j || (j.type && j.type !== SYM_FILE_TYPE) || !Array.isArray(j.groups)) throw new Error('Это не пресет симметрии');
  const groups = j.groups.map(g => ({
    name: String(g.name || 'Группа'),
    kind: ['tile', 'entity', 'decal'].includes(g.kind) ? g.kind : 'tile',
    on: g.on !== false,
    cells: [0, 1, 2, 3].map(i => {
      const c = g.cells && g.cells[i];
      return c && c.id ? { id: String(c.id), rot: Number.isInteger(c.rot) ? c.rot : null } : null;
    }),
  }));
  return { name: String(j.name || fallbackName), groups };
}
export function randomToFile(name, sets) {
  return { type: RANDOM_FILE_TYPE, version: 1, name, sets };
}
export function randomFromFile(j) {
  if (!j || (j.type && j.type !== RANDOM_FILE_TYPE)) throw new Error('Это не пресет рандома');
  const sets = Array.isArray(j) ? j : j.sets;
  if (!Array.isArray(sets)) throw new Error('В файле нет наборов');
  return sets.filter(s => s && Array.isArray(s.items) && ['tile', 'entity', 'decal'].includes(s.kind)).map(s => ({
    name: String(s.name || 'Набор'), kind: s.kind,
    items: s.items.filter(it => it && it.id).map(it => ({ id: String(it.id), w: Math.max(0, +it.w || 0) })),
    randRot: !!s.randRot, jitter: !!s.jitter, color: s.color || '#FFFFFFFF',
  }));
}
