// validate-world.mjs — the "tested adaptation" gate for the wish pipeline.
//
// A granted wish rewrites src/renderer/world.json. Before that can ship to
// players, this asserts the file is structurally sound: it merges cleanly over
// DEFAULT_CONFIG (mirroring loadConfig) and every level still builds on top of
// it. Exits non-zero with a reason if anything is off. Run:  node tools/validate-world.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { levelConfig, levelCount } from '../src/renderer/levels.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const path = join(__dirname, '..', 'src', 'renderer', 'world.json')

function fail(msg) { console.error('world.json REJECTED: ' + msg); process.exit(1) }

let raw
try { raw = JSON.parse(readFileSync(path, 'utf8')) }
catch (e) { fail('not valid JSON — ' + e.message) }

if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('must be a JSON object')

// merge the way the game does (loadConfig spreads world.json over DEFAULT_CONFIG)
const cfg = { ...DEFAULT_CONFIG, ...raw }

const isHex = s => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s)
const isNum = n => typeof n === 'number' && Number.isFinite(n)

// only wish-editable keys are checked; missing keys fall back to DEFAULT_CONFIG and are fine
if (raw.palette !== undefined) {
  const p = cfg.palette
  if (!p || !['wall', 'ceiling', 'floor', 'fog'].every(k => isHex(p[k]))) fail('palette needs wall/ceiling/floor/fog as #rrggbb hex')
}
if (raw.fogDistance !== undefined && !(isNum(cfg.fogDistance) && cfg.fogDistance > 0)) fail('fogDistance must be a positive number')
if (raw.wallDensity !== undefined && !(isNum(cfg.wallDensity) && cfg.wallDensity > 0 && cfg.wallDensity < 1)) fail('wallDensity must be between 0 and 1')
if (raw.flicker !== undefined && !(cfg.flicker && isNum(cfg.flicker.rate) && isNum(cfg.flicker.depth) && isNum(cfg.flicker.recoverySpeed))) fail('flicker needs numeric rate/depth/recoverySpeed')
if (raw.messages !== undefined && !(Array.isArray(cfg.messages) && cfg.messages.length && cfg.messages.every(m => typeof m === 'string'))) fail('messages must be a non-empty array of strings')
if (raw.items !== undefined && !(cfg.items && Array.isArray(cfg.items.types) && cfg.items.types.length)) fail('items.types must be a non-empty array')

// every level must still build on the drifted base without throwing
try {
  for (let i = 0; i < levelCount(); i++) {
    const c = levelConfig(cfg, i)
    if (!c.palette || !c.exit || typeof c.levelName !== 'string') fail('level ' + i + ' did not build cleanly')
  }
} catch (e) { fail('a level failed to build over the drifted world — ' + e.message) }

console.log('world.json OK — merges cleanly and all levels build.')
