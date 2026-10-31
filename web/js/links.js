// Device networks (DeviceList <-> DeviceNetwork.deviceLists) and signal links (DeviceLinkSource.linkedPorts).
import { S } from './state.js';
import { P, ent as protoOf } from './protos.js';
import { key, unkey, tileOf, rotSteps, DIR_VEC, S as DS, N, E, W, hasComp } from './logic.js';

const M = () => S.model;
const comp = (e, type) => (e.comps || []).find(c => c.type === type);

function withComp(e, type, fn) {
  // returns a new comps array where `type` is replaced by fn(copy) (or removed when fn returns null)
  const comps = (e.comps || []).map(c => ({ ...c }));
  let i = comps.findIndex(c => c.type === type);
  const cur = i >= 0 ? comps[i] : { type };
  const next = fn(structuredClone(cur));
  if (next === null) { if (i >= 0) comps.splice(i, 1); }
  else if (i >= 0) comps[i] = next;
  else comps.push(next);
  return comps;
}

// ---------------------------------------------------------------- device lists
export const canHoldList = e => hasComp(protoOf(e.proto), 'DeviceList') || !!comp(e, 'DeviceList');
export const isNetDevice = e => hasComp(protoOf(e.proto), 'DeviceNetwork') || !!comp(e, 'DeviceNetwork');
export const listDevices = e => ((comp(e, 'DeviceList') || {}).devices || []).map(String);
export const memberOf = e => ((comp(e, 'DeviceNetwork') || {}).deviceLists || []).map(String);

/** add (on=true) / remove (on=false) / toggle (on=undefined) a device in a holder's DeviceList. */
export function setListMember(holderUid, devUid, on) {
  const model = M();
  const h = model.ents.get(holderUid), d = model.ents.get(devUid);
  if (!h || !d || holderUid === devUid) return false;
  const has = listDevices(h).includes(devUid);
  if (on === undefined) on = !has;
  if (on === has) return on;
  model.updateEnt(holderUid, { comps: withComp(h, 'DeviceList', c => {
    const list = (c.devices || []).map(String).filter(u => u !== devUid);
    if (on) list.push(devUid);
    c.devices = list;
    return c;
  }) });
  model.updateEnt(devUid, { comps: withComp(d, 'DeviceNetwork', c => {
    const list = (c.deviceLists || []).map(String).filter(u => u !== holderUid);
    if (on) list.push(holderUid);
    if (list.length) c.deviceLists = list; else delete c.deviceLists;
    return Object.keys(c).length > 1 ? c : null;
  }) });
  return on;
}

/** Devices that make sense for a holder: air alarm -> atmos devices + firelocks; fire alarm -> firelocks. */
export function suitsHolder(holder, dev) {
  const hp = protoOf(holder.proto), dp = protoOf(dev.proto);
  if (!dp || !isNetDevice(dev) || dev.uid === holder.uid) return false;
  const firelock = hasComp(dp, 'Firelock') || /Firelock/.test(dev.proto);
  const atmos = hasComp(dp, 'AtmosDevice') || hasComp(dp, 'AirSensor') || /GasVent|Scrubber|AirSensor/.test(dev.proto);
  if (hasComp(hp, 'FireAlarm') || /FireAlarm/.test(holder.proto)) return firelock;
  if (hasComp(hp, 'AirAlarm') || /AirAlarm/.test(holder.proto)) return (atmos && !canHoldList(dev)) || firelock;
  return true;
}

/** Tiles of the room in front of a wall-mounted holder (flood fill bounded by airtight walls). */
export function roomTiles(holder, limit = 2500) {
  const model = M();
  const [hx, hy] = tileOf(holder.x, holder.y);
  const blocked = (x, y) => model.entsAt(x, y).some(u => {
    const p = protoOf(model.ents.get(u).proto);
    return p && p.airtight === 'All';
  });
  // wall-mounted entities face along their rotation: rot 0 = south
  const facing = [DS, E, N, W][rotSteps(holder.rot)];
  const [fx, fy] = DIR_VEC[facing];
  let start = [hx, hy];
  if (blocked(hx, hy) || !model.getTile(hx, hy)) start = [hx + fx, hy + fy];
  const out = new Set();
  const stack = [start];
  while (stack.length && out.size < limit) {
    const [x, y] = stack.pop();
    const k = key(x, y);
    if (out.has(k) || !model.getTile(x, y) || blocked(x, y)) continue;
    out.add(k);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return out;
}

/** Add every suitable device in the holder's room (and its doorways) to the list. Returns count added. */
export function autoLinkRoom(holderUid) {
  const model = M();
  const holder = model.ents.get(holderUid);
  const room = roomTiles(holder);
  const area = new Set(room);
  for (const k of room) {
    const [x, y] = unkey(k);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) area.add(key(x + dx, y + dy));
  }
  let n = 0;
  model.begin('Автосвязь комнаты');
  for (const k of area) {
    const [x, y] = unkey(k);
    for (const uid of model.entsAt(x, y)) {
      const d = model.ents.get(uid);
      if (!suitsHolder(holder, d)) continue;
      // doorway tiles only contribute firelocks
      if (!room.has(k) && !/Firelock/.test(d.proto) && !hasComp(protoOf(d.proto), 'Firelock')) continue;
      if (!listDevices(model.ents.get(holderUid)).includes(uid)) { setListMember(holderUid, uid, true); n++; }
    }
  }
  model.commit();
  return { added: n, room };
}

// ---------------------------------------------------------------- signal links
export const sourcePorts = e => protoOf(e.proto)?.srcPorts || [];
export const sinkPorts = e => protoOf(e.proto)?.sinkPorts || [];
export function linkedPorts(e) {
  const lp = (comp(e, 'DeviceLinkSource') || {}).linkedPorts;
  return lp && typeof lp === 'object' ? lp : {};
}
export function pairsBetween(src, sinkUid) {
  return (linkedPorts(src)[sinkUid] || []).map(p => [String(p[0]), String(p[1])]);
}
export function defaultPairs(src, sink) {
  const sinks = sinkPorts(sink);
  const out = [];
  for (const sp of sourcePorts(src)) {
    for (const d of P.srcPorts.get(sp)?.defaultLinks || []) if (sinks.includes(d)) out.push([sp, d]);
  }
  return out;
}
export function setPairs(srcUid, sinkUid, pairs) {
  const model = M();
  const src = model.ents.get(srcUid);
  model.begin('Связь портов');
  model.updateEnt(srcUid, { comps: withComp(src, 'DeviceLinkSource', c => {
    const lp = { ...(c.linkedPorts || {}) };
    if (pairs.length) lp[sinkUid] = pairs.map(p => [p[0], p[1]]); else delete lp[sinkUid];
    c.linkedPorts = lp;
    if (!Object.keys(lp).length) delete c.linkedPorts;
    return Object.keys(c).length > 1 ? c : null;
  }) });
  model.commit();
}

/** All connections for drawing: {a, b, kind:'list'|'signal', label} */
export function allConnections(onlyUid = null) {
  const model = M();
  const out = [];
  for (const e of model.ents.values()) {
    if (onlyUid && e.uid !== onlyUid) {
      // still include links that point at onlyUid
      if (!listDevices(e).includes(onlyUid) && !linkedPorts(e)[onlyUid]) continue;
    }
    for (const d of listDevices(e)) if (model.ents.has(d)) out.push({ a: e.uid, b: d, kind: 'list' });
    for (const [sink, pairs] of Object.entries(linkedPorts(e))) {
      if (!model.ents.has(sink)) continue;
      out.push({ a: e.uid, b: sink, kind: 'signal', label: (pairs || []).map(p => `${p[0]}→${p[1]}`).join(', ') });
    }
  }
  return out;
}

/** Validation helpers: networked atmos devices / firelocks that belong to no list. */
export function orphanDevices() {
  const model = M();
  const inList = new Set();
  for (const e of model.ents.values()) for (const d of listDevices(e)) inList.add(d);
  const atmos = [], firelocks = [];
  for (const e of model.ents.values()) {
    if (inList.has(e.uid) || !isNetDevice(e)) continue;
    const p = protoOf(e.proto);
    if (/^GasVent(Pump|Scrubber)/.test(e.proto) || hasComp(p, 'AirSensor')) atmos.push(e);
    else if (hasComp(p, 'Firelock') || /Firelock/.test(e.proto)) firelocks.push(e);
  }
  return { atmos, firelocks };
}
