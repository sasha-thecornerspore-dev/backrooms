export const DEFAULT_CONFIG = {
  palette: { wall: '#C8B870', ceiling: '#E8E0C0', floor: '#4A3820', fog: '#D4C87A' },
  fogDistance: 16,
  wallDensity: 0.30,
  chunkEvictRadius: 3,
  flicker: { rate: 0.07, depth: 0.60, recoverySpeed: 12 },
  audio: { humFrequency: 120, droneFrequency: 60, distantEventInterval: [8, 28] },
  messages: [
    "you shouldn't be here.",
    "the carpet is damp.",
    "the lights don't turn off.",
    "something moved. in your peripheral vision.",
    "you've been walking for hours. days. weeks.",
    "there is no exit.",
    "you can hear something. it's getting closer.",
    "the humming never stops.",
    "level 0.",
    "the wallpaper is the same in every direction.",
  ],
  messageInterval: [25, 90],
}

export async function loadConfig() {
  try {
    const r = await fetch('./world.json')
    if (!r.ok) return DEFAULT_CONFIG
    return await r.json()
  } catch {
    return DEFAULT_CONFIG
  }
}
