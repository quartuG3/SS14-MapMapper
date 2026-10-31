// Image cache for sprites, tiles and decals served by the backend.
import { P } from './protos.js';

const cache = new Map();   // key -> {img, ox, oy} | null (missing) | Promise (loading)
let onLoad = () => {};
let inflight = 0;
const queue = [];
const MAX_INFLIGHT = 12;

export function setOnLoad(fn) { onLoad = fn; }

function pump() {
  while (inflight < MAX_INFLIGHT && queue.length) {
    const [k, url, resolve] = queue.shift();
    inflight++;
    fetch(url).then(async r => {
      if (r.status !== 200) return null;
      const o = (r.headers.get('X-Origin') || '').split(',').map(Number);
      const blob = await r.blob();
      const img = await createImageBitmap(blob);
      return { img, ox: o.length === 2 && !isNaN(o[0]) ? o[0] : img.width / 2, oy: o.length === 2 && !isNaN(o[1]) ? o[1] : img.height / 2 };
    }).catch(() => null).then(v => {
      cache.set(k, v);
      inflight--;
      resolve(v);
      onLoad();
      pump();
    });
  }
}

function load(k, url) {
  const c = cache.get(k);
  if (c !== undefined) return c instanceof Promise ? undefined : c;
  const p = new Promise(res => queue.push([k, url, res]));
  cache.set(k, p);
  pump();
  return undefined;
}
function loadAsync(k, url) {
  const c = cache.get(k);
  if (c !== undefined) return c instanceof Promise ? c : Promise.resolve(c);
  const p = new Promise(res => queue.push([k, url, res]));
  cache.set(k, p);
  pump();
  return p;
}

const enc = encodeURIComponent;
// changes on every server start, so the browser never shows sprites rendered by older code
const rv = () => P.renderVersion ? '&rv=' + P.renderVersion : '';
export function spriteKey(proto, d, s, c, l) { return `s|${proto}|${d}|${s || ''}|${c || ''}|${l || ''}`; }
function spriteUrl(proto, d, s, c, l) {
  let u = `/api/sprite?p=${enc(proto)}&d=${d}`;
  if (s) u += `&s=${enc(s)}`;
  if (c) u += `&c=${enc(c)}`;
  if (l) u += `&l=${enc(l)}`;
  return u + rv();
}
/** returns {img, ox, oy}, null (no sprite) or undefined (loading). */
export function sprite(proto, d, s, c, l) { return load(spriteKey(proto, d, s, c, l), spriteUrl(proto, d, s, c, l)); }
export function spriteAsync(proto, d, s, c, l) { return loadAsync(spriteKey(proto, d, s, c, l), spriteUrl(proto, d, s, c, l)); }
export function tile(id, v) { return load(`t|${id}|${v}`, `/api/tile?id=${enc(id)}&v=${v}${rv()}`); }
export function tileAsync(id, v) { return loadAsync(`t|${id}|${v}`, `/api/tile?id=${enc(id)}&v=${v}${rv()}`); }
export function decal(id, c) { return load(`d|${id}|${c || ''}`, decalUrl(id, c)); }
export function decalAsync(id, c) { return loadAsync(`d|${id}|${c || ''}`, decalUrl(id, c)); }
export const iconUrl = id => `/api/icon?p=${enc(id)}${rv()}`;
export const tileUrl = (id, v = 0) => `/api/tile?id=${enc(id)}&v=${v}${rv()}`;
export const decalUrl = (id, c) => `/api/decal?id=${enc(id)}${c ? '&c=' + enc(c) : ''}${rv()}`;
