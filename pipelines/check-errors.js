// Проверки шаттла: неизвестные, debug / admin / DO NOT MAP прототипы (и в контейнерах), сущности в космосе,
// дубликаты, обязательное оборудование.
export const meta = {
  name: 'Поиск ошибок',
  description: 'Красным: неизвестные прототипы, DEBUG, Admeme/Admin и DO NOT MAP (на гриде и в контейнерах). '
    + 'Жёлтым: сущности над космосом, дубликаты на одной клетке. '
    + 'Плюс отсутствие консоли, гравитации, APC, двигателей. Клик по строке переходит к клетке.',
  params: {
    contained: { type: 'bool', label: 'Проверять содержимое контейнеров', default: true },
    space: { type: 'bool', label: 'Сущности над космосом', default: true },
    required: { type: 'bool', label: 'Обязательное оборудование', default: true },
  },
};

const SPACE_OK = /Thruster|Lattice|Catwalk|Grille|Radar|Shield|Marker|SpawnPoint|Docking|Airlock/;
const REASONS = { debug: 'DEBUG', admin: 'админский', donotmap: 'DO NOT MAP', unknown: 'неизвестный' };

export default function run(ctx) {
  const { grid, protos } = ctx;
  const ents = grid.entities();
  const seen = new Map();
  const reported = new Set();
  const restricted = (id, at, where) => {
    const why = protos.restricted(id);
    if (!why.length) return false;
    const k = id + '@' + at;
    if (!reported.has(k)) ctx.report('err', `${id}${where}: ${why.map(r => REASONS[r]).join(', ')} прототип`, at);
    reported.add(k);
    return true;
  };
  const has = { console: 0, grav: 0, apc: 0, thrust: 0 };
  ents.forEach((e, i) => {
    if (i % 2000 === 0) ctx.progress(i / ents.length, 'Сущности');
    const at = [e.tx, e.ty];
    if (restricted(e.proto, at, '') && !protos.has(e.proto)) return;
    const p = protos.get(e.proto);
    const k = `${e.proto}@${e.x.toFixed(3)},${e.y.toFixed(3)}@${Math.round(e.rot / (Math.PI / 2))}`;
    if (seen.has(k)) ctx.report('warn', `Дубликат ${e.proto} в (${e.tx}, ${e.ty})`, at);
    else seen.set(k, e.uid);
    if (ctx.params.space && !grid.tile(e.tx, e.ty) && !protos.hasComp(e.proto, 'Item') && !SPACE_OK.test(e.proto))
      ctx.report('warn', `${e.proto} над космосом (${e.tx}, ${e.ty})`, at);
    if (protos.hasComp(e.proto, 'ShuttleConsole')) has.console++;
    if (protos.hasComp(e.proto, 'GravityGenerator')) has.grav++;
    if (protos.hasComp(e.proto, 'Apc')) has.apc++;
    if (p.thruster && p.thruster.type !== 'Angular') has.thrust++;
  });
  if (ctx.params.contained) {
    const inside = grid.contained();
    const byUid = new Map(inside.map(o => [o.uid, o]));
    for (const o of inside) {
      const holder = holderOf(grid, byUid, o);
      restricted(o.proto, holder ? [holder.tx, holder.ty] : null, holder ? ` в ${holder.proto}` : ' (в контейнере)');
    }
  }
  if (ctx.params.required) {
    if (!has.console) ctx.report('err', 'Нет консоли пилота (ShuttleConsole)');
    if (!has.grav) ctx.report('warn', 'Нет генератора гравитации');
    if (!has.apc) ctx.report('err', 'Нет ни одного APC');
    if (!has.thrust) ctx.report('err', 'Нет двигателей');
  }
  ctx.progress(1);
  return `${ents.length} сущностей проверено`;
}

/** The grid entity that (through nested containers) holds a contained entity. */
function holderOf(grid, byUid, o) {
  let p = o.parent;
  for (let i = 0; i < 16 && p; i++) {
    const e = grid.entity(p);
    if (e) return e;
    p = byUid.has(p) ? byUid.get(p).parent : null;
  }
  return null;
}
