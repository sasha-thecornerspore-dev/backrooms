let actx, humGain, humOsc, ambienceGain
let ambienceOn  = true   // the toggle
let ambienceVol = 1      // the volume scale (1 == 100%, the historic level)
let humBase  = 120       // the hum's base pitch (config.audio.humFrequency), kept by initAudio: setFlicker dips from it
let noiseBuf = null      // one second of white noise, built once by initAudio: every step, page, hiss, pant and rasp plays a slice of it

const PEAK_CAP = 0.06    // the loudest the pulse's small sounds (and the hum, through setHum) may ever be, at the bus
const NOISE_S  = 1       // the shared noise, s
const HUM_GAIN = 0.018   // the hum's level; setHum's gainMul multiplies it
const cap = (v) => (v > PEAK_CAP ? PEAK_CAP : v)

export function initAudio(config) {
  try {
    actx = new AudioContext()

    // Ambience bus — hum, drone and distant events route through here so the
    // whole environmental layer can be toggled independently of the music.
    ambienceGain = actx.createGain()
    ambienceGain.gain.value = 1
    ambienceGain.connect(actx.destination)

    // the shared noise: your steps land 2-4 times a second on a phone, so no noise recipe below allocates its own
    noiseBuf = actx.createBuffer(1, actx.sampleRate * NOISE_S, actx.sampleRate)
    const nd = noiseBuf.getChannelData(0)
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1

    // Fluorescent hum
    humBase = config.audio.humFrequency
    humOsc  = actx.createOscillator()
    humGain = actx.createGain()
    const humFilter = actx.createBiquadFilter()
    humFilter.type = 'lowpass'
    humFilter.frequency.value = 400
    humOsc.type = 'sawtooth'
    humOsc.frequency.value = humBase
    humGain.gain.value = HUM_GAIN
    humOsc.connect(humFilter)
    humFilter.connect(humGain)
    humGain.connect(ambienceGain)
    humOsc.start()

    // Low drone
    const drone     = actx.createOscillator()
    const droneGain = actx.createGain()
    drone.type = 'sine'
    drone.frequency.value = config.audio.droneFrequency
    droneGain.gain.value  = 0.022
    drone.connect(droneGain)
    droneGain.connect(ambienceGain)
    drone.start()

    scheduleDistant(config)
  } catch (e) {
    // Web Audio unavailable — silent fallback
  }
}

export function setFlicker(intensity) {
  if (!humOsc || !actx) return
  // Hum pitch drops slightly during flicker (from the configured base; setHum's glide rides on the detune, so this never undoes it)
  humOsc.frequency.setTargetAtTime(
    humBase * (0.85 + intensity * 0.15),
    actx.currentTime,
    0.05
  )
}

// ── radio — a warbling music-box loop from somewhere that isn't here ──
const RADIO_NOTES = [220, 174.6, 196, 146.8, 220, 261.6, 196, 130.8]
let radioTimer = null
let radioStep = 0

export function setRadio(on) {
  if (!actx) return
  if (on && !radioTimer) {
    radioStep = 0
    radioTimer = setInterval(() => {
      try {
        const osc  = actx.createOscillator()
        const gain = actx.createGain()
        const filt = actx.createBiquadFilter()
        filt.type = 'bandpass'
        filt.frequency.value = 900
        filt.Q.value = 1.2
        osc.type = 'triangle'
        // detuned — the tune is almost right
        osc.frequency.value = RADIO_NOTES[radioStep % RADIO_NOTES.length] * (1 + (Math.random() - 0.5) * 0.02)
        gain.gain.setValueAtTime(0, actx.currentTime)
        gain.gain.linearRampToValueAtTime(0.03, actx.currentTime + 0.04)
        gain.gain.linearRampToValueAtTime(0, actx.currentTime + 0.42)
        osc.connect(filt); filt.connect(gain); gain.connect(actx.destination)
        osc.start()
        osc.stop(actx.currentTime + 0.5)
        radioStep++
      } catch { /* ignore */ }
    }, 480)
  } else if (!on && radioTimer) {
    clearInterval(radioTimer)
    radioTimer = null
  }
}

// ── generative weirdcore music ────────────────────────────────────────────
// No files, no loops — a self-generating ambient bed. Detuned breathing pads
// under a "wrong" music-box melody drawn from a per-level scale, washed through
// a generated reverb with tape wow/flutter, a drifting low-pass, and the odd
// pitch-drop. It never repeats and never ends; each level sets its own mood.

// Pure helper (unit-tested): frequency of a scale degree above a root, in Hz.
// Degrees beyond the scale length wrap up through the octaves.
export function scaleFrequency(root, scale, degree, octave = 0) {
  const n = scale.length
  const idx = ((degree % n) + n) % n
  const wraps = Math.floor(degree / n)
  const semis = scale[idx] + 12 * (octave + wraps)
  return root * Math.pow(2, semis / 12)
}

let music = null

function buildReverb(seconds = 3.2, decay = 2.6) {
  const rate = actx.sampleRate
  const len = Math.floor(rate * seconds)
  const buf = actx.createBuffer(2, len, rate)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay)
  }
  const conv = actx.createConvolver()
  conv.buffer = buf
  return conv
}

function initMusic() {
  if (!actx || music) return
  const master = actx.createGain(); master.gain.value = 0        // faded in by setMusic
  const reverb = buildReverb()
  const wet = actx.createGain(); wet.gain.value = 0.5
  const dry = actx.createGain(); dry.gain.value = 0.62
  const bus = actx.createBiquadFilter(); bus.type = 'lowpass'; bus.frequency.value = 1200; bus.Q.value = 0.4
  bus.connect(dry); bus.connect(reverb)
  reverb.connect(wet); wet.connect(master); dry.connect(master)
  master.connect(actx.destination)

  // three sustained pad voices — the chord
  const pad = [0, 1, 2].map(() => {
    const o = actx.createOscillator(); o.type = 'triangle'
    const g = actx.createGain(); g.gain.value = 0
    o.connect(g); g.connect(bus); o.start()
    return { o, g }
  })

  // bass voice — the chord root an octave down, giving the music a floor
  const bassOsc = actx.createOscillator(); bassOsc.type = 'triangle'
  const bassGain = actx.createGain(); bassGain.gain.value = 0
  bassOsc.connect(bassGain); bassGain.connect(bus); bassOsc.start()

  // tape wow/flutter — a slow LFO nudging every pad voice's detune
  const flutter = actx.createOscillator(); flutter.type = 'sine'; flutter.frequency.value = 0.17
  const flutterAmt = actx.createGain(); flutterAmt.gain.value = 6   // cents
  flutter.connect(flutterAmt); pad.forEach(p => flutterAmt.connect(p.o.detune)); flutter.start()

  // slow filter drift — the muffled dream tide
  const drift = actx.createOscillator(); drift.type = 'sine'; drift.frequency.value = 0.045
  const driftAmt = actx.createGain(); driftAmt.gain.value = 300
  drift.connect(driftAmt); driftAmt.connect(bus.frequency); drift.start()

  // one short noise buffer reused by every hi-hat tick (cheap percussion)
  const noiseBuf = actx.createBuffer(1, Math.floor(actx.sampleRate * 0.1), actx.sampleRate)
  const nd = noiseBuf.getChannelData(0)
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1

  music = { master, bus, pad, bass: bassOsc, bassGain, noiseBuf, mood: null, enabled: true,
            volScale: 1, beatTimer: null, beat: 0, chordTones: [0, 2, 4], trackIdx: 0, chordInTrack: 0 }
}

// Soft percussion routed dry to the master (bypasses the muffle bus) so the beat
// has punch without washing out. Only fires when a mood sets `groove` > 0.
function kick(gain) {
  try {
    const o = actx.createOscillator(), g = actx.createGain()
    o.type = 'sine'
    const t = actx.currentTime
    o.frequency.setValueAtTime(115, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.09 * gain, t + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.18)
    o.connect(g); g.connect(music.master)
    o.start(t); o.stop(t + 0.2)
  } catch { /* ignore */ }
}
function hat(gain) {
  try {
    const src = actx.createBufferSource(); src.buffer = music.noiseBuf
    const hp = actx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6500
    const g = actx.createGain()
    const t = actx.currentTime
    g.gain.setValueAtTime(0.02 * gain, t); g.gain.exponentialRampToValueAtTime(0.0004, t + 0.05)
    src.connect(hp); hp.connect(g); g.connect(music.master)
    src.start(t); src.stop(t + 0.06)
  } catch { /* ignore */ }
}

// Move pads + bass to the next chord of the progression (a triad stacked within
// the scale). Glides rather than jumps.
function goToChord(rootDeg) {
  const m = music, mood = m.mood
  m.chordTones = [rootDeg, rootDeg + 2, rootDeg + 4]
  const t = actx.currentTime
  m.pad.forEach((p, i) => {
    const f = scaleFrequency(mood.root, mood.scale, m.chordTones[i]) * (1 + (Math.random() - 0.5) * 0.004)
    p.o.frequency.setTargetAtTime(f, t, 0.7)
    p.g.gain.setTargetAtTime(0.013, t, 1.0)
  })
  m.bass.frequency.setTargetAtTime(scaleFrequency(mood.root, mood.scale, rootDeg, -1), t, 0.25)
  m.bassGain.gain.setTargetAtTime(0.06, t, 0.4)
}

// A single soft plucked note (used for the arpeggio and the lead melody).
function playPluck(freq, peak, len, bendProb) {
  try {
    const o = actx.createOscillator(), g = actx.createGain()
    o.type = Math.random() < 0.5 ? 'triangle' : 'sine'
    const t = actx.currentTime
    o.frequency.setValueAtTime(freq, t)
    if (bendProb && Math.random() < bendProb) o.frequency.exponentialRampToValueAtTime(freq * 0.5, t + len)
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(peak, t + 0.015)
    g.gain.exponentialRampToValueAtTime(0.0006, t + len)
    o.connect(g); g.connect(music.bus)
    o.start(t); o.stop(t + len + 0.05)
  } catch { /* ignore */ }
}

// One beat: advance the chord on the bar line, ripple an arpeggio up the current
// chord, and occasionally drop a higher lead note. This is what makes it read as
// music instead of random tones.
function onBeat() {
  const m = music, mood = m.mood
  if (!m.enabled) { m.beat++; return }

  // On each bar line, move to the next chord — and when the current progression
  // finishes, roll to the next "track" so a level cycles a few different tunes.
  const bpc = mood.beatsPerChord ?? 8
  if (m.beat % bpc === 0) {
    const progs = (mood.progressions && mood.progressions.length) ? mood.progressions
                : [mood.progression && mood.progression.length ? mood.progression : [0]]
    let prog = progs[m.trackIdx % progs.length]
    if (m.chordInTrack >= prog.length) {
      m.trackIdx = (m.trackIdx + 1) % progs.length
      m.chordInTrack = 0
      prog = progs[m.trackIdx % progs.length]
    }
    goToChord(prog[m.chordInTrack % prog.length])
    m.chordInTrack++
  }

  // arpeggio — ripples up the current chord across two octaves
  const tones = m.chordTones
  const idx = m.beat % (tones.length * 2)
  const tone = tones[idx % tones.length]
  const oct = 1 + (idx >= tones.length ? 1 : 0)
  const af = scaleFrequency(mood.root, mood.scale, tone, oct) * (1 + (Math.random() - 0.5) * (mood.wobble ?? 0.006))
  playPluck(af, 0.03, mood.arpLen ?? 0.55, 0)

  // occasional lead — the one voice allowed to bend "wrong"
  if (m.beat % 4 === 2 && Math.random() < (mood.leadChance ?? 0.35)) {
    const lt = tones[(Math.random() * tones.length) | 0] + (Math.random() < 0.5 ? 1 : 0)
    const lf = scaleFrequency(mood.root, mood.scale, lt, 2) * (1 + (Math.random() - 0.5) * (mood.wobble ?? 0.008))
    playPluck(lf, 0.04, mood.noteLen ?? 1.4, mood.bend ?? 0.12)
  }

  // light beat — kick on the bar (+ backbeat), hats on off-beats
  const groove = mood.groove ?? 0
  if (groove > 0) {
    const bpb = mood.beatsPerBar ?? 4
    const b = m.beat % bpb
    if (b === 0) kick(groove)
    else if (b === (bpb >> 1)) kick(groove * 0.75)
    if (b % 2 === 1) hat(groove)
  }
  m.beat++
}

function restartSchedulers() {
  const mood = music.mood
  clearInterval(music.beatTimer)
  music.beat = 0; music.trackIdx = 0; music.chordInTrack = 0
  onBeat()                                    // start on the downbeat, no dead air
  music.beatTimer = setInterval(onBeat, mood.tempo ?? 440)
}

// Set the level's mood — the engine morphs into it without stopping.
export function setMusic(mood) {
  if (!actx || !mood) return
  initMusic()
  if (!music) return
  music.mood = mood
  if (music.bus) music.bus.frequency.setTargetAtTime(mood.brightness ?? 1200, actx.currentTime, 2)
  music.master.gain.setTargetAtTime(music.enabled ? (mood.volume ?? 0.06) * music.volScale : 0, actx.currentTime, 2.0)
  restartSchedulers()
}

// Patch the live mood IN PLACE (the hunted state, tension.js huntDelta / calmDelta): groove and leadChance are read at the next
// onBeat, brightness and volume ramp the way setMusic's do. The schedulers are never restarted — the song thickens without a
// seam, and takes the same long breath on the way back. Tempo is never one of the keys.
export function setMood(partial) {
  if (!music || !music.mood || !partial) return
  Object.assign(music.mood, partial)
  if (partial.brightness != null && music.bus) music.bus.frequency.setTargetAtTime(partial.brightness, actx.currentTime, 2)
  if (partial.volume != null) music.master.gain.setTargetAtTime(music.enabled ? partial.volume * music.volScale : 0, actx.currentTime, 2.0)
}

export function setMusicEnabled(on) {
  if (!music) return
  music.enabled = on
  const vol = on ? (music.mood?.volume ?? 0.06) * music.volScale : 0
  music.master.gain.setTargetAtTime(vol, actx.currentTime, 0.8)
}

// Scale the music level as a percentage (0–150) of each level's base volume.
export function setMusicVolume(pct) {
  if (!music || !actx) return
  music.volScale = Math.max(0, Math.min(1.5, (pct ?? 100) / 100))
  const vol = music.enabled ? (music.mood?.volume ?? 0.06) * music.volScale : 0
  music.master.gain.setTargetAtTime(vol, actx.currentTime, 0.5)
}

export function toggleMusic() {
  if (!music) return false
  setMusicEnabled(!music.enabled)
  return music.enabled
}

export function isMusicOn() { return !!(music && music.enabled) }

function scheduleDistant(config) {
  if (!actx) return
  const [minS, maxS] = config.audio.distantEventInterval
  const delay = (minS + Math.random() * (maxS - minS)) * 1000
  setTimeout(() => {
    playDistant()
    scheduleDistant(config)
  }, delay)
}

function playDistant() {
  if (!actx) return
  try {
    const osc    = actx.createOscillator()
    const gain   = actx.createGain()
    const filter = actx.createBiquadFilter()
    filter.type            = 'bandpass'
    filter.frequency.value = 150 + Math.random() * 250
    filter.Q.value         = 2.5
    osc.frequency.value    = 60 + Math.random() * 160
    osc.type               = 'sine'
    gain.gain.setValueAtTime(0, actx.currentTime)
    gain.gain.linearRampToValueAtTime(0.035, actx.currentTime + 0.6)
    gain.gain.linearRampToValueAtTime(0,     actx.currentTime + 3.5)
    osc.connect(filter)
    filter.connect(gain)
    gain.connect(ambienceGain || actx.destination)
    osc.start()
    osc.stop(actx.currentTime + 4)
  } catch (e) { /* ignore */ }
}

// The environmental layer (hum / drone / distant events) has two independent
// controls that must compose, not overwrite each other: an on/off toggle and a
// volume scale. Both funnel through here so flipping the toggle can't wipe the
// volume and vice versa.
function applyAmbience() {
  if (!ambienceGain || !actx) return
  ambienceGain.gain.setTargetAtTime(ambienceOn ? ambienceVol : 0, actx.currentTime, 0.5)
}

// Toggle the whole environmental layer (hum / drone / distant events).
export function setAmbience(on) {
  ambienceOn = !!on
  applyAmbience()
}

// Scale the environmental layer as a percentage (0–150) of its base level.
// Mirrors setMusicVolume. 100 == the level it has always played at.
export function setAmbienceVolume(pct) {
  ambienceVol = Math.max(0, Math.min(1.5, (pct ?? 100) / 100))
  applyAmbience()
}

// A low heart-thump — game.js pulses it faster as something closes on you.
export function heartbeat(intensity = 1) {
  if (!actx) return
  try {
    const o = actx.createOscillator(), g = actx.createGain()
    o.type = 'sine'
    const t = actx.currentTime
    o.frequency.setValueAtTime(72, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.14)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.12 * intensity, t + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.22)
    o.connect(g); g.connect(actx.destination)
    o.start(t); o.stop(t + 0.26)
  } catch { /* ignore */ }
}

// A brief, wavering whisper — surfaces when your sanity runs low.
export function whisper() {
  if (!actx) return
  try { whisperInto(actx.destination, 1) } catch { /* ignore */ }
}
// the whisper's graph, into any destination at a gain scale (1 = the sanity whisper; bump('murmur') takes it at half into the ambience bus)
function whisperInto(dest, scale) {
  const dur = 0.6 + Math.random() * 0.5
  const len = Math.floor(actx.sampleRate * dur)
  const buf = actx.createBuffer(1, len, actx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.4)
  const src = actx.createBufferSource(); src.buffer = buf
  const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1100 + Math.random() * 1500; bp.Q.value = 6
  const lfo = actx.createOscillator(); lfo.frequency.value = 6 + Math.random() * 8
  const lg = actx.createGain(); lg.gain.value = 400
  lfo.connect(lg); lg.connect(bp.frequency); lfo.start()
  const g = actx.createGain(); const t = actx.currentTime
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.03 * scale, t + 0.2); g.gain.linearRampToValueAtTime(0, t + dur)
  src.connect(bp); bp.connect(g); g.connect(dest)
  src.start(t); src.stop(t + dur); lfo.stop(t + dur)
}

// A short chirp when a chat message arrives (a UI ping, always audible).
export function blip() {
  if (!actx) return
  try {
    const o = actx.createOscillator(), g = actx.createGain()
    o.type = 'sine'
    const t = actx.currentTime
    o.frequency.setValueAtTime(880, t)
    o.frequency.exponentialRampToValueAtTime(1320, t + 0.05)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.14)
    o.connect(g); g.connect(actx.destination)
    o.start(t); o.stop(t + 0.16)
  } catch { /* ignore */ }
}

// The ward — a low, downward "whump" of force pushing out into the dark.
export function wardPulse() {
  if (!actx) return
  try {
    const t = actx.currentTime
    const o = actx.createOscillator(), g = actx.createGain()
    o.type = 'triangle'
    o.frequency.setValueAtTime(200, t)
    o.frequency.exponentialRampToValueAtTime(48, t + 0.28)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.015)
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.34)
    o.connect(g); g.connect(actx.destination)
    o.start(t); o.stop(t + 0.36)
  } catch { /* ignore */ }
}

// ── ambient-event sounds (Living Atmosphere) — routed through the ambience bus
//    so they respect the environmental volume/toggle ──

// A far door slamming: a low thud plus a short wooden crack.
export function doorSlam() {
  if (!actx) return
  try {
    const dest = ambienceGain || actx.destination
    const t = actx.currentTime
    const o = actx.createOscillator(), g = actx.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(44, t + 0.12)
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.13, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0004, t + 0.3)
    o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.32)
    const len = Math.floor(actx.sampleRate * 0.12)
    const buf = actx.createBuffer(1, len, actx.sampleRate); const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3)
    const src = actx.createBufferSource(); src.buffer = buf
    const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8
    const ng = actx.createGain(); ng.gain.setValueAtTime(0.09, t); ng.gain.exponentialRampToValueAtTime(0.0004, t + 0.12)
    src.connect(bp); bp.connect(ng); ng.connect(dest); src.start(t); src.stop(t + 0.13)
  } catch { /* ignore */ }
}

// A drawer dragged open (game.js, the search hold): 0.3 s of filtered noise — doorSlam's noise half, longer, lower and swelling a
// little as it comes, through the ambience bus. No-op without audio.
export function drawerSlide() {
  if (!actx) return
  try {
    const dest = ambienceGain || actx.destination
    const t = actx.currentTime
    const len = Math.floor(actx.sampleRate * 0.3)
    const buf = actx.createBuffer(1, len, actx.sampleRate); const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.sin((i / len) * Math.PI)
    const src = actx.createBufferSource(); src.buffer = buf
    const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1
    bp.frequency.setValueAtTime(700, t); bp.frequency.linearRampToValueAtTime(1100, t + 0.3)
    const g = actx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06, t + 0.04); g.gain.exponentialRampToValueAtTime(0.0004, t + 0.3)
    src.connect(bp); bp.connect(g); g.connect(dest); src.start(t); src.stop(t + 0.31)
  } catch { /* ignore */ }
}

// A body answering your touch (feedback.js names the kind, game.js gates the calls): 'thud' is the doorSlam sine lower and shorter,
// 'hollow' a triangle for the drums and the machine, 'scrape' the footfall-style noise burst band-passed high, 'wood' one tap for the
// pallet, 'murmur' the whisper at half gain. Routed through the ambience bus; panned when the engine can (createStereoPanner), mono
// otherwise. No-op without audio.
export function bump(kind, intensity = 1, pan = 0) {
  if (!actx) return
  if (kind !== 'thud' && kind !== 'hollow' && kind !== 'scrape' && kind !== 'wood' && kind !== 'murmur') return   // 'silent', or no recipe
  try {
    const k = intensity > 1 ? 1 : intensity < 0 ? 0 : intensity
    const dest = panTo(pan)
    const t = actx.currentTime
    if (kind === 'thud') {
      const o = actx.createOscillator(), g = actx.createGain()
      o.type = 'sine'
      o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.14)
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.10 * k, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0004, t + 0.18)
      o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.2)
    } else if (kind === 'hollow') {
      const o = actx.createOscillator(), g = actx.createGain()
      o.type = 'triangle'
      o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(70, t + 0.2)
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09 * k, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0004, t + 0.25)
      o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.27)
    } else if (kind === 'scrape') {
      scrapeInto(dest, t, 0.07 * k)
    } else if (kind === 'wood') {
      const o = actx.createOscillator(), g = actx.createGain()
      o.type = 'sine'
      o.frequency.setValueAtTime(70, t)
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.08 * k, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0004, t + 0.08)
      o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.1)
    } else if (kind === 'murmur') {
      whisperInto(dest, 0.5)
    }
  } catch { /* ignore */ }
}
// the scrape's graph (bump's 'scrape', and call's: a chair moving somewhere): 0.12 s of noise falling away, band-passed at 900 Hz.
// Its envelope is baked into its own short buffer, so it keeps it rather than slicing the shared noise.
function scrapeInto(dest, t, peak) {
  const len = Math.floor(actx.sampleRate * 0.12)
  const buf = actx.createBuffer(1, len, actx.sampleRate); const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2)
  const src = actx.createBufferSource(); src.buffer = buf
  const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 1.2
  const g = actx.createGain(); g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.0004, t + 0.12)
  src.connect(bp); bp.connect(g); g.connect(dest); src.start(t); src.stop(t + 0.13)
}
// where a bump plays: the ambience bus, through a panner when one is asked for and the engine has them (a centred bump needs none)
function panTo(pan) {
  const bus = ambienceGain || actx.destination
  if (!pan || typeof actx.createStereoPanner !== 'function') return bus
  const p = actx.createStereoPanner()
  p.pan.value = pan < -1 ? -1 : pan > 1 ? 1 : pan
  p.connect(bus)
  return p
}

// Muffled footfalls that aren't yours — a handful of soft low thumps, receding.
export function footfall(steps = 4) {
  if (!actx) return
  try {
    const dest = ambienceGain || actx.destination
    for (let i = 0; i < steps; i++) {
      const t = actx.currentTime + i * (0.32 + Math.random() * 0.06)
      const o = actx.createOscillator(), g = actx.createGain()
      o.type = 'sine'
      o.frequency.setValueAtTime(58 + Math.random() * 10, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.07)
      const peak = 0.05 * (1 - i / (steps + 1))
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0004, t + 0.12)
      o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.14)
    }
  } catch { /* ignore */ }
}

// A whistle in the halls (the roll call, rollcall.js picks the pitch, gain and pan): two sine notes a fourth apart, ~0.4 s, 880 Hz
// raised by `semis`, through the ambience bus and panned like bump. No-op without audio or when there is no gain to give it.
export function whistle(semis = 0, pan = 0, gain = 1) {
  if (!actx || !(gain > 0)) return
  try {
    const k = gain > 1 ? 1 : gain
    const dest = panTo(pan)
    const f1 = 880 * Math.pow(2, semis / 12), f2 = f1 * Math.pow(2, 5 / 12)
    const t = actx.currentTime
    const o1 = actx.createOscillator(), g1 = actx.createGain()
    o1.type = 'sine'
    o1.frequency.setValueAtTime(f1, t)
    g1.gain.setValueAtTime(0.0001, t); g1.gain.exponentialRampToValueAtTime(0.07 * k, t + 0.012); g1.gain.exponentialRampToValueAtTime(0.0004, t + 0.19)
    o1.connect(g1); g1.connect(dest); o1.start(t); o1.stop(t + 0.2)
    const o2 = actx.createOscillator(), g2 = actx.createGain()
    o2.type = 'sine'
    o2.frequency.setValueAtTime(f2, t + 0.17)
    g2.gain.setValueAtTime(0.0001, t + 0.17); g2.gain.exponentialRampToValueAtTime(0.063 * k, t + 0.182); g2.gain.exponentialRampToValueAtTime(0.0004, t + 0.40)
    o2.connect(g2); g2.connect(dest); o2.start(t + 0.17); o2.stop(t + 0.41)
  } catch { /* ignore */ }
}

// The hum stops: duck the whole sound bed (ambience + music) to silence for a
// beat, then restore each to whatever level the player's settings had it at.
export function humDuck(seconds = 2.6) {
  if (!actx) return
  try {
    if (ambienceGain) ambienceGain.gain.setTargetAtTime(0.0001, actx.currentTime, 0.04)
    if (music && music.master) music.master.gain.setTargetAtTime(0.0001, actx.currentTime, 0.04)
    setTimeout(() => {
      try {
        applyAmbience()
        if (music && music.master) {
          const vol = music.enabled ? (music.mood?.volume ?? 0.06) * music.volScale : 0
          music.master.gain.setTargetAtTime(vol, actx.currentTime, 0.6)
        }
      } catch { /* ignore */ }
    }, seconds * 1000)
  } catch { /* ignore */ }
}

// ── the pulse's small sounds (T1-1): your own steps, the things you take and read, the panels going out, the calls the building
//    makes (a creature's tell, a landmark) and the hum's glide. All on the ambience bus, panned through panTo where they take a pan,
//    never louder than PEAK_CAP however they are asked; no-ops without audio, and none of them throws. ──

// a slice of the shared noise: `dur` s from a random place in it, ended by its own duration, so no two sound alike and none allocates
function noiseAt(t, dur) {
  const src = actx.createBufferSource(); src.buffer = noiseBuf
  src.start(t, Math.random() * (NOISE_S - dur), dur)
  return src
}
// (a low- or high-pass takes its Q in dB here: -3 is flat, no peak at the corner to push a recipe over its cap)
function filter(type, freq, q) {
  const f = actx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q
  return f
}
// struck: from nothing up to `peak` in `atk` s, then away to nothing by `end` s (the exponential pair every one-shot here uses)
function struck(g, t, peak, atk, end) {
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + atk); g.gain.exponentialRampToValueAtTime(0.0004, t + end)
}
// one struck oscillator: `type` at f0, gliding to f1 by t + glide when f1 is given, through `via` when given, stopped once it is quiet
function voice(dest, type, f0, f1, glide, t, peak, atk, end, via) {
  const o = actx.createOscillator(), g = actx.createGain()
  o.type = type
  o.frequency.setValueAtTime(f0, t); if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + glide)
  struck(g, t, peak, atk, end)
  if (via) { o.connect(via); via.connect(g) } else o.connect(g)
  g.connect(dest); o.start(t); o.stop(t + end + 0.01)
}
// one struck burst of the shared noise through one filter; the filter is handed back for a recipe that moves it
function burst(dest, type, freq, q, t, peak, atk, dur) {
  const src = noiseAt(t, dur), f = filter(type, freq, q), g = actx.createGain()
  struck(g, t, peak, atk, dur)
  src.connect(f); f.connect(g); g.connect(dest)
  return f
}

// Your own steps, by floor: game.js plays STEP_MATERIAL[level.index] on each step you actually take. Level ∅ has no entry (the hold).
export const STEP_MATERIAL = Object.freeze({ 0: 'carpet', 1: 'concrete', 2: 'grate', 3: 'rubber' })
// how hard game.js steps: a walk, a sprint
export const STEP_GAIN = Object.freeze({ walk: 0.5, sprint: 0.9 })
const STEP_PEAK = 0.035   // at intensity 1: a walk's knock (0.5) peaks at 0.35 x footfall's 0.05
const STEP_BAND = 1.7     // a band of noise passes a small part of its gain: the noise in a step gets this much more, still under the cap
// (levelled against the hum in an A-weighted offline render: a walk sits a little under the hum, a sprint about level with it)
const STEPS = {
  carpet:   (d, t, p) => { burst(d, 'bandpass', 300, 0.3, t, p * STEP_BAND, 0.008, 0.06) },        // the lobby: a soft thump of noise
  concrete: (d, t, p) => { voice(d, 'sine', 90, 60, 0.05, t, p, 0.004, 0.05)                         // a low knock
                           voice(d, 'sine', 2000, 0, 0, t, p * 0.7, 0.001, 0.012) },                  // and the grit under the sole
  grate:    (d, t, p) => { voice(d, 'triangle', 260, 0, 0, t, p, 0.004, 0.07)                         // a hollow step
                           voice(d, 'sine', 1800, 0, 0, t, p * 0.18, 0.002, 0.14) },                  // and the mesh pinging after it
  rubber:   (d, t, p) => { voice(d, 'sine', 70, 0, 0, t, p * 0.6, 0.006, 0.06)                       // the matting: one dull tap
                           burst(d, 'bandpass', 600, 0.5, t, p * 1.1, 0.006, 0.05) },                 // and the sole on it (a 70 Hz tap alone is felt, not heard)
  // not a floor's: the dead-panels district's wet carpet (2c), the thump with a squelch as its band slides down
  wet:      (d, t, p) => { const f = burst(d, 'bandpass', 900, 0.8, t, p * STEP_BAND, 0.01, 0.1)
                           f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(380, t + 0.09) },
}

// One step: `intensity` 0..1 (0.5 a walk, 0.9 a sprint), `pan` -1..1. An unknown material (Level ∅'s none) plays nothing.
export function step(material, intensity = 0.5, pan = 0) {
  if (!actx || !(intensity > 0) || !Object.hasOwn(STEPS, material)) return
  try {
    STEPS[material](panTo(pan), actx.currentTime, STEP_PEAK * (intensity > 1 ? 1 : intensity))
  } catch { /* ignore */ }
}

// Taking something (the tray, a machine's dispense): two 30 ms ticks, 1.2 then 1.6 kHz.
export function pickup() {
  if (!actx) return
  try {
    const d = ambienceGain || actx.destination, t = actx.currentTime
    voice(d, 'sine', 1200, 0, 0, t, 0.04, 0.002, 0.03)
    voice(d, 'sine', 1600, 0, 0, t + 0.05, 0.04, 0.002, 0.03)
  } catch { /* ignore */ }
}

// Paper in your hands: 'page' a note opened (one 0.18 s high-passed rustle), 'map' the map unfolded (two 0.1 s, a little heavier).
export function paper(kind) {
  if (!actx || (kind !== 'page' && kind !== 'map')) return
  try {
    const d = ambienceGain || actx.destination, t = actx.currentTime
    if (kind === 'page') burst(d, 'highpass', 2400, -3, t, 0.035, 0.012, 0.18)
    else { burst(d, 'highpass', 1600, -3, t, 0.032, 0.01, 0.1); burst(d, 'highpass', 1800, -3, t + 0.14, 0.025, 0.01, 0.1) }
  } catch { /* ignore */ }
}

// The lights cascade (silent until now): three soft thuds a quarter second apart, bump's thud lower, each panel further off.
export function panelsOut() {
  if (!actx) return
  try {
    const d = ambienceGain || actx.destination, t = actx.currentTime
    for (let i = 0; i < 3; i++) voice(d, 'sine', 110, 40, 0.14, t + i * 0.25, 0.045 * Math.pow(0.8, i), 0.006, 0.18)
  } catch { /* ignore */ }
}

// The calls: a creature's tell (dread.js TELL) or a landmark (soundscape.js CALLS), each written at full scale and played at `gain`.
const CALLS = {
  // the payphone through the walls: a bell, not a dial tone. Two gongs, 1.1 and 1.4 kHz, under a low-pass (the walls take the top);
  // the clapper strikes them in turn, 20 blows a second for 2 s, each falling away before the next, then they ring out. One call
  // is the 2 s on; the off is the caller's cadence.
  ring(d, t, k) {
    const wall = filter('lowpass', 1500, -3)
    wall.connect(d)
    for (let gong = 0; gong < 2; gong++) {
      const o = actx.createOscillator(), g = actx.createGain()
      const peak = PEAK_CAP * k * (gong ? 0.4 : 0.6), first = t + gong * 0.05, lastBlow = first + 1.9   // the lower gong carries further
      o.type = 'sine'; o.frequency.value = gong ? 1400 : 1100
      for (let i = 0; i < 20; i++) {
        const s = first + i * 0.1, a = peak * (i ? 1 : gong ? 0.85 : 0.7)                                // the clapper comes up to speed
        g.gain.setValueAtTime(a, s)
        g.gain.exponentialRampToValueAtTime(i < 19 ? a * 0.3 : 0.0004, s + (i < 19 ? 0.098 : 0.45))
      }
      o.connect(g); g.connect(wall); o.start(first); o.stop(lastBlow + 0.46)
    }
  },
  // a receiver left off the hook: the two tones of a line ringing somewhere else, small, from an earpiece, steady for 2 s
  offhook(d, t, k) {
    const ear = filter('bandpass', 700, 0.6), g = actx.createGain(), peak = 0.02 * k
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + 0.03); g.gain.setValueAtTime(peak, t + 1.95); g.gain.linearRampToValueAtTime(0, t + 2)
    const a = actx.createOscillator(), b = actx.createOscillator()
    a.frequency.value = 440; b.frequency.value = 480
    a.connect(ear); b.connect(ear); ear.connect(g); g.connect(d)
    a.start(t); b.start(t); a.stop(t + 2.02); b.stop(t + 2.02)
  },
  // the TV wall: a swell of static, band-passed high
  hiss(d, t, k) {
    const src = noiseAt(t, 0.4), bp = filter('bandpass', 4500, 0.6), g = actx.createGain(), peak = 0.035 * k
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + 0.06); g.gain.linearRampToValueAtTime(peak * 0.7, t + 0.3); g.gain.linearRampToValueAtTime(0, t + 0.4)
    src.connect(bp); bp.connect(g); g.connect(d)
  },
  // the chair pile: a wood tap pitched down, its note sagging as the stack settles
  creak(d, t, k) { voice(d, 'triangle', 240, 110, 0.26, t, 0.06 * k, 0.006, 0.3, filter('bandpass', 520, 0.7)) },
  // the tesla: a 120 Hz saw through a 1 kHz band-pass, a quarter second of something live
  buzz(d, t, k) {
    const o = actx.createOscillator(), bp = filter('bandpass', 1000, 2), g = actx.createGain(), peak = 0.06 * k
    o.type = 'sawtooth'; o.frequency.value = 120
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + 0.01); g.gain.setValueAtTime(peak, t + 0.22); g.gain.linearRampToValueAtTime(0, t + 0.25)
    o.connect(bp); bp.connect(g); g.connect(d); o.start(t); o.stop(t + 0.26)
  },
  // a smiler's: two dry 3 kHz ticks, close together
  click(d, t, k) { voice(d, 'sine', 3000, 0, 0, t, 0.045 * k, 0.001, 0.012); voice(d, 'sine', 3000, 0, 0, t + 0.09, 0.045 * k, 0.001, 0.012) },
  // a hound's: three noise breaths through 600 Hz, the middle one out
  pant(d, t, k) {
    const src = noiseAt(t, 0.6), bp = filter('bandpass', 600, 1.2), g = actx.createGain(), peak = 0.05 * k
    for (let i = 0; i < 3; i++) {
      const s = t + i * 0.21
      g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(peak * (i === 1 ? 0.8 : 1), s + 0.05); g.gain.linearRampToValueAtTime(0, s + 0.16)
    }
    src.connect(bp); bp.connect(g); g.connect(d)
  },
  // a lurker's: one drop, 1.4 falling to 0.9 kHz in 0.05 s
  drip(d, t, k) { voice(d, 'sine', 1400, 900, 0.05, t, 0.01 * k, 0.002, 0.12) },   // a pure tone up where the ear is keenest: quiet
  // a crawler's: its breath along the floor, 0.3 s of noise at 400 Hz
  rasp(d, t, k) {
    const src = noiseAt(t, 0.3), bp = filter('bandpass', 400, 0.9), g = actx.createGain(), peak = 0.06 * k
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + 0.04); g.gain.linearRampToValueAtTime(peak * 0.6, t + 0.22); g.gain.linearRampToValueAtTime(0, t + 0.3)
    src.connect(bp); bp.connect(g); g.connect(d)
  },
  // a watcher's: the whisper, low (at the default gain, 0.6 of the sanity whisper: under it, and panned where the sanity one never is)
  hush(d, t, k) { whisperInto(d, 1.2 * k) },
  // a shade's: one heavy 50 Hz thump in the structure, with the knock of it landing (50 Hz alone is felt, not heard, on a phone)
  thump(d, t, k) {
    voice(d, 'triangle', 50, 44, 0.2, t, 0.03 * k, 0.008, 0.3, filter('lowpass', 180, -3))
    burst(d, 'bandpass', 260, 0.6, t, 0.03 * k, 0.004, 0.09)
  },
  // a chair moving somewhere (the teller's other sound): bump's scrape, under the cap
  scrape(d, t, k) { scrapeInto(d, t, cap(0.07 * k)) },
}
export const CALL_SOUNDS = Object.freeze(Object.keys(CALLS))
// how long a call sounds before its quiet can begin, for a caller that repeats one (game.js fireEvent: an event's fx.gap is the quiet
// between): the bell's 2 s and the receiver's 2 s of tone; the rest are short enough to read as over at once
export const CALL_LEN = Object.freeze({ ring: 2, offhook: 2 })

// Play a call at `gain` 0..1 (soundscape.js's falloff, dread.js's tell gain), panned -1..1 toward where it comes from. An unknown
// sound, or no gain to give it, plays nothing.
export function call(sound, gain = 0.5, pan = 0) {
  if (!actx || !(gain > 0) || !Object.hasOwn(CALLS, sound)) return
  try {
    CALLS[sound](panTo(pan), actx.currentTime, gain > 1 ? 1 : gain)
  } catch { /* ignore */ }
}

// Glide the hum: its pitch by `ratio` (an octave either way at most) and its level by `gainMul`, arriving in about `seconds`. The
// stir warning drops it half a note, the hush swells it, every arrival puts it back with setHum(1, 1, 0.5). The pitch rides on the
// detune, since setFlicker re-aims the frequency every frame; the level is capped like everything above.
export function setHum(ratio = 1, gainMul = 1, seconds = 3) {
  if (!actx || !humOsc || !humGain) return
  try {
    const r = ratio > 0 && ratio < Infinity ? (ratio < 0.5 ? 0.5 : ratio > 2 ? 2 : ratio) : 1
    const m = gainMul >= 0 ? gainMul : 1
    const tc = seconds > 0 ? seconds / 3 : 0.01, t = actx.currentTime   // setTargetAtTime is ~95% there after three time constants
    humOsc.detune.setTargetAtTime(1200 * Math.log2(r), t, tc)
    humGain.gain.setTargetAtTime(cap(HUM_GAIN * m), t, tc)
  } catch { /* ignore */ }
}
