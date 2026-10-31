// Panels, palette, tool options and dialogs.
import { S, on, emit, toast, savePrefs } from './state.js';
import { P, search, displayName, ent as protoOf } from './protos.js';
import * as A from './assets.js';
import * as O from './ops.js';
import { TOOLS, TOOL_ORDER, setTool, setMode, startPaste, fillCells } from './tools.js';
import * as TL from './tools.js';
import * as L from './links.js';
import { requestDraw, centerOn, fitToContent, bake } from './view.js';
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
export function modal(title, body, onClose) {
  $('modalTitle').textContent = title;
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
  on('mode', renderToolOptions);
}

// ===================================================================== tool options
const PIPE_COLORS = [['#0055CCFF', 'Подача'], ['#990000FF', 'Отходы'], ['#03FCD3FF', 'Смесь'], ['#FF1212FF', 'Плазма'], ['#FFEB3BFF', 'Азот/O₂'], ['#947507FF', 'Топливо'], ['#FFFFFFFF', 'Белый']];
function chk(label, obj, k, after) {
  return h('label', {}, h('input', { type: 'checkbox', checked: !!obj[k], onchange: e => { obj[k] = e.target.checked; savePrefs(); after && after(); requestDraw(); } }), label);
}
export function renderToolOptions() {
  const box = $('toolOptions');
  box.innerHTML = '';
  const t = TOOLS[S.tool];
  const opts = (t && t.options) || [];
  const add = (...els) => box.append(...els);
  if (opts.includes('brush')) {
    add(h('label', {}, 'Кисть', h('input', { type: 'range', min: 1, max: 9, value: S.brush, oninput: e => { S.brush = +e.target.value; e.target.nextSibling.textContent = S.brush; requestDraw(); } }), String(S.brush)));
  }
  if (opts.includes('variant')) add(chk('случайный вариант', S.tileOpts, 'randomVariant'));
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
  if (opts.includes('devices') && (S.tool !== 'entity' || S.mode !== 'normal')) deviceBar(add);
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
const deviceCache = {};
function devicesFor(mode) {
  if (deviceCache[mode]) return deviceCache[mode];
  const all = [...P.ents.values()].filter(p => !p.hidden && !p.donotmap);
  deviceCache[mode] = (DEVICE_GROUPS[mode] || []).map(([name, f]) => [name,
    all.filter(f).sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id)).slice(0, 8)]).filter(g => g[1].length);
  return deviceCache[mode];
}
function deviceBar(add) {
  const mode = S.mode === 'normal' ? (S.tool === 'wire' ? 'wiring' : 'atmos') : S.mode;
  const bar = h('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;align-items:center;width:100%' });
  if (S.tool === 'entity') bar.append(h('button', { onclick: () => setTool(mode === 'wiring' ? 'wire' : 'pipe') }, mode === 'wiring' ? '⚡ к кабелям' : '◎ к трубам'));
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
  kindSeg.querySelectorAll('button').forEach(b => b.onclick = () => { setPalKind(b.dataset.kind); });
  $('palSearch').oninput = () => renderPalette();
  $('palCat').onchange = () => renderPalette();
  $('palHidden').onchange = () => renderPalette();
  palObserver = new IntersectionObserver(entries => {
    for (const en of entries) if (en.isIntersecting) { const img = en.target; if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; } palObserver.unobserve(img); }
  }, { root: $('palGrid') });
  on('pick', kind => { setPalKind(kind, true); });
  on('recent', renderRecent);
  setPalKind(S.palKind);
}
export function setPalKind(kind, keepSearch) {
  S.palKind = kind;
  $('palKind').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.kind === kind));
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
  S.sel[kind] = id;
  savePrefs();
  const tool = kind === 'tile' ? 'tile' : kind === 'decal' ? 'decal' : 'entity';
  if (!['fill', 'random', 'select', 'wand'].includes(S.tool) || kind !== S.palKind) setTool(tool);
  S.palKind = kind;
  for (const el of document.querySelectorAll('.pi')) el.classList.toggle('sel', el.dataset.id === id && el.dataset.kind === kind);
  showInfo(kind, id);
  renderToolOptions();
}
function showInfo(kind, id) {
  const p = kind === 'tile' ? P.tiles.get(id) : kind === 'decal' ? P.decals.get(id) : P.ents.get(id);
  if (!p) { $('palInfo').textContent = ''; return; }
  let extra = '';
  if (kind === 'entity') extra = ` · ${p.cat}${p.price ? ' · ' + p.price + '$' : ''}${p.sm ? ' · smooth:' + p.sm.key : ''}${p.cable ? ' · ' + p.cable : ''}${p.pipe !== undefined ? ' · труба' : ''}`;
  if (kind === 'tile') extra = ` · вариантов ${p.variants}${p.subfloor ? ' · подпол' : ''}`;
  $('palInfo').innerHTML = '';
  $('palInfo').append(h('b', {}, id), h('br'), displayName(kind, id) + extra);
}
function palItem(kind, p, small) {
  const set = O.activeSet();
  const inset = set && set.kind === kind && set.items.some(i => i.id === p.id);
  const el = h('div', { class: 'pi' + (selectedId(kind) === p.id ? ' sel' : '') + (inset ? ' inset' : ''), title: displayName(kind, p.id) + '\n' + p.id + '\nCtrl+клик — в набор рандома', onclick: ev => selectItem(kind, p.id, ev) },
    itemImg(kind, p.id), small ? null : h('div', { class: 'lbl' }, p.id));
  el.dataset.id = p.id;
  el.dataset.kind = kind;
  return el;
}
export function renderPalette() {
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
  pipes: 'Трубы', wires: 'Кабели', markers: 'Маркеры / спавны', grid: 'Сетка', chunks: 'Границы чанков (16×16)',
  leaks: 'Утечки атмосферы', openEnds: 'Открытые концы труб (атмос)', placeholders: 'Заглушки без спрайта',
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
  gl.append(h('div', { class: 'muted' }, 'Голубая линия — направляющая: тащите её мышью, ПКМ по ней или перенос на линейку — удалить, клик по ⌗ в углу — удалить все. Фиолетовый пунктир — ось зеркала (кнопки ⇋ X / ⇵ Y).'));
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
    h('button', { onclick: addPresets, title: 'Создать готовые наборы из прототипов репозитория' }, 'Пресеты')));
  box.append(h('p', { class: 'muted' }, 'Ctrl+клик в палитре добавляет элемент в активный набор. Кисть 🎲 (N) рисует набором, в выделении — «Рассыпать».'));
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
        h('button', { class: 'danger', onclick: () => { R.sets.splice(i, 1); R.active = 0; savePrefs(); renderRandom(); } }, '✕')),
      h('div', { class: 'row' },
        set.kind !== 'tile' ? chk('случ. поворот', set, 'randRot') : null,
        set.kind !== 'tile' ? chk('смещение', set, 'jitter') : null,
        set.kind === 'decal' ? h('input', { type: 'color', value: (set.color || '#FFFFFF').slice(0, 7), onchange: e => { set.color = e.target.value.toUpperCase() + 'FF'; savePrefs(); } }) : null),
      items));
  });
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
export async function openDialog(loadMap) {
  const body = h('div', {});
  const filter = h('input', { type: 'search', placeholder: 'Фильтр (например _Mono/Shuttles)', class: 'grow' });
  const list = h('div', { class: 'list' }, h('div', { class: 'li muted' }, 'Загрузка…'));
  body.append(h('div', { class: 'row' }, filter), list);
  const close = modal('Открыть карту грида', body);
  let maps = [];
  try { maps = await api.get('/api/maps'); } catch (e) { list.innerHTML = ''; list.append(h('div', { class: 'li' }, e.message)); return; }
  const render = () => {
    list.innerHTML = '';
    const q = filter.value.toLowerCase();
    for (const m of maps.filter(m => m.path.toLowerCase().includes(q)).slice(0, 400)) {
      list.append(h('div', { class: 'li', onclick: () => { close(); loadMap(m.path); } }, h('span', {}, m.path), h('span', { class: 'muted' }, Math.round(m.size / 1024) + ' КБ')));
    }
  };
  filter.oninput = render;
  render();
  filter.focus();
}

export function saveDialog(doSave, asNew) {
  const model = M();
  const isNew = !model.path;
  const path = h('input', { class: 'grow', value: model.path || 'SharedMaps/_Mono/Shuttles/Civilian/newshuttle.yml' });
  const regen = h('input', { type: 'checkbox', checked: isNew || !!model.doc.regenAtmos });
  const mix = h('select', {}, h('option', { value: 'air' }, 'Воздух 293K'), h('option', { value: 'freezer' }, 'Холодильник 235K'), h('option', { value: 'vacuum' }, 'Вакуум'));
  const exposed = h('input', { type: 'checkbox', checked: true });
  const gname = h('input', { class: 'grow', value: (model.doc.gridEnt.components.find(c => c.type === 'MetaData') || {}).name || 'grid' });
  const body = h('div', {},
    h('div', { class: 'row' }, 'Путь (от Resources/):', path),
    h('div', { class: 'row' }, 'Имя грида (MetaData):', gname),
    h('h4', {}, 'Атмосфера'),
    h('div', { class: 'row' }, h('label', { class: 'chk' }, regen, 'Пересоздать GridAtmosphere (как fixgridatmos)'), mix),
    h('div', { class: 'row' }, h('label', { class: 'chk' }, exposed, 'Тайлы с выходом в космос — вакуум')),
    h('p', { class: 'muted' }, 'Файл пишется прямо в репозиторий. Неизвестные компоненты и поля сохраняются без изменений.'),
    h('div', { class: 'row' }, h('button', { class: 'on', onclick: go }, 'Сохранить'), h('button', { onclick: () => closeModal() }, 'Отмена')));
  modal(asNew || isNew ? 'Сохранить как' : 'Сохранить', body);
  path.focus();
  async function go() {
    const md = model.doc.gridEnt.components.find(c => c.type === 'MetaData');
    if (md) md.name = gname.value;
    closeModal();
    await doSave(path.value.trim(), { regenAtmos: regen.checked, atmos: { mix: mix.value, exposedVacuum: exposed.checked } });
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

export function mirrorDialog() {
  const ax = h('input', { type: 'number', step: 0.5, value: S.mirror.ax });
  const ay = h('input', { type: 'number', step: 0.5, value: S.mirror.ay });
  const body = h('div', {},
    h('p', { class: 'muted' }, 'Ось X — вертикальная линия x = значение (целое — граница тайлов, .5 — центр тайла). Ось Y — горизонтальная линия. При включённой оси любые кисти, трубы, кабели, вставка и прототипы зеркалируются (с корректными поворотами, Left↔Right, NE↔NW и т.п.).'),
    h('div', { class: 'row' }, h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: S.mirror.x, onchange: e => S.mirror.x = e.target.checked }), 'Ось X'), 'x =', ax),
    h('div', { class: 'row' }, h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: S.mirror.y, onchange: e => S.mirror.y = e.target.checked }), 'Ось Y'), 'y =', ay),
    h('div', { class: 'row' },
      h('button', { onclick: () => { const b = M().bounds(); if (b) { ax.value = (b.minx + b.maxx + 1) / 2; ay.value = (b.miny + b.maxy + 1) / 2; } } }, 'По центру грида'),
      h('button', { onclick: () => { if (S.selection.size) { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (const k of S.selection) { const [x, y] = unkey(k); a = Math.min(a, x); b = Math.max(b, x + 1); c = Math.min(c, y); d = Math.max(d, y + 1); } ax.value = (a + b) / 2; ay.value = (c + d) / 2; } } }, 'По центру выделения'),
      h('button', { onclick: () => { if (S.hoverTile) { ax.value = S.hoverTile[0] + 0.5; ay.value = S.hoverTile[1] + 0.5; } } }, 'По тайлу под курсором')),
    h('div', { class: 'row' }, h('button', { class: 'on', onclick: () => { S.mirror.ax = +ax.value; S.mirror.ay = +ay.value; closeModal(); emit('mirror'); requestDraw(); } }, 'Применить')));
  modal('Оси зеркалирования', body);
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
function chips(values, selected, onChange) {
  const box = h('div', { class: 'chips' });
  const sel = new Set(selected);
  for (const v of [...new Set([...values, ...selected])]) {
    const lab = h('label', { class: sel.has(v) ? 'on' : '' },
      h('input', { type: 'checkbox', checked: sel.has(v), onchange: e => {
        if (e.target.checked) sel.add(v); else sel.delete(v);
        lab.classList.toggle('on', e.target.checked);
        onChange([...values, ...selected].filter((x, i, a) => sel.has(x) && a.indexOf(x) === i));
      } }), v);
    box.append(lab);
  }
  return box;
}
function selectOf(values, current, onChange) {
  const list = values.includes(current) || !current ? values : [current, ...values];
  return h('select', { onchange: e => onChange(e.target.value) }, ...list.map(v => h('option', { value: v, selected: v === current }, v)));
}

export async function vesselDialog() {
  const model = M();
  const en = await vesselEnums();
  const ex = (model.doc.vessels || [])[0] || {};
  const s = stats(model);
  const path = model.path ? '/' + model.path : '/SharedMaps/_Mono/Shuttles/Civilian/newshuttle.yml';
  const fileId = path.split('/').pop().replace(/\.yml$/, '');
  const base0 = Math.round(s.price);
  const savedMarkup = +(localStorage.getItem('ss14mapper.markup') ?? 5);
  const f = {
    id: ex.id || fileId.charAt(0).toUpperCase() + fileId.slice(1), name: ex.name || fileId, description: ex.description || '',
    category: ex.category || 'Small', group: ex.group || 'Shipyard',
    shuttlePath: ex.shuttlePath || path, classes: Array.isArray(ex.class) ? ex.class : [], engines: Array.isArray(ex.engine) ? ex.engine : [],
    gameMap: !ex.id, stationProto: 'StandardFrontierVessel',
  };
  const calc = { base: base0, markup: savedMarkup, round: 100, manual: !!ex.price, price: +ex.price || 0 };
  if (ex.price && base0 > 0) calc.markup = Math.max(0, Math.round(((+ex.price / base0) - 1) * 100 / 5) * 5);
  const computed = () => {
    const raw = calc.base * (1 + calc.markup / 100);
    return calc.round > 1 ? Math.ceil(raw / calc.round) * calc.round : Math.ceil(raw);
  };
  if (!calc.manual) calc.price = computed();

  const out = h('textarea', { rows: 14 });
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
    out.value = vesselYaml({ ...f, price: calc.price });
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
    h('h4', {}, 'Калькулятор цены'),
    h('div', { class: 'row' }, 'Оценка (StaticPrice)', baseIn, h('button', { title: 'Пересчитать по карте', onclick: () => { calc.base = Math.round(stats(M()).price); baseIn.value = calc.base; upd(); } }, '↻'), 'округление', roundSel),
    h('div', { class: 'row' }, 'Наценка', slider, pctSel, pctLabel),
    h('div', { class: 'row' }, 'Цена', priceIn, h('label', { class: 'chk' }, manualChk, 'вручную'), warn),
    h('div', { class: 'row' }, 'shuttlePath', inp('shuttlePath')),
    h('div', { class: 'row' }, h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: f.gameMap, onchange: e => { f.gameMap = e.target.checked; upd(); } }), 'добавить gameMap'), 'stationProto', inp('stationProto')),
    h('p', { class: 'muted', style: 'font-size:11px' }, 'Оценка — сумма StaticPrice сущностей; реальную стоимость в игре считает аппрейзер (материалы, содержимое и т.п.). Наценка выбирается с шагом 5%.'),
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
    ['C P N L H', 'кабели, трубы, случайная кисть, линейка, рука'],
    ['1 / 2 / 3', 'режимы: обычный / проводка / атмос'],
    ['R / Shift+R', 'поворот размещаемого прототипа / декали / вставки'],
    ['[ / ]', 'размер кисти'],
    ['Alt+клик', 'пипетка в любом инструменте'],
    ['Ctrl+Z / Ctrl+Y', 'отмена / повтор'],
    ['Ctrl+C / X / V', 'копировать / вырезать / вставить (в режиме вставки R, H, J — поворот и отражения)'],
    ['Ctrl+A, Esc, Del', 'выделить всё, снять выделение, удалить содержимое'],
    ['F / Shift+F', 'залить выделение / контур выделения текущим прототипом'],
    ['Ctrl+R, Shift+H, Shift+J', 'повернуть / отразить выделение'],
    ['Ctrl+S, Ctrl+O, Ctrl+H', 'сохранить, открыть, поиск и замена'],
    ['Home', 'показать весь грид'],
    ['Линейки', 'тяните с линейки — направляющая; обратно — удалить'],
  ];
  modal('Горячие клавиши', h('div', { class: 'help-grid' }, ...rows.flatMap(([k, v]) => [h('kbd', {}, k), h('span', {}, v)])));
}
