import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { normalizeMode } from './updater.js'

const DEFAULTS = { autoUpdate: true, softwareRender: false }

// updateMode ('auto' | 'notify' | 'manual') replaced the old autoUpdate checkbox. A settings file from
// before it keeps its meaning: autoUpdate on -> 'auto', off -> 'notify' (it used to prompt "restart now").
// autoUpdate is still written alongside, mirroring updateMode === 'auto'.
function withUpdateMode(s) {
  const updateMode = s.updateMode !== undefined
    ? normalizeMode(s.updateMode)
    : (s.autoUpdate === false ? 'notify' : 'auto')
  return { ...s, updateMode, autoUpdate: updateMode === 'auto' }
}

export function readSettings(filePath) {
  try {
    return withUpdateMode({ ...DEFAULTS, ...JSON.parse(readFileSync(filePath, 'utf8')) })
  } catch {
    return withUpdateMode({ ...DEFAULTS })
  }
}

export function writeSettings(filePath, settings) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(withUpdateMode(settings), null, 2))
}
