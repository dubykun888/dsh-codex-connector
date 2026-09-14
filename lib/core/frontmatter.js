'use strict'

// Minimal YAML frontmatter parser, scoped to exactly what a capability card
// uses. Deliberately dependency-free: the plugin must load with zero installed
// modules, and a full YAML parser would also accept constructs we do not want
// to support silently in a file that drives an external agent.
//
// Supported: nested maps by indentation, block sequences (`- `), sequence items
// that open a map (`- name: x`), flow sequences (`[a, b]`), quoted/bare scalars,
// booleans and numbers, and `#` comments. Unsupported constructs raise a clear
// error instead of misparsing.

const RE_KEY = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/

function stripComment(line) {
  let single = false
  let double = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === "'" && !double) single = !single
    else if (ch === '"' && !single && line[i - 1] !== '\\') double = !double
    else if (ch === '#' && !single && !double && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i)
    }
  }
  return line
}

function splitFlow(inner) {
  const parts = []
  let depth = 0
  let current = ''
  let quote = null
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (quote) {
      current += ch
      if (ch === quote && inner[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '[' || ch === '{') depth += 1
    if (ch === ']' || ch === '}') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim() !== '') parts.push(current)
  return parts.map((p) => p.trim())
}

function parseScalar(raw) {
  const text = String(raw).trim()
  if (text === '') return ''
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10)
  if (/^-?\d*\.\d+$/.test(text)) return Number.parseFloat(text)
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim()
    return inner === '' ? [] : splitFlow(inner).map(parseScalar)
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  return text
}

/**
 * @param {string} source frontmatter body, fenced content only
 * @returns {Record<string, unknown>}
 */
function parse(source) {
  const rows = []
  for (const raw of String(source).split(/\r?\n/)) {
    if (/^\s*\t/.test(raw)) throw new Error('tabs are not allowed for indentation')
    const line = stripComment(raw)
    if (line.trim() === '') continue
    rows.push({ indent: line.length - line.trimStart().length, text: line.trim() })
  }
  let cursor = 0

  function parseMap(indent) {
    const map = {}
    while (cursor < rows.length) {
      const row = rows[cursor]
      if (row.indent < indent) break
      if (row.indent > indent) throw new Error(`unexpected indent at "${row.text}"`)
      if (row.text.startsWith('- ')) break
      const kv = RE_KEY.exec(row.text)
      if (!kv) throw new Error(`expected "key: value", got "${row.text}"`)
      const [, key, valueText] = kv
      cursor += 1
      if (valueText.trim() !== '') {
        map[key] = parseScalar(valueText)
        continue
      }
      const next = rows[cursor]
      if (!next || next.indent <= indent) {
        map[key] = {}
        continue
      }
      map[key] = next.text.startsWith('- ') || next.text === '-' ? parseSeq(next.indent) : parseMap(next.indent)
    }
    return map
  }

  function parseSeq(indent) {
    const list = []
    while (cursor < rows.length) {
      const row = rows[cursor]
      if (row.indent < indent) break
      if (row.indent > indent) throw new Error(`unexpected indent in list at "${row.text}"`)
      if (!(row.text.startsWith('- ') || row.text === '-')) break
      const rest = row.text === '-' ? '' : row.text.slice(2).trim()
      const itemIndent = indent + 2
      cursor += 1
      if (rest === '') {
        const next = rows[cursor]
        if (next && next.indent > indent) {
          list.push(next.text.startsWith('- ') || next.text === '-' ? parseSeq(next.indent) : parseMap(next.indent))
        } else {
          list.push(null)
        }
        continue
      }
      const kv = RE_KEY.exec(rest)
      if (kv) {
        // `- key: value` opens a map whose subsequent keys sit at itemIndent.
        const item = {}
        const [, key, valueText] = kv
        if (valueText.trim() !== '') item[key] = parseScalar(valueText)
        else {
          const next = rows[cursor]
          if (next && next.indent > itemIndent) {
            item[key] = next.text.startsWith('- ') || next.text === '-' ? parseSeq(next.indent) : parseMap(next.indent)
          } else if (next && next.indent === itemIndent) {
            item[key] = {}
          } else {
            item[key] = {}
          }
        }
        // remaining sibling keys of this sequence item
        while (cursor < rows.length) {
          const peer = rows[cursor]
          if (peer.indent !== itemIndent) break
          if (peer.text.startsWith('- ')) break
          const peerKv = RE_KEY.exec(peer.text)
          if (!peerKv) throw new Error(`expected "key: value" in list item, got "${peer.text}"`)
          cursor += 1
          const [, pk, pv] = peerKv
          if (pv.trim() !== '') {
            item[pk] = parseScalar(pv)
          } else {
            const deeper = rows[cursor]
            item[pk] =
              deeper && deeper.indent > itemIndent
                ? deeper.text.startsWith('- ') || deeper.text === '-'
                  ? parseSeq(deeper.indent)
                  : parseMap(deeper.indent)
                : {}
          }
        }
        list.push(item)
        continue
      }
      list.push(parseScalar(rest))
    }
    return list
  }

  const first = rows[cursor]
  if (!first) return {}
  return first.text.startsWith('- ') || first.text === '-' ? parseSeq(first.indent) : parseMap(first.indent)
}

module.exports = { parse, parseScalar, stripComment }
