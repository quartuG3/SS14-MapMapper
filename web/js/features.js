// Validator, statistics, vessel prototype generator, find & replace.
import { S } from './state.js';
import { P, ent as protoOf } from './protos.js';
import { key, unkey, tileOf, rotSteps, leakTiles, openPipeEnds, openDisposalEnds, disposalsAt, dispDirsOf, cableNetwork, entLayer, isStructure, STACKABLE_RE, ameGroups } from './logic.js';
import { orphanDevices } from './links.js';

const has = (p, c) => !!(p && p.c && p.c.includes(c));

export function validate(model) {
  const issues = [];
  const add = (sev, msg, at = null) => issues.push({ sev, msg, at });
  const count = { grav: 0, console: 0, thrust: 0, gyro: 0, apc: 0, supply: 0, battery: 0, spawn: 0, dock: 0, vent: 0, airAlarm: 0 };
  const unknown = new Map();
  const seenPos = new Map();
  for (const e of model.ents.values()) {
    const p = protoOf(e.proto);
    const [x, y] = tileOf(e.x, e.y);
    if (!p) { if (!unknown.has(e.proto)) unknown.set(e.proto, [x, y]); continue; }
    if (has(p, 'GravityGenerator') || /GravityGenerator/.test(e.proto)) count.grav++;
    if (has(p, 'ShuttleConsole') || /ComputerShuttle|ComputerTabletopShuttle/.test(e.proto)) count.console++;
    if (p.thruster) p.thruster.type === 'Angular' ? count.gyro++ : count.thrust++;
    if (has(p, 'Gyroscope') || /Gyroscope/.test(e.proto)) count.gyro++;
    if (has(p, 'Apc')) count.apc++;
    if (p.supply) count.supply++;
    if (has(p, 'PowerNetworkBattery')) count.battery++;
    if (has(p, 'SpawnPoint') || /SpawnPoint/.test(e.proto)) count.spawn++;
    if (has(p, 'Docking')) count.dock++;
    if (/GasVentPump/.test(e.proto)) count.vent++;
    if (has(p, 'AirAlarm')) count.airAlarm++;
    // duplicates
    const pk = e.proto + '@' + e.x.toFixed(3) + ',' + e.y.toFixed(3) + '@' + rotSteps(e.rot);
    if (seenPos.has(pk)) add('warn', `Дубликат ${e.proto} в (${x}, ${y})`, [x, y]);
    else seenPos.set(pk, e.uid);
    // entity over space
    if (!model.getTile(x, y) && !has(p, 'Item') && entLayer(p) !== 'markers' && !/Thruster|Lattice|Catwalk|Grille|Radar/.test(e.proto)) {
      add('warn', `${e.proto} стоит в космосе (${x}, ${y})`, [x, y]);
    }
  }
  for (const [id, at] of unknown) add('err', `Неизвестный прототип: ${id}`, at);
  // antimatter engines (assembled from controller + shielding)
  for (const g of ameGroups(model)) {
    const [x, y] = g.at;
    if (!g.controllers.length) add('warn', `Экранирование ДАМа без контроллера (${x}, ${y})`, g.at);
    else if (!g.cores) add('warn', `ДАМ без ядра: нужно экранирование 3×3 вокруг каждого ядра (${x}, ${y})`, g.at);
    else count.supply++;
    if (g.controllers.length > 1) add('warn', `Несколько контроллеров в одном ДАМе (${x}, ${y})`, g.at);
  }
  const need = [
    ['grav', 'Нет генератора гравитации'], ['console', 'Нет консоли управления шаттлом'],
    ['thrust', 'Нет двигателей (Thruster)'], ['gyro', 'Нет гироскопа'], ['apc', 'Нет APC'],
  ];
  for (const [k, msg] of need) if (!count[k]) add('err', msg);
  if (!count.supply && !count.battery) add('err', 'Нет источников энергии (генератор / SMES)');
  if (!count.spawn) add('warn', 'Нет точки спавна (SpawnPointLatejoin и т.п.)');
  if (!count.dock) add('warn', 'Нет стыковочного шлюза (Docking)');
  if (!count.vent) add('warn', 'Нет вентиляции (GasVentPump)');
  if (count.vent && !count.airAlarm) add('warn', 'Есть вентиляция, но нет воздушной тревоги (AirAlarm)');

  // power wiring checks
  const cablesAt = (x, y) => new Set(model.entsAt(x, y).map(u => protoOf(model.ents.get(u).proto)?.cable).filter(Boolean));
  for (const e of model.ents.values()) {
    const p = protoOf(e.proto);
    if (!p) continue;
    const [x, y] = tileOf(e.x, e.y);
    const c = cablesAt(x, y);
    if (has(p, 'Apc')) {
      if (!c.has('MV')) add('err', `APC без MV-кабеля под ним (${x}, ${y})`, [x, y]);
      if (!c.has('LV')) add('warn', `APC без LV-кабеля под ним (${x}, ${y})`, [x, y]);
    }
    if (/Substation/.test(e.proto) && !has(p, 'Item')) {
      if (!c.has('HV')) add('err', `Подстанция без HV (${x}, ${y})`, [x, y]);
      if (!c.has('MV')) add('err', `Подстанция без MV (${x}, ${y})`, [x, y]);
    }
    if (has(p, 'CableTerminal') && !c.has('HV')) add('warn', `Терминал без HV (${x}, ${y})`, [x, y]);
    if (has(p, 'AmeController') && !c.has('HV')) add('warn', `Контроллер ДАМа без HV-кабеля (${x}, ${y})`, [x, y]);
    if (p.supply && !c.has('HV') && !c.has('MV') && !c.has('LV')) add('warn', `Генератор ${e.proto} не подключён к кабелю (${x}, ${y})`, [x, y]);
    if (p.load && !has(p, 'Apc') && p.load > 0 && !/Cable/.test(e.proto)) {
      // power receivers need an APC network nearby; checked coarsely below
    }
  }
  // several structures on one tile
  let multi = 0;
  for (const [k, set] of model.byTile) {
    const structs = [...set].map(u => model.ents.get(u)).filter(e => isStructure(protoOf(e.proto)) && !STACKABLE_RE.test(e.proto));
    if (structs.length < 2) continue;
    multi++;
    if (multi <= 40) add('warn', `Несколько структур в тайле (${k}): ${structs.map(e => e.proto).join(', ')}`, unkey(k));
  }
  if (multi > 40) add('warn', `…и ещё ${multi - 40} тайлов с несколькими структурами`);
  // device networks
  const orph = orphanDevices();
  if (orph.atmos.length) {
    const [x, y] = tileOf(orph.atmos[0].x, orph.atmos[0].y);
    add('warn', `Атмос-устройств без воздушной сигнализации: ${orph.atmos.length} (${[...new Set(orph.atmos.map(e => e.proto))].slice(0, 4).join(', ')}) — инструмент «Связи» (K)`, [x, y]);
  }
  if (orph.firelocks.length) {
    const [x, y] = tileOf(orph.firelocks[0].x, orph.firelocks[0].y);
    add('warn', `Пожарных шлюзов вне сети сигнализаций: ${orph.firelocks.length} — инструмент «Связи» (K)`, [x, y]);
  }
  // cable networks
  const seen = new Set();
  const nets = { HV: 0, MV: 0, LV: 0 };
  for (const e of model.ents.values()) {
    const k = protoOf(e.proto)?.cable;
    if (!k || seen.has(e.uid)) continue;
    const net = cableNetwork(model, e.uid);
    for (const u of net) seen.add(u);
    nets[k] = (nets[k] || 0) + 1;
  }
  add('info', `Сети кабелей: HV ${nets.HV || 0}, MV ${nets.MV || 0}, LV ${nets.LV || 0}`);
  // pipes
  const ends = openPipeEnds(model);
  if (ends.length) add('warn', `Открытых концов труб: ${ends.length}`, [ends[0].x, ends[0].y]);
  // disposals
  const dEnds = openDisposalEnds(model);
  if (dEnds.length) add('warn', `Открытых концов утилизационных труб: ${dEnds.length} — режим «Утилизация» (4) показывает их оранжевыми точками`, [dEnds[0].x, dEnds[0].y]);
  for (const e of model.ents.values()) {
    const p = protoOf(e.proto);
    if (!has(p, 'DisposalUnit')) continue;
    const [x, y] = tileOf(e.x, e.y);
    if (!disposalsAt(model, x, y).some(t => protoOf(t.proto)?.dispKind === 'entry' && dispDirsOf(t))) add('warn', `${e.proto} без DisposalTrunk под ним (${x}, ${y})`, [x, y]);
  }
  for (const e of model.ents.values()) {
    if (protoOf(e.proto)?.dispKind !== 'broken') continue;
    const [x, y] = tileOf(e.x, e.y);
    add('warn', `Сломанная утилизационная труба (${x}, ${y})`, [x, y]);
  }
  // leaks
  const ex = leakTiles(model);
  S.leaks = ex;
  if (ex.size) {
    const first = unkey([...ex][0]);
    add('warn', `Тайлов с выходом в космос (утечка атмосферы): ${ex.size} — включите слой «Утечки»`, first);
  } else add('ok', 'Корпус герметичен');
  if (model.doc.migrated && Object.keys(model.doc.migrated).length) {
    add('info', 'Применены миграции: ' + Object.entries(model.doc.migrated).map(([a, b]) => `${a} → ${b ?? 'удалён'}`).join(', '));
  }
  if (!issues.some(i => i.sev === 'err')) add('ok', 'Критических ошибок нет');
  const order = { err: 0, warn: 1, info: 2, ok: 3 };
  issues.sort((a, b) => order[a.sev] - order[b.sev]);
  return issues;
}

export function stats(model) {
  const s = { tiles: model.tiles.size, ents: model.ents.size, others: model.others.size, decals: model.decals.size };
  const b = model.bounds();
  s.size = b ? `${b.maxx - b.minx + 1}×${b.maxy - b.miny + 1}` : '—';
  let price = 0, load = 0, supply = 0;
  const thrusters = { N: 0, E: 0, S: 0, W: 0 };
  let gyros = 0;
  const byProto = new Map();
  for (const e of model.ents.values()) {
    const p = protoOf(e.proto);
    byProto.set(e.proto, (byProto.get(e.proto) || 0) + 1);
    if (!p) continue;
    price += p.price || 0;
    if (p.load) load += p.load;
    if (p.supply) supply += p.supply;
    if (p.thruster) {
      if (p.thruster.type === 'Angular') gyros++;
      else {
        // nozzle faces south at rot 0, so thrust pushes the ship to the north
        const st = rotSteps(e.rot);
        const pushes = ['N', 'W', 'S', 'E'][st];
        thrusters[pushes]++;
      }
    }
  }
  for (const o of model.others.values()) { const p = protoOf(o.proto); if (p) price += p.price || 0; }
  // AME output depends on the injection set in game; count the safe maximum (2 fuel per core)
  const ame = ameGroups(model).filter(g => g.controllers.length && g.cores);
  for (const g of ame) supply += g.safePower;
  const byTile = new Map();
  for (const t of model.tiles.values()) byTile.set(t[0], (byTile.get(t[0]) || 0) + 1);
  Object.assign(s, { price, load, supply, thrusters, gyros, ame, byProto, byTile });
  return s;
}

// ---------------------------------------------------------------- vessel prototype
export function vesselYaml(f) {
  const lines = [];
  lines.push('- type: vessel');
  lines.push(`  id: ${f.id}`);
  lines.push('  parent: BaseVessel');
  lines.push(`  name: ${q(f.name)}`);
  lines.push(`  description: ${q(f.description)}`);
  lines.push(`  price: ${Math.round(f.price)}`);
  lines.push(`  category: ${f.category}`);
  lines.push(`  group: ${f.group}`);
  lines.push(`  shuttlePath: ${f.shuttlePath}`);
  lines.push('  guidebookPage: null');
  if (f.classes.length) { lines.push('  class:'); for (const c of f.classes) lines.push(`  - ${c}`); }
  if (f.engines.length) { lines.push('  engine:'); for (const c of f.engines) lines.push(`  - ${c}`); }
  if (f.gameMap) {
    lines.push('');
    lines.push('- type: gameMap');
    lines.push(`  id: ${f.id}`);
    lines.push(`  mapName: ${q(f.name)}`);
    lines.push(`  mapPath: ${f.shuttlePath}`);
    lines.push('  minPlayers: 0');
    lines.push('  stations:');
    lines.push(`    ${f.id}:`);
    lines.push(`      stationProto: ${f.stationProto || 'StandardFrontierVessel'}`);
    lines.push('      components:');
    lines.push('        - type: StationNameSetup');
    lines.push(`          mapNameTemplate: ${q(f.name + ' {1}')}`);
    lines.push('          nameGenerator:');
    lines.push('            !type:NanotrasenNameGenerator');
    lines.push("            prefixCreator: '14'");
    lines.push('        - type: StationJobs');
    lines.push('          availableJobs:');
    lines.push('            Contractor: [ 0, 0 ]');
  }
  return lines.join('\n') + '\n';
}
function q(s) {
  s = String(s ?? '');
  if (/^[\w .,()\-]+$/.test(s) && !/^[\-\d]/.test(s)) return s;
  return "'" + s.replace(/'/g, "''") + "'";
}

// ---------------------------------------------------------------- find & replace
export function findReplace(model, { kind, from, to, scope }) {
  const inScope = (x, y) => scope !== 'selection' || S.selection.has(key(x, y));
  let n = 0;
  model.begin(`Замена ${from} → ${to}`);
  if (kind === 'tile') {
    for (const [k, t] of [...model.tiles]) {
      const [x, y] = unkey(k);
      if (t[0] !== from || !inScope(x, y)) continue;
      const tp = P.tiles.get(to);
      model.setTile(x, y, to ? [to, t[1], tp && t[2] < tp.variants ? t[2] : 0, t[3]] : null);
      n++;
    }
  } else if (kind === 'entity') {
    for (const e of [...model.ents.values()]) {
      const [x, y] = tileOf(e.x, e.y);
      if (e.proto !== from || !inScope(x, y)) continue;
      if (to) model.updateEnt(e.uid, { proto: to }); else model.removeEnt(e.uid);
      n++;
    }
  } else if (kind === 'decal') {
    for (const d of [...model.decals.values()]) {
      if (d.id !== from || !inScope(Math.floor(d.x + 0.5), Math.floor(d.y + 0.5))) continue;
      model.removeDecal(d._id);
      if (to) model.addDecal({ ...d, id: to });
      n++;
    }
  }
  model.commit();
  return n;
}
