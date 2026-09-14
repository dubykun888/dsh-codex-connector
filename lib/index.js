'use strict'

// Cordis plugin shell (HOST plane).
//
// This file is the shippable composition row. It owns:
//   - the `codex` Service (programmatic access for other host rows)
//   - the model-facing tools, registered into the host `tools` registry
//   - a spawn adapter over `ctx.subprocess` so a run inherits the HOST
//     execution world. That matters: `codex exec` must write its own
//     $CODEX_HOME (app-server socket, tmp, several sqlite DBs), which the
//     session file sandbox denies outright (measured: os error 5). A model-side
//     shell call can never do this; a host service can.
//
// Every side effect is owned by this fiber and unwound with it.

const path = require('node:path')
const { spawn: nodeSpawn } = require('node:child_process')

const { createWorkers } = require('./workers/workers')
const { compileParameters } = require('./tools-schema')

const WORKER = path.join(__dirname, 'workers', 'worker.js')

function textBlocks(text) {
  return [{ type: 'text', text: String(text) }]
}

function renderJson(_args, value) {
  if (value === undefined || value === null) return textBlocks('(no result)')
  if (typeof value === 'string') return textBlocks(value)
  try {
    return textBlocks(JSON.stringify(value, null, 2))
  } catch (error) {
    return textBlocks(`[result was not JSON-serialisable: ${error.message}]`)
  }
}

function readText(reader) {
  if (!reader) return ''
  try {
    const out = reader.readFrom(0)
    return out && typeof out.text === 'string' ? out.text : ''
  } catch (error) {
    return `[output unreadable: ${error.message}]`
  }
}

/** Spawn adapter over ctx.subprocess so callers get the same shape as nodeSpawn. */
function makeSubprocessSpawn(subprocess) {
  return function spawnViaService(spec) {
    const started = Date.now()
    let handle
    try {
      handle = subprocess.spawn({
        argv: spec.argv,
        cwd: spec.cwd,
        stdio: {
          stdin: spec.stdin === undefined ? 'ignore' : { data: String(spec.stdin) },
          stdout: { maxBytes: 8 * 1024 * 1024 },
          stderr: { maxBytes: 1024 * 1024 },
        },
        graceMs: spec.graceMs || 5000,
        env: spec.env,
      })
    } catch (error) {
      return Promise.reject(error)
    }
    let timedOut = false
    let timer
    if (spec.timeoutMs && Number.isFinite(spec.timeoutMs)) {
      timer = setTimeout(() => {
        timedOut = true
        try {
          handle.terminate()
        } catch {
          /* already gone */
        }
      }, spec.timeoutMs)
    }
    const clear = () => {
      if (timer) clearTimeout(timer)
    }
    return Promise.resolve(handle.done).then(
      (outcome) => {
        clear()
        return {
          exitCode: outcome ? outcome.exitCode : null,
          signal: outcome ? outcome.signal : null,
          stdout: readText(handle.collected && handle.collected.stdout),
          stderr: readText(handle.collected && handle.collected.stderr),
          elapsedMs: Date.now() - started,
          timedOut,
        }
      },
      (error) => {
        clear()
        throw error
      },
    )
  }
}

/** Fallback for shells without ctx.subprocess: run the worker in a child Node. */
function makeWorkerCliSpawn(defaultWorkspace) {
  return function spawnWorkerCli(spec) {
    const execPath = process.execPath
    if (!execPath) return Promise.reject(new Error('process.execPath unavailable'))
    return nodeSpawn(execPath, [WORKER, JSON.stringify(spec)], {
      cwd: defaultWorkspace || process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
}

// Argument specs use ONE dialect: a property map where each entry is the type
// spec itself, with `required: true` marking a required argument. They are
// compiled to raw JSON Schema by ./tools-schema before registration.

const TOOL_SPECS = [
  {
    name: 'codex_status',
    worker: 'status',
    description:
      'Health check for the Codex connection: whether the CLI was located (and by which probe), its version, whether it is logged in, how many capability cards this project has, and whether the project is registered and trusted.',
    parameters: {
      workspace: { type: 'string', description: 'Workspace directory. Defaults to the session workspace.' },
      cwd: { type: 'string', description: 'Alias for workspace.' },
      codexHome: { type: 'string', description: 'Override $CODEX_HOME.' },
      codexBinary: { type: 'string', description: 'Override the codex executable path.' },
    },
  },
  {
    name: 'codex_project',
    worker: 'project',
    description:
      'Register or inspect this workspace as a Codex project. Writes project knowledge into <workspace>/.codex/ (project profile, capability list, root marker) that Codex reads on every run. Registration is idempotent and never modifies an existing AGENTS.md. Execution policy in .codex/config.toml only takes effect for a trusted project, so this reports configEffective honestly instead of assuming it.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'register', 'refresh', 'grant-trust', 'revoke-trust'],
        description:
          'status = report only; register = create/complete project info; refresh = also rewrite the generated profile; grant-trust / revoke-trust = edit the USER-level Codex config and therefore need consent.',
      },
      workspace: { type: 'string', description: 'Workspace directory. Defaults to the session workspace.' },
      cwd: { type: 'string', description: 'Alias for workspace.' },
      adopt: {
        type: 'boolean',
        description:
          'Set true to allow writing into a .codex/ directory this tool did not create. Without it, a foreign .codex/ is left completely untouched.',
      },
      force: { type: 'boolean', description: 'With refresh: rewrite generated docs even if present.' },
      codexHome: { type: 'string', description: 'Override $CODEX_HOME.' },
    },
  },
  {
    name: 'codex_capabilities',
    worker: 'capabilities',
    description:
      'List, rank or read the Codex capability catalog (<workspace>/.dsh-codex/capabilities/*.md). Without arguments it returns every card plus its health; with query it ranks cards by keyword match and shows why each matched; with id it returns one card in full.',
    parameters: {
      workspace: { type: 'string', description: 'Workspace directory. Defaults to the session workspace.' },
      cwd: { type: 'string', description: 'Alias for workspace.' },
      query: { type: 'string', description: 'Task text to rank capabilities against.' },
      id: { type: 'string', description: 'Exact capability id to read.' },
    },
  },
  {
    name: 'codex_skill_write',
    worker: 'skillWrite',
    description:
      'Create or revise one Codex capability card (Markdown with YAML frontmatter) in .dsh-codex/capabilities/. This is the extension point: a new card is how the catalog learns a new thing Codex can do. Refuses to overwrite an existing card unless overwrite is true, so it must be read first. New cards start as draft until verified.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Capability id matching [a-z0-9][a-z0-9._-]* — also the file name (<id>.md).',
      },
      content: {
        type: 'string',
        description: 'Full card markdown (frontmatter + prompt body). Preferred over fields.',
      },
      fields: {
        type: 'object',
        description:
          'Structured alternative to content: {title, description, triggers, sandbox, skills, artifacts, inputs, body}.',
      },
      overwrite: { type: 'boolean', description: 'Must be true to revise an existing card.' },
      workspace: { type: 'string', description: 'Workspace directory. Defaults to the session workspace.' },
      cwd: { type: 'string', description: 'Alias for workspace.' },
    },
  },
  {
    name: 'codex_skill_verify',
    worker: 'skillVerify',
    description:
      'Verify a capability card. Runs a zero-cost pre-flight first (missing inputs / unfilled placeholders are reported instantly), then ONE real, tightly-scoped Codex call. On success the card leaves draft; on failure it returns a diagnosis (model unavailable for this account, missing skill, timeout) rather than a raw stack. Repeated failures mark the card needs-review so auto-routing stops selecting it.',
    parameters: {
      id: { type: 'string', required: true, description: 'Capability id to verify.' },
      probeInputs: {
        type: 'array',
        items: { type: 'object' },
        description: 'Optional list of input objects to try in order instead of the defaults.',
      },
      workspace: { type: 'string', description: 'Workspace directory. Defaults to the session workspace.' },
      cwd: { type: 'string', description: 'Alias for workspace.' },
    },
  },
  {
    name: 'codex_do',
    worker: 'codexDo',
    description:
      'Run a Codex session. Give a capability id, or a plain task that gets matched against the capability catalog. If nothing matches, this REFUSES and returns the catalog rather than guessing. Not for routine coding or file work: one call takes two minutes or more here.',
    parameters: {
      task: { type: 'string', required: true, description: 'What Codex should do, in natural language.' },
      capability: { type: 'string', description: 'Exact capability id to force.' },
      mode: {
        type: 'string',
        enum: ['auto', 'force'],
        description: 'auto (default) routes through the catalog; force sends the task as-is without routing.',
      },
      inputs: {
        type: 'object',
        description: 'Values for the capability card placeholders, e.g. {prompt, count}.',
      },
      workspace: { type: 'string', description: 'Workspace directory. Defaults to the session workspace.' },
      cwd: { type: 'string', description: 'Alias for workspace.' },
      model: { type: 'string', description: 'Override the model.' },
      sandbox: {
        type: 'string',
        enum: ['read-only', 'workspace-write', 'danger-full-access'],
        description:
          'Override the sandbox. danger-full-access is honoured ONLY when passed here explicitly; a capability card default cannot grant it.',
      },
      continueThread: {
        type: 'boolean',
        description: 'Continue the previous session for this capability via `codex exec resume`.',
      },
      timeoutMs: { type: 'number', description: 'Override the timeout in milliseconds (default 900000).' },
    },
  },
]

/**
 * Build the plugin. The loader adopts either an object with name/apply/inject or
 * a function; exporting BOTH shapes (named keys plus createPlugin) keeps this
 * working under ESM interop and plain CommonJS.
 * @param {object} [config]
 */
function createPlugin(config = {}) {
  const defaultWorkspace = config.defaultWorkspace

  function apply(ctx) {
    const subprocess = ctx.get('subprocess')
    const tools = ctx.get('tools')
    const jobs = ctx.get('jobs')
    const approval = ctx.get('approval')

    if (!tools || typeof tools.register !== 'function') {
      // Without the tool registry there is nothing to contribute; say so rather
      // than half-mounting a service nobody can reach.
      console.error('[dsh-codex-connector] tool registry unavailable; this row contributed nothing')
      return
    }

    const spawn = subprocess ? makeSubprocessSpawn(subprocess) : require('./workers/spawn').spawn
    const workerCliSpawn = makeWorkerCliSpawn(defaultWorkspace)
    void workerCliSpawn

    // Route user-level config writes through the approval service when the
    // deployment has one. Without it, grant-trust refuses rather than writing.
    const requestApproval = async (workspace, request) => {
      if (!approval || typeof approval.request !== 'function') return 'no-approval-channel'
      try {
        const outcome = await approval.request({
          kind: 'codex-connector.trust-write',
          title: 'Codex 连接器请求修改用户级配置',
          summary: request.summary,
          details: request.details,
        })
        if (outcome === true) return 'approved'
        if (outcome === false) return 'rejected'
        if (outcome && typeof outcome === 'object') {
          if (outcome.approved === true || outcome.decision === 'approved' || outcome.decision === 'allow') {
            return 'approved'
          }
          if (outcome.approved === false || outcome.decision === 'rejected' || outcome.decision === 'deny') {
            return 'rejected'
          }
        }
        return 'no-approval-channel'
      } catch (error) {
        return `approval-failed: ${error.message}`
      }
    }

    const workers = createWorkers({ spawn, defaultWorkspace, requestApproval })

    /** Resolve the workspace for one call: explicit arg, then the caller's cwd. */
    function workspaceFor(args, exec) {
      if (args) {
        if (typeof args.workspace === 'string' && args.workspace.trim() !== '') return args.workspace
        if (typeof args.cwd === 'string' && args.cwd.trim() !== '') return args.cwd
      }
      try {
        const cwd = exec && exec.agent && exec.agent.session ? exec.agent.session.cwd : undefined
        if (typeof cwd === 'string' && cwd !== '') return cwd
      } catch {
        /* fall through */
      }
      return defaultWorkspace || process.cwd()
    }

    async function invoke(workerName, args, exec) {
      const handler = workers[workerName]
      if (typeof handler !== 'function') {
        return { ok: false, error: `unknown worker "${workerName}"` }
      }
      return handler({ ...(args || {}), workspace: workspaceFor(args, exec) })
    }

    // ------------------------------------------------------------ Service ---
    const service = {
      async run(args) {
        return invoke('codexDo', args)
      },
      async capabilities(args = {}) {
        return invoke('capabilities', args)
      },
      async status(args = {}) {
        return invoke('status', args)
      },
      async project(args = {}) {
        return invoke('project', args)
      },
      /** Locate the CLI without running anything. */
      async binary(args = {}) {
        const { resolveBinary } = require('./core/codex-run')
        const located = resolveBinary(args.workspace || defaultWorkspace || process.cwd(), args)
        return { path: located.path, source: located.source }
      },
      describe() {
        return {
          name: 'dsh-codex-connector',
          spawnMode: subprocess ? 'subprocess' : 'node-child',
          workerCli: WORKER,
          jobsAvailable: Boolean(jobs),
          workspace: defaultWorkspace || process.cwd(),
        }
      },
    }
    if (typeof ctx.provide === 'function') {
      ctx.effect(() => ctx.provide('codex', service), 'codex service')
    }

    // -------------------------------------------------------------- Tools ---
    for (const spec of TOOL_SPECS) {
      // Compile once, at registration, so a malformed schema fails during
      // mount instead of on the first call (the registry only asserts
      // output.schema, so parameters errors would otherwise surface late).
      const parameters = compileParameters(spec.parameters)
      const definition = {
        name: spec.name,
        description: spec.description,
        parameters,
        output: { schema: {}, render: renderJson },
        async execute(args, exec) {
          try {
            return await invoke(spec.worker, args, exec)
          } catch (error) {
            return {
              ok: false,
              error: error && error.message ? error.message : String(error),
              code: (error && error.code) || null,
              runId: (error && error.runId) || null,
              binary: (error && error.binary) || null,
            }
          }
        },
      }
      ctx.effect(() => tools.register(definition), `codex tool ${spec.name}`)
    }
  }

  return { name: 'dsh-codex-connector', apply }
}

module.exports = {
  name: 'dsh-codex-connector',
  // `subprocess` is a hard dependency: without the host execution world a run
  // cannot start at all, because the session file sandbox denies Codex its own
  // home directory. `tools` is where the definitions land.
  inject: ['subprocess', 'tools'],
  apply: createPlugin().apply,
  createPlugin,
  TOOL_SPECS,
  makeSubprocessSpawn,
  makeWorkerCliSpawn,
}
