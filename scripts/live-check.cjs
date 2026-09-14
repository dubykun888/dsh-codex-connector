#!/usr/bin/env node
'use strict'

// Live end-to-end check: the real Codex CLI, the real worker, real artifacts.
//
// This is intentionally NOT part of `selftest`: every call costs a minute or
// more (measured: 122-126s per call on this network), so it only runs when
// asked for explicitly.
//
//   node scripts/live-check.cjs [--workspace <dir>] [--with-image] [--quick]
//
// It exercises the same code path the Cordis plugin uses, so a pass here is
// evidence about the shipped implementation, not a parallel re-implementation.

const path = require('node:path')
const fs = require('node:fs')

const { createWorkers } = require('../lib/workers/workers')
const { spawn } = require('../lib/workers/spawn')

const args = process.argv.slice(2)
function flag(name) {
  return args.includes(`--${name}`)
}
function option(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const workspace = path.resolve(option('workspace', path.join(__dirname, '..')))
const withImage = flag('with-image')
const quick = flag('quick')

const workers = createWorkers({ spawn, defaultWorkspace: workspace })

const results = []
function step(name, ok, detail) {
  results.push({ name, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}\n`)
  if (detail !== undefined) {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)
    process.stdout.write(
      text
        .split('\n')
        .slice(0, 30)
        .map((l) => `        ${l}`)
        .join('\n') + '\n',
    )
  }
}

async function main() {
  process.stdout.write(`\nworkspace: ${workspace}\n\n`)

  // ---- 1. locate + auth + catalog -----------------------------------------
  const status = await workers.status({ workspace })
  step('codex_status locates the CLI', status.codex.found === true, {
    path: status.codex.path,
    source: status.codex.source,
    version: status.codex.version,
    loggedIn: status.codex.loggedIn,
  })
  if (!status.codex.found) {
    step('aborting: no Codex CLI', false, status.codex.error)
    return finish()
  }
  step('catalog loaded', status.catalog.count > 0, { count: status.catalog.count, ids: status.catalog.ids })

  // ---- 2. project registration --------------------------------------------
  const registration = await workers.project({ action: 'register', workspace })
  step('project registered', registration.registered === true, {
    filesCreated: registration.filesCreated,
    trust: registration.trust,
    configEffective: registration.configEffective,
    warnings: registration.warnings,
  })
  const agentsPath = path.join(workspace, 'AGENTS.md')
  step('project knowledge carrier exists', fs.existsSync(path.join(workspace, '.codex', 'project', 'PROJECT.md')))

  // ---- 3. routing ----------------------------------------------------------
  const routed = await workers.codexDo({ workspace, task: '随便说点什么' })
  step(
    'unmatched task refuses instead of guessing',
    routed.routed === false && routed.ok === false,
    { error: routed.error, available: (routed.available || []).map((c) => c.id) },
  )

  if (quick) return finish()

  // ---- 4. a real, minimal Codex run ---------------------------------------
  const t0 = Date.now()
  const run = await workers.codexDo({
    workspace,
    mode: 'force',
    task: 'Reply with exactly the single word: CONNECTOR_OK',
    sandbox: 'read-only',
    timeoutMs: 600000,
  })
  step('live run completed', run.ok === true, {
    ok: run.ok,
    runId: run.runId,
    threadId: run.threadId,
    elapsedMs: run.elapsedMs,
    summary:
      typeof run.summary === 'string' && run.summary.length > 160
        ? `${run.summary.slice(0, 160)}…`
        : run.summary,
    binary: run.binary,
    envSuppressed: run.envSuppressed,
    warnings: run.warnings,
    errors: run.errors,
  })
  step('run finished in a plausible time', Date.now() - t0 < 15 * 60 * 1000)

  const runDir = path.join(workspace, '.dsh-codex', 'runs', run.runId || '')
  step('run ledger written', fs.existsSync(path.join(runDir, 'events.jsonl')), runDir)

  const report = {
    workspace,
    codex: { path: status.codex.path, source: status.codex.source, version: status.codex.version },
    catalogIds: status.catalog.ids,
    trust: registration.trust,
    configEffective: registration.configEffective,
    run: run.ok
      ? { ok: true, runId: run.runId, threadId: run.threadId, elapsedMs: run.elapsedMs, artifacts: run.artifacts }
      : { ok: false, errors: run.errors, warnings: run.warnings },
  }

  // ---- 5. optional: the real imagegen path --------------------------------
  if (withImage) {
    process.stdout.write('\n  (image probe: this is the expensive one)\n')
    const img = await workers.codexDo({
      workspace,
      capability: 'image.generate',
      inputs: {
        prompt: 'a simple flat red circle centered on a white background',
        count: '1',
        size: '1024x1024',
      },
      timeoutMs: 900000,
    })
    step('imagegen produced a recovered artifact', img.ok === true && img.artifacts.length > 0, {
      ok: img.ok,
      elapsedMs: img.elapsedMs,
      artifacts: img.artifacts,
      sources: img.artifactSources,
      errors: img.errors,
      warnings: img.warnings,
    })
    report.image = { ok: img.ok, artifacts: img.artifacts }
  }

  fs.mkdirSync(path.join(workspace, '.dsh-codex'), { recursive: true })
  fs.writeFileSync(
    path.join(workspace, '.dsh-codex', 'last-live-check.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  )
  void agentsPath
  return finish()
}

function finish() {
  const failed = results.filter((r) => !r.ok)
  process.stdout.write(`\n${results.length - failed.length} passed, ${failed.length} failed\n`)
  if (failed.length > 0) {
    process.stdout.write(`failed: ${failed.map((f) => f.name).join(', ')}\n`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  process.stdout.write(`\nlive-check crashed: ${error.stack || error.message}\n`)
  process.exitCode = 1
})
