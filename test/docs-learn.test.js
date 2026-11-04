// The docs follow M19, the things that learn your habits: the manual's "what they all do" and the README's "the things" say, in plain
// words, that a floor learns the way you keep getting away, what each refinement does, that the game says so once, that another way
// still works, and that it is solo only (the README's multiplayer list says so too). The one line the plan wrote is imported, so a change
// to it turns this red until the docs follow; the other three are the owner's to voice, and the docs do not quote them.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { LEARN, LEARN_LINES } from '../src/renderer/learn.js'

const root = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const readme = read('README.md'), manual = read('docs/manual.html')
const things = manual.slice(manual.indexOf('<h3>What they all do</h3>'), manual.indexOf('<div class="beasts">'))
const readmeThings = readme.slice(readme.indexOf('## the things'), readme.indexOf('## the fight'))
const readmeOnline = readme.slice(readme.indexOf('## multiplayer'), readme.indexOf('### invite links'))
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six']

describe('the manual: they learn your habits', () => {
  const li = things.slice(things.indexOf('<li><b>They learn your habits.</b>'), things.indexOf('</li>', things.indexOf('<li><b>They learn your habits.</b>')))
  it('is one of what they all do, after they hunt movement', () => {
    expect(li.length).toBeGreaterThan(0)
    expect(things.indexOf('<b>They hunt movement.</b>')).toBeLessThan(things.indexOf('<b>They learn your habits.</b>'))
  })
  it('says the count, the four ways, the floor, the run, the four refinements, the line once, another way, and alone only', () => {
    expect(li).toContain(`the same way ${WORDS[LEARN.after]} times on one floor`)
    for (const w of ['standing still', 'a ward', 'running', 'the flash']) expect(li).toContain(w)
    expect(li).toContain('every thing on that floor changes against it for the rest of the run')
    expect(li).toContain(`it waits longer where it lost you: <i>${LEARN_LINES.still}</i>`)
    expect(li).toContain('it keeps going the way you were heading')
    expect(li).toContain('Against a ward or the flash, it recovers sooner')
    expect(li).toContain('The building says so once for each')
    expect(li).toContain('Get away some other way and it works as it always did')
    expect(li).toContain('Only alone: the things in a room never learn')
    for (const m of ['ward', 'run', 'flash']) expect(li).not.toContain(LEARN_LINES[m])   // the owner's voice pass, not quoted yet
  })
})

describe('the README: they learn your habits', () => {
  it('the things say it in the same plain words, lowercase', () => {
    const p = readmeThings.slice(readmeThings.indexOf('**they learn your habits.**'))
    expect(p.length).toBeGreaterThan(0)
    expect(p).toContain(`get away the same way ${WORDS[LEARN.after]} times on one floor`)
    expect(p).toContain(`against stillness it waits longer where it lost you (*${LEARN_LINES.still}*)`)
    expect(p).toContain('against running it keeps going the way you were heading')
    expect(p).toContain('against a ward or the flash it recovers sooner')
    expect(p).toContain('get away some other way and it works as it always did')
    expect(p).toContain('only alone: the things in a room never learn.')
  })
  it('the multiplayer list says a room\'s things do not learn', () => {
    expect(readmeOnline).toContain('- the things in a room do not learn your habits; only a solo run\'s floors remember how you got away.')
  })
})
