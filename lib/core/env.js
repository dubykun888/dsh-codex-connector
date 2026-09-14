'use strict'

// Environment scrubbing for the spawned Codex process.
//
// Omitting `env` hands Codex — an external agent that executes shell commands —
// the entire DSH process environment, including credentials like
// DEEPSEEK_API_KEY that have nothing to do with it (DESIGN.md §4.1 security
// clause). We pass an explicit allowlist instead.

const ALLOW_ALWAYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'USERNAME',
  'USER',
  'LOGNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'LANG',
  'LC_ALL',
  'TZ',
  'CODEX_HOME',
  'PYTHONIOENCODING',
]

/** Prefixes that are safe/necessary to forward wholesale. */
const ALLOW_PREFIXES = ['CODEX_', 'npm_config_', 'NODE_']

/** Never forward these, even if a caller asks. */
const DENY = [/API_KEY/i, /SECRET/i, /TOKEN/i, /PASSWORD/i, /CREDENTIAL/i]

/**
 * @param {Record<string, string|undefined>} source
 * @param {{ extra?: string[], passthrough?: string[] }} [options]
 * @returns {{ env: Record<string,string>, dropped: string[] }}
 */
function buildEnv(source = process.env, options = {}) {
  const allow = new Set(ALLOW_ALWAYS.map((k) => k.toUpperCase()))
  for (const key of options.extra || []) allow.add(String(key).toUpperCase())
  const passthrough = new Set((options.passthrough || []).map((k) => k.toUpperCase()))

  const env = {}
  const dropped = []
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    const denied = DENY.some((re) => re.test(key)) && !passthrough.has(upper)
    if (denied) {
      dropped.push(key)
      continue
    }
    const allowed =
      allow.has(upper) ||
      passthrough.has(upper) ||
      ALLOW_PREFIXES.some((p) => upper.startsWith(p.toUpperCase()))
    if (allowed) env[key] = value
    else dropped.push(key)
  }
  return { env, dropped }
}

module.exports = { buildEnv, ALLOW_ALWAYS, ALLOW_PREFIXES }
