# Beacon T0 (Solo Signal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a player register their own outbound webhook and fire it with a keypress in-game — the disclosure-safe first slice of the beacon feature.

**Architecture:** All webhook validation and firing lives in a new pure `src/webhook.js` module (Node builtins only, no Electron import) so it is fully unit-testable. The Electron main process exposes one thin `fire-beacon` IPC handler that calls it; the renderer reaches it only through the existing `window.backrooms` preload bridge (the renderer never makes network calls itself). A keybind in the game loop and two fields in the settings modal complete the loop.

**Tech Stack:** Electron (ESM, `"type": "module"`), Node `https` / `dns` / `net` / `url` builtins, Vitest for tests. No new runtime dependencies.

## Global Constraints

- **Renderer has zero outbound network access.** Every HTTP call goes through a narrow main-process IPC handler; the renderer only calls `window.backrooms.fireBeacon(...)`. (Matches the existing `submit-wish` / `open-external` pattern.)
- **Outbound-safety rules, applied to every fire (verbatim, non-negotiable):** `https`-only scheme; **port 443 only**; **resolve-then-pin** DNS — reject every private / reserved / loopback / link-local / ULA / carrier-grade-NAT / cloud-metadata address; **no redirect following**; small fixed request body; **response body dropped**; short timeout (5000 ms); **no retries in T0**; a per-fire cooldown (10 s) in the main process.
- **No new runtime dependencies.** Use Node builtins only (`https`, `dns`, `net`, `url`).
- **Scope boundary:** T0 is a player firing *their own* webhook to *themselves*. Any behaviour involving a second participant is out of scope for every task below and must not be added here.
- **Copy tone:** lowercase, terse, in-world — match the existing `showMessage(...)` strings in `src/renderer/game.js`.
- **Module style:** small focused modules with named exports, mirroring `src/settings.js` and `src/renderer/anchor.js`.

---

### Task 1: Beacon preferences

**Files:**
- Modify: `src/renderer/prefs.js:14-27` (add two keys to `PREF_DEFAULTS`)
- Test: `test/prefs.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: two persisted prefs — `beaconEffect` (string, one of `'off' | 'ntfy' | 'discord' | 'custom'`, default `'off'`) and `beaconWebhook` (string, default `''`). Later tasks read these via `getPref('beaconEffect')` / `getPref('beaconWebhook')`.

- [ ] **Step 1: Write the failing test**

Append to `test/prefs.test.js` inside the existing `describe('prefs', ...)` block:

```js
  it('carries beacon defaults (off, empty target)', () => {
    expect(PREF_DEFAULTS.beaconEffect).toBe('off')
    expect(PREF_DEFAULTS.beaconWebhook).toBe('')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/prefs.test.js -t "beacon defaults"`
Expected: FAIL — `expected undefined to be 'off'`.

- [ ] **Step 3: Write minimal implementation**

In `src/renderer/prefs.js`, add the two keys at the end of the `PREF_DEFAULTS` object (after the `damage:` line, keeping the trailing comma style):

```js
  creatures:        true,   // do things spawn below level 0 at all
  damage:           true,   // can they hurt you (peaceful mode == false)
  beaconEffect:     'off',  // 'off' | 'ntfy' | 'discord' | 'custom' — what B fires
  beaconWebhook:    '',     // ntfy topic, or an https webhook url, per beaconEffect
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/prefs.test.js`
Expected: PASS (all prefs tests, including the new one).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/prefs.js test/prefs.test.js
git commit -m "feat(beacon): beaconEffect + beaconWebhook prefs"
```

---

### Task 2: SSRF address classifier

**Files:**
- Create: `src/webhook.js`
- Test: `test/webhook.test.js`

**Interfaces:**
- Consumes: Node `net` builtin.
- Produces: `isBlockedAddress(ip: string): boolean` — `true` when a **literal** IP address must never be a webhook target (private / reserved / loopback / link-local / ULA / CGNAT / metadata / multicast), or when the input is not a bare IP literal. Later tasks call it on every DNS-resolved address.

- [ ] **Step 1: Write the failing test**

Create `test/webhook.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { isBlockedAddress } from '../src/webhook.js'

describe('isBlockedAddress', () => {
  it('blocks IPv4 private / loopback / link-local / metadata / CGNAT ranges', () => {
    for (const ip of [
      '0.0.0.0', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '169.254.0.1', '100.64.0.1', '224.0.0.1',
      '255.255.255.255',
    ]) expect(isBlockedAddress(ip)).toBe(true)
  })

  it('allows ordinary public IPv4', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1'])
      expect(isBlockedAddress(ip)).toBe(false)
  })

  it('blocks IPv6 loopback / ULA / link-local and IPv4-mapped private', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1'])
      expect(isBlockedAddress(ip)).toBe(true)
  })

  it('allows public IPv6 and blocks non-IP input', () => {
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false)
    expect(isBlockedAddress('example.com')).toBe(true)
    expect(isBlockedAddress('')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/webhook.test.js`
Expected: FAIL — cannot resolve import `../src/webhook.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/webhook.js`:

```js
// webhook.js — outbound "beacon" signal (T0 solo).
//
// A player registers their own webhook target; pressing B in-game fires a
// small fixed POST to it. The renderer has no network access, so the main
// process calls fireBeacon() here. This module is SSRF-hardened and pure
// (Node builtins only, no Electron) so it can be unit-tested in isolation.
//
// SCOPE: T0 fires the player's OWN webhook to themselves. No co-presence,
// matching, or shared index of any kind lives here.

import net from 'net'

// True when a LITERAL ip must never be a webhook target. Anything that is not
// a bare IP literal is blocked too — callers only ever pass resolved literals.
export function isBlockedAddress(ip) {
  const v = net.isIP(ip)
  if (v === 4) return isBlockedV4(ip)
  if (v === 6) return isBlockedV6(ip)
  return true
}

function isBlockedV4(ip) {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p
  if (a === 0) return true                            // 0.0.0.0/8 "this network"
  if (a === 10) return true                           // 10/8 private
  if (a === 127) return true                          // 127/8 loopback
  if (a === 169 && b === 254) return true             // 169.254/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true    // 172.16/12 private
  if (a === 192 && b === 168) return true             // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true   // 100.64/10 carrier-grade NAT
  if (a >= 224) return true                           // 224/4 multicast + 240/4 reserved + broadcast
  return false
}

function isBlockedV6(ip) {
  const s = ip.toLowerCase()
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)   // IPv4-mapped → judge as v4
  if (mapped) return isBlockedV4(mapped[1])
  if (s === '::' || s === '::1') return true               // unspecified, loopback
  if (/^fe[89ab]/.test(s)) return true                     // fe80::/10 link-local
  if (/^f[cd]/.test(s)) return true                        // fc00::/7 unique-local
  if (s.startsWith('ff')) return true                      // ff00::/8 multicast
  return false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/webhook.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/webhook.js test/webhook.test.js
git commit -m "feat(beacon): SSRF address classifier for webhook targets"
```

---

### Task 3: URL validation and payload builder

**Files:**
- Modify: `src/webhook.js`
- Test: `test/webhook.test.js`

**Interfaces:**
- Consumes: `isBlockedAddress` (Task 2); Node `net` and `url` (`URL` global).
- Produces:
  - `validateWebhookUrl(urlStr: string): URL` — returns a parsed `URL` for an `https`, port-443, credential-free target whose literal-IP host (if any) is not blocked; throws `Error` otherwise.
  - `buildBeaconTarget(effect: string, webhook: string, ctx: {appVersion: string, now: number}): {url: string, headers: object, body: string}` — shapes the request per effect (`ntfy` / `discord` / `custom`); throws `Error` on a bad effect or bad target.

- [ ] **Step 1: Write the failing test**

Append to `test/webhook.test.js`:

```js
import { validateWebhookUrl, buildBeaconTarget } from '../src/webhook.js'

describe('validateWebhookUrl', () => {
  it('accepts a plain https url', () => {
    expect(validateWebhookUrl('https://example.com/hook').hostname).toBe('example.com')
  })
  it('rejects http, non-443 ports, credentials, and blocked literal IPs', () => {
    expect(() => validateWebhookUrl('http://example.com')).toThrow()
    expect(() => validateWebhookUrl('https://example.com:8443/x')).toThrow()
    expect(() => validateWebhookUrl('https://user:pw@example.com')).toThrow()
    expect(() => validateWebhookUrl('https://127.0.0.1/x')).toThrow()
    expect(() => validateWebhookUrl('not a url')).toThrow()
  })
})

describe('buildBeaconTarget', () => {
  const ctx = { appVersion: '1.4.0', now: 0 }
  it('builds an ntfy target from a sanitized topic', () => {
    const t = buildBeaconTarget('ntfy', 'my-room_1', ctx)
    expect(t.url).toBe('https://ntfy.sh/my-room_1')
    expect(t.body).toContain('beacon')
  })
  it('rejects an ntfy topic with unsafe characters', () => {
    expect(() => buildBeaconTarget('ntfy', 'a/b', ctx)).toThrow()
    expect(() => buildBeaconTarget('ntfy', '', ctx)).toThrow()
  })
  it('requires a discord host for the discord effect', () => {
    expect(buildBeaconTarget('discord', 'https://discord.com/api/webhooks/1/x', ctx).url)
      .toContain('discord.com')
    expect(() => buildBeaconTarget('discord', 'https://evil.example/x', ctx)).toThrow()
  })
  it('builds a custom json target and rejects unknown effects', () => {
    const t = buildBeaconTarget('custom', 'https://example.com/hook', ctx)
    expect(JSON.parse(t.body)).toMatchObject({ event: 'beacon', app: 'backrooms', version: '1.4.0' })
    expect(() => buildBeaconTarget('nope', '', ctx)).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/webhook.test.js -t "validateWebhookUrl"`
Expected: FAIL — `validateWebhookUrl is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/webhook.js`:

```js
const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/

// Parse + gate an https webhook url. Literal-IP hosts are checked now; DNS
// names get resolve-then-pin at fire time (resolveAndPin, Task 4).
export function validateWebhookUrl(urlStr) {
  let u
  try { u = new URL(urlStr) } catch { throw new Error('not a valid url') }
  if (u.protocol !== 'https:') throw new Error('https only')
  if (u.port && u.port !== '443') throw new Error('port 443 only')
  if (u.username || u.password) throw new Error('no credentials in url')
  if (net.isIP(u.hostname) && isBlockedAddress(u.hostname)) throw new Error('blocked address')
  return u
}

// Shape the outbound request for the chosen effect. Never trusts the raw
// target beyond what validateWebhookUrl / the ntfy regex permit.
export function buildBeaconTarget(effect, webhook, { appVersion, now }) {
  const target = String(webhook || '').trim()
  if (effect === 'ntfy') {
    if (!NTFY_TOPIC_RE.test(target)) throw new Error('ntfy topic: 1-64 of letters, digits, _ or -')
    return {
      url: `https://ntfy.sh/${target}`,
      headers: { 'Content-Type': 'text/plain', 'Title': 'the backrooms', 'Tags': 'green_circle' },
      body: 'a beacon was pushed.',
    }
  }
  if (effect === 'discord') {
    const u = validateWebhookUrl(target)
    if (u.hostname !== 'discord.com' && !u.hostname.endsWith('.discord.com'))
      throw new Error('not a discord webhook url')
    return {
      url: u.href,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'a beacon was pushed in the backrooms.' }),
    }
  }
  if (effect === 'custom') {
    const u = validateWebhookUrl(target)
    return {
      url: u.href,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'beacon', app: 'backrooms', version: appVersion, ts: new Date(now).toISOString() }),
    }
  }
  throw new Error(`unknown beacon effect: ${effect}`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/webhook.test.js`
Expected: PASS (all webhook tests so far).

- [ ] **Step 5: Commit**

```bash
git add src/webhook.js test/webhook.test.js
git commit -m "feat(beacon): url validation + per-effect payload builder"
```

---

### Task 4: Resolve-then-pin and the fire orchestrator

**Files:**
- Modify: `src/webhook.js`
- Test: `test/webhook.test.js`

**Interfaces:**
- Consumes: `isBlockedAddress`, `validateWebhookUrl`, `buildBeaconTarget`; Node `https`, `dns`.
- Produces:
  - `resolveAndPin(hostname: string, lookup?): Promise<string>` — resolves a hostname to a pinned literal IP, rejecting if it is (or any of its addresses is) blocked. `lookup` is injectable for tests; it resolves to an array of `{address, family}`.
  - `fireBeacon(effect: string, webhook: string, opts?: {appVersion?, now?, lookup?, request?, timeoutMs?}): Promise<{ok: boolean, status?: number, skipped?: boolean}>` — validates, pins, and POSTs. `request` (defaults to `https.request`) and `lookup` are injectable. Connects to the pinned IP with SNI + `Host` set to the real hostname (defeats DNS-rebinding between check and connect). No redirects, response body dropped.

- [ ] **Step 1: Write the failing test**

Append to `test/webhook.test.js`:

```js
import { resolveAndPin, fireBeacon } from '../src/webhook.js'

const pub = (addr, family = 4) => async () => [{ address: addr, family }]

describe('resolveAndPin', () => {
  it('returns a public address and rejects a blocked one', async () => {
    await expect(resolveAndPin('example.com', pub('93.184.216.34'))).resolves.toBe('93.184.216.34')
    await expect(resolveAndPin('sneaky.internal', pub('169.254.169.254'))).rejects.toThrow()
  })
  it('rejects when ANY resolved address is blocked', async () => {
    const mixed = async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }]
    await expect(resolveAndPin('mixed.example', mixed)).rejects.toThrow()
  })
})

describe('fireBeacon', () => {
  it('skips when effect is off without touching the network', async () => {
    let called = false
    const request = () => { called = true }
    const r = await fireBeacon('off', '', { request, lookup: pub('1.1.1.1') })
    expect(r.skipped).toBe(true)
    expect(called).toBe(false)
  })

  it('refuses to fire at a blocked target before any request', async () => {
    let called = false
    const request = () => { called = true }
    await expect(fireBeacon('custom', 'https://x.example/h', {
      request, lookup: pub('127.0.0.1'),
    })).rejects.toThrow()
    expect(called).toBe(false)
  })

  it('posts to a public target and reports a 2xx as ok', async () => {
    const seen = {}
    const fakeReq = (opts, cb) => {
      seen.opts = opts
      const res = { statusCode: 204, resume() {} }
      queueMicrotask(() => cb(res))
      return { on() {}, write() {}, end() {}, destroy() {} }
    }
    const r = await fireBeacon('custom', 'https://example.com/hook', {
      appVersion: '1.4.0', now: 0, lookup: pub('93.184.216.34'), request: fakeReq,
    })
    expect(r).toEqual({ ok: true, status: 204 })
    expect(seen.opts.host).toBe('93.184.216.34')   // connects to the pinned IP
    expect(seen.opts.servername).toBe('example.com')
    expect(seen.opts.headers.Host).toBe('example.com')
    expect(seen.opts.port).toBe(443)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/webhook.test.js -t "resolveAndPin"`
Expected: FAIL — `resolveAndPin is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/webhook.js` (add `import https from 'https'` and `import dns from 'dns'` to the top imports first):

```js
function defaultLookup(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses))
  })
}

// Resolve a hostname to a single pinned literal IP, rejecting if it (or any of
// its resolved addresses) is blocked. A literal-IP host is judged directly.
export async function resolveAndPin(hostname, lookup = defaultLookup) {
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new Error('blocked address')
    return hostname
  }
  const addrs = await lookup(hostname)
  if (!addrs || !addrs.length) throw new Error('host did not resolve')
  for (const a of addrs) if (isBlockedAddress(a.address)) throw new Error('resolves to a blocked address')
  return addrs[0].address
}

// Validate → pin → POST. https-only, port 443, no redirects, body dropped,
// 5 s timeout, no retries.
export async function fireBeacon(effect, webhook, opts = {}) {
  const {
    appVersion = '0.0.0', now = 0,
    lookup = defaultLookup, request = https.request, timeoutMs = 5000,
  } = opts
  if (!effect || effect === 'off') return { ok: false, skipped: true }

  const target = buildBeaconTarget(effect, webhook, { appVersion, now })
  const u = new URL(target.url)
  const pinnedIp = await resolveAndPin(u.hostname, lookup)

  return new Promise((resolve, reject) => {
    const req = request({
      protocol: 'https:',
      host: pinnedIp,             // connect to the pinned IP, not a re-resolved name
      servername: u.hostname,     // TLS SNI + cert hostname still verify against the real host
      port: 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        ...target.headers,
        'Host': u.hostname,       // virtual-host routing at the pinned IP
        'Content-Length': Buffer.byteLength(target.body),
        'User-Agent': `backrooms/${appVersion}`,
      },
      timeout: timeoutMs,
    }, (res) => {
      res.resume()                // drop the response body
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('beacon timed out')))
    req.write(target.body)
    req.end()
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/webhook.test.js`
Expected: PASS (all webhook tests, including resolveAndPin + fireBeacon).

- [ ] **Step 5: Commit**

```bash
git add src/webhook.js test/webhook.test.js
git commit -m "feat(beacon): resolve-then-pin + SSRF-safe fire orchestrator"
```

---

### Task 5: Main-process IPC handler

**Files:**
- Modify: `src/main.js` (add import near line 8; register handler after the `open-external` handler around line 148)
- Test: none (main.js imports Electron and has no unit harness; the tested logic lives in `src/webhook.js`). Verification is `npm test` staying green plus the manual smoke in Task 8.

**Interfaces:**
- Consumes: `fireBeacon` from `src/webhook.js`; Electron `app`, `ipcMain`; the module-level `logLine` (main.js:14).
- Produces: an IPC channel `fire-beacon` accepting `{effect, webhook}` and returning `{ok, status?}` / `{ok:false, reason}`. A module-level 10 s cooldown. Task 6 (preload) and Task 7 (game) depend on this channel name and payload shape.

- [ ] **Step 1: Add the import**

At the top of `src/main.js`, directly under the existing `import { readSettings, writeSettings } from './settings.js'` (line 8):

```js
import { readSettings, writeSettings } from './settings.js'
import { fireBeacon } from './webhook.js'
```

- [ ] **Step 2: Add the module-level cooldown state**

Directly under `let mainWindow = null` (main.js:74):

```js
let mainWindow = null
let lastBeaconAt = 0
```

- [ ] **Step 3: Register the handler**

In `app.whenReady()`, immediately after the `open-external` handler's closing `})` (main.js:148), add:

```js
  // beacon (T0 solo): fire the player's OWN registered webhook. All validation
  // and the SSRF-safe POST live in webhook.js; here we only rate-limit + log.
  ipcMain.handle('fire-beacon', async (_e, payload) => {
    const { effect, webhook } = payload || {}
    const now = Date.now()
    if (now - lastBeaconAt < 10_000) return { ok: false, reason: 'cooldown' }
    lastBeaconAt = now
    try {
      const r = await fireBeacon(effect, webhook, { appVersion: app.getVersion(), now })
      logLine(`beacon: effect=${effect} ok=${r.ok} status=${r.status ?? '-'}${r.skipped ? ' (skipped)' : ''}`)
      return r
    } catch (e) {
      logLine(`beacon failed: ${e.message}`)
      return { ok: false, reason: e.message }
    }
  })
```

- [ ] **Step 4: Verify the suite still passes**

Run: `npm test`
Expected: PASS — no regressions (existing suites unchanged; webhook suite green).

- [ ] **Step 5: Commit**

```bash
git add src/main.js
git commit -m "feat(beacon): fire-beacon IPC handler with cooldown + logging"
```

---

### Task 6: Preload bridge

**Files:**
- Modify: `src/preload.cjs:4-15` (add one method to the `backrooms` bridge object)
- Test: none (preload runs only in Electron's sandbox). Covered by the Task 8 smoke.

**Interfaces:**
- Consumes: the `fire-beacon` IPC channel (Task 5).
- Produces: `window.backrooms.fireBeacon(payload)` returning a `Promise` — consumed by Task 7.

- [ ] **Step 1: Add the bridge method**

In `src/preload.cjs`, add a line inside `exposeInMainWorld('backrooms', {...})`, directly after the `openExternal` line:

```js
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  fireBeacon: (payload) => ipcRenderer.invoke('fire-beacon', payload),
  logError: (msg) => ipcRenderer.send('renderer-log', msg),
```

- [ ] **Step 2: Verify the suite still passes**

Run: `npm test`
Expected: PASS — no regressions.

- [ ] **Step 3: Commit**

```bash
git add src/preload.cjs
git commit -m "feat(beacon): expose fireBeacon on the preload bridge"
```

---

### Task 7: In-game keybind (B)

**Files:**
- Modify: `src/renderer/game.js` (add a `KeyB` branch in the action block, after the `KeyL` line at game.js:612)
- Test: none (game.js DOM/loop code has no unit harness — see the comment at game.js:384). Covered by the Task 8 smoke.

**Interfaces:**
- Consumes: `getPref` (already imported and used at game.js:610), `window.backrooms.fireBeacon` (Task 6), `showMessage` (game.js:376), the input map `K`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the keybind branch**

In `src/renderer/game.js`, immediately after the `KeyL` flashlight line (game.js:612), add:

```js
      if (K['KeyL']) { K['KeyL'] = false; flashlight = !flashlight; showMessage(flashlight ? 'flashlight on.' : 'flashlight off — the dark leans in.') }
      if (K['KeyB']) {
        K['KeyB'] = false
        const effect = getPref('beaconEffect')
        if (!effect || effect === 'off') {
          showMessage('no beacon set. register one in settings.')
        } else {
          showMessage('you push the beacon into the dark...')
          const p = window.backrooms?.fireBeacon?.({ effect, webhook: getPref('beaconWebhook') })
          if (p) p.then(r => showMessage(
                    r?.ok ? 'something answers.'
                  : r?.reason === 'cooldown' ? 'the beacon is still warm.'
                  : 'the beacon goes quiet.'))
                 .catch(() => showMessage('the beacon goes quiet.'))
          else showMessage('the beacon goes quiet.')
        }
      }
```

- [ ] **Step 2: Verify the suite still passes**

Run: `npm test`
Expected: PASS — no regressions.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/game.js
git commit -m "feat(beacon): B pushes the beacon in-game"
```

---

### Task 8: Settings UI + end-to-end smoke

**Files:**
- Modify: `src/renderer/index.html` — markup after the "Can take damage" row (index.html:261); wiring after the pref-wiring line (index.html:499); `loadPrefsIntoPanel` additions (index.html:500-513)
- Test: manual Electron smoke (index.html has no unit harness).

**Interfaces:**
- Consumes: `setPref` / `getPrefs` (already imported in the index.html script), the prefs from Task 1, the keybind from Task 7.
- Produces: the settings rows a player uses to register a beacon.

- [ ] **Step 1: Add the markup**

In `src/renderer/index.html`, after the "Can take damage" `toggle-row` (index.html:261) and before the `update-ready-msg` div (index.html:263):

```html
      <div class="set-section">SIGNAL / BEACON</div>
      <label class="toggle-row">
        <span>Beacon effect <span class="set-hint">B fires your own webhook</span></span>
        <select id="set-beacon-effect">
          <option value="off">off</option>
          <option value="ntfy">ntfy.sh topic</option>
          <option value="discord">discord webhook</option>
          <option value="custom">custom https url</option>
        </select>
      </label>
      <label class="toggle-row">
        <span>Beacon target <span class="set-hint">topic or https url</span></span>
        <input type="text" id="set-beacon-webhook" spellcheck="false" style="width:200px;"/>
      </label>
```

- [ ] **Step 2: Wire the change handlers**

After the last pref-wiring line (index.html:499, the `prefRange('set-sens', ...)` line), add:

```js
    prefRange('set-sens', 'mouseSensitivity'); prefChk('set-creatures', 'creatures'); prefChk('set-damage', 'damage')
    document.getElementById('set-beacon-effect').addEventListener('change', e => setPref('beaconEffect', e.target.value))
    document.getElementById('set-beacon-webhook').addEventListener('input', e => setPref('beaconWebhook', e.target.value.slice(0, 300)))
```

- [ ] **Step 3: Load them into the panel**

Inside `loadPrefsIntoPanel()`, after the `set-damage` line (index.html:512), add:

```js
      document.getElementById('set-damage').checked     = p.damage
      document.getElementById('set-beacon-effect').value  = p.beaconEffect
      document.getElementById('set-beacon-webhook').value = p.beaconWebhook
```

- [ ] **Step 4: Verify the suite still passes**

Run: `npm test`
Expected: PASS — no regressions.

- [ ] **Step 5: Manual Electron smoke**

Run: `npm start`

Then:
1. Open **Settings** → scroll to **SIGNAL / BEACON**. Set **Beacon effect** to `ntfy.sh topic` and **Beacon target** to a throwaway topic (e.g. `backrooms-smoke-<random>`). Close settings.
2. In another window open `https://ntfy.sh/<that-topic>` to watch it.
3. Start **SOLO**, press **B**. Expected in-game: `you push the beacon into the dark...` then `something answers.` Expected on ntfy: a notification titled *the backrooms* with body *a beacon was pushed.*
4. Press **B** again within 10 s. Expected: `the beacon is still warm.` (cooldown).
5. Set **Beacon effect** to `off`, press **B**. Expected: `no beacon set. register one in settings.`
6. Set effect to `custom` and target to `https://127.0.0.1/x`, press **B**. Expected: `the beacon goes quiet.` and a `beacon failed: blocked address` line in `userData/backrooms.log`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/index.html
git commit -m "feat(beacon): settings UI to register a beacon target"
```

---

## Self-Review

**Spec coverage** (against the Global Constraints and the T0 scope):

- Renderer has no network access → Task 6 (preload bridge) + Task 5 (main handler); renderer only calls `fireBeacon`. ✅
- https-only, port 443, resolve-then-pin, reject private/reserved/loopback/link-local/ULA/CGNAT/metadata, no redirects, dropped body, 5 s timeout, no retries → Tasks 2–4 (`isBlockedAddress`, `validateWebhookUrl`, `resolveAndPin`, `fireBeacon`). ✅
- Per-fire cooldown → Task 5 (10 s). ✅
- No new runtime dependencies → only `https`/`dns`/`net`/`url` builtins used. ✅
- No behaviour involving a second participant → confirmed absent from every task. ✅
- In-world lowercase copy → Task 7 messages match existing `showMessage` tone. ✅

**Placeholder scan:** no TBD/TODO; every code and test step carries complete code; every command has an expected result. ✅

**Type consistency:** `isBlockedAddress`, `validateWebhookUrl`, `buildBeaconTarget`, `resolveAndPin`, `fireBeacon` are named identically in their defining task and every consuming task; the IPC channel `fire-beacon` and payload `{effect, webhook}` match across Tasks 5–7; pref keys `beaconEffect`/`beaconWebhook` match across Tasks 1, 7, 8. ✅

**Untested surfaces (declared, not hidden):** `src/main.js`, `src/preload.cjs`, `src/renderer/game.js`, `src/renderer/index.html` have no unit harness in this repo; their tasks fold in `npm test` (regression gate) + the Task 8 manual smoke. All branching logic worth testing lives in `src/webhook.js`, which is fully covered.
