import { describe, it, expect } from 'vitest'
import { LEVELS, levelConfig, levelCount, LOST_LINE } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { createFixedMap } from '../src/renderer/fixedmap.js'
import { NULL_MAP } from '../src/renderer/level-null-map.js'

describe('levels', () => {
  it('defines the four descent levels plus Level ∅', () => {
    expect(levelCount()).toBe(5)
    expect(LEVELS.map(l => l.id)).toEqual([0, 1, 2, 3, '∅'])
  })

  it('level 0 (the lobby) has entities disabled', () => {
    expect(levelConfig(DEFAULT_CONFIG, 0).entities.enabled).toBe(false)
  })

  it('levels 1-3 enable entities, getting harsher with depth', () => {
    const l1 = levelConfig(DEFAULT_CONFIG, 1).entities
    const l3 = levelConfig(DEFAULT_CONFIG, 3).entities
    expect(l1.enabled).toBe(true)
    expect(l3.enabled).toBe(true)
    expect(l3.damage).toBeGreaterThan(l1.damage)          // deeper hits harder
    expect(l3.spawnDenom).toBeLessThan(l1.spawnDenom)      // deeper spawns more
  })

  it('exits chain 0→1→2→3→0, and ∅ falls one-way into the lobby', () => {
    expect(levelConfig(DEFAULT_CONFIG, 0).exit.target).toBe(1)
    expect(levelConfig(DEFAULT_CONFIG, 1).exit.target).toBe(2)
    expect(levelConfig(DEFAULT_CONFIG, 2).exit.target).toBe(3)
    expect(levelConfig(DEFAULT_CONFIG, 3).exit.target).toBe(0)
    expect(levelConfig(DEFAULT_CONFIG, 4).exit.target).toBe(0)   // ∅ → the lobby
    // nothing in the ring targets ∅ — it stays a one-time entrance outside the loop
    expect(LEVELS.slice(0, 4).every(l => l.config.exit.target !== 4 && l.config.exit.target !== '∅')).toBe(true)
  })

  it('every level carries a descent hint and a name', () => {
    for (let i = 0; i < levelCount(); i++) {
      const c = levelConfig(DEFAULT_CONFIG, i)
      expect(typeof c.levelName).toBe('string')
      expect(c.exit.hint.length).toBeGreaterThan(10)
    }
  })

  it('each level has a distinct maze salt and palette', () => {
    const salts = LEVELS.map((_, i) => levelConfig(DEFAULT_CONFIG, i).maze.salt)
    expect(new Set(salts).size).toBe(5)
    const walls = LEVELS.map((_, i) => levelConfig(DEFAULT_CONFIG, i).palette.wall)
    expect(new Set(walls).size).toBe(5)
  })

  it('merges partial config over the base (keeps base keys it does not override)', () => {
    const c = levelConfig(DEFAULT_CONFIG, 1)
    expect(c.messageInterval).toEqual(DEFAULT_CONFIG.messageInterval) // untouched base key
    expect(c.palette.wall).not.toBe(DEFAULT_CONFIG.palette.wall)      // overridden
  })

  it('ships a dress denom per level: 2, 2, 3, 3 and 0 for ∅; levelConfig merges dress', () => {
    expect(LEVELS.map(l => l.config.dress)).toEqual([{ denom: 2 }, { denom: 2 }, { denom: 3 }, { denom: 3 }, { denom: 0 }])
    expect([0, 1, 2, 3, 4].map(i => levelConfig(DEFAULT_CONFIG, i).dress.denom)).toEqual([2, 2, 3, 3, 0])
    // DEFAULT_CONFIG stays untouched: no dress key, and absence merges to {} (which the pass reads as 0)
    expect('dress' in DEFAULT_CONFIG).toBe(false)
    expect(levelConfig({}, 0).dress).toEqual({ denom: 2 })
    expect(levelConfig({ dress: { denom: 9, extra: 1 } }, 1).dress).toEqual({ denom: 2, extra: 1 })   // the level's denom wins, base keys kept
  })

  it('ships a haunts denom per level: 14, 8, 8, 8 and 0 for ∅; levelConfig merges haunts', () => {
    expect(LEVELS.map(l => l.config.haunts)).toEqual([{ denom: 14 }, { denom: 8 }, { denom: 8 }, { denom: 8 }, { denom: 0 }])
    expect([0, 1, 2, 3, 4].map(i => levelConfig(DEFAULT_CONFIG, i).haunts.denom)).toEqual([14, 8, 8, 8, 0])
    // DEFAULT_CONFIG stays untouched: no haunts key, and absence merges to {} (which the pass reads as 0)
    expect('haunts' in DEFAULT_CONFIG).toBe(false)
    expect(levelConfig({}, 0).haunts).toEqual({ denom: 14 })
    expect(levelConfig({ haunts: { denom: 9, extra: 1 } }, 1).haunts).toEqual({ denom: 8, extra: 1 })   // the level's denom wins, base keys kept
  })

  it('addresses ∅ at index 4 and wraps past it', () => {
    expect(levelConfig(DEFAULT_CONFIG, 4).levelIndex).toBe('∅')   // ∅ is index 4
    expect(levelConfig(DEFAULT_CONFIG, 5).levelIndex).toBe(0)     // wraps back to the lobby
    expect(levelConfig(DEFAULT_CONFIG, -1).levelIndex).toBe('∅')  // -1 wraps to the last (∅)
  })

  // T1-5 / T1-2 / T1-7: twelve murmurs a floor, the lost line out of the draw, the lobby's sub-line, L2's wanderers
  it('levels 0-3 murmur from twelve distinct lines each, lowercase, no exclamation marks', () => {
    for (const i of [0, 1, 2, 3]) {
      const m = LEVELS[i].config.messages
      expect(m, `L${i}`).toHaveLength(12)
      expect(new Set(m).size, `L${i}`).toBe(12)
      for (const l of m) { expect(l).toBe(l.toLowerCase()); expect(l).not.toContain('!'); expect(l.at(-1)).toBe('.') }
    }
  })

  it('keeps every old murmur but the lost line, and adds the new ones without digits', () => {
    const NEW = {
      0: ['somewhere a printer is warming up. nobody sent anything.', 'the carpet is wetter here. you did not see where it starts.',
        'a ceiling tile is missing. the dark above it is very tidy.', 'every room has been tidied by someone who did not stay.',
        'you keep almost recognising the corners.', 'one of the lights is a different white.'],
      1: ['a charging cable, plugged into nothing, still warm.', 'tyre marks lead into a wall and stop.',
        'someone has labelled the pillars. no two labels are in the same hand.', 'the cold comes up through your shoes.',
        'a pallet of water bottles. every one has been opened and closed again.', 'far off, a roller door goes up. it does not come down.'],
      2: ['a pressure gauge, its needle resting past the end of the dial.', 'the pipes are warm on one side only.',
        'someone chalked an arrow on the pipe. it points into the pipe.', 'the drips keep a rhythm that is almost your walk.',
        'a valve wheel, chained shut. the chain is newer than the valve.', 'the steam smells faintly of almonds.', 'the pipes knock, then wait for an answer.'],
      3: ['the cables run into the floor and do not come out anywhere.', 'a warning sign. the warning has been sanded off.',
        'your light flickers in time with something behind the panels.', 'every transformer is a slightly different note.',
        'the hair on your arms stands up near the cabinets.', 'a breaker panel with every label torn away.', 'the dark here is warm, like a room someone just left.'],
    }
    const OLD = {
      0: ['the wallpaper is the same in every direction.', 'the carpet is damp.', 'the lights do not turn off.', 'you have been walking for hours. days. weeks.',
        'the humming never stops.', 'level 0. somewhere. always.'],
      1: ['the concrete sweats.', 'a shopping cart, alone, a mile from anywhere.', 'you are not the only thing awake here.', 'the lights buzz, then stop, then buzz.',
        'something followed you in from the lobby.', 'level 1. it is bigger than it looks.'],
      2: ['the pipes tick as they cool. or fill.', 'steam, from somewhere. it is warm and wrong.', 'do not follow the sound of running water.', 'the dark here has weight.',
        'level 2. bring your own light.'],
      3: ['everything here is live. do not touch the walls.', 'the current hums a note you can feel in your teeth.', 'something with too many joints is in here with you.',
        'the way up is here. somewhere. find the humming door.', 'level 3. the deepest you should go.'],
    }
    for (const i of [0, 1, 2, 3]) {
      expect(LEVELS[i].config.messages, `L${i}`).toEqual([...OLD[i], ...NEW[i]])
      for (const l of NEW[i]) expect(l).not.toMatch(/[0-9]/)
    }
    // 'it followed you down.' keeps its slot: game.js swaps the hint, the floor murmur stays
    expect(LEVELS[1].config.messages).toContain('something followed you in from the lobby.')
  })

  it('LOST_LINE is the setting\'s line, kept for its conditional and out of every murmur pool', () => {
    expect(LOST_LINE).toBe('there is no exit. keep looking.')
    for (let i = 0; i < levelCount(); i++) expect(levelConfig(DEFAULT_CONFIG, i).messages).not.toContain(LOST_LINE)
  })

  it("the lobby's sub-line drops its contradiction; the other floors keep theirs", () => {
    expect(LEVELS[0].sub).toBe('the hum of fluorescent light. damp carpet. you are here.')
    expect(levelConfig(DEFAULT_CONFIG, 0).levelSub).toBe('the hum of fluorescent light. damp carpet. you are here.')
    expect(LEVELS.slice(1).map((l) => l.sub)).toEqual([
      'concrete and dim service lights. something moved in the warehouse dark.',
      'endless maintenance tunnels. steam, rust, and the dark between the pipes.',
      'transformers hum with current in the black. one door leads back up.',
      'harlem park, west baltimore. a plan cleared the street out of the block and left this.',
    ])
  })

  it('L2 is not a floor of sleepers: its wanderers are the crawler and the watcher; the other floors are untouched', () => {
    expect(LEVELS[2].config.entities.wandererVariants).toEqual(['crawler', 'watcher'])
    expect(levelConfig(DEFAULT_CONFIG, 2).entities.wandererVariants).toEqual(['crawler', 'watcher'])
    expect(LEVELS[2].config.entities.stalkerVariants).toEqual(['lurker', 'hound'])
    expect(LEVELS[1].config.entities.wandererVariants).toEqual(['watcher'])
    expect(LEVELS[3].config.entities.wandererVariants).toEqual(['watcher'])
  })

  it('∅ keeps its seven lines (the hold)', () => {
    expect(LEVELS[4].config.messages).toHaveLength(7)
    expect(LEVELS[4].config.messages[0]).toBe('a form was left on the counter. someone started filling it out. they got bored.')
  })

  it('∅ carries the one authored note (the form on the counter) on open ground; levels 0-3 carry none', () => {
    expect(levelConfig(DEFAULT_CONFIG, 4).notes).toEqual([{ x: 6.5, y: 6.5 }])
    for (const i of [0, 1, 2, 3]) expect(levelConfig(DEFAULT_CONFIG, i).notes).toBeUndefined()
    expect('notes' in DEFAULT_CONFIG).toBe(false)
    const fm = createFixedMap(NULL_MAP)
    expect(fm.isWall(6.5, 6.5)).toBe(false)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) expect(fm.isWall(6.5 + dx, 6.5 + dy)).toBe(false)
  })
})
