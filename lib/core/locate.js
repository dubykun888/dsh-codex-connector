'use strict'

// Binary discovery for the Codex CLI.
//
// NEVER hardcode one path. Field evidence (DESIGN.md §9.1 H-4, §7.4): this machine
// carries two copies of the same build, and the desktop app keeps its binaries
// in directories NAMED BY CONTENT HASH, so an upgrade renames the directory and
// any hardcoded path silently rots.
//
// Probe order, first hit wins:
//   1. explicit user config            (highest priority, always wins)
//   2. CODEX_CLI_PATH hint in $CODEX_HOME/config.toml
//   3. <localAppData>/OpenAI/Codex/bin/<hash>/codex.exe   (newest hash dir)
//   4. <CODEX_HOME>/plugins/.plugin-appserver/codex.exe
//   5. bare `codex` on PATH

const fs = require('node:fs')
const path = require('node:path')

const EXE = process.platform === 'win32' ? 'codex.exe' : 'codex'

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function newestDirWithExe(parent) {
  let entries
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true })
  } catch {
    return undefined
  }
  const found = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const candidate = path.join(parent, e.name, EXE)
    if (isFile(candidate)) {
      let mtime = 0
      try {
        mtime = fs.statSync(candidate).mtimeMs
      } catch {
        /* keep 0 */
      }
      found.push({ candidate, mtime })
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  return found.length > 0 ? found[0].candidate : undefined
}

/** Read `CODEX_CLI_PATH` out of $CODEX_HOME/config.toml without a TOML dep. */
function hintFromCodexConfig(codexHome) {
  if (!codexHome) return undefined
  let text
  try {
    text = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')
  } catch {
    return undefined
  }
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*CODEX_CLI_PATH\s*=\s*['"](.+?)['"]\s*$/.exec(raw)
    if (m) {
      const value = m[1].replace(/\\\\/g, '\\')
      if (isFile(value)) return value
    }
  }
  return undefined
}

function onPath() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const d of dirs) {
    const candidate = path.join(d, EXE)
    if (isFile(candidate)) return candidate
  }
  return undefined
}

/**
 * @param {{ override?: string, codexHome?: string, localAppData?: string }} [options]
 * @returns {{ path: string, source: string, tried: Array<{source: string, path?: string, ok: boolean}> }}
 */
function locateCodex(options = {}) {
  const codexHome =
    options.codexHome || process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex')
  const localAppData = options.localAppData || process.env.LOCALAPPDATA

  const probes = []
  const push = (source, p) => probes.push({ source, path: p, ok: Boolean(p) && isFile(p) })

  // 1. explicit override
  if (options.override) {
    push('config', options.override)
    if (isFile(options.override)) {
      return { path: options.override, source: 'config', tried: probes }
    }
  }

  // 2. CODEX_CLI_PATH hint
  const hint = hintFromCodexConfig(codexHome)
  push('codex-config-hint', hint)
  if (hint) return { path: hint, source: 'codex-config-hint', tried: probes }

  // 3. desktop bin/<hash>/codex.exe
  if (localAppData) {
    const binRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin')
    const candidate = newestDirWithExe(binRoot)
    push('desktop-bin', candidate)
    if (candidate) return { path: candidate, source: 'desktop-bin', tried: probes }
  }

  // 4. plugin appserver copy
  const appserver = path.join(codexHome, 'plugins', '.plugin-appserver', EXE)
  push('plugin-appserver', appserver)
  if (isFile(appserver)) return { path: appserver, source: 'plugin-appserver', tried: probes }

  // 5. PATH
  const pathHit = onPath()
  push('path', pathHit)
  if (pathHit) return { path: pathHit, source: 'path', tried: probes }

  const error = new Error(
    'Codex CLI not found. Tried:\n' +
      probes.map((p) => `  - ${p.source}: ${p.path || '(not present)'}`).join('\n') +
      '\nInstall Codex or set `codexBinary` in .dsh-codex/config.json.',
  )
  error.code = 'CODEX_NOT_FOUND'
  error.probes = probes
  throw error
}

module.exports = { locateCodex, isFile, EXE }
