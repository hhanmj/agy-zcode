/**
 * Incremental decoding of the Antigravity CLI headless `--output-format
 * stream-json` protocol (verified against agy 1.4.0, see
 * scripts/fixtures/agy-1.4.0-*.ndjson).
 *
 * agy 1.4.7: `--output-format stream-json` and `--input-format stream-json`
 * are still documented (scripts/fixtures/agy-1.4.7-help.txt) and the 1.4.1–1.4.7
 * changelog lists no change to the headless output. The event shapes below were
 * NOT re-captured on 1.4.7 (that needs a model turn); they remain 1.4.0 captures
 * (provenance in scripts/fixtures/manifest.json), and anything new stays opaque.
 *
 * Observed vocabulary on 1.4.0 (only these shapes are interpreted):
 * - `init`: `conversation_id`, `init.cwd`, `init.tools[]`, `init.permission_mode`.
 * - `step_update`: `conversation_id`, `step_index`, `state` (ACTIVE | DONE |
 *   ERROR), `step_type` (user_input | agent_response | tool | ...), optional
 *   `text_delta`, `duration_seconds`, `usage`, `tool_name` and
 *   `tool_info` ({ name, parameters, output?, error?: { type, message } }).
 * - `result`: `conversation_id`, `status`, `response`, `duration_seconds`,
 *   `num_turns`, `usage`, optional `error`.
 *
 * `result.response` equals the concatenation of every streamed `text_delta`
 * (narration before tool calls included), so a consumer that streams deltas
 * must not append the final response again.
 *
 * Anything else (other event names, unknown step fields such as a
 * `subagent_info` payload that 1.4.0 did not emit in our captures) is kept as
 * opaque `extra`/`unknown` data instead of being guessed into a schema.
 */
import { StringDecoder } from 'node:string_decoder'

/** One NDJSON line larger than this (chars) is dropped and counted, never buffered forever. */
export const DEFAULT_MAX_LINE_CHARS = 8 << 20
/** Cap for retained non-JSON stdout (diagnostics / text-mode fallback). */
const MAX_NON_JSON_CHARS = 64 << 10
/** Cap for the accumulated streamed text (same order as the final response). */
const MAX_STREAMED_TEXT_CHARS = 16 << 20

/**
 * Split a byte stream into complete lines. UTF-8 sequences split across
 * chunks are decoded correctly (StringDecoder), CRLF is normalized, and a line
 * that grows past `maxLineChars` without a newline is discarded (counted in
 * `overflowedLines`) so a broken producer cannot exhaust memory.
 */
export class NdjsonLineSplitter {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private discarding = false
  overflowedLines = 0

  constructor(private readonly maxLineChars = DEFAULT_MAX_LINE_CHARS) {}

  push(chunk: Buffer | string): string[] {
    return this.consume(typeof chunk === 'string' ? chunk : this.decoder.write(chunk), false)
  }

  end(): string[] {
    return this.consume(this.decoder.end(), true)
  }

  private consume(text: string, final: boolean): string[] {
    const out: string[] = []
    let start = 0
    for (;;) {
      const idx = text.indexOf('\n', start)
      if (idx < 0) break
      const piece = text.slice(start, idx)
      start = idx + 1
      if (this.discarding) {
        this.discarding = false
        this.buffer = ''
        continue
      }
      const line = (this.buffer + piece).replace(/\r$/, '')
      this.buffer = ''
      if (line.length > this.maxLineChars) {
        this.overflowedLines += 1
        continue
      }
      if (line.trim().length > 0) out.push(line)
    }
    if (!this.discarding) {
      this.buffer += text.slice(start)
      if (this.buffer.length > this.maxLineChars) {
        this.buffer = ''
        this.discarding = true
        this.overflowedLines += 1
      }
    }
    if (final) {
      const tail = this.buffer.replace(/\r$/, '')
      if (!this.discarding && tail.trim().length > 0) out.push(tail)
      this.buffer = ''
      this.discarding = false
    }
    return out
  }
}

export interface AgyUsage {
  input_tokens?: number
  output_tokens?: number
  thinking_tokens?: number
  cache_read_tokens?: number
  total_tokens?: number
}

export interface AgyToolInfo {
  name?: string
  parameters?: unknown
  output?: unknown
  error?: { type?: string; message?: string } | unknown
}

export type AgyStreamEvent =
  | {
      kind: 'init'
      conversationId?: string
      cwd?: string
      tools: string[]
      permissionMode?: string
    }
  | {
      kind: 'step'
      conversationId?: string
      stepIndex?: number
      stepType?: string
      state?: string
      textDelta?: string
      toolName?: string
      toolInfo?: AgyToolInfo
      durationSeconds?: number
      usage?: AgyUsage
      /** Fields 1.4.0 did not emit in verified captures (e.g. `subagent_info`), kept opaque. */
      extra: Record<string, unknown>
    }
  | {
      kind: 'result'
      conversationId?: string
      status?: string
      response?: string
      error?: string
      durationSeconds?: number
      numTurns?: number
      usage?: AgyUsage
      extra: Record<string, unknown>
    }
  /** A bare `--output-format json` reply object (fallback when stream-json is unavailable). */
  | { kind: 'reply'; conversationId?: string; status?: string; response?: string; error?: string }
  | { kind: 'unknown'; event: string; raw: Record<string, unknown> }
  | { kind: 'malformed'; line: string }

const KNOWN_STEP_KEYS = new Set([
  'conversation_id', 'step_index', 'state', 'step_type', 'text_delta',
  'duration_seconds', 'usage', 'tool_name', 'tool_info',
])
const KNOWN_RESULT_KEYS = new Set([
  'conversation_id', 'status', 'response', 'error', 'duration_seconds', 'num_turns', 'usage',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
function usageOf(value: unknown): AgyUsage | undefined {
  if (!isRecord(value)) return undefined
  const usage: AgyUsage = {}
  for (const key of ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens'] as const) {
    const n = num(value[key])
    if (n !== undefined) usage[key] = n
  }
  return usage
}
/** AGY error payloads may be strings or objects; render a bounded string. */
export function errorText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (isRecord(value) && typeof value.message === 'string') {
    return typeof value.type === 'string' ? `${value.type}: ${value.message}` : value.message
  }
  try {
    return JSON.stringify(value).slice(0, 4096)
  } catch {
    return String(value)
  }
}
function extraOf(source: Record<string, unknown>, known: Set<string>): Record<string, unknown> {
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) if (!known.has(key)) extra[key] = value
  return extra
}

/** Parse one NDJSON line. Never throws. */
export function parseAgyStreamLine(line: string): AgyStreamEvent {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return { kind: 'malformed', line: line.slice(0, 2048) }
  }
  if (!isRecord(obj)) return { kind: 'malformed', line: line.slice(0, 2048) }
  const event = obj.event
  if (event === 'init') {
    const init = isRecord(obj.init) ? obj.init : {}
    return {
      kind: 'init',
      conversationId: str(obj.conversation_id),
      cwd: str(init.cwd),
      tools: Array.isArray(init.tools) ? init.tools.filter((t): t is string => typeof t === 'string') : [],
      permissionMode: str(init.permission_mode),
    }
  }
  if (event === 'step_update') {
    const step = isRecord(obj.step_update) ? obj.step_update : {}
    const info = isRecord(step.tool_info) ? step.tool_info : undefined
    return {
      kind: 'step',
      conversationId: str(step.conversation_id),
      stepIndex: num(step.step_index),
      stepType: str(step.step_type),
      state: str(step.state),
      textDelta: str(step.text_delta),
      toolName: str(step.tool_name) ?? str(info?.name),
      toolInfo: info === undefined ? undefined : {
        name: str(info.name),
        parameters: info.parameters,
        output: info.output,
        error: info.error,
      },
      durationSeconds: num(step.duration_seconds),
      usage: usageOf(step.usage),
      extra: extraOf(step, KNOWN_STEP_KEYS),
    }
  }
  if (event === 'result') {
    const result = isRecord(obj.result) ? obj.result : {}
    return {
      kind: 'result',
      conversationId: str(result.conversation_id),
      status: str(result.status),
      response: str(result.response),
      error: errorText(result.error),
      durationSeconds: num(result.duration_seconds),
      numTurns: num(result.num_turns),
      usage: usageOf(result.usage),
      extra: extraOf(result, KNOWN_RESULT_KEYS),
    }
  }
  if (typeof event === 'string') return { kind: 'unknown', event, raw: obj }
  if ('status' in obj || 'conversation_id' in obj || 'response' in obj) {
    return {
      kind: 'reply',
      conversationId: str(obj.conversation_id),
      status: str(obj.status),
      response: str(obj.response),
      error: errorText(obj.error),
    }
  }
  return { kind: 'unknown', event: '(none)', raw: obj }
}

/** Same reply shape the foreground json path historically consumed. */
export interface AgyReply {
  conversation_id?: string
  status?: string
  response?: string
  error?: string
}

/** Folds parsed events into the run state the provider needs at exit. */
export class AgyStreamAccumulator {
  conversationId: string | undefined
  status: string | undefined
  response: string | undefined
  error: string | undefined
  sawTerminal = false
  sawDelta = false
  streamedText = ''
  private streamedOverflow = false
  private nonJson = ''
  malformedLines = 0

  apply(event: AgyStreamEvent): void {
    switch (event.kind) {
      case 'init':
        if (event.conversationId) this.conversationId = event.conversationId
        return
      case 'step':
        if (event.conversationId && this.conversationId === undefined) this.conversationId = event.conversationId
        if (event.textDelta !== undefined && event.textDelta.length > 0) {
          this.sawDelta = true
          if (this.streamedText.length + event.textDelta.length <= MAX_STREAMED_TEXT_CHARS) this.streamedText += event.textDelta
          else this.streamedOverflow = true
        }
        return
      case 'result':
      case 'reply':
        this.sawTerminal = true
        if (event.conversationId) this.conversationId = event.conversationId
        if (event.status !== undefined) this.status = event.status
        if (event.response !== undefined) this.response = event.response
        if (event.error !== undefined) this.error = event.error
        return
      case 'malformed':
        this.malformedLines += 1
        if (this.nonJson.length < MAX_NON_JSON_CHARS) this.nonJson += `${event.line}\n`
        return
      default:
        return
    }
  }

  /** The terminal reply, or undefined when the stream ended without one. */
  reply(): AgyReply | undefined {
    if (!this.sawTerminal) return undefined
    return {
      conversation_id: this.conversationId,
      status: this.status,
      response: this.response,
      error: this.error,
    }
  }

  /** Text to surface when no terminal reply arrived (streamed deltas, else raw non-JSON stdout). */
  fallbackText(): string {
    if (this.streamedText.length > 0) return this.streamedText + (this.streamedOverflow ? '\n[streamed text truncated]' : '')
    return this.nonJson
  }
}

/**
 * agy 1.4.0 changelog: a turn that terminates on an agent or model API failure
 * prints `AGY_ERROR: {...}` on stderr and exits 3. The exact payload was not
 * observed in our captures, so it is returned as parsed JSON (or raw text).
 */
export function parseAgyErrorLine(stderr: string): unknown {
  const lines = stderr.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? ''
    const at = line.indexOf('AGY_ERROR:')
    if (at < 0) continue
    const body = line.slice(at + 'AGY_ERROR:'.length).trim()
    try {
      return JSON.parse(body) as unknown
    } catch {
      return body.slice(0, 2048)
    }
  }
  return undefined
}
