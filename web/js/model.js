// Editable document model with spatial index and undo/redo history.
import { key, unkey, tileOf } from './logic.js';

const clone = v => (v === null || v === undefined) ? v : structuredClone(v);

export class Model {
  constructor(doc) {
    this.doc = doc;
    this.path = doc.path || null;
    this.gridUid = String(doc.gridUid);
    this.tiles = new Map();         // "x,y" -> [name, flags, variant, rotmir]
    this.ents = new Map();          // uid -> entity (children of the grid)
    this.byTile = new Map();        // "x,y" -> Set(uid)
    this.others = new Map();        // uid -> raw entity (contained / not parented to the grid)
    this.children = new Map();      // parent uid -> Set(uid) among others
    this.decals = new Map();        // local id -> decal
    this.decalByTile = new Map();
    this._decalSeq = 1;
    for (const [x, y, name, f, v, r] of doc.tiles) this.tiles.set(key(x, y), [name, f, v, r]);
    for (const e of doc.entities) { e.uid = String(e.uid); this._addEnt(e); }
    for (const o of doc.others) { o.uid = String(o.uid); this._addOther(o); }
    for (const d of doc.decals) this._addDecal(d);
    let max = 0;
    for (const k of [this.gridUid, ...this.ents.keys(), ...this.others.keys()]) { const n = parseInt(k, 10); if (n > max) max = n; }
    for (const m of (doc.head?.maps || [])) { const n = parseInt(m, 10); if (n > max) max = n; }
    this._uidSeq = max + 1;
    this.undoStack = [];
    this.redoStack = [];
    this.tx = null;
    this.version = 0;
    this.savedVersion = 0;
    this.listeners = new Set();
  }

  get dirty() { return this.version !== this.savedVersion; }
  on(fn) { this.listeners.add(fn); }
  _changed(kind) { this.version++; for (const fn of this.listeners) fn(kind); }

  newUid() { return String(this._uidSeq++); }

  // ------------------------------------------------------------ raw (no history)
  _addEnt(e) {
    this.ents.set(e.uid, e);
    const k = key(...tileOf(e.x, e.y));
    if (!this.byTile.has(k)) this.byTile.set(k, new Set());
    this.byTile.get(k).add(e.uid);
  }
  _removeEnt(uid) {
    const e = this.ents.get(uid);
    if (!e) return;
    this.ents.delete(uid);
    const k = key(...tileOf(e.x, e.y));
    const s = this.byTile.get(k);
    if (s) { s.delete(uid); if (!s.size) this.byTile.delete(k); }
  }
  _parentOf(o) {
    const tf = (o.components || []).find(c => c.type === 'Transform');
    return tf && tf.parent !== undefined ? String(tf.parent) : null;
  }
  _addOther(o) {
    this.others.set(o.uid, o);
    const p = this._parentOf(o);
    if (p) { if (!this.children.has(p)) this.children.set(p, new Set()); this.children.get(p).add(o.uid); }
  }
  _removeOther(uid) {
    const o = this.others.get(uid);
    if (!o) return;
    this.others.delete(uid);
    const p = this._parentOf(o);
    if (p && this.children.has(p)) { this.children.get(p).delete(uid); }
  }
  _addDecal(d) {
    if (d._id === undefined) d._id = this._decalSeq++;
    else this._decalSeq = Math.max(this._decalSeq, d._id + 1);
    this.decals.set(d._id, d);
    const k = key(Math.floor(d.x + 0.5), Math.floor(d.y + 0.5));
    if (!this.decalByTile.has(k)) this.decalByTile.set(k, new Set());
    this.decalByTile.get(k).add(d._id);
  }
  _removeDecal(id) {
    const d = this.decals.get(id);
    if (!d) return;
    this.decals.delete(id);
    const k = key(Math.floor(d.x + 0.5), Math.floor(d.y + 0.5));
    const s = this.decalByTile.get(k);
    if (s) { s.delete(id); if (!s.size) this.decalByTile.delete(k); }
  }

  // ------------------------------------------------------------ queries
  getTile(x, y) { return this.tiles.get(key(x, y)) || null; }
  entsAt(x, y) { const s = this.byTile.get(key(x, y)); return s ? [...s] : []; }
  decalsAt(x, y) { const s = this.decalByTile.get(key(x, y)); return s ? [...s].map(id => this.decals.get(id)) : []; }
  descendants(uid) {
    const out = [];
    const stack = [String(uid)];
    while (stack.length) {
      const u = stack.pop();
      const ch = this.children.get(u);
      if (!ch) continue;
      for (const c of ch) { out.push(c); stack.push(c); }
    }
    return out;
  }
  bounds() {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    const grow = (x, y) => { if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y; };
    for (const k of this.tiles.keys()) grow(...unkey(k));
    for (const k of this.byTile.keys()) grow(...unkey(k));
    if (minx === Infinity) return null;
    return { minx, miny, maxx, maxy };
  }

  // ------------------------------------------------------------ history
  begin(label) {
    if (this.tx) { this.tx.depth++; return; }
    this.tx = { label, ops: [], depth: 1 };
  }
  commit() {
    if (!this.tx) return;
    if (--this.tx.depth > 0) return;
    const tx = this.tx;
    this.tx = null;
    if (tx.ops.length) {
      this.undoStack.push(tx);
      if (this.undoStack.length > 300) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    this._changed('commit');
  }
  _rec(op) {
    if (!this.tx) { this.begin('edit'); this.tx.ops.push(op); this.commit(); return; }
    this.tx.ops.push(op);
    this._changed('op');
  }
  _apply(op, dir) {
    const [kind, id, before, after] = op;
    const val = dir > 0 ? after : before;
    if (kind === 't') {
      if (val) this.tiles.set(id, clone(val)); else this.tiles.delete(id);
    } else if (kind === 'e') {
      this._removeEnt(id);
      if (val) this._addEnt(clone(val));
    } else if (kind === 'o') {
      this._removeOther(id);
      if (val) this._addOther(clone(val));
    } else if (kind === 'd') {
      this._removeDecal(id);
      if (val) this._addDecal(clone(val));
    }
  }
  undo() {
    const tx = this.undoStack.pop();
    if (!tx) return null;
    for (let i = tx.ops.length - 1; i >= 0; i--) this._apply(tx.ops[i], -1);
    this.redoStack.push(tx);
    this._changed('undo');
    return tx.label;
  }
  redo() {
    const tx = this.redoStack.pop();
    if (!tx) return null;
    for (const op of tx.ops) this._apply(op, 1);
    this.undoStack.push(tx);
    this._changed('redo');
    return tx.label;
  }

  // ------------------------------------------------------------ edits (recorded)
  setTile(x, y, val) {
    const k = key(x, y);
    const before = this.tiles.get(k) || null;
    if (!before && !val) return;
    if (before && val && before[0] === val[0] && before[1] === val[1] && before[2] === val[2] && before[3] === val[3]) return;
    this._rec(['t', k, clone(before), clone(val)]);
    if (val) this.tiles.set(k, clone(val)); else this.tiles.delete(k);
  }
  addEnt(e) {
    e.uid = e.uid ? String(e.uid) : this.newUid();
    if (!e.tf) e.tf = { pos: '', parent: this.gridUid };
    if (!e.comps) e.comps = [];
    this._rec(['e', e.uid, null, clone(e)]);
    this._addEnt(e);
    return e;
  }
  updateEnt(uid, patch) {
    const e = this.ents.get(uid);
    if (!e) return;
    const before = clone(e);
    const after = { ...clone(e), ...patch };
    this._rec(['e', uid, before, clone(after)]);
    this._removeEnt(uid);
    this._addEnt(after);
    return after;
  }
  removeEnt(uid) {
    const e = this.ents.get(uid);
    if (!e) return;
    for (const c of this.descendants(uid)) this.removeOther(c);
    this._rec(['e', uid, clone(e), null]);
    this._removeEnt(uid);
  }
  addOther(o) {
    this._rec(['o', o.uid, null, clone(o)]);
    this._addOther(o);
  }
  removeOther(uid) {
    const o = this.others.get(uid);
    if (!o) return;
    this._rec(['o', uid, clone(o), null]);
    this._removeOther(uid);
  }
  addDecal(d) {
    d = { ...d };
    d._id = this._decalSeq++;
    this._rec(['d', d._id, null, clone(d)]);
    this._addDecal(d);
    return d;
  }
  removeDecal(id) {
    const d = this.decals.get(id);
    if (!d) return;
    this._rec(['d', id, clone(d), null]);
    this._removeDecal(id);
  }

  /** Deep-copy an entity (and its contained entities) with fresh uids, placed at x, y. */
  cloneEnt(src, x, y, rot, proto, contents) {
    const e = clone(src);
    delete e.uid;
    e.x = x; e.y = y; e.rot = rot; e.proto = proto || src.proto;
    if (e.tf) { delete e.tf.rot; e.tf.pos = ''; }
    const added = this.addEnt(e);
    if (contents && contents.length) {
      const remap = new Map([[String(src.uid), added.uid]]);
      for (const o of contents) remap.set(String(o.uid), this.newUid());
      const fix = v => {
        if (Array.isArray(v)) return v.map(fix);
        if (v && typeof v === 'object') { const r = {}; for (const k in v) r[k] = fix(v[k]); return r; }
        if (typeof v === 'string' && remap.has(v)) return remap.get(v);
        return v;
      };
      for (const o of contents) {
        const no = clone(o);
        no.uid = remap.get(String(o.uid));
        no.components = no.components.map(c => (c.type === 'Transform' || c.type === 'ContainerContainer') ? fix(c) : c);
        this.addOther(no);
      }
      added.comps = added.comps.map(c => c.type === 'ContainerContainer' ? fix(c) : c);
      this.ents.set(added.uid, added);
    } else {
      // no contents: drop container references to entities we did not copy
      added.comps = added.comps.map(c => {
        if (c.type !== 'ContainerContainer' || !c.containers) return c;
        const conts = {};
        for (const [n, ct] of Object.entries(c.containers)) {
          if (ct && ct.$v && typeof ct.$v === 'object') {
            const body = { ...ct.$v };
            if (Array.isArray(body.ents)) body.ents = [];
            if (body.ent !== undefined) body.ent = 'null';
            conts[n] = { $tag: ct.$tag, $v: body };
          } else conts[n] = ct;
        }
        return { ...c, containers: conts };
      });
    }
    // keep the recorded "after" state in sync with remapped comps
    const last = this.tx && this.tx.ops.find(op => op[0] === 'e' && op[1] === added.uid);
    if (last) last[3] = clone(added);
    return added;
  }
  contentsOf(uid) { return this.descendants(uid).map(u => clone(this.others.get(u))); }

  // ------------------------------------------------------------ export
  toDoc() {
    const d = { ...this.doc };
    d.tiles = [];
    for (const [k, v] of this.tiles) { const [x, y] = unkey(k); d.tiles.push([x, y, v[0], v[1] | 0, v[2] | 0, v[3] | 0]); }
    d.entities = [...this.ents.values()].map(e => ({ ...e }));
    d.others = [...this.others.values()];
    d.decals = [...this.decals.values()].map(x => { const c = { ...x }; delete c._id; return c; });
    d.path = this.path;
    return d;
  }
}
