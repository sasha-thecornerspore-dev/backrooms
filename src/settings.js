import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

const DEFAULTS = { autoUpdate: true, softwareRender: false }

export function readSettings(filePath) {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(filePath, 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function writeSettings(filePath, settings) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(settings, null, 2))
}
