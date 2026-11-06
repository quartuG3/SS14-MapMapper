// Texts of entities: paper content with BB-code markup and stamps, names and descriptions (MetaData).
import { S, toast, savePrefs } from './state.js';
import { P, ent as protoOf, displayName } from './protos.js';
import { h, api, modal, closeModal, renderInspector } from './ui.js';
import * as A from './assets.js';
import { requestDraw, centerOn } from './view.js';
import { tileOf } from './logic.js';
import { icon } from './icons.js';

const M = () => S.model;
const enc = encodeURIComponent;
const SIGN_STATE = 'paper_stamp-nf-signature';   // sprite mark of a pen signature (PaperSystem.TrySign)
const BORDER = 'Textures/Interface/Paper/paper_stamp_border.svg.96dpi.png';

// ================================================================= components of any entity (grid or contained)
export function compsOf(uid) {
  const m = M();
  const e = m.ents.get(uid);
  if (e) return e.comps || [];
  const o = m.others.get(uid);
  return o ? (o.components || []) : null;
}
export const protoIdOf = uid => (M().ents.get(uid) || M().others.get(uid) || {}).proto;
export const isPaper = proto => !!(protoOf(proto) || {}).paper;

/** Replaces the components of uid inside the current transaction (Transform of grid entities stays in place). */
function putComps(uid, comps) {
  const m = M();
  const e = m.ents.get(uid);
  if (e) {
    // tfIndex: where Transform goes back when saving; keep it after a MetaData added in front
    const before = (e.comps || []).findIndex(c => c.type === 'MetaData');
    const after = comps.findIndex(c => c.type === 'MetaData');
    let ti = e.tfIndex || 0;
    if (before < 0 && after === 0) ti++;
    else if (before >= 0 && before < ti && after < 0) ti--;
    m.updateEnt(uid, { comps, tfIndex: ti || undefined });
  } else {
    const o = m.others.get(uid);
    m.removeOther(uid);
    m.addOther({ ...o, components: comps });
  }
}

// ================================================================= colours
const cctx = document.createElement('canvas').getContext('2d');
/** [r, g, b, a(0..255)] of a CSS / Robust colour (#RGB, #RRGGBB, #RRGGBBAA, names), null if invalid. */
export function rgba(c) {
  if (typeof c !== 'string' || !c.trim()) return null;
  c = c.trim();
  if (!/^(#[0-9a-f]+|rgba?\([\d.,\s%]+\)|[a-z]+)$/i.test(c)) return null;
  cctx.fillStyle = '#010203';
  cctx.fillStyle = c;
  const v = cctx.fillStyle;
  if (v === '#010203' && c.toLowerCase() !== '#010203') return null;
  if (v.startsWith('#')) return [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16)).concat(255);
  const m = v.match(/[\d.]+/g).map(Number);
  return [m[0], m[1], m[2], Math.round((m[3] ?? 1) * 255)];
}
const hex2 = n => n.toString(16).padStart(2, '0').toUpperCase();
/** Colour as the engine serializes it: '#RRGGBBAA'. */
export const engineColor = c => { const v = rgba(c) || [0, 0, 0, 255]; return '#' + v.map(hex2).join(''); };
const cssColor = c => { const v = rgba(c); return v ? `rgba(${v[0]},${v[1]},${v[2]},${(v[3] / 255).toFixed(3)})` : null; };
const inputColor = c => { const v = rgba(c) || [0, 0, 0]; return '#' + v.slice(0, 3).map(hex2).join('').toLowerCase(); };
const modColor = (c, mod) => {
  const v = rgba(c), m = rgba(mod) || [255, 255, 255, 255];
  return v ? `rgba(${Math.round(v[0] * m[0] / 255)},${Math.round(v[1] * m[1] / 255)},${Math.round(v[2] * m[2] / 255)},${(v[3] * m[3] / 65025).toFixed(3)})` : null;
};
const resUrl = (path, tint) => `/api/res?path=${enc(String(path).replace(/^\//, ''))}${tint ? '&tint=' + enc(engineColor(tint)) : ''}`;

// ================================================================= BB-code markup (Robust FormattedMessage)
// tags a paper window renders (PaperWindow._allowedTags); anything else shows its text without the effect
export const PAPER_TAGS = ['bold', 'italic', 'bolditalic', 'uline', 'cut', 'head', 'small', 'color', 'mono', 'bullet', 'conf', 'сonf', 'shift'];
const TAG_RE = /\[(\/?)([A-Za-zА-Яа-яЁё][\w]*)(?:\s*=\s*("[^"]*"|[^\]\s]+))?((?:\s+[A-Za-z]\w*\s*=\s*(?:"[^"]*"|[^\]\s]+))*)\s*(\/?)\]/y;

/** Markup -> tree {tag, val, kids}; text nodes are strings. Malformed tags stay text (AddMarkupPermissive). */
export function parseMarkup(src) {
  const root = { tag: null, kids: [] };
  const stack = [root];
  const unknown = new Set();
  let text = '';
  const flush = () => { if (text) { stack[stack.length - 1].kids.push(text); text = ''; } };
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '\\' && (src[i + 1] === '[' || src[i + 1] === '\\')) { text += src[i + 1]; i += 2; continue; }
    if (c === '[') {
      TAG_RE.lastIndex = i;
      const m = TAG_RE.exec(src);
      if (m) {
        const [all, close, name0, val, , self] = m;
        const name = name0.toLowerCase();
        flush();
        if (close) {
          let k = stack.length - 1;
          while (k > 0 && stack[k].tag !== name) k--;
          if (k > 0) stack.length = k;
        } else {
          const node = { tag: name, val: val ? val.replace(/^"|"$/g, '') : null, kids: [] };
          if (!PAPER_TAGS.includes(name)) unknown.add(name);
          stack[stack.length - 1].kids.push(node);
          if (!self) stack.push(node);
        }
        i += all.length;
        continue;
      }
    }
    text += c;
    i++;
  }
  flush();
  return { root, unknown: [...unknown] };
}

// font sizes in pt as Robust computes them (FontTag.DefaultSize = 12), shown at 96 dpi
const PT = 4 / 3;
const headSize = lvl => Math.ceil(12 * 2 / Math.sqrt(Math.min(3, Math.max(1, lvl | 0 || 1))));
// deterministic jitter of [conf] handwriting (PaperFormattingFont: fixed integer hashes)
function mixHash(v) {
  v = (v ^ (v >>> 16)) >>> 0; v = Math.imul(v, 0x7FEB352D) >>> 0;
  v = (v ^ (v >>> 15)) >>> 0; v = Math.imul(v, 0x846CA68B) >>> 0;
  return (v ^ (v >>> 16)) >>> 0;
}
const signed = (hash, amp) => amp <= 0 ? 0 : (hash % (amp * 2 + 1)) - amp;

/** Renders markup into an element. opts.color: default text colour, opts.accent: font modulate of the paper. */
export function renderMarkup(src, { color = '#191919', accent = null } = {}) {
  const { root, unknown } = parseMarkup(src);
  const out = h('div', { class: 'mk' });
  out.style.color = accent ? modColor(color, accent) : color;
  let runeIndex = 0;
  const walk = (node, parent, conf) => {
    for (const k of node.kids) {
      if (typeof k === 'string') {
        if (!conf) { parent.append(k); continue; }
        for (const ch of k) {
          if (ch === '\n' || ch === ' ') { parent.append(ch); runeIndex++; continue; }
          const hsh = mixHash((Math.imul(ch.codePointAt(0), 0x85EBCA6B) ^ Math.imul(runeIndex + 1, 0x9E3779B9)) >>> 0);
          const dy = Math.max(-((conf + 1) >> 1), Math.min((conf + 1) >> 1, signed(mixHash(hsh + 0xA511E9B3), Math.max(1, (conf + 2) / 3 | 0))));
          const rot = signed(mixHash((hsh + 0x27D4EB2F) >>> 0), conf * 2) / 10;
          const sx = 1 + signed(mixHash((hsh + 0x1B56C4E9) >>> 0), conf * 4) / 1000;
          parent.append(h('span', { class: 'mk-conf', style: `transform:translateY(${dy}px) rotate(${rot}deg) scaleX(${sx})` }, ch));
          runeIndex++;
        }
        continue;
      }
      let el = h('span');
      const v = k.val;
      switch (k.tag) {
        case 'bold': el.style.fontWeight = 'bold'; break;
        case 'italic': el.style.fontStyle = 'italic'; break;
        case 'bolditalic': el.style.fontWeight = 'bold'; el.style.fontStyle = 'italic'; break;
        case 'uline': el.style.textDecoration = 'underline'; break;
        case 'cut': el.style.textDecoration = 'line-through'; break;
        case 'head': el.style.fontWeight = 'bold'; el.style.fontSize = (headSize(+v) * PT).toFixed(1) + 'px'; el.style.lineHeight = '1.36'; break;
        case 'small': el.style.fontSize = ((12 - Math.min(6, Math.max(1, +v || 1))) * PT).toFixed(1) + 'px'; break;
        case 'mono': el.className = 'mk-mono'; break;
        case 'shift': el.style.lineHeight = '1.07'; el.style.display = 'inline-block'; break;
        case 'color': { const c = accent ? modColor(v, accent) : cssColor(v); if (c) el.style.color = c; break; }
        case 'bullet': parent.append(' · '); break;
        case 'conf': case 'сonf': break;
        default: el.className = 'mk-unknown'; el.title = `[${k.tag}] — бумага этот тег не отображает`;
      }
      const c2 = (k.tag === 'conf' || k.tag === 'сonf') ? Math.min(10, Math.max(1, +v || 1)) : conf;
      walk(k, el, c2);
      parent.append(el);
    }
  };
  walk(root, out, 0);
  return { el: out, unknown };
}

// ================================================================= stamps
/** .NET System.Random with a seed (legacy subtractive generator): stamps land where the game puts them. */
class NetRandom {
  constructor(seed) {
    const MBIG = 2147483647;
    const a = new Array(56).fill(0);
    const s = seed | 0;
    let mj = 161803398 - (s === -2147483648 ? 2147483647 : Math.abs(s));
    a[55] = mj;
    let mk = 1;
    for (let i = 1; i < 55; i++) {
      const ii = (21 * i) % 55;
      a[ii] = mk; mk = mj - mk; if (mk < 0) mk += MBIG; mj = a[ii];
    }
    for (let k = 1; k < 5; k++) for (let i = 1; i < 56; i++) {
      let n = i + 30; if (n >= 55) n -= 55;
      a[i] -= a[1 + n]; if (a[i] < 0) a[i] += MBIG;
    }
    this.a = a; this.i = 0; this.j = 21;
  }
  sample() {
    let i = this.i + 1; if (i >= 56) i = 1;
    let j = this.j + 1; if (j >= 56) j = 1;
    let r = this.a[i] - this.a[j];
    if (r === 2147483647) r--;
    if (r < 0) r += 2147483647;
    this.a[i] = r; this.i = i; this.j = j;
    return r * (1 / 2147483647);
  }
  next(min, max) { return Math.floor(this.sample() * (max - min)) + min; }
}

export const stampText = s => (s.stampType === 'Signature' ? s.stampedName : (P.stampNames[s.stampedName] ?? s.stampedName)) || '';
function stampEl(s) {
  const sig = s.stampType === 'Signature';
  const c = cssColor(s.stampedColor) || '#BB3232';
  const el = h('div', { class: 'pv-stamp' + (sig ? ' sig' : '') }, stampText(s));
  el.style.color = c;
  if (!sig) el.style.borderImageSource = `url("${resUrl(BORDER, s.stampedColor)}")`;
  return el;
}
/** StampCollection.ArrangeOverride: first stamp in the middle, the next ones around it, clamped to the strip. */
function layoutStamps(area, els, seed) {
  if (!els.length) { area.style.height = '0'; return; }
  const sizes = els.map(e => [e.offsetWidth + 12, e.offsetHeight + 12]);
  const W = area.clientWidth, H = Math.max(...sizes.map(s => s[1]));
  area.style.height = H + 'px';
  const rnd = new NetRandom(seed);
  const r = Math.hypot(W / 2, H / 2);
  const dt = -Math.PI / 2;
  const t0 = rnd.next(0, 3) * dt;
  els.forEach((el, i) => {
    const or = (rnd.sample() - 0.5) * 10 * Math.PI / 180;
    const th = t0 + dt * 0.5 + dt * i + (i > 4 ? Math.log(1 + Math.floor(i / 4)) * dt : 0);
    let x = W / 2, y = H / 2;
    if (i > 0) { x += Math.cos(th) * r; y += Math.sin(th) * r; }
    const [w, hh] = sizes[i];
    const cs = Math.abs(Math.cos(or)), sn = Math.abs(Math.sin(or));
    const ex = w / 2 * cs + hh / 2 * sn, ey = w / 2 * sn + hh / 2 * cs;
    x = Math.min(Math.max(x, ex), Math.max(ex, W - ex));
    y = Math.min(Math.max(y, ey), Math.max(ey, H - ey));
    el.style.left = (x - w / 2 + 6) + 'px';
    el.style.top = (y - hh / 2 + 6) + 'px';
    el.style.transform = `rotate(${or}rad)`;
  });
}

// ================================================================= paper look (PaperWindow.InitVisuals)
const thick = v => { const n = String(v || '').split(',').map(x => parseFloat(x) || 0); return n.length === 4 ? n : n.length === 2 ? [n[0], n[1], n[0], n[1]] : [n[0] || 0, n[0] || 0, n[0] || 0, n[0] || 0]; };
export function paperView(info, content, stamps, seed) {
  const vis = info.visuals || {};
  const bg = h('div', { class: 'pv' });
  let bgPath = vis.backgroundImagePath, bgMod = vis.backgroundModulate || 'White', patch = thick(vis.backgroundPatchMargin);
  if (!bgPath) { bgPath = 'Textures/Interface/Paper/paper_background_default.svg.96dpi.png'; bgMod = '#eaedde'; patch = [16, 16, 16, 16]; }
  const [pl, pt, pr, pb] = patch.map(v => Math.round(v));
  bg.style.borderImage = `url("${resUrl(bgPath, bgMod)}") ${pt} ${pr} ${pb} ${pl} fill / ${pt}px ${pr}px ${pb}px ${pl}px ${String(vis.backgroundImageTile).toLowerCase() === 'true' ? 'repeat' : 'stretch'}`;
  bg.style.padding = `${pt}px ${pr}px ${pb}px ${pl}px`;
  const cont = h('div', { class: 'pv-content' });
  const cm = thick(vis.contentMargin);
  cont.style.margin = `${cm[1]}px ${cm[2]}px ${cm[3]}px ${cm[0]}px`;
  if (vis.contentImagePath) {
    const lines = Math.max(1, parseInt(vis.contentImageNumLines, 10) || 1);
    cont.style.backgroundImage = `url("${resUrl(vis.contentImagePath, vis.contentImageModulate)}")`;
    cont.style.backgroundSize = `auto ${22 * lines}px`;
  }
  if (vis.headerImagePath) {
    const hm = thick(vis.headerMargin);
    cont.append(h('div', { style: `text-align:center;margin:${hm[1]}px ${hm[2]}px ${hm[3]}px ${hm[0]}px` },
      h('img', { src: resUrl(vis.headerImagePath, vis.headerImageModulate), style: 'max-width:100%' })));
  }
  const accent = vis.fontAccentColor || '#DFDFD5';   // PaperVisualsComponent.FontAccentColor default
  const { el, unknown } = renderMarkup(content, { accent });
  if (!content) { el.classList.add('pv-blank'); el.textContent = 'Пустой лист'; }
  cont.append(el);
  const area = h('div', { class: 'pv-stamps' });
  const els = stamps.map(stampEl);
  area.append(...els);
  cont.append(area);
  bg.append(cont);
  if (vis.maxWritableArea) {
    const [w] = String(vis.maxWritableArea).split(',').map(parseFloat);
    if (w > 0) bg.style.width = (w + pl + pr) + 'px';
  }
  bg.layout = () => layoutStamps(area, els, seed);
  return { el: bg, unknown };
}

// ================================================================= paper dialog
let templates = null;
const stampProtos = () => [...P.ents.values()].filter(p => p.stamp);

/** Writes Paper: content / stampState / stampedBy, dropping what equals the prototype (engine diff). */
function paperComp(old, info, content, stamps, stampState) {
  const c = old ? { ...old } : { type: 'Paper' };
  const set = (k, v, keep) => { if (keep) c[k] = v; else delete c[k]; };
  // new components get the engine's key order: stampState, stampedBy, content
  if (!old) { c.stampState = null; c.stampedBy = null; c.content = null; }
  set('stampState', stampState, !!stampState);
  set('stampedBy', stamps, stamps.length > 0);
  set('content', content, content !== (info.content || '') || (old && 'content' in old && content !== ''));
  const keys = Object.keys(c).filter(k => k !== 'type');
  return keys.length ? c : null;
}

export async function paperDialog(uid) {
  const proto = protoIdOf(uid);
  let info;
  try { info = await api.get('/api/paper?p=' + enc(proto)); } catch (e) { toast('Бумага: ' + e.message, 'err'); return; }
  const comps0 = compsOf(uid) || [];
  const old = comps0.find(c => c.type === 'Paper');
  let content = old && typeof old.content === 'string' ? old.content : (info.content || '');
  let stamps = (old && Array.isArray(old.stampedBy) ? old.stampedBy : []).map(s => ({ ...s }));
  let stampState = (old && old.stampState) || null;
  const seed = parseInt(uid, 10) || 0;
  const limit = info.contentSize || 6000;

  const ta = h('textarea', { class: 'paper-src', spellcheck: false });
  ta.value = content;
  const counter = h('span', { class: 'muted' });
  const warn = h('div', { class: 'muted', style: 'font-size:11px;min-height:14px' });
  const preview = h('div', { class: 'paper-preview' });
  const stampList = h('div', { class: 'list', style: 'max-height:150px' });
  const markRow = h('div', { class: 'stamp-marks' });

  const redraw = () => {
    content = ta.value;
    counter.textContent = `${content.length} / ${limit}`;
    counter.style.color = content.length > limit ? 'var(--bad)' : '';
    const { el, unknown } = paperView(info, content, stamps, seed);
    preview.replaceChildren(el);
    el.layout();
    warn.textContent = unknown.length ? `Теги не отображаются бумагой: ${unknown.map(t => '[' + t + ']').join(' ')}` : '';
  };
  let tmr = 0;
  ta.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(redraw, 120); });

  // ---- toolbar
  const wrap = (open, close = '') => {
    const a = ta.selectionStart, b = ta.selectionEnd, sel = ta.value.slice(a, b);
    ta.setRangeText(open + sel + close, a, b, 'select');
    if (!sel) ta.setSelectionRange(a + open.length, a + open.length);
    ta.focus();
    redraw();
  };
  const tb = (label, title, fn, style = '') => h('button', { title, style, onclick: fn }, label);
  const colorIn = h('input', { type: 'color', value: S.paper.color || '#cc0000', title: 'Цвет для [color]', style: 'width:28px;padding:0;height:24px' });
  colorIn.onchange = () => { S.paper.color = colorIn.value; savePrefs(); };
  const lvl = (tag, title, vals) => h('select', { title, onchange: ev => { if (ev.target.value) wrap(`[${tag}=${ev.target.value}]`, `[/${tag}]`); ev.target.value = ''; } },
    h('option', { value: '' }, tag), ...vals.map(v => h('option', { value: v }, `${tag}=${v}`)));
  const tplSel = h('select', { title: 'Вставить текст бумаги-прототипа (бланки, памятки)', style: 'max-width:180px' }, h('option', { value: '' }, 'Шаблон…'));
  (async () => {
    if (!templates) { try { templates = await api.get('/api/papertemplates'); } catch { templates = []; } }
    for (const t of templates) tplSel.append(h('option', { value: t.id }, `${t.name} (${t.id})`));
  })();
  tplSel.onchange = async () => {
    const id = tplSel.value;
    tplSel.value = '';
    if (!id) return;
    const t = await api.get('/api/paper?p=' + enc(id));
    if (ta.value.trim() && !confirm('Заменить текст шаблоном? Отмена — вставить в позицию курсора.')) ta.setRangeText(t.content, ta.selectionStart, ta.selectionEnd, 'end');
    else ta.value = t.content;
    redraw();
  };
  const toolbar = h('div', { class: 'row paper-tb' },
    tb('B', 'Жирный [bold]', () => wrap('[bold]', '[/bold]'), 'font-weight:bold'),
    tb('I', 'Курсив [italic]', () => wrap('[italic]', '[/italic]'), 'font-style:italic'),
    tb('BI', 'Жирный курсив [bolditalic]', () => wrap('[bolditalic]', '[/bolditalic]'), 'font-weight:bold;font-style:italic'),
    tb('U', 'Подчёркнутый [uline]', () => wrap('[uline]', '[/uline]'), 'text-decoration:underline'),
    tb('S', 'Зачёркнутый [cut]', () => wrap('[cut]', '[/cut]'), 'text-decoration:line-through'),
    lvl('head', 'Заголовок [head=1..3]', [1, 2, 3]),
    lvl('small', 'Мелкий шрифт [small=1..6]', [1, 2, 3, 4, 5, 6]),
    tb('mono', 'Моноширинный [mono]', () => wrap('[mono]', '[/mono]'), 'font-family:monospace'),
    tb(icon('list'), 'Маркер списка [bullet/]', () => wrap('[bullet/]')),
    colorIn, tb('цвет', 'Цвет [color=…]', () => wrap(`[color=${colorIn.value}]`, '[/color]')),
    lvl('conf', 'Неровный почерк [conf=1..10]', [1, 2, 3, 5, 7, 10]),
    tb('shift', 'Плотные строки для псевдографики [shift]', () => wrap('[shift]', '[/shift]')),
    tb('\\[', 'Символ [ без тега', () => wrap('\\[')),
    tb('⨯ теги', 'Убрать теги из выделения (или из всего текста)', () => {
      const a = ta.selectionStart, b = ta.selectionEnd;
      const strip = s => s.replace(/(?<!\\)\[\/?[A-Za-zА-Яа-яЁё]\w*(?:\s*=\s*(?:"[^"]*"|[^\]\s]+))?(?:\s+\w+\s*=\s*(?:"[^"]*"|[^\]\s]+))*\s*\/?\]/g, '');
      if (a === b) ta.value = strip(ta.value); else ta.setRangeText(strip(ta.value.slice(a, b)), a, b, 'select');
      redraw();
    }),
    tplSel);

  // ---- stamps
  const renderStamps = () => {
    stampList.innerHTML = '';
    stamps.forEach((s, i) => {
      const sig = s.stampType === 'Signature';
      const col = h('input', { type: 'color', value: inputColor(s.stampedColor), title: 'Цвет чернил', style: 'width:26px;padding:0;height:20px' });
      col.onchange = () => { s.stampedColor = engineColor(col.value); redraw(); };
      stampList.append(h('div', { class: 'li' },
        h('span', { style: 'display:flex;gap:6px;align-items:center;min-width:0' },
          h('span', { class: 'stamp-chip' + (sig ? ' sig' : ''), style: `color:${cssColor(s.stampedColor)}` }, stampText(s) || '—'),
          h('span', { class: 'muted', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, sig ? 'подпись' : s.stampedName)),
        h('span', { style: 'display:flex;gap:4px;align-items:center;flex:none' }, col,
          h('button', { style: 'padding:0 4px', title: 'Выше', disabled: i === 0, onclick: () => { [stamps[i - 1], stamps[i]] = [stamps[i], stamps[i - 1]]; renderStamps(); redraw(); } }, icon('arrowUp')),
          h('button', { style: 'padding:0 4px', title: 'Снять', onclick: () => { stamps.splice(i, 1); if (!stamps.length) stampState = null; renderStamps(); renderMarks(); redraw(); } }, icon('x')))));
    });
    if (!stamps.length) stampList.append(h('div', { class: 'li muted' }, 'Печатей нет'));
  };
  // PaperSystem.TryStamp: the first stamp also sets the mark drawn on the paper sprite
  const addStamp = (s, state) => {
    if (stamps.length >= 100) { toast('Не больше 100 печатей (StampLimit)', 'err'); return; }
    stamps.push(s);
    if (!stampState && state) stampState = state;
    renderStamps(); renderMarks(); redraw();
  };
  const fromProto = p => ({ reapply: p.stamp.reapply ? 'True' : 'False', stampType: 'RubberStamp', stampedColor: engineColor(p.stamp.color), stampedName: p.stamp.name });
  const rubber = stampProtos().filter(p => p.stamp.state !== SIGN_STATE)
    .sort((a, b) => (P.stampNames[a.stamp.name] || a.stamp.name).localeCompare(P.stampNames[b.stamp.name] || b.stamp.name));
  const buildStamps = h('div', { class: 'stamp-grid' }, ...rubber.map(p => h('button', {
    class: 'stamp-pick', title: `${p.id}\n${p.stamp.name}\n${p.stamp.color}${p.donotmap ? '\n(DoNotMap)' : ''}`,
    onclick: () => addStamp(fromProto(p), p.stamp.state),
  }, h('img', { src: A.iconUrl(p.id), onerror: ev => { ev.target.style.visibility = 'hidden'; } }),
    h('span', { style: `color:${cssColor(p.stamp.color)}` }, P.stampNames[p.stamp.name] || p.stamp.name))));

  // custom stamp / signature
  const cName = h('input', { class: 'grow', placeholder: 'текст печати или имя для подписи', value: S.paper.lastName || '' });
  const cColor = h('input', { type: 'color', value: S.paper.lastColor || '#bb3232', style: 'width:30px;padding:0;height:24px' });
  const cType = h('select', {}, h('option', { value: 'RubberStamp' }, 'печать (с рамкой)'), h('option', { value: 'Signature' }, 'подпись (без рамки)'));
  const pens = [...new Map(stampProtos().filter(p => p.stamp.state === SIGN_STATE).map(p => [engineColor(p.stamp.color), p])).values()];
  const penRow = h('span', { style: 'display:inline-flex;gap:2px' }, ...pens.map(p => h('button', {
    class: 'pen-dot', title: `Цвет как у ${p.id}`, style: `background:${cssColor(p.stamp.color)}`,
    onclick: () => { cColor.value = inputColor(p.stamp.color); cType.value = 'Signature'; },
  })));
  const customStamp = () => ({ name: cName.value.trim(), color: engineColor(cColor.value), type: cType.value });
  const addCustom = c => {
    if (!c.name) { toast('Введите текст печати', 'err'); return; }
    addStamp({ reapply: 'False', stampType: c.type, stampedColor: c.color, stampedName: c.name }, c.type === 'Signature' ? SIGN_STATE : 'paper_stamp-generic');
  };
  const savedBox = h('div', { class: 'row' });
  const renderSaved = () => {
    savedBox.innerHTML = '';
    if (!S.paper.custom.length) return;
    savedBox.append(h('span', { class: 'muted' }, 'Свои:'), ...S.paper.custom.map((c, i) => h('span', { class: 'saved-stamp' },
      h('button', { class: 'stamp-chip' + (c.type === 'Signature' ? ' sig' : ''), style: `color:${cssColor(c.color)}`, title: 'Поставить', onclick: () => addCustom(c) }, c.name),
      h('button', { style: 'padding:0 3px', title: 'Забыть', onclick: () => { S.paper.custom.splice(i, 1); savePrefs(); renderSaved(); } }, icon('x')))));
  };
  const customRow = h('div', { class: 'row' }, cName, cColor, penRow, cType,
    h('button', { onclick: () => { S.paper.lastName = cName.value; S.paper.lastColor = cColor.value; savePrefs(); addCustom(customStamp()); } }, '+ поставить'),
    h('button', { title: 'Запомнить в списке своих печатей (хранится в браузере)', onclick: () => {
      const c = customStamp();
      if (!c.name) { toast('Введите текст печати', 'err'); return; }
      S.paper.custom = S.paper.custom.filter(x => !(x.name === c.name && x.type === c.type)).concat(c);
      savePrefs(); renderSaved();
    } }, icon('star'), ' запомнить'));

  // sprite mark (PaperVisualLayers.Stamp)
  const renderMarks = () => {
    markRow.innerHTML = '';
    const pick = st => { stampState = st; renderMarks(); };
    markRow.append(h('button', { class: 'mark' + (!stampState ? ' on' : ''), title: 'Без отметки на спрайте', onclick: () => pick(null) }, '∅'));
    const states = new Set(info.stampStates);
    if (stampState) states.add(stampState);
    for (const st of states) {
      markRow.append(h('button', { class: 'mark' + (st === stampState ? ' on' : ''), title: st, onclick: () => pick(st), style: `background-image:url("${A.iconUrl(proto)}")` },
        h('img', { src: `/api/rsistate?rsi=${enc(info.rsi)}&state=${enc(st)}`, onerror: ev => { ev.target.replaceWith(st.replace('paper_stamp-', '')); } })));
    }
  };

  const apply = () => {
    if (ta.value.length > limit && !confirm(`Текст длиннее лимита бумаги (${ta.value.length} > ${limit}): в игре дописать его не выйдет, но загрузится он целиком. Сохранить?`)) return;
    const comps = (compsOf(uid) || []).map(c => ({ ...c }));
    const i = comps.findIndex(c => c.type === 'Paper');
    const pc = paperComp(i >= 0 ? comps[i] : null, info, ta.value, stamps, stampState);
    if (i >= 0) { if (pc) comps[i] = pc; else comps.splice(i, 1); } else if (pc) comps.push(pc);
    M().begin('Текст бумаги');
    putComps(uid, comps);
    M().commit();
    closeModal();
    toast('Бумага сохранена', 'ok');
    renderInspector();
    requestDraw();
  };

  const body = h('div', { class: 'paper-dlg' },
    h('div', { class: 'paper-cols' },
      h('div', { class: 'paper-left' },
        toolbar, ta,
        h('div', { class: 'row', style: 'justify-content:space-between' }, counter,
          h('span', {},
            h('button', { title: 'Текст, который у прототипа по умолчанию', onclick: () => { ta.value = info.content || ''; redraw(); } }, 'Текст прототипа'),
            ' ', h('button', { onclick: () => { ta.value = ''; redraw(); } }, 'Очистить'))),
        warn,
        h('h4', {}, 'Печати на листе (stampedBy)'), stampList,
        h('details', { class: 'stamp-src', open: true }, h('summary', {}, `Печати сборки (${rubber.length})`), buildStamps),
        h('h4', {}, 'Своя печать или подпись'), customRow, savedBox,
        h('h4', {}, 'Отметка на спрайте бумаги (stampState)'), markRow),
      h('div', { class: 'paper-right' }, h('div', { class: 'muted', style: 'font-size:11px;margin-bottom:4px' }, `${proto} · uid ${uid} — так лист выглядит в игре`), preview)),
    h('div', { class: 'row', style: 'justify-content:flex-end' },
      h('button', { onclick: closeModal }, 'Отмена'), h('button', { class: 'on', onclick: apply }, 'Применить')));
  modal('Бумага: ' + displayName('entity', proto), body, null, { wide: true });
  renderStamps(); renderMarks(); renderSaved();
  ta.addEventListener('keydown', ev => {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    const map = { KeyB: ['[bold]', '[/bold]'], KeyI: ['[italic]', '[/italic]'], KeyU: ['[uline]', '[/uline]'] };
    if (map[ev.code]) { ev.preventDefault(); wrap(...map[ev.code]); }
    if (ev.code === 'Enter') { ev.preventDefault(); apply(); }
  });
  redraw();
  ta.focus();
}

// ================================================================= names and descriptions (MetaData)
const textCache = new Map();   // proto -> {name, desc} as the game shows them
export async function protoTexts(ids) {
  const need = [...new Set(ids)].filter(id => !textCache.has(id));
  if (need.length) {
    const r = await api.post('/api/enttext', { ids: need });
    for (const id of need) textCache.set(id, r[id] || { name: id, desc: '' });
  }
  return id => textCache.get(id) || { name: id, desc: '' };
}
export function metaOf(uid) {
  const md = (compsOf(uid) || []).find(c => c.type === 'MetaData') || {};
  return { name: typeof md.name === 'string' ? md.name : null, desc: typeof md.desc === 'string' ? md.desc : null };
}
/** Sets MetaData name / desc of uid (null = as the prototype); call inside a transaction. */
export function setMeta(uid, { name, desc }) {
  const comps = (compsOf(uid) || []).map(c => ({ ...c }));
  let i = comps.findIndex(c => c.type === 'MetaData');
  if (i < 0) { comps.unshift({ type: 'MetaData' }); i = 0; }
  const md = comps[i];
  if (name !== undefined) { if (name === null || name === '') delete md.name; else md.name = name; }
  if (desc !== undefined) { if (desc === null || desc === '') delete md.desc; else md.desc = desc; }
  if (Object.keys(md).length === 1) comps.splice(i, 1);
  putComps(uid, comps);
}

/** Name / description fields (+ paper button) for the inspector. */
export async function metaSection(box, uid) {
  const proto = protoIdOf(uid);
  const sec = h('div', {});
  box.append(sec);
  const t = (await protoTexts([proto]))(proto);
  const cur = metaOf(uid);
  const nameIn = h('input', { class: 'grow', placeholder: t.name || proto, value: cur.name ?? '' });
  const descIn = h('textarea', { rows: 2, placeholder: t.desc || 'описание прототипа пустое', style: 'font-family:inherit' });
  descIn.value = cur.desc ?? '';
  const save = () => {
    const n = nameIn.value.trim(), d = descIn.value.trim();
    const now = metaOf(uid);
    if ((now.name ?? '') === n && (now.desc ?? '') === d) return;
    M().begin('Название / описание');
    setMeta(uid, { name: n || null, desc: d || null });
    M().commit();
    toast(n || d ? 'Название / описание заданы' : 'Название / описание как у прототипа', 'ok');
  };
  for (const el of [nameIn, descIn]) {
    el.addEventListener('change', save);
    el.addEventListener('keydown', ev => { if (ev.key === 'Enter' && (el === nameIn || ev.ctrlKey)) { ev.preventDefault(); el.blur(); } if (ev.key === 'Escape') { el.value = (el === nameIn ? metaOf(uid).name : metaOf(uid).desc) ?? ''; el.blur(); } });
  }
  sec.append(h('h4', {}, 'Название и описание (MetaData)'),
    h('div', { class: 'row' }, nameIn, h('button', { title: 'Как у прототипа', onclick: () => { nameIn.value = ''; descIn.value = ''; save(); } }, icon('rotateCcw'))),
    descIn,
    h('div', { class: 'muted', style: 'font-size:11px' }, 'Пустое поле — текст прототипа (серым). Enter — применить, Esc — отменить.'));
  if (isPaper(proto)) sec.append(h('div', { class: 'row' }, h('button', { onclick: () => paperDialog(uid) }, icon('paper'), ' Текст и печати бумаги'), paperSummary(uid)));
}
function paperSummary(uid) {
  const pc = (compsOf(uid) || []).find(c => c.type === 'Paper');
  if (!pc) return h('span', { class: 'muted' }, 'текст прототипа');
  const n = typeof pc.content === 'string' ? pc.content.length : 0;
  const s = Array.isArray(pc.stampedBy) ? pc.stampedBy.length : 0;
  return h('span', { class: 'muted' }, `${n} симв.${s ? ', печатей: ' + s : ''}`);
}

// ---------------------------------------------------------------- bulk editor
/** Entities of the edited grid: placed ones and everything inside them. */
function gridEntities() {
  const m = M();
  const out = [];
  for (const e of m.ents.values()) {
    out.push({ uid: e.uid, proto: e.proto, holder: null, x: e.x, y: e.y });
    for (const d of m.descendants(e.uid)) {
      const o = m.others.get(d);
      // entities without a prototype are internals (solutions of containers), not things a player sees
      if (o && o.proto) out.push({ uid: d, proto: o.proto, holder: e.uid, x: e.x, y: e.y });
    }
  }
  const n = u => parseInt(u, 10) || 0;
  return out.sort((a, b) => a.proto.localeCompare(b.proto) || n(a.uid) - n(b.uid));
}

export async function namesDialog(focusUid) {
  const all = gridEntities();
  const T = await protoTexts(all.map(e => e.proto));
  const q = h('input', { type: 'search', class: 'grow', placeholder: 'Поиск: прототип, название, описание, uid' });
  const onlySet = h('input', { type: 'checkbox', checked: !!S.paper.namesOnlySet });
  const onlyItems = h('input', { type: 'checkbox', checked: !!S.paper.namesItems });
  const onlyPaper = h('input', { type: 'checkbox' });
  const list = h('div', { class: 'list names-list' });
  const info = h('span', { class: 'muted' });
  const pending = new Map();   // uid -> {name, desc}
  const applyBtn = h('button', { class: 'on', disabled: true }, 'Применить');
  const LIMIT = 300;
  const render = () => {
    const terms = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    list.innerHTML = '';
    let n = 0, shown = 0;
    for (const e of all) {
      const p = protoOf(e.proto);
      const meta = pending.get(e.uid) || metaOf(e.uid);
      if (onlySet.checked && meta.name == null && meta.desc == null) continue;
      if (onlyItems.checked && !(p && p.c && p.c.includes('Item'))) continue;
      if (onlyPaper.checked && !(p && p.paper)) continue;
      const t = T(e.proto);
      if (terms.length) {
        const hay = [e.uid, e.proto, t.name, t.desc, meta.name, meta.desc, p && p.ru].join(' ').toLowerCase();
        if (!terms.every(w => hay.includes(w))) continue;
      }
      n++;
      if (shown >= LIMIT && e.uid !== focusUid) continue;
      shown++;
      const nameIn = h('input', { placeholder: t.name || e.proto, value: meta.name ?? '' });
      const descIn = h('input', { placeholder: t.desc || '—', value: meta.desc ?? '' });
      const mark = () => {
        const v = { name: nameIn.value.trim() || null, desc: descIn.value.trim() || null };
        const cur = metaOf(e.uid);
        if (v.name === cur.name && v.desc === cur.desc) pending.delete(e.uid); else pending.set(e.uid, v);
        row.classList.toggle('changed', pending.has(e.uid));
        applyBtn.disabled = !pending.size;
        applyBtn.textContent = pending.size ? `Применить (${pending.size})` : 'Применить';
      };
      nameIn.oninput = mark; descIn.oninput = mark;
      const [tx, ty] = tileOf(e.x, e.y);
      const row = h('div', { class: 'names-row' + (pending.has(e.uid) ? ' changed' : '') + (e.uid === focusUid ? ' focus' : '') },
        h('img', { src: A.iconUrl(e.proto), onerror: ev => { ev.target.style.visibility = 'hidden'; } }),
        h('span', { class: 'nm-id', title: `${displayName('entity', e.proto)}\nuid ${e.uid}${e.holder ? '\nвнутри ' + e.holder : ''}` },
          h('b', {}, e.proto), h('br'), h('span', { class: 'muted' }, `${e.uid}${e.holder ? ' ⊂ ' + e.holder : ''} · (${tx}, ${ty})`)),
        nameIn, descIn,
        h('span', { class: 'nm-act' },
          p && p.paper ? h('button', { title: 'Текст и печати бумаги', onclick: () => paperDialog(e.uid) }, icon('paper')) : null,
          h('button', { title: 'Показать на карте', onclick: () => { closeModal(); S.inspected = e.holder || e.uid; centerOn(e.x, e.y); renderInspector(); requestDraw(); } }, icon('locate'))));
      list.append(row);
    }
    info.textContent = n > shown ? `Показано ${shown} из ${n} — уточните поиск` : `Сущностей: ${n}`;
    const f = list.querySelector('.focus input');
    if (f) { f.scrollIntoView({ block: 'center' }); f.focus(); }
  };
  applyBtn.onclick = () => {
    if (!pending.size) return;
    M().begin('Названия и описания');
    for (const [uid, v] of pending) setMeta(uid, v);
    M().commit();
    toast(`Изменено сущностей: ${pending.size}`, 'ok');
    pending.clear();
    applyBtn.disabled = true;
    applyBtn.textContent = 'Применить';
    render();
    renderInspector();
  };
  let tmr = 0;
  q.oninput = () => { clearTimeout(tmr); tmr = setTimeout(render, 150); };
  for (const [c, k] of [[onlySet, 'namesOnlySet'], [onlyItems, 'namesItems']]) c.onchange = () => { S.paper[k] = c.checked; savePrefs(); render(); };
  onlyPaper.onchange = render;
  const body = h('div', {},
    h('div', { class: 'row' }, q,
      h('label', { class: 'chk' }, onlySet, 'только изменённые'),
      h('label', { class: 'chk' }, onlyItems, 'только предметы'),
      h('label', { class: 'chk' }, onlyPaper, 'только бумаги')),
    h('div', { class: 'names-head' }, h('span'), h('span', {}, 'Сущность'), h('span', {}, 'Название'), h('span', {}, 'Описание'), h('span')),
    list,
    h('div', { class: 'row', style: 'justify-content:space-between' }, info,
      h('span', { class: 'muted', style: 'font-size:11px' }, 'Пустое поле — текст прототипа (серым). Изменения применяются одной правкой (Ctrl+Z).'),
      applyBtn));
  modal('Названия и описания', body, null, { wide: true });
  if (focusUid) { const p = all.find(e => e.uid === focusUid); if (p) q.value = ''; }
  render();
  if (!focusUid) q.focus();
}
