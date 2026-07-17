import { WebSocket } from 'ws'

const HOST = 'wss://backrooms-relay.jeff-schatz112.workers.dev'
// A fresh room every run. Seeds are now permanent (webSocketClose no longer
// deletes them), so a fixed room name would keep the seed minted on the FIRST
// run forever and fail every run after.
const ROOM = `smoke-${Date.now().toString(36)}`
const URL  = `${HOST}/?room=${ROOM}`

// Jeff anchors; Maddie does not. Maddie must inherit Jeff's world.
const WANT = 123456789

function mk(name, worldSeed) {
  const ws = new WebSocket(URL)
  const got = { welcome: null, roomId: null, players: 0, joined: [], chat: [] }
  ws.on('open', () => {
    const join = { type: 'join', roomId: ROOM, name }
    if (worldSeed != null) join.worldSeed = worldSeed
    ws.send(JSON.stringify(join))
  })
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString())
    if (m.type === 'welcome') { got.welcome = m.worldSeed; got.roomId = m.roomId }
    else if (m.type === 'players') got.players++
    else if (m.type === 'joined') got.joined.push(m.name)
    else if (m.type === 'chat') got.chat.push(`${m.name}: ${m.text}`)
  })
  return { ws, got }
}

const jeff = mk('Jeff', WANT)
await new Promise(r => setTimeout(r, 700))
const maddie = mk('Maddie', null)
await new Promise(r => setTimeout(r, 700))
maddie.ws.send(JSON.stringify({ type: 'pos', x: 12.3, y: 4.5, angle: 1.1 }))
await new Promise(r => setTimeout(r, 400))
maddie.ws.send(JSON.stringify({ type: 'chat', text: 'hi jeff!' }))
await new Promise(r => setTimeout(r, 1500))

const checks = {
  // THE ONE THAT MATTERED. The old script only checked the two clients agreed
  // with each other — which passed while every online game was Math.random().
  // "Both got the same number" is true of any shared random value.
  seed_is_what_jeff_requested: jeff.got.welcome === WANT,
  maddie_inherited_jeffs_world: maddie.got.welcome === WANT,
  roomId_echoed: jeff.got.roomId === ROOM,
  jeff_got_player_updates: jeff.got.players > 0,
  jeff_saw_maddie_join: jeff.got.joined.includes('Maddie'),
  jeff_received_chat: jeff.got.chat.length > 0,
}

console.log(JSON.stringify({
  room: ROOM,
  requested: WANT,
  jeff_worldSeed: jeff.got.welcome,
  maddie_worldSeed: maddie.got.welcome,
  ...checks,
}, null, 1))

jeff.ws.close(); maddie.ws.close()
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
if (failed.length) { console.error('FAILED:', failed.join(', ')); process.exit(1) }
console.log('ALL PASS')
process.exit(0)
