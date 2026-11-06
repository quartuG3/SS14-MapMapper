// Sandbox of user pipelines (see pipelines.js and pipelines/README.md).
// Served with CSP "default-src 'none'; script-src blob:": no network, the only importable script is the pipeline's
// own blob module. Everything outside the open grid goes through whitelisted RPC calls to the main thread.
// The grid is a copy: edits are recorded as ops and applied by the main thread in one undo step.
'use strict';

const key = (x, y) => x + ',' + y;
const unkey = k => k.split(',').map(Number);
const tileOf = (x, y) => [Math.floor(x), Math.floor(y)];
const clone = v => (v === null || v === undefined) ? v : structuredClone(v);

// ---------------------------------------------------------------- rpc to the main thread
let rpcSeq = 0;
const pending = new Map();
function rpc(method, ...args) {
  const id = ++rpcSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    postMessage({ cmd: 'rpc', id, method, args });
  });
}

// ---------------------------------------------------------------- prototype catalogue
let CAT = null;
function catalogue(c) {
  const m = arr => new Map(arr.map(p => [p.id, p]));
  return { ents: m(c.ents), tiles: m(c.tiles), decals: m(c.decals), migrations: c.migrations || {} };
}
function protosApi() {
  const pick = kind => kind === 'tile' ? CAT.tiles : kind === 'decal' ? CAT.decals : CAT.ents;
  return {
    /** Summary of an entity prototype (id, name, ru, suffix, cat, c: components, hidden...) or null. */
    get: (id, kind = 'entity') => clone(pick(kind).get(id) || null),
    has: (id, kind = 'entity') => pick(kind).has(id),
    hasComp: (id, comp) => { const p = CAT.ents.get(id); return !!(p && p.c && p.c.includes(comp)); },
    /** All prototype ids of a kind ('entity' | 'tile' | 'decal'). */
    ids: (kind = 'entity') => [...pick(kind).keys()],
    migrations: () => clone(CAT.migrations),
    /** The prototype as written in its file: {id, type, file, data, parents}. type: entity | vessel | tile | decal. */
    raw: (id, type = 'entity') => rpc('protoRaw', type, id),
    /** The entity prototype merged with all parents: {components: {Type: data}, ...}. */
    resolved: id => rpc('protoResolved', id),
    /** Why a prototype should not be mapped: [] or some of 'debug' | 'admin' | 'donotmap' | 'unknown'
     *  (suffix DEBUG / Admeme / Admin / DO NOT MAP / TESTING, id with Debug / Admeme, category DoNotMap). */
    restricted,
  };
}

// ---------------------------------------------------------------- grid
class Grid {
  constructor(doc, { record = false } = {}) {
    this.doc = doc;
    this.record = record;
    this.ops = [];
    this.changes = 0;
    this._tiles = new Map();
    this._ents = new Map();
    this._byTile = new Map();
    this._others = new Map();
    this._children = new Map();
    this._decals = new Map();
    this._decalSeq = 0;
    for (const [x, y, name, f, v, r] of doc.tiles) this._tiles.set(key(x, y), [name, f | 0, v | 0, r | 0]);
    for (const e of doc.entities) { e.uid = String(e.uid); this._addEnt(e); }
    for (const o of doc.others || []) {
      o.uid = String(o.uid);
      this._others.set(o.uid, o);
      const tf = (o.components || []).find(c => c.type === 'Transform');
      const p = tf && tf.parent !== undefined ? String(tf.parent) : null;
      if (p) { if (!this._children.has(p)) this._children.set(p, []); this._children.get(p).push(o.uid); }
    }
    for (const d of doc.decals || []) {
      if (d._id === undefined) d._id = ++this._decalSeq; else this._decalSeq = Math.max(this._decalSeq, d._id);
      this._decals.set(d._id, d);
    }
    let max = parseInt(doc.gridUid, 10) || 0;
    for (const k of [...this._ents.keys(), ...this._others.keys(), ...((doc.head && doc.head.maps) || [])]) max = Math.max(max, parseInt(k, 10) || 0);
    this.uidSeq = Math.max(doc.uidSeq || 0, max + 1);
  }

  /** Path of the map file ("Maps/_NF/Shuttles/x.yml" or "user/x.yml"), null for an unsaved shuttle. */
  get path() { return this.doc.path || null; }
  get gridUid() { return String(this.doc.gridUid); }
  /** Vessel prototypes (Shipyard) whose shuttlePath points at this file. */
  get vessels() { return clone(this.doc.vessels || []); }
  get meta() { return clone(this.doc.meta || {}); }

  _op(op) { this.changes++; if (this.record) this.ops.push(op); }
  _addEnt(e) {
    this._ents.set(e.uid, e);
    const k = key(...tileOf(e.x, e.y));
    if (!this._byTile.has(k)) this._byTile.set(k, new Set());
    this._byTile.get(k).add(e.uid);
  }
  _removeEnt(uid) {
    const e = this._ents.get(uid);
    if (!e) return;
    this._ents.delete(uid);
    const s = this._byTile.get(key(...tileOf(e.x, e.y)));
    if (s) s.delete(uid);
  }
  _view(e) {
    const [tx, ty] = tileOf(e.x, e.y);
    return { uid: e.uid, proto: e.proto, x: e.x, y: e.y, rot: e.rot || 0, tx, ty, comps: clone(e.comps || []) };
  }
  _uid(e) { const uid = String(typeof e === 'object' ? e.uid : e); if (!this._ents.has(uid)) throw new Error('нет сущности ' + uid); return uid; }

  // ------------------------------------------------------------ tiles
  /** {x, y, id, flags, variant, rotmir} or null. */
  tile(x, y) { const t = this._tiles.get(key(x, y)); return t ? { x, y, id: t[0], flags: t[1], variant: t[2], rotmir: t[3] } : null; }
  /** All tiles; filter: tile id, RegExp, or function(tile). */
  tiles(filter) {
    const f = matcher(filter, t => t.id);
    const out = [];
    for (const [k, t] of this._tiles) { const [x, y] = unkey(k); const v = { x, y, id: t[0], flags: t[1], variant: t[2], rotmir: t[3] }; if (f(v)) out.push(v); }
    return out;
  }
  /** Set a tile (id null = space). The variant is kept when the new tile has it, otherwise 0. */
  setTile(x, y, id, { variant, rotmir, flags } = {}) {
    const k = key(x, y);
    const before = this._tiles.get(k) || null;
    let val = null;
    if (id) {
      const tp = CAT.tiles.get(id);
      if (!tp) throw new Error('неизвестный тайл ' + id);
      const v = variant ?? (before && before[2] < (tp.variants || 1) ? before[2] : 0);
      val = [id, flags ?? (before ? before[1] : 0), v, rotmir ?? (before && tp.rotmir ? before[3] : 0)];
    }
    if (!before && !val) return;
    if (before && val && before.every((x, i) => x === val[i])) return;
    if (val) this._tiles.set(k, val); else this._tiles.delete(k);
    this._op(['tile', x, y, val]);
  }

  // ------------------------------------------------------------ entities
  /** Entities on the grid (copies). filter: proto id, RegExp, function(e), or {proto, comp, at: [x, y], where}. */
  entities(filter) {
    let f;
    const obj = filter && typeof filter === 'object' && !(filter instanceof RegExp) && !Array.isArray(filter);
    if (obj) {
      const pf = filter.proto !== undefined ? matcher(filter.proto, e => e.proto) : () => true;
      f = e => pf(e) && (!filter.comp || hasComp(e.proto, filter.comp)) && (!filter.at || (e.tx === filter.at[0] && e.ty === filter.at[1]))
        && (!filter.where || filter.where(e));
    } else f = matcher(filter, e => e.proto);
    const src = obj && filter.at ? [...(this._byTile.get(key(...filter.at)) || [])].map(u => this._ents.get(u)) : this._ents.values();
    const out = [];
    for (const e of src) { const v = this._view(e); if (f(v)) out.push(v); }
    return out;
  }
  entity(uid) { const e = this._ents.get(String(uid)); return e ? this._view(e) : null; }
  entsAt(x, y) { return this.entities({ at: [x, y] }); }
  /** Entities inside containers of e (and their contents), raw: {uid, proto, components}. */
  contents(e) {
    const out = [];
    const stack = [String(typeof e === 'object' ? e.uid : e)];
    while (stack.length) for (const c of this._children.get(stack.pop()) || []) { out.push(clone(this._others.get(c))); stack.push(c); }
    return out;
  }
  /** Every entity inside containers of the grid's entities (any depth), raw copies + holder: {uid, proto, components, parent}. */
  contained(filter) {
    const f = matcher(filter, o => o.proto);
    const out = [];
    const stack = [...this._ents.keys()];
    while (stack.length) {
      const p = stack.pop();
      for (const c of this._children.get(p) || []) {
        const o = this._others.get(c);
        if (!o) continue;
        const v = { ...clone(o), parent: p };
        if (f(v)) out.push(v);
        stack.push(c);
      }
    }
    return out;
  }
  _otherUid(o) { const uid = String(typeof o === 'object' ? o.uid : o); if (!this._others.has(uid)) throw new Error('нет вложенной сущности ' + uid); return uid; }
  /** Change the prototype of a contained entity. */
  replaceContained(o, proto) {
    if (!CAT.ents.has(proto)) throw new Error('неизвестный прототип ' + proto);
    const uid = this._otherUid(o);
    const cur = this._others.get(uid);
    if (cur.proto === proto) return;
    this._others.set(uid, { ...cur, proto });
    this._op(['other~', uid, { proto }]);
  }
  /** Delete a contained entity with its own contents and drop it from the holder's container. */
  removeContained(o) {
    const uid = this._otherUid(o);
    const tf = (this._others.get(uid).components || []).find(c => c.type === 'Transform');
    const holder = tf && tf.parent !== undefined ? String(tf.parent) : null;
    const gone = [uid];
    for (let i = 0; i < gone.length; i++) for (const c of this._children.get(gone[i]) || []) gone.push(c);
    for (const u of gone) this._others.delete(u);
    if (holder && this._children.has(holder)) this._children.set(holder, this._children.get(holder).filter(c => c !== uid));
    this._op(['other-', uid]);
    if (holder) this._dropRef(holder, uid);
  }
  _dropRef(holder, uid) {
    const isEnt = this._ents.has(holder);
    const src = isEnt ? this._ents.get(holder).comps : (this._others.get(holder) || {}).components;
    if (!src) return;
    let changed = false;
    const comps = clone(src).map(c => {
      if (c.type !== 'ContainerContainer' || !c.containers) return c;
      for (const ct of Object.values(c.containers)) {
        const body = ct && ct.$v && typeof ct.$v === 'object' ? ct.$v : ct;
        if (!body || typeof body !== 'object') continue;
        if (Array.isArray(body.ents) && body.ents.map(String).includes(uid)) { body.ents = body.ents.filter(x => String(x) !== uid); changed = true; }
        if (body.ent !== undefined && String(body.ent) === uid) { body.ent = 'null'; changed = true; }
      }
      return c;
    });
    if (!changed) return;
    if (isEnt) this._update(holder, { comps });
    else { this._others.set(holder, { ...this._others.get(holder), components: comps }); this._op(['other~', holder, { components: clone(comps) }]); }
  }
  _update(uid, patch) {
    const e = this._ents.get(uid);
    const after = { ...e, ...clone(patch) };
    this._removeEnt(uid);
    this._addEnt(after);
    this._op(['ent~', uid, clone(patch)]);
    return this._view(after);
  }
  /** Change the prototype of an entity, everything else stays. */
  replace(e, proto) {
    if (!CAT.ents.has(proto)) throw new Error('неизвестный прототип ' + proto);
    const uid = this._uid(e);
    if (this._ents.get(uid).proto === proto) return this.entity(uid);
    return this._update(uid, { proto });
  }
  /** Delete an entity together with its contents. */
  remove(e) {
    const uid = this._uid(e);
    const gone = [uid];
    for (let i = 0; i < gone.length; i++) for (const c of this._children.get(gone[i]) || []) gone.push(c);
    for (const u of gone.slice(1)) this._others.delete(u);
    this._removeEnt(uid);
    this._op(['ent-', uid]);
  }
  /** Spawn a prototype in the centre of tile x, y (or at exact world coordinates with {exact: true}). rot in radians. */
  place(proto, x, y, { rot = 0, exact = false, comps = [] } = {}) {
    if (!CAT.ents.has(proto)) throw new Error('неизвестный прототип ' + proto);
    const e = { uid: String(this.uidSeq++), proto, x: exact ? x : x + 0.5, y: exact ? y : y + 0.5, rot, comps: clone(comps),
      tf: { pos: '', parent: this.gridUid } };
    this._addEnt(e);
    this._op(['ent+', clone(e)]);
    return this._view(e);
  }
  move(e, x, y, { exact = false } = {}) { return this._update(this._uid(e), { x: exact ? x : x + 0.5, y: exact ? y : y + 0.5 }); }
  rotate(e, rot) { return this._update(this._uid(e), { rot }); }
  /** Component data saved in the map for this entity (not the prototype defaults), or null. */
  comp(e, type) { const c = (this._ents.get(this._uid(e)).comps || []).find(c => c.type === type); return c ? clone(c) : null; }
  /** Write a component of the entity: data replaces the saved fields of that component. */
  setComp(e, type, data) {
    const uid = this._uid(e);
    const comps = clone(this._ents.get(uid).comps || []);
    const i = comps.findIndex(c => c.type === type);
    const c = { type, ...data };
    if (i >= 0) comps[i] = c; else comps.push(c);
    return this._update(uid, { comps });
  }
  removeComp(e, type) {
    const uid = this._uid(e);
    const comps = (this._ents.get(uid).comps || []).filter(c => c.type !== type);
    return this._update(uid, { comps: clone(comps) });
  }

  // ------------------------------------------------------------ decals
  /** Decals {_id, id, x, y, color, angle, z, cleanable}; filter as for tiles (by decal prototype id). */
  decals(filter) { const f = matcher(filter, d => d.id); return [...this._decals.values()].filter(d => f(d)).map(clone); }
  removeDecal(d) {
    const id = typeof d === 'object' ? d._id : d;
    if (!this._decals.delete(id)) return;
    this._op(['decal-', id]);
  }
  addDecal({ id, x, y, color = '#FFFFFFFF', angle = 0, z = 0, cleanable = false }) {
    if (!CAT.decals.has(id)) throw new Error('неизвестная декаль ' + id);
    const d = { _id: 'n' + (++this._decalSeq), id, x, y, color, angle, z, cleanable };
    this._decals.set(d._id, d);
    this._op(['decal+', clone(d)]);
    return clone(d);
  }

  // ------------------------------------------------------------ whole grid
  bounds() {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const k of this._tiles.keys()) { const [x, y] = unkey(k); minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); }
    return minx === Infinity ? null : { minx, miny, maxx, maxy };
  }
  /** Prototype ids used on the grid with counts: Map(id -> n). */
  protoCounts() {
    const m = new Map();
    for (const e of this._ents.values()) m.set(e.proto, (m.get(e.proto) || 0) + 1);
    for (const o of this._others.values()) m.set(o.proto, (m.get(o.proto) || 0) + 1);
    return m;
  }
  toDoc() {
    const d = { ...this.doc };
    d.tiles = [...this._tiles].map(([k, v]) => [...unkey(k), ...v]);
    d.entities = [...this._ents.values()];
    d.others = [...this._others.values()];
    d.decals = [...this._decals.values()].map(x => { const c = { ...x }; delete c._id; return c; });
    delete d.uidSeq;
    return d;
  }
  /** The map file text of the grid in its current state (as "Save" would write it). */
  yaml({ regenAtmos = false } = {}) { return rpc('mapYaml', this.toDoc(), regenAtmos); }
}

function restricted(id) {
  const p = CAT.ents.get(id);
  if (!p) return ['unknown'];
  const out = [];
  const sfx = p.suffix || '';
  if (/\bdebug\b|\btesting\b/i.test(sfx) || /Debug/.test(id)) out.push('debug');
  if (/\badmeme\b|\badmin\b|\badminfu\b/i.test(sfx) || /Admeme/.test(id)) out.push('admin');
  if (p.donotmap || /do not map|donotmap/i.test(sfx)) out.push('donotmap');
  return out;
}
function hasComp(id, comp) { const p = CAT.ents.get(id); return !!(p && p.c && p.c.includes(comp)); }
function matcher(filter, field) {
  if (filter === undefined || filter === null || filter === '') return () => true;
  if (typeof filter === 'function') return filter;
  if (filter instanceof RegExp) return v => filter.test(field(v));
  if (Array.isArray(filter)) { const s = new Set(filter); return v => s.has(field(v)); }
  return v => field(v) === filter;
}

// ---------------------------------------------------------------- run
const files = new Map();
function makeCtx(msg, grid) {
  const sel = new Set(msg.selection || []);
  return {
    params: msg.params || {},
    grid,
    protos: protosApi(),
    /** Selected tiles of the editor as [[x, y]]; empty when nothing is selected. */
    selection: [...sel].map(unkey),
    inSelection: (x, y) => sel.has(key(x, y)),
    log: (...a) => postMessage({ cmd: 'log', text: a.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' ') }),
    /** A line of the result list. sev: err | warn | info | ok; at: [x, y] makes it clickable and marks the tile. */
    report: (sev, msg, at = null, path = null) => postMessage({ cmd: 'report', sev, msg: String(msg), at, path }),
    progress: (v, text = '') => postMessage({ cmd: 'progress', v, text }),
    /** Add a file to the result; several files are downloaded as one zip. data: string or Uint8Array. */
    emit: (path, data) => { files.set(String(path).replace(/\\/g, '/').replace(/^\/+/, ''), data); },
    yaml: {
      dump: obj => rpc('yamlDump', obj),
      load: text => rpc('yamlLoad', text),
    },
    /** Locale of the build: raw Fluent values {key or key.attr: value} of the keys and their attributes.
     *  lang: the locale of conf.toml or en-US (others are not loaded). toFtl turns such an object back into .ftl text. */
    locale: {
      raw: (keys, lang = 'en-US') => rpc('locRaw', [].concat(keys), lang),
      toFtl,
    },
    /** Text files of the build under Resources/ (.yml .ftl .txt .json .toml). */
    res: { text: path => rpc('resText', path) },
    maps: {
      /** Map files of the build and of the user folder: [{path, cat, format, size}]. filter: RegExp / function on path. */
      list: async filter => (await rpc('mapList')).filter(m => matcher(filter, x => x.path)(m)),
      /** Load a map file into a separate Grid (read-only copy; edits there go only to yaml()/emit, never to the editor). */
      open: async (path, grid) => new Grid(await rpc('mapLoad', path, grid || null)),
    },
  };
}

function toFtl(entries) {
  const val = (v, ind) => v.includes('\n') ? '\n' + v.split('\n').map(l => l ? ind + l : '').join('\n') : ' ' + v;
  const out = [];
  for (const k of Object.keys(entries).filter(k => !k.includes('.')).sort()) {
    out.push(k + ' =' + val(entries[k], '    '));
    for (const a of Object.keys(entries).filter(a => a.startsWith(k + '.')).sort()) out.push('    .' + a.slice(k.length + 1) + ' =' + val(entries[a], '        '));
  }
  return out.join('\n') + (out.length ? '\n' : '');
}

async function load(text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  try { return await import(url); } finally { URL.revokeObjectURL(url); }
}
const plainMeta = m => JSON.parse(JSON.stringify(m || {}));

onmessage = async ({ data: msg }) => {
  if (msg.cmd === 'rpc') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result);
    return;
  }
  if (msg.cmd === 'describe') {
    const results = [];
    for (const s of msg.sources) {
      try {
        const mod = await load(s.text);
        if (typeof mod.default !== 'function') throw new Error('нет export default function run(ctx)');
        results.push({ key: s.key, meta: plainMeta(mod.meta) });
      } catch (e) { results.push({ key: s.key, error: String(e && e.message || e) }); }
    }
    postMessage({ cmd: 'described', results });
    return;
  }
  if (msg.cmd === 'run') {
    CAT = catalogue(msg.catalogue);
    const grid = msg.doc ? new Grid(msg.doc, { record: true }) : null;
    try {
      const mod = await load(msg.text);
      const result = await mod.default(makeCtx(msg, grid));
      postMessage({ cmd: 'done', ops: grid ? grid.ops : [], uidSeq: grid ? grid.uidSeq : 0, files: [...files], result: result === undefined ? null : plainMeta(result) });
    } catch (e) {
      postMessage({ cmd: 'done', error: String(e && e.stack || e), ops: [], files: [] });
    }
  }
};
