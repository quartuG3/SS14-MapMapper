// Automated smoke test, run with ?selftest=1. Drives tools with synthetic pointer events.
import { S } from './state.js';
import { setTool, setMode, startPaste, rotateBrushTile } from './tools.js';
import { w2s, bake } from './view.js';
import * as UI from './ui.js';
import { validate, stats, findReplace } from './features.js';
import { key, openPipeEnds, cableNetwork, exposedTiles, pipeDirsOf, rotateTileVal, mirrorTileVal } from './logic.js';
import { P } from './protos.js';
import { ent as protoOf } from './protos.js';

const log = [];
const ok = (name, cond, extra = '') => log.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ptr(type, x, y, opts = {}) {
  const cv = document.getElementById('view');
  const r = cv.getBoundingClientRect();
  const [sx, sy] = w2s(x + 0.5, y + 0.5);
  cv.dispatchEvent(new PointerEvent(type, { clientX: r.left + sx, clientY: r.top + sy, button: opts.button || 0, buttons: 1, pointerId: 1, bubbles: true, shiftKey: !!opts.shift, ctrlKey: !!opts.ctrl, altKey: !!opts.alt }));
}
function drag(path, opts) {
  ptr('pointerdown', path[0][0], path[0][1], opts);
  for (const p of path.slice(1)) ptr('pointermove', p[0], p[1], opts);
  const l = path[path.length - 1];
  ptr('pointerup', l[0], l[1], opts);
}
const click = (x, y, opts) => drag([[x, y]], opts);
const entsAt = (x, y) => S.model.entsAt(x, y).map(u => S.model.ents.get(u));

export async function run() {
  const out = document.createElement('pre');
  out.id = 'dbg';
  try {
    const m = S.model;
    S.view.z = 32; S.view.cx = 0; S.view.cy = 0;
    // tiles
    setTool('tile'); S.sel.tile = 'FloorSteel'; S.brush = 1;
    drag([[-5, -3], [5, -3]]);
    ok('tile line', m.tiles.size >= 11, `tiles=${m.tiles.size}`);
    drag([[-5, -3], [5, 3]], { ctrl: true });
    ok('tile rect', m.tiles.size >= 77, `tiles=${m.tiles.size}`);
    // walls with entity tool (rect outline)
    setTool('entity'); S.sel.entity = 'WallReinforced'; S.rotSteps = 0;
    drag([[-6, -4], [6, 4]], { ctrl: true, shift: true });
    const walls = [...m.ents.values()].filter(e => e.proto === 'WallReinforced').length;
    ok('wall outline', walls === 13 * 2 + 7 * 2, `walls=${walls}`);
    ok('no leaks', exposedTiles(m).size === 0, `exposed=${exposedTiles(m).size}`);
    // single placement + rotation
    S.sel.entity = 'ChairOfficeDark'; S.rotSteps = 1;
    click(0, 0);
    ok('place rotated', entsAt(0, 0).some(e => e.proto === 'ChairOfficeDark' && Math.abs(e.rot - Math.PI / 2) < 1e-6));
    // right click removes
    click(0, 0, { button: 2 });
    ok('remove top', !entsAt(0, 0).some(e => e.proto === 'ChairOfficeDark'));
    // pipes
    setTool('pipe'); S.pipe.layer = 'Primary'; S.pipe.color = '#0055CCFF';
    drag([[-3, 1], [0, 1], [0, -2]]);
    const bend = entsAt(0, 1)[0];
    ok('pipe bend', bend && bend.proto === 'GasPipeBend', bend && bend.proto);
    ok('pipe dirs', bend && pipeDirsOf(bend) === (8 | 2), bend && String(pipeDirsOf(bend)));
    ok('pipe ends (half caps)', openPipeEnds(m).length === 0, String(openPipeEnds(m).length));
    drag([[-1, 1], [-1, 2]]);
    ok('pipe tjunction', entsAt(-1, 1).some(e => e.proto === 'GasPipeTJunction'));
    S.pipe.layer = 'Secondary';
    drag([[2, -2], [2, 2]]);
    ok('pipe layer comp', entsAt(2, 0).some(e => (e.comps || []).some(c => c.type === 'AtmosPipeLayers' && c.pipeLayer === 'Secondary')));
    click(2, 2, { button: 2 });
    ok('pipe erase refit', entsAt(2, 1).some(e => e.proto === 'GasPipeHalf') || entsAt(2, 1).some(e => e.proto === 'GasPipeStraight'));
    // wires
    setTool('wire'); S.wire.kind = 'MV';
    drag([[-4, -1], [4, -1]]);
    const c = entsAt(-4, -1).find(e => protoOf(e.proto)?.cable === 'MV');
    ok('wire placed', !!c);
    ok('wire network', c && cableNetwork(m, c.uid).size === 9, c && String(cableNetwork(m, c.uid).size));
    setMode('normal');
    // decal
    setTool('decal'); S.sel.decal = 'BrickTileSteelLineN';
    click(-2, 2);
    ok('decal', m.decalsAt(-2, 2).length === 1);
    // mirror placement
    S.mirror.x = true; S.mirror.ax = 0.5;
    setTool('entity'); S.sel.entity = 'BenchSofaCorpLeft'; S.rotSteps = 0;
    click(-3, 2);
    const mirrored = entsAt(3, 2).find(e => e.proto.startsWith('BenchSofaCorp'));
    ok('mirror chiral swap', mirrored && mirrored.proto === 'BenchSofaCorpRight', mirrored && mirrored.proto);
    S.sel.entity = 'GasPipeBend'; S.rotSteps = 0;
    click(-4, 3);
    const mb = entsAt(4, 3).find(e => e.proto === 'GasPipeBend');
    ok('mirror pipe bend', mb && pipeDirsOf(mb) === (2 | 4), mb && String(pipeDirsOf(mb)));
    setTool('tile'); S.sel.tile = 'FloorWood';
    click(-4, -2);
    ok('mirror tile', m.getTile(4, -2)?.[0] === 'FloorWood', m.getTile(4, -2)?.[0]);
    // symmetry preset: explicit counterparts, both directions, disabled group falls back
    const symGroup = { name: 't', kind: 'tile', on: true, cells: [{ id: 'FloorWood', rot: null }, { id: 'Plating', rot: null }, null, null] };
    const symPrev = S.symmetry.active;
    S.symmetry.presets.push({ name: 'selftest', groups: [symGroup] });
    S.symmetry.active = S.symmetry.presets.length - 1;
    click(-4, 0);
    ok('symmetry preset tile', m.getTile(4, 0)?.[0] === 'Plating', m.getTile(4, 0)?.[0]);
    S.sel.tile = 'Plating';
    click(-4, 1);
    ok('symmetry preset reverse', m.getTile(4, 1)?.[0] === 'FloorWood', m.getTile(4, 1)?.[0]);
    symGroup.on = false;
    click(-4, 2);
    ok('symmetry group off', m.getTile(4, 2)?.[0] === 'Plating', m.getTile(4, 2)?.[0]);
    S.symmetry.presets.pop();
    S.symmetry.active = symPrev;
    // multi-tile footprint: the 2×2 thruster sits on its corner tile, the mirror keeps the 2×2 block symmetric
    if (protoOf('ThrusterLarge')?.fp) {
      setTool('entity'); S.sel.entity = 'ThrusterLarge'; S.rotSteps = 0;
      click(-5, 8);
      const th = [...m.ents.values()].filter(e => e.proto === 'ThrusterLarge').map(e => `${e.x},${e.y}`).sort();
      ok('mirror multi-tile footprint', th.join(' ') === '-4.5,8.5 4.5,8.5', th.join(' '));
      setTool('tile');
    }
    // shaped tiles rotate / mirror by their vertex geometry
    if (P.tiles.get('LatticeWedgeN')?.verts && P.tiles.has('LatticeHalfTiltNESLower')) {
      const rot = (id, k) => rotateTileVal([id, 0, 0, 0], k)[0];
      ok('shaped tile rotate wedge', rot('LatticeWedgeN', 1) === 'LatticeWedgeW' && rot('LatticeWedgeN', 2) === 'LatticeWedgeS', rot('LatticeWedgeN', 1));
      ok('shaped tile rotate half-tilt', rot('LatticeHalfTiltNESLower', 1) === 'LatticeHalfTiltNWELower' && rot('LatticeHalfTiltNESLower', 4) === 'LatticeHalfTiltNESLower', rot('LatticeHalfTiltNESLower', 1));
      ok('shaped tile rotate half', rot('LatticeHalfV', 1) === 'LatticeHalfH', rot('LatticeHalfV', 1));
      setTool('tile'); S.sel.tile = 'LatticeWedgeN';
      rotateBrushTile(1);
      ok('brush R shaped tile', S.sel.tile === 'LatticeWedgeW', S.sel.tile);
      rotateBrushTile(3);
      ok('brush Shift+R shaped tile', S.sel.tile === 'LatticeWedgeN', S.sel.tile);
      const rmTile = [...P.tiles.values()].find(t => t.rotmir && !t.space);
      if (rmTile) {
        S.sel.tile = rmTile.id; S.tileOpts.rm = 0;
        rotateBrushTile(1);
        click(-6, 10);
        ok('brush R rotmir tile', S.tileOpts.rm === 1 && m.getTile(-6, 10)?.[3] === 1, `${rmTile.id} rm=${S.tileOpts.rm} tile=${JSON.stringify(m.getTile(-6, 10))}`);
        S.tileOpts.rm = 0;
      }
      ok('shaped tile mirror w/o preset', mirrorTileVal(['LatticeHalfTiltNESLower', 0, 0, 0], 'x')[0] === 'LatticeHalfTiltNWSLower');
    }
    // drag the mirror axis by its ruler handle
    {
      const rt = document.getElementById('rulerTop'), vr = document.getElementById('view').getBoundingClientRect();
      const ry = rt.getBoundingClientRect().top + 5, guides = S.guides.length;
      const ev = (t, wx) => new PointerEvent(t, { clientX: vr.left + w2s(wx, 0)[0], clientY: ry, button: 0, bubbles: true });
      rt.dispatchEvent(ev('pointerdown', 0.5));
      window.dispatchEvent(ev('pointermove', 3.2));
      window.dispatchEvent(ev('pointerup', 3.2));
      ok('mirror axis ruler drag', S.mirror.ax === 3 && S.guides.length === guides, `ax=${S.mirror.ax} guides=${S.guides.length}`);
      S.mirror.ax = 0.5;
    }
    S.mirror.x = false;
    // selection + copy/paste + transforms
    setTool('select');
    drag([[-5, -3], [-1, 3]]);
    ok('select rect', S.selection.size === 35, String(S.selection.size));
    UI.selAction('copy');
    ok('clipboard', S.clipboard && S.clipboard.tiles.length === 35);
    const before = m.ents.size;
    startPaste(S.clipboard);
    click(12, 0);
    ok('paste', m.ents.size > before, `${before} -> ${m.ents.size}`);
    setTool('select');
    UI.selAction('flipX');
    UI.selAction('rot');
    ok('transform sel', S.selection.size > 0);
    // move selection by drag
    const anyKey = [...S.selection][0];
    const [ax, ay] = anyKey.split(',').map(Number);
    drag([[ax, ay], [ax + 3, ay]]);
    ok('move sel', S.selection.has(key(ax + 3, ay)));
    // fill tool
    setTool('fill'); S.palKind = 'tile'; S.sel.tile = 'FloorDark';
    click(1, 0);
    ok('fill inside walls', m.getTile(1, 0)?.[0] === 'FloorDark' && m.getTile(-6, 0)?.[0] !== 'FloorDark');
    // random
    S.random.sets = [{ name: 't', kind: 'entity', items: [{ id: 'PottedPlant1', w: 1 }, { id: 'PottedPlant2', w: 2 }], randRot: true }];
    S.random.active = 0; S.random.density = 100; S.random.fixedSeed = true;
    setTool('random'); S.brush = 3;
    click(3, 0);
    ok('random brush', [...m.ents.values()].filter(e => e.proto.startsWith('PottedPlant')).length >= 5);
    S.selection = new Set([key(1, 1), key(2, 1)]);
    UI.selAction('variants');
    // placement step / duplicates / nudge
    S.mirror.x = false;
    setTool('entity'); S.sel.entity = 'PottedPlant1'; S.rotSteps = 0; S.entOpts.step = '0.25'; S.entOpts.allowDup = false;
    click(8, 8);
    click(8, 8);
    ok('no dup by default', entsAt(8, 8).filter(e => e.proto === 'PottedPlant1').length === 1);
    S.entOpts.allowDup = true;
    click(8, 8);
    ok('dup allowed', entsAt(8, 8).filter(e => e.proto === 'PottedPlant1').length === 2);
    S.entOpts.allowDup = false; S.entOpts.step = 'center';
    setTool('inspect');
    click(8, 8);
    const insp = S.inspected;
    const ox = m.ents.get(insp).x;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', shiftKey: true }));
    ok('nudge', Math.abs(m.ents.get(insp).x - ox - 0.25) < 1e-6, `${ox} -> ${m.ents.get(insp).x}`);
    // devices visible in palette
    ok('APC not hidden', !protoOf('APCBasic')?.hidden);
    ok('vent not hidden', !protoOf('GasVentPump')?.hidden);
    // guides: drag and remove
    S.guides.push({ axis: 'x', v: 0 });
    drag([[0, 0], [3, 0]].map(([x, y]) => [x - 0.5, y]));
    ok('guide moved', S.guides.length === 1 && S.guides[0].v !== 0, String(S.guides[0]?.v));
    const gv = S.guides[0].v;
    click(gv - 0.5, 0, { button: 2 });
    ok('guide removed by RMB', S.guides.length === 0);
    // palette: every visible prototype must be reachable by scrolling
    UI.setPalKind('entity');
    const grid = document.getElementById('palGrid');
    const total = [...(await import('./protos.js')).P.ents.values()].filter(p => !p.hidden).length;
    for (let k = 0; k < 400 && grid.querySelectorAll('.pi').length < total; k++) { grid.scrollTop = grid.scrollHeight; grid.dispatchEvent(new Event('scroll')); await sleep(5); }
    ok('palette complete', grid.querySelectorAll('.pi').length === total, `${grid.querySelectorAll('.pi').length}/${total} · ${grid.firstChild.textContent}`);
    UI.setPalKind('tile');
    // ---- new features
    const LK = await import('./links.js');
    const OPS = await import('./ops.js');
    const VW = await import('./view.js');
    S.entOpts.step = 'center'; S.entOpts.allowDup = false; S.mirror.x = false;
    // underlay on empty space
    S.entOpts.underlay = true; S.entOpts.underlayTile = 'Plating'; S.entOpts.replaceStructs = false;
    setTool('entity'); S.sel.entity = 'WallReinforced'; S.rotSteps = 0;
    click(20, 20);
    ok('underlay tile', m.getTile(20, 20)?.[0] === 'Plating', String(m.getTile(20, 20)?.[0]));
    // multiple structures warning, then replacement
    S.sel.entity = 'ReinforcedWindow';
    click(20, 20);
    ok('struct warning', entsAt(20, 20).length === 2 && validate(m).some(i => /Несколько структур/.test(i.msg)));
    S.entOpts.replaceStructs = true;
    S.sel.entity = 'WallReinforced';
    click(20, 20);
    ok('replace structs', entsAt(20, 20).length === 1 && entsAt(20, 20)[0].proto === 'WallReinforced', entsAt(20, 20).map(e => e.proto).join(','));
    S.entOpts.replaceStructs = false;
    // device list: air alarm + vent in a small room
    setTool('tile'); S.sel.tile = 'FloorSteel';
    drag([[30, 30], [34, 33]], { ctrl: true });
    setTool('entity'); S.sel.entity = 'WallReinforced';
    drag([[29, 29], [35, 34]], { ctrl: true, shift: true });
    S.sel.entity = 'AirAlarm'; S.rotSteps = 2;   // on the south wall, facing north into the room
    click(32, 29);
    S.sel.entity = 'GasVentPump'; S.rotSteps = 0; click(31, 31);
    S.sel.entity = 'GasVentScrubber'; click(33, 31);
    const alarm = entsAt(32, 29).find(e => e.proto === 'AirAlarm');
    const vent = entsAt(31, 31).find(e => e.proto === 'GasVentPump');
    ok('orphan vents reported', validate(m).some(i => /без воздушной сигнализации/.test(i.msg)));
    const r = LK.autoLinkRoom(alarm.uid);
    ok('auto link room', r.added === 2 && LK.listDevices(m.ents.get(alarm.uid)).includes(vent.uid), `added=${r.added} room=${r.room.size}`);
    ok('device knows list', LK.memberOf(m.ents.get(vent.uid)).includes(alarm.uid));
    // link tool by clicks: toggle vent off
    setTool('link'); const TLm = await import('./tools.js'); TLm.link.mode = 'list'; TLm.link.holder = null;
    click(32, 29);
    ok('link holder picked', TLm.link.holder === alarm.uid, String(TLm.link.holder));
    click(31, 31);
    ok('link toggle off', !LK.listDevices(m.ents.get(alarm.uid)).includes(vent.uid));
    click(31, 31);
    ok('link toggle on', LK.listDevices(m.ents.get(alarm.uid)).includes(vent.uid));
    TLm.link.holder = null;
    // signal link
    setTool('entity'); S.sel.entity = 'SignalButton'; click(30, 32);
    S.sel.entity = 'BlastDoor'; click(32, 33);
    const btn = entsAt(30, 32).find(e => e.proto === 'SignalButton'), bd = entsAt(32, 33).find(e => e.proto === 'BlastDoor');
    const dp = LK.defaultPairs(btn, bd);
    ok('default ports', dp.some(p => p[0] === 'Pressed' && p[1] === 'Toggle'), JSON.stringify(dp));
    LK.setPairs(btn.uid, bd.uid, dp);
    ok('signal linked', LK.pairsBetween(m.ents.get(btn.uid), bd.uid).length === dp.length);
    // containers
    S.sel.entity = 'LockerSteel'; click(33, 32);
    const locker = entsAt(33, 32).find(e => e.proto === 'LockerSteel');
    S.inspected = locker.uid;
    UI.showTab('inspector'); await sleep(50);
    const createBtn = [...document.querySelectorAll('#tab-inspector button')].find(b => b.textContent === '+ entity_storage');
    ok('container create button', !!createBtn);
    createBtn && createBtn.click();
    const added = UI.addToContainer(locker.uid, 'entity_storage', 'Crowbar', 2);
    ok('container add', added.length === 2 && m.descendants(locker.uid).length === 2);
    UI.removeFromContainer(locker.uid, 'entity_storage', added[0]);
    ok('container remove', m.descendants(locker.uid).length === 1);
    // stack menu shows all entities on a tile
    UI.stackMenu({ ev: { clientX: 100, clientY: 100 }, ents: entsAt(32, 29).concat(entsAt(31, 31)), onPick: () => {} });
    ok('stack menu', document.querySelectorAll('#stackMenu .li').length >= 2);
    document.getElementById('stackMenu')?.remove();
    // subfloor on grates
    ok('grate subfloor', VW.subfloorVisibleOn(['FloorMaintGrid', 0, 0, 0], 'Grid') && !VW.subfloorVisibleOn(['FloorSteel', 0, 0, 0], 'Grid') && VW.subfloorVisibleOn(['Plating', 0, 0, 0], ''));
    // vessel enums
    const en = await UI.api.get('/api/enums');
    ok('vessel enums', en.class.includes('Salvage') && en.engine.includes('AME') && en.group.includes('Shipyard'), en.class.length + ' classes');
    // save contains links/containers
    const yml = await UI.api.post('/api/save', { doc: m.toDoc(), write: false });
    ok('save links', yml.includes('linkedPorts:') && yml.includes('- Pressed') && yml.includes('deviceLists:') && yml.includes('entity_storage: !type:Container'));
    void OPS;
    // find/replace
    const n = findReplace(m, { kind: 'entity', from: 'WallReinforced', to: 'WallSolid', scope: 'all' });
    ok('find replace', n > 0 && ![...m.ents.values()].some(e => e.proto === 'WallReinforced'), String(n));
    // undo everything / redo everything
    const v = m.ents.size, t = m.tiles.size;
    let u = 0;
    while (m.undo()) u++;
    ok('undo all', m.ents.size === 0 && m.tiles.size === 1, `steps=${u} ents=${m.ents.size} tiles=${m.tiles.size}`);
    while (m.redo());
    ok('redo all', m.ents.size === v && m.tiles.size === t, `${m.ents.size}/${v} ${m.tiles.size}/${t}`);
    // features
    const issues = validate(m);
    ok('validate', issues.length > 0, issues.filter(i => i.sev === 'err').map(i => i.msg).slice(0, 3).join('; '));
    const st = stats(m);
    ok('stats', st.ents === m.ents.size);
    const cv = await bake({ px: 16, hideSubfloor: true, bg: 'transparent' });
    ok('bake', cv.width > 0 && cv.height > 0, `${cv.width}x${cv.height}`);
    // save round trip (no write)
    const text = await UI.api.post('/api/save', { doc: m.toDoc(), write: false, regenAtmos: true, atmos: { mix: 'air', exposedVacuum: true } });
    ok('save yml', typeof text === 'string' && text.includes('GridAtmosphere') && text.includes('proto: GasPipeBend'), `${text.length} bytes`);
    ok('save tilemap', /tilemap:\n(.*\n)*?\s+\d+: FloorSteel/.test(text.replace(/\r/g, '')));
    await sleep(300);
    // open a real map and run validator/bake
  } catch (e) {
    log.push('EXCEPTION ' + (e.stack || e));
  }
  out.textContent = log.join('\n');
  document.body.append(out);
}
