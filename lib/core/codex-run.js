'use strict'

// The run orchestrator: argv assembly, spawn, event consumption, artifact
// recovery, and honest outcome reporting.
//
// Callers inject `spawn`. The worker uses a native Node spawn (it runs inside a
// real Node process); the Cordis plugin shell can supply a ctx.subprocess-backed
// implementation instead. Core logic stays identical either way, which is what
// prevents the "works in testing, breaks in the package" split.

const fs = require('node:fs')
const path = require('node:path')

const events = require('./events')
const artifacts = require('./artifacts')
const envmod = require('./env')
const { withLimit, withTransientRetry } = require('./parallel')
const runs = require('./runs')
const { locateCodex } = require('./locate')

const DEFAULT_TIMEOUT_MS = 900000

/** Argv for `codex exec`. Option order matters: `resume <id>` follows the exec options. */
function buildArgv(options) {
  const argv = [options.binary, 'exec', '--json']
  if (options.skipGitRepoCheck !== false) argv.push('--skip-git-repo-check')
  if (options.sandbox) argv.push('-s', options.sandbox)
  if (options.cwd) argv.push('-C', options.cwd)
  if (options.model) argv.push('-m', options.model)
  if (options.reasoningEffort) argv.push('-c', `model_reasoning_effort="${options.reasoningEffort}"`)
  if (options.lastMessageFile) argv.push('-o', options.lastMessageFile)
  if (options.ephemeral) argv.push('--ephemeral')
  if (options.resume) argv.push('resume', options.resume)
  if (options.extraArgs) argv.push(...options.extraArgs)
  if (options.review) argv.push('review')
  return argv
}

/** Reads config.json in the project state dir, tolerating absence/corruption. */
function readProjectConfig(workspace) {
  const file = path.join(workspace, runs.STATE_DIR, 'config.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function resolveBinary(workspace, options = {}) {
  const config = readProjectConfig(workspace)
  return locateCodex({
    override: options.binary || config.codexBinary,
    codexHome: options.codexHome || config.codexHome,
  })
}

/**
 * @param {object} request
 * @param {(spec: object) => Promise<{exitCode:number, stdout:string, stderr:string, elapsedMs:number}>} spawn
 */
async function run(request, spawn) {
  const workspace = path.resolve(request.workspace)
  const config = readProjectConfig(workspace)
  const sandbox = request.sandbox || config.defaultSandbox || 'workspace-write'
  const model = request.model || config.defaultModel || ''
  const timeoutMs = request.timeoutMs || config.timeoutMs || DEFAULT_TIMEOUT_MS
  const concurrency = request.concurrency || config.concurrency || 1

  // Danger is never inherited from a card default. A capability card may name
  // `sandbox: danger-full-access`, but that only becomes effective when the
  // CALLER passes sandbox explicitly; `sandboxExplicit` records that.
  if (sandbox === 'danger-full-access' && request.sandboxExplicit !== true) {
    const error = new Error(
      'danger-full-access must be requested explicitly on this call; a capability card default cannot grant it. ' +
        'Pass sandbox="danger-full-access" on the tool call itself.',
    )
    error.code = 'SANDBOX_NOT_AUTHORIZED'
    throw error
  }

  const located = resolveBinary(workspace, request)
  const { runId, dir } = runs.beginRun(workspace, {
    capability: request.capability,
    cwd: workspace,
    sandbox,
    background: request.background,
  })
  const lastMessageFile = path.join(dir, 'last-message.txt')

  const before = request.artifacts ? artifacts.snapshot(request.artifacts.patterns, { codexHome: request.codexHome }) : new Map()

  const argv = buildArgv({
    binary: located.path,
    sandbox,
    cwd: workspace,
    model: model || undefined,
    reasoningEffort: request.reasoningEffort,
    lastMessageFile,
    resume: request.resumeThreadId,
    ephemeral: request.ephemeral,
  })

  const { env, dropped } = envmod.buildEnv(process.env, {
    extra: config.envPassthrough || [],
    passthrough: config.envAllow || [],
  })

  const started = Date.now()
  let outcome
  try {
    const spawned = await withLimit(workspace, concurrency, () =>
      withTransientRetry(
        () =>
          spawn({
            argv,
            cwd: workspace,
            stdin: request.prompt,
            env,
            timeoutMs,
            graceMs: 5000,
          }),
        { retries: config.transientRetries ?? 1 },
      ),
    )
    outcome = spawned
  } catch (error) {
    runs.writeResult(dir, { ok: false, error: error.message, runId })
    runs.finishRun(workspace, runId, { capability: request.capability, ok: false })
    // Distinguish "the spawner itself failed" from "the command ran and then
    // failed". The previous wording claimed the process never started even when
    // a mid-session failure landed us here, which sends diagnoses the wrong way.
    const ranForMs = Date.now() - started
    const early = ranForMs < 1000
    const enriched = new Error(
      early
        ? `codex exec failed to start: ${error.message}`
        : `codex exec ran for ${Math.round(ranForMs / 1000)}s and then failed: ${error.message}`,
    )
    enriched.code = error.code || (early ? 'SPAWN_FAILED' : 'EXEC_FAILED')
    enriched.cause = error
    enriched.runId = runId
    enriched.binary = located.path
    throw enriched
  }

  const elapsedMs = outcome.elapsedMs ?? Date.now() - started
  const parsed = events.parseEvents(outcome.stdout)
  runs.writeEvents(dir, outcome.stdout)

  // `-o` is a convenience, not the source of truth: JSONL already carries the
  // agent message. A missing file degrades, it does not fail the run.
  let lastMessage
  try {
    lastMessage = fs.readFileSync(lastMessageFile, 'utf8').trim()
  } catch {
    lastMessage = undefined
  }

  // Artifact recovery: snapshot diff first, then cross-check the paths the agent
  // reported. Never synthesise a path from the thread id (DESIGN.md §1.3, §8).
  const reported = artifacts.pathsFromText(lastMessage || parsed.summary, { codexHome: request.codexHome })
  let collected = { collected: [], skipped: [], destRoot: undefined }
  if (request.artifacts && request.artifacts.patterns) {
    const after = artifacts.snapshot(request.artifacts.patterns, { codexHome: request.codexHome })
    const fresh = new Set(artifacts.diffNew(before, after))
    for (const file of reported) {
      if (request.artifacts.patterns.some((p) => artifacts.matchPath(artifacts.expand(p, request.codexHome), file))) {
        fresh.add(file)
      }
    }
    collected = artifacts.collect({
      files: [...fresh].sort(),
      workspace,
      collectTo: request.artifacts.collectTo,
      runId,
    })
  }

  const warnings = [...parsed.warnings]
  if (dropped.length > 0) warnings.push(`env: suppressed ${dropped.length} unrelated variable(s)`)
  if (collected.skipped.length > 0) warnings.push(`artifacts: ${collected.skipped.length} file(s) could not be copied`)

  // A killed run is NOT a success, even if the event stream happens to contain a
  // completed turn: the timeout fires on the wall clock, so `turn.completed` may
  // have arrived for an earlier phase while the agent was still working. Trusting
  // the event stream alone reported truncated timeouts as ok:true (found by
  // adversarial review, reproduced with a fake spawn).
  const timedOut = outcome.timedOut === true
  const ok = parsed.ok && !timedOut
  if (timedOut) {
    warnings.push(
      `timed out after ${Math.round(elapsedMs / 1000)}s and was terminated; ` +
        'the result may be truncated. Raise timeoutMs or run it in the background.',
    )
  } else if (outcome.exitCode !== 0 && parsed.ok) {
    warnings.push(`exit code ${outcome.exitCode} but turn completed; treating as success`)
  }

  const result = {
    // Success needs BOTH: the event stream completed without a real error, and
    // the process was not killed. The exit code alone is not the verdict — a
    // real run emitted four reconnect errors and still completed.
    ok,
    startedAt: new Date(started).toISOString(),
    runId,
    threadId: parsed.threadId,
    capability: request.capability || null,
    cwd: workspace,
    sandbox,
    model: model || null,
    elapsedMs,
    exitCode: outcome.exitCode,
    summary: lastMessage || parsed.summary,
    artifacts: collected.collected.map((c) => c.to),
    artifactSources: collected.collected.map((c) => c.from),
    usage: parsed.usage,
    errors: parsed.errors,
    warnings,
    envSuppressed: dropped.length,
    binary: { path: located.path, source: located.source },
    runDir: dir,
  }

  runs.writeResult(dir, result)
  runs.finishRun(workspace, runId, {
    capability: request.capability,
    ok: result.ok,
    threadId: parsed.threadId,
  })
  runs.appendHistory(
    workspace,
    `${result.startedAt || new Date().toISOString()} · capability=${request.capability || 'adhoc'} · ok=${result.ok} · ${Math.round(elapsedMs / 1000)}s · artifacts=${result.artifacts.length} · run=${runId}`,
  )

  return result
}

module.exports = { DEFAULT_TIMEOUT_MS, buildArgv, readProjectConfig, resolveBinary, run }
