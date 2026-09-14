'use strict'

// Native Node spawn. Collects stdout/stderr with a hard cap and returns the
// same shape whether it succeeded, failed, or was killed on timeout.
//
// Prompt delivery: passed on stdin whenever the child can accept it. That avoids
// Windows command-line length and quoting limits and keeps prompts out of the
// process table.

const { spawn: nodeSpawn } = require('node:child_process')

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024

/**
 * @param {{argv: string[], cwd: string, stdin?: string, env?: object,
 *          timeoutMs?: number, graceMs?: number}} spec
 * @returns {Promise<{exitCode:number|null, signal:string|null, stdout:string,
 *                    stderr:string, elapsedMs:number, timedOut:boolean}>}
 */
function spawn(spec) {
  const {
    argv,
    cwd,
    stdin,
    env,
    timeoutMs = 900000,
    graceMs = 5000,
  } = spec || {}

  if (!Array.isArray(argv) || argv.length === 0) {
    return Promise.reject(new Error('spawn: argv must be a non-empty array'))
  }
  if (!cwd || typeof cwd !== 'string') {
    return Promise.reject(new Error('spawn: cwd is required'))
  }

  const started = Date.now()
  return new Promise((resolve, reject) => {
    let child
    try {
      child = nodeSpawn(argv[0], argv.slice(1), {
        cwd,
        env: env || process.env,
        windowsHide: true,
        stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let timedOut = false
    let settled = false

    const append = (which, chunk) => {
      const text = chunk.toString('utf8')
      if (which === 'out') {
        stdoutBytes += Buffer.byteLength(text)
        if (stdoutBytes <= MAX_CAPTURE_BYTES) stdout += text
        else truncated = true
      } else {
        stderrBytes += Buffer.byteLength(text)
        if (stderrBytes <= MAX_CAPTURE_BYTES) stderr += text
        else truncated = true
      }
    }

    child.stdout.on('data', (c) => append('out', c))
    child.stderr.on('data', (c) => append('err', c))

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, graceMs).unref?.()
    }, timeoutMs)
    timer.unref?.()

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })

    child.on('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        exitCode,
        signal: signal || null,
        stdout: truncated ? `${stdout}\n[output truncated at ${MAX_CAPTURE_BYTES} bytes]` : stdout,
        stderr: truncated ? `${stderr}\n[output truncated at ${MAX_CAPTURE_BYTES} bytes]` : stderr,
        elapsedMs: Date.now() - started,
        timedOut,
      })
    })

    if (stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        /* child may exit before consuming stdin */
      })
      child.stdin.end(stdin, 'utf8')
    }
  })
}

module.exports = { spawn, MAX_CAPTURE_BYTES }
