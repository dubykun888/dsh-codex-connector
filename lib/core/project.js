'use strict'

// Project registration: make a DSH workspace a first-class Codex project.
//
// Field-measured facts this encodes (DESIGN.md §6):
//   - Codex's project-level config is <repo>/.codex/config.toml, but it is
//     GATED BY TRUST; `AGENTS.md` is not. So knowledge and execution policy are
//     delivered through different carriers, and we never pretend the policy
//     half took effect when it did not.
//   - project_root_markers defaults to [".git"], so a NON-git workspace has no
//     determinable project root. We anchor it on `.codex` instead.
//   - the root AGENTS.md is ALSO read by DSH's own agent-instructions row.
//     Rewriting it would silently change DSH's own prompt, so an existing file
//     is frozen: byte-identical before and after.
//   - a `.codex/` we did not create is the user's, and is not touched without
//     explicit adoption.

const fs = require('node:fs')
const path = require('node:path')

const facts = require('./project-facts')
const trust = require('./trust')
const catalog = require('./catalog')
const runs = require('./runs')

const MANAGED_MARKER = '<!-- managed by dsh-codex-connector'
const OWNERSHIP_FILE = '.dsh-codex/project.json'
const AGENTS_MARKER = '<!-- dsh-codex-connector:project-pointer -->'
const ROOT_MARKERS_LINE = 'project_root_markers = [".git", ".codex"]'

function ownershipFile(workspace) {
  return path.join(workspace, OWNERSHIP_FILE)
}

function readOwnership(workspace) {
  try {
    return JSON.parse(fs.readFileSync(ownershipFile(workspace), 'utf8'))
  } catch {
    return undefined
  }
}

function writeOwnership(workspace, data) {
  const file = ownershipFile(workspace)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  return data
}

function codexDir(workspace) {
  return path.join(workspace, '.codex')
}

/** Does a .codex/ exist that carries our mark?
 *
 *  Multi-signal on purpose: `runs.js` writes `.codex/project/HISTORY.md` as a
 *  run side effect, which can create `.codex/` BEFORE registration has recorded
 *  ownership. A single-signal check then classified our own directory as
 *  foreign and froze every later run (a self-inflicted deadlock found in the
 *  first live check). */
function isOurs(workspace) {
  // 1. The ownership record is authoritative, but its CONTENT must be ours —
  //    a file that merely exists (or holds `{}`) is not evidence.
  const own = readOwnership(workspace)
  if (own && own.managedBy === 'dsh-codex-connector') return true

  const dshDir = path.join(codexDir(workspace), 'dsh')

  // 2. notes.md must actually carry our marker, on its first line.
  if (startsWithMarker(path.join(dshDir, 'notes.md'))) return true

  // 3. binding.json must carry our managedBy.
  try {
    const binding = JSON.parse(fs.readFileSync(path.join(dshDir, 'binding.json'), 'utf8'))
    if (binding && binding.managedBy === 'dsh-codex-connector') return true
  } catch {
    /* absent, or not ours */
  }

  // 4. Generated docs carry the marker on the FIRST line. Matching anywhere in
  //    the file would let a user's own note that merely QUOTES the marker hand
  //    us their directory — the most dangerous direction of this check.
  const projectDir = path.join(codexDir(workspace), 'project')
  let entries = []
  try {
    entries = fs.readdirSync(projectDir)
  } catch {
    return false
  }
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    if (startsWithMarker(path.join(projectDir, entry))) return true
  }
  return false
}

/** True only when the file's first line IS our management marker. */
function startsWithMarker(file) {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(512)
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
      return buffer.subarray(0, read).toString('utf8').startsWith(MANAGED_MARKER)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false
  }
}

/** Claim ownership. Must run BEFORE any other write into .codex/, so a crash
 *  midway can never leave a directory we own looking foreign. */
function claimOwnership(workspace) {
  return writeOwnership(workspace, {
    managedBy: 'dsh-codex-connector',
    schema: 1,
    registeredAt: (readOwnership(workspace) || {}).registeredAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
}

/** Ensure `.codex/config.toml` exists and carries the root marker, without
 *  clobbering anything the user already put there.
 *
 *  Subtlety: an EXISTING config.toml is treated the same way as an existing
 *  AGENTS.md — we do not rewrite it. A config.toml that predates us means the
 *  user already owns project-level Codex config; appending our marker into it
 *  would be the same class of mistake as editing their instructions. We add the
 *  marker only to a file we are creating. */
function ensureProjectRootMarker(workspace) {
  const dir = codexDir(workspace)
  const file = path.join(dir, 'config.toml')
  fs.mkdirSync(dir, { recursive: true })

  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8')
    if (/^\s*project_root_markers\s*=/m.test(text)) {
      return { file, added: false, reason: 'project_root_markers already present (left untouched)' }
    }
    return {
      file,
      added: false,
      foreign: true,
      reason:
        '既有 .codex/config.toml 属于用户，未修改（与 AGENTS.md 同等对待）。' +
        '若需要项目根锚点，请手动加入: ' + ROOT_MARKERS_LINE,
    }
  }

  const header =
    '# Codex 项目级配置。注意：本文件仅在项目被标记为可信时生效；\n' +
    '# 项目知识请走 AGENTS.md 与 .codex/project/（不受信任门禁影响）。\n'
  fs.writeFileSync(file, `${header}${ROOT_MARKERS_LINE}\n`, 'utf8')
  return { file, added: true }
}

function ensureProjectDir(workspace) {
  const dir = path.join(codexDir(workspace), 'project')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeProjectDoc(workspace, options = {}) {
  const dir = ensureProjectDir(workspace)
  const file = path.join(dir, 'PROJECT.md')
  const prof = facts.profile(workspace)
  if (fs.existsSync(file) && !options.force) {
    return { file, written: false, prof }
  }
  const body = `${MANAGED_MARKER} — 可自由修改 -->\n\n${facts.renderProjectDoc(workspace, prof)}`
  fs.writeFileSync(file, body, 'utf8')
  return { file, written: true, prof }
}

function writeCapabilitiesDoc(workspace) {
  const dir = ensureProjectDir(workspace)
  const file = path.join(dir, 'CAPABILITIES.md')
  const { cards } = catalog.loadCatalog(workspace)
  const lines = [
    `${MANAGED_MARKER}; 由能力目录自动生成 -->`,
    '',
    '# 可用的 Codex 能力（能力卡）',
    '',
    '> 本文件由 `dsh-codex-connector` 从 `.dsh-codex/capabilities/` 生成。',
    '> 修改能力请改能力卡，不要改本文件。',
    '',
  ]
  if (cards.length === 0) {
    lines.push('（当前项目没有能力卡）')
  } else {
    for (const card of cards) {
      lines.push(`## \`${card.id}\`${card.title ? ` — ${card.title}` : ''}`)
      lines.push('')
      if (card.description) lines.push(card.description)
      lines.push('')
      if (card.skills && card.skills.length > 0) lines.push(`- 依赖 skill: ${card.skills.join(', ')}`)
      if (card.artifacts && card.artifacts.collectTo) lines.push(`- 产物目录: \`${card.artifacts.collectTo}\``)
      lines.push(`- 沙箱: \`${card.sandbox}\``)
      lines.push('')
    }
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
  return { file, count: cards.length }
}

function renderAgentsPointer() {
  return [
    AGENTS_MARKER,
    '# 项目说明',
    '',
    '本项目已登记为 Codex 项目。项目知识在 `.codex/project/` 下：',
    '',
    '- `.codex/project/PROJECT.md` —— 技术栈、常用命令、目录结构',
    '- `.codex/project/CAPABILITIES.md` —— 可用的 Codex 能力清单与产物约定',
    '',
    '执行策略在 `.codex/config.toml`（仅当项目被标记为可信时生效）。',
  ].join('\n')
}

/**
 * Create the root AGENTS.md ONLY when absent. An existing one is frozen: it is
 * also DSH's own instruction source, so rewriting it would change DSH's prompt.
 */
function ensureAgentsFile(workspace) {
  const file = path.join(workspace, 'AGENTS.md')
  if (fs.existsSync(file)) {
    return { file, created: false, frozen: true }
  }
  fs.writeFileSync(file, `${renderAgentsPointer()}\n`, 'utf8')
  return { file, created: true, frozen: false }
}

function ensureNotes(workspace) {
  const dir = path.join(codexDir(workspace), 'dsh')
  fs.mkdirSync(dir, { recursive: true })
  const notes = path.join(dir, 'notes.md')
  const binding = path.join(dir, 'binding.json')
  fs.writeFileSync(
    notes,
    [
      `${MANAGED_MARKER} -->`,
      '',
      '# 关于 `.codex/dsh/`',
      '',
      '本目录由 DSH 的 `dsh-codex-connector` 维护，用于说明「这个项目为什么有 `.codex/`」。',
      '删除本目录不会破坏项目；下次调用 Codex 时会重新生成。',
      '',
      '真实状态在同级目录之外：`.dsh-codex/`（本机可重建）。',
      '',
    ].join('\n'),
    'utf8',
  )
  return { notes, binding }
}

function bindingInfo(workspace, extra = {}) {
  const existing = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(codexDir(workspace), 'dsh', 'binding.json'), 'utf8'))
    } catch {
      return {}
    }
  })()
  return {
    schema: 1,
    projectId: existing.projectId || path.basename(path.resolve(workspace)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-'),
    workspace: path.resolve(workspace),
    registeredAt: existing.registeredAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    managedBy: 'dsh-codex-connector',
    ...extra,
  }
}

function status(workspace, options = {}) {
  const ws = path.resolve(workspace)
  const trustState = trust.resolveTrust(ws, options.codexHome)
  const own = readOwnership(ws)
  const hasCodexDir = fs.existsSync(codexDir(ws))
  const agentsFile = path.join(ws, 'AGENTS.md')
  return {
    workspace: ws,
    registered: Boolean(own) || isOurs(ws),
    projectType: facts.detectGit(ws).isRepo ? 'git' : 'non-git',
    codexDir: { exists: hasCodexDir, ours: isOurs(ws), path: codexDir(ws) },
    agentsMd: { exists: fs.existsSync(agentsFile), path: agentsFile },
    trust: {
      trusted: trustState.trusted,
      reason: trustState.reason,
      via: trustState.via || null,
      entryCount: trustState.entries.length,
    },
    configEffective: trustState.trusted,
  }
}

/**
 * Register (idempotent).
 * @param {string} workspace
 * @param {{ adopt?: boolean, codexHome?: string, force?: boolean }} [options]
 */
function register(workspace, options = {}) {
  const ws = path.resolve(workspace)
  const result = {
    workspace: ws,
    filesCreated: [],
    warnings: [],
    adopted: false,
  }

  const hasCodexDir = fs.existsSync(codexDir(ws))
  const ours = isOurs(ws)
  if (hasCodexDir && !ours && !options.adopt) {
    // Never touch a .codex/ we did not create without explicit adoption.
    const summary = []
    try {
      for (const entry of fs.readdirSync(codexDir(ws))) summary.push(entry)
    } catch {
      /* ignore */
    }
    return {
      ...result,
      registered: false,
      needsAdoption: true,
      existing: summary,
      message:
        '检测到既有 .codex/ 目录（非本工具创建）。未做任何写入。' +
        '确认可接管后，用 adopt: true 重新调用。',
      status: status(ws, options),
    }
  }
  if (options.adopt) result.adopted = true

  // 0. claim ownership FIRST. Everything below may create or extend `.codex/`,
  //    and a later failure must not leave a directory we own looking foreign.
  claimOwnership(ws)

  // 1. seed the capability catalog (project files; package never overwrites)
  const seeded = catalog.bootstrap(ws, options.force ? { force: true } : {})
  result.filesCreated.push(...seeded.created)

  // 2. project root marker
  const marker = ensureProjectRootMarker(ws)
  if (marker.added) result.filesCreated.push(marker.file)
  else if (marker.reason) result.warnings.push(marker.reason)

  // 3. project knowledge
  const doc = writeProjectDoc(ws, options)
  if (doc.written) result.filesCreated.push(doc.file)
  const caps = writeCapabilitiesDoc(ws)
  result.filesCreated.push(caps.file)

  // 4. AGENTS.md pointer — created only when absent
  const agents = ensureAgentsFile(ws)
  if (agents.created) result.filesCreated.push(agents.file)
  else result.warnings.push('AGENTS.md 已存在 → 未修改（它是 DSH 自身指令来源，保持冻结）')

  // 5. DSH binding notes
  const { notes, binding } = ensureNotes(ws)
  fs.writeFileSync(binding, `${JSON.stringify(bindingInfo(ws, { projectType: status(ws, options).projectType }), null, 2)}\n`, 'utf8')
  result.filesCreated.push(notes, binding)

  // 6. trust is REPORTED, never granted implicitly
  const trustState = trust.resolveTrust(ws, options.codexHome)
  result.trust = {
    trusted: trustState.trusted,
    reason: trustState.reason,
    via: trustState.via || null,
  }
  result.configEffective = trustState.trusted
  if (!trustState.trusted) {
    result.warnings.push(
      '项目级执行策略（.codex/config.toml）本次不会生效：项目未被标记为可信。' +
        '项目知识仍通过 AGENTS.md 生效。需要执行策略时请显式授权（codex_project action=grant-trust）。',
    )
  }

  result.registered = true
  result.status = status(ws, options)
  return result
}

module.exports = {
  AGENTS_MARKER,
  MANAGED_MARKER,
  claimOwnership,
  codexDir,
  ensureAgentsFile,
  ensureProjectRootMarker,
  isOurs,
  readOwnership,
  register,
  status,
  writeCapabilitiesDoc,
  writeOwnership,
  writeProjectDoc,
}
