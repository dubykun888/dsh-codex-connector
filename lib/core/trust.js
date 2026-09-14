'use strict'

// Project trust bookkeeping.
//
// Why this exists (DESIGN.md §6.1, measured): a project's `.codex/config.toml`
// is IGNORED unless the project is trusted in the USER-level config. `AGENTS.md`
// is not gated. So project knowledge needs no authorisation, but execution
// policy does.
//
// Rules this module enforces:
//   - never write the user config implicitly; callers must have consent
//   - back up before mutating, restore on any failure
//   - match Codex's own entry shape: [projects.'<lowercased path>']
//   - do not write a redundant child entry when an ancestor is already trusted
//
// Note (DESIGN.md §12.1 D5): `codex exec` itself can ADD trust entries. So a
// decision is always made from a fresh read, never from a cached "we wrote it".

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

function configPath(codexHome) {
  return path.join(codexHome || defaultCodexHome(), 'config.toml')
}

/** Codex writes lowercased paths in single-quoted literal keys. Match that. */
function keyFor(projectPath) {
  return path.resolve(projectPath).replace(/\\/g, '\\').toLowerCase()
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Parse `[projects.'<path>']` sections with their trust_level.
 * Deliberately regex-based: no TOML dependency needed for one table shape, and
 * we must never round-trip the user's whole file through a parser that could
 * reformat it.
 */
function readTrustEntries(codexHome) {
  const file = configPath(codexHome)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { file, exists: false, entries: [] }
  }
  const entries = []
  const headerRe = /^\s*\[projects\.(['"])(.+?)\1\]\s*$/gm
  const matches = []
  let m
  while ((m = headerRe.exec(text)) !== null) {
    matches.push({ raw: m[2], index: m.index, end: m.index + m[0].length })
  }
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].end
    const stop = i + 1 < matches.length ? matches[i + 1].index : text.length
    const body = text.slice(start, stop)
    const tl = /^\s*trust_level\s*=\s*(['"])(.*?)\1\s*$/m.exec(body)
    entries.push({
      raw: matches[i].raw,
      path: matches[i].raw.replace(/\\\\/g, '\\'),
      trustLevel: tl ? tl[2] : undefined,
    })
  }
  return { file, exists: true, entries, text }
}

function isPathInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Resolve trust for a project, honouring ancestor coverage.
 * @returns {{ trusted: boolean, reason: string, via?: string, entries: object[] }}
 */
function resolveTrust(projectPath, codexHome) {
  const { entries, exists } = readTrustEntries(codexHome)
  if (!exists) return { trusted: false, reason: 'no user config found', entries }
  const target = path.resolve(projectPath)

  const exact = entries.find((e) => path.resolve(e.path).toLowerCase() === target.toLowerCase())
  if (exact) {
    return {
      trusted: exact.trustLevel === 'trusted',
      reason: exact.trustLevel === 'trusted' ? 'exact entry is trusted' : `exact entry is "${exact.trustLevel}"`,
      via: exact.raw,
      entries,
    }
  }
  const ancestors = entries
    .filter((e) => isPathInside(target, e.path) && path.resolve(e.path).toLowerCase() !== target.toLowerCase())
    .sort((a, b) => path.resolve(b.path).length - path.resolve(a.path).length)
  const covering = ancestors.find((e) => e.trustLevel === 'trusted')
  if (covering) {
    return { trusted: true, reason: 'covered by a trusted ancestor entry', via: covering.raw, entries }
  }
  if (ancestors.some((e) => e.trustLevel !== 'trusted')) {
    return {
      trusted: false,
      reason: 'an ancestor entry exists but is not trusted',
      via: ancestors[0].raw,
      entries,
    }
  }
  return { trusted: false, reason: 'no entry covers this project', entries }
}

/**
 * Add a trust entry. Backs up first; restores on failure.
 * @returns {{ changed: boolean, file: string, backup?: string, entry?: string, reason?: string }}
 */
function grantTrust(projectPath, options = {}) {
  const codexHome = options.codexHome
  const file = configPath(codexHome)
  const resolved = resolveTrust(projectPath, codexHome)
  if (resolved.trusted) {
    return { changed: false, file, reason: resolved.reason, entry: resolved.via }
  }
  if (!fs.existsSync(file)) {
    return { changed: false, file, reason: 'user config absent; refusing to create one implicitly' }
  }

  const backup = `${file}.dsh-backup`
  const original = fs.readFileSync(file)
  fs.writeFileSync(backup, original)
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const key = keyFor(projectPath)
  const block = `${eol}[projects.'${key}']${eol}trust_level = "trusted"${eol}`

  try {
    const text = fs.readFileSync(file, 'utf8')
    if (text.includes(`[projects.'${key}']`)) {
      fs.unlinkSync(backup)
      return { changed: false, file, reason: 'entry already present' }
    }
    const body = text.endsWith(eol) ? text : text + eol
    const next = body + block
    // Write bytes, never a string: Node's writeFileSync with a string is UTF-8
    // without BOM, but going through Buffer keeps that explicit and auditable.
    fs.writeFileSync(file, Buffer.from(next, 'utf8'))
    const verify = resolveTrust(projectPath, codexHome)
    if (!verify.trusted) {
      fs.writeFileSync(file, original)
      fs.unlinkSync(backup)
      return { changed: false, file, reason: 'verification failed; restored original' }
    }
    fs.unlinkSync(backup)
    return { changed: true, file, entry: `[projects.'${key}']` }
  } catch (error) {
    try {
      fs.writeFileSync(file, original)
    } catch {
      /* best effort */
    }
    return { changed: false, file, reason: `write failed and config restored: ${error.message}` }
  }
}

/** Remove exactly the entry we would have written. */
function revokeTrust(projectPath, options = {}) {
  const codexHome = options.codexHome
  const file = configPath(codexHome)
  if (!fs.existsSync(file)) return { changed: false, file, reason: 'user config absent' }
  const original = fs.readFileSync(file, 'utf8')
  const key = keyFor(projectPath)
  const re = new RegExp(
    `\\r?\\n?\\[projects\\.'${escapeRe(key)}'\\]\\r?\\n(?:trust_level\\s*=\\s*['"][^'"]*['"]\\r?\\n?)?`,
    'i',
  )
  if (!re.test(original)) return { changed: false, file, reason: 'no matching entry' }
  const next = original.replace(re, '')
  fs.writeFileSync(file, Buffer.from(next, 'utf8'))
  return { changed: true, file }
}

module.exports = {
  configPath,
  defaultCodexHome,
  grantTrust,
  keyFor,
  readTrustEntries,
  resolveTrust,
  revokeTrust,
}
