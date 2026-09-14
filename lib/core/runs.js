'use strict'

// Run ledger: per-run metadata, raw events, capability health counters, and the
// thread-id bookkeeping that makes `codex exec resume` possible.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const STATE_DIR = '.dsh-codex'

/** Consecutive failures after which a capability leaves auto-routing. */
const FAILURE_LIMIT = 3

function stateFile(workspace) {
  return path.join(workspace, STATE_DIR, 'state.json')
}

function runsDir(workspace) {
  return path.join(workspace, STATE_DIR, 'runs')
}

function readState(workspace) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(workspace), 'utf8'))
  } catch {
    return { version: 1, capabilities: {}, runs: 0 }
  }
}

function writeState(workspace, state) {
  const file = stateFile(workspace)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return state
}

function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const suffix = crypto.randomBytes(3).toString('hex')
  return `${stamp}-${suffix}`
}

function beginRun(workspace, meta = {}) {
  const runId = meta.runId || newRunId()
  const dir = path.join(runsDir(workspace), runId)
  fs.mkdirSync(dir, { recursive: true })
  const record = {
    runId,
    startedAt: new Date().toISOString(),
    capability: meta.capability || null,
    cwd: meta.cwd || workspace,
    sandbox: meta.sandbox || null,
    background: Boolean(meta.background),
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return { runId, dir, record }
}

function writeEvents(dir, rawText) {
  if (rawText === undefined || rawText === null) return undefined
  const file = path.join(dir, 'events.jsonl')
  fs.writeFileSync(file, rawText, 'utf8')
  return file
}

function writeResult(dir, result) {
  fs.writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

/**
 * Record the outcome. Capability health drives the anti-degradation guardrails
 * (DESIGN.md §5): a card that keeps failing stops being auto-selected.
 */
function finishRun(workspace, runId, outcome = {}) {
  const state = readState(workspace)
  state.runs = (state.runs || 0) + 1
  state.lastRunId = runId
  state.lastRunAt = new Date().toISOString()

  const capability = outcome.capability
  if (capability) {
    const entry = state.capabilities[capability] || {
      ok: 0,
      failed: 0,
      // A card starts UNVERIFIED. Marking it 'verified' on creation would let a
      // never-tested card be auto-selected by mode=auto (found by review: a card
      // with one failure still reported status 'verified').
      status: 'draft',
      createdAt: new Date().toISOString(),
    }
    if (outcome.ok) {
      entry.ok += 1
      entry.failed = 0
      entry.everOk = true
      entry.status = 'verified'
    } else {
      entry.failed += 1
      // Escalation must not depend on the starting status. A card that has NEVER
      // succeeded stays 'draft' until it does, but one that has failed enough
      // times (ever) is 'needs-review' regardless of its current label — the
      // guardrail exists to stop auto-routing from repeating a known failure.
      // Escalation must not depend on the starting status, but it must still
      // respect the threshold: below it a never-succeeded card stays 'draft',
      // and at it the card escalates to 'needs-review' — from 'draft' or from
      // 'verified' alike.
      if (entry.failed >= FAILURE_LIMIT) entry.status = 'needs-review'
      else if (!entry.everOk) entry.status = 'draft'
    }
    entry.lastRunId = runId
    entry.lastRunAt = new Date().toISOString()
    entry.lastOk = Boolean(outcome.ok)
    if (outcome.threadId) entry.threadId = outcome.threadId
    if (outcome.verifiedAt) entry.verifiedAt = outcome.verifiedAt
    state.capabilities[capability] = entry
  }
  return writeState(workspace, state)
}

function markDraft(workspace, capabilityId) {
  const state = readState(workspace)
  const entry = state.capabilities[capabilityId] || { ok: 0, failed: 0 }
  entry.status = 'draft'
  entry.createdAt = entry.createdAt || new Date().toISOString()
  state.capabilities[capabilityId] = entry
  return writeState(workspace, state)
}

function capabilityHealth(workspace, capabilityId) {
  const state = readState(workspace)
  return state.capabilities[capabilityId]
}

function lastThreadId(workspace, capabilityId) {
  const entry = capabilityHealth(workspace, capabilityId)
  return entry && entry.threadId
}

/** Append one line to the human-readable project history (DESIGN.md §6.4).
 *
 *  NOTE: this runs as a side effect of ANY run, so it can create `.codex/`
 *  before a project registration has happened. It therefore carries the
 *  `managed by` marker, which `project.isOurs` accepts as an ownership signal —
 *  without it, our own directory looked foreign on the next run. */
function appendHistory(workspace, line) {
  const dir = path.join(workspace, '.codex', 'project')
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'HISTORY.md')
    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        '<!-- managed by dsh-codex-connector -->\n' +
          '# Codex 运行历史\n\n> 由 dsh-codex-connector 追加维护。每行一次运行。\n\n',
        'utf8',
      )
    }
    fs.appendFileSync(file, `- ${line}\n`, 'utf8')
    return file
  } catch {
    return undefined
  }
}

module.exports = {
  STATE_DIR,
  appendHistory,
  beginRun,
  capabilityHealth,
  finishRun,
  lastThreadId,
  markDraft,
  newRunId,
  readState,
  runsDir,
  stateFile,
  writeEvents,
  writeResult,
  writeState,
}
