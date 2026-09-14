'use strict'

// Compile an author-facing parameter spec into the raw JSON Schema the tool
// registry stores and the model sees.
//
// Why this exists instead of relying on `defineTool`: the harness compiles its
// OWN spec dialect (`parameterSchemaSpecToJsonSchema`, whose property nodes are
// `{ type: 'string' | 'object' | 'json' | ... }`), and passing raw JSON Schema
// through it is not a documented equivalence — JSON Schema allows shapes its
// author dialect rejects. Compiling here keeps one dialect for our definitions
// and registers exactly what the model should see, matching the shapes observed
// in the live tool catalog (`pwsh`, `read`, `write` all publish raw JSON Schema
// with `properties`/`required`).
//
// One deliberate omission: `additionalProperties` is left OFF the root object.
// DSH's own author dialect has an "implicit open object root", and several
// shipped tools (e.g. web_search's `queries`) neither set it nor enumerate every
// key, so refusing extra keys at the root could reject valid calls. Unknown
// arguments are therefore accepted and ignored, which is the safer failure mode
// for a tool that mostly forwards its arguments to a worker.

/**
 * @param {Record<string, object>} spec map of argument name -> type spec
 * @returns {{ type: 'object', properties: Record<string, object>, required: string[] }}
 */
function compileParameters(spec = {}) {
  const properties = {}
  const required = []
  for (const [name, raw] of Object.entries(spec)) {
    if (!raw || typeof raw !== 'object') {
      throw new TypeError(`parameter "${name}" must be an object describing its type`)
    }
    const { required: isRequired, description, ...rest } = raw
    if (isRequired === true) required.push(name)
    properties[name] = compileNode(rest, `parameter "${name}"`)
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

const KNOWN_KEYS = new Set([
  'type',
  'description',
  'enum',
  'const',
  'items',
  'properties',
  'additionalProperties',
  'required',
])

function compileNode(spec, where) {
  // Anything outside the known set is REJECTED rather than dropped. Silently
  // ignoring a key the author wrote (e.g. `default`, `minLength`, `oneOf`) makes
  // the spec look accepted while doing nothing — and a dropped `oneOf` degrades
  // the argument to "any JSON" (both found by adversarial review).
  for (const key of Object.keys(spec)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new TypeError(
        `${where}: unsupported key "${key}". Supported: ${[...KNOWN_KEYS].join(', ')}`,
      )
    }
  }
  if (spec.required !== undefined && typeof spec.required !== 'boolean') {
    throw new TypeError(`${where}: required must be a boolean (got ${JSON.stringify(spec.required)})`)
  }
  const node = {}
  if (spec.type !== undefined) {
    const type = spec.type
    if (!['string', 'number', 'integer', 'boolean', 'array', 'object', 'null', 'json'].includes(type)) {
      throw new TypeError(`${where}: unsupported type "${type}"`)
    }
    // `json` is author-facing shorthand for "any lossless JSON" and has no JSON
    // Schema keyword of its own; the empty schema {} accepts anything.
    if (type !== 'json') node.type = type
  }
  if (spec.description !== undefined) node.description = spec.description
  if (spec.enum !== undefined) {
    if (!Array.isArray(spec.enum) || spec.enum.length === 0) {
      throw new TypeError(`${where}: enum must be a non-empty array`)
    }
    node.enum = [...spec.enum]
    if (node.type === undefined) {
      const kinds = [...new Set(spec.enum.map((v) => (v === null ? 'null' : typeof v)))]
      if (kinds.length === 1) {
        node.type = kinds[0] === 'integer' ? 'integer' : kinds[0]
      }
    }
  }
  if (spec.const !== undefined) node.const = spec.const
  if (spec.items !== undefined) {
    if (spec.type !== 'array') throw new TypeError(`${where}: items is only valid with type "array"`)
    node.items = compileNode(spec.items, `${where}.items`)
  }
  if (spec.properties !== undefined) {
    if (spec.type !== 'object') throw new TypeError(`${where}: properties is only valid with type "object"`)
    const nested = compileParameters(spec.properties)
    node.properties = nested.properties
    if (nested.required) node.required = nested.required
  }
  if (spec.additionalProperties !== undefined) node.additionalProperties = Boolean(spec.additionalProperties)
  return node
}

module.exports = { compileParameters }
