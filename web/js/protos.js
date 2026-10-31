// Prototype catalogue received from the backend.
export const P = {
  ents: new Map(),
  tiles: new Map(),
  decals: new Map(),
  migrations: {},
  renderVersion: '',
  entCats: [],
  srcPorts: new Map(),
  sinkPorts: new Map(),
};

export async function loadProtos() {
  const r = await fetch('/api/protos');
  if (!r.ok) throw new Error('protos: ' + r.status);
  const j = await r.json();
  for (const e of j.entities) P.ents.set(e.id, e);
  for (const t of j.tiles) P.tiles.set(t.id, t);
  for (const d of j.decals) P.decals.set(d.id, d);
  P.migrations = j.migrations || {};
  P.renderVersion = j.renderVersion || '';
  for (const p of (j.ports && j.ports.source) || []) P.srcPorts.set(p.id, p);
  for (const p of (j.ports && j.ports.sink) || []) P.sinkPorts.set(p.id, p);
  const cats = new Set();
  for (const e of j.entities) cats.add(e.cat);
  P.entCats = [...cats].sort();
}

export const ent = id => P.ents.get(id);
export const tile = id => P.tiles.get(id);
export const decal = id => P.decals.get(id);
export const hasComp = (id, c) => { const e = P.ents.get(id); return !!(e && e.c && e.c.includes(c)); };

export function displayName(kind, id) {
  const m = kind === 'tile' ? P.tiles : kind === 'decal' ? P.decals : P.ents;
  const p = m.get(id);
  if (!p) return id;
  let s = p.name || id;
  if (p.ru && p.ru !== s) s += ' / ' + p.ru;
  if (p.suffix) s += ' [' + p.suffix + ']';
  return s;
}

export function search(kind, q, { cat = '', hidden = false, limit = Infinity } = {}) {
  const m = kind === 'tile' ? P.tiles : kind === 'decal' ? P.decals : P.ents;
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const p of m.values()) {
    if (!hidden && p.hidden) continue;
    if (kind === 'entity' && cat && p.cat !== cat) continue;
    if (kind === 'decal' && cat && !(p.tags || []).includes(cat)) continue;
    if (kind === 'tile' && p.space) continue;
    if (terms.length) {
      const hay = (p.id + ' ' + (p.name || '') + ' ' + (p.ru || '') + ' ' + (p.suffix || '')).toLowerCase();
      if (!terms.every(t => hay.includes(t))) continue;
    }
    out.push(p);
  }
  if (terms.length) {
    const t0 = terms[0];
    const score = p => (p.id.toLowerCase() === t0 ? 0 : p.id.toLowerCase().startsWith(t0) ? 1 : 2);
    out.sort((a, b) => score(a) - score(b) || a.id.length - b.id.length || a.id.localeCompare(b.id));
  } else {
    out.sort((a, b) => a.id.localeCompare(b.id));
  }
  return out.slice(0, limit);
}

// ---------------------------------------------------------------- mirror counterparts
const CHIRAL = [['Left', 'Right'], ['Right', 'Left']];
const AXIS_TOKENS = {
  x: [['NE', 'NW'], ['NW', 'NE'], ['SE', 'SW'], ['SW', 'SE'], ['Ne', 'Nw'], ['Nw', 'Ne'], ['Se', 'Sw'], ['Sw', 'Se'],
      ['East', 'West'], ['West', 'East'], ['E', 'W'], ['W', 'E']],
  y: [['NE', 'SE'], ['SE', 'NE'], ['NW', 'SW'], ['SW', 'NW'], ['Ne', 'Se'], ['Se', 'Ne'], ['Nw', 'Sw'], ['Sw', 'Nw'],
      ['North', 'South'], ['South', 'North'], ['N', 'S'], ['S', 'N']],
};

/** Counterpart id after mirroring along axis ('x' = horizontal flip). Returns {id, chiral}. */
export function mirrorId(kind, id, axis) {
  const m = kind === 'tile' ? P.tiles : kind === 'decal' ? P.decals : P.ents;
  for (const [a, b] of AXIS_TOKENS[axis]) {
    if (id.endsWith(a)) {
      const cand = id.slice(0, id.length - a.length) + b;
      if (m.has(cand)) return { id: cand, chiral: false, dirSwap: true };
    }
  }
  for (const [a, b] of CHIRAL) {
    const i = id.lastIndexOf(a);
    if (i >= 0) {
      const cand = id.slice(0, i) + b + id.slice(i + a.length);
      if (m.has(cand)) return { id: cand, chiral: true };
    }
  }
  if (id.endsWith('Flipped')) {
    const cand = id.slice(0, -7);
    if (m.has(cand)) return { id: cand, chiral: true };
  } else if (m.has(id + 'Flipped')) {
    return { id: id + 'Flipped', chiral: true };
  }
  return { id, chiral: false };
}
