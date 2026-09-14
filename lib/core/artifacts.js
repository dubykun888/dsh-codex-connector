'use strict'

// Artifact recovery.
//
// The imagegen builtin does NOT accept a destination path: images always land
// under $CODEX_HOME/generated_images/<run-dir>/ (DESIGN.md §1.2). And <run-dir>
// is NOT the thread id — measured: dir 01a0a0f7-… vs thread 01a0a0f5-…
// (DESIGN.md §12.1 D1). So we never synthesise a path from the thread id; we
// diff a before/after snapshot, and cross-check against the paths the agent
// reported in its final message.

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const DEFAULT_CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')

function expand(pattern, codexHome = DEFAULT_CODEX_HOME) {
  return String(pattern)
    .replace(/\$CODEX_HOME/g, codexHome)
    .replace(/^~(?=[\\/]|$)/, os.homedir())
    .split(/[\\/]/)
    .join(path.sep)
}

/** Longest leading run of segments with no glob metacharacters. */
function staticBase(expanded) {
  const parts = expanded.split(path.sep)
  const kept = []
  for (const part of parts) {
    if (/[*?[\]]/.test(part)) break
    kept.push(part)
  }
  if (kept.length === 0) return path.parse(expanded).root || '.'
  return kept.join(path.sep) || path.sep
}

function segmentToRegex(segment) {
  let out = ''
  for (const ch of segment) {
    if (ch === '*') out += '[^\\\\/]*'
    else if (ch === '?') out += '[^\\\\/]'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`, process.platform === 'win32' ? 'i' : '')
}

function matchPath(expandedPattern, candidate) {
  const patParts = expandedPattern.split(path.sep).filter((p) => p !== '')
  const candParts = candidate.split(path.sep).filter((p) => p !== '')
  const cache = new Map()
  const walk = (pi, ci) => {
    const key = `${pi}:${ci}`
    if (cache.has(key)) return cache.get(key)
    let result
    if (pi === patParts.length) result = ci === candParts.length
    else if (patParts[pi] === '**') {
      result = walk(pi + 1, ci) || (ci < candParts.length && walk(pi, ci + 1))
    } else if (ci >= candParts.length) {
      result = false
    } else {
      result = segmentToRegex(patParts[pi]).test(candParts[ci]) && walk(pi + 1, ci + 1)
    }
    cache.set(key, result)
    return result
  }
  return walk(0, 0)
}

function walkFiles(root, out = [], depth = 0) {
  if (depth > 12) return out
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) walkFiles(full, out, depth + 1)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** @returns {string[]} absolute paths matching any pattern */
function globFiles(patterns, options = {}) {
  const codexHome = options.codexHome || DEFAULT_CODEX_HOME
  const hits = new Set()
  for (const pattern of patterns || []) {
    const expanded = expand(pattern, codexHome)
    const base = staticBase(expanded)
    for (const file of walkFiles(base)) {
      if (matchPath(expanded, file)) hits.add(path.resolve(file))
    }
  }
  return [...hits]
}

/** Snapshot: absolute path -> {size, mtimeMs}. Used to isolate this run's files. */
function snapshot(patterns, options = {}) {
  const map = new Map()
  for (const file of globFiles(patterns, options)) {
    try {
      const st = fs.statSync(file)
      map.set(file, { size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      /* vanished mid-walk */
    }
  }
  return map
}

function diffNew(before, after) {
  const fresh = []
  for (const [file, info] of after) {
    const prev = before.get(file)
    if (!prev) fresh.push(file)
    else if (prev.size !== info.size || prev.mtimeMs !== info.mtimeMs) fresh.push(file)
  }
  return fresh.sort()
}

/** Never clobber: hero.png -> hero-v2.png -> hero-v3.png */
function uniqueName(dir, filename) {
  const ext = path.extname(filename)
  const stem = path.basename(filename, ext)
  let candidate = path.join(dir, filename)
  let n = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-v${n}${ext}`)
    n += 1
  }
  return candidate
}

/**
 * Copy the run's new files into the workspace.
 *
 * `collectTo` comes from a capability card, which users AND the self-extending
 * agent can write, so it is UNTRUSTED input: `collectTo: "../../escaped"` was
 * measured writing files outside the workspace. Containment is therefore
 * asserted here rather than assumed.
 *
 * @returns {{ collected: Array<{from: string, to: string, bytes: number}>, skipped: string[], destRoot?: string, refused?: boolean }}
 */
function collect({ files, workspace, collectTo, runId }) {
  const collected = []
  const skipped = []
  const root = path.resolve(workspace)

  let destRoot
  if (collectTo) {
    const candidate = path.resolve(root, collectTo)
    if (!isInside(candidate, root)) {
      return {
        collected,
        skipped: files.map((f) => `${f}: refused — collectTo "${collectTo}" resolves outside the workspace`),
        destRoot: undefined,
        refused: true,
      }
    }
    destRoot = candidate
  } else {
    destRoot = path.join(root, '.dsh-codex', 'artifacts', runId || 'latest')
  }

  fs.mkdirSync(destRoot, { recursive: true })
  for (const file of files) {
    try {
      const dest = uniqueName(destRoot, path.basename(file))
      // Re-asserted per copy: uniqueName cannot escape today, and a future
      // change to it must not silently reopen this hole.
      if (!isInside(dest, root)) {
        skipped.push(`${file}: refused — destination escaped the workspace`)
        continue
      }
      fs.copyFileSync(file, dest)
      collected.push({ from: file, to: dest, bytes: fs.statSync(dest).size })
    } catch (error) {
      skipped.push(`${file}: ${error.message}`)
    }
  }
  return { collected, skipped, destRoot }
}

/** True when `child` is strictly inside `root`. */
function isInside(child, root) {
  const rel = path.relative(path.resolve(root), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Pull absolute paths out of the agent's final message. Measured reliable: the
 * imagegen run reported the exact PNG path. Used as a cross-check on the diff.
 */
function pathsFromText(text, options = {}) {
  const codexHome = options.codexHome || DEFAULT_CODEX_HOME
  const found = new Set()
  const re = /(?:[A-Za-z]:\\[^\s"'`<>|]+|\/(?:Users|home|tmp|var|mnt)\/[^\s"'`<>|]+)/g
  let m
  while ((m = re.exec(String(text || ''))) !== null) {
    const candidate = m[0].replace(/[.,;:)\]]+$/, '')
    const absolute = candidate.startsWith('$CODEX_HOME')
      ? candidate.replace('$CODEX_HOME', codexHome)
      : candidate
    try {
      if (fs.statSync(absolute).isFile()) found.add(path.resolve(absolute))
    } catch {
      /* not a real path */
    }
  }
  return [...found]
}

module.exports = {
  DEFAULT_CODEX_HOME,
  collect,
  diffNew,
  expand,
  globFiles,
  isInside,
  matchPath,
  pathsFromText,
  snapshot,
  staticBase,
  uniqueName,
}
