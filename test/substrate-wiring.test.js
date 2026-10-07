// The factions wave's substrate, wired into game.js (it only runs in a page, so these are source guards; the modules are tested on their
// own: test/evbus.test.js, test/papercard.test.js, test/gfx-sprites.test.js): the event bus built once beside the chat, the roster it reads
// and this floor's remote players refilled once per frame without allocating a list, the 'here' heartbeat from one reused object, the
// floor filter on the friend rule and the sprite list, and the joined line's status.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const game = read('../src/renderer/game.js')
const at = (s) => { const k = game.indexOf(s); expect(k, s).toBeGreaterThan(0); return k }
const loopAt = game.indexOf('function loop(ts) {')
const count = (re) => (game.match(re) || []).length

describe('game.js: the event bus (I3)', () => {
  it('imports createEvBus from ../net/evbus.js and anchorSeed beside the anchor helpers', () => {
    expect(game).toMatch(/import \{ createEvBus, depthOf \} from '\.\.\/net\/evbus\.js'/)   // depthOf: level.depth (I14a; W3's status.js takes it over in I13)
    expect(game).toMatch(/import \{ formatAnchor, driftMeters, anchorSeed \} from '\.\/anchor\.js'/)
  })
  it('builds ONE bus, null solo, after the chat is registered and before the loop: the players list\'s sendEv / mergeRemote, a ms clock, the reused roster', () => {
    expect(count(/createEvBus\(/g)).toBe(1)
    expect(at('const bus = mpClient ? createEvBus({')).toBeGreaterThan(at('mpClient.onChat(addChatLine)'))
    expect(at('const bus = mpClient ? createEvBus({')).toBeLessThan(loopAt)
    expect(game).toMatch(/send: mpClient\.sendEv, now: \(\) => performance\.now\(\),/)
    expect(game).toMatch(/self: \(\) => \{ selfPos\.x = player\.x; selfPos\.y = player\.y; selfPos\.lvl = level \? level\.index : 0; return selfPos \},/)
    expect(game).toMatch(/peerPos, peerIds: \(\) => peerIdSet, selfId: \(\) => mpClient\.id, mergeRemote: mpClient\.mergeRemote,/)
    expect(game).toContain('mpClient.onEv(bus.receive)')
    expect(game).toMatch(/bus\.onFloorChange\(\(id, name, from, to, line\) => \{ if \(line\) addChatLine\(name \|\| 'someone', line, true\) \}\)/)
    for (const s of ['const selfPos = { x: 0, y: 0, lvl: 0 }', 'const peerIdSet = new Set(), peerRec = new Map()', 'const peerPos = (id) => peerRec.get(id) ?? null']) expect(at(s)).toBeLessThan(loopAt)
  })
  it('hereFields() fills ONE object (the bus copies it); the loop says it about once a second beside sendPos, after the bus\'s one tick per frame', () => {
    expect(game).toContain("const hereObj = { lvl: 0, lit: true, st: 'ok', seen: false, o: null, thin: false, status: 'notice-mailed', aseed: myAseed }")
    expect(game).toContain('const myAseed = anchor ? anchorSeed(anchor.lat, anchor.lng) : null')
    const body = game.slice(at('function hereFields() {'), game.indexOf('return hereObj', at('function hereFields() {')))
    expect(body).toContain('hereObj.lvl = level ? level.index : 0')
    expect(body).toContain('hereObj.lit = flashlight')
    expect(body).not.toMatch(/\{\s*lvl:/)                                     // no literal: nothing allocated per call
    const loop = game.slice(loopAt)
    expect(count(/bus\.tick\(/g)).toBe(1)
    expect(loop).toMatch(/fillRemotes\(\)\r?\n\s*if \(bus\) \{ bus\.tick\(performance\.now\(\)\); hereTimer \+= dt; if \(hereTimer >= 1\) \{ hereTimer = 0; bus\.here\(hereFields\(\)\) \} \}/)
    expect(loop.indexOf('mpClient.sendPos(')).toBeLessThan(loop.indexOf('fillRemotes()'))
    expect(loop.indexOf('fillRemotes()')).toBeLessThan(loop.indexOf('level.entitySys.update(dt, player, pcx, pcy, aiCtx)'))
  })
  it('a travel and a death say the new floor at once (after buildLevel, under the fade)', () => {
    const travel = game.slice(at('function travel(way) {'), at('// die(): death.js resolves it'))
    expect(travel.indexOf('bus?.here(hereFields())')).toBeGreaterThan(travel.indexOf('buildLevel(way.target, fromC)'))
    const die = game.slice(at('function die() {'), at('// ── input ──'))
    expect(die.indexOf('bus?.here(hereFields())')).toBeGreaterThan(die.indexOf('if (r.wakeLevel !== level.index) buildLevel(r.wakeLevel, C)'))
  })
  it('the roster and this floor\'s remote players are refilled once per frame in place: bus.onFloor filters, a stale friend\'s fields are blanked', () => {
    const body = game.slice(at('function fillRemotes() {'), at('function fillRemotes() {') + 900)
    expect(body).toMatch(/remoteOnFloor\.length = 0; peerIdSet\.clear\(\); peerRec\.clear\(\)/)
    expect(body).toContain('peerIdSet.add(rp.id); peerRec.set(rp.id, rp)')
    expect(body).toContain('if (!bus.onFloor(rp.id)) continue')
    expect(body).toContain('if (!bus.fresh(rp.id)) { rp.st = rp.lit = rp.origin = rp.status = undefined; rp.thin = rp.seen = false }')
    expect(count(/(?<!function )fillRemotes\(\)/g)).toBe(1)
    expect(count(/mpClient\.getRemotePlayers\(\)/g)).toBe(1)                // one read of the players list per frame
  })
  it('the friend rule (sanity) and the sprite list read this floor\'s remote players', () => {
    expect(game).toMatch(/if \(mpClient\) \{ for \(const rp of remoteOnFloor\) \{ if \(\(rp\.x - player\.x\) \*\* 2 \+ \(rp\.y - player\.y\) \*\* 2 < 36\) \{ sdelta \+= 3; break \} \} \}/)
    expect(game).toContain("if (mpClient) entityAsm.add('player', remoteOnFloor, EF.player)")
  })
  it('addChatLine takes the client\'s id; a join is said 2 s later with the friend\'s filed status, else today\'s line', () => {
    expect(game).toMatch(/function addChatLine\(from, text, isSystem, id\) \{\r?\n\s*if \(isSystem && id && bus && text === JOINED_LINE\) \{ setTimeout\(\(\) => addChatLine\(from, joinedLine\(id\), true\), JOIN_SAY_MS\); return \}/)
    expect(game).toContain("const JOINED_LINE = 'entered the level.', JOIN_SAY_MS = 2000")
    expect(game).toContain("return p && bus.fresh(id) && p.status !== 'notice-mailed' ? `entered the level, filed under ${p.status}.` : JOINED_LINE")
  })
})

describe('game.js: the paper card (I4)', () => {
  const html = read('../src/renderer/index.html')
  it('imports createCard and CARD_KEYS from papercard.js and builds ONE card before the loop', () => {
    expect(game).toMatch(/import \{ createCard, CARD_KEYS \} from '\.\/papercard\.js'/)
    expect(count(/createCard\(\)/g)).toBe(1)
    expect(at('const card = createCard()')).toBeLessThan(loopAt)
    expect(at('let cardScrap = null')).toBeLessThan(loopAt)
  })
  it('the card branch takes CARD_KEYS first — before the Enter check, the map\'s Tab and the verbs; the old close-any-key block is gone', () => {
    expect(game).not.toMatch(/K\['Escape'\] = K\['KeyE'\] = K\['KeyF'\] = K\['Space'\] = K\['Enter'\] = K\['NumpadEnter'\] = false/)
    expect(game).toMatch(/if \(noteOpen\) \{\r?\n\s*for \(let i = 0; i < CARD_KEYS\.length; i\+\+\) \{ const k = CARD_KEYS\[i\]; if \(K\[k\]\) \{ K\[k\] = false; cardInput\(k\) \} \}\r?\n\s*\}/)
    const branch = at('for (let i = 0; i < CARD_KEYS.length; i++)')
    expect(branch).toBeGreaterThan(loopAt)
    expect(branch).toBeLessThan(at("if (!chatOpen && !dialogOpen && !noteOpen && (K['Enter'] || K['NumpadEnter'])) {"))
    expect(branch).toBeLessThan(at("if (mapOpen && (K['Escape'] || K['Tab']))"))
    expect(branch).toBeLessThan(at('if (!transitioning && !dialogOpen && !chatOpen && !noteOpen && !mapOpen) {'))
  })
  it('noteOpen follows card.state: set only where a card opens, cleared where every close lands; a forced close is an Esc to the card', () => {
    expect(count(/noteOpen = true/g)).toBe(1)
    const open = game.slice(at('function openCard(mode, opts, scrap = null) {'), at('function closeNoteCard() {'))
    expect(open).toMatch(/if \(noteOpen \|\| !noteCardEl\) return null/)
    expect(open).toMatch(/const s = card\.open\(mode, opts\)\r?\n\s*cardScrap = scrap\r?\n\s*noteOpen = true\r?\n\s*document\.exitPointerLock\(\)/)
    const close = game.slice(at('function closeNoteCard() {'), at('function cardInput(key) {'))
    expect(close).toContain("if (s) { card.step(s, 'Escape'); if (s.onClose) s.onClose() }")
    expect(close).toContain('card.state = null; cardScrap = null; noteOpen = false')
    const input = game.slice(at('function cardInput(key) {'), at("noteCardEl?.addEventListener('pointerdown'"))
    expect(input).toMatch(/const \{ state, action \} = card\.step\(s, key\)\r?\n\s*if \(state === null\) closeNoteCard\(\)/)
    expect(input).toContain('if (action.confirmed && s.onConfirm) s.onConfirm()')
    expect(input).toContain('if (s.onPick) s.onPick(action.pick)')
    expect(input).toContain("else if (action.type === 'refuse') showMessage(action.line)")
    // the hit still folds the card (creatures-wiring / fight-wiring / floors-map-wiring pin the line itself)
    expect(game).toMatch(/if \(mapOpen\) closeMap\(\); if \(noteOpen\) closeNoteCard\(\)/)
  })
  it('a tap on the card body is the card\'s \'tap\'; an option line is \'tapLine:i\' and never reaches the body', () => {
    expect(game).toContain("noteCardEl?.addEventListener('pointerdown', () => cardInput('tap'))")
    expect(game).toContain("p.addEventListener('pointerdown', (e) => { e.stopPropagation(); cardInput('tapLine:' + i) })")
    expect(game).not.toMatch(/addEventListener\('pointerdown', closeNoteCard\)/)
  })
  it('the reveal binds the card\'s scrap and keeps the pinned map line; a page opens revealed (today\'s card: +6 once, the pin, the pages-found foot)', () => {
    const reveal = game.slice(at('function revealScrap() {'), at('function redactScrap() {'))
    expect(reveal).toMatch(/const scrap = cardScrap\r?\n/)
    expect(reveal).toContain('if (!readSet.has(scrap.frag)) { readSet.add(scrap.frag); sanity = Math.min(100, sanity + rules.scrapSanity) }')   // origins (I5): LEGACY +6
    expect(reveal).toContain("if (!level.cfg.map) fog.pinThing(level.index, 'n:' + scrap.key, 'note', scrap.x, scrap.y, true)")
    expect(reveal).toContain('renderCard(card.setFoot(card.state, `${readSet.size} of ${SCRAPS.length} pages found`))')
    expect(game.slice(at('function redactScrap() {'), at('function openNoteCard(scrap) {'))).toMatch(/const scrap = cardScrap\r?\n/)
    expect(game).toMatch(/function openNoteCard\(scrap\) \{\r?\n\s*if \(!scrap \|\| !openCard\('page', \{ text: SCRAPS\[scrap\.frag\] \?\? '' \}, scrap\)\) return\r?\n\s*revealScrap\(\)/)
    expect(game).toContain('else if (nearScrap) nearScrap.form ? openForm() : openNoteCard(nearScrap)')   // origins (I5): ∅'s form note opens the form card
  })
  it('index.html: the option lines sit between the text and the foot, faint and tappable', () => {
    expect(html).toMatch(/<p id="note-text"><\/p>\r?\n\s*<div id="note-lines"><\/div>\r?\n\s*<p id="note-foot"><\/p>/)
    expect(html).toMatch(/#note-lines \.note-line \{[^}]*cursor: pointer;/)
    expect(html).toMatch(/#note-lines:empty \{ display: none; \}/)
  })
})

describe('game.js: the remote player fill (I2)', () => {
  it('ENTITY_FILLS.player forwards the six heartbeat fields after hp, in order, and never the id', () => {
    expect(game).toContain("r.hp = p.hp; r.st = p.st; r.lit = p.lit; r.thin = !!p.thin; r.origin = p.origin; r.status = p.status; r.seen = !!p.seen }")
    expect(game).not.toMatch(/r\.id = p\.id/)
  })
})
