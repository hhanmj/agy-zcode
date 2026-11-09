/**
 * Durable, bounded, redacted trace of what an Antigravity CLI run actually
 * did, derived from its headless stream-json events.
 *
 * Every record is an AGY-internal execution observation (AGY's own steps and
 * AGY's own tool calls). Nothing here is a DSH tool call, and AGY's hidden
 * model reasoning is not part of the stream, so it is never recorded or
 * implied. Files live outside any repository (default ~/.dsh/agy-traces),
 * one NDJSON file per trace key (SHA-256 file names, no path traversal), with
 * per-trace event/byte caps and a global file-count rotation.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { errorText, type AgyStreamEvent, type AgyUsage } from './stream-events.js'
import type { SupervisionReport } from './supervision.js'

export const TRACE_SCHEMA = 1

export interface TraceLimits {
  maxEventsPerTrace: number
  maxBytesPerTrace: number
  maxTraces: number
}
export const DEFAULT_TRACE_LIMITS: TraceLimits = { maxEventsPerTrace: 2000, maxBytesPerTrace: 4 << 20, maxTraces: 200 }
/** Lifecycle records (run start/end, evidence) may still land this far past a full trace. */
const RESERVED_LIFECYCLE_EVENTS = 64

/** native: DSH child session; chat: main DSH session using an AGY model; task: antigravity tool runs. */
export type TraceKind = 'native' | 'chat' | 'task'
export interface TraceMeta {
  trace_key: string
  kind: TraceKind
  /** DSH Agent/Session id allowed to read this trace (the delegating parent). */
  owner: string | null
  child_id: string | null
  created_at: number
}
export interface TraceRecord {
  seq: number
  ts: number
  type: string
  run?: string
  [field: string]: unknown
}

// ── Redaction ────────────────────────────────────────────────────────────────

export interface SanitizeContext {
  /** Run working directory, rewritten to `.` in persisted text. */
  cwd?: string
  /** User home directory, rewritten to `~`. */
  home?: string
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]'],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED]'],
  [/\bya29\.[0-9A-Za-z._-]{20,}/g, '[REDACTED]'],
  [/\b1\/\/0[0-9A-Za-z_-]{20,}/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[REDACTED JWT]'],
  [/(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|authorization)\b["']?\s*[:=]\s*["']?)([^\s"'&;,]{4,})/gi, '$1[REDACTED]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, '$1[REDACTED]@'],
]

export function redactSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pathVariants(path: string): string[] {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (trimmed.length < 4) return []
  return [...new Set([trimmed, trimmed.replace(/\\/g, '/'), trimmed.replace(/\//g, '\\')])]
    .sort((a, b) => b.length - a.length)
}

/** Rewrite the run cwd to `.` and the home directory to `~` (case-insensitive on Windows). */
export function relativizePaths(text: string, ctx: SanitizeContext): string {
  let out = text
  const flags = process.platform === 'win32' ? 'gi' : 'g'
  for (const [path, replacement] of [[ctx.cwd, '.'], [ctx.home, '~']] as const) {
    if (!path) continue
    for (const variant of pathVariants(path)) out = out.replace(new RegExp(escapeRegExp(variant), flags), replacement)
  }
  return out
}

export function sanitizeText(text: string, ctx: SanitizeContext, max: number): string {
  const cleaned = relativizePaths(redactSecrets(text), ctx)
  return cleaned.length > max ? `${cleaned.slice(0, max)}… [+${cleaned.length - max} chars]` : cleaned
}

const SENSITIVE_KEY = /pass(?:word|wd)?|secret|token|api[-_]?key|credential|authorization|cookie|private[-_]?key/i
const CONTENT_KEY = /content|chunk|patch|diff|^code$|^body$|^data$|^input$|^text$/i
const MAX_PARAM_STRING = 400

/** Bounded, redacted copy of tool parameters; file bodies are replaced by their size. */
export function sanitizeValue(value: unknown, ctx: SanitizeContext, key = '', depth = 0): unknown {
  if (key && SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (key && CONTENT_KEY.test(key)) return `[omitted ${value.length} chars]`
    return sanitizeText(value, ctx, MAX_PARAM_STRING)
  }
  if (depth >= 4) return '[depth limit]'
  if (Array.isArray(value)) {
    if (key && CONTENT_KEY.test(key)) return `[omitted ${value.length} items]`
    const items = value.slice(0, 16).map((item) => sanitizeValue(item, ctx, '', depth + 1))
    if (value.length > 16) items.push(`[+${value.length - 16} more]`)
    return items
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    const entries = Object.entries(value as Record<string, unknown>)
    for (const [k, v] of entries.slice(0, 32)) out[k] = sanitizeValue(v, ctx, k, depth + 1)
    if (entries.length > 32) out['…'] = `[+${entries.length - 32} more keys]`
    return out
  }
  return String(value)
}

// ── Store ────────────────────────────────────────────────────────────────────

interface TraceFileState {
  file: string
  seq: number
  count: number
  bytes: number
  capped: boolean
}

export interface TracePage {
  meta: TraceMeta
  events: TraceRecord[]
  nextCursor: number
  hasMore: boolean
  total: number
}

/** Append-only NDJSON trace files. All failures are contained: tracing never breaks a run. */
export class TraceStore {
  private readonly states = new Map<string, TraceFileState>()

  constructor(
    readonly dir: string,
    readonly limits: TraceLimits = DEFAULT_TRACE_LIMITS,
    private readonly warn: (message: string) => void = () => {},
  ) {}

  fileOf(key: string): string {
    return join(this.dir, `${createHash('sha256').update(key).digest('hex')}.ndjson`)
  }

  /** Create the trace (meta line) if absent; an existing trace keeps its owner. */
  ensure(meta: Omit<TraceMeta, 'created_at'>): void {
    const file = this.fileOf(meta.trace_key)
    try {
      if (existsSync(file)) {
        const current = this.readMeta(meta.trace_key)
        if (current !== undefined && current.owner === null && meta.owner !== null) {
          this.append(meta.trace_key, { type: 'owner', owner: meta.owner }, true)
        }
        return
      }
      mkdirSync(this.dir, { recursive: true })
      const record = { seq: 0, ts: Date.now(), type: 'meta', schema: TRACE_SCHEMA, ...meta, created_at: Date.now() }
      const line = `${JSON.stringify(record)}\n`
      appendFileSync(file, line, 'utf8')
      this.states.set(meta.trace_key, { file, seq: 0, count: 1, bytes: Buffer.byteLength(line), capped: false })
      this.rotate(file)
    } catch (error) {
      this.warn(`agy trace: cannot create trace ${meta.trace_key}: ${String(error)}`)
    }
  }

  private load(key: string): TraceFileState | undefined {
    const cached = this.states.get(key)
    if (cached !== undefined) return cached
    const file = this.fileOf(key)
    if (!existsSync(file)) return undefined
    const records = this.readRecords(file)
    const last = records.at(-1)
    const state: TraceFileState = {
      file,
      seq: last?.seq ?? 0,
      count: records.length,
      bytes: statSync(file).size,
      capped: records.some((record) => record.type === 'trace_truncated'),
    }
    this.states.set(key, state)
    return state
  }

  /** Append one record; returns its seq, or undefined when dropped (cap) or failed. */
  append(key: string, record: { type: string; run?: string; [field: string]: unknown }, lifecycle = false): number | undefined {
    try {
      const state = this.load(key)
      if (state === undefined) return undefined
      const full = state.count >= this.limits.maxEventsPerTrace || state.bytes >= this.limits.maxBytesPerTrace
      if (full && !state.capped) {
        state.capped = true
        this.write(state, { type: 'trace_truncated', reason: `trace cap reached (${this.limits.maxEventsPerTrace} events / ${this.limits.maxBytesPerTrace} bytes); later step records are dropped, lifecycle records are kept` })
      }
      if (state.capped && !lifecycle) return undefined
      if (state.count >= this.limits.maxEventsPerTrace + RESERVED_LIFECYCLE_EVENTS) return undefined
      return this.write(state, record)
    } catch (error) {
      this.warn(`agy trace: append failed for ${key}: ${String(error)}`)
      return undefined
    }
  }

  private write(state: TraceFileState, record: Record<string, unknown>): number {
    const seq = state.seq + 1
    const line = `${JSON.stringify({ seq, ts: Date.now(), ...record })}\n`
    appendFileSync(state.file, line, 'utf8')
    state.seq = seq
    state.count += 1
    state.bytes += Buffer.byteLength(line)
    return seq
  }

  private readRecords(file: string): TraceRecord[] {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return []
    }
    const out: TraceRecord[] = []
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const value = JSON.parse(line) as TraceRecord
        if (value !== null && typeof value === 'object' && typeof value.seq === 'number' && typeof value.type === 'string') out.push(value)
      } catch {
        // a torn trailing line after a crash is skipped
      }
    }
    return out
  }

  /** Fold the meta line plus any later owner claim. */
  readMeta(key: string): TraceMeta | undefined {
    return this.readAll(key)?.meta
  }

  readAll(key: string): { meta: TraceMeta; records: TraceRecord[] } | undefined {
    const records = this.readRecords(this.fileOf(key))
    const head = records[0]
    if (head === undefined || head.type !== 'meta' || head.trace_key !== key) return undefined
    const meta: TraceMeta = {
      trace_key: key,
      kind: head.kind === 'native' || head.kind === 'chat' ? head.kind : 'task',
      owner: typeof head.owner === 'string' ? head.owner : null,
      child_id: typeof head.child_id === 'string' ? head.child_id : null,
      created_at: typeof head.created_at === 'number' ? head.created_at : head.ts,
    }
    for (const record of records) {
      if (record.type === 'owner' && meta.owner === null && typeof record.owner === 'string') meta.owner = record.owner
    }
    return { meta, records: records.slice(1) }
  }

  /** Cursor pagination over records with seq > cursor. */
  page(key: string, cursor = 0, limit = 50): TracePage | undefined {
    const all = this.readAll(key)
    if (all === undefined) return undefined
    const after = all.records.filter((record) => record.seq > cursor)
    const events = after.slice(0, Math.max(0, limit))
    return {
      meta: all.meta,
      events,
      nextCursor: events.at(-1)?.seq ?? cursor,
      hasMore: after.length > events.length,
      total: all.records.length,
    }
  }

  /** Keep the newest `maxTraces` files (by mtime). */
  private rotate(keep: string): void {
    let names: string[]
    try {
      names = readdirSync(this.dir).filter((name) => /^[0-9a-f]{64}\.ndjson$/.test(name))
    } catch {
      return
    }
    if (names.length <= this.limits.maxTraces) return
    const files = names
      .map((name) => {
        const file = join(this.dir, name)
        try {
          return { file, mtime: statSync(file).mtimeMs }
        } catch {
          return { file, mtime: 0 }
        }
      })
      .filter((entry) => entry.file !== keep)
      .sort((a, b) => a.mtime - b.mtime)
    for (const entry of files.slice(0, names.length - this.limits.maxTraces)) {
      try {
        rmSync(entry.file, { force: true })
        for (const [key, state] of this.states) if (state.file === entry.file) this.states.delete(key)
      } catch {
        // best-effort rotation
      }
    }
  }
}

// ── Per-run recorder ─────────────────────────────────────────────────────────

export type TraceTransport = 'stream-json' | 'json' | 'text'
export interface RunStartInfo {
  mode: string
  label: string
  resumed: boolean
  conversation_id?: string
  transport: TraceTransport
  /** Whether per-run agy hook supervision was injected. */
  supervision?: 'enforced' | 'off'
  /** --model / --effort sent to agy (requested values, not proof of what ran). */
  model?: string | null
  effort?: string | null
  model_source?: string
  /** DSH skills exposed to AGY for this run. */
  shared_skills?: string[]
  /** Persistent session: the agy process this turn ran on. */
  process?: { pid?: number; turn: number; reused: boolean }
}
export interface RunEndInfo {
  outcome: string
  exit_code: number | null
  signal: string | null
  timed_out: boolean
  cancelled: boolean
  stderr?: string
  agy_error?: unknown
  diagnostic?: string
  supervision?: SupervisionReport
}
export interface EvidenceLike {
  task_id: string
  execution_status: string
  conversation_id: string | null
  changed_files: { path: string; change: string }[]
  diff_summary: { added_files: number; modified_files: number; deleted_files: number; changed_files_total: number; added_lines: number | null; deleted_lines: number | null }
  warnings: string[]
  evidence_complete: boolean
}

const MAX_PREVIEW = 600
const MAX_TEXT_PREVIEW = 240
const TERMINAL_STATES = new Set(['DONE', 'ERROR', 'CANCELLED', 'CANCELED', 'FAILED', 'SKIPPED'])

function seconds(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value * 1000) / 1000
}

/** Turns stream events of ONE run into durable trace records. */
export class RunTraceRecorder {
  private readonly toolSteps = new Set<number>()
  private readonly textPreview = new Map<number, { preview: string; chars: number }>()
  private readonly reportedSteps = new Set<string>()
  private malformed = 0
  private toolCalls = 0
  private toolErrors = 0
  private steps = new Set<number>()
  private conversationId: string | undefined

  constructor(
    private readonly store: TraceStore,
    readonly key: string,
    readonly run: string,
    private readonly ctx: SanitizeContext,
  ) {}

  private add(record: { type: string; [field: string]: unknown }, lifecycle = false): void {
    this.store.append(this.key, { run: this.run, ...record }, lifecycle)
  }

  start(info: RunStartInfo): void {
    if (info.conversation_id) this.conversationId = info.conversation_id
    this.add({ type: 'run_start', ...info, label: sanitizeText(info.label, this.ctx, 200) }, true)
  }

  transport(transport: TraceTransport, reason: string): void {
    this.add({ type: 'transport', transport, reason }, true)
  }

  onEvent(event: AgyStreamEvent): void {
    try {
      this.record(event)
    } catch {
      // never let a malformed event break the run
    }
  }

  private record(event: AgyStreamEvent): void {
    const ctx = this.ctx
    switch (event.kind) {
      case 'init':
        if (event.conversationId) this.conversationId = event.conversationId
        this.add({
          type: 'init',
          conversation_id: event.conversationId ?? null,
          permission_mode: event.permissionMode ?? null,
          tool_count: event.tools.length,
          tools: event.tools.slice(0, 128),
        })
        return
      case 'step': {
        const step = event.stepIndex ?? -1
        if (step >= 0) this.steps.add(step)
        const state = event.state ?? 'UNKNOWN'
        const terminal = TERMINAL_STATES.has(state)
        const extra = Object.keys(event.extra).length > 0 ? { extra: sanitizeValue(event.extra, ctx) } : {}
        if (event.stepType === 'tool' || event.toolInfo !== undefined) {
          const tool = event.toolName ?? event.toolInfo?.name ?? null
          if (!this.toolSteps.has(step)) {
            this.toolSteps.add(step)
            this.toolCalls += 1
            this.add({
              type: 'tool_call', step, step_type: event.stepType ?? null, state, tool,
              parameters: sanitizeValue(event.toolInfo?.parameters ?? null, ctx), ...extra,
            })
          }
          if (!terminal) return
          const error = event.toolInfo?.error
          const failed = state === 'ERROR' || (error !== undefined && error !== null)
          if (failed) this.toolErrors += 1
          const output = event.toolInfo?.output
          const outputText = output === undefined || output === null ? undefined : typeof output === 'string' ? output : JSON.stringify(output)
          this.add({
            type: 'tool_result', step, step_type: event.stepType ?? null, state, tool,
            duration_s: seconds(event.durationSeconds) ?? null,
            ...(outputText !== undefined ? { output_preview: sanitizeText(outputText, ctx, MAX_PREVIEW), output_chars: outputText.length } : {}),
            ...(failed ? { error: sanitizeText(errorText(error) ?? state, ctx, MAX_PREVIEW) } : {}),
            ...extra,
          })
          return
        }
        if (event.stepType === 'agent_response') {
          const entry = this.textPreview.get(step) ?? { preview: '', chars: 0 }
          if (event.textDelta) {
            entry.chars += event.textDelta.length
            if (entry.preview.length < MAX_TEXT_PREVIEW) entry.preview += event.textDelta.slice(0, MAX_TEXT_PREVIEW - entry.preview.length)
            this.textPreview.set(step, entry)
          }
          if (!terminal) return
          this.textPreview.delete(step)
          this.add({
            type: 'response_step', step, state,
            duration_s: seconds(event.durationSeconds) ?? null,
            text_chars: entry.chars,
            ...(entry.chars > 0 ? { text_preview: sanitizeText(entry.preview, ctx, MAX_TEXT_PREVIEW) } : {}),
            ...(event.usage ? { usage: event.usage } : {}),
            ...extra,
          })
          return
        }
        if (event.stepType === 'user_input') {
          if (terminal) this.add({ type: 'user_input', step, state })
          return
        }
        // Unverified step vocabulary: record first observation and terminal state.
        const marker = `${step}:${terminal ? 'end' : 'start'}`
        if (this.reportedSteps.has(marker)) return
        this.reportedSteps.add(marker)
        this.add({
          type: 'step', step, step_type: event.stepType ?? null, state,
          duration_s: seconds(event.durationSeconds) ?? null, ...extra,
        })
        return
      }
      case 'result':
      case 'reply':
        if (event.conversationId) this.conversationId = event.conversationId
        this.add({
          type: 'result',
          via: event.kind === 'reply' ? 'json-reply' : 'stream-json',
          status: event.status ?? null,
          conversation_id: event.conversationId ?? null,
          response_chars: event.response?.length ?? 0,
          ...(event.kind === 'result' ? {
            duration_s: seconds(event.durationSeconds) ?? null,
            num_turns: event.numTurns ?? null,
            ...(event.usage ? { usage: event.usage as AgyUsage } : {}),
          } : {}),
          ...(event.error ? { error: sanitizeText(event.error, ctx, MAX_PREVIEW) } : {}),
        }, true)
        return
      case 'unknown':
        this.add({ type: 'unknown_event', event: event.event, preview: sanitizeText(JSON.stringify(event.raw), ctx, MAX_PREVIEW) })
        return
      case 'malformed':
        this.malformed += 1
        if (this.malformed <= 3) this.add({ type: 'stream_noise', preview: sanitizeText(event.line, ctx, 300) })
        return
    }
  }

  end(info: RunEndInfo): void {
    this.add({
      type: 'run_end',
      outcome: info.outcome,
      exit_code: info.exit_code,
      signal: info.signal,
      timed_out: info.timed_out,
      cancelled: info.cancelled,
      conversation_id: this.conversationId ?? null,
      steps: this.steps.size,
      tool_calls: this.toolCalls,
      tool_errors: this.toolErrors,
      non_json_lines: this.malformed,
      ...(info.stderr && info.stderr.trim().length > 0 ? { stderr_tail: sanitizeText(info.stderr.trim().slice(-2000), this.ctx, 2000) } : {}),
      ...(info.agy_error !== undefined ? { agy_error: sanitizeValue(info.agy_error, this.ctx) } : {}),
      ...(info.diagnostic ? { diagnostic: sanitizeText(info.diagnostic, this.ctx, 1000) } : {}),
      ...(info.supervision !== undefined ? {
        supervision: {
          allowed: info.supervision.allowed,
          denied: info.supervision.denied,
          reworks: info.supervision.reworks,
          tampered: info.supervision.tampered,
        },
        // Model names agy itself reported to the hooks: the only verified "effective" value.
        ...(info.supervision.effectiveModels.length > 0 ? { effective_model: info.supervision.effectiveModels.join(', ') } : {}),
      } : {}),
    }, true)
  }

  /** Record every non-allow hook decision (denials, Stop decisions) and tampering. */
  supervision(report: SupervisionReport): void {
    for (const decision of report.decisions) {
      if (decision.event === 'PreToolUse' && decision.decision === 'allow' && decision.rule !== 'cwd-redirected') continue
      this.add({
        type: 'supervision',
        event: decision.event,
        decision: decision.decision === '' ? (decision.event === 'Stop' ? 'stop' : '(empty)') : decision.decision,
        rule: decision.rule,
        ...(typeof decision.step === 'number' ? { step: decision.step } : {}),
        ...(decision.tool ? { tool: decision.tool } : {}),
        ...(decision.command ? { command: sanitizeText(decision.command, this.ctx, 300) } : {}),
        ...(decision.reason ? { reason: sanitizeText(decision.reason, this.ctx, MAX_PREVIEW) } : {}),
        ...(decision.termination_reason ? { termination_reason: decision.termination_reason } : {}),
      }, true)
    }
    if (report.tampered.length > 0) {
      this.add({ type: 'supervision_tamper', files: report.tampered, note: 'supervisor files changed during the run; treat this run as unsupervised' }, true)
    }
  }

  evidence(evidence: EvidenceLike): void {
    recordEvidence(this.store, this.key, this.run, evidence)
  }
}

/** Link a locally collected evidence report (never AGY's self-report) to a trace run. */
export function recordEvidence(store: TraceStore, key: string, run: string, evidence: EvidenceLike): void {
  store.append(key, {
    type: 'evidence',
    run,
    evidence_task: evidence.task_id,
    execution_status: evidence.execution_status,
    conversation_id: evidence.conversation_id,
    changed_files_total: evidence.diff_summary.changed_files_total,
    added_files: evidence.diff_summary.added_files,
    modified_files: evidence.diff_summary.modified_files,
    deleted_files: evidence.diff_summary.deleted_files,
    added_lines: evidence.diff_summary.added_lines,
    deleted_lines: evidence.diff_summary.deleted_lines,
    changed_files: evidence.changed_files.slice(0, 20).map((file) => `${file.change}: ${file.path}`),
    evidence_complete: evidence.evidence_complete,
    warnings: evidence.warnings.length,
    review_status: 'pending',
  }, true)
}

// ── Summary ──────────────────────────────────────────────────────────────────

export interface TraceSummary {
  trace_key: string
  kind: TraceKind
  child_id: string | null
  runs: number
  active: boolean
  lifecycle: {
    started: boolean
    execution: string
    evidence: string
    review: 'pending'
  }
  current_run: Record<string, unknown> | null
  tools_used: Record<string, { calls: number; errors: number }>
  conversation_ids: string[]
  total_events: number
  truncated: boolean
  last_event: { seq: number; ts: number; type: string } | null
}

/**
 * Derive the four acceptance stages separately: started, execution outcome,
 * local file evidence, and review — which is ALWAYS pending here because only
 * the delegating DSH agent can verify behavior and accept the work.
 */
export function summarizeTrace(meta: TraceMeta, records: readonly TraceRecord[], activeRuns: ReadonlySet<string>): TraceSummary {
  const runs = records.filter((record) => record.type === 'run_start')
  const lastStart = runs.at(-1)
  const tools: Record<string, { calls: number; errors: number }> = {}
  const conversations = new Set<string>()
  for (const record of records) {
    if (typeof record.conversation_id === 'string' && record.conversation_id.length > 0) conversations.add(record.conversation_id)
    if (record.type === 'tool_call') {
      const name = typeof record.tool === 'string' ? record.tool : '(unnamed)'
      tools[name] ??= { calls: 0, errors: 0 }
      tools[name].calls += 1
    }
    if (record.type === 'tool_result' && record.error !== undefined) {
      const name = typeof record.tool === 'string' ? record.tool : '(unnamed)'
      tools[name] ??= { calls: 0, errors: 0 }
      tools[name].errors += 1
    }
  }
  let currentRun: Record<string, unknown> | null = null
  let execution = 'not-started'
  let evidenceState = 'not-applicable'
  const active = lastStart?.run !== undefined && activeRuns.has(lastStart.run)
  if (lastStart !== undefined) {
    const runId = lastStart.run
    const own = records.filter((record) => record.run === runId)
    const end = own.find((record) => record.type === 'run_end')
    const evidence = own.findLast((record) => record.type === 'evidence')
    const result = own.findLast((record) => record.type === 'result')
    const calls = own.filter((record) => record.type === 'tool_call')
    const results = own.filter((record) => record.type === 'tool_result')
    const finished = new Set(results.map((record) => record.step))
    const running = calls.filter((record) => !finished.has(record.step)).at(-1)
    execution = end !== undefined ? String(end.outcome) : active ? 'running' : 'interrupted (no run_end recorded and no live process)'
    evidenceState = evidence !== undefined
      ? (evidence.evidence_complete === true ? 'collected' : 'incomplete')
      : end !== undefined ? 'not-collected' : 'pending'
    currentRun = {
      run: runId,
      mode: lastStart.mode,
      transport: lastStart.transport,
      started_at: lastStart.ts,
      ended_at: end?.ts ?? null,
      outcome: end?.outcome ?? null,
      result_status: result?.status ?? null,
      conversation_id: (end?.conversation_id ?? result?.conversation_id ?? lastStart.conversation_id ?? null),
      steps: new Set(own.filter((record) => typeof record.step === 'number').map((record) => record.step)).size,
      tool_calls: calls.length,
      tool_errors: results.filter((record) => record.error !== undefined).length,
      running_tool: active && running !== undefined ? { step: running.step, tool: running.tool, since: running.ts } : null,
      model: {
        requested: lastStart.model ?? null,
        effort: lastStart.effort ?? null,
        source: lastStart.model_source ?? null,
        effective: end?.effective_model ?? null,
        verified: end?.effective_model !== undefined,
      },
      supervision: lastStart.supervision === 'enforced'
        ? (end?.supervision ?? { state: active ? 'live (decisions are merged when the run ends; denials already appear as tool errors)' : 'no report' })
        : 'off',
      evidence: evidence === undefined ? null : {
        task: evidence.evidence_task,
        changed_files_total: evidence.changed_files_total,
        evidence_complete: evidence.evidence_complete,
        execution_status: evidence.execution_status,
      },
    }
  }
  const last = records.at(-1)
  return {
    trace_key: meta.trace_key,
    kind: meta.kind,
    child_id: meta.child_id,
    runs: runs.length,
    active,
    lifecycle: { started: lastStart !== undefined, execution, evidence: evidenceState, review: 'pending' },
    current_run: currentRun,
    tools_used: tools,
    conversation_ids: [...conversations],
    total_events: records.length,
    truncated: records.some((record) => record.type === 'trace_truncated'),
    last_event: last === undefined ? null : { seq: last.seq, ts: last.ts, type: last.type },
  }
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19) + 'Z'
}

/** One compact line per record for model-facing rendering. */
/** ' process pid=… turn=… (reused|new)' for persistent-session turns. */
function processLabel(value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''
  const p = value as { pid?: unknown; turn?: unknown; reused?: unknown }
  return ` process pid=${String(p.pid ?? '?')} turn=${String(p.turn ?? '?')} ${p.reused === true ? 'reused' : 'new'}`
}

export function renderTraceRecord(record: TraceRecord): string {
  const head = `#${record.seq} ${stamp(record.ts)} ${record.type}`
  const step = typeof record.step === 'number' ? ` step ${record.step}` : ''
  switch (record.type) {
    case 'run_start':
      return `${head} run=${String(record.run)} mode=${String(record.mode)} transport=${String(record.transport)}${record.resumed ? ' resumed' : ''} model=${record.model ? String(record.model) : '(CLI default)'}${record.effort ? ` effort=${String(record.effort)}` : ''}${processLabel(record.process)}`
    case 'init':
      return `${head} conversation=${String(record.conversation_id)} permission_mode=${String(record.permission_mode)} tools=${String(record.tool_count)}`
    case 'tool_call':
      return `${head}${step} ${String(record.tool)} ${JSON.stringify(record.parameters)}`
    case 'tool_result':
      return `${head}${step} ${String(record.tool)} ${String(record.state)}${record.duration_s !== null && record.duration_s !== undefined ? ` ${String(record.duration_s)}s` : ''}${record.error !== undefined ? ` error: ${String(record.error)}` : record.output_preview !== undefined ? ` output: ${JSON.stringify(record.output_preview)}` : ''}`
    case 'response_step':
      return `${head}${step} ${String(record.state)} ${String(record.text_chars)} chars${record.text_preview ? ` ${JSON.stringify(record.text_preview)}` : ''}`
    case 'result':
      return `${head} status=${String(record.status)} response_chars=${String(record.response_chars)}${record.error ? ` error: ${String(record.error)}` : ''}`
    case 'run_end':
      return `${head} outcome=${String(record.outcome)} exit=${String(record.exit_code)} steps=${String(record.steps)} tool_calls=${String(record.tool_calls)} tool_errors=${String(record.tool_errors)}${record.diagnostic ? ` diagnostic: ${String(record.diagnostic)}` : ''}`
    case 'supervision':
      return `${head}${step} ${String(record.event)} decision=${String(record.decision)} rule=${String(record.rule)}${record.tool ? ` tool=${String(record.tool)}` : ''}${record.command ? ` command=${JSON.stringify(record.command)}` : ''}${record.reason ? ` reason: ${String(record.reason)}` : ''}`
    case 'evidence':
      return `${head} task=${String(record.evidence_task)} execution=${String(record.execution_status)} changed_files=${String(record.changed_files_total)} complete=${String(record.evidence_complete)} review=pending`
    default: {
      const { seq: _seq, ts: _ts, type: _type, run: _run, ...rest } = record
      return `${head}${step} ${JSON.stringify(rest).slice(0, 400)}`
    }
  }
}
