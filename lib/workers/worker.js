'use strict'

// Tool worker: JSON in on argv[2], JSON out on stdout.
//
// This exists so the SAME implementation serves two shells:
//   - the Cordis plugin package (lib/index.js) calls createWorkers directly
//   - a Cordis dynamic plugin (or any shell without Node builtins) can run this
//     file as a child process: node lib/workers/worker.js '<json>'
//
// It is also why the dynamic-plugin verification path is honest: it exercises
// the real code, not a re-implementation.

const { createWorkers } = require('./workers')
const { spawn } = require('./spawn')

async function main() {
  const raw = process.argv[2]
  if (!raw) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'usage: worker.js <json-spec>' }))
    process.exitCode = 2
    return
  }
  let spec
  try {
    spec = JSON.parse(raw)
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: `invalid JSON spec: ${error.message}` }))
    process.exitCode = 2
    return
  }
  const workers = createWorkers({ spawn, defaultWorkspace: process.cwd() })
  const handler = workers[spec.tool]
  if (typeof handler !== 'function') {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: `unknown tool "${spec.tool}"`,
        available: Object.keys(workers),
      }),
    )
    process.exitCode = 2
    return
  }
  try {
    const result = await handler(spec.args || {})
    process.stdout.write(JSON.stringify(result ?? null))
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: error.message,
        code: error.code || null,
        runId: error.runId || null,
      }),
    )
    process.exitCode = 1
  }
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: `worker crashed: ${error.message}` }))
  process.exitCode = 1
})
