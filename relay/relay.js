// backrooms-relay — a Cloudflare Worker + Durable Object that relays a small
// multiplayer room over WebSockets. One public wss:// URL, one room code, no
// host and no port-forwarding: everyone connects here and shares a world.
//
// Speaks the exact same JSON protocol as server/index.js:
//   → join {roomId, worldSeed?, name}  → pos {x,y,angle}  → chat {text}
//   → ev {kind, payload, keep?, drop?}
//   ← welcome {playerId, worldSeed, first}  ← players [...]  ← joined/left/chat
//   ← ev {id, name, kind, payload, t, replay?}
//
// Uses the WebSocket Hibernation API + a SQLite-backed class so it runs on the
// Workers free plan. Per-connection state (id, name, position, the ev token
// bucket) rides in each socket's attachment, so it survives hibernation
// between bursts of traffic.
//
// Two plain HTTPS routes ride the same worker:
//   POST /wish  {text, meta, version?} → files the wish as a GitHub issue with
//               the relay's own token (env.GITHUB_TOKEN, a wrangler secret) —
//               the only key there is; no copy of the game carries one.
//               ← {ok:true, number} | {ok:false, reason}
//   GET  /maps?u=<maps.app.goo.gl link> → {lat, lng}: the pin a phone's share
//               link redirects to, for the anchor field (relay/mapslink.js).
// Both are rate-limited per sender through the Gate durable object, keyed by
// a salted hash of CF-Connecting-IP (an IPv6 address by its /64), and /wish
// also by one Gate every sender shares. Nothing here logs; wrangler.jsonc turns
// the invocation log off, so not even the URL of a /maps call is kept.
import { DurableObject } from 'cloudflare:workers'
import { roomSeed } from './seed.js'
import { evKindOk, evFrameOk, evBucket } from './evguard.js'
import { createEvLog } from './evlog.js'
import { BODY_MAX, DAY_MS, GATE_RULES, GLOBAL_GATE, ALLOWED_ORIGINS, WISH_ORIGINS, originOk, corsHeaders, validateWish, filterWish, buildIssue, issueRequest, gateTake, gateKey, hashIp } from './wishgate.js'
import { shortLink, resolveShortLink } from './mapslink.js'

export class Room extends DurableObject {
  async fetch(request) {
    // No seed logic here. This is the WebSocket upgrade, and the join message
    // carrying the client's requested seed has not arrived yet — which is why
    // the old ?seed= param could never work: index.html never sent one, so
    // Number(null) === 0 failed the guard and every room fell to Math.random()
    // while the HUD reported the player's real anchor. The world is decided in
    // webSocketMessage('join') instead.
    const pair = new WebSocketPair()
    const client = pair[0], server = pair[1]
    const id = crypto.randomUUID().slice(0, 12)
    server.serializeAttachment({ id, name: 'wanderer', x: 0, y: 0, angle: 0 })
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  // The keep/drop log (relay/evlog.js) — the only server state the ev
  // substrate adds, behind the owner's opt-in (wrangler var EV_LOG; '0' turns
  // it off). It lives in this instance's memory: a hibernated or evicted
  // object forgets it, which is acceptable for a leave-behind log.
  evLog() {
    if (!this._evLog) this._evLog = createEvLog({ max: 64, perName: 6 })
    return this._evLog
  }

  async webSocketMessage(ws, raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    const att = ws.deserializeAttachment() || {}
    const env = this.env || {}
    const LOG = env.EV_LOG !== '0'

    if (msg.type === 'join') {
      att.name = String(msg.name || 'wanderer').slice(0, 24)
      ws.serializeAttachment(att)
      const roomId = String(msg.roomId || 'default').slice(0, 32)
      // The first joiner into a virgin room fixes its world — from their anchor
      // if they sent one, mirroring server/index.js:72-77. Durable Object input
      // gates make this get/put atomic: no other event is delivered while a
      // storage op is in flight, so two simultaneous joins cannot interleave.
      const stored = await this.ctx.storage.get('seed')
      const seed = roomSeed(msg.worldSeed, stored)
      if (stored == null) await this.ctx.storage.put('seed', seed)
      // first = no OTHER live socket in the room at join (the accepting socket is
      // already in the list). NOT `stored == null`: the seed is kept forever, which
      // would mint every returning visitor to an empty room thin.
      ws.send(JSON.stringify({ type: 'welcome', playerId: att.id, worldSeed: seed, roomId, first: this.ctx.getWebSockets().length === 1 }))
      if (LOG) for (const f of this.evLog().replay()) { try { ws.send(JSON.stringify({ ...f, replay: true })) } catch { /* ignore */ } }
      this.broadcast({ type: 'joined', id: att.id, name: att.name }, att.id)
      this.pushPlayers()
    } else if (msg.type === 'pos') {
      att.x = +msg.x || 0; att.y = +msg.y || 0; att.angle = +msg.angle || 0; att.hp = (msg.hp == null ? 100 : +msg.hp)
      ws.serializeAttachment(att)
      this.pushPlayers()
    } else if (msg.type === 'chat') {
      const text = String(msg.text ?? '').slice(0, 200)
      if (text.trim()) this.broadcast({ type: 'chat', id: att.id, name: att.name, text }, att.id)
    } else if (msg.type === 'typing') {
      this.broadcast({ type: 'typing', id: att.id, name: att.name, on: !!msg.on }, att.id)
    } else if (msg.type === 'ev') {
      // one generic relayed event — mirrored textually in server/index.js. The relay
      // never inspects kind semantics or payload: size, spelling, rate, attach, forward.
      if (!evFrameOk(raw)) return
      const kind = typeof msg.kind === 'string' ? msg.kind : ''
      if (!evKindOk(kind)) return
      const ok = evBucket(att, Date.now())
      ws.serializeAttachment(att)                  // evTok/evT ride the attachment
      if (!ok) return
      const out = { type: 'ev', id: att.id, name: att.name, kind, payload: msg.payload, t: Date.now() }
      if (LOG && typeof msg.keep === 'string') this.evLog().keep(msg.keep.slice(0, 48), att.name, out)
      else if (LOG && typeof msg.drop === 'string') this.evLog().drop(msg.drop.slice(0, 48))
      this.broadcast(out, att.id)
    }
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {}
    this.broadcast({ type: 'left', id: att.id, name: att.name }, att.id)
    // The world is NEVER forgotten. A room is a persistent place.
    // This used to delete the seed once the last player left, so the same room
    // code produced a different maze tomorrow — and nothing persistent (least
    // of all territory) can be built on a room that erases itself.
  }

  webSocketError() { /* close handler does the cleanup */ }

  broadcast(obj, exceptId) {
    const raw = JSON.stringify(obj)
    for (const s of this.ctx.getWebSockets()) {
      const a = s.deserializeAttachment() || {}
      if (a.id !== exceptId) { try { s.send(raw) } catch { /* ignore */ } }
    }
  }

  pushPlayers() {
    const sockets = this.ctx.getWebSockets()
    const list = sockets.map(s => {
      const a = s.deserializeAttachment() || {}
      return { id: a.id, x: a.x, y: a.y, angle: a.angle, name: a.name, hp: a.hp ?? 100 }
    })
    const raw = JSON.stringify({ type: 'players', list })
    for (const s of sockets) { try { s.send(raw) } catch { /* ignore */ } }
  }
}

// One per hashed address (the worker names it by hashIp). It keeps only the
// times of recent takes per bucket ('wish', 'maps'), and an alarm wipes the lot
// a day after the last take, so an address that stops calling leaves nothing.
// Input gates make each take's get/put atomic.
export class Gate extends DurableObject {
  async take(bucket) {
    const rules = GATE_RULES[bucket]
    if (!rules) return { ok: false, retryMs: 0 }
    const now = Date.now()
    const r = gateTake(await this.ctx.storage.get(bucket), now, rules)
    if (r.ok) {
      await this.ctx.storage.put(bucket, r.stamps)
      await this.ctx.storage.setAlarm(now + DAY_MS)
    }
    return { ok: r.ok, retryMs: r.retryMs }
  }

  async alarm() { await this.ctx.storage.deleteAll() }
}

// each route's own origins: a browser may call /maps from the desktop page ('null' / 'file://'), /wish only from the site and itch
const ROUTE_ORIGINS = { '/wish': WISH_ORIGINS, '/maps': ALLOWED_ORIGINS }

function reply(obj, status, origin, extra, allowed = ALLOWED_ORIGINS) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin, allowed), ...extra },
  })
}

async function gate(request, env, bucket) {
  const key = await hashIp(gateKey(request.headers.get('CF-Connecting-IP') || ''), env.IP_SALT || 'backrooms-gate')
  return env.GATE.get(env.GATE.idFromName(key)).take(bucket)
}

const refused = (g, origin, allowed) => reply({ ok: false, reason: 'rate' }, 429, origin, { 'Retry-After': String(Math.max(1, Math.ceil(g.retryMs / 1000))) }, allowed)

// The body, never more than max bytes of it: a chunked request has no Content-Length to refuse up front, and request.text() would
// buffer all of it (up to Cloudflare's 100 MB) before anything could be checked. -> the text, or null once it runs past max
export async function readCapped(request, max) {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const parts = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > max) { try { await reader.cancel() } catch { /* already gone */ } return null }
    parts.push(value)
  }
  const all = new Uint8Array(n)
  let at = 0
  for (const p of parts) { all.set(p, at); at += p.byteLength }
  return new TextDecoder().decode(all)
}

// refusals that cost nothing come first (origin, token, shape, words); only a
// wish that would be filed takes one of the address's wishes
async function wish(request, env, origin) {
  const say = (obj, status, extra) => reply(obj, status, origin, extra, WISH_ORIGINS)
  if (!env.GITHUB_TOKEN) return say({ ok: false, reason: 'closed' }, 503)
  if (Number(request.headers.get('content-length')) > BODY_MAX) return say({ ok: false, reason: 'body' }, 413)
  const raw = await readCapped(request, BODY_MAX)
  if (raw == null) return say({ ok: false, reason: 'body' }, 413)
  let body
  try { body = JSON.parse(raw) } catch { return say({ ok: false, reason: 'body' }, 400) }
  const v = validateWish(body)
  if (!v.ok) return say({ ok: false, reason: v.reason }, 400)
  const bad = filterWish(v.wish.text)
  if (bad) return say({ ok: false, reason: bad }, 422)
  const g = await gate(request, env, 'wish')
  if (!g.ok) return refused(g, origin, WISH_ORIGINS)
  // the one gate every sender shares: the worst any number of addresses can do in a day is bounded
  const all = await env.GATE.get(env.GATE.idFromName(GLOBAL_GATE)).take('wishAll')
  if (!all.ok) return refused(all, origin, WISH_ORIGINS)
  const { url, init } = issueRequest(buildIssue(v.wish), { repo: env.GITHUB_REPO, token: env.GITHUB_TOKEN })
  try {
    const res = await fetch(url, init)
    if (res.status !== 201) return say({ ok: false, reason: 'upstream' }, 502)
    const issue = await res.json()
    return say({ ok: true, number: issue.number }, 201)
  } catch {
    return say({ ok: false, reason: 'upstream' }, 502)
  }
}

async function maps(request, env, origin, url) {
  const u = url.searchParams.get('u') || ''
  // the link is checked before the gate, and resolveShortLink checks it again: nothing else is ever fetched
  if (!shortLink(u)) return reply({ ok: false, reason: 'link' }, 400, origin)
  const g = await gate(request, env, 'maps')
  if (!g.ok) return refused(g, origin)
  const r = await resolveShortLink(u, (to, init) => fetch(to, init))
  if (r.lat != null) return reply({ lat: r.lat, lng: r.lng }, 200, origin)
  const status = r.reason === 'upstream' ? 502 : r.reason === 'link' ? 400 : 422
  return reply({ ok: false, reason: r.reason }, status, origin)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.headers.get('Upgrade') !== 'websocket') {
      if (url.pathname === '/wish' || url.pathname === '/maps') {
        const origin = request.headers.get('Origin')
        const allowed = ROUTE_ORIGINS[url.pathname]
        if (request.method === 'OPTIONS') {
          return originOk(origin, allowed) && origin != null
            ? new Response(null, { status: 204, headers: corsHeaders(origin, allowed) })
            : new Response(null, { status: 403, headers: { Vary: 'Origin' } })
        }
        if (!originOk(origin, allowed)) return reply({ ok: false, reason: 'origin' }, 403, null)
        if (url.pathname === '/wish') return request.method === 'POST' ? wish(request, env, origin) : reply({ ok: false, reason: 'method' }, 405, origin)
        return request.method === 'GET' ? maps(request, env, origin, url) : reply({ ok: false, reason: 'method' }, 405, origin)
      }
      return new Response('the backrooms relay is running.\nconnect a websocket: wss://<this-host>/?room=CODE', {
        status: 200, headers: { 'content-type': 'text/plain' },
      })
    }
    const room = (url.searchParams.get('room') || 'default').slice(0, 32)
    const stub = env.ROOM.get(env.ROOM.idFromName(room))
    return stub.fetch(request)
  },
}
