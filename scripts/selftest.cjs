#!/usr/bin/env node
'use strict'

// Offline self-test: exercises every pure module with no network and no Codex
// call. Run with `npm run selftest` (or `node scripts/selftest.mjs`).
//
// Live probes that DO call Codex live in scripts/live-check.mjs, because they
// cost a minute or more per call and must never run implicitly.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const frontmatter = require('../lib/core/frontmatter')
const serialize = require('../lib/core/serialize')
const catalog = require('../lib/core/catalog')
const prompt = require('../lib/core/prompt')
const events = require('../lib/core/events')
const artifacts = require('../lib/core/artifacts')
const env = require('../lib/core/env')
const parallel = require('../lib/core/parallel')
const project = require('../lib/core/project')
const trust = require('../lib/core/trust')
const facts = require('../lib/core/project-facts')
const runs = require('../lib/core/runs')
const codexRun = require('../lib/core/codex-run')
const { composeCard } = require('../lib/workers/workers')

let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    process.stdout.write(`  ok   ${name}\n`)
  } catch (error) {
    failures.push({ name, error })
    process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`)
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`  ok   ${name}\n`)
  } catch (error) {
    failures.push({ name, error })
    process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`)
  }
}

function tmpdir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dshcc-${label}-`))
  return dir
}

process.stdout.write('\nfrontmatter\n')

test('parses scalars, lists and nested maps', () => {
  const parsed = frontmatter.parse(
    [
      'id: image.generate',
      'title: 生成图片',
      'description: "带引号的: 描述"',
      'triggers: [画一张图, 出图]',
      'timeoutMs: 900000',
      'sandbox: workspace-write',
      'artifacts:',
      '  patterns: ["$CODEX_HOME/generated_images/**/*.png"]',
      '  collectTo: assets/generated',
      'inputs:',
      '  - name: prompt',
      '    required: true',
      '  - name: count',
      '    required: false',
      '    default: "1"',
    ].join('\n'),
  )
  assert.equal(parsed.id, 'image.generate')
  assert.equal(parsed.title, '生成图片')
  assert.equal(parsed.description, '带引号的: 描述')
  assert.deepEqual(parsed.triggers, ['画一张图', '出图'])
  assert.equal(parsed.timeoutMs, 900000)
  assert.equal(parsed.artifacts.collectTo, 'assets/generated')
  assert.deepEqual(parsed.artifacts.patterns, ['$CODEX_HOME/generated_images/**/*.png'])
  assert.equal(parsed.inputs.length, 2)
  assert.equal(parsed.inputs[0].name, 'prompt')
  assert.equal(parsed.inputs[0].required, true)
  assert.equal(parsed.inputs[1].default, '1')
})

test('strips comments outside quotes', () => {
  const parsed = frontmatter.parse('a: 1 # trailing\nb: "x # y"\n')
  assert.equal(parsed.a, 1)
  assert.equal(parsed.b, 'x # y')
})

test('rejects tab indentation', () => {
  assert.throws(() => frontmatter.parse('a:\n\tb: 1\n'), /tabs/)
})

test('round-trips through the serializer', () => {
  const card = composeCard('demo.card', {
    title: '演示',
    description: '用于自测的卡片',
    triggers: ['演示', 'demo'],
    artifacts: { patterns: ['out/**/*.png'], collectTo: 'assets' },
    inputs: [{ name: 'task', required: true }],
    body: '执行：{{task}}',
  })
  const parsed = catalog.parseCard(card, { file: 'memory', source: 'project' })
  assert.deepEqual(parsed.problems, [])
  assert.equal(parsed.id, 'demo.card')
  assert.equal(parsed.title, '演示')
  assert.deepEqual(parsed.triggers, ['演示', 'demo'])
  assert.equal(parsed.artifacts.collectTo, 'assets')
  assert.equal(parsed.inputs[0].name, 'task')
})

process.stdout.write('\ncatalog\n')

test('validates and reports problems instead of throwing', () => {
  const bad = catalog.parseCard('no frontmatter here', { file: 'x', source: 'project' })
  assert.ok(bad.problems.length > 0)

  const missingId = catalog.parseCard('---\ndescription: d\n---\nbody\n', { file: 'x', source: 'project' })
  assert.ok(missingId.problems.some((p) => /id/.test(p)))

  const badSandbox = catalog.parseCard(
    '---\nid: a.b\ndescription: d\nsandbox: everything\n---\nbody\n',
    { file: 'x', source: 'project' },
  )
  assert.ok(badSandbox.problems.some((p) => /sandbox/.test(p)))
})

test('bootstrap seeds a project once and does not overwrite edits', () => {
  const ws = tmpdir('seed')
  const first = catalog.bootstrap(ws)
  assert.ok(first.created.length > 0, 'seeds should be copied on first run')
  const target = path.join(ws, '.dsh-codex', 'capabilities')
  const one = fs.readdirSync(target)[0]
  fs.writeFileSync(path.join(target, one), '---\nid: edited.cap\ndescription: edited\n---\nbody\n', 'utf8')
  const second = catalog.bootstrap(ws)
  assert.equal(second.created.length, 0, 'second bootstrap must not copy again')
  const kept = fs.readFileSync(path.join(target, one), 'utf8')
  assert.match(kept, /edited\.cap/, 'user edit must survive')
})

test('every shipped seed card parses after seeding (regression)', () => {
  // Regression: the first seeding implementation prepended its banner BEFORE
  // the opening `---`, which made every seeded card fail frontmatter parsing and
  // silently produced an empty catalog (count: 0) in a live run.
  const ws = tmpdir('seed-parse')
  const res = catalog.bootstrap(ws)
  assert.ok(res.created.length > 0)
  const loaded = catalog.loadCatalog(ws, { bootstrap: false })
  assert.equal(loaded.problems.length, 0, `seed cards must parse: ${JSON.stringify(loaded.problems)}`)
  assert.equal(loaded.cards.length, res.created.length, 'every seeded card must load')
  const ids = loaded.cards.map((c) => c.id).sort()
  assert.deepEqual(ids, ['art.assets', 'code.review', 'design.spec', 'image.generate'])
  // the banner must still be present, just somewhere harmless
  for (const card of loaded.cards) {
    const text = fs.readFileSync(card.file, 'utf8')
    assert.match(text, /Seeded from dsh-codex-connector/)
    assert.ok(text.startsWith('---'), 'frontmatter must still open the file')
  }
})

test('matches by trigger and returns nothing when nothing fits', () => {
  const cards = [
    catalog.parseCard(
      '---\nid: image.generate\ntitle: 生成图片\ndescription: 需要位图素材\ntriggers: [画一张图, 出图]\n---\nbody {{task}}\n',
      { file: 'a', source: 'project' },
    ),
    catalog.parseCard(
      '---\nid: code.review\ntitle: 代码评审\ndescription: review code\ntriggers: [评审, review]\n---\nbody {{task}}\n',
      { file: 'b', source: 'project' },
    ),
  ]
  const hit = catalog.matchCards(cards, '帮我画一张图，用作 hero')
  assert.equal(hit[0].card.id, 'image.generate')
  assert.equal(catalog.matchCards(cards, '今天天气怎么样').length, 0)
})

process.stdout.write('\nprompt\n')

test('renders placeholders and injects run context', () => {
  const card = catalog.parseCard(
    [
      '---',
      'id: t',
      'description: d',
      'skills: [imagegen]',
      'artifacts:',
      '  collectTo: assets/generated',
      'inputs:',
      '  - name: task',
      '    required: true',
      '---',
      '做 {{task}}',
    ].join('\n'),
    { file: 'x', source: 'project' },
  )
  const built = prompt.buildPrompt(card, { task: '一张图' }, { workspace: 'C:\\ws', runId: 'r1' })
  assert.match(built.prompt, /做 一张图/)
  assert.match(built.prompt, /C:\\ws/)
  assert.match(built.prompt, /imagegen/)
  assert.match(built.prompt, /assets/)
})

test('fails early on missing required input and unfilled placeholders', () => {
  const card = catalog.parseCard(
    '---\nid: t\ndescription: d\ninputs:\n  - name: task\n    required: true\n---\n做 {{task}}\n',
    { file: 'x', source: 'project' },
  )
  assert.throws(() => prompt.buildPrompt(card, {}, { workspace: '.' }), /missing required input/)

  const card2 = catalog.parseCard(
    '---\nid: t2\ndescription: d\n---\n做 {{who}}\n',
    { file: 'x', source: 'project' },
  )
  assert.throws(() => prompt.buildPrompt(card2, {}, { workspace: '.' }), /placeholder/)
})

process.stdout.write('\nevents\n')

// Verbatim shape captured from a real run (DESIGN.md §1.5). Note every `error`
// line here is a PLAIN transport event: in the measured stream even the
// "Falling back from WebSockets..." notice arrives as `{"type":"error",...}`,
// NOT as an item. A completed item is what a real, run-failing error looks like.
const REAL_STREAM = [
  '{"type":"thread.started","thread_id":"01a0a0f5-40d5-7173-8a2c-a954f076a2ef"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"Reconnecting... 2/5 (request timed out)"}',
  '{"type":"error","message":"Reconnecting... 3/5 (request timed out)"}',
  '{"type":"error","message":"Reconnecting... 4/5 (request timed out)"}',
  '{"type":"error","message":"Reconnecting... 5/5 (request timed out)"}',
  '{"type":"error","message":"Falling back from WebSockets to HTTPS transport. request timed out"}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"PROBE_OK"}}',
  '{"type":"turn.completed","usage":{"input_tokens":17183,"output_tokens":177}}',
].join('\n')

test('treats transient transport errors as success (measured behaviour)', () => {
  const parsed = events.parseEvents(REAL_STREAM)
  assert.equal(parsed.ok, true, 'five transient transport errors must not fail the run')
  assert.equal(parsed.threadId, '01a0a0f5-40d5-7173-8a2c-a954f076a2ef')
  assert.equal(parsed.summary, 'PROBE_OK')
  assert.equal(parsed.usage.input_tokens, 17183)
  assert.equal(parsed.errors.length, 0)
  assert.ok(parsed.warnings.some((w) => /transient/.test(w)))
})

test('does not blow up on non-JSON lines', () => {
  const dirty = `Reading additional input from stdin...\nAt line:3 char:1\n${REAL_STREAM}\nplain trailing noise`
  const parsed = events.parseEvents(dirty)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.dirtyLines.length, 3)
  assert.ok(parsed.warnings.some((w) => /non-JSON/.test(w)))
})

test('an item-wrapped transport notice is not a failure (measured)', () => {
  // Verbatim from the run that answered CONNECTOR_OK: the WebSocket fallback
  // arrived as an ITEM, not as a plain error event, even though an earlier run
  // had delivered the same notice as {"type":"error"}. Treating item-wrapped
  // errors as fatal made a successful 118s run report failure.
  const stream = [
    '{"type":"thread.started","thread_id":"01a0a10b-78e9-77e0-9dd9-a5217deb5c2a"}',
    '{"type":"turn.started"}',
    '{"type":"error","message":"Reconnecting... 2/5 (request timed out)"}',
    '{"type":"error","message":"Reconnecting... 3/5 (request timed out)"}',
    '{"type":"error","message":"Reconnecting... 4/5 (request timed out)"}',
    '{"type":"error","message":"Reconnecting... 5/5 (request timed out)"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back from WebSockets to HTTPS transport. request timed out"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"CONNECTOR_OK"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
  ].join('\n')
  const parsed = events.parseEvents(stream)
  assert.equal(parsed.ok, true, 'transport notice in item form must not fail the run')
  assert.equal(parsed.summary, 'CONNECTOR_OK')
  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.transportErrors.length, 5)
})

test('an item-wrapped model rejection IS a failure (measured)', () => {
  const stream = [
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"i","type":"error","message":"{\\"detail\\":\\"The \'X\' model is not supported when using Codex with a ChatGPT account.\\"}"}}',
    '{"type":"turn.completed"}',
  ].join('\n')
  const parsed = events.parseEvents(stream)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errors.length, 1)
})

test('classification separates notices from rejections', () => {
  assert.equal(events.classifyMessage('Reconnecting... 3/5 (request timed out)'), 'transient')
  assert.equal(events.classifyMessage('Falling back from WebSockets to HTTPS transport. request timed out'), 'transient')
  assert.equal(events.classifyMessage("The 'X' model is not supported when using Codex with a ChatGPT account."), 'fatal')
  assert.equal(events.classifyMessage('stream error: 401 unauthorized'), 'fatal')
  assert.equal(events.classifyMessage('something entirely unexpected'), 'fatal')
})

test('a real error item fails the run', () => {
  const failed = [
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"i","type":"error","message":"model not supported"}}',
    '{"type":"turn.completed"}',
  ].join('\n')
  const parsed = events.parseEvents(failed)
  assert.equal(parsed.ok, false)
  assert.deepEqual(parsed.errors, ['model not supported'])
})

test('a missing turn.completed fails the run', () => {
  const parsed = events.parseEvents('{"type":"thread.started","thread_id":"t"}')
  assert.equal(parsed.ok, false)
})

process.stdout.write('\nartifacts\n')

test('globs ** across directories and expands $CODEX_HOME', () => {
  const home = tmpdir('codexhome')
  const runDir = path.join(home, 'generated_images', 'run-1')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'a.png'), 'x')
  fs.mkdirSync(path.join(runDir, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(runDir, 'nested', 'b.png'), 'y')
  fs.writeFileSync(path.join(runDir, 'c.txt'), 'z')

  const hits = artifacts.globFiles(['$CODEX_HOME/generated_images/**/*.png'], { codexHome: home })
  assert.equal(hits.length, 2, `expected 2 png, got ${hits.length}`)
})

test('run-dir name is never derived from the thread id', () => {
  // Regression guard for D1: measured dir 01a0a0f7-… vs thread 01a0a0f5-…
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'core', 'codex-run.js'), 'utf8')
  assert.ok(!/threadId[^\n]*generated_images/.test(src), 'must not build artifact paths from threadId')
  assert.match(src, /diffNew/, 'artifact recovery must diff a snapshot')
})

test('collect never clobbers and reports skips', () => {
  const home = tmpdir('collect-home')
  const runDir = path.join(home, 'generated_images', 'r')
  fs.mkdirSync(runDir, { recursive: true })
  const a = path.join(runDir, 'hero.png')
  fs.writeFileSync(a, 'first')
  const ws = tmpdir('collect-ws')

  const before = artifacts.snapshot(['$CODEX_HOME/generated_images/**/*.png'], { codexHome: home })
  fs.writeFileSync(a, 'second version')
  const after = artifacts.snapshot(['$CODEX_HOME/generated_images/**/*.png'], { codexHome: home })
  const fresh = artifacts.diffNew(before, after)
  assert.equal(fresh.length, 1, 'changed file counts as new')

  const out = artifacts.collect({ files: [...fresh, ...fresh], workspace: ws, collectTo: 'assets', runId: 'r' })
  assert.equal(out.collected.length, 2, 'second copy allowed')
  const names = out.collected.map((c) => path.basename(c.to)).sort()
  assert.deepEqual(names, ['hero-v2.png', 'hero.png'])
})

test('extracts real file paths from agent prose only', () => {
  const home = tmpdir('paths-home')
  const f = path.join(home, 'pic.png')
  fs.writeFileSync(f, 'x')
  const found = artifacts.pathsFromText(`Done. Saved to ${f} and also C:\\nope\\missing.png`, { codexHome: home })
  assert.deepEqual(found, [path.resolve(f)])
})

process.stdout.write('\nenv + parallel\n')

test('suppresses credentials but keeps the essentials', () => {
  const { env: built, dropped } = env.buildEnv({
    PATH: '/usr/bin',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    CODEX_HOME: 'C:\\codex',
    DEEPSEEK_API_KEY: 'secret-value',
    GITHUB_TOKEN: 'gh',
    AWS_SECRET_ACCESS_KEY: 'x',
    SOME_RANDOM_VAR: 'y',
  })
  assert.equal(built.PATH, '/usr/bin')
  assert.equal(built.CODEX_HOME, 'C:\\codex')
  assert.equal(built.DEEPSEEK_API_KEY, undefined, 'must not leak the DSH key')
  assert.equal(built.GITHUB_TOKEN, undefined)
  assert.equal(built.AWS_SECRET_ACCESS_KEY, undefined)
  assert.ok(dropped.includes('DEEPSEEK_API_KEY'))
})

test('serializes per key and detects transient lock errors', async () => {
  let concurrent = 0
  let max = 0
  const work = async () => {
    concurrent += 1
    max = Math.max(max, concurrent)
    await new Promise((r) => setTimeout(r, 15))
    concurrent -= 1
  }
  await Promise.all([1, 2, 3, 4].map(() => parallel.withLimit('k', 1, work)))
  assert.equal(max, 1, 'limit 1 must serialize')

  assert.equal(parallel.isTransient('database is locked'), true)
  assert.equal(parallel.isTransient('拒绝访问。 (os error 5)'), true)
  assert.equal(parallel.isTransient('model not found'), false)

  let attempts = 0
  const value = await parallel.withTransientRetry(async () => {
    attempts += 1
    if (attempts < 3) throw new Error('database is locked')
    return 'recovered'
  }, { retries: 3, delayMs: 1 })
  assert.equal(value, 'recovered')
  assert.equal(attempts, 3)
})

process.stdout.write('\ntrust\n')

test('reads Codex-authored entries (single quotes, lowercased path)', () => {
  const home = tmpdir('trust-read')
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    "[projects.'f:\\chatgptproject']\ntrust_level = \"trusted\"\n",
    'utf8',
  )
  const res = trust.resolveTrust('F:\\chatgptproject', home)
  assert.equal(res.trusted, true)
})

test('an untrusted project is reported untrusted', () => {
  const home = tmpdir('trust-none')
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "m"\n', 'utf8')
  const res = trust.resolveTrust('C:\\somewhere\\proj', home)
  assert.equal(res.trusted, false)
  assert.match(res.reason, /no entry/)
})

test('a trusted ancestor covers a child (measured: parent and child entries coexist)', () => {
  const home = tmpdir('trust-ancestor')
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    "[projects.'f:\\chatgptproject']\ntrust_level = \"trusted\"\n",
    'utf8',
  )
  const res = trust.resolveTrust('F:\\chatgptproject\\counter-battery', home)
  assert.equal(res.trusted, true)
  assert.match(res.reason, /ancestor/)
})

test('grantTrust adds a correctly shaped entry and is verified', () => {
  const home = tmpdir('trust-grant')
  const cfg = path.join(home, 'config.toml')
  fs.writeFileSync(cfg, 'model = "m"\r\n', 'utf8')
  const res = trust.grantTrust('C:\\work\\Demo Project', { codexHome: home })
  assert.equal(res.changed, true)
  const text = fs.readFileSync(cfg, 'utf8')
  assert.match(text, /\[projects\.'c:\\work\\demo project'\]/)
  assert.match(text, /trust_level = "trusted"/)
  assert.ok(!text.startsWith('\uFEFF'), 'must not add a BOM')
  assert.equal(trust.resolveTrust('C:\\work\\Demo Project', home).trusted, true)
})

test('grantTrust is a no-op when an ancestor already covers it', () => {
  const home = tmpdir('trust-grant-ancestor')
  const cfg = path.join(home, 'config.toml')
  fs.writeFileSync(cfg, "[projects.'c:\\work']\ntrust_level = \"trusted\"\n", 'utf8')
  const before = fs.readFileSync(cfg)
  const res = trust.grantTrust('C:\\work\\proj', { codexHome: home })
  assert.equal(res.changed, false)
  assert.deepEqual(fs.readFileSync(cfg), before, 'no redundant child entry may be written')
})

test('revokeTrust removes exactly the entry and nothing else', () => {
  const home = tmpdir('trust-revoke')
  const cfg = path.join(home, 'config.toml')
  fs.writeFileSync(cfg, 'model = "m"\n', 'utf8')
  trust.grantTrust('C:\\work\\proj', { codexHome: home })
  const withEntry = fs.readFileSync(cfg, 'utf8')
  const res = trust.revokeTrust('C:\\work\\proj', { codexHome: home })
  assert.equal(res.changed, true)
  const after = fs.readFileSync(cfg, 'utf8')
  assert.ok(!/proj/.test(after))
  assert.equal(after.trim(), 'model = "m"')
  assert.ok(withEntry.length > after.length)
})

process.stdout.write('\nproject\n')

test('registration creates project info and reports configEffective honestly', () => {
  const ws = tmpdir('proj-register')
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node t' } }), 'utf8')
  const home = tmpdir('proj-register-home')
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "m"\n', 'utf8')

  const res = project.register(ws, { codexHome: home })
  assert.equal(res.registered, true)
  assert.ok(fs.existsSync(path.join(ws, '.codex', 'config.toml')))
  assert.ok(fs.existsSync(path.join(ws, '.codex', 'project', 'PROJECT.md')))
  assert.ok(fs.existsSync(path.join(ws, '.codex', 'project', 'CAPABILITIES.md')))
  assert.ok(fs.existsSync(path.join(ws, '.codex', 'dsh', 'binding.json')))
  assert.ok(fs.existsSync(path.join(ws, 'AGENTS.md')))
  assert.equal(res.configEffective, false, 'untrusted project means project config does NOT apply')
  assert.ok(res.warnings.some((w) => /不生效|可信/.test(w)))

  const marker = fs.readFileSync(path.join(ws, '.codex', 'config.toml'), 'utf8')
  assert.match(marker, /project_root_markers = \["\.git", "\.codex"\]/)
})

test('an existing AGENTS.md is never touched (it is also DSH input)', () => {
  const ws = tmpdir('proj-agents')
  const agents = path.join(ws, 'AGENTS.md')
  fs.writeFileSync(agents, '# hand written rules\nnever edit me\n', 'utf8')
  const before = fs.readFileSync(agents)
  project.register(ws, { codexHome: tmpdir('proj-agents-home') })
  assert.deepEqual(fs.readFileSync(agents), before, 'AGENTS.md must be byte-identical')
})

test('a foreign .codex/ is not written without adoption', () => {
  const ws = tmpdir('proj-foreign')
  fs.mkdirSync(path.join(ws, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.codex', 'config.toml'), 'model = "users-own"\n', 'utf8')
  const before = fs.readFileSync(path.join(ws, '.codex', 'config.toml'))
  const res = project.register(ws, { codexHome: tmpdir('proj-foreign-home') })
  assert.equal(res.registered, false)
  assert.equal(res.needsAdoption, true)
  assert.deepEqual(fs.readFileSync(path.join(ws, '.codex', 'config.toml')), before)
  assert.ok(!fs.existsSync(path.join(ws, '.codex', 'project')), 'must not create our dirs either')

  const adopted = project.register(ws, { adopt: true, codexHome: tmpdir('proj-foreign-home2') })
  assert.equal(adopted.registered, true)
  assert.deepEqual(
    fs.readFileSync(path.join(ws, '.codex', 'config.toml')),
    before,
    'adoption still must not rewrite the user config.toml content',
  )
  assert.match(fs.readFileSync(path.join(ws, '.codex', 'config.toml'), 'utf8'), /model = "users-own"/)
})

test('registration is idempotent', () => {
  const ws = tmpdir('proj-idem')
  const home = tmpdir('proj-idem-home')
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "m"\n', 'utf8')
  const first = project.register(ws, { codexHome: home })
  const agentsAfterFirst = fs.readFileSync(path.join(ws, 'AGENTS.md'))
  const second = project.register(ws, { codexHome: home })
  assert.equal(second.registered, true)
  assert.deepEqual(fs.readFileSync(path.join(ws, 'AGENTS.md')), agentsAfterFirst)
  const cfg = fs.readFileSync(path.join(ws, '.codex', 'config.toml'), 'utf8')
  assert.equal((cfg.match(/project_root_markers/g) || []).length, 1, 'marker must not be duplicated')
  assert.ok(first.filesCreated.length >= second.filesCreated.length)
})

test('project facts detect a JS project', () => {
  const ws = tmpdir('facts')
  fs.writeFileSync(
    path.join(ws, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { build: 'b', test: 't' } }),
    'utf8',
  )
  fs.writeFileSync(path.join(ws, 'pnpm-lock.yaml'), '', 'utf8')
  const prof = facts.profile(ws)
  assert.ok(prof.stack.some((s) => /Node/.test(s)))
  assert.ok(prof.commands.includes('pnpm run test'))
  assert.equal(prof.git.isRepo, false)
})

// Worker-level tests are async and live in `main()` at the bottom of this file,
// because a .cjs file has no top-level await.

test('a run-created HISTORY.md must not make our own .codex/ look foreign', () => {
  // Regression: runs.appendHistory creates `.codex/project/HISTORY.md` as a side
  // effect of ANY run. It could therefore create `.codex/` before registration
  // recorded ownership; the next register() then saw a "foreign" directory and
  // refused to write, freezing the project permanently. Found in the first live
  // check, where registration returned needsAdoption on its own directory.
  const ws = tmpdir('history-deadlock')
  const home = tmpdir('history-deadlock-home')
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "m"\n', 'utf8')

  // simulate what a run does before any registration
  const { runId } = runs.beginRun(ws, {})
  runs.finishRun(ws, runId, { ok: true })
  runs.appendHistory(ws, 'adhoc run before registration')
  assert.ok(fs.existsSync(path.join(ws, '.codex', 'project', 'HISTORY.md')))
  assert.equal(project.isOurs(ws), true, 'our own history file is an ownership signal')

  const res = project.register(ws, { codexHome: home })
  assert.equal(res.registered, true, 'registration must not be blocked by our own side effect')
  assert.notEqual(res.needsAdoption, true)
})

test('a run-created .codex/ directory still is not overwritten before registration', () => {
  // The mirror of the test above: a directory with NO signal of ours stays
  // foreign. Only our own artifacts count as ownership.
  const ws = tmpdir('history-foreign')
  fs.mkdirSync(path.join(ws, '.codex', 'project'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.codex', 'project', 'HISTORY.md'), 'someone else wrote this\n', 'utf8')
  assert.equal(project.isOurs(ws), false)
  const res = project.register(ws, { codexHome: tmpdir('history-foreign-home') })
  assert.equal(res.needsAdoption, true)
})

process.stdout.write('\nruns\n')

test('run ledger records outcomes and demotes a repeatedly failing card', () => {
  const ws = tmpdir('runs')
  const { runId, dir } = runs.beginRun(ws, { capability: 'x.y' })
  assert.ok(fs.existsSync(path.join(dir, 'meta.json')))
  runs.writeEvents(dir, '{"type":"turn.started"}')
  assert.ok(fs.existsSync(path.join(dir, 'events.jsonl')))

  runs.finishRun(ws, runId, { capability: 'x.y', ok: false })
  runs.finishRun(ws, runId, { capability: 'x.y', ok: false })
  let health = runs.capabilityHealth(ws, 'x.y')
  assert.equal(health.failed, 2)
  assert.notEqual(health.status, 'needs-review')

  runs.finishRun(ws, runId, { capability: 'x.y', ok: false })
  health = runs.capabilityHealth(ws, 'x.y')
  assert.equal(health.status, 'needs-review', 'three failures must demote the card')

  runs.finishRun(ws, runId, { capability: 'x.y', ok: true, threadId: 't-1' })
  health = runs.capabilityHealth(ws, 'x.y')
  assert.equal(health.status, 'verified')
  assert.equal(runs.lastThreadId(ws, 'x.y'), 't-1')
})

process.stdout.write('\nargv / sandbox policy\n')

test('builds the measured exec argv including resume placement', () => {
  const argv = codexRun.buildArgv({
    binary: 'codex.exe',
    sandbox: 'workspace-write',
    cwd: 'C:\\ws',
    model: 'gpt-6-astra',
    lastMessageFile: 'C:\\tmp\\last.txt',
    resume: 'thread-abc',
  })
  assert.deepEqual(argv.slice(0, 4), ['codex.exe', 'exec', '--json', '--skip-git-repo-check'])
  assert.ok(argv.includes('-s') && argv.includes('workspace-write'))
  assert.ok(argv.includes('-C') && argv.includes('C:\\ws'))
  const resumeAt = argv.indexOf('resume')
  assert.equal(argv[resumeAt + 1], 'thread-abc')
  assert.ok(argv.indexOf('-o') < resumeAt, 'options must precede the resume subcommand')
})

test('a killed (timed-out) run is never reported as success', async () => {
  // Regression from adversarial review: spawn.js RESOLVES on timeout with
  // timedOut:true, and codex-run.js judged success from the event stream alone.
  // A stream that already contained turn.completed therefore reported a
  // truncated, killed run as ok:true.
  const stream = [
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"partial"}}',
    '{"type":"turn.completed"}',
  ].join('\n')

  const hung = async () => ({ exitCode: null, signal: 'SIGTERM', stdout: stream, stderr: '', elapsedMs: 1234, timedOut: true })
  const timedOut = await codexRun.run({ workspace: tmpdir('timeout-run'), prompt: 'x' }, hung)
  assert.equal(timedOut.ok, false, 'a killed run must not be ok')
  assert.ok(timedOut.warnings.some((w) => /timed out/.test(w)), 'the timeout must be reported')

  // The same stream WITHOUT the timeout flag is a normal success.
  const clean = async () => ({ exitCode: 0, signal: null, stdout: stream, stderr: '', elapsedMs: 1234, timedOut: false })
  const ok = await codexRun.run({ workspace: tmpdir('timeout-run-ok'), prompt: 'x' }, clean)
  assert.equal(ok.ok, true)
  assert.ok(!ok.warnings.some((w) => /timed out/.test(w)))
})

test('danger-full-access needs explicit authorisation on the call', async () => {
  const spawn = async () => ({ exitCode: 0, stdout: '', stderr: '', elapsedMs: 1 })
  // A card/caller default that merely resolves to danger is refused...
  await assert.rejects(
    () => codexRun.run({ workspace: process.cwd(), prompt: 'x', sandbox: 'danger-full-access' }, spawn),
    /explicitly/,
  )
  // ...and explicit authorisation is what unlocks it.
  const allowed = await codexRun.run(
    { workspace: process.cwd(), prompt: 'x', sandbox: 'danger-full-access', sandboxExplicit: true },
    spawn,
  )
  assert.equal(allowed.sandbox, 'danger-full-access')
})

// ---------------------------------------------------------------------------

// Worker-level tests touch async paths (routing, preflight, spawn refusal) and
// therefore must run inside an async main; every one of them asserts that Codex
// is NEVER spawned, which is only meaningful if the harness fails when it is.

async function main() {
  const { createWorkers } = require('../lib/workers/workers')
  const { compileParameters } = require('../lib/tools-schema')
  const plugin = require('../lib/index')
  const base = tmpdir('workers-base')

  process.stdout.write('\ntool schema\n')

  test('compiles a parameter spec into raw JSON Schema', () => {
    const schema = compileParameters({
      action: { type: 'string', required: true, enum: ['a', 'b'], description: 'pick one' },
      count: { type: 'number' },
      opt: { type: 'boolean' },
      list: { type: 'array', items: { type: 'object' } },
      any: { type: 'object' },
      free: { type: 'json' },
    })
    assert.equal(schema.type, 'object')
    assert.deepEqual(schema.required, ['action'])
    assert.deepEqual(schema.properties.action.enum, ['a', 'b'])
    assert.equal(schema.properties.action.type, 'string')
    assert.equal(schema.properties.count.type, 'number')
    assert.equal(schema.properties.opt.type, 'boolean')
    assert.equal(schema.properties.list.type, 'array')
    assert.deepEqual(schema.properties.list.items, { type: 'object' })
    assert.equal(schema.properties.any.type, 'object')
    // `json` means "any lossless JSON" and has no JSON Schema keyword of its
    // own: it must compile to the empty schema, which accepts anything.
    assert.deepEqual(schema.properties.free, {})
    // requiredness must not leak into the property node
    assert.equal(schema.properties.action.required, undefined)
  })

  test('rejects malformed parameter specs loudly', () => {
    assert.throws(() => compileParameters({ x: { type: 'nope' } }), /unsupported type/)
    assert.throws(() => compileParameters({ x: 'string' }), /must be an object/)
    assert.throws(() => compileParameters({ x: { type: 'string', enum: [] } }), /enum/)
    assert.throws(() => compileParameters({ x: { type: 'string', items: { type: 'string' } } }), /items/)
  })

  test('every shipped tool definition is registrable and complete', () => {
    assert.equal(typeof plugin.apply, 'function', 'plugin must expose apply for the loader')
    assert.equal(plugin.name, 'dsh-codex-connector')
    assert.deepEqual(plugin.inject, ['subprocess', 'tools'])
    assert.ok(plugin.TOOL_SPECS.length >= 6)
    const seen = new Set()
    for (const spec of plugin.TOOL_SPECS) {
      assert.ok(spec.name && !seen.has(spec.name), `duplicate or missing tool name: ${spec.name}`)
      seen.add(spec.name)
      assert.ok(spec.description && spec.description.length > 40, `${spec.name} needs a real description`)
      assert.equal(typeof spec.worker, 'function'.replace('function', 'string'))
      const schema = compileParameters(spec.parameters)
      assert.equal(schema.type, 'object')
      for (const [key, value] of Object.entries(schema.properties)) {
        assert.ok(value && typeof value === 'object', `${spec.name}.${key} must compile to an object`)
        const types = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']
        if (value.type !== undefined) assert.ok(types.includes(value.type), `${spec.name}.${key} bad type`)
      }
    }
    for (const required of ['codex_status', 'codex_project', 'codex_capabilities', 'codex_skill_write', 'codex_skill_verify', 'codex_do']) {
      assert.ok(seen.has(required), `missing tool ${required}`)
    }
  })

  test('the plugin registers every tool and cleans up through ctx.effect', () => {
    const disposers = []
    const registered = []
    const effects = []
    const ctx = {
      get(name) {
        if (name === 'tools') return { register: (def) => { registered.push(def); return () => {} } }
        if (name === 'subprocess') return { spawn: () => { throw new Error('not used here') } }
        return undefined
      },
      effect(fn, label) {
        effects.push(label)
        const d = fn()
        if (typeof d === 'function') disposers.push(d)
        return d
      },
      provide() {
        return () => {}
      },
    }
    plugin.createPlugin().apply(ctx)
    assert.equal(registered.length, plugin.TOOL_SPECS.length, 'each spec must register exactly one tool')
    assert.ok(effects.length >= plugin.TOOL_SPECS.length, 'each registration must be owned by an effect')
    assert.equal(registered[0].parameters.type, 'object')
    assert.equal(typeof registered[0].output.render, 'function')
    assert.deepEqual(registered[0].output.render({}, { ok: true }), [{ type: 'text', text: '{\n  "ok": true\n}' }])
  })

  test('a missing tool registry is reported instead of half-mounting', () => {
    const logs = []
    const original = console.error
    console.error = (...a) => logs.push(a.join(' '))
    try {
      plugin.createPlugin().apply({
        get: () => undefined,
        effect: () => () => {},
        provide: () => () => {},
      })
    } finally {
      console.error = original
    }
    assert.ok(logs.some((l) => /tool registry unavailable/.test(l)))
  })

  process.stdout.write('\nreview regressions\n')

test('a user-owned .codex/ is never mistaken for ours (H1)', () => {
  // Review finding: all three ownership signals only checked EXISTENCE or a
  // substring, so a user's own files made isOurs() true and register() then
  // wrote into their directory without the adoption gate.
  const cases = [
    {
      label: 'notes.md with no marker',
      setup: (ws) => fs.writeFileSync(path.join(ws, '.codex', 'dsh', 'notes.md'), '# mine\n', 'utf8'),
    },
    {
      label: 'binding.json that is just {}',
      setup: (ws) => fs.writeFileSync(path.join(ws, '.codex', 'dsh', 'binding.json'), '{}\n', 'utf8'),
    },
    {
      label: 'a doc that merely QUOTES the marker',
      setup: (ws) =>
        fs.writeFileSync(
          path.join(ws, '.codex', 'project', 'NOTES.md'),
          '# my notes\n\nthe string <!-- managed by dsh-codex-connector --> appears in docs\n',
          'utf8',
        ),
    },
    {
      label: 'a run-created HISTORY.md with foreign content',
      setup: (ws) =>
        fs.writeFileSync(path.join(ws, '.codex', 'project', 'HISTORY.md'), 'someone else wrote this\n', 'utf8'),
    },
  ]
  for (const c of cases) {
    const ws = tmpdir('foreign-signal')
    fs.mkdirSync(path.join(ws, '.codex', 'dsh'), { recursive: true })
    fs.mkdirSync(path.join(ws, '.codex', 'project'), { recursive: true })
    c.setup(ws)
    assert.equal(project.isOurs(ws), false, `${c.label} must NOT count as ownership`)
    const res = project.register(ws, { codexHome: tmpdir('foreign-signal-home') })
    assert.equal(res.needsAdoption, true, `${c.label} must require adoption`)
  }
})

test('genuine markers still count as ours, so the deadlock does not return', () => {
  const ws = tmpdir('ours-real')
  fs.mkdirSync(path.join(ws, '.codex', 'project'), { recursive: true })
  fs.writeFileSync(
    path.join(ws, '.codex', 'project', 'HISTORY.md'),
    '<!-- managed by dsh-codex-connector -->\n# history\n',
    'utf8',
  )
  assert.equal(project.isOurs(ws), true)
})

test('collect refuses a collectTo that escapes the workspace (H2)', () => {
  const ws = tmpdir('escape-ws')
  const home = tmpdir('escape-home')
  const runDir = path.join(home, 'generated_images', 'r')
  fs.mkdirSync(runDir, { recursive: true })
  const src = path.join(runDir, 'x.png')
  fs.writeFileSync(src, 'bytes')

  const before = new Set(fs.readdirSync(ws, { recursive: true }).map(String))
  for (const evil of ['../../escaped', '..', 'a/../../b', '..' + path.sep + '..' + path.sep + '..']) {
    const out = artifacts.collect({ files: [src], workspace: ws, collectTo: evil, runId: 'r' })
    assert.equal(out.collected.length, 0, `"${evil}" must not copy anything`)
    assert.equal(out.refused, true, `"${evil}" must be reported as refused`)
    assert.ok(out.skipped.length > 0, `"${evil}" must explain the refusal`)
  }
  const after = new Set(fs.readdirSync(ws, { recursive: true }).map(String))
  assert.deepEqual([...after].sort(), [...before].sort(), 'a refused collect must create nothing in the workspace')
  // The legitimate case still works.
  const good = artifacts.collect({ files: [src], workspace: ws, collectTo: 'assets/generated', runId: 'r' })
  assert.equal(good.collected.length, 1)
  assert.ok(artifacts.isInside(good.collected[0].to, ws))
})

test('isInside is not fooled by prefix-similar siblings', () => {
  const root = path.resolve('C:\\a\\b')
  assert.equal(artifacts.isInside(path.join(root, 'c'), root), true)
  assert.equal(artifacts.isInside(path.resolve('C:\\a\\bb\\c'), root), false)
  assert.equal(artifacts.isInside(root, root), false)
  assert.equal(artifacts.isInside(path.resolve('C:\\a'), root), false)
})

test('duplicate capability ids are reported, not silently shadowed (L4)', () => {
  const ws = tmpdir('dup-ids')
  const dir = path.join(ws, '.dsh-codex', 'capabilities')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'a.md'), '---\nid: dup.id\ndescription: first\n---\nbody\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'b.md'), '---\nid: dup.id\ndescription: second\n---\nbody\n', 'utf8')
  const loaded = catalog.loadCatalog(ws, { bootstrap: false })
  assert.equal(loaded.cards.length, 1, 'only one definition of an id may be active')
  assert.ok(
    loaded.problems.some((p) => p.problems.some((m) => /duplicate id/.test(m))),
    'the drop must be reported',
  )
})

test('a card that failed once is not reported as verified (L6)', () => {
  const ws = tmpdir('fresh-health')
  const { runId } = runs.beginRun(ws, { capability: 'fresh.card' })
  runs.finishRun(ws, runId, { capability: 'fresh.card', ok: false })
  const health = runs.capabilityHealth(ws, 'fresh.card')
  assert.equal(health.failed, 1)
  assert.notEqual(health.status, 'verified', 'a never-succeeded card must not claim verified')
})

test('a plain (non-item) fatal error fails the run (L7)', () => {
  const stream = [
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"turn.started"}',
    // No inner quotes: an embedded quote made this line invalid JSON, so the
    // parser (correctly) treated it as a dirty line and the fatal error was
    // never seen at all — a broken probe, not a broken parser.
    '{"type":"error","message":"unknown model nope"}',
    '{"type":"turn.completed"}',
  ].join('\n')
  const parsed = events.parseEvents(stream)
  assert.equal(parsed.ok, false, 'a fatal plain error must not be swallowed')
  assert.equal(parsed.errors.length, 1)
})

test('plain transport noise without turn.completed still fails', () => {
  const parsed = events.parseEvents('{"type":"error","message":"Reconnecting... 2/5"}')
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errors.length, 0)
})

test('the serializer refuses multi-line frontmatter values (L5)', () => {
  const { serializeCard } = require('../lib/core/serialize')
  assert.throws(
    () => serializeCard({ id: 'x', description: 'line one\nline two' }, 'body'),
    /single-line/,
  )
  // and a card produced for single-line input still round-trips
  const okCard = serializeCard({ id: 'ok.card', description: 'fine' }, 'body {{task}}')
  const parsed = catalog.parseCard(okCard, { file: 'memory', source: 'project' })
  assert.deepEqual(parsed.problems, [])
})

process.stdout.write('\nworkers\n')

  await testAsync('codex_do refuses an unmatched task without spawning', async () => {
    let spawned = 0
    const workers = createWorkers({
      spawn: async () => {
        spawned += 1
        throw new Error('must not spawn')
      },
      defaultWorkspace: base,
    })
    const res = await workers.codexDo({ workspace: base, task: '今天天气怎么样' })
    assert.equal(res.routed, false)
    assert.equal(spawned, 0, 'no Codex process may be started for an unmatched task')
  })

  await testAsync('codex_skill_verify pre-flights before spending a live call', async () => {
    const ws = tmpdir('verify-preflight')
    let spawned = 0
    const workers = createWorkers({
      spawn: async () => {
        spawned += 1
        throw new Error('must not spawn')
      },
      defaultWorkspace: ws,
    })
    fs.mkdirSync(path.join(ws, '.dsh-codex', 'capabilities'), { recursive: true })
    fs.writeFileSync(
      path.join(ws, '.dsh-codex', 'capabilities', 'broken.card.md'),
      '---\nid: broken.card\ndescription: broken on purpose\ninputs:\n  - name: musthave\n    required: true\n---\n做 {{musthave}}\n',
      'utf8',
    )
    const res = await workers.skillVerify({ workspace: ws, id: 'broken.card', probeInputs: [{ task: 'x' }] })
    assert.equal(res.ok, false)
    assert.equal(res.phase, 'preflight', 'must fail at preflight, not after a live call')
    assert.equal(spawned, 0, 'a preflight failure must not start Codex')
    assert.match(res.error, /required input/)
  })

  await testAsync('codex_do refuses a needs-review card', async () => {
    const ws = tmpdir('needs-review')
    let spawned = 0
    const workers = createWorkers({
      spawn: async () => {
        spawned += 1
        throw new Error('must not spawn')
      },
      defaultWorkspace: ws,
    })
    const loaded = catalog.bootstrap(ws)
    assert.ok(loaded.created.length > 0)
    for (let i = 0; i < 3; i += 1) runs.finishRun(ws, 'r', { capability: 'image.generate', ok: false })
    assert.equal(runs.capabilityHealth(ws, 'image.generate').status, 'needs-review')
    const res = await workers.codexDo({ workspace: ws, capability: 'image.generate', inputs: { prompt: 'x' } })
    assert.equal(res.ok, false)
    assert.match(res.error, /needs-review/)
    assert.equal(spawned, 0)
  })

  await testAsync('codex_do suggests alternatives for an unknown capability', async () => {
    const ws = tmpdir('unknown-cap')
    const workers = createWorkers({
      spawn: async () => {
        throw new Error('must not spawn')
      },
      defaultWorkspace: ws,
    })
    catalog.bootstrap(ws)
    const res = await workers.codexDo({ workspace: ws, capability: 'image.generat', inputs: {} })
    assert.equal(res.ok, false)
    assert.ok(Array.isArray(res.suggestions))
  })

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
  if (failures.length > 0) {
    process.stdout.write('\nfailures:\n')
    for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error.stack || f.error.message}\n`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  process.stdout.write(`\nselftest harness crashed: ${error.stack || error.message}\n`)
  process.exitCode = 1
})
