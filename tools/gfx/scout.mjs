// scout.mjs — print an ASCII map of a level region so scene poses can be chosen by eye.
//
//   node tools/gfx/scout.mjs --src <src/renderer dir> --level 0 [--seed 1337] [--cx 11 --cy 11] [--r 24]
//
// '#' wall, '.' floor, digits/letters are decor: e exit, n npc, s scrap, m machine, V sight,
// p prop, i item, E enemy, @ the (cx,cy) probe point. Coordinates on the axes are world cells.
// Pure Node: the renderer's data modules are import-safe, only renderer.js needs a DOM.
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => {
  if (v.startsWith('--')) a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true])
  return a
}, []))
if (!args.src) { console.error('usage: node tools/gfx/scout.mjs --src <src/renderer> --level N [--seed S] [--cx X --cy Y] [--r R]'); process.exit(2) }
const src = pathToFileURL(path.resolve(args.src) + path.sep).href
const imp = (f) => import(new URL(f, src).href)
const { DEFAULT_CONFIG, createChunkCache, CHUNK_SIZE } = await imp('world.js')
const { levelConfig, LEVELS } = await imp('levels.js')
const { createFixedMap } = await imp('fixedmap.js')
const { createDecorSystem } = await imp('decor.js')
const { createEntitySystem } = await imp('entities.js')

const level = args.level === '∅' || args.level === 'null' ? 4 : Number(args.level ?? 0)
const seed = args.seed === undefined ? 0 : Number(args.seed)
const cfg = levelConfig(DEFAULT_CONFIG, level)
const cache = cfg.map ? createFixedMap(cfg.map) : createChunkCache(cfg, seed)
cache.preload(0, 0)
const cx = Number(args.cx ?? (cfg.spawn?.x ?? CHUNK_SIZE / 2 + 0.5))
const cy = Number(args.cy ?? (cfg.spawn?.y ?? CHUNK_SIZE / 2 + 0.5))
const R = Number(args.r ?? 24)
const isWall = (x, y) => cache.isWall(x, y, Math.floor(cx / CHUNK_SIZE), Math.floor(cy / CHUNK_SIZE))
const decor = createDecorSystem(cfg, isWall, seed)
decor.enterLevel(cfg)
const pcx = Math.floor(cx / CHUNK_SIZE), pcy = Math.floor(cy / CHUNK_SIZE)
decor.update(pcx, pcy)
const esys = createEntitySystem(cfg, isWall)
esys.update(0, { x: cx, y: cy }, pcx, pcy, 1)

const marks = new Map()
const put = (x, y, ch) => marks.set(`${Math.floor(x)},${Math.floor(y)}`, ch)
for (const p of decor.getProps()) put(p.x, p.y, 'p')
for (const e of decor.getExits()) put(e.x, e.y, 'e')
for (const n of decor.getNpcs()) put(n.x, n.y, 'n')
for (const s of decor.getScraps()) put(s.x, s.y, 's')
for (const m of decor.getMachines()) put(m.x, m.y, 'm')
for (const s of decor.getSights()) put(s.x, s.y, 'V')
for (const e of esys.getEntities()) put(e.x, e.y, 'E')
put(cx, cy, '@')

const x0 = Math.floor(cx - R), x1 = Math.floor(cx + R), y0 = Math.floor(cy - R), y1 = Math.floor(cy + R)
// x axis: the world x of every 10th column, written out (e.g. -10, 0, 10, 20)
const axis = Array(x1 - x0 + 1).fill(' ')
for (let x = Math.ceil(x0 / 10) * 10; x <= x1; x += 10) String(x).split('').forEach((ch, k) => { if (x - x0 + k < axis.length) axis[x - x0 + k] = ch })
console.log(`level ${cfg.levelName} seed ${seed} centre ${cx},${cy}\n` + '      ' + axis.join(''))
for (let y = y0; y <= y1; y++) {
  let row = String(y).padStart(5) + ' '
  for (let x = x0; x <= x1; x++) row += marks.get(`${x},${y}`) ?? (isWall(x + 0.5, y + 0.5) ? '#' : '.')
  console.log(row)
}
console.log('\nprops:', decor.getProps().filter(p => Math.abs(p.x - cx) <= R && Math.abs(p.y - cy) <= R).map(p => `${p.type}@${p.x},${p.y}`).join(' '))
console.log('enemies:', esys.getEntities().map(e => `${e.variant}/${e.type}@${e.x.toFixed(2)},${e.y.toFixed(2)}`).join(' '))
console.log('exits:', decor.getExits().map(e => `@${e.x},${e.y}`).join(' '), ' notes:', decor.getScraps().map(e => `@${e.x},${e.y}`).join(' '),
  ' machines:', decor.getMachines().map(e => `@${e.x},${e.y}`).join(' '), ' sights:', decor.getSights().map(e => `${e.type}@${e.x},${e.y}`).join(' '))
