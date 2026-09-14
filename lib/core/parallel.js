'use strict'

// Per-workspace serialization.
//
// Every `codex exec` shares one $CODEX_HOME, which holds several SQLite
// databases. Concurrent runs risk lock contention (DESIGN.md §4.1 concurrency
// clause). Default is therefore one run at a time per workspace, configurable
// upward, with lock-ish failures treated as transient rather than fatal.

const queues = new Map()

const LOCK_PATTERNS = [
  /database is locked/i,
  /SQLITE_BUSY/i,
  /unable to open database file/i,
  /os error 5/i,
  /拒绝访问/,
]

function isTransient(message) {
  const text = String(message || '')
  return LOCK_PATTERNS.some((re) => re.test(text))
}

function queueFor(key) {
  let q = queues.get(key)
  if (!q) {
    q = { active: 0, waiting: [] }
    queues.set(key, q)
  }
  return q
}

/**
 * Run `task` with at most `limit` concurrent executions per key.
 * @template T
 * @param {string} key
 * @param {number} limit
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function withLimit(key, limit, task) {
  const q = queueFor(key)
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1
  return new Promise((resolve, reject) => {
    const attempt = () => {
      q.active += 1
      Promise.resolve()
        .then(task)
        .then(
          (value) => {
            q.active -= 1
            drain(q, max)
            resolve(value)
          },
          (error) => {
            q.active -= 1
            drain(q, max)
            reject(error)
          },
        )
    }
    if (q.active < max) attempt()
    else q.waiting.push(attempt)
  })
}

function drain(q, max) {
  while (q.active < max && q.waiting.length > 0) {
    const next = q.waiting.shift()
    next()
  }
}

/** Retry `fn` while it throws something that looks like a lock/permission race. */
async function withTransientRetry(fn, options = {}) {
  const retries = options.retries ?? 2
  const delayMs = options.delayMs ?? 1500
  let lastError
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!isTransient(error && error.message) || i === retries) throw error
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)))
    }
  }
  throw lastError
}

module.exports = { withLimit, withTransientRetry, isTransient }
