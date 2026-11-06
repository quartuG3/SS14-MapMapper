// User pipelines: JS modules from pipelines/ on the server or from the user's computer, run in a sandboxed worker
// (pipeline-worker.js). A pipeline gets a copy of the open grid; its edits come back as ops and are applied here
// as one undo step. Files it emits are downloaded (several as a zip). See pipelines/README.md for the API.
import { S, toast } from './state.js';
import { P } from './protos.js';
import { h, modal, api, chips, priceCalculator } from './ui.js';
import { requestDraw, centerOn } from './view.js';
import { enumLabel } from './labels.js';

const M = () => S.model;
const local = [];          // pipelines loaded from the user's computer this session: {key, file, text}
let catalogue = null;

function getCatalogue() {
  if (!catalogue) catalogue = { ents: [...P.ents.values()], tiles: [...P.tiles.values()], decals: [...P.decals.values()], migrations: P.migrations };
  return catalogue;
}

// ===================================================================== worker
async function getText(url) {
  const r = await fetch(url);
  const t = await r.text();
  if (!r.ok) { let m = t; try { m = JSON.parse(t).error; } catch { /* plain text */ } throw new Error(m || r.status); }
  return t;
}
async function allMaps() {
  const [b, u] = await Promise.all([api.get('/api/maps'), api.get('/api/usermaps')]);
  return [...u, ...b].map(m => ({ path: m.path, cat: m.cat, format: m.format, size: m.size }));
}
/** The only things a pipeline can reach outside its grid copy. Read-only, apart from rendering a map to text. */
const RPC = {
  protoRaw: (type, id) => api.get(`/api/protoraw?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`).catch(() => null),
  protoResolved: id => api.get('/api/protoresolved?id=' + encodeURIComponent(id)).catch(() => null),
  yamlDump: async obj => (await api.post('/api/yaml/dump', { obj })).text,
  yamlLoad: async text => (await api.post('/api/yaml/load', { text })).obj,
  locRaw: (keys, lang) => api.post('/api/locraw', { keys, lang }),
  resText: path => getText('/api/restext?path=' + encodeURIComponent(path)),
  mapYaml: (doc, regenAtmos) => api.post('/api/save', { doc, write: false, regenAtmos: !!regenAtmos }),
  mapList: allMaps,
  mapLoad: (path, grid) => api.get('/api/map?path=' + encodeURIComponent(path) + (grid ? '&grid=' + encodeURIComponent(grid) : '')),
};

function spawn(onMsg) {
  const w = new Worker('/js/pipeline-worker.js', { type: 'module' });
  w.onmessage = async ({ data: msg }) => {
    if (msg.cmd !== 'rpc') return onMsg(msg);
    const fn = RPC[msg.method];
    try {
      if (!fn) throw new Error('неизвестный вызов ' + msg.method);
      w.postMessage({ cmd: 'rpc', id: msg.id, result: await fn(...msg.args) });
    } catch (e) { w.postMessage({ cmd: 'rpc', id: msg.id, error: String(e && e.message || e) }); }
  };
  w.onerror = e => { e.preventDefault(); onMsg({ cmd: 'done', error: e.message || 'ошибка воркера', ops: [], files: [] }); };
  return w;
}

/** Read meta of several pipelines: Map(key -> {meta} | {error}). Loading a module runs its top level, so in the sandbox too. */
function describe(sources) {
  return new Promise(resolve => {
    if (!sources.length) return resolve(new Map());
    const w = spawn(msg => { if (msg.cmd === 'described') { w.terminate(); clearTimeout(t); resolve(new Map(msg.results.map(r => [r.key, r]))); } });
    const t = setTimeout(() => { w.terminate(); resolve(new Map(sources.map(s => [s.key, { error: 'не загрузился за 5 с' }]))); }, 5000);
    w.postMessage({ cmd: 'describe', sources });
  });
}

function snapshot(model) {
  const d = model.toDoc();
  d.decals = [...model.decals.values()].map(x => ({ ...x }));
  d.uidSeq = model._uidSeq;
  return d;
}

/** Start a pipeline. Returns {done: Promise<result msg>, stop()}. */
function run(text, params, scope, onMsg) {
  let finish;
  const done = new Promise(r => { finish = r; });
  const w = spawn(msg => { if (msg.cmd === 'done') { w.terminate(); finish(msg); } else onMsg(msg); });
  w.postMessage({
    cmd: 'run', text, params, catalogue: getCatalogue(),
    doc: scope === 'map' && M() ? snapshot(M()) : null,
    selection: [...S.selection],
  });
  return { done, stop: () => { w.terminate(); finish({ cmd: 'done', error: 'Остановлено', ops: [], files: [] }); } };
}

function applyOps(model, ops, uidSeq, label) {
  const decalIds = new Map();
  model.begin(label);
  try {
    for (const op of ops) {
      switch (op[0]) {
        case 'tile': model.setTile(op[1], op[2], op[3]); break;
        case 'ent+': model.addEnt(op[1]); break;
        case 'ent~': model.updateEnt(op[1], op[2]); break;
        case 'ent-': model.removeEnt(op[1]); break;
        case 'decal+': { const d = { ...op[1] }; const tmp = d._id; delete d._id; decalIds.set(tmp, model.addDecal(d)._id); break; }
        case 'decal-': model.removeDecal(decalIds.get(op[1]) ?? op[1]); break;
        case 'other~': { const o = model.others.get(op[1]); if (o) { model.removeOther(op[1]); model.addOther({ ...structuredClone(o), ...op[2] }); } break; }
        case 'other-': { for (const d of model.descendants(op[1])) model.removeOther(d); model.removeOther(op[1]); break; }
      }
    }
  } finally { model.commit(); }
  model._uidSeq = Math.max(model._uidSeq, uidSeq || 0);
}

// ===================================================================== zip (stored, no compression)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let off = 0;
  for (const [name, data] of files) {
    const nb = enc.encode(name), db = typeof data === 'string' ? enc.encode(data) : data;
    const crc = crc32(db);
    const hd = new DataView(new ArrayBuffer(30));
    hd.setUint32(0, 0x04034b50, true); hd.setUint16(4, 20, true); hd.setUint16(6, 0x0800, true);
    hd.setUint32(14, crc, true); hd.setUint32(18, db.length, true); hd.setUint32(22, db.length, true); hd.setUint16(26, nb.length, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, db.length, true); cd.setUint32(24, db.length, true); cd.setUint16(28, nb.length, true);
    cd.setUint32(42, off, true);
    parts.push(hd, nb, db);
    central.push(cd, nb);
    off += 30 + nb.length + db.length;
  }
  const size = central.reduce((s, p) => s + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function deliver(files, baseName) {
  if (!files.length) return;
  if (files.length === 1) {
    const [name, data] = files[0];
    download(new Blob([data], { type: 'application/octet-stream' }), name.split('/').pop());
  } else download(zip(files), baseName + '.zip');
}

// ===================================================================== dialog
const SCOPES = { map: 'открытый шаттл', batch: 'несколько карт' };
const prefKey = k => 'ss14mapper.pipeline.' + k;

let enumCache = null;
async function vesselEnums() {
  if (!enumCache) { try { enumCache = await api.get('/api/enums'); } catch { enumCache = {}; } }
  return enumCache;
}
const asList = v => Array.isArray(v) ? v : v === null || v === undefined || v === '' ? [] : [v];

function paramInput(name, def, value, enums) {
  const label = def.label || name;
  const kindMap = { proto: P.ents, tile: P.tiles, decal: P.decals };
  let el, get;
  if (kindMap[def.type]) {
    const list = 'pl-dl-' + name;
    const dl = h('datalist', { id: list });
    const used = new Set();
    if (M()) {
      if (def.type === 'proto') for (const e of M().ents.values()) used.add(e.proto);
      else if (def.type === 'tile') for (const t of M().tiles.values()) used.add(t[0]);
      else for (const d of M().decals.values()) used.add(d.id);
    }
    for (const id of [...used].sort()) dl.append(h('option', { value: id }));
    let n = 0; for (const id of kindMap[def.type].keys()) { if (n++ > 4000) break; if (!used.has(id)) dl.append(h('option', { value: id })); }
    el = h('span', { class: 'row grow', style: 'margin:0;flex:1' }, h('input', { class: 'grow', list, value: value ?? '', placeholder: def.placeholder || 'id' }), dl);
    get = () => el.querySelector('input').value.trim();
  } else if (def.type === 'enum') {
    // vessel enums of the build (category / group / class / engine) with labels; multi: several values
    const vals = [...new Set([...(enums[def.source] || []), ...(def.options || []), ...asList(value)])];
    const text = v => { const l = enumLabel(def.source, v); return l === v ? v : `${l} (${v})`; };
    if (def.multi) {
      // chips like in the vessel dialog; the Russian label is in the tooltip
      let sel = asList(value);
      el = chips(vals, sel, v => { sel = v; }, v => enumLabel(def.source, v));
      get = () => sel;
    } else {
      el = h('select', {}, def.empty !== undefined ? h('option', { value: '' }, def.empty) : null,
        vals.map(v => h('option', { value: v, selected: v === value }, text(v))));
      get = () => el.value;
    }
  } else if (def.type === 'price') {
    // the vessel dialog's calculator: estimate of the open grid × markup, or a manual price
    if (M()) { const c = priceCalculator(value, null); el = c.el; get = c.price; }
    else { el = h('input', { type: 'number', value: value ?? 0, style: 'width:110px' }); get = () => Number(el.value) || 0; }
  } else if (def.type === 'bool') {
    el = h('input', { type: 'checkbox', checked: !!value });
    get = () => el.checked;
  } else if (def.type === 'number') {
    el = h('input', { type: 'number', value: value ?? '', step: def.step || 'any', style: 'width:110px' });
    get = () => el.value === '' ? null : Number(el.value);
  } else if (def.type === 'select') {
    el = h('select', {}, (def.options || []).map(o => { const v = typeof o === 'object' ? o.value : o; return h('option', { value: v, selected: v === value }, typeof o === 'object' ? (o.label ?? v) : o); }));
    get = () => el.value;
  } else if (def.type === 'text' || def.type === 'list') {
    el = h('textarea', { rows: def.rows || 4, style: 'width:100%;font-family:monospace', placeholder: def.placeholder || (def.type === 'list' ? 'по одному на строку' : '') });
    el.value = Array.isArray(value) ? value.join('\n') : (value ?? '');
    get = () => def.type === 'list' ? el.value.split('\n').map(s => s.trim()).filter(Boolean) : el.value;
  } else {
    el = h('input', { class: 'grow', value: value ?? '', placeholder: def.placeholder || '' });
    get = () => el.value;
  }
  const row = def.type === 'text' || def.type === 'list' ? h('div', {}, h('div', { class: 'muted' }, label), el)
    : (def.type === 'enum' && def.multi) || def.type === 'price' ? h('div', {}, h('h4', {}, label), el)
    : h('label', { class: 'row' }, h('span', { style: 'min-width:130px' }, label), el);
  if (def.help) row.append(h('div', { class: 'muted', style: 'font-size:11px' }, def.help));
  return { row, get };
}

export { run as runPipeline, applyOps, describe, zip };

/** Pipelines dialog. loadMap(path) opens a map (clicks on reports of batch pipelines). */
export async function pipelinesDialog(loadMap) {
  const list = h('div', { class: 'list', style: 'max-height:60vh' });
  const pane = h('div', { style: 'flex:1;min-width:0' }, h('p', { class: 'muted' }, 'Выберите пайплайн слева или загрузите свой .js.'));
  const fileInp = h('input', { type: 'file', accept: '.js,.mjs,text/javascript', multiple: true, style: 'display:none' });
  const body = h('div', {},
    h('div', { style: 'display:flex;gap:12px;align-items:flex-start' },
      h('div', { style: 'width:290px;flex:none' },
        h('div', { class: 'row' },
          h('button', { onclick: () => fileInp.click(), title: 'Пайплайн с компьютера: выполняется у вас, на сервер не попадает' }, 'Загрузить свой .js'),
          h('button', { onclick: () => fill(), title: 'Перечитать папку pipelines/' }, '⟳')),
        list,
        h('div', { class: 'muted', style: 'font-size:11px;margin-top:4px' }, 'Сервер: папка pipelines/ маппера. Файл можно перетащить в окно.')),
      pane),
    fileInp);
  let items = [];
  let current = null;
  let running = null;

  const addLocal = async fl => {
    let last = null;
    for (const f of fl) {
      if (!/\.m?js$/i.test(f.name)) { toast(f.name + ': нужен .js', 'err'); continue; }
      const key = 'local:' + f.name;
      const i = local.findIndex(x => x.key === key);
      const it = { key, file: f.name.replace(/\.m?js$/i, ''), text: await f.text() };
      if (i >= 0) local[i] = it; else local.push(it);
      last = key;
    }
    await fill(last);
  };
  fileInp.onchange = () => { addLocal([...fileInp.files]); fileInp.value = ''; };
  body.addEventListener('dragover', e => { e.preventDefault(); });
  body.addEventListener('drop', e => { e.preventDefault(); addLocal([...e.dataTransfer.files]); });

  async function fill(select) {
    list.innerHTML = '';
    list.append(h('div', { class: 'li muted' }, 'Загрузка…'));
    let server = [];
    try {
      server = await api.get('/api/pipelines');
      server = await Promise.all(server.map(async p => ({ key: 'server:' + p.file, file: p.file, server: true, text: await getText('/api/pipeline?name=' + encodeURIComponent(p.file)) })));
    } catch (e) { toast('Пайплайны: ' + e.message, 'err'); }
    items = [...server, ...local];
    const metas = await describe(items.map(i => ({ key: i.key, text: i.text })));
    for (const it of items) Object.assign(it, metas.get(it.key) || {});
    list.innerHTML = '';
    for (const it of items) {
      const m = it.meta || {};
      const row = h('div', { class: 'li' + (current && current.key === it.key ? ' on' : ''), onclick: () => show(it) },
        h('span', {}, m.name || it.file,
          h('div', { class: 'muted' }, (it.server ? '' : 'локальный · ') + (it.error ? 'ошибка: ' + it.error : `${it.file}.js · ${SCOPES[m.scope || 'map'] || m.scope}`))));
      list.append(row);
    }
    if (!items.length) list.append(h('div', { class: 'li muted' }, 'Папка pipelines/ пуста'));
    const sel = items.find(i => i.key === (select || (current && current.key)));
    if (sel) show(sel);
  }

  const enums = await vesselEnums();
  function show(it) {
    current = it;
    list.querySelectorAll('.li').forEach((r, i) => r.classList.toggle('on', items[i] === it));
    pane.innerHTML = '';
    const m = it.meta || {};
    const scope = m.scope || 'map';
    pane.append(h('h3', { style: 'margin:0 0 4px' }, m.name || it.file),
      h('div', { class: 'muted' }, `${it.server ? 'pipelines/' : 'с компьютера: '}${it.file}.js · ${SCOPES[scope] || scope}`));
    if (m.description) pane.append(h('p', { style: 'white-space:pre-wrap' }, m.description));
    const src = h('pre', { style: 'display:none;max-height:40vh;overflow:auto;font-size:11px;background:#111;padding:6px' }, it.text);
    const actions = h('div', { class: 'row' },
      h('button', { onclick: () => { src.style.display = src.style.display === 'none' ? '' : 'none'; } }, 'Код'));
    if (!it.server) actions.append(h('button', { title: 'Положить в pipelines/ — станет доступен всем, кто открывает этот маппер', onclick: () => saveToServer(it) }, 'Сохранить на сервер'),
      h('button', { onclick: () => { local.splice(local.indexOf(it), 1); current = null; pane.innerHTML = ''; fill(); } }, 'Убрать из списка'));
    else actions.append(h('button', { class: 'danger', onclick: async () => {
      if (!confirm(`Удалить pipelines/${it.file}.js?`)) return;
      await api.post('/api/pipeline/delete', { name: it.file }); current = null; pane.innerHTML = ''; fill();
    } }, 'Удалить'));
    if (it.error) { pane.append(h('div', { class: 'issue err' }, it.error), actions, src); return; }

    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(prefKey(it.key)) || '{}'); } catch { /* ignore */ }
    // fromVessel: the field of the open shuttle's vessel prototype wins over the remembered value
    const vessel = (M() && (M().doc.vessels || [])[0]) || null;
    const initial = (name, def) => def.fromVessel && vessel && vessel[def.fromVessel] !== undefined ? vessel[def.fromVessel]
      : def.type === 'price' ? 0 : saved[name] ?? def.default;   // a price remembered from another shuttle makes no sense
    const inputs = Object.entries(m.params || {}).map(([name, def]) => [name, paramInput(name, def || {}, initial(name, def || {}), enums)]);
    const form = h('div', {}, inputs.map(([, x]) => x.row));
    const out = h('div', {});
    const runBtn = h('button', { class: 'on', onclick: () => start() }, '▶ Запустить');
    const stopBtn = h('button', { disabled: true, onclick: () => running && running.stop() }, '■ Стоп');
    pane.append(form, h('div', { class: 'row' }, runBtn, stopBtn), actions, src, out);

    async function start() {
      if (scope === 'map' && !M()) { toast('Откройте шаттл: этот пайплайн работает с открытым файлом', 'err'); return; }
      const params = Object.fromEntries(inputs.map(([n, x]) => [n, x.get()]));
      try { localStorage.setItem(prefKey(it.key), JSON.stringify(params)); } catch { /* ignore */ }
      const model = M(), version = model && model.version;
      out.innerHTML = '';
      const prog = h('progress', { style: 'width:100%;display:none', max: 1 });
      const progText = h('div', { class: 'muted' });
      const logBox = h('pre', { style: 'max-height:20vh;overflow:auto;font-size:11px;white-space:pre-wrap;margin:4px 0;display:none' });
      const reports = h('div', { style: 'max-height:40vh;overflow:auto' });
      const status = h('div', { class: 'muted' }, 'Выполняется…');
      out.append(status, prog, progText, logBox, reports);
      const markers = [];
      const t0 = performance.now();
      runBtn.disabled = true; stopBtn.disabled = false;
      running = run(it.text, params, scope, msg => {
        if (msg.cmd === 'log') { logBox.style.display = ''; logBox.textContent += msg.text + '\n'; logBox.scrollTop = 1e9; }
        else if (msg.cmd === 'progress') { prog.style.display = ''; prog.value = Math.max(0, Math.min(1, +msg.v || 0)); progText.textContent = msg.text || ''; }
        else if (msg.cmd === 'report') {
          const at = Array.isArray(msg.at) ? msg.at : null;
          if (at && !msg.path && (msg.sev === 'err' || msg.sev === 'warn')) markers.push({ x: at[0], y: at[1], sev: msg.sev });
          reports.append(h('div', { class: 'issue ' + (msg.sev || 'info'), onclick: async () => {
            if (msg.path && (!M() || M().path !== msg.path)) await loadMap(msg.path);
            if (at) centerOn(at[0] + 0.5, at[1] + 0.5, Math.max(S.view.z, 32));
          } }, (msg.path ? msg.path + ': ' : '') + msg.msg));
        }
      });
      const res = await running.done;
      running = null;
      runBtn.disabled = false; stopBtn.disabled = true;
      prog.style.display = 'none';
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      if (res.error) { status.textContent = ''; status.append(h('div', { class: 'issue err', style: 'white-space:pre-wrap' }, 'Ошибка: ' + res.error)); return; }
      const lines = [`Готово за ${secs} с.`];
      if (res.ops.length) {
        if (M() !== model) lines.push('Изменения не применены: открыт другой файл.');
        else if (model.version !== version && !confirm('Шаттл менялся, пока работал пайплайн. Всё равно применить его изменения?')) lines.push('Изменения отменены.');
        else { applyOps(model, res.ops, res.uidSeq, 'Пайплайн: ' + (m.name || it.file)); requestDraw(); lines.push(`Изменений: ${res.ops.length} (Ctrl+Z отменит одним шагом).`); }
      } else if (scope === 'map') lines.push('Шаттл не изменён.');
      if (res.files.length) {
        const base = (m.name || it.file).replace(/[\\/:*?"<>|]+/g, '_') + (model && model.path ? '-' + model.path.split('/').pop().replace(/\.yml$/, '') : '');
        deliver(res.files, base);
        lines.push(`Файлов: ${res.files.length}` + (res.files.length > 1 ? ' (zip)' : '') + ': ' + res.files.map(f => f[0]).slice(0, 8).join(', ') + (res.files.length > 8 ? '…' : ''));
      }
      if (res.result !== null && res.result !== undefined) lines.push('Результат: ' + (typeof res.result === 'string' ? res.result : JSON.stringify(res.result)));
      status.textContent = lines.join(' ');
      if (scope === 'map') { S.markers = markers; requestDraw(); }
    }
  }

  async function saveToServer(it) {
    try {
      let r;
      try { r = await api.post('/api/pipeline', { name: it.file, text: it.text }); } catch (e) {
        if (!/409|exists/.test(e.message) || !confirm(`pipelines/${it.file}.js уже есть. Перезаписать?`)) throw e;
        r = await api.post('/api/pipeline', { name: it.file, text: it.text, overwrite: true });
      }
      local.splice(local.indexOf(it), 1);
      toast(`Сохранено: pipelines/${r.file}.js`, 'ok');
      await fill('server:' + r.file);
    } catch (e) { toast(e.message, 'err'); }
  }

  modal('Пайплайны', body, () => { if (running) running.stop(); }, { wide: true });
  fill();
}
