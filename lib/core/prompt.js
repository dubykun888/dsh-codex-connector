'use strict'

// Prompt assembly: capability card body + rendered inputs + run context.
//
// The card body is the prompt template; {{name}} placeholders are filled from
// the caller's inputs. Required inputs that are missing fail EARLY here rather
// than producing a half-specified prompt that Codex would answer confidently
// and wrongly.

function placeholderNames(text) {
  const names = new Set()
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g
  let m
  while ((m = re.exec(text)) !== null) names.add(m[1])
  return [...names]
}

function renderTemplate(text, values) {
  return String(text).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, name) => {
    const v = values[name]
    if (v === undefined || v === null || v === '') return whole
    return String(v)
  })
}

/**
 * @param {object} card
 * @param {Record<string, unknown>} inputs
 * @param {{ workspace: string, collectTo?: string, runId?: string }} context
 */
function buildPrompt(card, inputs = {}, context = {}) {
  const declared = Array.isArray(card.inputs) ? card.inputs : []
  const values = {}
  const missing = []
  for (const input of declared) {
    const name = input && input.name
    if (!name) continue
    let value = inputs[name]
    if (value === undefined && input.default !== undefined) value = input.default
    if ((value === undefined || value === '') && input.required) missing.push(name)
    if (value !== undefined) values[name] = value
  }
  // Undeclared inputs still render, so a card can accept opportunistic extras.
  for (const [k, v] of Object.entries(inputs)) {
    if (values[k] === undefined) values[k] = v
  }
  if (missing.length > 0) {
    const error = new Error(
      `capability "${card.id}" is missing required input(s): ${missing.join(', ')}`,
    )
    error.code = 'MISSING_INPUTS'
    error.missing = missing
    throw error
  }

  let body = renderTemplate(card.body, values)
  const unreplaced = placeholderNames(body)
  if (unreplaced.length > 0) {
    const error = new Error(
      `capability "${card.id}" still has unfilled placeholder(s): ${unreplaced.join(', ')}`,
    )
    error.code = 'UNFILLED_PLACEHOLDERS'
    error.placeholders = unreplaced
    throw error
  }

  const lines = [body.trim(), '', '---', '运行上下文（由 DSH 注入，不要臆测）:']
  lines.push(`- 工作区绝对路径: ${context.workspace}`)
  if (card.artifacts && card.artifacts.collectTo) {
    lines.push(`- 产物请落到: ${path(context.workspace, card.artifacts.collectTo)}`)
  }
  if (context.runId) lines.push(`- 本次运行标识: ${context.runId}`)
  if (Array.isArray(card.skills) && card.skills.length > 0) {
    lines.push(`- 必须使用的 skill: ${card.skills.join(', ')}（若不可用请直接说明，不要用其他方式冒充）`)
  }
  lines.push('- 完成后用一句话给出结论，并逐行列出你实际写出的文件绝对路径。')

  return { prompt: lines.join('\n'), values }
}

function path(workspace, rel) {
  const p = require('node:path')
  return p.isAbsolute(rel) ? rel : p.join(workspace, rel)
}

module.exports = { buildPrompt, renderTemplate, placeholderNames }
