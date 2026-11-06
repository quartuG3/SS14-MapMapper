// Global editor state and a tiny event bus.
export const S = {
  model: null,
  mode: 'normal',                 // normal | wiring | atmos | disposal
  view: { cx: 0, cy: 0, z: 32 },  // world center, pixels per tile
  layers: {
    tiles: true, decals: true, walls: true, objects: true, subfloor: true, pipes: true, wires: true,
    disposal: true, markers: true, grid: true, chunks: false, leaks: false, openEnds: true, placeholders: true, links: false, realSubfloor: false,
  },
  pipeLayers: { Primary: true, Secondary: true, Tertiary: true },
  mirror: { x: false, y: false, ax: 0.5, ay: 0.5 },
  symmetry: { presets: [], active: -1 },  // see symmetry.js
  mirrorDrag: null,               // 'x' | 'y' while an axis is dragged from a ruler
  guides: [],                     // {axis:'x'|'y', v}
  selection: new Set(),
  sel: { tile: 'Plating', entity: 'WallReinforced', decal: null },
  palKind: 'tile',
  rotSteps: 0,
  brush: 1,
  tool: 'tile',
  hoverTile: null,
  hoverWorld: null,
  highlight: null,
  inspected: null,
  markers: [],
  leaks: new Set(),
  clipboard: null,
  pipe: { layer: 'Primary', color: '#0055CCFF' },
  wire: { kind: 'LV' },
  disposal: { junction: 'junction' },   // family for new three-way tubes: junction | router | signal
  decal: { color: '#FFFFFFFF', snap: true, angle: 0, z: 0, cleanable: false },
  tileOpts: { randomVariant: true, rm: 0 },  // rm: rotation of the brush tile for rotmir tiles (R)
  entOpts: { replace: true, free: false, step: 'center', allowDup: false, underlay: true, underlayTile: 'Plating', replaceStructs: false },
  fillOpts: { stopAtWalls: true, mode: 'tile' },
  shapeOpts: { kind: 'rect', filled: false },
  eraseOpts: { tiles: true, ents: true, decals: true, top: false },
  selFilter: { tiles: true, ents: true, decals: true },
  random: { sets: [], active: 0, seed: 1337, fixedSeed: false, density: 25, target: 'brush' },
  recent: { tile: [], entity: [], decal: [] },
  palettes: [],                   // custom palettes from palettes/ (see palettes.js)
  palOpts: { active: '', view: 'grid' }, // file of the active custom palette; view: grid | gallery | list
  savePath: null,
  saveOpts: { toRepo: false },     // false: download the .yml, true: write into the repo
  // mass scanner (radar.js): range 0 = fit, colours of the own grid outline and of the backing
  radar: { range: 0, color: '#00FA9A', bg: '#141414', center: 'console', shield: false, shieldColor: '', blips: true, docks: true, labels: true, azimuth: true, rings: true },
  radarDock: { open: false, x: null, y: null, size: 240, expanded: false },   // pinned scanner mini window
  subfloor: { grates: 'Lattice|Grat|Grid|Catwalk|TechMaint|Mesh', showOnGrates: true },
  // paper editor and names editor (texts.js): own stamps, last colours, list filters
  paper: { custom: [], color: '#cc0000', lastName: '', lastColor: '#bb3232', namesOnlySet: false, namesItems: false },
};

const handlers = {};
export function on(ev, fn) { (handlers[ev] ||= []).push(fn); }
export function emit(ev, ...a) { for (const fn of handlers[ev] || []) fn(...a); }

const PERSIST = ['subfloor', 'layers', 'pipeLayers', 'pipe', 'wire', 'disposal', 'decal', 'tileOpts', 'entOpts', 'fillOpts', 'shapeOpts', 'eraseOpts', 'selFilter', 'recent', 'sel', 'saveOpts', 'palOpts', 'radar', 'radarDock', 'paper'];
export function loadPrefs() {
  try {
    const j = JSON.parse(localStorage.getItem('ss14mapper.prefs') || '{}');
    for (const k of PERSIST) if (j[k]) Object.assign(S[k], j[k]);
    if (j.random) { S.random.sets = j.random.sets || []; S.random.seed = j.random.seed ?? 1337; S.random.density = j.random.density ?? 25; }
    if (j.symmetry) { S.symmetry.presets = j.symmetry.presets || []; S.symmetry.active = Math.min(j.symmetry.active ?? -1, S.symmetry.presets.length - 1); }
  } catch { /* ignore */ }
}
export function savePrefs() {
  try {
    const j = {};
    for (const k of PERSIST) j[k] = S[k];
    j.random = { sets: S.random.sets, seed: S.random.seed, density: S.random.density };
    j.symmetry = S.symmetry;
    localStorage.setItem('ss14mapper.prefs', JSON.stringify(j));
  } catch { /* ignore */ }
}

export function toast(msg, kind = '', ms = 3500) {
  const box = document.getElementById('toast');
  const d = document.createElement('div');
  d.className = kind;
  d.textContent = msg;
  box.appendChild(d);
  setTimeout(() => d.remove(), ms);
  document.getElementById('stMsg').textContent = msg;
}
