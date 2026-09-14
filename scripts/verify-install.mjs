#!/usr/bin/env node
'use strict'

// Post-install verification. Run it FROM the profile directory so the module
// resolution base matches what the Cordis loader will use:
//
//   cd "$DSH_HOME/profiles/web" && node <this-repo>/scripts/verify-install.mjs
//
// It answers four questions the install cannot confirm by itself:
//   1. does the package resolve from the profile?
//   2. does the resolved entry have the shape the loader adopts (name/apply/inject)?
//   3. is the patch file a single valid root sequence containing our row?
//   4. is the profile dependency a local link (so edits take effect without repackaging)?

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(path.join(process.cwd(), 'cordis.patch.yml'))
const problems = []
const ok = (message) => process.stdout.write(`ok   ${message}\n`)
const bad = (message) => {
  problems.push(message)
  process.stdout.write(`FAIL ${message}\n`)
}

// 1 + 2: resolution and adopted shape.
let resolved
try {
  resolved = require.resolve('dsh-codex-connector')
  ok(`resolves  -> ${resolved}`)
} catch (error) {
  bad(`cannot resolve dsh-codex-connector from ${process.cwd()}: ${error.message}`)
}

if (resolved) {
  // Mirror the loader's unwrapExports so this check matches real adoption.
  const unwrap = (exports) => {
    if (exports === null || exports === undefined) return exports
    const first = exports.default ?? exports
    if (!first.__esModule) return first
    return first.default ?? first
  }
  const plugin = unwrap(require('dsh-codex-connector'))
  ok(`exports   -> ${Object.keys(plugin).join(', ')}`)
  if (typeof plugin.apply !== 'function') bad('adopted plugin has no apply()')
  if (typeof plugin.name !== 'string' || plugin.name === '') bad('adopted plugin has no name')
  if (!Array.isArray(plugin.inject) || plugin.inject.length === 0) bad('plugin declares no inject')
  const toolCount = (plugin.TOOL_SPECS || []).length
  ok(`tools     -> ${toolCount} (${(plugin.TOOL_SPECS || []).map((t) => t.name).join(', ')})`)
  if (toolCount === 0) bad('plugin exposes no tool specs')
}

// 3: the patch file must be ONE root sequence — an empty-list marker left in
// place alongside an appended row makes the file two root nodes and invalid.
{
  const patchFile = path.join(process.cwd(), 'cordis.patch.yml')
  if (!fs.existsSync(patchFile)) {
    bad(`${patchFile} does not exist`)
  } else {
    const text = fs.readFileSync(patchFile, 'utf8')
    const stray = text.split(/\r?\n/).filter((l) => /^\s*\[\s*\]\s*$/.test(l))
    const unexpected = text
      .split(/\r?\n/)
      .map((l, i) => ({ l, i: i + 1 }))
      .filter(({ l }) => {
        const t = l.trim()
        if (t === '' || t.startsWith('#')) return false
        return !/^- /.test(l) && !/^\s+/.test(l)
      })
    if (stray.length > 0) bad(`patch file has ${stray.length} stray empty-list marker(s); it is invalid YAML`)
    if (unexpected.length > 0) bad(`patch file has unexpected top-level content at line(s) ${unexpected.map((u) => u.i).join(', ')}`)
    if (!text.includes('- id: tool-codex-connector')) bad('patch file is missing the tool-codex-connector row')
    else ok('patch row -> tool-codex-connector')
    if (!text.includes("name: 'dsh-codex-connector'")) bad('row does not reference the package name')
  }
}

// 4: the dependency must be a link, or edits to this repo would not be picked up.
{
  const pkgFile = path.join(process.cwd(), 'package.json')
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
    const dep = pkg.dependencies && pkg.dependencies['dsh-codex-connector']
    if (!dep) bad('profile package.json has no dsh-codex-connector dependency')
    else if (!dep.startsWith('link:')) bad(`profile dependency is not a link (${dep}); edits would need a repack`)
    else ok(`dependency -> ${dep}`)
  } catch (error) {
    bad(`cannot read ${pkgFile}: ${error.message}`)
  }
}

process.stdout.write(
  problems.length === 0
    ? '\nINSTALL VERIFIED — restart DSH so the Host mounts the new row.\n'
    : `\nINSTALL PROBLEMS:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`,
)
process.exitCode = problems.length === 0 ? 0 : 1
