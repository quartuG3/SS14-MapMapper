// Замена прототипов по таблице: по строке на пару "Что -> НаЧто". Пустая правая часть удаляет сущность.
export const meta = {
  name: 'Замена прототипов по таблице',
  description: 'Каждая строка: «СтарыйId -> НовыйId» (или через пробел). Без правой части сущности удаляются.\n'
    + 'Строки с # — комментарии. Можно ограничиться выделением.',
  params: {
    table: { type: 'text', label: 'Таблица замен', rows: 8, placeholder: 'WallSolid -> WallReinforced\nAirlockGlass -> AirlockGlassShuttle' },
    onlySelection: { type: 'bool', label: 'Только в выделении', default: false },
  },
};

export default function run(ctx) {
  const pairs = new Map();
  for (const raw of ctx.params.table.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [from, to = ''] = line.split(/\s*->\s*|\s+/);
    if (to && !ctx.protos.has(to)) { ctx.report('err', `Неизвестный прототип: ${to} (строка «${line}»)`); continue; }
    pairs.set(from, to);
  }
  if (!pairs.size) { ctx.report('warn', 'Таблица пуста'); return; }
  if (ctx.params.onlySelection && !ctx.selection.length) { ctx.report('warn', 'Ничего не выделено'); return; }

  const counts = new Map();
  for (const e of ctx.grid.entities([...pairs.keys()])) {
    if (ctx.params.onlySelection && !ctx.inSelection(e.tx, e.ty)) continue;
    const to = pairs.get(e.proto);
    if (to) ctx.grid.replace(e, to); else ctx.grid.remove(e);
    counts.set(e.proto, (counts.get(e.proto) || 0) + 1);
  }
  for (const [from, to] of pairs) {
    const n = counts.get(from) || 0;
    ctx.report(n ? 'ok' : 'info', `${from} → ${to || '(удалено)'}: ${n}`);
  }
}
