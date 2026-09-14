#!/usr/bin/env node
'use strict'

// Install this package into a DSH profile, or remove it again.
//
//   node scripts/install.mjs --profile web                  # install (interactive-safe: prints a plan first)
//   node scripts/install.mjs --profile web --apply          # actually write
//   node scripts/install.mjs --profile web --preset standard --apply
//   node scripts/install.mjs --profile web --uninstall --apply
//
// What it touches, and what it refuses to touch:
//   - $DSH_HOME/profiles/<profile>/package.json          (adds/removes ONE dependency)
//   - $DSH_HOME/profiles/<profile>/cordis.patch.yml      (adds/removes ONE row)
//   - $DSH_HOME/.agent-presets/<preset>/agent.cordis.yml (only with --preset; a COPY)
//
// It NEVER edits a shipped bundle (@deepseek-ai/dsh-base, dsh-web-app) and never
// edits a shipped preset in place: --preset copies the shipped preset first.
//
// Every write is backed up, and a failure restores the backups.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROW_ID = 'tool-codex-connector'
const PKG_NAME = 'dsh-codex-connector'
const PRESET_ROW_ID = 'tool-codex-connector'

const args = process.argv.slice(2)
const flag = (n) => args.includes(`--${n}`)
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}

const selfDir = path.resolve(__dirname, '..')
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profile = opt('profile', 'web')
const presetId = opt('preset', null)
const apply = flag('apply')
const uninstall = flag('uninstall')

const profileDir = path.join(dshHome, 'profiles', profile)
const profilePkg = path.join(profileDir, 'package.json')
const patchFile = path.join(profileDir, 'cordis.patch.yml')
const userPresetRoot = path.join(dshHome, '.agent-presets')

const log = (m) => process.stdout.write(`${m}\n`)
const plan = []

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function backup(file) {
  if (!fs.existsSync(file)) return undefined
  const to = `${file}.dshcc-backup`
  fs.copyFileSync(file, to)
  return to
}

function restore(file, backupPath) {
  if (backupPath && fs.existsSync(backupPath)) fs.copyFileSync(backupPath, file)
}

function dropBackup(backupPath) {
  if (backupPath && fs.existsSync(backupPath)) fs.unlinkSync(backupPath)
}

// ---------------------------------------------------------------------- plan --

if (!fs.existsSync(profileDir)) {
  log(`profile not found: ${profileDir}`)
  log('list profiles under: ' + path.join(dshHome, 'profiles'))
  process.exit(2)
}
if (!fs.existsSync(profilePkg)) {
  log(`profile package.json not found: ${profilePkg}`)
  process.exit(2)
}

const linkSpec = `link:${selfDir.replace(/\\/g, '/')}`

log(`package : ${selfDir}`)
log(`profile : ${profileDir}`)
log(`mode    : ${uninstall ? 'UNINSTALL' : 'INSTALL'}${apply ? '' : ' (dry run — pass --apply to write)'}`)
log('')

const pkg = readJson(profilePkg)
const currentDep = (pkg.dependencies || {})[PKG_NAME]
if (uninstall) {
  plan.push(`package.json: remove dependency ${PKG_NAME}${currentDep ? ` (currently ${currentDep})` : ' (absent)'}`)
} else {
  plan.push(
    currentDep
      ? `package.json: dependency ${PKG_NAME} already present as ${currentDep} → leave as is`
      : `package.json: add dependency ${PKG_NAME} = "${linkSpec}"`,
  )
}

const patchText = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : ''
const patchHasRow = patchText.includes(`id: ${ROW_ID}`)
if (uninstall) {
  plan.push(`cordis.patch.yml: remove row ${ROW_ID}${patchHasRow ? '' : ' (absent)'}`)
} else {
  plan.push(
    patchHasRow
      ? `cordis.patch.yml: row ${ROW_ID} already present → leave as is`
      : `cordis.patch.yml: append one row (${ROW_ID} → ${PKG_NAME})`,
  )
}

if (presetId && !uninstall) {
  const target = path.join(userPresetRoot, presetId)
  plan.push(
    fs.existsSync(target)
      ? `preset ${presetId}: exists at ${target} → add tool row if missing`
      : `preset ${presetId}: copy from the shipped preset, then add the tool row`,
  )
} else if (presetId && uninstall) {
  plan.push(`preset ${presetId}: remove tool row ${PRESET_ROW_ID} if present`)
} else {
  plan.push('preset: not requested (--preset <id> also wires the tools into a session preset)')
}

for (const line of plan) log(`  • ${line}`)
log('')

if (!apply) {
  log('dry run complete. Re-run with --apply to perform these changes.')
  log('After applying: restart DSH so the Host mounts the new row.')
  process.exit(0)
}

// --------------------------------------------------------------------- apply --

const backups = []
let presetFile

try {
  // 1. profile package.json
  const pkgBackup = backup(profilePkg)
  backups.push([profilePkg, pkgBackup])
  const nextPkg = readJson(profilePkg)
  nextPkg.dependencies = nextPkg.dependencies || {}
  if (uninstall) delete nextPkg.dependencies[PKG_NAME]
  else if (!nextPkg.dependencies[PKG_NAME]) nextPkg.dependencies[PKG_NAME] = linkSpec
  fs.writeFileSync(profilePkg, `${JSON.stringify(nextPkg, null, 2)}\n`, 'utf8')
  log(`updated ${profilePkg}`)

  // 2. cordis.patch.yml
  const patchBackup = backup(patchFile)
  backups.push([patchFile, patchBackup])
  let text = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : ''
  const row = [
    `- id: ${ROW_ID}`,
    `  name: '${PKG_NAME}'`,
    '  config:',
    '    defaultWorkspace: !!js process.cwd()',
  ].join('\n')

  if (uninstall) {
    text = removeRow(text, ROW_ID)
  } else if (!text.includes(`id: ${ROW_ID}`)) {
    text = appendRow(text, row)
  }
  fs.writeFileSync(patchFile, text, 'utf8')
  log(`updated ${patchFile}`)

  // 3. optional preset wiring
  if (presetId) {
    fs.mkdirSync(userPresetRoot, { recursive: true })
    const target = path.join(userPresetRoot, presetId)
    if (!fs.existsSync(target)) {
      const shipped = findShippedPreset(presetId)
      if (!shipped) throw new Error(`shipped preset "${presetId}" not found; pass an existing user preset id`)
      copyDir(shipped, target)
      log(`copied shipped preset → ${target}`)
    }
    presetFile = path.join(target, 'agent.cordis.yml')
    const presetBackup = backup(presetFile)
    backups.push([presetFile, presetBackup])
    let presetText = fs.readFileSync(presetFile, 'utf8')
    if (uninstall) {
      presetText = removeRow(presetText, PRESET_ROW_ID)
    } else if (!presetText.includes(`id: ${PRESET_ROW_ID}`)) {
      presetText +=
        '\n# ── codex connector ────────────────────────────────────────────────────────\n' +
        '# Consumes the HOST-plane `codex` service and registers the model-facing\n' +
        '# tools for this preset\'s agents. Resolves the host tools registry, so it\n' +
        '# must NOT sit behind an isolate realm of its own.\n' +
        row +
        '\n'
    }
    fs.writeFileSync(presetFile, presetText, 'utf8')
    log(`updated ${presetFile}`)
  }

  for (const [, b] of backups) dropBackup(b)

  log('')
  log('done. Next steps:')
  log(`  1. cd "${profileDir}" && pnpm install      # link the package`)
  log('  2. restart DSH                              # the Host mounts the new row')
  log('  3. in a session: codex_status               # should report the CLI and the catalog')
  if (presetId) log(`  4. start sessions on preset "${presetId}" to get the codex_* tools`)
} catch (error) {
  log(`\nFAILED: ${error.message}`)
  log('restoring backups...')
  for (const [file, b] of backups) {
    try {
      restore(file, b)
      dropBackup(b)
    } catch (restoreError) {
      log(`  could not restore ${file}: ${restoreError.message}`)
    }
  }
  log('restored. Nothing was left half-applied.')
  process.exit(1)
}

// ------------------------------------------------------------------- helpers --

function appendRow(text, rowYaml) {
  const trimmed = text.replace(/\s*$/, '')
  // Files that are just an empty loader list `[]` need the bracket removed.
  if (trimmed === '[]') {
    return `${rowYaml}\n`
  }
  return `${trimmed}\n\n${rowYaml}\n`
}

function removeRow(text, id) {
  const lines = text.split(/\r?\n/)
  const out = []
  let skipping = false
  for (const line of lines) {
    if (/^-\s+id:\s/.test(line)) {
      skipping = line.includes(`id: ${id}`)
      if (skipping) continue
    }
    if (skipping) {
      // row content is indented or a nested key; a new top-level row ends it
      if (/^-\s+/.test(line)) {
        skipping = false
      } else {
        continue
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

function findShippedPreset(id) {
  const candidates = [
    path.join(selfDir, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', id),
  ]
  for (const base of [path.join(dshHome, 'profiles'), dshHome]) {
    candidates.push(path.join(base, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', id))
  }
  return candidates.find((c) => fs.existsSync(c))
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dest)
    else fs.copyFileSync(src, dest)
  }
}
