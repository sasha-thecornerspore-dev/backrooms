// ascii.mjs — print the 3x3 chunks round a floor's origin for one tree: props (p), dressed (D), exits (E), stairs (^), items (i), scraps (s),
// machines (m), sights (V), souls (n), haunts (h), creatures (c), spawn (@).
//
//   node tools/pacing/ascii.mjs [--src <tree>/src/renderer] [--level 0..3] [--seed N|null]
import { loadTree, parseArgs } from './lib.mjs'
const { val } = parseArgs(process.argv.slice(2), ['src', 'level', 'seed'])
const T = await loadTree(val.src)
const lv = Number(val.level ?? 0), seed = val.seed === undefined || val.seed === 'null' ? null : Number(val.seed)
const f = T.buildFloor(lv, seed, { cx: 0, cy: 0 }, { fresh: lv === 0 && seed === null })
f.entitySys.update(0, { x: f.spawn.x, y: f.spawn.y, angle: 0 }, 0, 0, 1)
const marks = new Map(); const put = (x, y, ch) => marks.set(`${Math.floor(x)},${Math.floor(y)}`, ch)
for (const p of f.decor.getProps()) put(p.x, p.y, /:d\d/.test(String(p.key)) ? 'D' : 'p')
for (const e of f.itemSys.getWorldItems()) put(e.x, e.y, 'i')
for (const e of f.decor.getScraps()) put(e.x, e.y, 's')
for (const e of f.decor.getMachines()) put(e.x, e.y, 'm')
for (const e of f.decor.getSights()) put(e.x, e.y, 'V')
for (const e of f.decor.getNpcs()) put(e.x, e.y, 'n')
for (const e of f.decor.getKind('haunt')) put(e.x, e.y, 'h')
for (const e of f.decor.getStairs()) put(e.x, e.y, '^')
for (const e of f.decor.getExits()) put(e.x, e.y, 'E')
for (const e of f.entitySys.getEntities()) put(e.x, e.y, 'c')
put(f.spawn.x, f.spawn.y, '@')
const C = T.CHUNK
for (let y = -C; y < 2 * C; y++) {
  let row = String(y).padStart(4) + ' '
  for (let x = -C; x < 2 * C; x++) row += marks.get(`${x},${y}`) ?? (f.grid.floor(x, y) ? '.' : '#')
  console.log(row)
}
