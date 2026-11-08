// I5: the touch TYPE (Enter) and BEACON (B) buttons, wired. game.js hands touch.js its own Enter — the loop's Enter branch, run inside
// the tap so the line's input is focused inside the gesture and the phone's keyboard comes up — and tells it once a frame which of the
// two would do something now. What B and Enter do is unchanged: this is reach only. Off a touch screen initTouchControls returns null
// and nothing of this runs.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const game = read('../src/renderer/game.js'), touch = read('../src/renderer/touch.js'), html = read('../src/renderer/index.html')
const loopAt = game.indexOf('function loop(ts)')
const at = (s, from = 0) => game.indexOf(s, from)
const count = (s) => game.split(s).length - 1

const ENTER_BRANCH = "if (!chatOpen && !dialogOpen && !noteOpen && (K['Enter'] || K['NumpadEnter'])) {"
const VERBS = 'if (!transitioning && !dialogOpen && !chatOpen && !noteOpen && !mapOpen) {'
const SWEEP_B = "if (down.st === 'down') { K['KeyF'] = K['KeyQ'] = K['KeyX'] = K['KeyE'] = K['KeyB'] = K['KeyL'] = false;"
const INIT = 'const touchUi = initTouchControls({ canvas, K, player, getPref, edges: { Space: wardInput }, taps: { Enter: touchLine } })'
const TOUCH_LINE = 'function touchLine() { if (!chatOpen && !dialogOpen && !noteOpen) openChat() }'
const SHOW = "if (touchUi) touchUi.show(lineShown(!!chatInputEl && !chatOpen && !dialogOpen && !noteOpen, !!mpClient), beaconShown(getPref('beaconEffect'), !transitioning && !dialogOpen && !chatOpen && !noteOpen && !mapOpen && down.st !== 'down'))"

describe('game.js: the touch line and beacon (I5)', () => {
  it('imports the two conditions beside initTouchControls', () => {
    expect(game).toContain("import { initTouchControls, isTouchDevice, beaconShown, lineShown } from './touch.js'")
  })
  it('hands touch.js its Enter: touchLine is the Enter branch\'s own test, then the same openChat the keyboard reaches', () => {
    expect(count(INIT)).toBe(1)
    expect(count(TOUCH_LINE)).toBe(1)
    expect(ENTER_BRANCH).toContain('!chatOpen && !dialogOpen && !noteOpen')        // the very test touchLine runs
    expect(count(ENTER_BRANCH)).toBe(1)
    expect(game.match(/openChat\(\)/g)).toHaveLength(3)                            // its definition, the loop's Enter branch, touchLine
    // after closeChat, so the slice fight-wiring reads (openChat .. closeChat) is untouched
    expect(at(TOUCH_LINE)).toBeGreaterThan(at('function closeChat()'))
  })
  it('the show line: once a frame, after the card, the Enter branch, the down sweep and the verbs, before the world streams', () => {
    expect(count(SHOW)).toBe(1)
    const s = at(SHOW)
    expect(s).toBeGreaterThan(loopAt)
    for (const before of [ENTER_BRANCH, SWEEP_B, VERBS, "if (K['Escape'] && dialogOpen) { K['Escape'] = false; closeDialog() }"]) expect(s, before).toBeGreaterThan(at(before, loopAt))
    expect(s).toBeLessThan(at('// ── stream world + subsystems around the player ──', loopAt))
  })
  it('TYPE\'s test is the Enter branch\'s (plus the input being there, as openChat asks); BEACON\'s is the verbs\' guard and the down sweep', () => {
    expect(SHOW).toContain('lineShown(!!chatInputEl && !chatOpen && !dialogOpen && !noteOpen, !!mpClient)')
    expect(game).toContain('if (!chatInputEl || chatOpen) return')                 // openChat's own guard
    expect(SHOW).toContain(`beaconShown(getPref('beaconEffect'), ${VERBS.slice(4, -3)} && down.st !== 'down')`)
  })
  it('desktop and keyboard: touchUi is null off a touch screen, and the show line and the look\'s level hold are the only other places it is read', () => {
    const code = game.split('\n').map((l) => l.replace(/^\s*\/\/.*$|\s\/\/ .*$/, '')).join('\n')   // (a name in a comment is not a use)
    expect(code.split('touchUi').length - 1).toBe(4)                               // const touchUi = …, if (touchUi) touchUi.show(…), (keyTurn && !touchUi)
    expect(code).toContain(INIT)
    expect(code).toContain(SHOW)
    // an arrow-key turn levels the view off a touch screen only (look-wiring.test.js): on one, the drag tilts and the arrows leave it alone
    expect(code.split('(keyTurn && !touchUi)').length - 1).toBe(1)
    expect(touch).toMatch(/if \(!isTouchDevice\(\) \|\| typeof document === 'undefined'\) return null/)
  })
  it('what B does is unchanged: the same decision, the same push, the same seam', () => {
    const b = game.slice(at("if (K['KeyB']) {", loopAt), at("const code = `Digit${i + 1}`", loopAt))
    expect(b).toContain("const effect = getPref('beaconEffect')")
    expect(b).toContain("const target = (webhook || '').toLowerCase().replace(/[^a-z0-9]/g, '')")
    expect(b).toContain('const b = beaconDecision({ effect, target, rules, status: file.status, closing: file.closing, anchor, webhook })')
    expect(b).toContain('const p = window.backrooms?.fireBeacon?.(b.payload)')
    expect(b).toContain('if (b.setBeaconFired) { beaconFired = true; tryFinale() }')
  })
  it('a disc tapped while the line is up does not wait for it to close: closing the line lets go of every key, as opening it does', () => {
    // TYPE leaves the six on screen; a plain disc sets its key on touch, and the verbs consume nothing while the line is up. closeChat
    // drops what was pressed meanwhile, so LIGHT, ACT or USE never fires the moment the line goes away (a keyboard types into the line)
    const close = game.slice(at('function closeChat() {'), at('function touchLine()'))
    expect(close).toContain('for (const k in K) K[k] = false')
    expect(close).toContain('charger.forceRelease()')
    // replayed: the line opens, LIGHT is tapped under it, the line is sent empty and closes; the frame after sees no LIGHT
    const open = game.slice(at('function openChat() {'), at('function closeChat() {'))
    const K = {}, el = { style: {}, value: '', focus() {} }
    let released = 0
    const h = new Function('K', 'charger', 'document', 'chatInputEl', 'chatLogEl', 'mpClient', 'clearTimeout',
      `let chatOpen = false, typingSent = false, typingStopT = 0\n${open}\n${close}\nreturn { openChat, closeChat, open: () => chatOpen }`)(
      K, { forceRelease: () => { released++ } }, { exitPointerLock() {} }, el, null, null, () => {})
    K.KeyW = true
    h.openChat()
    expect(h.open()).toBe(true); expect(K.KeyW).toBe(false)
    K.KeyL = true; K.KeyF = true; K.KeyQ = true                                   // taps on LIGHT, ACT, USE under the open line
    h.closeChat()
    expect(h.open()).toBe(false)
    expect(Object.values(K).some(Boolean)).toBe(false)
    expect(released).toBe(2)
  })
  it('Enter in the line sends as before, and so does the enter key of a phone\'s keyboard (which may carry no code); Esc still cancels', () => {
    const h = game.slice(at("chatInputEl?.addEventListener('keydown', (e) => {"), at('// ── the field console: the chat input doubles'))
    expect(h).toContain("if (e.code === 'Enter' || e.code === 'NumpadEnter' || (e.key === 'Enter' && !e.isComposing)) {")
    expect(h).toContain("if (t.startsWith('/') && !t.startsWith('/me ')) handleCommand(t)   // the field console")
    expect(h).toContain("else if (e.code === 'Escape') closeChat()")
  })
})

describe('touch.js: reach only', () => {
  it('says nothing of its own: no line, no plate', () => {
    expect(touch).not.toMatch(/showMessage|plate\(|later\(|PRIO/)
  })
  it('the CSS flex stack stays as the fallback; placed discs are absolutely positioned; a hidden disc takes no room', () => {
    expect(touch).toContain('flex-wrap: wrap-reverse')
    expect(touch).toContain('#touch-actions.placed { inset: 0; display: block; max-height: none; }')
    expect(touch).toContain('#touch-actions.placed .touch-btn { position: absolute; }')
    expect(touch).toContain('.touch-btn.off { display: none; }')
  })
  it('measures the page only on mount, a resize, a turn, a control resizing, or a change of set — never in show() when nothing changed', () => {
    const show = touch.slice(touch.indexOf('function show(line, beacon) {'), touch.indexOf('// action buttons'))
    expect(show).toMatch(/if \(want === mask\) return/)
    expect(show.indexOf('if (want === mask) return')).toBeLessThan(show.indexOf('relayout()'))
  })
})

describe('index.html', () => {
  it('the line asks a phone\'s keyboard for a send key, and for no capitals or suggestions', () => {
    const input = html.match(/<input id="chat-input"[^>]*>/)[0]
    for (const a of ['enterkeyhint="send"', 'autocapitalize="off"', 'autocomplete="off"', 'maxlength="200"', 'spellcheck="false"', 'style="display:none"']) expect(input, a).toContain(a)
  })
  it('on a landscape phone the dock under the gauges is capped at 380 px, after the narrow rules, so the discs keep the right-hand side', () => {
    const cap = '@media (pointer: coarse) and (max-width: 700px) and (orientation: landscape) { #hotbar-dock { width: min(calc(100vw - 24px), 380px); } }'
    expect(html).toContain(cap)
    expect(html.indexOf(cap)).toBeGreaterThan(html.indexOf('#hotbar-dock { position: static; height: auto; display: flex; gap: 4px; width: calc(100vw - 24px); }'))
  })
})
