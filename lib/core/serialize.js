'use strict'

// Frontmatter serializer for cards written by the tool (as opposed to by hand).
// Kept deliberately simple and deterministic so a card produced by
// `codex_skill_write` is stable across runs and diffs cleanly.

const BARE_SAFE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/

function scalar(value) {
  if (value === null || value === undefined) return '""'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '""'
  const text = String(value)
  if (text === '') return '""'
  // A newline cannot be represented in a single-line scalar without a block
  // scalar. Emitting one anyway produced a card that this package's own parser
  // could not read back (found by review), so refuse instead of writing garbage.
  if (/[\r\n]/.test(text)) {
    throw new Error('frontmatter values must be single-line; collapse the newlines before writing')
  }
  if (BARE_SAFE.test(text)) return text
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function flowList(list) {
  if (!Array.isArray(list) || list.length === 0) return '[]'
  return `[${list.map(scalar).join(', ')}]`
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function emit(value, indent, lines) {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isPlainObject(item)) {
        const entries = Object.entries(item)
        if (entries.length === 0) {
          lines.push(`${pad}- {}`)
          continue
        }
        const [firstKey, firstValue] = entries[0]
        if (isPlainObject(firstValue) || Array.isArray(firstValue)) {
          lines.push(`${pad}- ${firstKey}:`)
          emit(firstValue, indent + 4, lines)
          for (const [k, v] of entries.slice(1)) {
            if (isPlainObject(v) || Array.isArray(v)) {
              lines.push(`${pad}  ${k}:`)
              emit(v, indent + 4, lines)
            } else {
              lines.push(`${pad}  ${k}: ${scalar(v)}`)
            }
          }
        } else {
          lines.push(`${pad}- ${firstKey}: ${scalar(firstValue)}`)
          for (const [k, v] of entries.slice(1)) {
            if (isPlainObject(v) || Array.isArray(v)) {
              lines.push(`${pad}  ${k}:`)
              emit(v, indent + 4, lines)
            } else {
              lines.push(`${pad}  ${k}: ${scalar(v)}`)
            }
          }
        }
      } else if (Array.isArray(item)) {
        lines.push(`${pad}-`)
        emit(item, indent + 2, lines)
      } else {
        lines.push(`${pad}- ${scalar(item)}`)
      }
    }
    return
  }
  for (const [key, v] of Object.entries(value)) {
    if (isPlainObject(v)) {
      if (Object.keys(v).length === 0) {
        lines.push(`${pad}${key}: {}`)
      } else {
        lines.push(`${pad}${key}:`)
        emit(v, indent + 2, lines)
      }
    } else if (Array.isArray(v)) {
      const simple = v.every((item) => !isPlainObject(item) && !Array.isArray(item))
      if (simple) lines.push(`${pad}${key}: ${flowList(v)}`)
      else {
        lines.push(`${pad}${key}:`)
        emit(v, indent + 2, lines)
      }
    } else {
      lines.push(`${pad}${key}: ${scalar(v)}`)
    }
  }
}

/** @returns {string} a full card: fenced frontmatter + body */
function serializeCard(frontmatter, body = '') {
  const lines = []
  emit(frontmatter, 0, lines)
  return `---\n${lines.join('\n')}\n---\n\n${String(body).trim()}\n`
}

/** @returns {string} frontmatter block only (with fences) */
function serializeFrontmatter(frontmatter) {
  const lines = []
  emit(frontmatter, 0, lines)
  return `---\n${lines.join('\n')}\n---`
}

module.exports = { serializeCard, serializeFrontmatter, scalar }
