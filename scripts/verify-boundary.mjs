#!/usr/bin/env node
// Boundary verification against the REAL harness validators.
//
//   node scripts/verify-boundary.mjs [--live]
//
// The offline selftest mirrors the harness rules so it can run anywhere. This
// script uses the actual validators the running DSH instance uses, loaded from
// the installed Profile, and exercises the two gates that can reject a call:
//
//   1. ARGUMENTS — the compiled parameter schema this plugin registers
//   2. RESULT    — dsh-util-values isJsonValue, which rejects anything that does
//                  not survive a JSON round trip
//
// It exists because a live call failed with
//
//   tool "codex_do" returned invalid output: value is not lossless JSON
//
// and that message pointed at the wrong layer: the actual cause was an argument
// the tool declared required while the call legitimately omitted it. Only a
// check against the real validators distinguishes the two.
//
// Requires an installed Profile (see README) because it loads harness packages.
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME, '.dsh')
const profile = process.env.DSH_PROFILE || 'web'
const requireFromProfile = createRequire(path.join(dshHome, 'profiles', profile, 'cordis.patch.yml'))

let isJsonValue
try {
  ;({ isJsonValue } = requireFromProfile('@deepseek-ai/dsh-util-values'))
  process.stdout.write('validators: harness @deepseek-ai/dsh-util-values\n')
} catch (error) {
  process.stdout.write(
    `validators: UNAVAILABLE (${error.message})\n` +
      `Install the plugin into a Profile first (README "安装"), or set DSH_HOME / DSH_PROFILE.\n`,
  )
  process.exit(2)
}

const requireRepo = createRequire(path.join(repo, 'package.json'))
const { createWorkers } = requireRepo('./lib/workers/workers.js')
const { spawn } = requireRepo('./lib/workers/spawn.js')
const { compileParameters } = requireRepo('./lib/tools-schema.js')
const { toLosslessJson, TOOL_SPECS } = requireRepo('./lib/index.js')

const workers = createWorkers({ spawn, defaultWorkspace: repo })
const live = process.argv.includes('--live')

let failures = 0
const fail = (message) => {
  failures += 1
  process.stdout.write(`FAIL ${message}\n`)
}

/** Gate 2: would the harness accept this value as a tool result? */
function checkResult(label, value) {
  const clean = toLosslessJson(value)
  const rawOk = isJsonValue(value)
  const cleanOk = isJsonValue(clean)
  if (cleanOk) {
    process.stdout.write(`ok   ${label}: lossless (raw=${rawOk} sanitised=${cleanOk})\n`)
  } else {
    fail(`${label}: sanitised result is still not lossless`)
    const probe = (v, p = '') => {
      if (v === undefined) return process.stdout.write(`       undefined at ${p}\n`)
      const t = typeof v
      if (t === 'function' || t === 'symbol' || t === 'bigint') return process.stdout.write(`       ${t} at ${p}\n`)
      if (t === 'number' && !Number.isFinite(v)) return process.stdout.write(`       non-finite at ${p}\n`)
      if (v === null || t !== 'object') return
      for (const k of Object.keys(v)) probe(v[k], p ? `${p}.${k}` : k)
    }
    probe(clean)
  }
  return clean
}

process.stdout.write('\n-- gate 1: registered parameter schemas --\n')
for (const spec of TOOL_SPECS) {
  let compiled
  try {
    compiled = compileParameters(spec.parameters)
  } catch (error) {
    fail(`${spec.name}: parameters do not compile (${error.message})`)
    continue
  }
  if (compiled.type !== 'object' || typeof compiled.properties !== 'object') {
    fail(`${spec.name}: compiled parameters are not an object schema`)
    continue
  }
  const required = compiled.required || []
  process.stdout.write(`ok   ${spec.name}: required=[${required.join(',')}]\n`)
}
// `task` must NOT be required: a capability card carries its own task text, and
// declaring it required rejected the legitimate `{ capability, inputs }` call.
{
  const doSpec = TOOL_SPECS.find((s) => s.name === 'codex_do')
  const compiled = compileParameters(doSpec.parameters)
  if ((compiled.required || []).includes('task')) {
    fail('codex_do declares `task` required; `{ capability, inputs }` would be rejected')
  } else {
    process.stdout.write('ok   codex_do: `task` is optional (a card may supply task text)\n')
  }
}

process.stdout.write('\n-- gate 2: real worker results --\n')
checkResult('capabilities(query)', await workers.capabilities({ workspace: repo, query: '画图' }))
checkResult('status', await workers.status({ workspace: repo }))
checkResult('project(status)', await workers.project({ workspace: repo, action: 'status' }))
checkResult('codex_do(unmatched task)', await workers.codexDo({ workspace: repo, task: '今天天气怎么样' }))
checkResult('codex_do(no task, no capability)', await workers.codexDo({ workspace: repo }))
checkResult('synthetic undefined-bearing result', {
  ok: true,
  threadId: undefined,
  artifacts: [],
  destRoot: undefined,
  usage: undefined,
})
{
  // A refused artifact collection is a real result shape that carries undefined.
  const artifacts = requireRepo('./lib/core/artifacts.js')
  checkResult(
    'artifact collection refusal',
    artifacts.collect({ files: [], workspace: repo, collectTo: '../outside' }),
  )
}

if (live) {
  process.stdout.write('\n-- live: real image task (takes minutes) --\n')
  const result = await workers.codexDo({
    workspace: repo,
    capability: 'image.generate',
    inputs: {
      prompt:
        'a minimal flat-design app icon: a single white compass needle on a deep indigo rounded square, no text, no watermark',
      count: '1',
      size: '1024x1024',
    },
  })
  const clean = checkResult('codex_do(image.generate) LIVE', result)
  process.stdout.write(`     ok=${clean.ok} elapsed=${Math.round((clean.elapsedMs || 0) / 1000)}s\n`)
  process.stdout.write(`     artifacts=${JSON.stringify(clean.artifacts || [])}\n`)
  process.stdout.write(`     errors=${JSON.stringify(clean.errors || [])}\n`)
  process.stdout.write(`     warnings=${JSON.stringify(clean.warnings || [])}\n`)
  if (!clean.ok) fail('the live image run did not succeed')
}

process.stdout.write(failures === 0 ? '\nBOUNDARY VERIFIED\n' : `\nBOUNDARY FAILURES: ${failures}\n`)
process.exitCode = failures === 0 ? 0 : 1
