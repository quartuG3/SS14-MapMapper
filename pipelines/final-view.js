// FinalView: подготовка шаттла к релизу для DeadSpace (QMonolith-DS). Заменяет DEBUG / админские / DO NOT MAP
// прототипы (на гриде и в контейнерах) по таблице или правилом «убрать Debug из id», остальные удаляет; проверяет
// и по желанию открывает заблокированные шлюзы; мелкие фиксы карты. Всё применяется одним шагом (Ctrl+Z).
export const meta = {
  name: 'FinalView: чистовая подготовка (DeadSpace)',
  description: 'Чистка перед сдачей шаттла:\n'
    + '• DEBUG / Admeme / Admin / DO NOT MAP прототипы → замена по таблице или по правилу «без Debug в id», иначе удаление;\n'
    + '• шлюзы с доступом (*Locked) и заболтированные двери — отчёт, по желанию замена на открытый вариант и снятие болтов;\n'
    + '• мелочи: двери, сохранённые в состоянии открытия, точные дубликаты, неизвестные прототипы, предметы в космосе.',
  params: {
    fixDebug: { type: 'bool', label: 'DEBUG-прототипы', default: true },
    fixAdmin: { type: 'bool', label: 'Admeme / Admin', default: true },
    fixDnm: { type: 'bool', label: 'DO NOT MAP', default: true },
    contained: { type: 'bool', label: 'И в контейнерах', default: true },
    table: {
      type: 'text', label: 'Таблица замен («Что -> НаЧто», пустая правая часть — удалить)', rows: 10,
      default: [
        '# Питание',
        'DebugAPC -> APCBasic',
        'DebugSMES -> SMESBasic',
        'DebugSubstation -> SubstationBasic',
        'DebugGenerator -> GeneratorBasic15kW',
        'DebugBatteryStorage -> SMESBasic',
        'DebugBatteryDischarger ->',
        'DebugConsumer ->',
        'DebugPowerReceiver ->',
        '# Двигатели и прочее (DebugThruster*, DebugGyroscope*, *Debug — правилом ниже)',
        'ThrusterDebugStrength -> Thruster',
        'GyroscopeDebugStrength -> Gyroscope',
        'WallDebug -> WallSolid',
        'DebugHardBomb ->',
        'ResearchDiskDebug ->',
        'PinpointerUniversalDebug ->',
      ].join('\n'),
    },
    autoStrip: { type: 'bool', label: 'Правило «убрать Debug из id»', default: true,
      help: 'DebugThrusterNfsd → ThrusterNfsd, WallPlastitaniumDebug → WallPlastitanium — если такой прототип есть и он не запрещён.' },
    deleteUnmatched: { type: 'bool', label: 'Удалять, если замены нет', default: true, help: 'Иначе только отчёт.' },
    keep: { type: 'list', label: 'Не трогать (id или /RegExp/)', placeholder: 'ShuttleGunDuster\n/^ShuttleGun/' },
    locked: { type: 'bool', label: 'Проверка заблокированных шлюзов', default: true },
    unlock: { type: 'bool', label: 'Заменять *Locked на открытый вариант и снимать болты', default: false },
    doors: { type: 'bool', label: 'Двери в состоянии Opening/Open/Closing → закрыты', default: true },
    duplicates: { type: 'bool', label: 'Удалять точные дубликаты', default: true },
    unknown: { type: 'bool', label: 'Удалять неизвестные прототипы', default: true },
    spaceItems: { type: 'bool', label: 'Удалять предметы над космосом', default: false },
  },
};

const REASONS = { debug: 'DEBUG', admin: 'админский', donotmap: 'DO NOT MAP', unknown: 'неизвестный' };
const truthy = v => String(v).toLowerCase() === 'true';

export default function run(ctx) {
  const { grid, protos, params } = ctx;
  const stat = { replaced: 0, removed: 0, unlocked: 0, unbolted: 0, doors: 0, dups: 0 };

  // ------------------------------------------------ restricted prototypes
  const table = new Map();
  for (const raw of (params.table || '').split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [from, to = ''] = line.split(/\s*->\s*/).map(s => s.trim());
    if (to && (!protos.has(to) || protos.restricted(to).length)) { ctx.report('err', `Таблица: ${to} неизвестен или сам запрещён («${line}»)`); continue; }
    table.set(from, to);
  }
  const keep = (params.keep || []).map(s => {
    const m = /^\/(.*)\/(\w*)$/.exec(s);
    if (m) { const rx = new RegExp(m[1], m[2]); return id => rx.test(id); }
    return id => id === s;
  });
  const wanted = why => why.some(r => (r === 'debug' && params.fixDebug) || (r === 'admin' && params.fixAdmin)
    || (r === 'donotmap' && params.fixDnm) || (r === 'unknown' && params.unknown));
  const cache = new Map();
  /** undefined: leave as is; '' : delete; id: replace. */
  const decide = id => {
    if (cache.has(id)) return cache.get(id);
    let res;
    const why = protos.restricted(id);
    if (!why.length || !wanted(why) || keep.some(k => k(id))) res = undefined;
    else if (table.has(id)) res = table.get(id);
    else if (why.includes('unknown')) res = '';
    else {
      const cand = params.autoStrip ? id.replace(/DebugStrength|Debug/, '') : '';
      res = cand && cand !== id && protos.has(cand) && !protos.restricted(cand).length ? cand : (params.deleteUnmatched ? '' : null);
    }
    cache.set(id, res);
    return res;
  };
  const what = id => protos.restricted(id).map(r => REASONS[r]).join(', ');
  for (const e of grid.entities()) {
    const to = decide(e.proto);
    if (to === undefined) continue;
    const at = [e.tx, e.ty];
    if (to === null) ctx.report('err', `${e.proto} (${what(e.proto)}): нет замены, оставлен`, at);
    else if (to) { grid.replace(e, to); stat.replaced++; ctx.report('ok', `${e.proto} → ${to}`, at); }
    else { grid.remove(e); stat.removed++; ctx.report('warn', `${e.proto} (${what(e.proto)}) удалён`, at); }
  }
  if (params.contained) {
    for (const o of grid.contained()) {
      const to = decide(o.proto);
      if (to === undefined) continue;
      const h = grid.entity(o.parent);
      const at = h ? [h.tx, h.ty] : null;
      const where = h ? ` в ${h.proto}` : ' в контейнере';
      if (to === null) ctx.report('err', `${o.proto}${where}: нет замены, оставлен`, at);
      else if (to) { grid.replaceContained(o, to); stat.replaced++; ctx.report('ok', `${o.proto}${where} → ${to}`, at); }
      else if (grid.contained(x => x.uid === o.uid).length) { grid.removeContained(o); stat.removed++; ctx.report('warn', `${o.proto}${where} удалён`, at); }
    }
  }

  // ------------------------------------------------ duplicates, items in space
  if (params.duplicates) {
    const seen = new Set();
    for (const e of grid.entities()) {
      const k = `${e.proto}@${e.x.toFixed(3)},${e.y.toFixed(3)}@${Math.round(e.rot / (Math.PI / 2))}`;
      if (!seen.has(k)) { seen.add(k); continue; }
      grid.remove(e); stat.dups++;
      ctx.report('warn', `Дубликат ${e.proto} удалён`, [e.tx, e.ty]);
    }
  }
  if (params.spaceItems) {
    for (const e of grid.entities(x => !grid.tile(x.tx, x.ty) && protos.hasComp(x.proto, 'Item'))) {
      grid.remove(e); stat.removed++;
      ctx.report('warn', `${e.proto} над космосом удалён`, [e.tx, e.ty]);
    }
  }

  // ------------------------------------------------ doors
  const isDoor = id => protos.hasComp(id, 'Door') || protos.hasComp(id, 'Airlock');
  for (const e of grid.entities(x => isDoor(x.proto))) {
    let cur = e;
    if (params.locked && /Locked/.test(cur.proto)) {
      const open = cur.proto.replace('Locked', '');
      const ok = open !== cur.proto && protos.has(open) && !protos.restricted(open).length;
      if (params.unlock && ok) { cur = grid.replace(cur, open); stat.unlocked++; ctx.report('ok', `${e.proto} → ${open}`, [e.tx, e.ty]); }
      else ctx.report('warn', `Шлюз с доступом: ${e.proto}` + (ok ? ` (открытый вариант: ${open})` : ' (открытого варианта нет)'), [e.tx, e.ty]);
    }
    const bolt = grid.comp(cur, 'DoorBolt');
    if (params.locked && bolt && truthy(bolt.boltsDown)) {
      if (params.unlock) {
        const { type, boltsDown, ...rest } = bolt;
        cur = Object.keys(rest).length ? grid.setComp(cur, 'DoorBolt', rest) : grid.removeComp(cur, 'DoorBolt');
        stat.unbolted++;
        ctx.report('ok', `Болты сняты: ${cur.proto}`, [e.tx, e.ty]);
      } else ctx.report('warn', `Заболтирована: ${cur.proto}`, [e.tx, e.ty]);
    }
    const door = grid.comp(cur, 'Door');
    if (params.doors && door && door.state && door.state !== 'Closed') {
      // a map saved while the door animated: it would load half-open (no collision / airtightness)
      const { type, state, secondsUntilStateChange, ...rest } = door;
      cur = Object.keys(rest).length ? grid.setComp(cur, 'Door', rest) : grid.removeComp(cur, 'Door');
      const dls = grid.comp(cur, 'DeviceLinkSource');
      if (dls && dls.lastSignals && 'DoorStatus' in dls.lastSignals) {
        const { type: t, lastSignals, ...other } = dls;
        const { DoorStatus, ...signals } = lastSignals;
        grid.setComp(cur, 'DeviceLinkSource', Object.keys(signals).length ? { ...other, lastSignals: signals } : other);
      }
      stat.doors++;
      ctx.report('ok', `Дверь ${cur.proto} (${state}) закрыта`, [e.tx, e.ty]);
    }
  }

  ctx.progress(1);
  return `заменено ${stat.replaced}, удалено ${stat.removed}, дубликатов ${stat.dups}, шлюзов открыто ${stat.unlocked}, `
    + `болтов снято ${stat.unbolted}, дверей закрыто ${stat.doors}`;
}
