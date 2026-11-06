// Panels, palette, tool options and dialogs.
import { S, on, emit, toast, savePrefs } from './state.js';
import { P, search, displayName, ent as protoOf, mirrorId } from './protos.js';
import { newGroup, symToFile, symFromFile, randomToFile, randomFromFile } from './symmetry.js';
import * as PL from './palettes.js';
import * as RD from './radar.js';
import * as TX from './texts.js';
import * as A from './assets.js';
import * as O from './ops.js';
import { TOOLS, TOOL_ORDER, setTool, setMode, startPaste, fillCells, specialContext } from './tools.js';
import * as TL from './tools.js';
import * as L from './links.js';
import { requestDraw, centerOn, fitToContent, bake, size as viewSize, s2w } from './view.js';
import { validate, stats, vesselYaml, findReplace } from './features.js';
import { key, unkey, tileOf, rotSteps, stepsToRot, normAngle, HALF_PI, leakTiles, pipeLayerOf, pipeColorOf, hasComp } from './logic.js';

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'checked' || k === 'value' || k === 'selected' || k === 'disabled') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const $ = id => document.getElementById(id);
const M = () => S.model;
export const api = {
  async get(url) { const r = await fetch(url); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; },
  async post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ct = r.headers.get('Content-Type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) throw new Error((data && data.error) || r.status);
    return data;
  },
};

// ===================================================================== modal
export function modal(title, body, onClose, { wide = false } = {}) {
  $('modalTitle').textContent = title;
  $('modal').querySelector('.modal-box').classList.toggle('wide', wide);
  const mb = $('modalBody');
  mb.innerHTML = '';
  mb.append(body);
  $('modal').classList.remove('hidden');
  const close = () => { $('modal').classList.add('hidden'); mb.innerHTML = ''; if (onClose) onClose(); };
  $('modalClose').onclick = close;
  return close;
}
export const closeModal = () => $('modal').classList.add('hidden');
export const modalOpen = () => !$('modal').classList.contains('hidden');

// ===================================================================== toolbar
export function buildToolbar() {
  const tb = $('toolbar');
  tb.innerHTML = '';
  for (const id of TOOL_ORDER) {
    if (!id) { tb.append(h('div', { class: 'tsep' })); continue; }
    const t = TOOLS[id];
    tb.append(h('button', { 'data-tool': id, title: t.title, onclick: () => setTool(id) }, t.icon));
  }
  on('tool', id => {
    for (const b of tb.querySelectorAll('button')) b.classList.toggle('on', b.dataset.tool === id);
    renderToolOptions();
  });
  on('selection', () => { renderToolOptions(); updateStatus(); });
  on('mode', m => {
    // a special mode places prototypes: show them in the palette
    if (m !== 'normal' && S.palView !== 'custom' && S.palView !== 'entity') setPalKind('entity', true);
    renderToolOptions();
  });
}

// ===================================================================== tool options
const MODE_TOOL = { wiring: 'wire', atmos: 'pipe', disposal: 'disposal' };
const PIPE_COLORS = [['#0055CCFF', 'Подача'], ['#990000FF', 'Отходы'], ['#03FCD3FF', 'Смесь'], ['#FF1212FF', 'Плазма'], ['#FFEB3BFF', 'Азот/O₂'], ['#947507FF', 'Топливо'], ['#FFFFFFFF', 'Белый']];
function chk(label, obj, k, after) {
  return h('label', {}, h('input', { type: 'checkbox', checked: !!obj[k], onchange: e => { obj[k] = e.target.checked; savePrefs(); after && after(); requestDraw(); } }), label);
}
export function renderToolOptions() {
  const box = $('toolOptions');
  box.innerHTML = '';
  const t = TOOLS[S.tool];
  const opts = [...((t && t.options) || [])];
  const ctx = specialContext();
  if (S.tool === 'entity' && ctx) opts.push(MODE_TOOL[ctx]);
  const add = (...els) => box.append(...els);
  if (opts.includes('brush')) {
    add(h('label', {}, 'Кисть', h('input', { type: 'range', min: 1, max: 9, value: S.brush, oninput: e => { S.brush = +e.target.value; e.target.nextSibling.textContent = S.brush; requestDraw(); } }), String(S.brush)));
  }
  if (opts.includes('variant')) add(chk('случайный вариант', S.tileOpts, 'randomVariant'));
  if (opts.includes('tileRot') && S.sel.tile) {
    const tp = P.tiles.get(S.sel.tile);
    const label = tp && tp.rotmir ? ['0°', '90°', '180°', '270°'][(S.tileOpts.rm || 0) % 4] + ((S.tileOpts.rm || 0) >= 4 ? ' отр.' : '') : S.sel.tile;
    add(h('span', { title: 'Фигурные тайлы (клинья, углы, HalfTilt) переключаются на тайл другой ориентации, тайлы с allowRotationMirror поворачиваются' }, 'Поворот тайла:'),
      h('button', { onclick: () => { TL.rotateBrushTile(3); renderToolOptions(); }, title: 'Shift+R' }, '↻'),
      h('b', {}, label),
      h('button', { onclick: () => { TL.rotateBrushTile(1); renderToolOptions(); }, title: 'R' }, '↺'));
  }
  if (opts.includes('rot')) {
    add(h('span', {}, 'Поворот: '),
      h('button', { onclick: () => { S.rotSteps = (S.rotSteps + 3) % 4; renderToolOptions(); requestDraw(); }, title: 'Shift+R' }, '↻'),
      h('b', {}, ['↓ Юг 0°', '→ Восток 90°', '↑ Север 180°', '← Запад 270°'][S.rotSteps]),
      h('button', { onclick: () => { S.rotSteps = (S.rotSteps + 1) % 4; renderToolOptions(); requestDraw(); }, title: 'R' }, '↺'));
  }
  if (opts.includes('step')) {
    const steps = [['center', 'центр тайла'], ['0.5', '½ тайла'], ['0.25', '¼ тайла'], ['0.125', '⅛ тайла'], ['0.03125', '1 px (свободно)']];
    add(h('label', { title: 'Привязка позиции. Shift при клике — свободно (1 px)' }, 'Привязка',
      h('select', { onchange: e => { S.entOpts.step = e.target.value; savePrefs(); requestDraw(); } },
        ...steps.map(([v, n]) => h('option', { value: v, selected: String(S.entOpts.step) === v }, n)))));
  }
  if (opts.includes('replace')) add(chk('замена (стены)', S.entOpts, 'replace'));
  if (opts.includes('underlay')) {
    const dl = h('datalist', { id: 'underlayTiles' }, ...[...P.tiles.values()].filter(t => !t.space).map(t => h('option', { value: t.id })));
    add(h('span', { title: 'Если тайла под размещаемым прототипом нет — подложить этот тайл' }, chk('подложка', S.entOpts, 'underlay')),
      dl, h('input', { list: 'underlayTiles', value: S.entOpts.underlayTile || 'Plating', style: 'width:110px', onchange: e => {
        if (P.tiles.has(e.target.value)) { S.entOpts.underlayTile = e.target.value; savePrefs(); } else { toast('Нет такого тайла: ' + e.target.value, 'err'); e.target.value = S.entOpts.underlayTile; }
      } }),
      h('span', { title: 'Новая структура (стена, окно, машина…) удаляет другие структуры в тайле' }, chk('заменять структуры', S.entOpts, 'replaceStructs')));
  }
  if (opts.includes('link')) {
    const lk = TL.link;
    const holder = lk.holder && M().ents.get(lk.holder);
    add(h('div', { class: 'seg' },
      h('button', { class: lk.mode === 'list' ? 'on' : '', onclick: () => { lk.mode = 'list'; lk.holder = null; renderToolOptions(); requestDraw(); } }, 'Сеть устройств (сигнализации)'),
      h('button', { class: lk.mode === 'signal' ? 'on' : '', onclick: () => { lk.mode = 'signal'; lk.holder = null; renderToolOptions(); requestDraw(); } }, 'Сигналы (порты)')));
    if (holder) {
      add(h('span', {}, 'Выбрано: ', h('b', {}, holder.proto), ` (${holder.uid})`));
      if (lk.mode === 'list') add(
        h('span', { class: 'muted' }, `устройств: ${L.listDevices(holder).length}`),
        h('button', { onclick: () => { const r = L.autoLinkRoom(holder.uid); toast(`Добавлено: ${r.added} (комната ${r.room.size} тайлов)`, 'ok'); renderToolOptions(); requestDraw(); } }, '⚙ Автосвязь комнаты'));
      add(h('button', { onclick: () => { lk.holder = null; renderToolOptions(); requestDraw(); } }, 'Сбросить (Esc)'));
    } else add(h('span', { class: 'muted' }, lk.mode === 'list' ? 'Кликните по AirAlarm / FireAlarm, затем по устройствам' : 'Кликните по источнику (кнопка, рычаг…), затем по приёмнику'));
  }
  if (opts.includes('dup')) add(h('span', { title: 'Разрешить несколько одинаковых прототипов в одной точке' }, chk('дубликаты', S.entOpts, 'allowDup')));
  if (opts.includes('devices') && (S.tool !== 'entity' || ctx)) deviceBar(add, ctx);
  if (opts.includes('decal')) {
    add(h('label', {}, 'Цвет', h('input', { type: 'color', value: S.decal.color.slice(0, 7), oninput: e => { S.decal.color = e.target.value.toUpperCase() + S.decal.color.slice(7, 9).padEnd(2, 'F'); savePrefs(); requestDraw(); } })),
      h('label', {}, 'α', h('input', { type: 'range', min: 0, max: 255, value: parseInt(S.decal.color.slice(7, 9) || 'FF', 16), oninput: e => { S.decal.color = S.decal.color.slice(0, 7) + (+e.target.value).toString(16).padStart(2, '0').toUpperCase(); savePrefs(); } })),
      chk('привязка', S.decal, 'snap'),
      h('button', { onclick: () => { S.decal.angle = normAngle(S.decal.angle + HALF_PI); renderToolOptions(); requestDraw(); } }, `↺ ${Math.round(S.decal.angle * 180 / Math.PI)}°`),
      h('label', {}, 'z', h('input', { type: 'number', value: S.decal.z, style: 'width:50px', onchange: e => { S.decal.z = +e.target.value | 0; savePrefs(); } })),
      chk('смываемая', S.decal, 'cleanable'));
  }
  if (opts.includes('fill')) add(chk('не через стены', S.fillOpts, 'stopAtWalls'), h('span', { class: 'muted' }, `заливка: ${({ tile: 'тайл', entity: 'прототип', decal: 'декаль' })[S.palKind]} (ПКМ — стереть)`));
  if (opts.includes('erase')) add(chk('тайлы', S.eraseOpts, 'tiles'), chk('сущности', S.eraseOpts, 'ents'), chk('только верхнюю', S.eraseOpts, 'top'), chk('декали', S.eraseOpts, 'decals'));
  if (opts.includes('pipe')) {
    const sel = h('select', { onchange: e => { S.pipe.layer = e.target.value; savePrefs(); } },
      ...['Primary', 'Secondary', 'Tertiary'].map(l => h('option', { value: l, selected: S.pipe.layer === l }, l)));
    add(h('label', {}, 'Слой', sel));
    for (const [c, n] of PIPE_COLORS) add(h('span', { class: 'swatch' + (S.pipe.color === c ? ' on' : ''), title: n, style: `background:${c.slice(0, 7)}`, onclick: () => { S.pipe.color = c; savePrefs(); renderToolOptions(); } }));
    add(h('input', { type: 'color', value: S.pipe.color.slice(0, 7), title: 'Свой цвет', oninput: e => { S.pipe.color = e.target.value.toUpperCase() + 'FF'; savePrefs(); } }));
  }
  if (opts.includes('disposal')) {
    const names = { junction: 'Развилка', router: 'Маршрутизатор', signal: 'Сигнальный' };
    const tips = { junction: 'DisposalJunction / Flipped / YJunction', router: 'DisposalRouter: предметы с метками сортировщика уходят вбок', signal: 'DisposalSignalRouter: направление переключается сигналом' };
    add(h('span', { title: 'Какой прототип ставить, когда к трубе подводится третья ветка' }, 'Новые развилки:'),
      h('div', { class: 'seg' }, ...Object.entries(names).map(([k, n]) => h('button', { class: S.disposal.junction === k ? 'on' : '', title: tips[k], onclick: () => { S.disposal.junction = k; savePrefs(); renderToolOptions(); } }, n))),
      h('span', { class: 'muted' }, 'над трубой: R — выход развилки, T — тип; крестовин нет'));
  }
  if (opts.includes('wire')) {
    const seg = h('div', { class: 'seg' }, ...['HV', 'MV', 'LV'].map(k => h('button', { class: S.wire.kind === k ? 'on' : '', onclick: () => { S.wire.kind = k; savePrefs(); renderToolOptions(); } }, k)));
    add(seg, h('span', { class: 'muted' }, 'HV — генераторы/SMES, MV — подстанция→APC, LV — APC→потребители'));
  }
  if (opts.includes('random')) {
    const sel = h('select', { onchange: e => { S.random.active = +e.target.value; } },
      ...S.random.sets.map((s, i) => h('option', { value: i, selected: i === S.random.active }, s.name)));
    add(h('label', {}, 'Набор', sel), h('label', {}, 'Плотность', h('input', { type: 'range', min: 1, max: 100, value: S.random.density, oninput: e => { S.random.density = +e.target.value; e.target.nextSibling.textContent = S.random.density + '%'; savePrefs(); } }), S.random.density + '%'));
  }
  if ((S.tool === 'select' || S.tool === 'wand') && S.selection.size) selectionActions(add);
  else if (S.tool === 'select' || S.tool === 'wand') add(h('span', { class: 'muted' }, 'Выделите область. Ctrl+A — всё, Esc — снять'));
}

// quick device bars for wiring / atmos modes
const DEVICE_GROUPS = {
  wiring: [
    ['APC', p => p.c && p.c.includes('Apc')],
    ['SMES', p => /^SMES/.test(p.id)],
    ['Подстанция', p => /^Substation/.test(p.id) && !(p.c || []).includes('Item')],
    ['Терминал', p => /^CableTerminal/.test(p.id)],
    ['Генераторы', p => (p.supply > 0 || (p.c || []).includes('AmeController')) && !/Debug|Admin/.test(p.id)],
  ],
  atmos: [
    ['Вентиляция', p => /^GasVentPump/.test(p.id)],
    ['Скруббер', p => /^GasVentScrubber/.test(p.id)],
    ['Пассивная вент.', p => /^GasPassiveVent/.test(p.id)],
    ['Насосы', p => /^Gas(Pressure|Volume)Pump/.test(p.id)],
    ['Клапаны', p => /^Gas(Valve|ManualValve|DualPortVentPump|Outlet)/.test(p.id)],
    ['Порт', p => /^GasPort/.test(p.id)],
    ['Смеситель', p => /^GasMixer/.test(p.id)],
    ['Фильтр', p => /^GasFilter/.test(p.id)],
    ['Термомашины', p => /^GasThermoMachine/.test(p.id)],
    ['Датчики', p => /^(AirAlarm|AirSensor|FireAlarm|GasAnalyzer)$/.test(p.id) || (p.c || []).includes('AirAlarm')],
    ['Канистры', p => /^(Air|Oxygen|Nitrogen|Plasma|CarbonDioxide|Storage)Canister$/.test(p.id)],
  ],
};
DEVICE_GROUPS.disposal = [
  ['Блоки', p => (p.c || []).includes('DisposalUnit') && !/Toilet/.test(p.id)],
  ['Трубы', p => ['transit', 'bend', 'entry', 'broken'].includes(p.dispKind)],
  ['Сортировка', p => p.dispKind === 'tagger' || p.dispKind === 'router' || p.dispKind === 'signal'],
  ['Развилки', p => p.dispKind === 'junction'],
  ['Туалеты', p => (p.c || []).includes('DisposalUnit') && /Toilet/.test(p.id)],
];
const deviceCache = {};
function devicesFor(mode) {
  if (deviceCache[mode]) return deviceCache[mode];
  const all = [...P.ents.values()].filter(p => !p.hidden && !p.donotmap);
  deviceCache[mode] = (DEVICE_GROUPS[mode] || []).map(([name, f]) => [name,
    all.filter(f).sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id)).slice(0, 8)]).filter(g => g[1].length);
  return deviceCache[mode];
}
function deviceBar(add, mode) {
  const bar = h('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;align-items:center;width:100%' });
  const back = { wiring: ['wire', '⚡ к кабелям'], atmos: ['pipe', '◎ к трубам'], disposal: ['disposal', '♻ к утилизации'] }[mode];
  if (S.tool === 'entity') bar.append(h('button', { onclick: () => setTool(back[0]) }, back[1]));
  for (const [name, list] of devicesFor(mode)) {
    const grp = h('span', { style: 'display:inline-flex;gap:1px;align-items:center;border:1px solid var(--line);border-radius:4px;padding:1px 3px' }, h('span', { class: 'muted', style: 'font-size:11px;margin-right:2px' }, name));
    for (const p of list) {
      grp.append(h('img', { src: A.iconUrl(p.id), title: displayName('entity', p.id) + '\n' + p.id,
        style: 'width:24px;height:24px;image-rendering:pixelated;cursor:pointer;border-radius:3px;' + (S.sel.entity === p.id && S.tool === 'entity' ? 'outline:2px solid var(--acc)' : ''),
        onclick: () => { S.sel.entity = p.id; setTool('entity'); remember(p.id); } }));
    }
    bar.append(grp);
  }
  add(bar);
}
function remember(id) {
  const r = S.recent.entity;
  const i = r.indexOf(id);
  if (i >= 0) r.splice(i, 1);
  r.unshift(id);
  if (r.length > 18) r.length = 18;
}

function selectionActions(add) {
  const f = S.selFilter;
  add(h('span', { class: 'muted' }, 'Фильтр:'), chk('тайлы', f, 'tiles'), chk('сущности', f, 'ents'), chk('декали', f, 'decals'));
  add(h('span', { class: 'sep' }));
  add(h('button', { onclick: () => selAction('copy'), title: 'Ctrl+C' }, 'Копир.'),
    h('button', { onclick: () => selAction('cut'), title: 'Ctrl+X' }, 'Вырез.'),
    h('button', { onclick: () => selAction('delete'), title: 'Del' }, 'Удал.'),
    h('button', { onclick: () => selAction('fill'), title: 'F — залить текущим элементом палитры' }, 'Залить'),
    h('button', { onclick: () => selAction('outline'), title: 'Shift+F — контур внутри текущим прототипом' }, 'Контур'),
    h('button', { onclick: () => selAction('shell'), title: 'Обвести снаружи текущим прототипом (стены) с подложкой Plating' }, 'Оболочка'),
    h('button', { onclick: () => selAction('rot'), title: 'Ctrl+R — повернуть на 90°' }, '⟲90'),
    h('button', { onclick: () => selAction('flipX'), title: 'Shift+H — отразить по X' }, '⇋'),
    h('button', { onclick: () => selAction('flipY'), title: 'Shift+J — отразить по Y' }, '⇵'),
    h('button', { onclick: () => selAction('mirrorCopy'), title: 'Скопировать выделение на другую сторону осей зеркала' }, '⇋ копия'),
    h('button', { onclick: () => selAction('prefab'), title: 'Сохранить как префаб' }, 'Префаб'));
  add(h('span', { class: 'sep' }));
  add(h('button', { onclick: () => selAction('scatter'), title: 'Рассыпать активный набор рандома' }, '🎲 Рассыпать'),
    h('button', { onclick: () => selAction('variants'), title: 'Случайные варианты тайлов' }, '🎲 Варианты'),
    h('button', { onclick: () => selAction('rotations'), title: 'Случайные повороты сущностей' }, '🎲 Повороты'));
}

export function moveSelection(dx, dy) {
  const clip = O.extract(S.selection);
  if (!clip) return;
  M().begin('Сдвиг выделения');
  O.deleteSelection(S.selection);
  O.pasteClip(clip, clip.minx + dx, clip.miny + dy, false);
  M().commit();
  S.selection = new Set([...S.selection].map(k => { const [x, y] = unkey(k); return key(x + dx, y + dy); }));
  emit('selection');
  requestDraw();
}

export function selAction(act) {
  const model = M();
  const sel = S.selection;
  if (!sel.size && act !== 'paste') return;
  switch (act) {
    case 'copy': S.clipboard = O.extract(sel); toast(`Скопировано: ${S.clipboard.tiles.length} тайлов, ${S.clipboard.ents.length} сущностей`); break;
    case 'cut': S.clipboard = O.extract(sel); model.begin('Вырезать'); O.deleteSelection(sel); model.commit(); break;
    case 'delete': model.begin('Удалить'); O.deleteSelection(sel); model.commit(); break;
    case 'fill': fillCells([...sel]); break;
    case 'outline': case 'shell': {
      const proto = S.sel.entity;
      if (!proto) { toast('Выберите прототип (стену) в палитре'); return; }
      const cells = new Set();
      for (const k of sel) {
        const [x, y] = unkey(k);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const nk = key(x + dx, y + dy);
          if (sel.has(nk)) continue;
          cells.add(act === 'outline' ? k : nk);
        }
      }
      model.begin(act === 'shell' ? 'Оболочка' : 'Контур');
      for (const k of cells) {
        const [x, y] = unkey(k);
        if (act === 'shell' && !model.getTile(x, y)) O.paintTile(x, y, ['Plating', 0, 0, 0], false);
        O.placeEnt({ proto, x: x + 0.5, y: y + 0.5, rot: stepsToRot(S.rotSteps), mirror: false });
      }
      model.commit();
      break;
    }
    case 'rot': case 'flipX': case 'flipY': {
      const clip = O.extract(sel);
      const xf = { rot: act === 'rot' ? 1 : 0, flipX: act === 'flipX', flipY: act === 'flipY' };
      const c2 = O.transformClip(clip, xf);
      const cx = clip.minx + Math.floor((clip.w - c2.w) / 2), cy = clip.miny + Math.floor((clip.h - c2.h) / 2);
      model.begin('Трансформация');
      O.deleteSelection(sel);
      const covered = O.pasteClip(c2, cx, cy, false);
      model.commit();
      // transform the selection shape too
      const ns = new Set();
      for (const k of sel) {
        let [x, y] = unkey(k); x -= clip.minx; y -= clip.miny;
        if (xf.rot) [x, y] = [clip.h - 1 - y, x];
        if (xf.flipX) x = c2.w - 1 - x;
        if (xf.flipY) y = c2.h - 1 - y;
        ns.add(key(x + cx, y + cy));
      }
      for (const k of covered) ns.add(k);
      S.selection = ns;
      break;
    }
    case 'mirrorCopy': {
      if (!S.mirror.x && !S.mirror.y) { toast('Включите ось зеркала (X и/или Y)'); return; }
      const clip = O.extract(sel);
      model.begin('Зеркальная копия');
      O.pasteClip(clip, clip.minx, clip.miny, true);
      model.commit();
      break;
    }
    case 'prefab': {
      const clip = O.extract(sel);
      const name = prompt('Имя префаба:', 'room');
      if (!name) return;
      api.post('/api/prefab', { name, clip }).then(() => { toast('Префаб сохранён', 'ok'); renderPrefabs(); }).catch(e => toast(e.message, 'err'));
      break;
    }
    case 'scatter': {
      const set = O.activeSet();
      if (!set) { toast('Нет активного набора на вкладке «Рандом»'); return; }
      const rnd = O.rng();
      model.begin('Рассыпать');
      for (const k of [...sel].sort()) { const [x, y] = unkey(k); O.applyRandomAt(x, y, set, rnd, S.random.density); }
      model.commit();
      break;
    }
    case 'variants': model.begin('Варианты'); O.randomizeVariants(sel, O.rng()); model.commit(); break;
    case 'rotations': model.begin('Повороты'); O.randomRotation(sel, O.rng()); model.commit(); break;
  }
  emit('selection');
  requestDraw();
}

// ===================================================================== palette
let palObserver = null;
export function buildPalette() {
  const kindSeg = $('palKind');
  kindSeg.querySelectorAll('button').forEach(b => b.onclick = () => { setPalKind(b.dataset.kind); toolForPalKind(b.dataset.kind); });
  $('palSearch').oninput = () => renderPalette();
  $('palCat').onchange = () => renderPalette();
  $('palHidden').onchange = () => renderPalette();
  palObserver = new IntersectionObserver(entries => {
    for (const en of entries) if (en.isIntersecting) { const img = en.target; if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; } palObserver.unobserve(img); }
  }, { root: $('palGrid') });
  on('pick', kind => {
    if (S.palView !== 'custom') { setPalKind(kind, true); return; }
    S.palKind = kind;
    markSelected(kind, S.sel[kind]);
    showInfo(kind, S.sel[kind]);
  });
  on('recent', renderRecent);
  setPalKind(S.palKind);
}
// opening a palette tab selects its placement tool; fill and selection tools work with any kind and stay
const PAL_TOOL = { tile: 'tile', entity: 'entity', decal: 'decal' };
function toolForPalKind(kind) {
  const tool = PAL_TOOL[kind];
  if (tool && S.tool !== tool && !['fill', 'select', 'wand'].includes(S.tool)) setTool(tool);
}
export function setPalKind(kind, keepSearch) {
  // palView is what the tab shows ('custom' = own palettes), palKind the kind of the current element
  S.palView = kind;
  if (kind !== 'custom') S.palKind = kind;
  $('palKind').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.kind === kind));
  $('palCatRow').style.display = kind === 'custom' ? 'none' : '';
  $('palCustomBar').style.display = kind === 'custom' ? '' : 'none';
  if (kind === 'custom') renderCustomBar();
  const cat = $('palCat');
  cat.innerHTML = '';
  cat.append(h('option', { value: '' }, 'Все категории'));
  if (kind === 'entity') for (const c of P.entCats) cat.append(h('option', { value: c }, c));
  if (kind === 'decal') { const tags = new Set(); for (const d of P.decals.values()) for (const t of d.tags || []) tags.add(t); for (const t of [...tags].sort()) cat.append(h('option', { value: t }, t)); }
  cat.style.display = kind === 'tile' ? 'none' : '';
  if (!keepSearch) $('palSearch').value = '';
  renderPalette();
  renderRecent();
  renderToolOptions();
}
function itemImg(kind, id) {
  const img = h('img', { alt: '' });
  img.dataset.src = kind === 'tile' ? A.tileUrl(id) : kind === 'decal' ? A.decalUrl(id) : A.iconUrl(id);
  img.onerror = () => { img.style.display = 'none'; };
  return img;
}
function selectedId(kind) { return S.sel[kind]; }
function selectItem(kind, id, ev) {
  if (ev && (ev.ctrlKey || ev.metaKey)) { toggleInSet(kind, id); return; }
  if (ev && ev.shiftKey) { togglePalItem(kind, id); return; }
  S.sel[kind] = id;
  if (kind === 'tile') S.tileOpts.rm = 0;
  savePrefs();
  const tool = kind === 'tile' ? 'tile' : kind === 'decal' ? 'decal' : 'entity';
  if (!['fill', 'random', 'select', 'wand'].includes(S.tool) || kind !== S.palKind) setTool(tool);
  S.palKind = kind;
  markSelected(kind, id);
  showInfo(kind, id);
  renderToolOptions();
  if (S.palView === 'custom') renderCustomBar();
}
function markSelected(kind, id) {
  for (const el of document.querySelectorAll('.pi')) el.classList.toggle('sel', el.dataset.id === id && el.dataset.kind === kind);
}
function showInfo(kind, id) {
  const p = kind === 'tile' ? P.tiles.get(id) : kind === 'decal' ? P.decals.get(id) : P.ents.get(id);
  if (!p) { $('palInfo').textContent = ''; return; }
  let extra = '';
  if (kind === 'entity') extra = ` · ${p.cat}${p.price ? ' · ' + p.price + '$' : ''}${p.sm ? ' · smooth:' + p.sm.key : ''}${p.cable ? ' · ' + p.cable : ''}${p.pipe !== undefined ? ' · труба' : ''}`;
  if (kind === 'tile') extra = ` · вариантов ${p.variants}${p.subfloor ? ' · подпол' : ''}`;
  const pal = PL.activePalette();
  const inPal = PL.hasItem(pal, kind, id);
  $('palInfo').innerHTML = '';
  $('palInfo').append(h('button', { style: 'float:right;padding:0 5px', title: pal ? `${inPal ? 'Убрать из' : 'Добавить в'} палитру «${pal.name}» (Shift+клик)` : 'Создать свою палитру с этим элементом (Shift+клик)',
    onclick: () => togglePalItem(kind, id) }, inPal ? '★' : '☆'), h('b', {}, id), h('br'), displayName(kind, id) + extra);
}
function palItem(kind, p, small) {
  const set = O.activeSet();
  const inset = set && set.kind === kind && set.items.some(i => i.id === p.id);
  const inpal = PL.hasItem(PL.activePalette(), kind, p.id);
  const el = h('div', { class: 'pi' + (selectedId(kind) === p.id ? ' sel' : '') + (inset ? ' inset' : '') + (inpal ? ' inpal' : ''), title: displayName(kind, p.id) + '\n' + p.id + '\nCtrl+клик — в набор рандома\nShift+клик — в свою палитру', onclick: ev => selectItem(kind, p.id, ev) },
    itemImg(kind, p.id), small ? null : h('div', { class: 'lbl' }, p.id));
  el.dataset.id = p.id;
  el.dataset.kind = kind;
  return el;
}
export function renderPalette() {
  if (S.palView === 'custom') { renderCustomPalette(); return; }
  const kind = S.palKind;
  const grid = $('palGrid');
  grid.innerHTML = '';
  const q = $('palSearch').value, cat = $('palCat').value, showHidden = $('palHidden').checked;
  const list = search(kind, q, { cat, hidden: showHidden });
  const hiddenCount = showHidden ? 0 : search(kind, q, { cat, hidden: true }).length - list.length;
  const head = h('div', { class: 'muted', style: 'grid-column:1/-1;font-size:11px' },
    `Найдено: ${list.length}` + (hiddenCount ? ` · ещё ${hiddenCount} скрытых в игре (HideSpawnMenu) — включите «скрытые»` : ''));
  grid.append(head);
  // render in batches while scrolling, so all results are reachable without freezing the page
  let pos = 0;
  const BATCH = 240;
  const more = () => {
    const end = Math.min(list.length, pos + BATCH);
    const frag = document.createDocumentFragment();
    for (; pos < end; pos++) {
      const el = palItem(kind, list[pos]);
      frag.append(el);
      palObserver.observe(el.querySelector('img'));
    }
    grid.append(frag);
  };
  grid.onscroll = () => {
    if (pos < list.length && grid.scrollTop + grid.clientHeight > grid.scrollHeight - 600) more();
  };
  more();
  if (!list.length) grid.append(h('div', { class: 'muted', style: 'grid-column:1/-1' }, 'Ничего не найдено'));
  if (selectedId(kind)) showInfo(kind, selectedId(kind));
}

function renderRecent() {
  const box = $('palRecent');
  box.innerHTML = '';
  if (S.palView === 'custom') return;
  for (const id of S.recent[S.palKind] || []) {
    const m = S.palKind === 'tile' ? P.tiles : S.palKind === 'decal' ? P.decals : P.ents;
    const p = m.get(id);
    if (!p) continue;
    const el = palItem(S.palKind, p, true);
    const img = el.querySelector('img');
    img.src = img.dataset.src;
    box.append(el);
  }
}
// ---------------------------------------------------------------- custom palettes
const PAL_KIND_NAMES = { tile: 'Тайлы', entity: 'Прототипы', decal: 'Декали' };
const protoMap = kind => kind === 'tile' ? P.tiles : kind === 'decal' ? P.decals : P.ents;
function persistPalette(p) {
  return PL.savePalette(p).catch(e => { toast('Палитра не сохранена: ' + e.message, 'err', 6000); });
}
async function newPalette(items = []) {
  const name = prompt('Имя палитры', PL.uniqueName('Палитра ' + (S.palettes.length + 1)));
  if (!name || !name.trim()) return null;
  const p = { file: null, name: PL.uniqueName(name.trim()), items };
  S.palettes.push(p);
  await persistPalette(p);
  PL.setActivePalette(p);
  refreshPaletteViews();
  return p;
}
function refreshPaletteViews() {
  if (S.palView === 'custom') renderCustomBar();
  renderPalette();
}
/** Shift+click: add to / remove from the active palette (creates one when there is none). */
async function togglePalItem(kind, id) {
  let p = PL.activePalette();
  if (!p) { p = await newPalette([{ kind, id }]); if (p) toast(`Палитра «${p.name}»: ${id} добавлен`, 'ok'); return; }
  const on = PL.toggleItem(p, kind, id);
  persistPalette(p);
  for (const el of document.querySelectorAll('.pi')) if (el.dataset.kind === kind && el.dataset.id === id) el.classList.toggle('inpal', on);
  if (S.palView === 'custom') refreshPaletteViews();
  if (S.sel[kind] === id) showInfo(kind, id);
  toast(`«${p.name}»: ${id} ${on ? 'добавлен' : 'убран'} (${p.items.length})`);
}
function addSelectionToPalette(p) {
  const model = M();
  const items = [];
  for (const k of S.selection) {
    const [x, y] = unkey(k);
    const t = model.getTile(x, y);
    if (t) items.push({ kind: 'tile', id: t[0] });
    for (const uid of model.entsAt(x, y)) items.push({ kind: 'entity', id: model.ents.get(uid).proto });
    for (const d of model.decalsAt(x, y)) items.push({ kind: 'decal', id: d.id });
  }
  const n = PL.addItems(p, items);
  persistPalette(p);
  refreshPaletteViews();
  toast(`Добавлено в «${p.name}»: ${n}`, 'ok');
}
async function importPalettes() {
  let n = 0;
  for (const f of await pickJsonFiles()) {
    try {
      for (const p of PL.palettesFromImport(f.data, f.name)) {
        p.name = PL.uniqueName(p.name);
        S.palettes.push(p);
        await persistPalette(p);
        PL.setActivePalette(p);
        n++;
      }
    } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
  }
  if (n) toast(`Импортировано палитр: ${n}`, 'ok');
  refreshPaletteViews();
}
function renderCustomBar() {
  const bar = $('palCustomBar');
  bar.innerHTML = '';
  const act = PL.activePalette();
  const sel = h('select', { class: 'grow', onchange: e => { PL.setActivePalette(S.palettes.find(p => p.file === e.target.value)); refreshPaletteViews(); } },
    ...S.palettes.map(p => h('option', { value: p.file, selected: p === act }, `${p.name} (${p.items.length})`)));
  if (!S.palettes.length) sel.append(h('option', { value: '' }, '— нет палитр —'));
  const cur = S.sel[S.palKind];
  bar.append(
    h('div', { class: 'row' }, sel,
      h('button', { title: 'Новая палитра', onclick: () => newPalette() }, '+'),
      h('button', { title: 'Переименовать', disabled: !act, onclick: () => {
        const n = prompt('Новое имя палитры', act.name);
        if (!n || !n.trim() || n.trim() === act.name) return;
        act.name = PL.uniqueName(n.trim(), act);
        persistPalette(act).then(refreshPaletteViews);
      } }, '✎'),
      h('button', { class: 'danger', title: 'Удалить палитру (файл в palettes/)', disabled: !act, onclick: async () => {
        if (!confirm(`Удалить палитру «${act.name}»?`)) return;
        try { await PL.deletePalette(act); } catch (e) { toast(e.message, 'err'); }
        refreshPaletteViews();
      } }, '✕')),
    h('div', { class: 'row' },
      h('button', { disabled: !act || !cur || PL.hasItem(act, S.palKind, cur), title: `Добавить текущий элемент: ${cur || '—'}`, onclick: () => togglePalItem(S.palKind, cur) }, '+ текущий'),
      h('button', { disabled: !act || !S.selection.size, title: 'Добавить тайлы, прототипы и декали из выделения на карте', onclick: () => addSelectionToPalette(act) }, '+ из выделения'),
      h('span', { class: 'sep' }),
      h('button', { disabled: !act, title: 'Скачать палитру .json в «Загрузки»', onclick: () => downloadJson(PL.paletteToFile(act), fileName(act.name)) }, '⬇'),
      h('button', { disabled: !S.palettes.length, title: 'Скачать все палитры одним файлом', onclick: () => downloadJson(PL.bundleToFile(S.palettes), fileName('palettes')) }, '⬇ все'),
      h('button', { title: 'Загрузить палитры из .json (одна палитра или файл «все»)', onclick: importPalettes }, '⬆ импорт')));
}
let palDrag = null;
function renderCustomPalette() {
  const grid = $('palGrid');
  grid.innerHTML = '';
  grid.onscroll = null;
  const act = PL.activePalette();
  const note = txt => grid.append(h('div', { class: 'muted', style: 'grid-column:1/-1' }, txt));
  if (!act) { note('Своих палитр нет. Создайте палитру кнопкой «+» или Shift+клик по элементу в каталоге (Тайлы / Прототипы / Декали).'); return; }
  const terms = $('palSearch').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const kind of ['tile', 'entity', 'decal']) {
    const items = act.items.filter(it => it.kind === kind && (!terms.length || terms.every(t => (it.id + ' ' + displayName(kind, it.id)).toLowerCase().includes(t))));
    if (!items.length) continue;
    grid.append(h('div', { class: 'pal-sec' }, `${PAL_KIND_NAMES[kind]} · ${items.length}`));
    for (const it of items) {
      const p = protoMap(kind).get(it.id);
      const el = palItem(kind, p || { id: it.id }, false);
      if (!p) { el.classList.add('missing'); el.title = `${it.id}\nНет в репозитории`; }
      const img = el.querySelector('img');
      img.src = img.dataset.src;
      el.draggable = true;
      el.addEventListener('contextmenu', ev => { ev.preventDefault(); togglePalItem(kind, it.id); });
      el.addEventListener('dragstart', () => { palDrag = it; });
      el.addEventListener('dragover', ev => { if (palDrag && palDrag.kind === kind) { ev.preventDefault(); el.classList.add('drop'); } });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', ev => {
        ev.preventDefault();
        if (!palDrag || palDrag === it) return;
        act.items.splice(act.items.indexOf(palDrag), 1);
        act.items.splice(act.items.indexOf(it), 0, palDrag);
        palDrag = null;
        persistPalette(act);
        renderCustomPalette();
      });
      grid.append(el);
      shown++;
    }
  }
  if (!shown) note(act.items.length ? 'Ничего не найдено' : 'Палитра пуста. Shift+клик по элементу в каталоге добавляет его сюда, «+ из выделения» — всё из выделенной области карты.');
  else grid.append(h('div', { class: 'muted', style: 'grid-column:1/-1;font-size:11px' }, 'Клик — выбрать, ПКМ — убрать из палитры, перетаскивание — порядок.'));
  const cur = S.sel[S.palKind];
  if (cur) showInfo(S.palKind, cur);
}

function toggleInSet(kind, id) {
  let set = O.activeSet();
  if (!set || set.kind !== kind) {
    set = { name: `${({ tile: 'Тайлы', entity: 'Прототипы', decal: 'Декали' })[kind]} ${S.random.sets.length + 1}`, kind, items: [], randRot: kind !== 'tile', jitter: false, color: '#FFFFFFFF' };
    S.random.sets.push(set);
    S.random.active = S.random.sets.length - 1;
  }
  const i = set.items.findIndex(x => x.id === id);
  if (i >= 0) set.items.splice(i, 1); else set.items.push({ id, w: 1 });
  savePrefs();
  renderPalette();
  renderRandom();
  toast(`Набор «${set.name}»: ${set.items.length} элементов`);
}

// ===================================================================== side tabs
export function buildTabs() {
  $('sideTabs').querySelectorAll('button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  on('tab', showTab);
  on('stackMenu', stackMenu);
  on('portsDialog', portsDialog);
  on('link', () => { renderToolOptions(); if (S.inspected && $('tab-inspector').classList.contains('on')) renderInspector(); });
  on('inspect', () => { if (S.inspected) showTab('inspector'); else renderInspector(); });
}
export function showTab(t) {
  $('sideTabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('on', s.id === 'tab-' + t));
  ({ inspector: renderInspector, layers: renderLayers, random: renderRandom, prefabs: renderPrefabs, stats: renderStats })[t]?.();
}

// ===================================================================== inspector
function entRow(e, { current = false, extra = [], onclick } = {}) {
  const p = protoOf(e.proto);
  return h('div', { class: 'li', style: current ? 'background:#1f3350' : '', onclick },
    h('span', { style: 'display:flex;gap:6px;align-items:center;min-width:0' },
      h('img', { src: A.iconUrl(e.proto), style: 'width:22px;height:22px;image-rendering:pixelated;flex:none', onerror: ev => { ev.target.style.visibility = 'hidden'; } }),
      h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, h('b', {}, e.proto), ' ', h('span', { class: 'muted' }, p ? (p.ru || p.name || '') : 'неизвестен'))),
    h('span', { style: 'display:flex;gap:4px;align-items:center;flex:none' }, h('span', { class: 'muted' }, e.uid), ...extra));
}
const comp = (e, type) => (e.comps || []).find(c => c.type === type);
const goTo = uid => { S.inspected = uid; renderInspector(); requestDraw(); };
const xBtn = (title, fn) => h('button', { style: 'padding:0 4px', title, onclick: ev => { ev.stopPropagation(); fn(); } }, '✕');

export async function renderInspector() {
  const box = $('tab-inspector');
  box.innerHTML = '';
  const model = M();
  if (!model) return;
  const uid = S.inspected;
  const e = uid && model.ents.get(uid);
  if (!e) {
    box.append(h('p', { class: 'muted' }, 'Выберите сущность инструментом «Инспектор» (V). Если в тайле несколько сущностей, появится список; ПКМ инспектором всегда показывает список.'));
    if (S.hoverTile) tileInfo(box, ...S.hoverTile);
    return;
  }
  const p = protoOf(e.proto);
  const [tx, ty] = tileOf(e.x, e.y);
  // every entity on this tile, top-most first
  const stack = model.entsAt(tx, ty).map(u => model.ents.get(u)).sort((a, b) => (protoOf(b.proto)?.dd ?? 0) - (protoOf(a.proto)?.dd ?? 0));
  box.append(h('h4', {}, `В тайле (${tx}, ${ty}): ${stack.length}`));
  const sl = h('div', { class: 'list', style: 'max-height:150px' });
  for (const o of stack) {
    sl.append(entRow(o, { current: o.uid === uid, onclick: () => goTo(o.uid),
      extra: [xBtn('Удалить', () => { model.begin('Удаление'); model.removeEnt(o.uid); model.commit(); if (o.uid === uid) S.inspected = null; renderInspector(); })] }));
  }
  box.append(sl);

  const posX = h('input', { type: 'number', step: '0.03125', value: e.x, style: 'width:90px' });
  const posY = h('input', { type: 'number', step: '0.03125', value: e.y, style: 'width:90px' });
  const rotIn = h('input', { type: 'number', step: '90', value: Math.round((e.rot || 0) * 180 / Math.PI * 1000) / 1000, style: 'width:80px' });
  const ta = h('textarea', { rows: 12 });
  box.append(
    h('table', { class: 'kv' },
      h('tr', {}, h('td', {}, 'Прототип'), h('td', {}, h('b', {}, e.proto), h('br'), p ? displayName('entity', e.proto) : h('span', { style: 'color:var(--bad)' }, 'неизвестен'))),
      h('tr', {}, h('td', {}, 'UID'), h('td', {}, e.uid)),
      h('tr', {}, h('td', {}, 'Позиция'), h('td', {}, posX, ' ', posY, ' ', h('button', { title: 'В центр тайла', onclick: () => { posX.value = tx + 0.5; posY.value = ty + 0.5; apply(); } }, '⌖'))),
      h('tr', {}, h('td', {}, 'Поворот, °'), h('td', {}, rotIn)),
      p && p.pipe !== undefined ? h('tr', {}, h('td', {}, 'Труба'), h('td', {}, `${pipeLayerOf(e)} · ${pipeColorOf(e) || '—'}`)) : null,
      p ? h('tr', {}, h('td', {}, 'Слой отрисовки'), h('td', {}, String(p.dd))) : null),
    h('div', { class: 'row' },
      h('button', { onclick: apply }, 'Применить'),
      h('button', { onclick: () => { S.sel.entity = e.proto; S.rotSteps = rotSteps(e.rot); setTool('entity'); setPalKind('entity', true); } }, 'Взять в кисть'),
      h('button', { onclick: () => { centerOn(e.x, e.y); } }, 'Показать'),
      h('button', { class: 'danger', onclick: () => { model.begin('Удаление'); model.removeEnt(uid); model.commit(); S.inspected = null; renderInspector(); } }, 'Удалить')));
  TX.metaSection(box, uid);
  linksSection(box, e);
  containersSection(box, e);
  box.append(h('h4', {}, 'Компоненты (YAML, без Transform)'), ta, h('div', { class: 'row' }, h('button', { onclick: apply }, 'Применить YAML')));
  try {
    const r = await api.post('/api/yaml/dump', { obj: e.comps.length ? e.comps : [] });
    ta.value = e.comps.length ? r.text : '';
  } catch (err) { ta.value = '# ' + err.message; }
  async function apply() {
    try {
      let comps = [];
      if (ta.value.trim()) {
        const r = await api.post('/api/yaml/load', { text: ta.value });
        comps = r.obj || [];
        if (!Array.isArray(comps)) throw new Error('ожидается список компонентов');
      }
      model.begin('Правка сущности');
      model.updateEnt(uid, { x: +posX.value, y: +posY.value, rot: normAngle((+rotIn.value) * Math.PI / 180), comps });
      model.commit();
      toast('Применено', 'ok');
      renderInspector();
    } catch (err) { toast('Ошибка YAML: ' + err.message, 'err'); }
  }
}

// ---------------------------------------------------------------- links in inspector
function linksSection(box, e) {
  const model = M();
  const parts = [];
  if (L.canHoldList(e)) {
    const devs = L.listDevices(e);
    const l = h('div', { class: 'list', style: 'max-height:180px' });
    for (const d of devs) {
      const de = model.ents.get(d);
      if (!de) { l.append(h('div', { class: 'li muted' }, `${d} — нет на карте (уберётся при сохранении)`)); continue; }
      l.append(entRow(de, { onclick: () => goTo(d),
        extra: [xBtn('Убрать из сети', () => { model.begin('Сеть устройств'); L.setListMember(e.uid, d, false); model.commit(); renderInspector(); requestDraw(); })] }));
    }
    if (!devs.length) l.append(h('div', { class: 'li muted' }, 'Нет подключённых устройств'));
    parts.push(h('h4', {}, `Сеть устройств (DeviceList): ${devs.length}`), l,
      h('div', { class: 'row' },
        h('button', { onclick: () => { TL.link.mode = 'list'; TL.link.holder = e.uid; setTool('link'); } }, '🔗 Добавлять кликами'),
        h('button', {
          title: 'Добавить все подходящие устройства комнаты перед сигнализацией (вентиляции, скрубберы, датчики, пожарные шлюзы в проёмах)',
          onclick: () => { const r = L.autoLinkRoom(e.uid); toast(`Комната: ${r.room.size} тайлов, добавлено устройств: ${r.added}`, 'ok'); renderInspector(); requestDraw(); },
        }, '⚙ Автосвязь комнаты'),
        devs.length ? h('button', { class: 'danger', onclick: () => { model.begin('Очистить сеть'); for (const d of devs) L.setListMember(e.uid, d, false); model.commit(); renderInspector(); requestDraw(); } }, 'Очистить') : null));
  }
  const lists = L.memberOf(e).filter(u => model.ents.has(u));
  if (lists.length) {
    parts.push(h('h4', {}, 'Входит в сети'), h('div', { class: 'list' }, ...lists.map(u => entRow(model.ents.get(u), { onclick: () => goTo(u),
      extra: [xBtn('Отключить', () => { model.begin('Сеть устройств'); L.setListMember(u, e.uid, false); model.commit(); renderInspector(); requestDraw(); })] }))));
  }
  if (L.sourcePorts(e).length) {
    const lp = L.linkedPorts(e);
    const l = h('div', { class: 'list', style: 'max-height:180px' });
    for (const [sink, pairs] of Object.entries(lp)) {
      const se = model.ents.get(sink);
      if (!se) continue;
      l.append(entRow(se, { onclick: () => goTo(sink),
        extra: [h('span', { class: 'muted', style: 'font-size:11px' }, (pairs || []).map(x => `${x[0]}→${x[1]}`).join(', ')),
          h('button', { style: 'padding:0 4px', title: 'Порты', onclick: ev => { ev.stopPropagation(); portsDialog({ src: e.uid, sink }); } }, '✎'),
          xBtn('Разорвать', () => { L.setPairs(e.uid, sink, []); renderInspector(); requestDraw(); })] }));
    }
    if (!Object.keys(lp).length) l.append(h('div', { class: 'li muted' }, 'Нет связей'));
    parts.push(h('h4', {}, `Исходящие сигналы (${L.sourcePorts(e).join(', ')})`), l,
      h('div', { class: 'row' }, h('button', { onclick: () => { TL.link.mode = 'signal'; TL.link.holder = e.uid; setTool('link'); } }, '🔗 Связать кликами')));
  }
  if (L.sinkPorts(e).length) {
    const inc = [...model.ents.values()].filter(o => L.linkedPorts(o)[e.uid]);
    parts.push(h('h4', {}, `Входящие сигналы (${L.sinkPorts(e).join(', ')})`),
      h('div', { class: 'list' }, ...(inc.length ? inc.map(o => entRow(o, { onclick: () => goTo(o.uid),
        extra: [h('span', { class: 'muted', style: 'font-size:11px' }, L.pairsBetween(o, e.uid).map(x => `${x[0]}→${x[1]}`).join(', '))] }))
        : [h('div', { class: 'li muted' }, 'Нет')])));
  }
  box.append(...parts);
}

// ---------------------------------------------------------------- containers
function containersOf(e) {
  const cc = comp(e, 'ContainerContainer');
  if (!cc || !cc.containers) return [];
  return Object.entries(cc.containers).map(([name, v]) => {
    const tag = v && v.$tag ? v.$tag : '!type:Container';
    const body = v && v.$v ? v.$v : (v || {});
    const slot = /ContainerSlot/.test(tag);
    const ents = slot ? (body.ent && body.ent !== 'null' ? [String(body.ent)] : []) : (body.ents || []).map(String);
    return { name, tag, body, slot, ents };
  });
}
function updateContainer(holderUid, name, fn) {
  const model = M();
  const e = model.ents.get(holderUid);
  const comps = (e.comps || []).map(c => ({ ...c }));
  let cc = comps.find(c => c.type === 'ContainerContainer');
  if (!cc) { cc = { type: 'ContainerContainer', containers: {} }; comps.push(cc); }
  cc.containers = { ...(cc.containers || {}) };
  const cur = cc.containers[name] || { $tag: '!type:Container', $v: { showEnts: 'False', occludes: 'True', ents: [] } };
  const next = fn(structuredClone(cur));
  if (next === null) delete cc.containers[name]; else cc.containers[name] = next;
  model.updateEnt(holderUid, { comps });
}
function removeContained(uid) {
  const model = M();
  for (const d of model.descendants(uid)) model.removeOther(d);
  model.removeOther(uid);
}
export function addToContainer(holderUid, name, proto, count = 1) {
  const model = M();
  const c = containersOf(model.ents.get(holderUid)).find(x => x.name === name);
  model.begin('Содержимое контейнера');
  const added = [];
  const n = c && c.slot ? 1 : count;
  if (c && c.slot) for (const old of c.ents) removeContained(old);
  for (let i = 0; i < n; i++) {
    const uid = model.newUid();
    model.addOther({ uid, proto, components: [{ type: 'Transform', parent: holderUid }] });
    added.push(uid);
  }
  updateContainer(holderUid, name, v => {
    if (/ContainerSlot/.test(v.$tag)) v.$v.ent = added[0];
    else v.$v.ents = [...(v.$v.ents || []).map(String), ...added];
    return v;
  });
  model.commit();
  return added;
}
export function removeFromContainer(holderUid, name, uid) {
  const model = M();
  model.begin('Содержимое контейнера');
  removeContained(uid);
  updateContainer(holderUid, name, v => {
    if (/ContainerSlot/.test(v.$tag)) v.$v.ent = 'null';
    else v.$v.ents = (v.$v.ents || []).map(String).filter(x => x !== uid);
    return v;
  });
  model.commit();
}
function protoInput() {
  const id = 'pl' + Math.random().toString(36).slice(2, 8);
  const dl = h('datalist', { id });
  const inp = h('input', { class: 'grow', list: id, placeholder: 'прототип (поиск по id / названию)' });
  inp.oninput = () => {
    dl.innerHTML = '';
    if (inp.value.length < 2) return;
    for (const p of search('entity', inp.value, { hidden: true, limit: 40 })) dl.append(h('option', { value: p.id }, displayName('entity', p.id)));
  };
  return [inp, dl];
}
function containersSection(box, e) {
  const model = M();
  const p = protoOf(e.proto);
  const conts = containersOf(e);
  const sec = h('div', {});
  sec.append(h('h4', {}, `Содержимое контейнеров (${model.descendants(e.uid).length})`));
  for (const c of conts) {
    const l = h('div', { class: 'list', style: 'max-height:200px' });
    for (const u of c.ents) {
      const o = model.others.get(u);
      if (!o) { l.append(h('div', { class: 'li muted' }, `${u} — нет сущности`)); continue; }
      const nested = model.descendants(u).length;
      l.append(entRow({ uid: u, proto: o.proto }, {
        extra: [nested ? h('span', { class: 'muted', title: 'вложенных сущностей' }, `+${nested}`) : null,
          TX.metaOf(u).name ? h('span', { class: 'muted', title: 'Своё название (MetaData)' }, '«' + TX.metaOf(u).name + '»') : null,
          TX.isPaper(o.proto) ? h('button', { style: 'padding:0 4px', title: 'Текст и печати бумаги', onclick: ev => { ev.stopPropagation(); TX.paperDialog(u); } }, '📝') : null,
          h('button', { style: 'padding:0 4px', title: 'Название и описание (F2)', onclick: ev => { ev.stopPropagation(); TX.namesDialog(u); } }, 'Aa'),
          h('button', { style: 'padding:0 4px', title: 'Компоненты (YAML)', onclick: () => editOtherDialog(u) }, '✎'),
          xBtn('Удалить', () => { removeFromContainer(e.uid, c.name, u); renderInspector(); })] }));
    }
    if (!c.ents.length) l.append(h('div', { class: 'li muted' }, 'пусто'));
    const [inp, dl] = protoInput();
    const cnt = h('input', { type: 'number', min: 1, max: 50, value: 1, style: 'width:50px', disabled: c.slot });
    sec.append(
      h('div', { class: 'row', style: 'justify-content:space-between' },
        h('b', {}, c.name), h('span', { class: 'muted' }, c.tag.replace('!type:', '')),
        h('button', { class: 'danger', style: 'padding:0 4px', title: 'Удалить контейнер со всем содержимым', onclick: () => {
          if (!confirm(`Удалить контейнер ${c.name} и ${c.ents.length} предметов?`)) return;
          model.begin('Удалить контейнер'); for (const u of c.ents) removeContained(u); updateContainer(e.uid, c.name, () => null); model.commit(); renderInspector();
        } }, '✕')),
      l,
      h('div', { class: 'row' }, inp, dl, cnt, h('button', { onclick: () => {
        const id = inp.value.trim();
        if (!P.ents.has(id)) { toast('Неизвестный прототип: ' + id, 'err'); return; }
        addToContainer(e.uid, c.name, id, Math.max(1, Math.min(50, +cnt.value || 1)));
        renderInspector();
      } }, c.slot ? 'Поставить' : '+ Добавить')));
    if (c.name === 'storagebase') sec.append(h('div', { class: 'muted', style: 'font-size:11px' }, 'Хранилище с сеткой (Storage): позиции предметов в сетке назначит игра при загрузке.'));
  }
  const known = [];
  if (hasComp(p, 'EntityStorage') && !conts.some(c => c.name === 'entity_storage')) known.push(['entity_storage', '!type:Container']);
  if (hasComp(p, 'Storage') && !conts.some(c => c.name === 'storagebase')) known.push(['storagebase', '!type:Container']);
  const nameIn = h('input', { class: 'grow', placeholder: 'имя нового контейнера' });
  const typeSel = h('select', {}, h('option', { value: '!type:Container' }, 'Container'), h('option', { value: '!type:ContainerSlot' }, 'ContainerSlot'));
  const create = (name, tag) => {
    if (!name) return;
    model.begin('Новый контейнер');
    updateContainer(e.uid, name, () => ({ $tag: tag, $v: /Slot/.test(tag) ? { showEnts: 'False', occludes: 'True', ent: 'null' } : { showEnts: 'False', occludes: 'True', ents: [] } }));
    model.commit(); renderInspector();
  };
  if (known.length) sec.append(h('div', { class: 'row' }, ...known.map(([n, t]) => h('button', { onclick: () => create(n, t) }, '+ ' + n))));
  sec.append(h('div', { class: 'row' }, nameIn, typeSel, h('button', { onclick: () => create(nameIn.value.trim(), typeSel.value) }, '+ контейнер')));
  if (!conts.length && !known.length) sec.append(h('div', { class: 'muted', style: 'font-size:11px' }, 'У прототипа нет известного хранилища. Имя контейнера должно совпадать с тем, что ожидает компонент (entity_storage, storagebase, id слота ItemSlots…).'));
  box.append(sec);
}
function editOtherDialog(uid) {
  const model = M();
  const o = model.others.get(uid);
  const ta = h('textarea', { rows: 18 });
  const body = h('div', {}, h('p', { class: 'muted' }, `${o.proto} · uid ${uid}. Transform (parent) менять не нужно.`), ta,
    h('div', { class: 'row' }, h('button', { class: 'on', onclick: async () => {
      try {
        const r = await api.post('/api/yaml/load', { text: ta.value });
        if (!Array.isArray(r.obj)) throw new Error('ожидается список компонентов');
        model.begin('Правка вложенной сущности');
        model.removeOther(uid);
        model.addOther({ ...o, components: r.obj });
        model.commit();
        closeModal(); renderInspector();
      } catch (err) { toast('Ошибка YAML: ' + err.message, 'err'); }
    } }, 'Применить')));
  modal('Вложенная сущность', body);
  api.post('/api/yaml/dump', { obj: o.components }).then(r => { ta.value = r.text; });
}

// ---------------------------------------------------------------- stack picker / ports dialog
export function stackMenu({ ev, ents, onPick }) {
  document.getElementById('stackMenu')?.remove();
  if (!ents || !ents.length) return;
  const menu = h('div', { id: 'stackMenu', class: 'stack-menu', style: `left:${ev.clientX + 6}px;top:${ev.clientY + 6}px` });
  menu.append(h('div', { class: 'muted', style: 'padding:3px 8px;font-size:11px' }, `Сущностей: ${ents.length} — выберите`));
  const close = () => { menu.remove(); S.highlight = null; requestDraw(); window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', esc, true); };
  for (const e of ents) {
    const row = entRow(e, { current: e.uid === S.inspected, onclick: () => { close(); onPick(e); } });
    row.onmouseenter = () => { S.highlight = new Set([e.uid]); requestDraw(); };
    menu.append(row);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (r.bottom > innerHeight) menu.style.top = Math.max(4, innerHeight - r.height - 4) + 'px';
  if (r.right > innerWidth) menu.style.left = Math.max(4, innerWidth - r.width - 4) + 'px';
  const outside = e2 => { if (!menu.contains(e2.target)) close(); };
  const esc = e2 => { if (e2.key === 'Escape') { e2.stopPropagation(); close(); } };
  setTimeout(() => { window.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', esc, true); }, 0);
}

export function portsDialog({ src, sink }) {
  const model = M();
  const se = model.ents.get(src), ke = model.ents.get(sink);
  const sp = L.sourcePorts(se), kp = L.sinkPorts(ke);
  let pairs = L.pairsBetween(se, sink);
  const existed = pairs.length > 0;
  const has = (a, b) => pairs.some(p => p[0] === a && p[1] === b);
  const table = h('table', { class: 'kv' });
  const render = () => {
    table.innerHTML = '';
    table.append(h('tr', {}, h('td', {}, 'Источник ↓ / Приёмник →'), ...kp.map(k => h('td', { style: 'font-size:11px;text-align:center', title: k }, P.sinkPorts.get(k)?.name || k))));
    for (const a of sp) {
      table.append(h('tr', {}, h('td', { title: a }, P.srcPorts.get(a)?.name || a), ...kp.map(b => h('td', { style: 'text-align:center' },
        h('input', { type: 'checkbox', checked: has(a, b), onchange: ev => { pairs = pairs.filter(p => !(p[0] === a && p[1] === b)); if (ev.target.checked) pairs.push([a, b]); } })))));
    }
  };
  if (!existed) pairs = L.defaultPairs(se, ke);
  render();
  const body = h('div', {},
    h('p', {}, h('b', {}, se.proto), ` (${src}) → `, h('b', {}, ke.proto), ` (${sink})`),
    existed ? null : h('p', { class: 'muted' }, 'Отмечены пары по умолчанию (defaultLinks портов).'),
    table,
    h('div', { class: 'row' },
      h('button', { onclick: () => { pairs = L.defaultPairs(se, ke); render(); } }, 'По умолчанию'),
      h('button', { onclick: () => { pairs = []; render(); } }, 'Очистить'),
      h('button', { class: 'on', onclick: () => {
        L.setPairs(src, sink, pairs);
        closeModal();
        toast(pairs.length ? `Связано: ${pairs.map(p => p.join('→')).join(', ')}` : 'Связь удалена', 'ok');
        emit('link'); requestDraw();
        if (S.inspected) renderInspector();
      } }, 'Применить')));
  modal('Порты сигналов', body);
}

function tileInfo(box, x, y) {
  const model = M();
  const t = model.getTile(x, y);
  box.append(h('h4', {}, `Тайл (${x}, ${y})`));
  box.append(h('div', {}, t ? `${t[0]} · вариант ${t[2]}${t[3] ? ' · rot ' + t[3] : ''}` : 'Space'));
  const ents = model.entsAt(x, y).map(u => model.ents.get(u));
  if (ents.length) {
    box.append(h('h4', {}, 'Сущности'));
    const list = h('div', { class: 'list' });
    for (const e of ents) list.append(entRow(e, { onclick: () => { S.inspected = e.uid; emit('inspect'); requestDraw(); } }));
    box.append(list);
  }
  const decs = model.decalsAt(x, y);
  if (decs.length) box.append(h('h4', {}, 'Декали'), h('div', {}, decs.map(d => d.id + ' ' + (d.color || '')).join(', ')));
}

// ===================================================================== layers
const LAYER_NAMES = {
  tiles: 'Тайлы', decals: 'Декали', walls: 'Стены и окна', objects: 'Объекты', subfloor: 'Подпол (прочее)',
  pipes: 'Трубы', disposal: 'Утилизационные трубы', wires: 'Кабели', markers: 'Маркеры / спавны', grid: 'Сетка', chunks: 'Границы чанков (16×16)',
  leaks: 'Утечки атмосферы', openEnds: 'Открытые концы труб (атмос, утилизация)', placeholders: 'Заглушки без спрайта',
  links: 'Связи устройств (сети и сигналы)', realSubfloor: 'Подпол как в игре (скрыт под полом, виден на решётках)',
};
export function renderLayers() {
  const box = $('tab-layers');
  box.innerHTML = '';
  box.append(h('h4', {}, 'Видимость'));
  for (const k of Object.keys(LAYER_NAMES)) {
    box.append(h('div', {}, chk(LAYER_NAMES[k], S.layers, k, () => { if (k === 'leaks' && S.layers.leaks) refreshLeaks(); })));
  }
  box.append(h('h4', {}, 'Слои труб'));
  for (const k of ['Primary', 'Secondary', 'Tertiary']) box.append(h('div', {}, chk(k, S.pipeLayers, k)));
  box.append(h('h4', {}, 'Вид'));
  box.append(h('div', { class: 'row' }, h('button', { onclick: fitToContent }, 'Показать всё (Home)'), h('button', { onclick: () => centerOn(0.5, 0.5) }, 'К началу координат')));
  box.append(h('h4', {}, 'Направляющие'));
  const gl = h('div', {});
  for (const [i, g] of S.guides.entries()) gl.append(h('div', { class: 'row' }, `${g.axis === 'x' ? 'Вертикаль x' : 'Горизонталь y'} = ${g.v}`, h('button', { onclick: () => { S.guides.splice(i, 1); renderLayers(); requestDraw(); } }, '✕')));
  if (!S.guides.length) gl.append(h('div', { class: 'muted' }, 'Тяните с линейки на холст, чтобы создать направляющую.'));
  else gl.append(h('button', { onclick: () => { S.guides.length = 0; renderLayers(); requestDraw(); } }, 'Удалить все направляющие'));
  gl.append(h('div', { class: 'muted' }, 'Голубая линия — направляющая: тащите её мышью, ПКМ по ней или перенос на линейку — удалить, клик по ⌗ в углу — удалить все. Фиолетовый пунктир — ось зеркала (кнопки ⇋ X / ⇵ Y): её двигают за фиолетовый маркер на линейке.'));
  box.append(gl);
}
export function refreshLeaks() { if (M()) { S.leaks = leakTiles(M()); requestDraw(); } }

// ===================================================================== random sets
export function renderRandom() {
  const box = $('tab-random');
  box.innerHTML = '';
  const R = S.random;
  box.append(h('div', { class: 'row' },
    h('label', {}, 'Сид', h('input', { type: 'number', value: R.seed, onchange: e => { R.seed = +e.target.value | 0; savePrefs(); } })),
    chk('фикс. сид', R, 'fixedSeed'),
    h('label', {}, 'Плотность', h('input', { type: 'number', min: 1, max: 100, value: R.density, onchange: e => { R.density = Math.max(1, Math.min(100, +e.target.value)); savePrefs(); } }), '%')));
  box.append(h('div', { class: 'row' },
    h('button', { onclick: () => newSet('tile') }, '+ тайлы'), h('button', { onclick: () => newSet('entity') }, '+ прототипы'), h('button', { onclick: () => newSet('decal') }, '+ декали'),
    h('button', { onclick: addPresets, title: 'Создать готовые наборы из прототипов репозитория' }, 'Встроенные')));
  box.append(h('div', { class: 'row' },
    h('button', { disabled: !R.sets.length, title: 'Скачать все наборы одним пресетом .json в «Загрузки»', onclick: () => downloadJson(randomToFile('Наборы', R.sets), fileName('random-sets')) }, '⬇ В загрузки'),
    h('button', { title: 'Добавить наборы из .json файла', onclick: async () => { for (const f of await pickJsonFiles()) addRandomSets(f.data); } }, '⬆ Из файла'),
    h('button', { disabled: !R.sets.length, title: 'Сохранить все наборы в папку presets/random/ маппера', onclick: () => { const n = prompt('Имя пресета', 'Наборы'); if (n) saveToCatalog('random', n, randomToFile(n, R.sets)); } }, '💾 В каталог'),
    h('button', { title: 'Пресеты из папки presets/random/ маппера', onclick: randomCatalogDialog }, '📂 Каталог')));
  box.append(h('p', { class: 'muted' }, 'Ctrl+клик в палитре добавляет элемент в активный набор. Кисть 🎲 (N) рисует набором, в выделении — «Рассыпать». Загруженные пресеты добавляются к текущим наборам.'));
  R.sets.forEach((set, i) => {
    const items = h('div', { class: 'items' });
    for (const it of set.items) {
      const img = h('img', { src: set.kind === 'tile' ? A.tileUrl(it.id) : set.kind === 'decal' ? A.decalUrl(it.id) : A.iconUrl(it.id), title: it.id });
      items.append(h('span', { class: 'it' }, img,
        h('input', { type: 'number', min: 0, step: 1, value: it.w, title: 'вес', onchange: e => { it.w = Math.max(0, +e.target.value); savePrefs(); } }),
        h('button', { style: 'padding:0 3px', onclick: () => { set.items.splice(set.items.indexOf(it), 1); savePrefs(); renderRandom(); } }, '✕')));
    }
    box.append(h('div', { class: 'set' + (i === R.active ? ' on' : '') },
      h('div', { class: 'row' },
        h('input', { type: 'radio', name: 'rset', checked: i === R.active, onchange: () => { R.active = i; renderRandom(); renderToolOptions(); } }),
        h('input', { class: 'grow', value: set.name, onchange: e => { set.name = e.target.value; savePrefs(); } }),
        h('span', { class: 'muted' }, ({ tile: 'тайлы', entity: 'прото', decal: 'декали' })[set.kind]),
        h('button', { title: 'Скачать этот набор .json в «Загрузки»', onclick: () => downloadJson(randomToFile(set.name, [set]), fileName(set.name)) }, '⬇'),
        h('button', { class: 'danger', onclick: () => { R.sets.splice(i, 1); R.active = 0; savePrefs(); renderRandom(); } }, '✕')),
      h('div', { class: 'row' },
        set.kind !== 'tile' ? chk('случ. поворот', set, 'randRot') : null,
        set.kind !== 'tile' ? chk('смещение', set, 'jitter') : null,
        set.kind === 'decal' ? h('input', { type: 'color', value: (set.color || '#FFFFFF').slice(0, 7), onchange: e => { set.color = e.target.value.toUpperCase() + 'FF'; savePrefs(); } }) : null),
      items));
  });
}
function addRandomSets(data) {
  try {
    const sets = randomFromFile(data);
    if (!sets.length) { toast('В пресете нет наборов', 'err'); return; }
    S.random.sets.push(...sets);
    S.random.active = S.random.sets.length - sets.length;
    savePrefs(); renderRandom(); renderToolOptions();
    toast(`Добавлено наборов: ${sets.length}`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}
function randomCatalogDialog() {
  modal('Пресеты рандома (presets/random/)', h('div', {},
    h('p', { class: 'muted' }, 'Наборы из пресета добавляются к текущим.'),
    catalogList('random', d => `${((d && d.sets) || []).length} наборов`, d => { addRandomSets(d); closeModal(); })));
}
function newSet(kind) {
  S.random.sets.push({ name: `Набор ${S.random.sets.length + 1}`, kind, items: [], randRot: kind !== 'tile', jitter: false, color: '#FFFFFFFF' });
  S.random.active = S.random.sets.length - 1;
  savePrefs(); renderRandom();
}
function addPresets() {
  const mk = (name, kind, re, opts = {}) => {
    const m = kind === 'tile' ? P.tiles : kind === 'decal' ? P.decals : P.ents;
    const items = [...m.values()].filter(p => re.test(p.id) && !p.hidden).slice(0, 40).map(p => ({ id: p.id, w: 1 }));
    if (items.length) S.random.sets.push({ name, kind, items, randRot: false, jitter: false, color: '#FFFFFFFF', ...opts });
  };
  mk('Растения в горшках', 'entity', /^PottedPlant\d+$/);
  mk('Мусор', 'entity', /^Trash[A-Z]/, { jitter: true });
  mk('Грязь (декали)', 'decal', /^Dirt/, { randRot: true, color: '#FFFFFF7F' });
  mk('Обломки/пятна (декали)', 'decal', /^(Rust|Damaged|burnt)/i, { randRot: true });
  mk('Плитка стали', 'tile', /^FloorSteel(Dirty)?$/);
  mk('Решётки техпола', 'tile', /^FloorTechMaint\d?$/);
  savePrefs(); renderRandom(); toast('Пресеты добавлены', 'ok');
}

// ===================================================================== prefabs
export async function renderPrefabs() {
  const box = $('tab-prefabs');
  box.innerHTML = '';
  box.append(h('div', { class: 'row' }, h('button', { onclick: () => selAction('prefab'), disabled: !S.selection.size }, 'Сохранить выделение'),
    h('button', { onclick: () => S.clipboard && startPaste(S.clipboard), disabled: !S.clipboard }, 'Вставить буфер')));
  box.append(h('p', { class: 'muted' }, 'Префабы хранятся в папке prefabs/ рядом с инструментом и доступны во всех шаттлах.'));
  let list = [];
  try { list = await api.get('/api/prefabs'); } catch { /* ignore */ }
  const l = h('div', { class: 'list' });
  for (const p of list) {
    l.append(h('div', { class: 'li' },
      h('span', { onclick: () => startPaste(p.clip) }, `${p.name}`, h('span', { class: 'muted' }, `  ${p.clip.w}×${p.clip.h} · ${p.clip.ents.length} сущн.`)),
      h('button', { class: 'danger', onclick: async () => { if (confirm('Удалить префаб ' + p.name + '?')) { await api.post('/api/prefab/delete', { name: p.name }); renderPrefabs(); } } }, '✕')));
  }
  if (!list.length) l.append(h('div', { class: 'li muted' }, 'Нет префабов'));
  box.append(l);
}

// ===================================================================== stats
export function renderStats() {
  const box = $('tab-stats');
  box.innerHTML = '';
  if (!M()) return;
  const s = stats(M());
  const fmt = n => Math.round(n).toLocaleString('ru-RU');
  box.append(h('table', { class: 'kv' },
    h('tr', {}, h('td', {}, 'Размер'), h('td', {}, s.size)),
    h('tr', {}, h('td', {}, 'Тайлов'), h('td', {}, fmt(s.tiles))),
    h('tr', {}, h('td', {}, 'Сущностей'), h('td', {}, `${fmt(s.ents)} (+${fmt(s.others)} в контейнерах)`)),
    h('tr', {}, h('td', {}, 'Декалей'), h('td', {}, fmt(s.decals))),
    h('tr', {}, h('td', {}, 'Оценка цены (StaticPrice)'), h('td', {}, fmt(s.price) + ' $')),
    h('tr', {}, h('td', {}, 'Потребление'), h('td', {}, fmt(s.load) + ' Вт')),
    h('tr', {}, h('td', {}, 'Генерация'), h('td', {}, fmt(s.supply) + ' Вт' + (s.supply < s.load ? ' ⚠ меньше потребления' : ''))),
    ...s.ame.map((g, i) => h('tr', {}, h('td', {}, s.ame.length > 1 ? `ДАМ #${i + 1}` : 'ДАМ'),
      h('td', { title: 'Безопасный впрыск — до 2 ед. на ядро; при большем впрыске ядра теряют стабильность' },
        `ядер: ${g.cores}, до ${fmt(g.safePower)} Вт при впрыске ${g.safeFuel}` +
        (g.injection !== g.safeFuel ? ` (впрыск ${g.injection} на карте: ${fmt(g.power)} Вт)` : '')))),
    h('tr', {}, h('td', {}, 'Двигатели толкают'), h('td', {}, `↑${s.thrusters.N} ↓${s.thrusters.S} →${s.thrusters.E} ←${s.thrusters.W}`)),
    h('tr', {}, h('td', {}, 'Гироскопы'), h('td', {}, String(s.gyros)))));
  box.append(h('div', { class: 'row' }, h('button', { onclick: renderStats }, 'Обновить')));
  box.append(h('h4', {}, 'Прототипы'));
  const l = h('div', { class: 'list' });
  for (const [id, n] of [...s.byProto].sort((a, b) => b[1] - a[1]).slice(0, 80)) {
    l.append(h('div', { class: 'li', onclick: () => { S.sel.entity = id; setPalKind('entity'); setTool('entity'); } }, h('span', {}, id), h('span', { class: 'muted' }, String(n))));
  }
  box.append(l);
  box.append(h('h4', {}, 'Тайлы'));
  const lt = h('div', { class: 'list' });
  for (const [id, n] of [...s.byTile].sort((a, b) => b[1] - a[1])) lt.append(h('div', { class: 'li' }, h('span', {}, id), h('span', { class: 'muted' }, String(n))));
  box.append(lt);
}

// ===================================================================== status
export function updateStatus() {
  const model = M();
  if (!model) return;
  if (S.hoverTile) {
    const [x, y] = S.hoverTile;
    const t = model.getTile(x, y);
    const n = model.entsAt(x, y).length;
    const top = O.visibleEntsAt(x, y)[0];
    $('stCursor').textContent = `(${x}, ${y})  ${t ? t[0] : 'Space'}${n ? ` · ${n} сущн.` : ''}${top ? ' · ' + top.proto : ''}`;
  }
  let selText = '';
  if (S.selection.size) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const k of S.selection) { const [x, y] = unkey(k); minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); }
    selText = `выделено ${S.selection.size} (${maxx - minx + 1}×${maxy - miny + 1})`;
  }
  $('stSel').textContent = selText;
  $('stCounts').textContent = `тайлов ${model.tiles.size} · сущностей ${model.ents.size}${model.dirty ? ' · ●' : ''}`;
}

// ===================================================================== dialogs
const kb = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : Math.round(n / 1024) + ' КБ';
const catBadge = m => m.format < 7
  ? h('span', { class: 'badge old', title: `Старый формат ${m.format}: грид или целая карта, станции` }, 'f' + m.format)
  : h('span', { class: 'badge' + (m.cat === 'Grid' ? '' : ' map'), title: m.cat === 'Grid' ? 'Грид (шаттл, POI)' : 'Карта целиком (станция, несколько гридов)' }, m.cat === 'Grid' ? 'грид' : 'карта');

/** Upload .yml files into the user folder (shuttles/). Returns the uploaded paths. */
export async function uploadMaps(files) {
  const done = [];
  for (const f of files) {
    if (!/\.ya?ml$/i.test(f.name)) { toast(`${f.name}: нужен файл .yml`, 'err'); continue; }
    const text = await f.text();
    let body = { name: f.name, text };
    for (;;) {
      const r = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (r.status === 409 && j.exists) {
        if (!confirm(`В «Моих шаттлах» уже есть ${j.path.slice(5)}. Заменить?`)) break;
        body = { ...body, overwrite: true };
        continue;
      }
      if (!r.ok) { toast(j.error || String(r.status), 'err', 8000); break; }
      toast(`Загружено: ${j.path.slice(5)} — гридов ${j.grids}, тайлов ${j.tiles}, сущностей ${j.entities}`, 'ok');
      done.push(j.path);
      break;
    }
  }
  return done;
}

export async function openDialog(loadMap) {
  const open = (path, grid) => { close(); loadMap(path, grid); };
  // ---- own shuttles (shuttles/ in the mapper folder)
  const userList = h('div', { class: 'list', style: 'max-height:22vh' }, h('div', { class: 'li muted' }, 'Загрузка…'));
  const picker = h('input', { type: 'file', accept: '.yml,.yaml', multiple: true, style: 'display:none', onchange: () => { upload([...picker.files]); picker.value = ''; } });
  const drop = h('div', { class: 'dropzone', title: 'Файлы копируются в папку shuttles/ маппера',
    onclick: () => picker.click() }, '⬆ Перетащите сюда .yml шаттла или ', h('u', {}, 'выберите файлы'), picker);
  const autoOpen = h('input', { type: 'checkbox', checked: S.saveOpts.openUploaded !== false, onchange: e => { S.saveOpts.openUploaded = e.target.checked; savePrefs(); } });
  async function upload(files) {
    drop.classList.add('busy');
    const paths = await uploadMaps(files);
    drop.classList.remove('busy');
    await fillUser(paths);
    if (paths.length === 1 && autoOpen.checked) open(paths[0]);
  }
  async function fillUser(highlight = []) {
    let list = [];
    try { list = await api.get('/api/usermaps'); } catch (e) { userList.innerHTML = ''; userList.append(h('div', { class: 'li' }, e.message)); return; }
    userList.innerHTML = '';
    for (const m of list) {
      userList.append(h('div', { class: 'li' + (highlight.includes(m.path) ? ' hl' : ''), onclick: () => open(m.path) },
        h('span', {}, catBadge(m), ' ', m.path.slice(5)),
        h('span', { class: 'row', style: 'margin:0;flex-wrap:nowrap' },
          h('span', { class: 'muted' }, `${kb(m.size)} · ${new Date(m.mtime * 1000).toLocaleString('ru-RU')}`),
          h('button', { class: 'danger', style: 'padding:0 5px', title: 'Удалить файл из shuttles/', onclick: async ev => {
            ev.stopPropagation();
            if (!confirm(`Удалить ${m.path.slice(5)} из «Моих шаттлов»?`)) return;
            await api.post('/api/usermap/delete', { path: m.path });
            fillUser();
          } }, '✕'))));
    }
    if (!list.length) userList.append(h('div', { class: 'li muted' }, 'Пока пусто: загрузите свой шаттл выше.'));
  }
  // ---- every grid / map of the build
  const filter = h('input', { type: 'search', placeholder: 'Фильтр (например _Mono/Shuttles или box)', class: 'grow' });
  const kinds = { all: 'Все', Grid: 'Гриды', Map: 'Карты' };
  let kind = 'all';
  const seg = h('div', { class: 'seg' }, ...Object.entries(kinds).map(([k, n]) => h('button', { 'data-k': k, class: k === kind ? 'on' : '', onclick: () => { kind = k; seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === k)); render(); } }, n)));
  const list = h('div', { class: 'list' }, h('div', { class: 'li muted' }, 'Загрузка…'));
  const count = h('span', { class: 'muted' });
  const body = h('div', {},
    h('h4', { style: 'margin-top:0' }, 'Мои шаттлы (shuttles/)'),
    drop, h('div', { class: 'row' }, h('label', { class: 'chk' }, autoOpen, 'открыть после загрузки')), userList,
    h('h4', {}, 'Билд'),
    h('div', { class: 'row' }, filter, seg, count), list,
    h('p', { class: 'muted' }, 'Открывается любой файл карты: гриды и целые карты (станции, формат 6 и 7). В карте с несколькими гридами редактируется самый крупный, другой выбирается в заголовке после открытия; остальное содержимое файла сохраняется без изменений.'));
  const close = modal('Открыть', body);
  // drag'n'drop onto the whole dialog
  const box = body.closest('.modal-box') || body;
  const over = ev => { if ([...ev.dataTransfer.types].includes('Files')) { ev.preventDefault(); drop.classList.add('over'); } };
  body.addEventListener('dragover', over);
  body.addEventListener('dragenter', over);
  body.addEventListener('dragleave', ev => { if (!body.contains(ev.relatedTarget)) drop.classList.remove('over'); });
  body.addEventListener('drop', ev => {
    ev.preventDefault();
    drop.classList.remove('over');
    const files = [...ev.dataTransfer.files];
    if (files.length) upload(files);
  });
  void box;
  fillUser();
  let maps = [];
  try { maps = await api.get('/api/maps'); } catch (e) { list.innerHTML = ''; list.append(h('div', { class: 'li' }, e.message)); return; }
  function render() {
    list.innerHTML = '';
    const q = filter.value.toLowerCase();
    // format 6 files do not say whether they are a grid or a whole map: they show up under both
    const found = maps.filter(m => m.path.toLowerCase().includes(q) && (kind === 'all' || m.format < 7 || (kind === 'Grid') === (m.cat === 'Grid')));
    count.textContent = `${found.length} из ${maps.length}`;
    for (const m of found.slice(0, 500)) {
      list.append(h('div', { class: 'li', onclick: () => open(m.path) }, h('span', {}, catBadge(m), ' ', m.path), h('span', { class: 'muted' }, kb(m.size))));
    }
    if (found.length > 500) list.append(h('div', { class: 'li muted' }, `…и ещё ${found.length - 500}, уточните фильтр`));
  }
  filter.oninput = render;
  render();
  filter.focus();
}

/** Grid picker in the top bar for files with several grids. */
export function renderGridPicker(doc, loadMap) {
  const box = $('gridPick');
  box.innerHTML = '';
  const grids = doc.gridList || [];
  if (grids.length < 2 || !doc.path) return;
  box.append(h('select', { title: 'Грид этого файла, который редактируется. Остальные гриды и содержимое карты сохраняются без изменений.',
    onchange: e => { const v = e.target.value; e.target.value = doc.gridUid; loadMap(doc.path, v); } },
  ...grids.map(g => h('option', { value: g.uid, selected: g.uid === doc.gridUid }, `${g.name || 'грид'} #${g.uid} · ${g.tiles} тайлов`))));
}

export function saveDialog(doSave, asNew) {
  const model = M();
  const isNew = !model.path;
  const path = h('input', { class: 'grow', value: model.path || 'SharedMaps/_Mono/Shuttles/Civilian/newshuttle.yml' });
  const regen = h('input', { type: 'checkbox', checked: isNew || !!model.doc.regenAtmos });
  const mix = h('select', {}, h('option', { value: 'air' }, 'Воздух 293K'), h('option', { value: 'freezer' }, 'Холодильник 235K'), h('option', { value: 'vacuum' }, 'Вакуум'));
  const exposed = h('input', { type: 'checkbox', checked: true });
  const toRepo = h('input', { type: 'checkbox', checked: !!S.saveOpts.toRepo });
  const gname = h('input', { class: 'grow', value: (model.doc.gridEnt.components.find(c => c.type === 'MetaData') || {}).name || 'grid' });
  const body = h('div', {},
    h('div', { class: 'row' }, h('span', { title: 'Путь от Resources/ или user/<файл>.yml — папка shuttles/ маппера' }, 'Путь (от Resources/ или user/…):'), path,
      h('button', { title: 'Сохранять в «Мои шаттлы» (папка shuttles/ маппера)', onclick: () => { path.value = 'user/' + path.value.split('/').pop(); toRepo.checked = true; } }, '→ мои шаттлы')),
    h('div', { class: 'row' }, 'Имя грида (MetaData):', gname),
    h('h4', {}, 'Атмосфера'),
    h('div', { class: 'row' }, h('label', { class: 'chk' }, regen, 'Пересоздать GridAtmosphere (как fixgridatmos)'), mix),
    h('div', { class: 'row' }, h('label', { class: 'chk' }, exposed, 'Тайлы с выходом в космос — вакуум')),
    h('h4', {}, 'Куда'),
    h('div', { class: 'row' }, h('label', { class: 'chk' }, toRepo, 'Записать файл по этому пути: в репозиторий или для user/… в папку shuttles/ (иначе файл скачивается в «Загрузки»)')),
    h('p', { class: 'muted' }, 'Неизвестные компоненты и поля сохраняются без изменений.'),
    h('div', { class: 'row' }, h('button', { class: 'on', onclick: go }, 'Сохранить'), h('button', { onclick: () => closeModal() }, 'Отмена')));
  modal(asNew || isNew ? 'Сохранить как' : 'Сохранить', body);
  path.focus();
  async function go() {
    const md = model.doc.gridEnt.components.find(c => c.type === 'MetaData');
    if (md) md.name = gname.value;
    S.saveOpts.toRepo = toRepo.checked;
    savePrefs();
    closeModal();
    await doSave(path.value.trim(), { toRepo: toRepo.checked, regenAtmos: regen.checked, atmos: { mix: mix.value, exposedVacuum: exposed.checked } });
  }
}

export function exportDialog() {
  const px = h('select', {}, ...[8, 16, 32, 64].map(v => h('option', { value: v, selected: v === 32 }, v + ' px/тайл')));
  const bg = h('select', {}, h('option', { value: 'transparent' }, 'Прозрачный'), h('option', { value: '#000000' }, 'Чёрный'), h('option', { value: '#0b0d12' }, 'Космос'));
  const hide = h('input', { type: 'checkbox', checked: true });
  const noUtil = h('input', { type: 'checkbox' });
  const grid = h('input', { type: 'checkbox' });
  const decals = h('input', { type: 'checkbox', checked: true });
  const markers = h('input', { type: 'checkbox' });
  const margin = h('input', { type: 'number', value: 1, min: 0, max: 16 });
  const gratesOn = h('input', { type: 'checkbox', checked: S.subfloor.showOnGrates });
  const gratesRe = h('input', { class: 'grow', value: S.subfloor.grates, title: 'Регулярное выражение по id тайла' });
  const preview = h('div', { style: 'margin-top:8px;max-height:45vh;overflow:auto;background:repeating-conic-gradient(#222 0 25%, #2a2a2a 0 50%) 0 0/16px 16px' });
  const opts = () => ({ px: +px.value, bg: bg.value, hideSubfloor: hide.checked, grates: gratesOn.checked ? gratesRe.value : '', noUtilities: noUtil.checked, grid: grid.checked, decals: decals.checked, markers: markers.checked, margin: +margin.value });
  let last = null;
  const body = h('div', {},
    h('div', { class: 'row' }, 'Разрешение', px, 'Фон', bg, 'Поля', margin),
    h('div', { class: 'row' }, h('label', { class: 'chk' }, hide, 'прятать подпол под полом (как в игре)'), h('label', { class: 'chk' }, noUtil, 'без труб/кабелей'),
      h('label', { class: 'chk' }, decals, 'декали'), h('label', { class: 'chk' }, grid, 'сетка'), h('label', { class: 'chk' }, markers, 'маркеры')),
    h('div', { class: 'row' }, h('label', { class: 'chk', title: 'На тайлах-решётках провода и трубы остаются видны (под обычным полом — скрыты)' }, gratesOn, 'подпол виден на решётках:'), gratesRe,
      h('button', { onclick: () => { S.subfloor.showOnGrates = gratesOn.checked; S.subfloor.grates = gratesRe.value; savePrefs(); toast('Сохранено как настройка по умолчанию', 'ok'); } }, 'Запомнить')),
    h('div', { class: 'row' }, h('button', { onclick: doPreview }, 'Предпросмотр'), h('button', { class: 'on', onclick: download }, 'Скачать PNG'),
      h('button', { onclick: () => { px.value = 32; bg.value = 'transparent'; hide.checked = true; noUtil.checked = false; grid.checked = false; markers.checked = false; doPreview(); } }, 'Пресет: превью Shipyard')),
    preview);
  modal('Экспорт запечённого изображения грида', body);
  async function doPreview() {
    preview.innerHTML = 'Рендер…';
    try {
      last = await bake(opts());
      preview.innerHTML = '';
      last.style.maxWidth = '100%';
      last.style.imageRendering = 'pixelated';
      preview.append(last, h('div', { class: 'muted' }, `${last.width}×${last.height}`));
    } catch (e) { preview.textContent = e.message; }
  }
  async function download() {
    try {
      const cv = await bake(opts());
      const name = (M().path || 'shuttle.yml').split('/').pop().replace(/\.yml$/, '') + '.png';
      cv.toBlob(b => { const a = h('a', { href: URL.createObjectURL(b), download: name }); document.body.append(a); a.click(); a.remove(); toast('PNG сохранён: ' + name, 'ok'); });
    } catch (e) { toast(e.message, 'err'); }
  }
  doPreview();
}

// ===================================================================== preset files (Downloads / browser / presets/ catalog)
function downloadJson(obj, name) {
  const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function pickJsonFiles() {
  return new Promise(resolve => {
    const inp = h('input', { type: 'file', accept: '.json,application/json', multiple: true, style: 'display:none' });
    inp.onchange = async () => {
      const out = [];
      for (const f of inp.files) {
        try { out.push({ name: f.name.replace(/\.json$/i, ''), data: JSON.parse(await f.text()) }); } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
      }
      inp.remove();
      resolve(out);
    };
    document.body.append(inp);
    inp.click();
  });
}
const fileName = s => (String(s || 'preset').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'preset') + '.json';
async function saveToCatalog(kind, name, data) {
  try {
    const list = await api.get('/api/presets?kind=' + kind);
    if (list.some(p => p.file.toLowerCase() === name.toLowerCase() || (p.data && p.data.name === name)) && !confirm(`Пресет «${name}» уже есть в каталоге. Перезаписать?`)) return;
    const r = await api.post('/api/preset', { kind, name, data });
    toast(`Сохранено: presets/${kind}/${r.file}.json`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}
/** List of presets from presets/<kind>/ with load/delete buttons. */
function catalogList(kind, describe, onLoad) {
  const box = h('div', { class: 'list' }, h('div', { class: 'li muted' }, 'Загрузка…'));
  const fill = async () => {
    let list = [];
    try { list = await api.get('/api/presets?kind=' + kind); } catch (e) { box.innerHTML = ''; box.append(h('div', { class: 'li' }, e.message)); return; }
    box.innerHTML = '';
    for (const p of list) {
      box.append(h('div', { class: 'li' },
        h('span', {}, p.data ? (p.data.name || p.file) : p.file, h('span', { class: 'muted' }, '  ' + (p.error ? 'ошибка: ' + p.error : `${p.file}.json · ${describe(p.data)}`))),
        h('span', { class: 'row', style: 'margin:0;flex-wrap:nowrap' },
          h('button', { disabled: !p.data, onclick: () => onLoad(p.data, p.file) }, 'Загрузить'),
          h('button', { class: 'danger', title: 'Удалить файл из каталога', onclick: async () => { if (confirm(`Удалить presets/${kind}/${p.file}.json?`)) { await api.post('/api/preset/delete', { kind, name: p.file }); fill(); } } }, '✕'))));
    }
    if (!list.length) box.append(h('div', { class: 'li muted' }, `Каталог presets/${kind}/ пуст`));
  };
  fill();
  return box;
}

// ===================================================================== symmetry
const KIND_NAMES = { tile: 'тайлы', entity: 'прототипы', decal: 'декали' };
const CELL_NAMES = ['Исходный', 'Отражение по X (⇋)', 'Отражение по Y (⇵)', 'По X и Y'];
const kindUrl = (kind, id) => kind === 'tile' ? A.tileUrl(id) : kind === 'decal' ? A.decalUrl(id) : A.iconUrl(id);

/** Floating search list to choose a tile / prototype / decal id. */
function idPicker(anchor, kind, initial, onPick) {
  document.querySelector('.id-picker')?.remove();
  const q = h('input', { type: 'search', class: 'grow', placeholder: 'Поиск (id / имя / рус.)', value: initial || '' });
  const list = h('div', { class: 'pal-grid', style: 'max-height:300px;overflow-y:auto' });
  const box = h('div', { class: 'stack-menu id-picker', style: 'padding:6px;width:360px' },
    h('div', { class: 'row' }, q, h('button', { onclick: () => { onPick(null); close(); } }, 'Очистить')), list);
  const outside = e => { if (!box.contains(e.target)) close(); };
  function close() { box.remove(); document.removeEventListener('pointerdown', outside, true); }
  const render = () => {
    list.innerHTML = '';
    for (const p of search(kind, q.value, { limit: 150, hidden: true })) {
      list.append(h('div', { class: 'pi', title: displayName(kind, p.id), onclick: () => { onPick(p.id); close(); } },
        h('img', { src: kindUrl(kind, p.id), loading: 'lazy' }), h('span', { class: 'lbl' }, p.id)));
    }
  };
  q.oninput = render;
  q.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  box.style.left = Math.max(4, Math.min(r.left, innerWidth - 370)) + 'px';
  box.style.top = Math.max(4, Math.min(r.bottom + 4, innerHeight - 360)) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  render();
  q.focus();
  q.select();
}

function rotOptions(kind) {
  const deg = ['0°', '90°', '180°', '270°'];
  const opts = [['', 'поворот: авто']];
  deg.forEach((d, i) => opts.push([String(i), d]));
  if (kind === 'tile') deg.forEach((d, i) => opts.push([String(i + 4), 'отр. ' + d]));
  return opts;
}
function cellTransform(kind, rot) {
  if (rot === null || rot === undefined) return '';
  return `transform: rotate(${-90 * (rot % 4)}deg)${kind === 'tile' && rot >= 4 ? ' scaleX(-1)' : ''}`;
}
function autoFillGroup(g) {
  const base = g.cells.findIndex(Boolean);
  if (base < 0) return;
  for (let i = 0; i < 4; i++) {
    if (g.cells[i]) continue;
    let id = g.cells[base].id;
    if ((i ^ base) & 1) id = mirrorId(g.kind, id, 'x').id;
    if ((i ^ base) & 2) id = mirrorId(g.kind, id, 'y').id;
    g.cells[i] = { id, rot: null };
  }
}

/** One group: 2×2 cells split by the purple axes; the black-framed cell is the original. */
function symGroupCard(g, changed, rerender, remove) {
  const grid = h('div', { class: 'symgrid' });
  g.cells.forEach((c, i) => {
    const img = c ? h('img', { src: kindUrl(g.kind, c.id), style: cellTransform(g.kind, c.rot) }) : h('span', { class: 'muted' }, '+');
    const rot = h('select', { disabled: !c, title: 'Поворот клетки. «Авто» совпадает с любым поворотом, он пересчитывается как обычно', onchange: e => { c.rot = e.target.value === '' ? null : +e.target.value; changed(); rerender(); } },
      ...rotOptions(g.kind).map(([v, t]) => h('option', { value: v, selected: String(c && c.rot !== null && c.rot !== undefined ? c.rot : '') === v }, t)));
    const pick = h('div', { class: 'symimg', title: `${CELL_NAMES[i]}: ${c ? displayName(g.kind, c.id) : 'не задан (встроенные правила)'}. Клик — выбрать` }, img);
    pick.onclick = () => idPicker(pick, g.kind, c ? c.id : (g.cells.find(Boolean) || {}).id, id => {
      g.cells[i] = id ? { id, rot: c ? c.rot : null } : null;
      if (id && (!g.name || g.name === 'Группа')) g.name = id;
      changed(); rerender();
    });
    grid.append(h('div', { class: 'symcell' + (i === 0 ? ' orig' : '') }, pick, h('div', { class: 'symid', title: c ? c.id : '' }, c ? c.id : CELL_NAMES[i]), rot));
  });
  return h('div', { class: 'set symgrp' + (g.on ? ' on' : '') },
    h('div', { class: 'row' },
      h('input', { type: 'checkbox', checked: g.on, title: 'Группа включена', onchange: e => { g.on = e.target.checked; changed(); rerender(); } }),
      h('input', { class: 'grow', value: g.name, onchange: e => { g.name = e.target.value; changed(); } }),
      h('span', { class: 'muted' }, KIND_NAMES[g.kind]),
      h('button', { title: 'Заполнить пустые клетки встроенными правилами (NE↔NW, Left↔Right…)', onclick: () => { autoFillGroup(g); changed(); rerender(); } }, 'Авто'),
      h('button', { class: 'danger', onclick: remove }, '✕')),
    grid);
}

export function mirrorDialog() {
  const Y = S.symmetry;
  const body = h('div', {});
  let showCatalog = false;
  const changed = () => { savePrefs(); emit('mirror'); };
  const axisInput = k => h('input', { type: 'number', step: 0.5, value: S.mirror[k], onchange: e => { S.mirror[k] = +e.target.value; changed(); requestDraw(); } });
  const setAxes = (x, y) => { S.mirror.ax = x; S.mirror.ay = y; changed(); requestDraw(); render(); };
  const addPreset = p => {
    const i = Y.presets.findIndex(q => q.name === p.name);
    if (i >= 0 && confirm(`Пресет «${p.name}» уже есть. Заменить его? (Отмена — добавить копию)`)) { Y.presets[i] = p; Y.active = i; }
    else { Y.presets.push(p); Y.active = Y.presets.length - 1; }
    changed(); render();
  };
  function render() {
    const scroll = $('modalBody').scrollTop;
    body.innerHTML = '';
    const P0 = Y.active >= 0 ? Y.presets[Y.active] : null;
    body.append(
      h('h4', {}, 'Оси'),
      h('p', { class: 'muted' }, 'Ось X — вертикальная линия x = значение (целое — граница тайлов, .5 — центр тайла), ось Y — горизонтальная. Ось можно перетащить за фиолетовый маркер на линейке. При включённой оси кисти, трубы, кабели, вставка и прототипы зеркалируются (повороты, Left↔Right, NE↔NW и т.п.).'),
      h('div', { class: 'row' }, h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: S.mirror.x, onchange: e => { S.mirror.x = e.target.checked; changed(); requestDraw(); } }), 'Ось X'), 'x =', axisInput('ax')),
      h('div', { class: 'row' }, h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: S.mirror.y, onchange: e => { S.mirror.y = e.target.checked; changed(); requestDraw(); } }), 'Ось Y'), 'y =', axisInput('ay')),
      h('div', { class: 'row' },
        h('button', { onclick: () => { const b = M().bounds(); if (b) setAxes((b.minx + b.maxx + 1) / 2, (b.miny + b.maxy + 1) / 2); } }, 'По центру грида'),
        h('button', { onclick: () => { if (S.selection.size) { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (const k of S.selection) { const [x, y] = unkey(k); a = Math.min(a, x); b = Math.max(b, x + 1); c = Math.min(c, y); d = Math.max(d, y + 1); } setAxes((a + b) / 2, (c + d) / 2); } } }, 'По центру выделения'),
        h('button', { onclick: () => { if (S.hoverTile) setAxes(S.hoverTile[0] + 0.5, S.hoverTile[1] + 0.5); } }, 'По тайлу под курсором')),
      h('h4', {}, 'Пресет отражений'),
      h('p', { class: 'muted' }, 'Пресет задаёт явные зеркальные пары для тайлов, прототипов и декалей, которые встроенные правила не узнают (например LatticeHalfTilt…Lower). В группе чёрная рамка — исходный элемент, фиолетовые линии — оси, остальные клетки — его отражения по X, по Y и по обеим осям. Пока группа включена, любой её элемент при зеркалировании заменяется на соответствующую клетку.'),
      h('div', { class: 'row' },
        h('select', { class: 'grow', onchange: e => { Y.active = +e.target.value; changed(); render(); } },
          h('option', { value: -1, selected: Y.active < 0 }, '— нет (только встроенные правила) —'),
          ...Y.presets.map((p, i) => h('option', { value: i, selected: i === Y.active }, `${p.name} (${p.groups.length})`))),
        h('button', { onclick: () => { Y.presets.push({ name: `Пресет ${Y.presets.length + 1}`, groups: [] }); Y.active = Y.presets.length - 1; changed(); render(); } }, '+ новый'),
        h('button', { disabled: !P0, onclick: () => { Y.presets.push(symFromFile(JSON.parse(JSON.stringify(symToFile({ ...P0, name: P0.name + ' (копия)' }))))); Y.active = Y.presets.length - 1; changed(); render(); } }, 'Копия'),
        h('button', { class: 'danger', disabled: !P0, title: 'Убрать пресет из браузера (файлы в каталоге не трогаются)', onclick: () => { if (confirm(`Убрать пресет «${P0.name}» из браузера? Файлы в каталоге не трогаются.`)) { Y.presets.splice(Y.active, 1); Y.active = -1; changed(); render(); } } }, '✕')),
      h('div', { class: 'row' },
        h('button', { disabled: !P0, title: 'Скачать пресет .json в «Загрузки»', onclick: () => downloadJson(symToFile(P0), fileName(P0.name)) }, '⬇ В загрузки'),
        h('button', { title: 'Загрузить пресет из .json файла', onclick: async () => { for (const f of await pickJsonFiles()) { try { addPreset(symFromFile(f.data, f.name)); } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); } } } }, '⬆ Из файла'),
        h('button', { disabled: !P0, title: 'Сохранить в папку presets/symmetry/ маппера', onclick: () => saveToCatalog('symmetry', P0.name, symToFile(P0)) }, '💾 В каталог'),
        h('button', { class: showCatalog ? 'on' : '', title: 'Пресеты из папки presets/symmetry/ маппера', onclick: () => { showCatalog = !showCatalog; render(); } }, '📂 Каталог')),
      showCatalog ? catalogList('symmetry', d => `${((d && d.groups) || []).length} групп`, (d, file) => { try { addPreset(symFromFile(d, file)); toast('Пресет загружен', 'ok'); } catch (e) { toast(e.message, 'err'); } }) : '');
    if (P0) {
      const add = g => { P0.groups.push(g); changed(); render(); };
      body.append(
        h('div', { class: 'row' }, 'Имя', h('input', { class: 'grow', value: P0.name, onchange: e => { P0.name = e.target.value || 'Пресет'; changed(); render(); } })),
        h('div', { class: 'row' },
          h('button', { onclick: () => add(newGroup('tile')) }, '+ тайлы'),
          h('button', { onclick: () => add(newGroup('entity')) }, '+ прототипы'),
          h('button', { onclick: () => add(newGroup('decal')) }, '+ декали'),
          h('button', { title: 'Группа из выбранного в палитре элемента; отражения заполняются встроенными правилами', onclick: () => {
            const id = S.sel[S.palKind];
            if (!id) { toast('В палитре ничего не выбрано'); return; }
            const g = newGroup(S.palKind, id); autoFillGroup(g); add(g);
          } }, '+ из палитры'),
          h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: P0.groups.length > 0 && P0.groups.every(g => g.on), onchange: e => { for (const g of P0.groups) g.on = e.target.checked; changed(); render(); } }), 'включить все')));
      const list = h('div', {});
      for (const g of P0.groups) list.append(symGroupCard(g, changed, render, () => { P0.groups.splice(P0.groups.indexOf(g), 1); changed(); render(); }));
      if (!P0.groups.length) list.append(h('div', { class: 'muted' }, 'Групп нет. Добавьте группу и выберите элементы кликом по клеткам.'));
      body.append(list);
    }
    body.append(h('div', { class: 'row' }, h('button', { class: 'on', onclick: () => { document.querySelector('.id-picker')?.remove(); closeModal(); } }, 'Готово')));
    $('modalBody').scrollTop = scroll;
  }
  modal('Настройка симметрии', body, () => document.querySelector('.id-picker')?.remove());
  render();
}

// ===================================================================== mass scanner
/** Settings of the scanner (S.radar). redraw() is called after every change; sync(result) updates the range hint. */
function radarControls(model, redraw, { onSave, onPin, compact = false } = {}) {
  const o = S.radar;
  const rangeInp = h('input', { type: 'number', min: 8, max: 4096, step: 8, style: 'width:80px', value: o.range || '', title: 'Радиус обзора в метрах (тайлах). Пусто — по размеру шаттла. Колесо мыши над сканером — масштаб',
    onchange: e => { o.range = Math.max(0, Math.round(+e.target.value) || 0); redraw(); } });
  const centers = RD.radarCenters(model);
  const centerSel = h('select', { onchange: e => { o.center = e.target.value; redraw(); } },
    h('option', { value: 'console', selected: o.center === 'console' }, centers.length ? 'Консоль шаттла' : 'Консоль (на шаттле нет)'),
    ...centers.map(c => h('option', { value: c.uid, selected: o.center === c.uid }, c.label)),
    h('option', { value: 'grid', selected: o.center === 'grid' }, 'Центр грида'));
  const color = (k, title) => h('input', { type: 'color', title, value: (o[k] || '#000000').slice(0, 7), oninput: e => { o[k] = e.target.value.toUpperCase(); redraw(); } });
  const autoShield = RD.shieldColor(model);
  const hasGen = [...model.ents.values()].some(e => protoOf(e.proto)?.shield);
  const shieldInp = h('input', { type: 'color', title: 'Цвет щита (по умолчанию — цвет генератора щита на шаттле)', value: rgbHex(o.shieldColor || autoShield),
    oninput: e => { o.shieldColor = e.target.value.toUpperCase(); redraw(); } });
  const colorInp = color('color'), bgInp = color('bg');
  const el = h('div', { class: 'radar-controls' },
    h('div', { class: 'row' }, h('label', {}, 'Центр ', centerSel), h('label', {}, 'Радиус ', rangeInp, ' м'),
      h('button', { title: 'Подогнать радиус под шаттл', onclick: () => { o.range = 0; rangeInp.value = ''; redraw(); } }, 'По размеру')),
    h('div', { class: 'row' },
      h('label', { title: 'Цвет контура своего грида (в игре — MediumSpringGreen)' }, 'Контур ', colorInp),
      h('label', { title: 'Цвет фона сканера' }, 'Фон ', bgInp),
      h('button', { title: 'Цвета как в игре', onclick: () => { o.color = '#00FA9A'; o.bg = '#141414'; colorInp.value = '#00fa9a'; bgInp.value = '#141414'; redraw(); } }, 'Как в игре'),
      compact ? null : h('span', { class: 'sep' }),
      chk('щит', o, 'shield', redraw), shieldInp,
      h('button', { title: hasGen ? 'Цвет генератора щита на шаттле' : 'Генератора щита на шаттле нет: цвет щита по умолчанию', onclick: () => { o.shieldColor = ''; shieldInp.value = rgbHex(autoShield); redraw(); } }, hasGen ? 'из генератора' : 'по умолчанию')),
    h('div', { class: 'row' }, chk('сигнатуры', o, 'blips', redraw), chk('доки', o, 'docks', redraw), chk('названия доков', o, 'labels', redraw),
      chk('азимуты', o, 'azimuth', redraw), chk('кольца дальности', o, 'rings', redraw),
      h('span', { style: 'margin-left:auto' }),
      onPin ? h('button', { title: 'Закрепить сканер мини-окном поверх редактора: перетаскивается, обновляется вживую', onclick: onPin }, '📌 Закрепить') : null,
      onSave ? h('button', { onclick: onSave }, 'Сохранить PNG') : null));
  return { el, sync: r => { rangeInp.placeholder = `авто ${r.range}`; } };
}
function savePng(cv, model) {
  cv.toBlob(b => {
    const a = h('a', { href: URL.createObjectURL(b), download: ((model.path || 'shuttle').split('/').pop().replace(/\.yml$/, '')) + '-radar.png' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}
/** Mouse wheel over a scanner canvas changes the range. */
function radarWheel(cv, getLast, redraw) {
  cv.addEventListener('wheel', ev => {
    ev.preventDefault();
    const cur = S.radar.range || getLast().range;
    S.radar.range = Math.max(8, Math.min(4096, Math.round(cur * (ev.deltaY < 0 ? 1 / 1.2 : 1.2))));
    redraw(true);
  }, { passive: false });
}

export function radarDialog() {
  const model = M();
  const SIZE = 600;
  const cv = h('canvas', { width: SIZE, height: SIZE, style: `width:${SIZE}px;height:${SIZE}px;display:block;border-radius:4px;cursor:zoom-in` });
  const info = h('span', { class: 'muted' });
  let last = null;
  let ctl = null;
  const redraw = rebuild => {
    savePrefs();
    last = RD.drawRadar(cv.getContext('2d'), SIZE, SIZE, S.radar, model);
    if (rebuild) { const n = radarControls(model, redraw, opts); ctl.el.replaceWith(n.el); ctl = n; }
    ctl.sync(last);
    info.textContent = `радиус ${Math.round(last.range)} м · центр (${last.center[0].toFixed(1)}, ${last.center[1].toFixed(1)})`;
    radarDock.refresh();
  };
  const opts = { onSave: () => savePng(cv, model), onPin: () => { closeModal(); radarDock.open(); } };
  ctl = radarControls(model, redraw, opts);
  radarWheel(cv, () => last, redraw);
  const body = h('div', {}, ctl.el, cv, h('div', { class: 'row' }, info),
    h('p', { class: 'muted' }, 'Как консоль шаттла в игре: контур грида и метки рёбер (RadarEdgeMarker), доки с названиями, сигнатуры (RadarBlip: консоли, ДАМ, двигатели, орудия…) с цветами и формами из прототипов сборки, щит — овал вокруг грида с отступом 50 м. IFF не рисуется.'));
  modal('Сканер масс', body);
  redraw();
}

// Pinned scanner: a floating mini window over the editor (S.radarDock: open, x, y, size, expanded).
// The scan is cached in an offscreen canvas and rebuilt on map / settings changes; the visible canvas
// adds the editor viewport on top, so panning the editor is cheap.
export const radarDock = (() => {
  let panel = null, cv = null, base = null, body = null, ctl = null, last = null, model = null;
  let dirty = true, timer = null;
  const D = () => S.radarDock;
  const dpr = () => window.devicePixelRatio || 1;

  function build() {
    const stage = $('stage');
    panel = h('div', { id: 'radarDock', class: 'float-panel' });
    const head = h('div', { class: 'fp-head', title: 'Перетащите, чтобы переместить' },
      h('span', { class: 'fp-title' }, '◎ Сканер масс'),
      h('span', { style: 'margin-left:auto' }),
      h('button', { title: 'Настройки сканера', onclick: () => { D().expanded = !D().expanded; layout(); savePrefs(); } }, '⚙'),
      h('button', { title: 'Открыть большой сканер', onclick: () => radarDialog() }, '⤢'),
      h('button', { title: 'Открепить (закрыть мини-окно)', onclick: close }, '✕'));
    cv = h('canvas', { title: 'Клик — показать это место в редакторе, колесо — масштаб сканера' });
    base = document.createElement('canvas');
    body = h('div', { class: 'fp-body' }, cv);
    const grip = h('div', { class: 'fp-resize', title: 'Размер' });
    panel.append(head, body, grip);
    stage.append(panel);
    drag(head, (dx, dy, st) => { D().x = st.x + dx; D().y = st.y + dy; place(); }, () => ({ x: D().x, y: D().y }));
    drag(grip, (dx, dy, st) => { D().size = Math.max(160, Math.min(720, st.size + Math.max(dx, dy))); layout(); }, () => ({ size: D().size }));
    radarWheel(cv, () => last, () => { savePrefs(); rebuildControls(); });
    cv.addEventListener('click', ev => {
      if (!last) return;
      const r = cv.getBoundingClientRect(), s = D().size;
      const sc = (s / 2) / last.range;
      centerOn(last.center[0] + (ev.clientX - r.left - s / 2) / sc, last.center[1] - (ev.clientY - r.top - s / 2) / sc);
    });
    on('viewDrawn', () => { if (D().open) overlay(); });
    window.addEventListener('resize', () => { if (D().open) place(); });
    on('doc', () => { if (D().open) { bindModel(); rebuildControls(); dirty = true; paint(); } });
  }
  function drag(handle, apply, start) {
    handle.addEventListener('pointerdown', ev => {
      if (ev.button !== 0 || ev.target.tagName === 'BUTTON') return;
      ev.preventDefault();
      const st = start(), x0 = ev.clientX, y0 = ev.clientY;
      const move = e => apply(e.clientX - x0, e.clientY - y0, st);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); savePrefs(); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }
  function bindModel() {
    if (model === M()) return;
    model = M();
    if (model) model.on(() => {
      if (!D().open) return;
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(paint, 200);
    });
  }
  function rebuildControls() {
    if (!M()) return;
    const n = radarControls(M(), () => { savePrefs(); dirty = true; paint(); }, { compact: true, onSave: () => savePng(base, M()) });
    if (ctl) ctl.el.replaceWith(n.el); else body.append(n.el);
    ctl = n;
    layout();
  }
  /** Keep the window inside the stage. */
  function place() {
    const st = $('stage'), w = panel.offsetWidth, hh = panel.offsetHeight;
    if (D().x === null) { D().x = st.clientWidth - w - 14; D().y = 30; }
    D().x = Math.max(0, Math.min(st.clientWidth - w, D().x));
    D().y = Math.max(0, Math.min(st.clientHeight - Math.min(hh, 40), D().y));
    panel.style.left = D().x + 'px';
    panel.style.top = D().y + 'px';
  }
  function layout() {
    const s = D().size;
    cv.style.width = cv.style.height = s + 'px';
    cv.width = cv.height = Math.round(s * dpr());
    if (ctl) ctl.el.style.display = D().expanded ? '' : 'none';
    panel.style.width = (D().expanded ? Math.max(s, 460) : s) + 12 + 'px';   // + body padding and border
    dirty = true;
    paint();
    place();
  }
  function paint() {
    if (!panel || !D().open || !M()) return;
    if (dirty) {
      const s = Math.round(D().size * dpr());
      base.width = base.height = s;
      last = RD.drawRadar(base.getContext('2d'), s, s, S.radar, M());
      ctl?.sync(last);
      dirty = false;
    }
    overlay();
  }
  /** Scan image + the area the editor currently shows. */
  function overlay() {
    if (!last || !cv) return;
    const c = cv.getContext('2d');
    c.drawImage(base, 0, 0);
    const s = cv.width, sc = (s / 2) / last.range;
    const [W, H] = viewSize();
    const [x0, y1] = s2w(0, 0), [x1, y0] = s2w(W, H);
    const px = x => s / 2 + (x - last.center[0]) * sc, py = y => s / 2 - (y - last.center[1]) * sc;
    c.strokeStyle = 'rgba(255,255,255,0.55)';
    c.lineWidth = dpr();
    c.setLineDash([4 * dpr(), 3 * dpr()]);
    c.strokeRect(px(x0), py(y1), (x1 - x0) * sc, (y1 - y0) * sc);
    c.setLineDash([]);
  }
  function open() {
    if (!panel) build();
    D().open = true;
    savePrefs();
    panel.style.display = '';
    bindModel();
    rebuildControls();
  }
  function close() {
    D().open = false;
    savePrefs();
    if (panel) panel.style.display = 'none';
  }
  return { open, close, refresh: () => { if (panel && D().open) { rebuildControls(); dirty = true; paint(); } }, isOpen: () => !!D().open };
})();

function rgbHex(c) {
  const t = document.createElement('canvas').getContext('2d');
  t.fillStyle = c;
  const v = t.fillStyle;
  if (v.startsWith('#')) return v;
  const m = v.match(/[\d.]+/g).slice(0, 3).map(n => (+n).toString(16).padStart(2, '0'));
  return '#' + m.join('');
}

export function validateDialog() {
  const issues = validate(M());
  S.markers = issues.filter(i => i.at && (i.sev === 'err' || i.sev === 'warn')).map(i => ({ x: i.at[0], y: i.at[1], sev: i.sev }));
  requestDraw();
  const body = h('div', {});
  const ne = issues.filter(i => i.sev === 'err').length, nw = issues.filter(i => i.sev === 'warn').length;
  body.append(h('p', {}, `Ошибок: ${ne}, предупреждений: ${nw}. Клик по пункту — перейти.`));
  for (const i of issues) {
    body.append(h('div', { class: 'issue ' + i.sev, onclick: () => { if (i.at) { centerOn(i.at[0] + 0.5, i.at[1] + 0.5, Math.max(S.view.z, 32)); } } }, i.msg));
  }
  body.append(h('div', { class: 'row' }, h('button', { onclick: () => { S.markers = []; requestDraw(); closeModal(); } }, 'Скрыть маркеры'), h('button', { onclick: () => { S.layers.leaks = true; refreshLeaks(); closeModal(); } }, 'Показать утечки')));
  modal('Проверка шаттла', body);
}

export function findReplaceDialog() {
  const kind = h('select', {}, h('option', { value: 'entity' }, 'Прототип'), h('option', { value: 'tile' }, 'Тайл'), h('option', { value: 'decal' }, 'Декаль'));
  const dl = h('datalist', { id: 'frList' });
  const from = h('input', { class: 'grow', list: 'frList', placeholder: 'что (id)' });
  const to = h('input', { class: 'grow', list: 'frList', placeholder: 'на что (пусто = удалить)' });
  const scope = h('select', {}, h('option', { value: 'all' }, 'Вся карта'), h('option', { value: 'selection', selected: S.selection.size > 0 }, 'Выделение'));
  const info = h('div', { class: 'muted' });
  const fillList = () => {
    dl.innerHTML = '';
    const used = new Set();
    if (kind.value === 'tile') for (const t of M().tiles.values()) used.add(t[0]);
    else if (kind.value === 'entity') for (const e of M().ents.values()) used.add(e.proto);
    else for (const d of M().decals.values()) used.add(d.id);
    const m = kind.value === 'tile' ? P.tiles : kind.value === 'decal' ? P.decals : P.ents;
    for (const id of [...used].sort()) dl.append(h('option', { value: id }));
    let n = 0; for (const id of m.keys()) { if (n++ > 4000) break; if (!used.has(id)) dl.append(h('option', { value: id })); }
  };
  kind.onchange = fillList;
  fillList();
  if (S.palKind === 'entity' && S.sel.entity) to.value = S.sel.entity;
  const body = h('div', {}, dl,
    h('div', { class: 'row' }, 'Тип', kind, 'Область', scope),
    h('div', { class: 'row' }, from), h('div', { class: 'row' }, to), info,
    h('div', { class: 'row' }, h('button', { class: 'on', onclick: () => {
      const m = kind.value === 'tile' ? P.tiles : kind.value === 'decal' ? P.decals : P.ents;
      if (to.value && !m.has(to.value)) { info.textContent = 'Неизвестный id: ' + to.value; return; }
      const n = findReplace(M(), { kind: kind.value, from: from.value.trim(), to: to.value.trim(), scope: scope.value });
      info.textContent = `Заменено: ${n}`;
      requestDraw();
    } }, 'Заменить')));
  modal('Поиск и замена', body);
}

let enumCache = null;
async function vesselEnums() {
  if (!enumCache) {
    try { enumCache = await api.get('/api/enums'); } catch { enumCache = {}; }
  }
  return enumCache;
}
export function chips(values, selected, onChange, title = v => v) {
  const box = h('div', { class: 'chips' });
  const sel = new Set(selected);
  for (const v of [...new Set([...values, ...selected])]) {
    const lab = h('label', { class: sel.has(v) ? 'on' : '' },
      h('input', { type: 'checkbox', checked: sel.has(v), onchange: e => {
        if (e.target.checked) sel.add(v); else sel.delete(v);
        lab.classList.toggle('on', e.target.checked);
        onChange([...values, ...selected].filter((x, i, a) => sel.has(x) && a.indexOf(x) === i));
      } }), v);
    if (title(v) !== v) lab.title = title(v);
    box.append(lab);
  }
  return box;
}
function selectOf(values, current, onChange) {
  const list = values.includes(current) || !current ? values : [current, ...values];
  return h('select', { onchange: e => onChange(e.target.value) }, ...list.map(v => h('option', { value: v, selected: v === current }, v)));
}

/** Shuttle price calculator: estimate (sum of StaticPrice of the open grid) × (1 + markup), rounding, manual price.
 *  price: the current vessel price (0 = computed). onChange(price) after every change. Returns {el, price()}. */
export function priceCalculator(price, onChange) {
  const base0 = Math.round(stats(M()).price);
  const calc = { base: base0, markup: +(localStorage.getItem('ss14mapper.markup') ?? 5), round: 100, manual: !!price, price: +price || 0 };
  if (price && base0 > 0) calc.markup = Math.max(0, Math.round(((+price / base0) - 1) * 100 / 5) * 5);
  const computed = () => {
    const raw = calc.base * (1 + calc.markup / 100);
    return calc.round > 1 ? Math.ceil(raw / calc.round) * calc.round : Math.ceil(raw);
  };
  if (!calc.manual) calc.price = computed();

  const priceIn = h('input', { type: 'number', value: calc.price, style: 'width:110px' });
  const pctLabel = h('b', {});
  const warn = h('span', { class: 'muted', style: 'font-size:11px' });
  const upd = () => {
    if (!calc.manual) { calc.price = computed(); priceIn.value = calc.price; }
    const real = calc.base > 0 ? (calc.price / calc.base - 1) * 100 : 0;
    pctLabel.textContent = `${calc.markup}%`;
    warn.textContent = calc.base > 0
      ? `фактическая наценка ${real.toFixed(1)}%` + (real < 0 ? ' — цена ниже оценки!' : real > 150 ? ' — выше maxPriceMarkup 2.5 (Mono)' : '')
      : '';
    warn.style.color = real < 0 || real > 150 ? 'var(--bad)' : '';
    if (onChange) onChange(calc.price);
  };
  priceIn.oninput = () => { calc.manual = true; calc.price = +priceIn.value || 0; manualChk.checked = true; upd(); };
  const manualChk = h('input', { type: 'checkbox', checked: calc.manual, onchange: e => { calc.manual = e.target.checked; upd(); } });
  const slider = h('input', { type: 'range', min: 0, max: 200, step: 5, value: calc.markup, style: 'flex:1' });
  const pctSel = h('select', {}, ...Array.from({ length: 41 }, (_, i) => i * 5).map(v => h('option', { value: v, selected: v === calc.markup }, v + '%')));
  const setPct = v => {
    calc.markup = Math.max(0, Math.min(200, Math.round(v / 5) * 5));
    slider.value = calc.markup; pctSel.value = calc.markup;
    calc.manual = false; manualChk.checked = false;
    localStorage.setItem('ss14mapper.markup', calc.markup);
    upd();
  };
  slider.oninput = () => setPct(+slider.value);
  pctSel.onchange = () => setPct(+pctSel.value);
  const baseIn = h('input', { type: 'number', value: calc.base, style: 'width:110px', oninput: e => { calc.base = +e.target.value || 0; upd(); } });
  const roundSel = h('select', { onchange: e => { calc.round = +e.target.value; upd(); } },
    ...[[1, 'без округления'], [10, 'до 10'], [100, 'до 100'], [500, 'до 500'], [1000, 'до 1000']].map(([v, n]) => h('option', { value: v, selected: v === calc.round }, n)));
  const el = h('div', {},
    h('div', { class: 'row' }, 'Оценка (StaticPrice)', baseIn, h('button', { title: 'Пересчитать по карте', onclick: () => { calc.base = Math.round(stats(M()).price); baseIn.value = calc.base; upd(); } }, '↻'), 'округление', roundSel),
    h('div', { class: 'row' }, 'Наценка', slider, pctSel, pctLabel),
    h('div', { class: 'row' }, 'Цена', priceIn, h('label', { class: 'chk' }, manualChk, 'вручную'), warn),
    h('p', { class: 'muted', style: 'font-size:11px' }, 'Оценка — сумма StaticPrice сущностей; реальную стоимость в игре считает аппрейзер (материалы, содержимое и т.п.). Наценка выбирается с шагом 5%.'));
  upd();
  return { el, price: () => calc.price };
}

export async function vesselDialog() {
  const model = M();
  const en = await vesselEnums();
  const ex = (model.doc.vessels || [])[0] || {};
  const path = model.path ? '/' + model.path : '/SharedMaps/_Mono/Shuttles/Civilian/newshuttle.yml';
  const fileId = path.split('/').pop().replace(/\.yml$/, '');
  const f = {
    id: ex.id || fileId.charAt(0).toUpperCase() + fileId.slice(1), name: ex.name || fileId, description: ex.description || '',
    category: ex.category || 'Small', group: ex.group || 'Shipyard',
    shuttlePath: ex.shuttlePath || path, classes: Array.isArray(ex.class) ? ex.class : [], engines: Array.isArray(ex.engine) ? ex.engine : [],
    gameMap: !ex.id, stationProto: 'StandardFrontierVessel', price: 0,
  };
  const out = h('textarea', { rows: 14 });
  const upd = () => { out.value = vesselYaml(f); };
  const calc = priceCalculator(ex.price, p => { f.price = p; upd(); });

  const inp = k => h('input', { class: 'grow', value: f[k], oninput: e => { f[k] = e.target.value; upd(); } });
  const savePath = h('input', { class: 'grow', value: `Prototypes/_Mono/Shipyard/${(f.shuttlePath.split('/').slice(-2, -1)[0] || 'Civilian')}/${fileId}.yml` });
  const body = h('div', {},
    h('div', { class: 'row' }, 'id', inp('id'), 'Название', inp('name')),
    h('div', { class: 'row' }, 'Описание', inp('description')),
    h('div', { class: 'row' },
      'Категория', selectOf(en.category || ['Micro', 'Small', 'Medium', 'Large'], f.category, v => { f.category = v; upd(); }),
      'Группа', selectOf(en.group || ['Shipyard'], f.group, v => { f.group = v; upd(); })),
    h('h4', {}, 'Классы'), chips(en.class || [], f.classes, v => { f.classes = v; upd(); }),
    h('h4', {}, 'Двигатели'), chips(en.engine || [], f.engines, v => { f.engines = v; upd(); }),
    h('h4', {}, 'Калькулятор цены'), calc.el,
    h('div', { class: 'row' }, 'shuttlePath', inp('shuttlePath')),
    h('div', { class: 'row' }, h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: f.gameMap, onchange: e => { f.gameMap = e.target.checked; upd(); } }), 'добавить gameMap'), 'stationProto', inp('stationProto')),
    out,
    h('div', { class: 'row' }, h('button', { onclick: () => { navigator.clipboard.writeText(out.value); toast('Скопировано', 'ok'); } }, 'Копировать'),
      savePath, h('button', { onclick: async () => {
        try { await api.post('/api/writefile', { path: savePath.value, text: out.value }); toast('Записано: ' + savePath.value, 'ok'); } catch (e) { toast(e.message, 'err'); }
      } }, 'Записать файл')));
  upd();
  modal('Прототип вессела (Shipyard)', body);
}

export function newDialog(create) {
  const name = h('input', { class: 'grow', value: 'NewShuttle' });
  const body = h('div', {}, h('div', { class: 'row' }, 'Имя грида', name),
    h('p', { class: 'muted' }, 'Создаётся грид с компонентами шаттла (Shuttle, Gravity, DecalGrid, GridAtmosphere…) и одним тайлом Plating в начале координат.'),
    h('div', { class: 'row' }, h('button', { class: 'on', onclick: () => { closeModal(); create(name.value); } }, 'Создать')));
  modal('Новый шаттл', body);
}

export function helpDialog() {
  const rows = [
    ['ЛКМ / ПКМ', 'действие инструмента / стирание (для кистей, труб, кабелей, прототипов)'],
    ['Колесо, средняя кнопка, Пробел+тянуть', 'масштаб / перемещение вида'],
    ['M W V B E D G X I', 'выделение, палочка, инспектор, тайлы, прототипы, декали, заливка, ластик, пипетка'],
    ['C P U N L H', 'кабели, трубы, утилизация, случайная кисть, линейка, рука'],
    ['1 / 2 / 3 / 4', 'режимы: обычный / проводка / атмос / утилизация'],
    ['R / Shift+R, T', 'утилизация: над развилкой — сменить выход / тип (развилка, маршрутизатор, сигнальный; прямая ↔ сортировщик)'],
    ['Shift+клик в палитре', 'добавить элемент в активную свою палитру / убрать из неё'],
    ['R / Shift+R', 'поворот размещаемого прототипа / декали / вставки'],
    ['[ / ]', 'размер кисти'],
    ['Alt+клик', 'пипетка в любом инструменте'],
    ['Ctrl+Z / Ctrl+Y', 'отмена / повтор'],
    ['Ctrl+C / X / V', 'копировать / вырезать / вставить (в режиме вставки R, H, J — поворот и отражения)'],
    ['Ctrl+A, Esc, Del', 'выделить всё, снять выделение, удалить содержимое'],
    ['F / Shift+F', 'залить выделение / контур выделения текущим прототипом'],
    ['Ctrl+R, Shift+H, Shift+J', 'повернуть / отразить выделение'],
    ['Ctrl+S, Ctrl+O, Ctrl+H', 'сохранить, открыть, поиск и замена'],
    ['F2', 'названия и описания (с выбранной сущностью); в редакторе бумаги Ctrl+B / I / U — теги, Ctrl+Enter — применить'],
    ['Home', 'показать весь грид'],
    ['Линейки', 'тяните с линейки — направляющая; обратно — удалить'],
  ];
  modal('Горячие клавиши', h('div', { class: 'help-grid' }, ...rows.flatMap(([k, v]) => [h('kbd', {}, k), h('span', {}, v)])));
}
