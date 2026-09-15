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

/** Row id this installer writes into the profile patch layer. */
const ROW_ID = 'tool-codex-connector'
/** Package name the row must reference. */
const PKG_NAME = 'dsh-codex-connector'

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

    // Checking for the id alone is NOT enough: a bare `- id: <x>` contains it too,
    // and that form is a patch against an EXISTING row — the loader warns
    // "patch: entry <x> not found" and contributes nothing. A NEW row must be
    // wrapped in `insert:`. That exact mistake shipped once: the plugin never
    // mounted while every weaker check passed.
    const lines = text.split(/\r?\n/)
    const idLine = lines.findIndex((l) => l.includes(`id: ${ROW_ID}`))
    if (idLine === -1) {
      bad('patch file is missing the tool-codex-connector row')
    } else {
      const indent = lines[idLine].length - lines[idLine].trimStart().length
      if (indent === 0) {
        bad(
          `row at line ${idLine + 1} is a bare top-level entry; a NEW row must be wrapped in "- insert:" ` +
            'or the loader treats it as an override of a nonexistent row and skips it',
        )
      } else {
        let header = -1
        for (let i = idLine - 1; i >= 0; i -= 1) {
          if (/^- /.test(lines[i])) {
            header = i
            break
          }
        }
        const headerLine = header === -1 ? '' : lines[header]
        if (!/^-\s+insert:\s*$/.test(headerLine)) {
          bad(`row at line ${idLine + 1} is nested under "${headerLine.trim()}", expected "- insert:"`)
        } else if (!lines.some((l) => /name:\s*'?"?dsh-codex-connector/.test(l))) {
          bad('row does not reference the package name')
        } else {
          ok('patch row -> tool-codex-connector (insert-wrapped)')
        }
      }
    }
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
