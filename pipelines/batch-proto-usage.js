// Заготовка пакетного пайплайна (scope: 'batch'): проходит по многим картам, ничего не меняет в редакторе.
// Пример: где используются прототипы. Результат — отчёт (клик открывает карту) и CSV.
export const meta = {
  name: 'Где используется прототип (по всем картам)',
  scope: 'batch',
  description: 'Открывает каждую карту, подходящую под фильтр, и считает сущности с нужными прототипами. '
    + 'Заготовка для своих пакетных пайплайнов: ctx.maps.list() + ctx.maps.open(path).',
  params: {
    protos: { type: 'list', label: 'Прототипы (id или /RegExp/)', placeholder: 'GravityGeneratorMini\n/^Thruster/' },
    filter: { type: 'string', label: 'Фильтр путей карт (RegExp)', default: 'Shuttles' },
    stations: { type: 'bool', label: 'Включая целые карты (станции)', default: false },
  },
};

export default async function run(ctx) {
  const tests = ctx.params.protos.map(s => {
    const m = /^\/(.*)\/(\w*)$/.exec(s);
    if (m) { const rx = new RegExp(m[1], m[2]); return id => rx.test(id); }
    return id => id === s;
  });
  if (!tests.length) { ctx.report('warn', 'Не заданы прототипы'); return; }
  const rx = ctx.params.filter ? new RegExp(ctx.params.filter, 'i') : null;
  const maps = (await ctx.maps.list()).filter(m => (!rx || rx.test(m.path)) && (ctx.params.stations || m.cat !== 'Map'));
  const csv = ['map;proto;count'];
  let total = 0;
  for (let i = 0; i < maps.length; i++) {
    const path = maps[i].path;
    ctx.progress(i / maps.length, path);
    let grid;
    try { grid = await ctx.maps.open(path); } catch (e) { ctx.report('err', e.message, null, path); continue; }
    for (const [id, n] of grid.protoCounts()) {
      if (!tests.some(t => t(id))) continue;
      const first = grid.entities(id)[0];
      ctx.report('info', `${id}: ${n}`, first ? [first.tx, first.ty] : null, path);
      csv.push(`${path};${id};${n}`);
      total += n;
    }
  }
  ctx.progress(1);
  ctx.emit('proto-usage.csv', csv.join('\n') + '\n');
  return `Карт: ${maps.length}, найдено сущностей: ${total}`;
}
