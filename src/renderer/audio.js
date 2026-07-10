let actx, humGain, humOsc, ambienceGain

export function initAudio(config) {
  try {
    actx = new AudioContext()

    // Ambience bus — hum, drone and distant events route through here so the
    // whole environmental layer can be toggled independently of the music.
    ambienceGain = actx.createGain()
    ambienceGain.gain.value = 1
    ambienceGain.connect(actx.destination)

    // Fluorescent hum
    humOsc  = actx.createOscillator()
    humGain = actx.createGain()
    const humFilter = actx.createBiquadFilter()
    humFilter.type = 'lowpass'
    humFilter.frequency.value = 400
    humOsc.type = 'sawtooth'
    humOsc.frequency.value = config.audio.humFrequency
    humGain.gain.value = 0.018
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
  // Hum pitch drops slightly during flicker
  humOsc.frequency.setTargetAtTime(
    120 * (0.85 + intensity * 0.15),
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
  const now = actx.currentTime
  const master = actx.createGain(); master.gain.value = 0        // faded in by setMusic
  const reverb = buildReverb()
  const wet = actx.createGain(); wet.gain.value = 0.55
  const dry = actx.createGain(); dry.gain.value = 0.6
  const bus = actx.createBiquadFilter(); bus.type = 'lowpass'; bus.frequency.value = 1100; bus.Q.value = 0.4
  bus.connect(dry); bus.connect(reverb)
  reverb.connect(wet); wet.connect(master); dry.connect(master)
  master.connect(actx.destination)

  // three detuned pad voices (the chord that breathes)
  const pad = [0, 1, 2].map(() => {
    const o = actx.createOscillator(); o.type = 'triangle'
    const g = actx.createGain(); g.gain.value = 0
    o.connect(g); g.connect(bus); o.start()
    return { o, g }
  })

  // tape wow/flutter — a slow LFO nudging every pad voice's detune
  const flutter = actx.createOscillator(); flutter.type = 'sine'; flutter.frequency.value = 0.17
  const flutterAmt = actx.createGain(); flutterAmt.gain.value = 7   // cents
  flutter.connect(flutterAmt); pad.forEach(p => flutterAmt.connect(p.o.detune)); flutter.start()

  // slow filter drift — the muffled dream tide
  const drift = actx.createOscillator(); drift.type = 'sine'; drift.frequency.value = 0.045
  const driftAmt = actx.createGain(); driftAmt.gain.value = 350
  drift.connect(driftAmt); driftAmt.connect(bus.frequency); drift.start()

  music = { master, bus, pad, mood: null, enabled: true, volScale: 1, stepTimer: null, chordTimer: null }
}

function padChord() {
  const m = music, mood = m.mood
  const base = Math.floor(Math.random() * mood.scale.length)
  const degs = [base, base + 2, base + 4]                    // stacked thirds within the scale
  const t = actx.currentTime
  m.pad.forEach((p, i) => {
    const f = scaleFrequency(mood.root, mood.scale, degs[i]) * (1 + (Math.random() - 0.5) * 0.006)
    p.o.frequency.setTargetAtTime(f, t, 0.9)                 // glide, don't jump
    p.g.gain.setTargetAtTime(0.02, t, 1.4)
  })
}

function melodyNote() {
  const m = music, mood = m.mood
  try {
    const o = actx.createOscillator()
    const g = actx.createGain()
    o.type = Math.random() < 0.5 ? 'triangle' : 'sine'
    const deg = Math.floor(Math.random() * mood.scale.length)
    const oct = 1 + (Math.random() < 0.3 ? 1 : 0)
    let f = scaleFrequency(mood.root, mood.scale, deg, oct)
    f *= 1 + (Math.random() - 0.5) * (mood.wobble ?? 0.012)  // the tune is almost right
    const t = actx.currentTime
    const len = mood.noteLen ?? 1.6
    o.frequency.setValueAtTime(f, t)
    if (Math.random() < (mood.bend ?? 0.14)) o.frequency.exponentialRampToValueAtTime(f * 0.5, t + len) // tape drop
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(0.05, t + 0.06)
    g.gain.exponentialRampToValueAtTime(0.0008, t + len)
    o.connect(g); g.connect(m.bus)
    o.start(t); o.stop(t + len + 0.1)
  } catch { /* ignore */ }
}

function restartSchedulers() {
  const mood = music.mood
  clearInterval(music.stepTimer); clearInterval(music.chordTimer)
  music.chordTimer = setInterval(() => { if (music.enabled) padChord() }, (mood.chordEvery ?? 9) * 1000)
  music.stepTimer  = setInterval(() => {
    if (music.enabled && Math.random() < (mood.density ?? 0.5)) melodyNote()
  }, mood.tempo ?? 680)
}

// Set the level's mood — the engine morphs into it without stopping.
export function setMusic(mood) {
  if (!actx || !mood) return
  initMusic()
  if (!music) return
  music.mood = mood
  if (music.bus) music.bus.frequency.setTargetAtTime(mood.brightness ?? 1100, actx.currentTime, 2)
  music.master.gain.setTargetAtTime(music.enabled ? (mood.volume ?? 0.06) * music.volScale : 0, actx.currentTime, 2.5)
  padChord()
  restartSchedulers()
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

// Toggle the whole environmental layer (hum / drone / distant events).
export function setAmbience(on) {
  if (!ambienceGain || !actx) return
  ambienceGain.gain.setTargetAtTime(on ? 1 : 0, actx.currentTime, 0.5)
}
