// The way in, wired (growth-spec §1.3-1.6, launch-fixes F5.1 / F7): index.html reads an invite link and a pin off the address, offers one
// click into the room, copies an invite from the PLAY ONLINE modal (the pin only through 'include my place', which warns first), looks a
// phone's short maps link up through the relay, keeps the LAN buttons off https, and hands initGame the room; game.js answers /invite and
// reads the case board from the site off the site; the offline shells carry site.js and leave a query-string navigation alone; the desktop
// copies only our own /play/ link. index.html has no DOM rig, so these are source assertions (the rules themselves: test/site.test.js).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const html = read('../src/renderer/index.html')
const game = read('../src/renderer/game.js')
const sw = read('../src/sw.js')
const build = read('../tools/build-play.sh')
const preload = read('../src/preload.cjs')
const main = read('../src/main.js')
const at = (src, s, from = 0) => { const k = src.indexOf(s, from); expect(k, s).toBeGreaterThan(0); return k }
const slice = (src, from, to) => { const a = at(src, from), b = src.indexOf(to, a); expect(b, to).toBeGreaterThan(a); return src.slice(a, b) }

describe('index.html: the title screen', () => {
  it('imports the way in from site.js', () => {
    const imp = html.match(/import \{([^}]*)\} from '\.\/site\.js'/)
    expect(imp).not.toBe(null)
    for (const n of ['readInvite', 'buildInvite', 'normalizeRoom', 'lanReachable', 'shortMapsLink', 'resolveShortLink', 'ANCHOR_NOT_FOUND', 'ANCHOR_LOOKING', 'PIN_WARNING', 'NO_FIELD_PIN']) {
      expect(imp[1], n).toMatch(new RegExp(`\\b${n}\\b`))
    }
  })
  it('the order: the name, the invite plate (hidden), the anchor field, the ways in, the front door', () => {
    const name = at(html, '<input id="player-name"'), plate = at(html, '<div id="invite-plate" hidden>'), anchor = at(html, '<div id="anchor-wrap">')
    const btns = at(html, '<div class="btns">'), door = at(html, '<div id="front-door">'), status = at(html, '<div id="start-status"')
    expect(name).toBeLessThan(plate); expect(plate).toBeLessThan(anchor); expect(anchor).toBeLessThan(btns); expect(btns).toBeLessThan(door); expect(door).toBeLessThan(status)
    expect(html).toMatch(/<div id="invite-plate" hidden>\r?\n\s*<div id="invite-line"><\/div>\r?\n\s*<button id="btn-invite-join" type="button">JOIN ▶<\/button>\r?\n\s*<div id="invite-sub" class="set-hint"><\/div>\r?\n\s*<\/div>/)
    expect(html).toMatch(/#invite-plate\[hidden\] \{ display: none; \}/)            // its display:flex must not undo [hidden]
  })
  it('the anchor field: the new placeholder, no "(optional)", more contrast', () => {
    expect(html).toContain(`<input id="anchor-input" type="text" placeholder="paste a google maps link — that place becomes the maze's seed" spellcheck="false"/>`)
    expect(html).not.toContain('(optional)')
    expect(html).toMatch(/#anchor-input \{[^}]*border: 1px solid #8a7a3a;/)
    expect(html).toMatch(/#anchor-input::placeholder \{ color: #c9bd8f; \}/)
  })
})

describe('index.html: an invite link, ?room=CODE[&anchor=LAT,LNG]', () => {
  const block = slice(html, 'const invite = readInvite(location.search)', '// player name (persisted)')
  it('the pin fills the anchor field and says so through its own input event', () => {
    expect(block).toContain("if (invite.anchor) { anchorInput.value = formatAnchor(invite.anchor); anchorInput.dispatchEvent(new Event('input')) }")
    expect(at(html, "anchorInput.addEventListener('input'")).toBeLessThan(at(html, 'const invite = readInvite(location.search)'))
  })
  it('the room fills the online field and raises the plate; the code reaches the page as text only', () => {
    expect(block).toContain("document.getElementById('online-room').value = invite.room")
    expect(block).toContain("document.getElementById('invite-line').textContent = `a door was left open · room ${invite.room}`")
    expect(block).toContain("document.getElementById('invite-sub').textContent = invite.anchor ? 'the first one in decides the world.' : ''")
    expect(block).toContain("document.getElementById('invite-plate').hidden = false")
    expect(block).toContain("startEl.classList.add('invited')")
    expect(html).not.toMatch(/innerHTML[^\n]*invite/)
    expect(block).not.toMatch(/nameInput|playerName|setPref/)                  // the link never chooses a name
  })
  it('JOIN and the modal\'s ENTER go through one joinOnline', () => {
    expect(block).toContain("document.getElementById('btn-invite-join').onclick = () => { startStatus.textContent = ''; joinOnline(invite.room, startStatus) }")
    const fn = slice(html, 'function joinOnline(code, statusEl) {', '\n    }')
    expect(fn).toContain("const c = normalizeRoom(code) || 'default'")
    expect(fn).toContain("return startMultiplayer(`${RELAY_URL}/?room=${encodeURIComponent(c)}`, c, statusEl, 'online')")
    expect(html).toContain("document.getElementById('online-connect').onclick = () => joinOnline(document.getElementById('online-room').value, document.getElementById('online-status'))")
    expect((html.match(/startMultiplayer\(`\$\{RELAY_URL\}/g) || []).length).toBe(1)
  })
  it('while the plate shows, JOIN is the one primary button and SOLO steps back', () => {
    expect(html).toMatch(/#start #btn-solo, #start #btn-continue, #start #btn-invite-join \{/)
    expect(html).toMatch(/#start\.invited #btn-solo \{[^}]*background: rgba\(14,12,7,0\.74\);[^}]*\}/)
    expect(html).toMatch(/#start\.invited #btn-solo:focus-visible \{ outline: 2px solid var\(--glow\); outline-offset: 3px; \}/)
  })
  it('the room goes into the game: initGame learns the code, the route and, on a LAN, the address a friend types', () => {
    expect(html).toContain("async function startMultiplayer(serverUrl, roomId, statusEl, route = 'lan', lanUrl = serverUrl) {")
    expect(html).toContain("await initGame(canvas, { worldSeed, mpClient, anchor, intakeCtx: intakeFor(route, anchor), room: { code: roomId, route, lan: route === 'online' ? null : lanUrl } })")
    expect(html).toContain("await startMultiplayer(`ws://localhost:${port}`, room, startStatus, r ? 'host' : 'lan', info.url || `ws://localhost:${port}`)")
  })
})

describe('index.html: copying an invite', () => {
  it('the PLAY ONLINE box lies over the title like JOIN LAN\'s (it had no rule and opened unseen under #start)', () => {
    expect(html).toMatch(/#join-modal, #online-modal \{ position:fixed;inset:0;background:#0008;display:flex;align-items:center;justify-content:center;z-index:100; \}/)
    expect(Number(html.match(/#start \{[^}]*z-index: (\d+);/)[1])).toBeLessThanOrEqual(100)
    expect(at(html, '<div id="online-modal" style="display:none">')).toBeGreaterThan(at(html, '<div id="start">'))   // same z: later in the page wins
  })
  it('the modal has the button, the pin\'s opt-in (off) and the hand-copy fallback', () => {
    expect(html).toMatch(/<input id="online-room"[^>]*\/>\r?\n\s*<div id="online-invite-row">\r?\n\s*<button id="online-invite" type="button">copy invite link<\/button>\r?\n\s*<label for="online-invite-pin"><input id="online-invite-pin" type="checkbox"\/> include my place<\/label>\r?\n\s*<\/div>\r?\n\s*<input id="online-invite-url" type="text" readonly hidden spellcheck="false"\/>/)
    expect(html).toMatch(/\.modal-box #online-invite-url\[hidden\] \{ display:none; \}/)
    expect(html).toMatch(/\.modal-box #online-invite-pin \{[^}]*display:inline-block;[^}]*width:16px;/)
  })
  const modal = slice(html, "const inviteBtn = document.getElementById('online-invite')", '// ── continue a saved run ──')
  it('the pin is never remembered and is warned about the moment it is ticked', () => {
    expect(modal).toContain('invitePin.checked = false')
    expect(modal).toMatch(/invitePin\.addEventListener\('change', \(\) => \{\r?\n\s*onlineStatus\.textContent = !invitePin\.checked \? '' : fieldAnchorNow\(\) \? PIN_WARNING : NO_FIELD_PIN\r?\n\s*\}\)/)
    expect(modal).not.toMatch(/setPref|localStorage/)
  })
  it('the copy is the room only unless the box is ticked; with the pin it says the warning again', () => {
    expect(modal).toContain('const pin = invitePin.checked ? fieldAnchorNow() : null')
    expect(modal).toContain("shareInvite(buildInvite({ room: document.getElementById('online-room').value, anchor: pin }), (t) => { onlineStatus.textContent = pin ? `${PIN_WARNING} ${t}` : t }, inviteUrlEl)")
  })
  it('one copy helper: the share sheet on a phone, the desktop bridge, the clipboard, else the link shown selected', () => {
    const fn = slice(html, 'async function shareInvite(url, say, fallbackEl) {', "document.addEventListener('backrooms:invite'")
    expect(fn).toMatch(/if \(sharePhone\(\)\) \{[\s\S]*await navigator\.share\(\{ url \}\)/)
    expect(fn.indexOf('window.backrooms?.copyInvite')).toBeLessThan(fn.indexOf('navigator.clipboard.writeText(url)'))
    expect(fn).toContain("say('the link is on your clipboard.')")
    expect(fn).toContain('fallbackEl.value = url; fallbackEl.hidden = false; fallbackEl.select()')
    expect(fn).toContain("say('copy this and send it.')")
    expect(html).toContain("const sharePhone = () => !!navigator.share && matchMedia('(pointer: coarse)').matches")
    expect(html).toContain("if (sharePhone()) inviteBtn.textContent = 'send invite'")
  })
  it('the game\'s /invite reaches the same helper through one document event', () => {
    expect(html).toContain("document.addEventListener('backrooms:invite', (e) => { const d = e.detail || {}; shareInvite(d.url, (t) => d.say?.(t), null) })")
    expect(game).toContain("document.dispatchEvent(new CustomEvent('backrooms:invite', { detail: { url: inv.url, say: (t) => showMessage([inv.say, t, inv.url].filter(Boolean).join('\\n'), PRIO.discovery) } }))")
  })
  it('the console\'s placeholder names /invite, and the centre line can wrap a link (it has no spaces)', () => {
    expect(html).toContain(' · /intake · /status · /invite)"')
    expect(html).toMatch(/#msg \{[^}]*white-space: pre-wrap; overflow-wrap: anywhere;/)
  })
})

describe('index.html: the anchor field, a short link, the LAN buttons, the service worker', () => {
  const anchorBlock = slice(html, '// ── anchor — no-clip from a real place', 'const invite = readInvite(location.search)')
  it('a place that cannot be found says the owner\'s line, from site.js only', () => {
    expect(anchorBlock).toContain('anchorStatus.textContent = ANCHOR_NOT_FOUND')
    expect(html).not.toContain('that place cannot be found')
  })
  it('a short link is looked up once through the relay, said while it is out, and the answer counts once it is in', () => {
    expect(anchorBlock).toContain('const link = a ? null : shortMapsLink(v)')
    expect(anchorBlock).toContain('anchorStatus.textContent = ANCHOR_LOOKING')
    expect(anchorBlock).toMatch(/if \(!shortAsk\.has\(link\)\) shortAsk\.set\(link, resolveShortLink\(link\)\.then\(\(p\) => \{ if \(p\) shortPin\.set\(link, p\); else shortAsk\.delete\(link\); return p \}\)\)/)
    expect(anchorBlock).toContain('return parseAnchor(v) ?? shortPin.get(shortMapsLink(v)) ?? null')
    // a stale answer never overwrites what the field says now
    expect(anchorBlock).toContain('if (shortMapsLink(anchorInput.value) === link && !parseAnchor(anchorInput.value)) anchorStatus.textContent = p ? anchoredLine(p) : ANCHOR_NOT_FOUND')
  })
  it('SOLO, the front door and the online joins wait for a short link still out', () => {
    expect(anchorBlock).toMatch(/async function takeAnchor\(\) \{\r?\n\s*return applyIdentity\(\{ anchor: await fieldAnchor\(\) \}\)/)
    expect(slice(html, 'async function startSolo(', '// one connection attempt at a time')).toContain('const anchor = await takeAnchor()')
    expect(slice(html, 'async function startMultiplayer(', "document.getElementById('btn-solo')")).toContain('const anchor = await takeAnchor()')
    expect(html).not.toMatch(/(?<!await|function) takeAnchor\(\)/)                // every call awaits it
  })
  it('a solo start runs once even when the lookup holds it', () => {
    const solo = slice(html, 'async function startSolo(', '// one connection attempt at a time')
    expect(solo).toMatch(/if \(soloBusy\) return\r?\n\s*soloBusy = true/)
  })
  it('JOIN LAN / HOST LAN are not offered on an https page', () => {
    expect(html).toContain("if (!lanReachable(location)) for (const id of ['btn-join', 'btn-host']) document.getElementById(id).hidden = true")
  })
  it('the service worker registers only on a top-level http(s) page (never framed: itch, a portal)', () => {
    expect(html).toContain("if ('serviceWorker' in navigator && location.protocol.startsWith('http') && window.top === window.self) {")
  })
  it('the online modal\'s status is legible (it was ink on ink)', () => {
    expect(html).toMatch(/#join-status, #online-status \{ color:#a09060;/)
  })
})

describe('game.js: /invite and the case board', () => {
  it('/invite goes through inviteFor with the room, the pin and the session\'s warning', () => {
    const cmd = slice(game, 'async function handleCommand(t) {', '// desktop: a fetch that never reached the site')
    expect(cmd).toMatch(/\} else if \(cmd === 'invite'\) \{[\s\S]*const inv = inviteFor\(\{ arg, room, anchor, warned: pinWarned \}\)\r?\n\s*pinWarned = inv\.warned\r?\n\s*if \(!inv\.url\) \{ showMessage\(inv\.say, PRIO\.discovery\); return \}/)
    expect(game).toMatch(/let pinWarned = false[^\n]*\r?\n\s*async function handleCommand\(t\) \{/)
    expect(game).toContain("addChatLine('', 'connected — Enter to chat · /me to emote · /invite for a link', true)")
  })
  it('the case board: relative on the site, the site\'s own address everywhere else (itch, the desktop app, localhost)', () => {
    expect(game).toContain("import { inviteFor, recoverBase, RECOVER_LOCAL } from './site.js'")
    expect(game).toContain("const RECOVER_BASE = recoverBase(typeof location === 'undefined' ? null : location)")
    expect(game).toContain('const RECOVER_REMOTE = RECOVER_BASE !== RECOVER_LOCAL')
    expect(game).not.toContain('recover/cases')
  })
})

describe('the offline shells and the desktop bridge', () => {
  it('both shells carry site.js, and both caches were renamed for it', () => {
    expect(sw).toContain(`'/renderer/site.js'`)
    expect(build).toContain(`'site.js'`)
    expect(Number(/backrooms-pwa-v(\d+)/.exec(sw)[1])).toBeGreaterThanOrEqual(11)
    expect(Number(/PLAY_SW_VERSION:-(\d+)/.exec(build)[1])).toBeGreaterThanOrEqual(22)
  })
  it('a navigation with a query (an invite) is the same page: matched ignoring the query, never stored once per code', () => {
    for (const src of [sw, build]) {
      expect(src).toMatch(/const cached = await caches\.match\(req, req\.mode === 'navigate' \? \{ ignoreSearch: true \} : undefined\)/)
      expect(src).toContain("if (res.ok && !(req.mode === 'navigate' && new URL(req.url).search)) { const c = await caches.open(CACHE); c.put(req, res.clone()) }")
      expect(src).not.toMatch(/if \(res\.ok\) \{ const c = await caches\.open\(CACHE\)/)
    }
  })
  it('the desktop copies an invite through main, and main copies only our own /play/ link', () => {
    expect(preload).toContain("copyInvite: (url) => ipcRenderer.invoke('copy-invite', url),")
    expect(main).toMatch(/import \{ app, BrowserWindow, ipcMain, shell, clipboard \} from 'electron'/)
    expect(main).toContain("ipcMain.handle('copy-invite', (_e, url) => {")
    expect(main).toContain("url.startsWith('https://backrooms.thecornerspore.dev/play/?room=')")
  })
})
