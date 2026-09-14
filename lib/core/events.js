'use strict'

// JSONL event parsing for `codex exec --json`.
//
// Schema is not guessed: it was captured from a real run (DESIGN.md §1.2.1).
//
//   {"type":"thread.started","thread_id":"..."}
//   {"type":"turn.started"}
//   {"type":"error","message":"Reconnecting... 2/5 (request timed out)"}
//   {"type":"item.completed","item":{"id":"item_0","type":"error","message":"..."}}
//   {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"..."}}
//   {"type":"turn.completed","usage":{...}}
//
// Two rules that are easy to get wrong and were both observed in the field:
//
//   1. A transport notification is NOT failure, and it does not have a single
//      shape. Measured across two runs:
//        run A: {"type":"error","message":"Falling back from WebSockets..."}
//        run B: {"type":"item.completed","item":{"type":"error","message":
//                "Falling back from WebSockets to HTTPS transport..."}}
//      In BOTH runs the agent still answered and `turn.completed` arrived. So
//      classification is by MEANING, not by event shape: reconnect/transport
//      chatter is a warning; a model/request rejection is a real failure.
//   2. stdout can carry non-JSON lines (PowerShell noise, native stderr merged
//      into the same stream). Parse line by line and never JSON.parse the blob.

/** Transport chatter that a successful run can legitimately contain. */
const TRANSIENT_PATTERNS = [
  /Reconnecting/i,
  /Falling back from WebSockets/i,
  /WebSocket/i,
  /transport/i,
  /ECONNRESET/i,
  /socket hang up/i,
]

/** A rejection the run cannot recover from. */
const FATAL_PATTERNS = [
  /is not supported when using Codex/i,
  /model .* not found/i,
  /unknown model/i,
  /invalid_api_key/i,
  /unauthorized/i,
  /401\b/,
  /403\b/,
  /quota/i,
  /rate limit/i,
]

function classifyMessage(message) {
  const text = String(message || '')
  if (FATAL_PATTERNS.some((re) => re.test(text))) return 'fatal'
  if (TRANSIENT_PATTERNS.some((re) => re.test(text))) return 'transient'
  // Unknown text: only treat a bare connect/timeout complaint as transient.
  if (/timed out|timeout/i.test(text)) return 'transient'
  return 'fatal'
}

/**
 * @param {string} text raw stdout (may be dirty)
 */
function parseEvents(text) {
  const events = []
  const dirty = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (line[0] !== '{') {
      dirty.push(line)
      continue
    }
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') events.push(parsed)
      else dirty.push(line)
    } catch {
      dirty.push(line)
    }
  }
  return summarize(events, dirty)
}

function summarize(events, dirty) {
  const agentMessages = []
  const realErrors = []
  const transportErrors = []
  const items = []
  let threadId
  let usage
  let sawTurnCompleted = false
  let sawTurnStarted = false

  for (const ev of events) {
    switch (ev.type) {
      case 'thread.started':
        if (typeof ev.thread_id === 'string') threadId = ev.thread_id
        break
      case 'turn.started':
        sawTurnStarted = true
        break
      case 'turn.completed':
        sawTurnCompleted = true
        if (ev.usage && typeof ev.usage === 'object') usage = ev.usage
        break
      case 'error': {
        // A plain error event is USUALLY transport noise, but not always: a
        // fatal shape such as {"type":"error","message":"unknown model"} would
        // otherwise be swallowed while the run still reported success. Classify
        // by meaning here too, exactly as the item path does.
        if (typeof ev.message === 'string') {
          if (classifyMessage(ev.message) === 'transient') transportErrors.push(ev.message)
          else realErrors.push(ev.message)
        }
        break
      }
      case 'item.completed': {
        const item = ev.item || {}
        items.push(item)
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          agentMessages.push(item.text)
        } else if (item.type === 'error') {
          const message = typeof item.message === 'string' ? item.message : 'unknown error'
          // Shape is not meaning: an item-wrapped transport notice is still a
          // notice (measured — the stream that produced CONNECTOR_OK contained
          // exactly this).
          if (classifyMessage(message) === 'transient') transportErrors.push(message)
          else realErrors.push(message)
        }
        break
      }
      default:
        break
    }
  }

  const warnings = []
  if (transportErrors.length > 0) {
    warnings.push(
      `transport: ${transportErrors.length} transient notice(s) ignored (e.g. "${String(transportErrors[0]).slice(0, 80)}")`,
    )
  }
  if (dirty.length > 0) {
    warnings.push(`stdout: ${dirty.length} non-JSON line(s) ignored`)
  }

  // Success requires a completed turn and no REAL error. Transport notices never
  // fail a run: the run that produced CONNECTOR_OK contained a WebSocket
  // fallback notice as an item-wrapped error (measured, see the header note).
  const ok = sawTurnCompleted && realErrors.length === 0

  return {
    ok,
    sawTurnStarted,
    sawTurnCompleted,
    threadId,
    usage,
    summary: agentMessages.length > 0 ? agentMessages[agentMessages.length - 1] : '',
    agentMessages,
    errors: realErrors,
    transportErrors,
    dirtyLines: dirty,
    warnings,
    eventCount: events.length,
  }
}

module.exports = { parseEvents, summarize, classifyMessage }
