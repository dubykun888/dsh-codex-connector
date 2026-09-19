'use strict'

// Tool implementations. Each returns plain JSON-safe data — no live objects,
// no class instances, nothing that cannot cross a process boundary.

const fs = require('node:fs')
const path = require('node:path')

const runs = require('../core/runs')
const catalog = require('../core/catalog')
const project = require('../core/project')
const trust = require('../core/trust')
const codexRun = require('../core/codex-run')
const { buildPrompt } = require('../core/prompt')
const { locateCodex } = require('../core/locate')
const { serializeCard } = require('../core/serialize')

/**
 * @param {{ spawn: Function, defaultWorkspace?: string }} deps
 */
function createWorkers(deps) {
  const spawn = deps.spawn
  // Optional approval gate. Present => trust writes are consented; absent =>
  // they are refused (see the grant-trust branch).
  const pickWorkspace = (args) => path.resolve(args.workspace || args.cwd || deps.defaultWorkspace || process.cwd())

  function capabilityHealthOf(ws, id) {
    return runs.capabilityHealth(ws, id)
  }

  // ---------------------------------------------------------------- status --
  async function status(args = {}) {
    const ws = pickWorkspace(args)
    const out = { workspace: ws, codex: {}, catalog: {}, project: {} }

    try {
      const located = codexRun.resolveBinary(ws, args)
      out.codex.found = true
      out.codex.path = located.path
      out.codex.source = located.source
      const v = await safeSpawn(spawn, [located.path, '--version'], ws)
      out.codex.version = firstLine(v.stdout) || firstLine(v.stderr) || '(unknown)'
      const login = await safeSpawn(spawn, [located.path, 'login', 'status'], ws)
      out.codex.loggedIn = /Logged in/i.test(`${login.stdout}${login.stderr}`)
      out.codex.loginDetail = firstLine(login.stdout) || firstLine(login.stderr) || ''
    } catch (error) {
      out.codex.found = false
      out.codex.error = error.message
      out.codex.probes = error.probes
    }

    try {
      const loaded = catalog.loadCatalog(ws)
      out.catalog = {
        dir: loaded.dir,
        count: loaded.cards.length,
        ids: loaded.cards.map((c) => c.id),
        invalid: loaded.problems,
        health: Object.fromEntries(
          loaded.cards.map((c) => [c.id, capabilityHealthOf(ws, c.id) || { status: 'unverified' }]),
        ),
      }
    } catch (error) {
      out.catalog.error = error.message
    }

    out.project = project.status(ws, args)
    out.ok = out.codex.found
    return out
  }

  // ------------------------------------------------------------ project ----
  async function projectTool(args = {}) {
    const ws = pickWorkspace(args)
    const action = args.action || 'status'
    switch (action) {
      case 'status':
        return { ok: true, action, ...project.status(ws, args) }
      case 'register':
      case 'refresh': {
        const res = project.register(ws, {
          adopt: args.adopt === true,
          codexHome: args.codexHome,
          force: action === 'refresh' && args.force === true,
        })
        if (res.needsAdoption) return { ok: false, action, ...res }
        return { ok: true, action, ...res }
      }
      case 'grant-trust': {
        // Writing to the USER-level Codex config affects every Codex session on
        // this machine, so it is gated on a real approval channel when one
        // exists. The gate is skipped only once the write is known to be a
        // no-op (already trusted), so repeat calls do not re-prompt.
        const before = trust.resolveTrust(ws, { codexHome: args.codexHome })
        if (!before.trusted && deps.requestApproval) {
          const verdict = await deps.requestApproval(ws, {
            summary:
              'dsh-codex-connector 需要写入你的用户级 Codex 配置 (~/.codex/config.toml)，' +
              '为该项目添加一条 trust_level = "trusted"。这会影响本机所有 Codex 会话。',
            details: { workspace: ws, reason: before.reason, entry: trust.keyFor(ws) },
          })
          if (verdict !== 'approved') {
            return {
              ok: false,
              action,
              denied: true,
              reason: verdict,
              note:
                '未授权，未做任何写入。项目知识（AGENTS.md / .codex/project/）不受影响，' +
                '仍然照常生效；只有项目级执行策略需要这次授权。',
              status: project.status(ws, args),
            }
          }
        }
        if (!before.trusted && !deps.requestApproval) {
          return {
            ok: false,
            action,
            reason: 'no-approval-channel',
            note:
              '本部署没有可用的审批通道，因此拒绝隐式改写你的用户级 Codex 配置。' +
              '如需授权，请手动加入: [projects.\'' + trust.keyFor(ws) + '\'] trust_level = "trusted"',
            status: project.status(ws, args),
          }
        }
        const res = trust.grantTrust(ws, { codexHome: args.codexHome })
        return { ok: res.changed || /already|covered/i.test(res.reason || ''), action, ...res, status: project.status(ws, args) }
      }
      case 'revoke-trust': {
        const res = trust.revokeTrust(ws, { codexHome: args.codexHome })
        // ok must reflect whether anything actually changed; hardcoding true hid
        // a no-op from callers (found by review).
        return { ok: res.changed === true, action, ...res, status: project.status(ws, args) }
      }
      default:
        return { ok: false, error: `unknown action "${action}"`, allowed: ['status', 'register', 'refresh', 'grant-trust', 'revoke-trust'] }
    }
  }

  // -------------------------------------------------------------- catalog --
  async function capabilities(args = {}) {
    const ws = pickWorkspace(args)
    const loaded = catalog.loadCatalog(ws)
    if (args.id) {
      const card = catalog.findCard(loaded.cards, args.id)
      if (!card) {
        return {
          ok: false,
          error: `no capability "${args.id}"`,
          suggestions: catalog.matchCards(loaded.cards, args.id).map((m) => m.card.id),
        }
      }
      return { ok: true, card: publicCard(card), health: capabilityHealthOf(ws, card.id) }
    }
    const cards = args.query ? catalog.matchCards(loaded.cards, args.query, 10) : loaded.cards.map((c) => ({ card: c, score: null, reasons: [] }))
    return {
      ok: true,
      dir: loaded.dir,
      count: loaded.cards.length,
      invalid: loaded.problems,
      matched: cards.map((m) => ({
        ...publicCard(m.card),
        health: capabilityHealthOf(ws, m.card.id),
        matchScore: m.score,
        matchReasons: m.reasons,
      })),
    }
  }

  // ------------------------------------------------------------ skill write --
  async function skillWrite(args = {}) {
    const ws = pickWorkspace(args)
    const dir = catalog.projectCapabilityDir(ws)
    if (!args.id) return { ok: false, error: 'id is required' }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(args.id)) {
      return { ok: false, error: `id "${args.id}" must match [a-z0-9][a-z0-9._-]*` }
    }
    const file = path.join(dir, `${args.id}.md`)
    const exists = fs.existsSync(file)
    if (exists && args.overwrite !== true) {
      return {
        ok: false,
        error: `capability "${args.id}" already exists; read it first, then pass overwrite: true to revise it`,
        file,
        existing: fs.readFileSync(file, 'utf8'),
      }
    }
    let content = args.content
    if (!content) {
      if (!args.fields) return { ok: false, error: 'provide either content (full markdown) or fields' }
      content = composeCard(args.id, args.fields)
    }
    const parsed = catalog.parseCard(content, { file, source: 'project' })
    if (parsed.problems && parsed.problems.length > 0) {
      return { ok: false, error: 'card is invalid', problems: parsed.problems, content }
    }
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf8')
    runs.markDraft(ws, args.id)
    project.writeCapabilitiesDoc(ws)
    return {
      ok: true,
      file,
      id: args.id,
      overwritten: exists,
      next: `run codex_do with capability "${args.id}" (or codex_skill_verify) to move it out of draft`,
    }
  }

  // ----------------------------------------------------------- skill verify --
  async function skillVerify(args = {}) {
    const ws = pickWorkspace(args)
    const loaded = catalog.loadCatalog(ws)
    const card = catalog.findCard(loaded.cards, args.id)
    if (!card) return { ok: false, error: `no capability "${args.id}"` }
    const probe = args.probeInputs || defaultProbeInputs(card)

    // Cheap pre-flight BEFORE spending a real Codex call (2+ minutes each).
    // Prompt assembly already catches missing required inputs and unfilled
    // placeholders at zero cost, so a malformed card is reported instantly
    // rather than after minutes of network time.
    for (const inputs of probe) {
      try {
        buildPrompt(card, inputs, { workspace: ws, runId: 'preflight' })
      } catch (error) {
        return {
          ok: false,
          capability: card.id,
          phase: 'preflight',
          error: error.message,
          code: error.code || null,
          probeInputs: inputs,
          next:
            '这是零成本预检，未调用 Codex。修正能力卡的 inputs 声明或正文占位符后重试；' +
            '若只是探针缺参数，可在 probeInputs 里显式给出。',
        }
      }
    }

    const attempted = []
    for (const inputs of probe) {
      const res = await doRun({ ...args, workspace: ws, capability: card.id, inputs, verify: true })
      attempted.push({ inputs, ok: res.ok, runId: res.runId, elapsedMs: res.elapsedMs, errors: res.errors })
      if (res.ok) {
        return { ok: true, capability: card.id, probeInputs: inputs, runId: res.runId, elapsedMs: res.elapsedMs, artifacts: res.artifacts, attempted }
      }
    }
    const rootCause = await diagnose(ws, attempted)
    return {
      ok: false,
      capability: card.id,
      phase: 'live',
      attempted,
      diagnosis: rootCause,
      hint: '修正能力卡后重试；连续失败达阈值会自动标记为 needs-review 并退出 auto 选择。',
    }
  }

  // ------------------------------------------------------------------ do ----
  async function codexDo(args = {}) {
    const ws = pickWorkspace(args)
    const loaded = catalog.loadCatalog(ws)
    let card
    let matchInfo

    if (args.capability) {
      card = catalog.findCard(loaded.cards, args.capability)
      if (!card) {
        return {
          ok: false,
          error: `no capability "${args.capability}"`,
          suggestions: catalog.matchCards(loaded.cards, args.capability).map((m) => m.card.id),
          available: loaded.cards.map((c) => c.id),
        }
      }
    } else if (args.mode !== 'force') {
      const matches = catalog.matchCards(loaded.cards, args.task || '')
      if (matches.length === 0) {
        return {
          ok: false,
          routed: false,
          error: 'no capability matched this task',
          task: args.task,
          available: loaded.cards.map((c) => ({ id: c.id, title: c.title, description: c.description })),
          next:
            '不要猜测。要么用 codex_do(mode="force", task=…) 直接把原始任务交给 Codex，' +
            '要么用 codex_skill_write 新增一张能力卡后再调用。',
        }
      }
      const best = matches[0]
      card = best.card
      matchInfo = { score: best.score, reasons: best.reasons, runnerUp: matches.slice(1).map((m) => m.card.id) }
      if (matches.length > 1 && matches[1].score >= best.score) {
        return {
          ok: false,
          routed: false,
          error: 'ambiguous: two capabilities scored equally',
          candidates: matches.map((m) => ({ id: m.card.id, score: m.score })),
          next: '指定 capability 明确其一。',
        }
      }
    }
    return doRun({ ...args, workspace: ws, capability: card ? card.id : undefined, card, matchInfo })
  }

  async function doRun(args) {
    const ws = path.resolve(args.workspace)
    const card = args.card
    const health = card ? capabilityHealthOf(ws, card.id) : undefined
    if (card && health && health.status === 'needs-review' && args.verify !== true) {
      return {
        ok: false,
        error: `capability "${card.id}" is marked needs-review after repeated failures; refusing to auto-run it`,
        health,
        next: '修复能力卡后调用 codex_skill_verify 复审。',
      }
    }

    const runId = runs.newRunId()
    let prompt
    if (card) {
      // A card carries its own task text, so `{ capability, inputs }` is a
      // complete call. Only forward `task` when it was actually given: passing
      // `undefined` through would put a non-lossless value in the result and
      // make the harness reject it with a message about JSON, not about args.
      const cardInputs = { ...(args.inputs || {}) }
      if (typeof args.task === 'string' && args.task.trim() !== '') cardInputs.task = args.task
      const built = buildPrompt(card, cardInputs, { workspace: ws, runId })
      prompt = built.prompt
    } else {
      if (typeof args.task !== 'string' || args.task.trim() === '') {
        return {
          ok: false,
          error:
            'either `task` (what Codex should do) or `capability` (a card that carries its own task text) is required',
        }
      }
      prompt = args.task
      if (args.mode === 'force') {
        prompt = `${prompt}\n\n---\n运行上下文:\n- 工作区绝对路径: ${ws}\n- 完成后逐行列出你实际写出的文件绝对路径。`
      }
    }
    if (!prompt || prompt.trim() === '') return { ok: false, error: 'empty prompt' }

    const sandbox = args.sandbox || (card ? card.sandbox : undefined) || 'workspace-write'
    const result = await codexRun.run(
      {
        workspace: ws,
        capability: card ? card.id : undefined,
        prompt,
        sandbox,
        // Only a value passed on the call itself may authorise danger; a card
        // default must not. See codex-run.js SANDBOX_NOT_AUTHORIZED.
        sandboxExplicit: args.sandbox !== undefined,
        model: args.model || (card ? card.model : undefined),
        reasoningEffort: args.reasoningEffort || (card ? card.reasoningEffort : undefined),
        timeoutMs: args.timeoutMs || (card ? card.timeoutMs : undefined),
        artifacts: card ? card.artifacts : args.artifacts,
        resumeThreadId: args.resumeThreadId || (args.continueThread && card ? runs.lastThreadId(ws, card.id) : undefined),
        background: args.background,
        runId,
      },
      spawn,
    )
    if (card) project.writeCapabilitiesDoc(ws)
    return { ...result, match: args.matchInfo, health: card ? capabilityHealthOf(ws, card.id) : undefined }
  }

  return { status, project: projectTool, capabilities, skillWrite, skillVerify, codexDo }
}

// ------------------------------------------------------------------ helpers --

function publicCard(card) {
  return {
    id: card.id,
    title: card.title,
    description: card.description,
    triggers: card.triggers,
    engine: card.engine,
    sandbox: card.sandbox,
    skills: card.skills,
    artifacts: card.artifacts,
    inputs: card.inputs,
    output: card.output,
    file: card.file,
  }
}

function firstLine(text) {
  const line = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !/^(WARNING|codex\.exe|At line:|CategoryInfo|FullyQualifiedErrorId|\+)/.test(l))
  return line || ''
}

async function safeSpawn(spawn, argv, cwd) {
  try {
    return await spawn({ argv, cwd, stdin: undefined, timeoutMs: 60000, graceMs: 3000 })
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: error.message, elapsedMs: 0 }
  }
}

function composeCard(id, fields) {
  const fm = {
    id,
    title: fields.title || id,
    description: fields.description || '',
    triggers: fields.triggers || [],
    engine: fields.engine || 'codex-exec',
    sandbox: fields.sandbox || 'workspace-write',
    skills: fields.skills || [],
    output: fields.output || 'text',
    timeoutMs: fields.timeoutMs || 900000,
  }
  if (fields.model) fm.model = fields.model
  if (fields.reasoningEffort) fm.reasoningEffort = fields.reasoningEffort
  if (fields.artifacts) fm.artifacts = fields.artifacts
  if (fields.inputs) fm.inputs = fields.inputs
  const body = fields.body || `执行任务：{{task}}\n\n完成后给出结论与实际写出的文件路径。`
  return `${serializeCard(fm)}\n${body}\n`
}

function defaultProbeInputs(card) {
  const base = { task: '用最小代价验证该能力可用：执行一次最简单的真实调用即可，不要做额外发挥。' }
  const values = {}
  for (const input of card.inputs || []) {
    if (!input || !input.name) continue
    if (input.default !== undefined) values[input.name] = input.default
  }
  const probes = [{ ...base, ...values }]
  if (!('prompt' in values)) probes.push({ ...base, ...values, prompt: '一个简单的深色背景方形图标，纯色几何形状' })
  return probes
}

async function diagnose(ws, attempted) {
  const messages = attempted.flatMap((a) => a.errors || [])
  if (messages.length === 0) return '运行未完成但未报明确错误；检查超时与网络。'
  const joined = messages.join(' \n')
  if (/not supported when using Codex with a ChatGPT account/i.test(joined)) {
    return '模型名不被当前 ChatGPT 账号支持：能力卡里的 model 需要改成账号可用的模型，或留空继承默认。'
  }
  if (/skill/i.test(joined) && /not (found|available)/i.test(joined)) {
    return '依赖的 skill 不存在：核对能力卡的 skills 字段，或从能力卡与 prompt 中移除它。'
  }
  if (/timed out|timeout/i.test(joined)) return '超时：提高 timeoutMs，或改为 background 运行。'
  return `运行报错：${messages[0]}`
}

module.exports = { createWorkers, composeCard, publicCard }
