'use strict'

// Static project profiling — no Codex call, no network. Produces the facts a
// Codex agent would otherwise have to rediscover on every run.

const fs = require('node:fs')
const path = require('node:path')

const MAX_DEPTH = 2
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.dsh-codex',
  'dist',
  'build',
  'out',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  'vendor',
])

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function exists(workspace, name) {
  return fs.existsSync(path.join(workspace, name))
}

function topLevel(workspace) {
  const dirs = []
  const files = []
  let entries = []
  try {
    entries = fs.readdirSync(workspace, { withFileTypes: true })
  } catch {
    return { dirs, files }
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.codex') continue
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue
      dirs.push(entry.name)
    } else if (entry.isFile()) {
      files.push(entry.name)
    }
  }
  return { dirs: dirs.sort(), files: files.sort() }
}

function detectStack(workspace) {
  const stack = []
  const commands = []

  const pkg = readJson(path.join(workspace, 'package.json'))
  if (pkg) {
    stack.push(`Node.js${pkg.type === 'module' ? ' (ESM)' : ''}`)
    if (pkg.packageManager) stack.push(pkg.packageManager.split('@')[0])
    const pm = exists(workspace, 'pnpm-lock.yaml')
      ? 'pnpm'
      : exists(workspace, 'yarn.lock')
        ? 'yarn'
        : exists(workspace, 'package-lock.json')
          ? 'npm'
          : 'npm'
    const scripts = pkg.scripts || {}
    for (const name of ['build', 'test', 'lint', 'dev', 'start']) {
      if (scripts[name]) commands.push(`${pm} run ${name}`)
    }
    if (!scripts.test && !exists(workspace, 'node_modules')) {
      // no test runner declared; say nothing rather than inventing one
    }
    if (Array.isArray(pkg.dependencies) === false && Array.isArray(pkg.devDependencies)) {
      // no-op: keep shape stable
    }
    if (!pkg.scripts) commands.push(`${pm} install`)
  }

  if (exists(workspace, 'pyproject.toml')) {
    stack.push('Python (pyproject)')
    commands.push('python -m pytest', 'ruff check .')
  } else if (exists(workspace, 'requirements.txt')) {
    stack.push('Python (requirements.txt)')
    commands.push('pytest')
  }
  if (exists(workspace, 'go.mod')) {
    stack.push('Go')
    commands.push('go build ./...', 'go test ./...')
  }
  if (exists(workspace, 'Cargo.toml')) {
    stack.push('Rust')
    commands.push('cargo build', 'cargo test')
  }
  if (exists(workspace, 'pom.xml')) {
    stack.push('Java (Maven)')
    commands.push('mvn test')
  }
  if (exists(workspace, 'build.gradle') || exists(workspace, 'build.gradle.kts')) {
    stack.push('Java/Kotlin (Gradle)')
    commands.push('./gradlew test')
  }
  if (exists(workspace, 'CMakeLists.txt')) {
    stack.push('C/C++ (CMake)')
    commands.push('cmake -B build', 'cmake --build build')
  }
  if (exists(workspace, 'index.html') && !pkg) stack.push('static HTML')

  return { stack: [...new Set(stack)], commands: [...new Set(commands)] }
}

function countFiles(root, limit = 4000) {
  let count = 0
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || count >= limit) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (count >= limit) return
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue
        walk(path.join(dir, entry.name), depth + 1)
      } else if (entry.isFile()) {
        count += 1
      }
    }
  }
  walk(root, 0)
  return count
}

function detectGit(workspace) {
  const gitDir = path.join(workspace, '.git')
  if (!fs.existsSync(gitDir)) return { isRepo: false }
  let branch
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    branch = m ? m[1] : head.slice(0, 12)
  } catch {
    branch = undefined
  }
  return { isRepo: true, branch }
}

/** @returns {{ stack: string[], commands: string[], dirs: string[], files: string[], git: object, fileCount: number }} */
function profile(workspace) {
  const { dirs, files } = topLevel(workspace)
  const { stack, commands } = detectStack(workspace)
  return {
    stack,
    commands,
    dirs,
    files,
    git: detectGit(workspace),
    fileCount: countFiles(workspace),
  }
}

function renderProjectDoc(workspace, facts) {
  const lines = []
  lines.push('# 项目画像（PROJECT.md）')
  lines.push('')
  lines.push('> 由 dsh-codex-connector 自动探测生成，供 Codex 会话快速建立上下文。')
  lines.push('> 可自由修改；`codex_project` 的 refresh 只补写缺失段落。')
  lines.push('')
  lines.push(`- 工作区: \`${workspace}\``)
  lines.push(`- 版本控制: ${facts.git.isRepo ? `git 仓库（分支 ${facts.git.branch || 'unknown'}）` : '非 git 项目'}`)
  lines.push(`- 技术栈: ${facts.stack.length > 0 ? facts.stack.join('、') : '未识别（可能是纯内容/素材项目）'}`)
  lines.push(`- 文件数（前 ${MAX_DEPTH} 层，已排除依赖目录）: 约 ${facts.fileCount}`)
  lines.push('')
  if (facts.commands.length > 0) {
    lines.push('## 常用命令')
    lines.push('')
    for (const c of facts.commands) lines.push(`- \`${c}\``)
    lines.push('')
  }
  if (facts.dirs.length > 0) {
    lines.push('## 顶层目录')
    lines.push('')
    for (const d of facts.dirs.slice(0, 40)) lines.push(`- \`${d}/\``)
    lines.push('')
  }
  lines.push('## 约定')
  lines.push('')
  lines.push('- 未在本文件确认的事实，先读代码再断言，不要臆测技术栈或命令。')
  lines.push('- 生成类产物统一写入本文件登记的产物目录。')
  lines.push('')
  return lines.join('\n')
}

module.exports = { profile, renderProjectDoc, detectGit, detectStack, topLevel }
