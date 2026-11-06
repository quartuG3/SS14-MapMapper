// Entry point: bootstraps UI, input handling, loading/saving and autosave.
import { S, on, emit, toast, loadPrefs, savePrefs } from './state.js';
import { loadProtos, P } from './protos.js';
import { Model } from './model.js';
import { initView, requestDraw, s2w, w2s, zoomAt, fitToContent, size } from './view.js';
import { TOOLS, setTool, setMode, startPaste, pickAt, paste, rotateBrushTile } from './tools.js';
import * as UI from './ui.js';
import * as TX from './texts.js';
import { key, unkey, tileOf } from './logic.js';
import { activePreset } from './symmetry.js';
import { loadPalettes } from './palettes.js';
import { pipelinesDialog } from './pipelines.js';
import { setOnProgress } from './assets.js';

const $ = id => document.getElementById(id);
const api = UI.api;

// ===================================================================== load bar
// Bottom progress bar: indeterminate while the map file is fetched/parsed, then done/total of sprite requests.
let mapLoading = false, spritesDone = 0, spritesTotal = 0;
function renderLoadBar() {
  const bar = $('loadBar'), label = $('stLoad');
  const busy = mapLoading, sprites = spritesTotal > 0;
  bar.classList.toggle('hidden', !busy && !sprites);
  bar.classList.toggle('busy', busy);
  bar.firstElementChild.style.width = busy ? '' : (sprites ? (100 * spritesDone / spritesTotal).toFixed(1) + '%' : '0');
  label.textContent = busy ? 'Загрузка карты…' : sprites ? `Загрузка спрайтов: ${spritesDone}/${spritesTotal}` : '';
}
setOnProgress((done, total) => { spritesDone = done; spritesTotal = total; renderLoadBar(); });
function setMapLoading(v) { mapLoading = v; renderLoadBar(); }

// ===================================================================== documents
function setModel(doc) {
  S.model = new Model(doc);
  S.selection = new Set();
  S.inspected = null;
  S.markers = [];
  S.leaks = new Set();
  S.model.on(() => { requestDraw(); scheduleSideRefresh(); });
  $('docTitle').textContent = doc.path || 'новый шаттл (не сохранён)';
  UI.renderGridPicker(doc, loadMap);
  if (doc.renumbered && doc.renumbered.length) toast(`В файле повторялись uid: ${doc.renumbered.length} сущностей получили новые uid (иначе они потерялись бы при сохранении)`, 'err', 10000);
  if (doc.migrated && Object.keys(doc.migrated).length) toast('Применены миграции прототипов: ' + Object.keys(doc.migrated).length, '', 6000);
  const unknown = new Set([...S.model.ents.values()].filter(e => !P.ents.has(e.proto)).map(e => e.proto));
  if (unknown.size) toast('Неизвестные прототипы: ' + [...unknown].slice(0, 6).join(', ') + (unknown.size > 6 ? '…' : ''), 'err', 8000);
  fitToContent();
  UI.updateStatus();
  UI.renderInspector();
  emit('doc');
}
let sideTimer = null;
function scheduleSideRefresh() {
  clearTimeout(sideTimer);
  sideTimer = setTimeout(() => {
    UI.updateStatus();
    if (S.layers.leaks) UI.refreshLeaks();
    if ($('tab-stats').classList.contains('on')) UI.renderStats();
  }, 250);
}

/** Open a map file; grid: uid of the grid to edit in a file with several grids (default: the largest). */
async function loadMap(path, grid) {
  if (S.model && S.model.dirty && !confirm('Есть несохранённые изменения. Открыть другую карту?')) return;
  toast('Загрузка ' + path + '…');
  setMapLoading(true);
  try {
    const r = await fetch('/api/map?path=' + encodeURIComponent(path) + (grid ? '&grid=' + encodeURIComponent(grid) : ''));
    const doc = await r.json();
    if (!r.ok) throw new Error(doc.error);
    setModel(doc);
    const multi = (doc.gridList || []).length > 1 ? ` (грид #${doc.gridUid} из ${doc.gridList.length})` : '';
    toast(`Открыто: ${path}${multi} — ${doc.tiles.length} тайлов, ${doc.entities.length} сущностей`, 'ok');
    localStorage.setItem('ss14mapper.last', path);
    localStorage.setItem('ss14mapper.lastGrid', multi ? doc.gridUid : '');
  } catch (e) { toast('Ошибка загрузки: ' + e.message, 'err', 8000); }
  finally { setMapLoading(false); }
}

async function newMap(name) {
  if (S.model && S.model.dirty && !confirm('Есть несохранённые изменения. Создать новый шаттл?')) return;
  const doc = await api.get('/api/new?name=' + encodeURIComponent(name || 'grid'));
  doc.tiles = [[0, 0, 'Plating', 0, 0, 0]];
  setModel(doc);
}

function downloadText(text, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/yaml' }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function save(path, opts) {
  const model = S.model;
  try {
    const doc = model.toDoc();
    if (!path.endsWith('.yml')) throw new Error('путь должен заканчиваться на .yml');
    let msg;
    if (opts.toRepo) {
      const r = await api.post('/api/save', { doc, path, regenAtmos: opts.regenAtmos, atmos: opts.atmos });
      msg = `Сохранено: ${r.path} (${Math.round(r.bytes / 1024)} КБ)`;
    } else {
      const text = await api.post('/api/save', { doc, write: false, regenAtmos: opts.regenAtmos, atmos: opts.atmos });
      const name = path.split('/').pop();
      downloadText(text, name);
      msg = `Скачано: ${name} (${Math.round(text.length / 1024)} КБ)`;
    }
    model.path = path;
    model.doc.path = path;
    model.savedVersion = model.version;
    model.doc.regenAtmos = opts.regenAtmos;
    $('docTitle').textContent = path;
    toast(msg, 'ok');
    localStorage.setItem('ss14mapper.last', path);
    UI.updateStatus();
  } catch (e) { toast('Ошибка сохранения: ' + e.message, 'err', 8000); }
}
let lastSaveOpts = null;
function quickSave() {
  if (!S.model) return;
  if (!S.model.path || !lastSaveOpts) { UI.saveDialog(async (p, o) => { lastSaveOpts = o; await save(p, o); }); return; }
  save(S.model.path, lastSaveOpts);
}
async function downloadYml() {
  try {
    const text = await api.post('/api/save', { doc: S.model.toDoc(), write: false, regenAtmos: !!S.model.doc.regenAtmos });
    downloadText(text, (S.model.path || 'shuttle.yml').split('/').pop());
  } catch (e) { toast(e.message, 'err'); }
}

// ===================================================================== input
let panning = null;
let guideDrag = null;
let spaceDown = false;
function guideAt(sx, sy) {
  for (const g of S.guides) {
    const [gx, gy] = w2s(g.axis === 'x' ? g.v : 0, g.axis === 'y' ? g.v : 0);
    if (g.axis === 'x' ? Math.abs(sx - gx) <= 4 : Math.abs(sy - gy) <= 4) return g;
  }
  return null;
}
let activeButton = -1;
function pointerInfo(ev) {
  const r = $('view').getBoundingClientRect();
  const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
  const [wx, wy] = s2w(sx, sy);
  const [tx, ty] = tileOf(wx, wy);
  return { sx, sy, wx, wy, tx, ty, ev, button: activeButton >= 0 ? activeButton : ev.button };
}
function bindCanvas() {
  const cv = $('view');
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', ev => {
    if (!S.model) return;
    cv.focus();
    try { cv.setPointerCapture(ev.pointerId); } catch { /* synthetic events */ }
    if (ev.button === 1 || (ev.button === 0 && spaceDown)) { panning = [ev.clientX, ev.clientY, S.view.cx, S.view.cy]; ev.preventDefault(); return; }
    const i = pointerInfo(ev);
    const g = !spaceDown && guideAt(i.sx, i.sy);
    if (g && ev.button === 2) { S.guides.splice(S.guides.indexOf(g), 1); requestDraw(); return; }
    if (g && ev.button === 0 && !ev.ctrlKey && !ev.shiftKey) { guideDrag = g; return; }
    activeButton = ev.button;
    if (ev.altKey && ev.button === 0 && !['select', 'wand', 'pick', 'paste'].includes(S.tool)) { pickAt(i.tx, i.ty, ev); activeButton = -1; return; }
    const t = TOOLS[S.tool];
    if (t && t.down) t.down(i);
  });
  cv.addEventListener('pointermove', ev => {
    if (!S.model) return;
    if (panning) {
      S.view.cx = panning[2] - (ev.clientX - panning[0]) / S.view.z;
      S.view.cy = panning[3] + (ev.clientY - panning[1]) / S.view.z;
      requestDraw();
      return;
    }
    const i = pointerInfo(ev);
    if (guideDrag) {
      guideDrag.v = Math.round((guideDrag.axis === 'x' ? i.wx : i.wy) * 2) / 2;
      requestDraw();
      return;
    }
    const hg = guideAt(i.sx, i.sy);
    cv.style.cursor = hg ? (hg.axis === 'x' ? 'ew-resize' : 'ns-resize') : '';
    const prev = S.hoverTile;
    S.hoverWorld = [i.wx, i.wy];
    S.hoverTile = [i.tx, i.ty];
    S.shiftDown = ev.shiftKey;
    const t = TOOLS[S.tool];
    if (t && t.move) t.move(i);
    if (!prev || prev[0] !== i.tx || prev[1] !== i.ty) {
      UI.updateStatus();
      if (!S.inspected && $('tab-inspector').classList.contains('on')) UI.renderInspector();
    }
    requestDraw();
  });
  const up = ev => {
    if (panning) { panning = null; return; }
    if (guideDrag) {
      const r = cv.getBoundingClientRect();
      if (ev.clientX < r.left || ev.clientY < r.top || ev.clientX > r.right || ev.clientY > r.bottom) {
        S.guides.splice(S.guides.indexOf(guideDrag), 1);
        toast('Направляющая удалена');
      }
      guideDrag = null;
      requestDraw();
      return;
    }
    if (activeButton < 0) return;
    const i = pointerInfo(ev);
    const t = TOOLS[S.tool];
    if (t && t.up) t.up(i);
    activeButton = -1;
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('pointerleave', () => { S.hoverTile = null; S.hoverWorld = null; requestDraw(); });
  cv.addEventListener('wheel', ev => {
    ev.preventDefault();
    const r = cv.getBoundingClientRect();
    zoomAt(ev.clientX - r.left, ev.clientY - r.top, ev.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  // rulers -> guides; the purple marker on a ruler drags the mirror axis
  for (const [id, axis] of [['rulerTop', 'y'], ['rulerLeft', 'x']]) {
    const mAxis = axis === 'y' ? 'x' : 'y';
    const along = e => { const r = cv.getBoundingClientRect(); return mAxis === 'x' ? e.clientX - r.left : e.clientY - r.top; };
    $(id).addEventListener('pointermove', ev => { $(id).style.cursor = mirrorHandleAt(mAxis, along(ev)) ? (mAxis === 'x' ? 'ew-resize' : 'ns-resize') : ''; });
    $(id).addEventListener('pointerdown', ev => {
      ev.preventDefault();
      if (S.model && ev.button === 0 && mirrorHandleAt(mAxis, along(ev))) { dragMirrorAxis(mAxis); return; }
      const g = { axis, v: 0 };
      S.guides.push(g);
      const move = e => {
        const r = cv.getBoundingClientRect();
        const [wx, wy] = s2w(e.clientX - r.left, e.clientY - r.top);
        g.v = Math.round((axis === 'x' ? wx : wy) * 2) / 2;
        requestDraw();
      };
      const fin = e => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', fin);
        const r = cv.getBoundingClientRect();
        if (e.clientX < r.left || e.clientY < r.top) S.guides.splice(S.guides.indexOf(g), 1);
        requestDraw();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', fin);
      move(ev);
    });
  }
  $('rulerCorner').addEventListener('click', () => {
    if (!S.guides.length) return;
    S.guides.length = 0;
    toast('Направляющие удалены');
    requestDraw();
  });
}

function mirrorHandleAt(axis, p) {
  if (!S.mirror[axis]) return false;
  const q = axis === 'x' ? w2s(S.mirror.ax, 0)[0] : w2s(0, S.mirror.ay)[1];
  return Math.abs(p - q) <= 8;
}
function dragMirrorAxis(axis) {
  const cv = $('view');
  S.mirrorDrag = axis;
  const move = e => {
    const r = cv.getBoundingClientRect();
    const [wx, wy] = s2w(e.clientX - r.left, e.clientY - r.top);
    const v = Math.round((axis === 'x' ? wx : wy) * 2) / 2;
    if (axis === 'x') S.mirror.ax = v; else S.mirror.ay = v;
    $('stMsg').textContent = `Ось ${axis.toUpperCase()}: ${axis} = ${v}`;
    requestDraw();
  };
  const fin = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', fin);
    S.mirrorDrag = null;
    emit('mirror');
    requestDraw();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', fin);
}

function isTyping(ev) {
  const t = ev.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
}
const KEYMAP = {};
function bindKeys() {
  for (const [id, t] of Object.entries(TOOLS)) if (t.hotkey) KEYMAP[t.hotkey] = id;
  // russian layout aliases
  const ru = { k: 'л', m: 'ь', w: 'ц', v: 'м', b: 'и', e: 'у', d: 'в', g: 'п', x: 'ч', i: 'ш', p: 'з', c: 'с', n: 'т', l: 'д', h: 'р', u: 'г' };
  for (const [en, r] of Object.entries(ru)) if (KEYMAP[en]) KEYMAP[r] = KEYMAP[en];

  window.addEventListener('keydown', ev => {
    if (ev.key === ' ' && !isTyping(ev)) { spaceDown = true; if (ev.target === $('view')) ev.preventDefault(); }
    if (ev.key === 'Shift') { S.shiftDown = true; requestDraw(); }
    if (isTyping(ev)) return;
    if (UI.modalOpen()) { if (ev.key === 'Escape') UI.closeModal(); return; }
    if (!S.model) return;
    const k = ev.key.toLowerCase();
    const code = ev.code;
    const ctrl = ev.ctrlKey || ev.metaKey;
    const t = TOOLS[S.tool];
    if ((!ctrl || ev.key.startsWith('Arrow')) && t && t.onKey && t.onKey(ev)) { ev.preventDefault(); requestDraw(); return; }
    const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (ARROWS[ev.key] && S.selection.size && (S.tool === 'select' || S.tool === 'wand')) {
      ev.preventDefault();
      const [dx, dy] = ARROWS[ev.key].map(v => v * (ev.shiftKey ? 5 : 1));
      UI.moveSelection(dx, dy);
      return;
    }
    if (ctrl) {
      if (code === 'KeyZ' && !ev.shiftKey) { const l = S.model.undo(); if (l) toast('Отменено: ' + l); }
      else if (code === 'KeyY' || (code === 'KeyZ' && ev.shiftKey)) { const l = S.model.redo(); if (l) toast('Повторено: ' + l); }
      else if (code === 'KeyS') quickSave();
      else if (code === 'KeyO') UI.openDialog(loadMap);
      else if (code === 'KeyC') UI.selAction('copy');
      else if (code === 'KeyX') UI.selAction('cut');
      else if (code === 'KeyV') { if (S.clipboard) startPaste(S.clipboard); }
      else if (code === 'KeyA') { S.selection = new Set([...S.model.tiles.keys(), ...S.model.byTile.keys()]); setTool('select'); emit('selection'); }
      else if (code === 'KeyR') UI.selAction('rot');
      else if (code === 'KeyH') UI.findReplaceDialog();
      else return;
      ev.preventDefault();
      requestDraw();
      return;
    }
    if (code === 'Escape') { S.selection = new Set(); S.inspected = null; S.highlight = null; emit('selection'); emit('inspect'); requestDraw(); return; }
    if (code === 'Delete' || code === 'Backspace') { if (S.selection.size) UI.selAction('delete'); return; }
    if (code === 'F1') { UI.helpDialog(); ev.preventDefault(); return; }
    if (code === 'F2') { TX.namesDialog(S.inspected); ev.preventDefault(); return; }
    if (code === 'Home') { fitToContent(); return; }
    if (code === 'BracketLeft') { S.brush = Math.max(1, S.brush - 1); UI.renderToolOptions(); requestDraw(); return; }
    if (code === 'BracketRight') { S.brush = Math.min(9, S.brush + 1); UI.renderToolOptions(); requestDraw(); return; }
    if (code === 'Digit1') { setMode('normal'); setTool('entity'); return; }
    if (code === 'Digit2') { setMode('wiring'); return; }
    if (code === 'Digit3') { setMode('atmos'); return; }
    if (code === 'Digit4') { setMode('disposal'); return; }
    if (code === 'KeyR') {
      if (S.tool === 'tile' || (S.tool === 'fill' && S.fillOpts.mode === 'tile')) { rotateBrushTile(ev.shiftKey ? 3 : 1); UI.renderToolOptions(); return; }
      if (S.tool === 'decal') S.decal.angle = (S.decal.angle + (ev.shiftKey ? -1 : 1) * Math.PI / 2) % (2 * Math.PI);
      else S.rotSteps = (S.rotSteps + (ev.shiftKey ? 3 : 1)) % 4;
      UI.renderToolOptions(); requestDraw(); return;
    }
    if (code === 'KeyF' && S.selection.size) { UI.selAction(ev.shiftKey ? 'outline' : 'fill'); return; }
    if (ev.shiftKey && code === 'KeyH' && S.selection.size) { UI.selAction('flipX'); return; }
    if (ev.shiftKey && code === 'KeyJ' && S.selection.size) { UI.selAction('flipY'); return; }
    const tool = KEYMAP[k] || KEYMAP[code.replace('Key', '').toLowerCase()];
    if (tool && !ev.shiftKey && !ev.altKey) setTool(tool);
  });
  window.addEventListener('keyup', ev => {
    if (ev.key === ' ') spaceDown = false;
    if (ev.key === 'Shift') { S.shiftDown = false; requestDraw(); }
  });
}

// ===================================================================== top menu
function bindMenu() {
  document.querySelectorAll('#topbar [data-act]').forEach(b => b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (!S.model && !['open', 'new', 'help', 'pipelines'].includes(a)) return;
    ({
      new: () => UI.newDialog(newMap),
      open: () => UI.openDialog(loadMap),
      save: quickSave,
      saveas: () => UI.saveDialog(async (p, o) => { lastSaveOpts = o; await save(p, o); }, true),
      undo: () => S.model.undo(),
      redo: () => S.model.redo(),
      mirrorX: () => { S.mirror.x = !S.mirror.x; if (S.mirror.x && S.mirror.ax === 0.5) autoAxis(); emit('mirror'); requestDraw(); },
      mirrorY: () => { S.mirror.y = !S.mirror.y; if (S.mirror.y && S.mirror.ay === 0.5) autoAxis(); emit('mirror'); requestDraw(); },
      mirrorCfg: UI.mirrorDialog,
      export: UI.exportDialog,
      downloadYml,
      validate: UI.validateDialog,
      radar: UI.radarDialog,
      findReplace: UI.findReplaceDialog,
      pipelines: () => pipelinesDialog(loadMap),
      names: () => TX.namesDialog(S.inspected),
      vessel: UI.vesselDialog,
      help: UI.helpDialog,
    })[a]?.();
  }));
  document.querySelectorAll('#modeSeg button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  on('mode', m => document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === m)));
  on('mirror', () => {
    $('btnMirrorX').classList.toggle('on', S.mirror.x);
    $('btnMirrorY').classList.toggle('on', S.mirror.y);
    const p = activePreset();
    $('btnMirrorCfg').textContent = p ? '⚙•' : '⚙';
    $('btnMirrorCfg').title = 'Настройка симметрии: оси и пресеты отражений' + (p ? `
Активный пресет: ${p.name}` : '');
  });
}
function autoAxis() {
  const b = S.model.bounds();
  if (!b) return;
  S.mirror.ax = (b.minx + b.maxx + 1) / 2;
  S.mirror.ay = (b.miny + b.maxy + 1) / 2;
}

// ===================================================================== autosave
function startAutosave() {
  let lastVersion = -1;
  setInterval(async () => {
    const m = S.model;
    if (!m || !m.dirty || m.version === lastVersion) return;
    lastVersion = m.version;
    try { await api.post('/api/autosave', { doc: m.toDoc(), time: Date.now() }); } catch { /* ignore */ }
  }, 60000);
  window.addEventListener('beforeunload', e => { if (S.model && S.model.dirty) { e.preventDefault(); e.returnValue = ''; } });
}
async function tryRestore() {
  try {
    const r = await fetch('/api/autosave');
    if (r.status !== 200) return false;
    const j = await r.json();
    const when = new Date(j.time).toLocaleString('ru-RU');
    if (!confirm(`Найдено автосохранение (${j.doc.path || 'новый шаттл'}, ${when}). Восстановить?`)) return false;
    setModel(j.doc);
    S.model.savedVersion = -1;
    return true;
  } catch { return false; }
}

// ===================================================================== boot
window.addEventListener('error', e => toast('JS: ' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno, 'err', 10000));
window.addEventListener('unhandledrejection', e => toast('JS: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason), 'err', 10000));
async function main() {
  loadPrefs();
  initView();
  UI.buildToolbar();
  UI.buildTabs();
  bindCanvas();
  bindKeys();
  bindMenu();
  emit('mirror');
  try {
    await loadProtos();
  } catch (e) {
    $('loading').textContent = 'Ошибка загрузки прототипов: ' + e.message;
    return;
  }
  $('loading').remove();
  try { await loadPalettes(); } catch (e) { toast('Палитры не загружены: ' + e.message, 'err', 6000); }
  UI.buildPalette();
  setTool('tile');
  startAutosave();
  const qs = new URLSearchParams(location.search);
  const qmap = qs.get('map');
  if (qmap) await loadMap(qmap, qs.get('grid') || undefined);
  else if (qs.has('selftest')) await newMap('SelfTest');
  else if (!(await tryRestore())) {
    const last = localStorage.getItem('ss14mapper.last');
    if (last) await loadMap(last, localStorage.getItem('ss14mapper.lastGrid') || undefined);
    else await newMap('NewShuttle');
  }
  if (new URLSearchParams(location.search).has('debug')) {
    setTimeout(() => {
      const cv = $('view');
      const d = document.createElement('pre');
      d.id = 'dbg';
      const px = cv.getContext('2d').getImageData(cv.width / 2, cv.height / 2, 1, 1).data;
      d.textContent = JSON.stringify({ w: cv.width, h: cv.height, sw: cv.style.width, view: S.view, size: size(), px: [...px], tiles: S.model && S.model.tiles.size, b: S.model && S.model.bounds() });
      document.body.append(d);
    }, 4000);
  }
  if (qs.get('mode')) setMode(qs.get('mode'));
  if ((S.radarDock.open || qs.has('dock')) && S.model) UI.radarDock.open();
  if (qs.get('inspect') && S.model) { S.inspected = qs.get('inspect'); setTool('inspect'); emit('inspect'); const e = S.model.ents.get(S.inspected); if (e) { S.view.cx = e.x; S.view.cy = e.y; } }
  if (qs.get('layers')) for (const k of qs.get('layers').split(',')) S.layers[k] = true;
  const dlg = { export: UI.exportDialog, validate: UI.validateDialog, vessel: UI.vesselDialog, radar: UI.radarDialog, open: () => UI.openDialog(loadMap),
    names: () => TX.namesDialog(S.inspected), pipelines: () => pipelinesDialog(loadMap), paper: () => S.inspected && TX.paperDialog(S.inspected) }[qs.get('dialog')];
  if (dlg && S.model) dlg();
  if (qs.has('selftest')) (await import('./selftest.js')).run({ loadMap, newMap });
  void size; void savePrefs; void paste; void key; void unkey;
}
main();
