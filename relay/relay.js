// backrooms-relay — a Cloudflare Worker + Durable Object that relays a small
// multiplayer room over WebSockets. One public wss:// URL, one room code, no
// host and no port-forwarding: everyone connects here and shares a world.
//
// Speaks the exact same JSON protocol as server/index.js:
//   → join {roomId, worldSeed?, name}  → pos {x,y,angle}  → chat {text}
//   ← welcome {playerId, worldSeed}     ← players [...]     ← joined/left/chat
//
// Uses the WebSocket Hibernation API + a SQLite-backed class so it runs on the
// Workers free plan. Per-connection state (id, name, position) rides in each
// socket's attachment, so it survives hibernation between bursts of traffic.
import { DurableObject } from 'cloudflare:workers'
import { roomSeed } from './seed.js'
import SEED from './atlas-seed.js'
import { parseAtlasPath, authorize, readAtlas, upsertBeacon, appendStratum, checkin, dropin, regenBalance } from './atlas.js'

// sha256 hex — salts the per-device check-in dedup key with the beacon id so the
// same device is never correlatable across beacons, even in DO storage.
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

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

  async webSocketMessage(ws, raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    const att = ws.deserializeAttachment() || {}

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
      ws.send(JSON.stringify({ type: 'welcome', playerId: att.id, worldSeed: seed, roomId }))
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

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,PUT,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
}
function atlasJson(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...CORS } })
}

// A single global store of beacons + strata. Reads are open (CORS); writes need
// the admin bearer secret. All logic is the pure module atlas.js; this shell just
// loads the store, calls it, and persists. Seeded from atlas-seed.js on first use.
export class Atlas extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url)
    const route = parseAtlasPath(url.pathname)
    if (!route) return atlasJson(404, { error: 'not found' })
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    let store = await this.ctx.storage.get('store')
    if (!store) { store = SEED; await this.ctx.storage.put('store', store) }

    if (request.method === 'GET') {
      const r = readAtlas(store, route)
      return atlasJson(r.status, r.json)
    }

    // presence-proved check-in — NO admin key; geolocation proximity is the gate.
    // Coords are used only to verify distance, then discarded (never stored).
    if (request.method === 'POST' && route.resource === 'checkin') {
      const body = await request.json().catch(() => null)
      if (!body || typeof body !== 'object') return atlasJson(400, { error: 'body must be json' })
      const visitor = typeof body.visitor === 'string' ? body.visitor.slice(0, 100) : ''
      if (!visitor) return atlasJson(400, { error: 'visitor required' })
      const key = await sha256Hex(route.id + ':' + visitor)
      const dedupKey = 'dedup:' + route.id
      const dedup = (await this.ctx.storage.get(dedupKey)) || {}
      const r = checkin(store, dedup, route.id, { lat: body.lat, lng: body.lng }, key, Date.now())
      try {
        if (r.store) await this.ctx.storage.put('store', r.store)
        if (r.dedup) await this.ctx.storage.put(dedupKey, r.dedup)
      } catch { return atlasJson(503, { error: 'atlas write failed' }) }
      return atlasJson(r.status, r.json)
    }

    // passage balance for an anonymous device token (regenerated, read-only)
    if (request.method === 'POST' && route.resource === 'passage') {
      const body = await request.json().catch(() => null)
      const visitor = body && typeof body.visitor === 'string' ? body.visitor.slice(0, 100) : ''
      if (!visitor) return atlasJson(400, { error: 'visitor required' })
      const rec = await this.ctx.storage.get('passage:' + await sha256Hex(visitor))
      return atlasJson(200, { passage: Math.floor(regenBalance(rec, Date.now())) })
    }

    // drop in on a far beacon — spends distance-scaled passage; coords discarded.
    if (request.method === 'POST' && route.resource === 'dropin') {
      const body = await request.json().catch(() => null)
      if (!body || typeof body !== 'object') return atlasJson(400, { error: 'body must be json' })
      const visitor = typeof body.visitor === 'string' ? body.visitor.slice(0, 100) : ''
      if (!visitor) return atlasJson(400, { error: 'visitor required' })
      const pKey = 'passage:' + await sha256Hex(visitor)
      const rec = await this.ctx.storage.get(pKey)
      const r = dropin(store, rec, route.id, { lat: body.lat, lng: body.lng }, Date.now())
      try {
        if (r.store) await this.ctx.storage.put('store', r.store)
        if (r.passage) await this.ctx.storage.put(pKey, r.passage)
      } catch { return atlasJson(503, { error: 'atlas write failed' }) }
      return atlasJson(r.status, r.json)
    }

    // writes require the admin key
    if (!authorize(request.headers.get('authorization'), this.env.ATLAS_ADMIN_KEY)) {
      return atlasJson(401, { error: 'unauthorized' })
    }
    const body = await request.json().catch(() => null)
    if (body == null) return atlasJson(400, { error: 'body must be json' })

    if (request.method === 'PUT' && route.resource === 'beacon') {
      const r = upsertBeacon(store, route.id, body)
      try { if (r.store) await this.ctx.storage.put('store', r.store) }
      catch { return atlasJson(503, { error: 'atlas write failed' }) }
      return atlasJson(r.status, r.json)
    }
    if (request.method === 'POST' && route.resource === 'strata') {
      const r = appendStratum(store, route.id, body)
      try { if (r.store) await this.ctx.storage.put('store', r.store) }
      catch { return atlasJson(503, { error: 'atlas write failed' }) }
      return atlasJson(r.status, r.json)
    }
    return atlasJson(405, { error: 'method not allowed' })
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/atlas')) {
      const stub = env.ATLAS.get(env.ATLAS.idFromName('global'))
      return stub.fetch(request)
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('the backrooms relay is running.\nconnect a websocket: wss://<this-host>/?room=CODE', {
        status: 200, headers: { 'content-type': 'text/plain' },
      })
    }
    const room = (url.searchParams.get('room') || 'default').slice(0, 32)
    const stub = env.ROOM.get(env.ROOM.idFromName(room))
    return stub.fetch(request)
  },
}
