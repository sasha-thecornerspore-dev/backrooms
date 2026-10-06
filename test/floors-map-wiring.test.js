// Floors + map wiring (integrator step "floors-map"): game.js travels between stacked floors through ONE travel(way) in one coordinate
// system (topology.js), remembers each floor through levelmem (what you took / emptied / set down, where you stood, the arrival chunk),
// dies through death.js (a floor above, lighter, the trays locked), saves memory / playT / deaths every time and the fog on the full
// cadence, resumes in levelmem.applyResume's documented order, draws the pencil sheet (fogmap / sightpins / mapcard) on the cell-change
// tick only, holds the map without stopping the world, and points the two-line compass (compass.js) at what you have seen. game.js only
// boots in a page, so these are source guards plus the re-exports replayed (the behaviour itself is topology / levelmem / death / fogmap /
// sightpins / mapcard / compass .test.js and save-shape.test.js).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { exitArrow as gameArrow, applyResume as gameResume } from '../src/renderer/game.js'
import { exitArrow } from '../src/renderer/compass.js'
import { applyResume } from '../src/renderer/levelmem.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const game = read('../src/renderer/game.js')
const html = read('../src/renderer/index.html')
const sw = read('../src/sw.js')
const build = read('../tools/build-play.sh')
const readme = read('../README.md')
const at = (s) => { const k = game.indexOf(s); expect(k, s).toBeGreaterThan(0); return k }
const loopAt = game.indexOf('function loop(ts) {')
const slice = (from, to) => { const a = at(from), b = game.indexOf(to, a); expect(b, to).toBeGreaterThan(a); return game.slice(a, b) }

describe('game.js: the real exported names, the re-exports, the placeholders gone', () => {
  it('imports topology / levelmem / death / fogmap / sightpins / mapcard / compass by their real names', () => {
    expect(game).toMatch(/import \{ waysFor, stairsPass, chunkMid, findOpenNear, arrivalFor, wayMessage, wayLabel \} from '\.\/topology\.js'/)
    expect(game).toMatch(/import \{ createLevelMemory, applyResume \} from '\.\/levelmem\.js'/)
    expect(game).toMatch(/import \{ resolveDeath, onArrive, wakeSpot \} from '\.\/death\.js'/)
    expect(game).toMatch(/import \{ createFogMap, revealRadius \} from '\.\/fogmap\.js'/)
    expect(game).toMatch(/import \{ visibleWays, SIGHT_LINES, PROX_PIN \} from '\.\/sightpins\.js'/)
    expect(game).toMatch(/import \{ createMapCard \} from '\.\/mapcard\.js'/)
    expect(game).toMatch(/import \{ compassLines, compassText, arrivalSummary \} from '\.\/compass\.js'/)
  })
  it('exitArrow and applyResume are re-exported from game.js and ARE the modules\' functions; the local arrow table is gone', () => {
    expect(game).toMatch(/export \{ exitArrow \} from '\.\/compass\.js'/)
    expect(game).toMatch(/export \{ applyResume \} from '\.\/levelmem\.js'/)
    expect(gameArrow).toBe(exitArrow)
    expect(gameResume).toBe(applyResume)
    expect(game).not.toMatch(/const EXIT_DIRS = /)
    expect(game).not.toMatch(/function exitArrow\(/)
  })
  it('no TODO(integrate:floors) or TODO(integrate:map) is left; the state is declared once, outside the loop', () => {
    expect(game).not.toMatch(/TODO\(integrate:floors/)
    expect(game).not.toMatch(/TODO\(integrate:map\)/)
    for (const s of ['const mem = createLevelMemory()', 'let spawnChunk = { cx: 0, cy: 0 }', 'let closing    = null', 'let deaths     = 0',
      'let vendLocked = false', 'const fog = createFogMap()', 'let mapOpen = false, mapEverOpened = false, lastLostMsg = -Infinity',
      'const compassOut = []', 'const seenWays = [], seenSights = []', 'let vendedSet = new Set()']) {
      expect(at(s)).toBeLessThan(loopAt)
      expect((game.match(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length).toBe(1)
    }
    expect(game).not.toMatch(/const vendedSet = /)
  })
})

describe('game.js: buildLevel(index, at)', () => {
  const body = slice('function buildLevel(index, at = null) {', 'const fader = createFader(')
  it('sets cfg.ways before decor is built, streams the arrival chunk, runs stairsPass first after the sights (dress and haunts behind it), and spawns at the chunk\'s crossing', () => {
    expect(body).toMatch(/cfg\.ways {4}= waysFor\(index\)\r?\n\s*spawnChunk {2}= at \?\? \{ cx: 0, cy: 0 \}/)
    expect(body.indexOf('cfg.ways    = waysFor(index)')).toBeLessThan(body.indexOf('const decor     = createDecorSystem('))
    expect(body).toContain('cache.preload(spawnChunk.cx, spawnChunk.cy)')
    expect(body).toContain('grid.setPlayerChunk(spawnChunk.cx, spawnChunk.cy)')
    expect(body).toMatch(/passes: cfg\.map \? \[\] : \[stairsPass\(cfg, cfg\.ways\), dressPass\(cfg\), hauntsPass\(cfg\)\]\.filter\(Boolean\),/)
    expect(body).not.toMatch(/TODO\(integrate:dress\)/)
    expect(body).toMatch(/else \{ const mid = chunkMid\(spawnChunk\.cx, spawnChunk\.cy\), m = findOpenNear\(mid\.x, mid\.y, grid\.floor\) \?\? mid; player\.x = m\.x; player\.y = m\.y \}/)
    expect(body).not.toMatch(/player\.x = HALF \+ 0\.5/)
    expect(body).toContain('decor.update(spawnChunk.cx, spawnChunk.cy); itemSys.update(spawnChunk.cx, spawnChunk.cy)')
  })
  it('enters the items with what the floor remembers and takes the frame\'s vendedSet from levelmem (nothing for the block)', () => {
    expect(body).toContain('itemSys.enterLevel(cfg, cfg.map ? null : mem.takenFor(index), cfg.map ? null : mem.droppedFor(index))')
    expect(body).toMatch(/vendedSet = mem\.vendedFor\(index, playT\)/)
    expect(body).not.toContain('vendedSet.clear()')
  })
})

describe('game.js: travel(way) replaces descend', () => {
  const body = slice('function travel(way) {', '// die(): death.js resolves it')
  it('is the one way between floors: the closing guard, the memory written before the fade, the lift\'s line under it, no followers into the lift', () => {
    expect(game).not.toMatch(/\bdescend\(/)
    expect((game.match(/function travel\(/g) || []).length).toBe(1)
    expect(body).toMatch(/if \(closing && closing\.key === way\.key && playT < closing\.until\) return/)
    expect(body).toMatch(/const followers = \(creaturesOn && way\.kind !== 'lift'\) \? level\.entitySys\.snapshotChasers\(player, 10, 3\) : \[\]/)
    expect(body).toMatch(/mem\.leave\(level\.index, player, fromC, playT\)\r?\n\s*mem\.setDropped\(level\.index, itemSys\.getDropped\(\)\)\r?\n\s*fadeThen\(/)
    // the lift's 'before' line is pushed UNDER the veil, after buildLevel's msgQ.clear() (which dropped it when said before the fade), at combat
    // (never queued behind a prompt result) and right before the level name (combat queues FIFO: both read)
    expect(body).not.toMatch(/before: true \}\), PRIO\.discovery\)/)
    expect(body).toMatch(/persist\(true\)[^\n]*\r?\n(\s*\/\/[^\n]*\r?\n)*\s*if \(way\.kind === 'lift'\) showMessage\(wayMessage\(way, \{ before: true \}\), PRIO\.combat\)\r?\n\s*showMessage\(level\.cfg\.levelName, PRIO\.combat\)/)
    expect(body.indexOf('buildLevel(way.target, fromC)')).toBeLessThan(body.indexOf("{ before: true }"))
    expect(body.indexOf('if (mapOpen) closeMap()')).toBeLessThan(body.indexOf('fadeThen('))
  })
  it('under the fade: buildLevel at the from-chunk, the partner by kind, arrivalFor with the ring\'s memory, the closing way, the arrival record, the ceiling, the trays, the pin, the full save', () => {
    expect(body).toContain('buildLevel(way.target, fromC)')
    expect(body).toMatch(/const partner = way\.kind === 'down' \? level\.decor\.wayAt\(fromC\.cx, fromC\.cy, 'up'\) : way\.kind === 'up' \? level\.decor\.exitAt\(fromC\.cx, fromC\.cy\) : null/)
    expect(body).toMatch(/const m = way\.kind === 'ring' \? mem\.get\(way\.target\) : null/)
    expect(body).toMatch(/const a = arrivalFor\(\{ way, fromCx: fromC\.cx, fromCy: fromC\.cy, partner, mem: m, floorFn: level\.grid\.floor, angle: player\.angle \}\)/)
    expect(body).toMatch(/closing = \{ key: partner\?\.key \?\? null, until: playT \+ 5 \}/)
    expect(body).toMatch(/const rec = mem\.arrive\(way\.target, spawnChunk, playT\)\r?\n\s*const first = rec\.visits === 1\r?\n\s*const hp0 = player\.maxHp\r?\n\s*player\.maxHp = onArrive\(player\.maxHp, first\)/)
    expect(body).toContain('vendLocked = false')
    expect(body).toMatch(/if \(!level\.cfg\.map\) fog\.pinThing\(way\.target, 'arrived:' \+ \(playT \| 0\), 'arrived', player\.x, player\.y\)/)
    expect(body).toContain('persist(true)')
    // the order: arrival placed -> decor at the new chunk -> settle -> arrive
    const place = body.indexOf('player.x = a.x; player.y = a.y'), dec = body.indexOf('level.decor.update(spawnChunk.cx, spawnChunk.cy)'), settle = body.indexOf('level.solid.settlePlayer(player)'), arr = body.indexOf('const rec = mem.arrive(')
    expect(place).toBeLessThan(dec); expect(dec).toBeLessThan(settle); expect(settle).toBeLessThan(arr)
  })
  it('the message ladder: the level name (combat) at once; first visit: hint 3.8 s, way line 7.5 s; later: way line 3.8 s, the arrival summary 7.5 s; the raised ceiling at 11 s', () => {
    expect(body).toMatch(/showMessage\(level\.cfg\.levelName, PRIO\.combat\)\r?\n\s*const wm = wayMessage\(way, \{ partner, mem: mem\.get\(way\.target\) \}\)/)
    expect(body).toMatch(/if \(first\) \{\r?\n\s*if \(level\.cfg\.exit\?\.hint\) setTimeout\(\(\) => showMessage\(level\.cfg\.exit\.hint, PRIO\.discovery\), 3800\)\r?\n\s*if \(wm\) setTimeout\(\(\) => showMessage\(wm, PRIO\.discovery\), 7500\)/)
    expect(body).toMatch(/\} else \{\r?\n\s*if \(wm\) setTimeout\(\(\) => showMessage\(wm, PRIO\.discovery\), 3800\)\r?\n\s*const s = arrivalSummary\(fog\.countWays\(way\.target\), rec\.visits\)\r?\n\s*if \(s\) setTimeout\(\(\) => showMessage\(s, PRIO\.discovery\), 7500\)/)
    expect(body).toMatch(/if \(player\.maxHp > hp0\) setTimeout\(\(\) => showMessage\('the floor remembers you less\.', PRIO\.discovery\), 11000\)/)
  })
  it('F takes the way through travel(nearExit); the prompt reads wayLabel, or the closing line for the way you came by', () => {
    expect(game).toMatch(/\} else if \(nearExit\) \{\r?\n\s*travel\(nearExit\)\r?\n\s*\}/)
    expect(game).toMatch(/itemHintEl\.textContent = closing && nearExit\.key === closing\.key && playT < closing\.until \? 'f · the way is still closing\.' : `f · \$\{wayLabel\(nearExit\)\}`/)
  })
})

describe('game.js: die() through death.js', () => {
  const body = slice('function die() {', '// ── input ──')
  it('says the dark, remembers where you fell, resolves the death with the item names, wakes a floor above beside the exit (or the crossing)', () => {
    expect(body).toContain("showMessage('everything goes dark.', PRIO.combat)")
    expect(body).toMatch(/mem\.leave\(level\.index, player, C, playT\)\r?\n\s*mem\.setDropped\(level\.index, itemSys\.getDropped\(\)\)\r?\n\s*fadeThen\(/)
    expect(body).toMatch(/const r = resolveDeath\(\{ level: level\.index, inventory: itemSys\.inventory, selected: itemSys\.selected, maxHp: player\.maxHp, deaths, names: ITEM_NAMES \}\)/)
    expect(body).toContain('if (r.wakeLevel !== level.index) buildLevel(r.wakeLevel, C)')
    expect(body).toMatch(/const exit = level\.decor\.exitAt\(C\.cx, C\.cy\) \?\? level\.decor\.nearestWayAny\(mid\.x, mid\.y\)\?\.rec \?\? null\r?\n\s*const spot = exit \? wakeSpot\(exit, level\.grid\.floor\) : null/)
    expect(body).toMatch(/if \(spot\) \{ player\.x = spot\.x; player\.y = spot\.y; player\.angle = spot\.angle \}\r?\n\s*else \{ const m = findOpenNear\(mid\.x, mid\.y, level\.grid\.floor\) \?\? mid; player\.x = m\.x; player\.y = m\.y \}/)
    expect(body).not.toMatch(/HALF \+ 0\.5/)
  })
  it('applies the result in place: the inventory spliced, the selection, the ceiling and hp, the deaths, the locked trays, the closing way; then the record, the hotbar, the full save and the lines', () => {
    expect(body).toMatch(/closing = \{ key: exit\?\.key \?\? null, until: playT \+ 5 \}/)
    expect(body).toMatch(/itemSys\.inventory\.length = 0\r?\n\s*itemSys\.inventory\.push\(\.\.\.r\.inventory\)\r?\n\s*itemSys\.select\(r\.selected\)\r?\n\s*player\.maxHp = r\.maxHp; player\.hp = r\.maxHp\r?\n\s*deaths = r\.deaths\r?\n\s*vendLocked = r\.vendLocked/)
    expect(body).toContain('mem.arrive(level.index, spawnChunk, playT)')
    expect(body).toContain('persist(true)')
    expect(body).toMatch(/setTimeout\(\(\) => showMessage\(r\.message, PRIO\.discovery\), 2600\)\r?\n\s*if \(r\.dropped\) setTimeout\(\(\) => showMessage\(r\.droppedLine, PRIO\.discovery\), 5200\)/)
    expect(body).toContain("cancelCommit('the bandage slips.')")
  })
})

describe('game.js: the machines and the memory of what you took', () => {
  it('dispenseFromMachine: the locked tray first, then the spent key, then wasRestocked; a grant notes the vend and says the refill line before the clunk (+1.6 s)', () => {
    const body = slice('function dispenseFromMachine(m) {', '// ── snapshot + persistence')
    expect(body).toMatch(/if \(!m\) return\r?\n\s*if \(vendLocked\) \{ showMessage\('the tray is empty\.'\); return \}[^\n]*\r?\n\s*if \(vendedSet\.has\(m\.key\)\) return\r?\n\s*const refilled = mem\.wasRestocked\(level\.index, m\.key, playT\)/)
    expect(body).toMatch(/mem\.noteVended\(level\.index, m\.key, playT\); vendedSet\.add\(m\.key\)/)
    expect(body).toMatch(/if \(refilled\) \{ showMessage\('the machine has been refilled\. by whom\.', PRIO\.discovery\); setTimeout\(\(\) => showMessage\(clunk\), 1600\) \}\r?\n\s*else showMessage\(clunk\)/)
    expect(body).toContain("fog.pinThing(level.index, m.key, 'machine', m.x, m.y, true)")
  })
  it('a pickup notes the key as taken (a set-down item is not); the dropped list is written on the one itemsDirty read', () => {
    expect(game).toMatch(/if \(res\.ok\) \{ showMessage\(`you take the \$\{ITEM_NAMES\[res\.item\.type\] \?\? res\.item\.type\}\.`\); if \(!nearItem\.key\.startsWith\('d:'\)\) mem\.noteTaken\(level\.index, nearItem\.key\) \}/)
    expect(game).toMatch(/if \(itemsDirty\) \{ mem\.setDropped\(level\.index, itemSys\.getDropped\(\)\); persist\(\) \}/)
    expect((game.match(/mem\.setDropped\(/g) || []).length).toBe(3)        // travel, die, the loop
  })
})

describe('game.js: the save and the resume', () => {
  it('snapshot keeps v:1 and ADDS memory / playT / deaths and fog; the fog is re-exported every 4th save and on travel / death / unload, and every save carries the last export', () => {
    expect(game).toMatch(/function snapshot\(full = false\) \{/)
    expect(game).toMatch(/memory: mem\.export\(\), playT, deaths,/)
    expect(game).toMatch(/if \(full \|\| !fogExport\) fogExport = fog\.export\(\)[^\n]*\r?\n\s*s\.fog = fogExport/)
    expect((game.match(/fog\.export\(\)/g) || []).length).toBe(1)
    expect(game).toMatch(/function persist\(full = false\) \{ if \(mpClient\) return; persistN\+\+; writeSave\(snapshot\(full \|\| persistN % 4 === 0\)\) \}/)
    expect(game).toMatch(/window\.addEventListener\('beforeunload', \(\) => persist\(true\)\)/)
    expect((game.match(/persist\(true\)/g) || []).length).toBe(3)         // travel, die, beforeunload
  })
  it('resume goes through applyResume with the deps in the documented order; the clock is set first; the dispelled list is handed alone; a refused fog only warns', () => {
    const body = slice('if (resume) {', '} else {')
    expect(body).toMatch(/playT = Number\(resume\.playT\) \|\| 0\r?\n\s*const r = applyResume\(resume, \{/)
    const order = ['mem, buildLevel,', 'applyPlayer: (s) => {', 'updateAt: (pcx, pcy) =>', 'restoreDispelled: (l) => level.entitySys.restoreDispelled(l),', 'fogImport: (f) =>', 'settlePlayer: resumeSettle,']
    let last = -1
    for (const s of order) { const k = body.indexOf(s); expect(k, s).toBeGreaterThan(last); last = k }
    expect(body).toContain('return player')
    expect(body).toMatch(/fogImport: \(f\) => \{ if \(f && !fog\.import\(f\)\) console\.warn\(/)
    expect(body).toContain('deaths = r.deaths')
    expect(game).not.toMatch(/buildLevel\(resume\.level \?\? 0\)/)
    // a fresh run records its first arrival so a return to the lobby reads as a return
    expect(game).toMatch(/buildLevel\(mpClient \? 0 : 4\); mem\.arrive\(level\.index, spawnChunk, playT\)/)
  })
})

describe('game.js: the map, held not modal', () => {
  it('the card is built once with the fog and a Tab-shaped onTap; closeMap folds it; the paper corner feeds the same key', () => {
    expect(game).toMatch(/const mapCard = createMapCard\(document, \{ fog, getLevel: \(\) => level, getPlayer: \(\) => player, onTap: \(\) => \{ K\['Tab'\] = true \} \}\)/)
    expect(game).toMatch(/function closeMap\(\) \{ mapCard\.close\(\); mapOpen = false \}/)
    expect(game).toMatch(/mapTabEl\?\.addEventListener\('touchstart', \(e\) => \{ e\.preventDefault\(\); K\['Tab'\] = true \}, \{ passive: false \}\)/)
    expect(game).toMatch(/mapTabEl\?\.addEventListener\('click', \(\) => \{ K\['Tab'\] = true \}\)/)
    expect(game).not.toMatch(/mapCard\.toggle/)
  })
  it('Tab / Esc fold it; Tab opens it when nothing else is up, never on the block, with the first-open line; the edge is consumed either way', () => {
    expect(game).toMatch(/if \(mapOpen && \(K\['Escape'\] \|\| K\['Tab'\]\)\) \{ K\['Escape'\] = K\['Tab'\] = false; closeMap\(\) \}\r?\n\s*else if \(K\['Tab'\]\) \{\r?\n\s*K\['Tab'\] = false\r?\n\s*if \(!transitioning && !dialogOpen && !chatOpen && !noteOpen && !cfg\.map && settingsHidden\(\)\) \{\r?\n\s*mapCard\.open\(\); mapOpen = true/)
    expect(game).toContain("if (!mapEverOpened) { mapEverOpened = true; showMessage('you start drawing. it is the only way to know you are moving.', PRIO.discovery) }")
    expect(at("if (mapOpen && (K['Escape'] || K['Tab']))")).toBeLessThan(at('if (!transitioning && !dialogOpen && !chatOpen && !noteOpen && !mapOpen) {'))
  })
  it('the gates: half pace and no sprint while open, the verbs (F/E/Q/X and the ward) off, mouse-look untouched, a hit folds it, events and damage stay live', () => {
    expect(game).toMatch(/if \(mapOpen\) wantSprint = false[^\n]*\r?\n\s*const mult = mapOpen \? 0\.5 : \(wantSprint \? 1\.8 : 1\)/)
    expect(game).toMatch(/const modal = transitioning \|\| dialogOpen \|\| chatOpen \|\| noteOpen \|\| mapOpen/)
    expect(game).toMatch(/if \(!transitioning && !dialogOpen && !chatOpen && !noteOpen && !mapOpen\) \{\r?\n\s*\/\/ F/)
    expect(game).toMatch(/if \(mapOpen\) closeMap\(\); if \(noteOpen\) closeNoteCard\(\)/)
    expect(game).toMatch(/const evCanFire = !transitioning && !dialogOpen && !chatOpen && !noteOpen && level\.index >= 0 && level\.index <= 3/)   // not gated on the map
    expect(game).toMatch(/if \(locked\) player\.angle \+= e\.movementX/)
    const card = slice('const mapCard = createMapCard(', 'const mapTabEl')
    expect(card).not.toContain('exitPointerLock')
  })
  it('the fog steps after decor.update with the grid at this frame\'s chunk: the flood, the pins, the stale check (90 s + a whisper), the card\'s dirty flags; the block has no map', () => {
    expect(at('level.grid.setPlayerChunk(pcx, pcy)')).toBeLessThan(at('const st = fog.step('))
    expect(at('level.decor.update(pcx, pcy)')).toBeLessThan(at('const st = fog.step('))
    expect(game).toMatch(/if \(!cfg\.map\) \{\r?\n\s*const st = fog\.step\(level\.index, player\.x, player\.y, revealRadius\(level\.index\), level\.grid\.floor, epochOf\)\r?\n\s*if \(st\) \{\r?\n\s*pinSeen\(cfg\.fogDistance \* fogMul\)\r?\n\s*const lost = fog\.checkStale\(level\.index, player, nearestWayFn, epochOf\)\r?\n\s*if \(lost && playT - lastLostMsg > 90\) \{ lastLostMsg = playT; showMessage\('the hole is not where you drew it\.', PRIO\.discovery\); whisper\(\) \}\r?\n\s*if \(mapOpen\) mapCard\.cellsDirty\(\)\r?\n\s*\}\r?\n\s*if \(mapOpen\) mapCard\.angleDirty\(player\.angle\)\r?\n\s*\}/)
    // the helpers are built once, outside the loop: nothing allocated per frame
    for (const s of ['const epochOf = (cx, cy) => level.cache.epochOf?.(cx, cy) ?? 0', 'const nearestWayFn = (x, y) => level.decor.nearestWay(x, y, 2)',
      'const compassState = { player, known: null, fallback: null, arrived: null, stale: (p) => fog.isStale(level.index, p.chunkKey, epochOf) }',
      "const compassEl = document.getElementById('exit-compass')", 'function pinSeen(reach) {']) expect(at(s)).toBeLessThan(loopAt)
    expect((game.match(/getElementById\('exit-compass'\)/g) || []).length).toBe(1)
  })
  it('pinSeen: ways at 1.35x the reach with their chunk epoch, sights at the reach with the first-sight line within 9 u, the machine / note / soul beside you by PROX_PIN', () => {
    const body = slice('function pinSeen(reach) {', 'const entityAsm = createEntityAssembler()')
    expect(body).toMatch(/visibleWays\(player, level\.decor\.getExits\(\), floor, reach \* 1\.35, HF, seenWays\)/)
    expect(body).toMatch(/visibleWays\(player, level\.decor\.getStairs\(\), floor, reach \* 1\.35, HF, seenWays\)/)
    expect(body).toMatch(/fog\.pinWay\(L, s, epochOf\(s\.cx, s\.cy\)\)/)
    expect(body).toMatch(/visibleWays\(player, level\.decor\.getSights\(\), floor, reach, HF, seenSights\)/)
    expect(body).toMatch(/fog\.pinThing\(L, s\.key, 'sight', s\.x, s\.y\)\r?\n\s*if \(\(s\.x - player\.x\) \*\* 2 \+ \(s\.y - player\.y\) \*\* 2 <= 81\) \{/)
    expect(body).toMatch(/showMessage\(SIGHT_LINES\[s\.type\]\?\.line, PRIO\.discovery\)/)
    expect(body).toMatch(/nearestMachine\(player\.x, player\.y, PROX_PIN\)\r?\n\s*if \(m\) fog\.pinThing\(L, m\.key, 'machine', m\.x, m\.y, vendedSet\.has\(m\.key\)\)/)
    expect(body).toMatch(/nearestScrap\(player\.x, player\.y, PROX_PIN\)\r?\n\s*if \(sc\) fog\.pinThing\(L, sc\.key, 'note', sc\.x, sc\.y, readSet\.has\(sc\.frag\)\)/)
    expect(body).toMatch(/nearestNpc\(player\.x, player\.y, PROX_PIN\)\r?\n\s*if \(np\) fog\.pinThing\(L, np\.key, 'npc', np\.x, np\.y\)/)
    // the other pins: where it hurt you (after the hit block's lines), the note read, the machine emptied
    expect(game).toMatch(/cancelCommit\('the bandage slips\.'\)\r?\n\s*fog\.pinThing\(level\.index, 'hurt:' \+ frameCount, 'hurt', player\.x, player\.y\)/)
    expect(game).toMatch(/if \(!level\.cfg\.map\) fog\.pinThing\(level\.index, scrap\.key, 'note', scrap\.x, scrap\.y, true\)/)
  })
  it('the compass recomputes only on a cell, heading or known-ways change, writes the text only when it changed, and hides under the prompt; the old block is gone', () => {
    expect(game).toMatch(/const known = fog\.ways\(level\.index\)\r?\n\s*if \(cellChanged \|\| Math\.abs\(player\.angle - lastCompassAngle\) > 0\.05 \|\| known\.length !== lastWayCount\) \{\r?\n\s*lastCompassAngle = player\.angle; lastWayCount = known\.length\r?\n\s*compassState\.known = known\r?\n\s*compassState\.fallback = level\.decor\.nearestWayAny\(player\.x, player\.y\)/)
    expect(game).toMatch(/compassState\.arrived = fog\.arrivedPin\(level\.index\)\r?\n\s*compassLines\(compassState, compassOut\)\r?\n\s*const s = compassText\(compassOut\)\r?\n\s*if \(s !== lastCompassText\) \{ compassEl\.textContent = s; lastCompassText = s \}/)
    expect(game).toMatch(/compassEl\.style\.opacity = \(compassOut\.length === 0 \|\| nearExit\) \? '0' : '1'/)
    expect(game).not.toMatch(/cfg\.exit\?\.label \?\? 'descent'/)
    expect(game).not.toMatch(/exitArrow\(rel\)/)
  })
})

describe('the words', () => {
  it('every line this step ships is lowercase, understated, in-fiction: no capitals, no exclamation marks', () => {
    for (const s of ['the tray is empty.', 'the machine has been refilled. by whom.', 'everything goes dark.', 'the floor remembers you less.',
      'f · the way is still closing.', 'you start drawing. it is the only way to know you are moving.', 'the hole is not where you drew it.']) {
      expect(game).toContain(`'${s}'`)
      expect(s).toBe(s.toLowerCase()); expect(s).not.toContain('!')
    }
    expect(game).not.toContain('you wake where you fell in.')
  })
})

describe('index.html: the map card and the paper corner', () => {
  it('#map-card (hidden by default) holds #map-inner.paper with the 448x448 canvas, the footer and the fold hint; the paper look is shared with the note', () => {
    expect(html).toMatch(/<div id="map-card" style="display:none">\r?\n\s*<div id="map-inner" class="paper">\r?\n\s*<canvas id="map-canvas" width="448" height="448"><\/canvas>\r?\n\s*<p id="map-foot"><\/p>\r?\n\s*<div id="map-hint">tab · esc — fold it<\/div>/)
    expect(html).toMatch(/#note-inner, \.paper \{/)
    expect(html).toMatch(/#map-card \{\r?\n\s*position: fixed;[^}]*display: none;[^}]*z-index: 55; pointer-events: none;/)
    expect(html).toMatch(/#map-inner \{[^}]*max-height: 62vh; max-width: 86vw; pointer-events: auto;/)
    expect(html).toMatch(/#map-canvas \{[^}]*image-rendering: pixelated;/)
  })
  it('#map-tab sits in #hud-cluster under the plate, hidden until a coarse pointer, and the hint row names tab', () => {
    expect(html).toMatch(/<\/div>\r?\n\s*<div id="map-tab" class="paper" title="the map \(tab\)">map<\/div>\r?\n\s*<div id="hotbar-dock">/)
    expect(html).toMatch(/#map-tab \{\r?\n\s*display: none; width: 36px; height: 36px;/)
    expect(html).toMatch(/@media \(pointer: coarse\) \{ #map-tab \{ display: flex; pointer-events: auto; \} \}/)
    expect(html).toContain('<span>tab map</span>')
    expect(html).toMatch(/#exit-compass \{[^}]*white-space: pre;/)      // the two compass lines are joined with a newline
  })
})

describe('README and the offline shell lists', () => {
  it('the controls table has the tab row and the descent names the stairs up, the lift and the waking a floor above', () => {
    expect(readme).toMatch(/^\| tab \| the map \(hold your pace\) \|$/m)
    expect(readme).toContain('**stairwell up**')
    expect(readme).toContain('**lift**')
    expect(readme).toContain('you wake a floor above, beside the hole you fell through')
    expect(readme).not.toContain('the floor you left does not remember you.')
  })
  for (const f of ['topology.js', 'levelmem.js', 'death.js', 'channels.js', 'fogmap.js', 'sightpins.js', 'mapcard.js', 'compass.js']) {
    it(`${f} is in src/sw.js and tools/build-play.sh`, () => {
      expect(sw).toContain(`'/renderer/${f}'`)
      expect(build).toContain(`'${f}'`)
    })
  }
})
