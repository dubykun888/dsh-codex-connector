'use strict'

// The capability catalog: the user-extensible extension point.
//
// A capability is one Markdown file with YAML frontmatter (DESIGN.md §3.2).
// Humans edit it directly, DSH edits it through the write tool, and it diffs
// well in git. Cards live at <workspace>/.dsh-codex/capabilities/*.md.
//
// Seeds ship inside this package (capabilities/) and are copied into a project
// on first use so a fresh project is never empty (DESIGN.md §3.1.1). Once
// copied they are ordinary project files: package upgrades never overwrite them.

const fs = require('node:fs')
const path = require('node:path')
const YAML = require('./frontmatter')

const CAPABILITY_DIR = path.join('.dsh-codex', 'capabilities')

function packageCapabilityDir() {
  return path.join(__dirname, '..', '..', 'capabilities')
}

function projectCapabilityDir(workspace) {
  return path.join(workspace, CAPABILITY_DIR)
}

function splitFrontmatter(text) {
  const normalized = String(text ?? '').replace(/^\uFEFF/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized)
  if (!m) return { frontmatter: null, body: normalized }
  return { frontmatter: m[1], body: m[2] }
}

function normalizeList(value) {
  if (value == null) return []
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

/** Validate a parsed card; returns an array of human-readable problems. */
function validateCard(card) {
  const problems = []
  if (!card.id) problems.push('missing required field: id')
  else if (!/^[a-z0-9][a-z0-9._-]*$/.test(card.id)) {
    problems.push(`id "${card.id}" must match [a-z0-9][a-z0-9._-]*`)
  }
  if (!card.description) problems.push('missing required field: description')
  if (!card.body || card.body.trim() === '') problems.push('body (prompt template) is empty')
  if (card.sandbox && !['read-only', 'workspace-write', 'danger-full-access'].includes(card.sandbox)) {
    problems.push(`sandbox must be read-only | workspace-write | danger-full-access (got "${card.sandbox}")`)
  }
  if (card.timeoutMs != null && (!Number.isFinite(Number(card.timeoutMs)) || Number(card.timeoutMs) <= 0)) {
    problems.push('timeoutMs must be a positive number')
  }
  return problems
}

/**
 * @param {string} text file content
 * @param {{ file?: string, source?: string, builtin?: boolean }} [meta]
 */
function parseCard(text, meta = {}) {
  const { frontmatter, body } = splitFrontmatter(text)
  if (frontmatter == null) {
    return {
      id: undefined,
      problems: ['no YAML frontmatter found (file must start with ---)'],
      file: meta.file,
      source: meta.source,
      body,
    }
  }
  let data
  try {
    data = YAML.parse(frontmatter) || {}
  } catch (error) {
    return {
      id: undefined,
      problems: [`frontmatter is not valid YAML: ${error.message}`],
      file: meta.file,
      source: meta.source,
      body,
    }
  }
  const card = {
    id: typeof data.id === 'string' ? data.id.trim() : undefined,
    title: data.title ? String(data.title) : undefined,
    description: data.description ? String(data.description) : undefined,
    triggers: normalizeList(data.triggers),
    engine: data.engine ? String(data.engine) : 'codex-exec',
    model: data.model ? String(data.model) : '',
    reasoningEffort: data.reasoningEffort ? String(data.reasoningEffort) : '',
    sandbox: data.sandbox ? String(data.sandbox) : 'workspace-write',
    skills: normalizeList(data.skills),
    workspace: data.workspace ? String(data.workspace) : 'session',
    output: data.output ? String(data.output) : 'text',
    timeoutMs: data.timeoutMs != null ? Number(data.timeoutMs) : 900000,
    background: data.background === true,
    artifacts: data.artifacts && typeof data.artifacts === 'object' ? data.artifacts : undefined,
    inputs: Array.isArray(data.inputs) ? data.inputs : [],
    body,
    file: meta.file,
    source: meta.source || 'project',
    builtin: Boolean(meta.builtin),
  }
  card.problems = validateCard(card)
  return card
}

/** Seed a project's catalog from this package's bundled capabilities. */
function bootstrap(workspace, options = {}) {
  const target = projectCapabilityDir(workspace)
  const created = []
  let existing = []
  try {
    existing = fs.readdirSync(target).filter((f) => f.endsWith('.md'))
  } catch {
    existing = []
  }
  if (existing.length > 0 && !options.force) {
    return { bootstrapped: false, created, target }
  }
  const seedDir = options.seedDir || packageCapabilityDir()
  let seeds = []
  try {
    seeds = fs.readdirSync(seedDir).filter((f) => f.endsWith('.md'))
  } catch (error) {
    return { bootstrapped: false, created, target, warning: `seed dir unreadable: ${error.message}` }
  }
  fs.mkdirSync(target, { recursive: true })
  for (const file of seeds) {
    const dest = path.join(target, file)
    if (fs.existsSync(dest) && !options.force) continue
    const raw = fs.readFileSync(path.join(seedDir, file), 'utf8')
    fs.writeFileSync(dest, withSeedBanner(raw), 'utf8')
    created.push(dest)
  }
  return { bootstrapped: created.length > 0, created, target }
}

/**
 * Mark a seeded card as project-owned WITHOUT breaking frontmatter.
 *
 * The banner must land in the body, after the closing `---`. Putting any line
 * before the opening `---` makes the file fail frontmatter parsing outright,
 * which silently produced an empty catalog the first time this was written
 * (see the regression test in scripts/selftest.cjs).
 */
function withSeedBanner(raw) {
  const banner =
    '<!-- managed by dsh-codex-connector -->\n' +
    '<!-- Seeded from dsh-codex-connector. This is now a PROJECT file: edit it freely;\n' +
    '     package upgrades will not overwrite it. Delete it to be re-seeded. -->'
  const { frontmatter, body } = splitFrontmatter(raw)
  if (frontmatter == null) return `${raw}\n${banner}\n`
  return `---\n${frontmatter}\n---\n\n${banner}\n${body.replace(/^\s*\n/, '')}`
}

/**
 * Load the catalog for a workspace. Project cards are the only writable root;
 * seeds are used read-only when the project has none (and are reported as such).
 */
function loadCatalog(workspace, options = {}) {
  if (options.bootstrap !== false) bootstrap(workspace, options)
  const cards = []
  const problems = []
  const projectDir = projectCapabilityDir(workspace)

  let files = []
  try {
    files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.md'))
  } catch {
    files = []
  }
  const seen = new Map()
  for (const file of files) {
    const full = path.join(projectDir, file)
    const card = parseCard(fs.readFileSync(full, 'utf8'), {
      file: full,
      source: 'project',
      builtin: false,
    })
    if (card.problems && card.problems.length > 0) {
      problems.push({ file: full, problems: card.problems })
      continue
    }
    // Two files may declare the same id. Letting the first silently win made
    // routing depend on directory order (found by review), so a duplicate is
    // reported and the later definition dropped rather than shadowing.
    const prior = seen.get(card.id)
    if (prior) {
      problems.push({
        file: full,
        problems: [
          `duplicate id "${card.id}" already defined in ${path.basename(prior)}; this file was ignored`,
        ],
      })
      continue
    }
    seen.set(card.id, file)
    cards.push(card)
  }
  return { cards, problems, dir: projectDir }
}

function findCard(cards, id) {
  if (!id) return undefined
  const wanted = String(id).trim().toLowerCase()
  return cards.find((c) => c.id && c.id.toLowerCase() === wanted)
}

/** Crude but predictable keyword scoring. Returns [] when nothing matches. */
function matchCards(cards, query, limit = 3) {
  const q = String(query || '').toLowerCase().trim()
  if (q === '') return []
  const qWords = q.split(/[\s,，。;；/]+/).filter((w) => w.length >= 2)

  const scored = []
  for (const card of cards) {
    let score = 0
    const reasons = []
    const id = (card.id || '').toLowerCase()
    const title = (card.title || '').toLowerCase()
    const desc = (card.description || '').toLowerCase()

    if (id && q.includes(id)) {
      score += 10
      reasons.push(`id "${card.id}" appears verbatim`)
    }
    for (const t of card.triggers) {
      const trig = t.toLowerCase()
      if (trig && q.includes(trig)) {
        score += 6
        reasons.push(`trigger "${t}"`)
      }
    }
    for (const w of qWords) {
      if (title.includes(w)) {
        score += 3
        reasons.push(`title contains "${w}"`)
      }
      if (desc.includes(w)) {
        score += 2
        reasons.push(`description contains "${w}"`)
      }
    }
    if (score > 0) scored.push({ card, score, reasons: [...new Set(reasons)].slice(0, 4) })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

module.exports = {
  CAPABILITY_DIR,
  bootstrap,
  findCard,
  loadCatalog,
  matchCards,
  packageCapabilityDir,
  parseCard,
  projectCapabilityDir,
  splitFrontmatter,
  validateCard,
  withSeedBanner,
}
