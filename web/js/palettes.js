// Custom palettes: user lists of tiles / prototypes / decals, one .json per palette in palettes/.
// palette = { file, name, items: [{ kind: 'tile' | 'entity' | 'decal', id }] }; file is the name on disk (null until saved).
import { S, savePrefs } from './state.js';

export const PALETTE_FILE_TYPE = 'ss14mapper-palette';
const KINDS = ['tile', 'entity', 'decal'];

async function req(url, body) {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}

export async function loadPalettes() {
  const list = await req('/api/palettes');
  S.palettes = [];
  for (const f of list) {
    if (f.error) { console.warn('palette', f.file, f.error); continue; }
    try { S.palettes.push({ ...paletteFromFile(f.data, f.file), file: f.file }); } catch (e) { console.warn('palette', f.file, e); }
  }
  if (!activePalette()) S.palOpts.active = S.palettes[0]?.file || '';
}

export function activePalette() {
  return S.palettes.find(p => p.file === S.palOpts.active) || null;
}
export function setActivePalette(p) {
  S.palOpts.active = p ? p.file : '';
  savePrefs();
}

export function paletteToFile(p) {
  return { type: PALETTE_FILE_TYPE, version: 1, name: p.name, items: p.items.map(({ kind, id }) => ({ kind, id })) };
}
export function paletteFromFile(j, fallbackName = 'Палитра') {
  if (!j || (j.type && j.type !== PALETTE_FILE_TYPE) || !Array.isArray(j.items)) throw new Error('Это не палитра');
  const seen = new Set();
  const items = [];
  for (const it of j.items) {
    if (!it || !KINDS.includes(it.kind) || !it.id) continue;
    const k = it.kind + ':' + it.id;
    if (seen.has(k)) continue;
    seen.add(k);
    items.push({ kind: it.kind, id: String(it.id) });
  }
  return { file: null, name: String(j.name || fallbackName), items };
}
/** Palettes from an imported file: a single palette or a bundle {palettes: [...]} made by «export all». */
export function palettesFromImport(j, fallbackName) {
  if (j && Array.isArray(j.palettes)) return j.palettes.map((p, i) => paletteFromFile(p, `${fallbackName} ${i + 1}`));
  return [paletteFromFile(j, fallbackName)];
}
export const bundleToFile = list => ({ type: PALETTE_FILE_TYPE + '-bundle', version: 1, palettes: list.map(paletteToFile) });

/** A palette name not used yet: «Name», «Name (2)»… */
export function uniqueName(name, except = null) {
  const used = new Set(S.palettes.filter(p => p !== except).map(p => p.name.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!used.has(`${name} (${i})`.toLowerCase())) return `${name} (${i})`;
}

/** Write the palette to palettes/<name>.json; renames the old file when the name changed. */
export async function savePalette(p) {
  const r = await req('/api/palette', { name: p.name, old: p.file, data: paletteToFile(p) });
  const wasActive = S.palOpts.active === p.file;
  p.file = r.file;
  if (!S.palettes.includes(p)) S.palettes.push(p);
  if (wasActive || !S.palOpts.active) setActivePalette(p);
  return p;
}
export async function deletePalette(p) {
  if (p.file) await req('/api/palette/delete', { name: p.file });
  S.palettes.splice(S.palettes.indexOf(p), 1);
  if (S.palOpts.active === p.file) setActivePalette(S.palettes[0] || null);
}

export const hasItem = (p, kind, id) => !!p && p.items.some(it => it.kind === kind && it.id === id);
/** Add or remove an item; returns true when it is now in the palette. */
export function toggleItem(p, kind, id) {
  const i = p.items.findIndex(it => it.kind === kind && it.id === id);
  if (i >= 0) { p.items.splice(i, 1); return false; }
  p.items.push({ kind, id });
  return true;
}
/** Add items that are not in the palette yet; returns how many were added. */
export function addItems(p, items) {
  let n = 0;
  for (const it of items) if (!hasItem(p, it.kind, it.id)) { p.items.push({ kind: it.kind, id: it.id }); n++; }
  return n;
}
