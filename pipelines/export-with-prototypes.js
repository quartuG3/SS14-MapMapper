// Экспорт шаттла вместе с прототипами: карта + прототип вессела (с выбранной консолью и тегами) + (по желанию)
// прототипы сущностей и их родители из выбранных папок сборки + строки локали + КАК_ПЕРЕНЕСТИ.txt.
// Результат — zip со структурой Resources/. Прототипы сущностей пишутся так, как они записаны в файлах сборки
// (без слияния с родителями), сгруппированными по исходным файлам.
export const meta = {
  name: 'Экспорт шаттла с прототипами',
  description: 'Собирает zip: Maps/… (шаттл в текущем состоянии), прототип вессела с выбранной консолью и тегами '
    + '(если вессела нет — создаётся), прототипы сущностей из папок под фильтр (с родителями), строки локали '
    + 'и КАК_ПЕРЕНЕСТИ.txt с короткой инструкцией. Консоль и теги подставляются из вессела открытого шаттла.',
  params: {
    mapPath: { type: 'string', label: 'Путь карты в билде', placeholder: 'пусто — как сейчас (Maps/_Export/<имя>.yml для «Моих шаттлов»)' },
    vessel: { type: 'bool', label: 'Прототип вессела', default: true },
    group: { type: 'enum', source: 'group', label: 'Консоль (group)', fromVessel: 'group', default: 'Shipyard',
      help: 'ShipyardConsoleUiKey: на какой консоли верфи шаттл продаётся.' },
    category: { type: 'enum', source: 'category', label: 'Размер (category)', fromVessel: 'category', default: 'Small' },
    classes: { type: 'enum', source: 'class', multi: true, label: 'Классы', fromVessel: 'class' },
    engines: { type: 'enum', source: 'engine', multi: true, label: 'Двигатели', fromVessel: 'engine' },
    price: { type: 'price', label: 'Калькулятор цены', fromVessel: 'price',
      help: 'Цена записывается в прототип вессела (и в существующий, и в новый).' },
    vesselId: { type: 'string', label: 'id нового вессела', placeholder: 'пусто — по имени файла', help: 'Только если у шаттла ещё нет вессела.' },
    vesselName: { type: 'string', label: 'Название нового вессела', placeholder: 'пусто — по имени файла' },
    entities: { type: 'bool', label: 'Прототипы сущностей', default: true },
    folder: { type: 'string', label: 'Фильтр папок (RegExp)', default: '_LuaM|_Mono|_NF',
      help: 'Только прототипы из файлов, путь которых подходит под выражение. Пусто — все (будет очень много).' },
    parents: { type: 'bool', label: 'С родителями', default: true },
    locale: { type: 'string', label: 'Локали', default: 'en-US, ru-RU', help: 'Пусто — без локали.' },
  },
};

export default async function run(ctx) {
  const { grid, protos, params } = ctx;
  const file = (grid.path || 'shuttle.yml').split('/').pop();
  const base = file.replace(/\.yml$/, '');
  const mapPath = (params.mapPath || '').trim().replace(/^\/+/, '').replace(/^Resources\//, '')
    || (grid.path && !grid.path.startsWith('user/') ? grid.path : `Maps/_Export/${file}`);
  const files = [];       // [path in zip, what it is] for the instructions
  const out = (path, text, what) => { ctx.emit(path, text); files.push([path, what]); };
  ctx.progress(0, 'Карта');
  out('Resources/' + mapPath, await grid.yaml(), 'карта шаттла');

  const locKeys = [];
  const vessels = [];
  if (params.vessel) {
    const tags = v => {
      if (params.group) v.group = params.group;
      if (params.category) v.category = params.category;
      if ((params.classes || []).length) v.class = params.classes; else delete v.class;
      if ((params.engines || []).length) v.engine = params.engines; else delete v.engine;
      if (params.price > 0) v.price = Math.round(params.price);
      v.shuttlePath = '/' + mapPath;
      return v;
    };
    for (const v of grid.vessels) {
      const raw = await protos.raw(v.id, 'vessel');
      if (!raw) continue;
      const data = tags({ ...raw.data });
      out('Resources/' + raw.file, await ctx.yaml.dump([data]), `прототип вессела ${data.id}`);
      vessels.push(data);
      for (const k of ['name', 'description']) if (/^[a-z][\w-]*$/.test(data[k] || '')) locKeys.push(data[k]);
      ctx.report('ok', `Вессел ${data.id} → ${raw.file} (консоль ${data.group}, ${data.category}, цена ${data.price})`);
    }
    if (!vessels.length) {
      const id = (params.vesselId || '').trim() || base.charAt(0).toUpperCase() + base.slice(1);
      const data = tags({ type: 'vessel', id, parent: 'BaseVessel', name: (params.vesselName || '').trim() || base,
        description: '', price: Math.round(params.price || 0), category: 'Small', group: 'Shipyard', shuttlePath: '', guidebookPage: 'null' });
      const path = `Prototypes/_Export/Shipyard/${base}.yml`;
      out('Resources/' + path, await ctx.yaml.dump([data]), `новый прототип вессела ${id}`);
      vessels.push(data);
      ctx.report(data.price ? 'ok' : 'warn', `Создан вессел ${id} (консоль ${data.group}, ${data.category}, цена ${data.price})`
        + (data.price ? '' : ' — укажите цену'));
    }
  }

  const ids = [];
  if (params.entities) await collectEntities(ctx, ids, (path, text) => out(path, text, 'прототипы сущностей'));

  // locale: vessel name / description keys and ent-<id> strings (with .desc / .suffix) of the exported prototypes
  locKeys.push(...ids.map(id => 'ent-' + id));
  for (const lang of locKeys.length ? (params.locale || '').split(',').map(s => s.trim()).filter(Boolean) : []) {
    const entries = await ctx.locale.raw(locKeys, lang);
    const n = Object.keys(entries).filter(k => !k.includes('.')).length;
    if (n) out(`Resources/Locale/${lang}/_Export/${base}.ftl`, ctx.locale.toFtl(entries), `локаль ${lang}`);
    ctx.report(n ? 'ok' : 'info', `Локаль ${lang}: ${n} строк` + (n ? '' : ' (нет ключей или язык не загружен: доступны en-US и locale из conf.toml)'));
  }

  ctx.emit('КАК_ПЕРЕНЕСТИ.txt', instructions(base, mapPath, vessels, files, ids.length));
  ctx.progress(1);
}

function instructions(base, mapPath, vessels, files, nProtos) {
  const L = [];
  L.push(`Перенос шаттла «${base}» в билд`, '');
  L.push('1. Скопируйте папку Resources из архива в корень репозитория билда с объединением папок.');
  L.push('   Файлы, которые уже есть в билде, не заменяйте вслепую: сравните и перенесите только недостающее.', '');
  L.push('   Что в архиве:');
  for (const [p, what] of files) L.push(`   - ${p} — ${what}`);
  L.push('');
  L.push(`2. Карта лежит в ${mapPath}. Если переносите её в другую папку, поправьте shuttlePath в прототипе вессела.`);
  for (const v of vessels) {
    L.push(`3. Вессел ${v.id}: консоль ${v.group}, размер ${v.category}` + (v.class ? `, классы ${[].concat(v.class).join(', ')}` : '')
      + (v.engine ? `, двигатели ${[].concat(v.engine).join(', ')}` : '') + `, цена ${v.price ?? '—'}.`);
    L.push('   Убедитесь, что в билде есть такая консоль (ShipyardConsoleUiKey) и такие значения классов и двигателей.');
  }
  if (nProtos) {
    L.push('4. Прототипы сущностей: если в билде уже есть прототипы с теми же id, удалите дубли из скопированных файлов,');
    L.push('   иначе сервер не запустится с ошибкой о повторяющемся id.');
  }
  L.push('5. Локаль: строки ent-* и название вессела лежат в Locale/<язык>/_Export/. Их можно перенести в свои .ftl.');
  L.push('6. Проверка: запустите сервер, убедитесь, что в логе нет ошибок прототипов, купите шаттл на консоли и осмотрите его.');
  return L.join('\r\n') + '\r\n';
}

async function collectEntities(ctx, ids, emit) {
  const { grid, protos, params } = ctx;
  const rx = params.folder ? new RegExp(params.folder) : null;
  const byFile = new Map();     // file -> [raw data]
  const taken = new Set();
  const queue = [...grid.protoCounts().keys()];
  let done = 0;
  while (queue.length) {
    const id = queue.shift();
    if (taken.has(id)) continue;
    taken.add(id);
    if (++done % 25 === 0) ctx.progress(done / (done + queue.length), 'Прототипы: ' + id);
    const raw = await protos.raw(id);
    if (!raw) { ctx.report('err', `Нет прототипа ${id}`); continue; }
    if (rx && !rx.test(raw.file || '')) continue;
    if (!byFile.has(raw.file)) byFile.set(raw.file, []);
    byFile.get(raw.file).push(raw.data);
    if (params.parents) queue.push(...raw.parents);
  }
  for (const [file, docs] of byFile) {
    emit('Resources/' + file, await ctx.yaml.dump(docs));
    ids.push(...docs.map(d => d.id));
  }
  ctx.report('ok', `Прототипов: ${ids.length} в ${byFile.size} файлах`);
}
