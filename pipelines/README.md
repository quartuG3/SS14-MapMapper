# Пайплайны

Пайплайн — это JS-модуль (`.js`), который маппер запускает над открытым шаттлом или над набором карт:
проверки, массовые замены, экспорт. Файлы из этой папки видны всем, кто открывает маппер (кнопка
«Пайплайны»). Свой файл можно загрузить в диалоге: он выполнится в браузере и на сервер не попадёт,
пока не нажать «Сохранить на сервер».

## Песочница

Пайплайн выполняется в Web Worker (`web/js/pipeline-worker.js`) с CSP `default-src 'none'; script-src blob:`:
ему недоступны сеть (`fetch`, `WebSocket`), `import` других файлов, DOM и файловая система. Всё, что ему
нужно снаружи, идёт через `ctx`, а сервер даёт только чтение.

Шаттл передаётся копией. Правки копятся и применяются к редактору **одним шагом** после успешного
завершения: Ctrl+Z отменяет весь прогон. Если пайплайн бросил исключение или его остановили кнопкой «Стоп»,
изменения не применяются вовсе.

## Формат

```js
export const meta = {
  name: 'Замена стен',
  description: 'Текст под названием в диалоге.',
  scope: 'map',                 // 'map' (по умолчанию) — открытый шаттл; 'batch' — много карт, см. ниже
  params: {                     // форма в диалоге; значения запоминаются
    from: { type: 'proto', label: 'Что', default: 'WallSolid' },
    to:   { type: 'proto', label: 'На что' },
    sel:  { type: 'bool', label: 'Только выделение' },
  },
};

export default async function run(ctx) {
  for (const e of ctx.grid.entities(ctx.params.from)) {
    if (ctx.params.sel && !ctx.inSelection(e.tx, e.ty)) continue;
    ctx.grid.replace(e, ctx.params.to);
  }
}
```

Типы параметров: `proto`, `tile`, `decal` (id с подсказками), `string`, `text` (многострочный), `list`
(массив строк, по одной на строку), `number`, `bool`, `select` (`options: ['a', 'b']` или `[{value, label}]`),
`enum` — значения вессела из C#-перечислений сборки с русскими подписями, как в SS14-MapViewer:
`source`: `group` (консоль верфи), `category` (размер), `class`, `engine`; `multi: true` даёт набор флажков
(значение — массив), они показываются чипами, как в диалоге «Вессел»; `empty: '(не менять)'` добавляет пустой вариант.
`price` — калькулятор цены из диалога «Вессел» (оценка StaticPrice открытого шаттла × наценка, округление, ручная цена),
значение — число.
Общие поля: `label`, `default`, `placeholder`, `help`, `fromVessel: 'group'` — подставить поле прототипа вессела
открытого шаттла (если он есть) вместо запомненного значения.

Значение, которое вернёт `run` (строка или JSON), показывается в строке результата.

## API `ctx`

### Общее

| | |
|---|---|
| `ctx.params` | значения формы |
| `ctx.log(...v)` | строка в журнал |
| `ctx.report(sev, msg, at?, path?)` | строка отчёта; `sev`: `err` `warn` `info` `ok`; `at: [x, y]` — клик переходит к клетке, `err`/`warn` ставят маркер; `path` — карта, которую открыть по клику (для batch) |
| `ctx.progress(0..1, text?)` | полоса прогресса |
| `ctx.emit(path, data)` | файл результата (строка или `Uint8Array`); один файл скачивается как есть, несколько — одним zip с этими путями |
| `ctx.selection` / `ctx.inSelection(x, y)` | выделенные клетки редактора |

### Шаттл: `ctx.grid` (в batch — `null`)

Все методы чтения возвращают **копии**; менять шаттл можно только методами ниже.

Тайлы:
- `tile(x, y)` → `{x, y, id, flags, variant, rotmir}` или `null`
- `tiles(filter?)` — фильтр: id, массив id, RegExp или функция
- `setTile(x, y, id | null, {variant, rotmir, flags}?)` — `null` = космос; вариант сохраняется, если он есть у нового тайла

Сущности (то, что стоит на гриде; `tx, ty` — клетка, `x, y` — точные координаты, `rot` — радианы):
- `entities(filter?)` — фильтр: id, массив id, RegExp, функция или `{proto, comp, at: [x, y], where}`
- `entity(uid)`, `entsAt(x, y)`, `contents(e)` — содержимое контейнеров (сырые `{uid, proto, components}`)
- `replace(e, proto)`, `remove(e)` (вместе с содержимым), `move(e, x, y)`, `rotate(e, rot)`
- `place(proto, x, y, {rot, exact, comps}?)` — в центр клетки (или точно при `exact: true`), возвращает новую сущность
- `comp(e, type)`, `setComp(e, type, data)`, `removeComp(e, type)` — компоненты, записанные в карте (не значения прототипа)

Вложенные сущности (содержимое шкафов, слотов — на любой глубине):
- `contained(filter?)` → `[{uid, proto, components, parent}]`, `parent` — uid держателя
- `replaceContained(o, proto)`, `removeContained(o)` — удаление вместе с собственным содержимым; ссылка в
  контейнере держателя убирается

Декали: `decals(filter?)`, `addDecal({id, x, y, color, angle, z, cleanable})`, `removeDecal(d)`.

Прочее: `path`, `gridUid`, `vessels` (прототипы вессела этого файла), `meta`, `bounds()`,
`protoCounts()` (`Map` id → количество, включая содержимое контейнеров), `await yaml()` — текст файла карты
в текущем состоянии, как его записало бы «Сохранить».

### Прототипы: `ctx.protos`

- `get(id, kind?)` — сводка (`id, name, ru, suffix, cat, hidden, donotmap, thruster, ...`); `kind`: `entity` `tile` `decal`
- `has(id, kind?)`, `ids(kind?)`, `migrations()`
- `restricted(id)` → причины, по которым прототип нельзя ставить: `debug` (суффикс DEBUG/TESTING, `Debug` в id),
  `admin` (Admeme / Admin / adminfu), `donotmap` (категория или суффикс DO NOT MAP), `unknown`; `[]` — можно
- `hasComp(id, comp)` — только по частым компонентам (Item, Apc, Door, Airlock, Docking, ShuttleConsole,
  GravityGenerator, PowerNetworkBattery, AirAlarm, ...). Полный список даёт `resolved`.
- `await raw(id, type?)` → `{id, type, file, data, parents}` — прототип как записан в файле (без слияния с
  родителями); `type`: `entity` `vessel` `tile` `decal`; `parents` — все предки, ближние первыми
- `await resolved(id)` → прототип с родителями: `{components: {Type: data}, ...}`

### Сборка

- `await ctx.yaml.dump(obj)` / `await ctx.yaml.load(text)` — YAML в формате маппера (теги `!type:` сохраняются)
- `await ctx.locale.raw(keys, lang)` → `{ключ или ключ.атрибут: значение}` — строки .ftl; доступны `en-US`
  и `locale` из `conf.toml`
- `ctx.locale.toFtl(entries)` — обратно в текст .ftl
- `await ctx.res.text(path)` — текстовый файл из `Resources/` (`.yml .ftl .txt .json .toml`)

### Несколько карт (`scope: 'batch'`, заготовка)

- `await ctx.maps.list(filter?)` → `[{path, cat, format, size}]` — карты сборки и папки `shuttles/` (`user/...`)
- `await ctx.maps.open(path, gridUid?)` → отдельный `Grid` с тем же API, что `ctx.grid`

Правки открытых так карт в редактор не попадают. Чтобы получить изменённые файлы, выгрузите их:
`ctx.emit('Resources/' + path, await g.yaml())`. Пример — `batch-proto-usage.js`.

## Встроенные пайплайны

- `check-errors.js` — поиск ошибок с маркерами на карте; DEBUG / админские / DO NOT MAP — красным, в том числе в контейнерах
- `final-view.js` — чистовая подготовка для DeadSpace: замена или удаление DEBUG / админских / DO NOT MAP
  прототипов (таблица, правило «без Debug в id», список исключений), отчёт по шлюзам `*Locked` и болтам с
  возможностью открыть, двери, сохранённые в состоянии открытия, дубликаты, неизвестные прототипы
- `replace-prototypes.js` — замена прототипов по таблице
- `export-with-prototypes.js` — zip: карта, прототип вессела с выбранной консолью и тегами (создаётся, если его
  нет), прототипы сущностей из выбранных папок (с родителями), локаль и `КАК_ПЕРЕНЕСТИ.txt`
- `batch-proto-usage.js` — где используются прототипы во всех картах (CSV)
