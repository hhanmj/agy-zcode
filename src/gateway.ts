/**
 * Anthropic Messages-compatible HTTP gateway in front of the agy CLI.
 *
 * ZCode custom model providers speak openai-chat-completions /
 * openai-responses / anthropic-messages over HTTP. This module implements the
 * anthropic-messages shape (POST {base}/messages, SSE streaming) so agy can be
 * registered as a ZCode model provider and used by native subagents without
 * MCP tool calls.
 *
 * Constraints inherited from the DSH native bridge (CLAUDE_HANDOFF.md):
 * - agy is a full agent, not a bare model: ZCode's system prompt and tool
 *   declarations are dropped, tool_use blocks are never emitted, and agy runs
 *   its own internal tool loop with the permissions configured for the CLI.
 * - Only real agy text deltas become content_block_delta events; tool progress
 *   rides in SSE comments so it never pollutes the conversation history.
 * - Multi-turn requests replay a transcript, or resume a stored agy
 *   conversation when the prior history hashes match exactly.
 * - Requests are served over ACP (agy acp) so agent_thought_chunk updates can
 *   be surfaced as Anthropic thinking blocks; the stream-json print mode drops
 *   thought content entirely. The legacy stream-json path remains as a
 *   fallback when ACP is unavailable.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgyStreamEvent, AgyUsage } from '../shared/stream-events.js'
import { AgyModelSelectionError, resolveSelection } from '../shared/models.js'
import type { RunnerConfig } from './config.js'
import { resolveAgy } from './proc.js'
import { AgyRunner, validateWorkspace, type AgyRun } from './runner.js'

declare const __AGY_MCP_VERSION__: string
const VERSION = typeof __AGY_MCP_VERSION__ === 'string' ? __AGY_MCP_VERSION__ : '0.0.0-dev'

export const DEFAULT_GATEWAY_PORT = 8378
const MAX_BODY_BYTES = 64 << 20
/** SSE keep-alive interval; AGY_GATEWAY_PING_MS overrides it (tests shrink it to assert pings). */
export const PING_MS = Number(process.env.AGY_GATEWAY_PING_MS) > 0 ? Number(process.env.AGY_GATEWAY_PING_MS) : 15_000
const MAX_CONVERSATION_ENTRIES = 200
const AUTOSTART_WAIT_MS = 8_000

export interface GatewayOptions {
  runner: AgyRunner
  config: RunnerConfig
  /** 0 listens on an ephemeral port (tests); the chosen port is reported back. */
  port: number
  host?: string
  token: string
  /** Absolute directory agy works in (there is no workspace in an HTTP request). */
  cwd: string
  log?: (message: string) => void
}

export interface GatewayHandle {
  server: Server
  port: number
  close: () => Promise<void>
}

// ── Errors shaped like Anthropic API errors ─────────────────────────────────

class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
  ) {
    super(message)
  }
}

function anthropicError(type: string, message: string): Record<string, unknown> {
  return { type: 'error', error: { type, message } }
}

// ── Auth token ──────────────────────────────────────────────────────────────

/** The provider apiKey: a persisted local secret (file permissions are a POSIX nicety). */
export function loadOrCreateToken(dataDir: string): string {
  const file = join(dataDir, 'gateway-token.txt')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing.length > 0) return existing
  } catch {
    // first start
  }
  const token = randomBytes(24).toString('hex')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(file, token + '\n', { encoding: 'utf8', mode: 0o600 })
  return token
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function bearerOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  const key = req.headers['x-api-key']
  return typeof key === 'string' && key.length > 0 ? key.trim() : undefined
}

// ── Conversation map: exact-prefix history hash → agy conversation ─────────

interface Turn {
  role: 'user' | 'assistant'
  text: string
}

interface ConversationEntry {
  task: string
  conversationId: string
  cwd: string
  model: string
  turns: number
  updatedAt: number
}

function historyHash(turns: readonly Turn[]): string {
  return createHash('sha256').update(JSON.stringify(turns)).digest('hex')
}

class ConversationMap {
  private readonly file: string
  constructor(
    dataDir: string,
    private readonly log: (message: string) => void,
  ) {
    this.file = join(dataDir, 'gateway-conversations.json')
  }

  private read(): Record<string, ConversationEntry> {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid conversation map')
      const out: Record<string, ConversationEntry> = {}
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = value as Partial<ConversationEntry> | null
        if (entry !== null && typeof entry === 'object' &&
          typeof entry.task === 'string' && typeof entry.conversationId === 'string' &&
          typeof entry.cwd === 'string' && typeof entry.model === 'string' &&
          typeof entry.turns === 'number' && Number.isFinite(entry.turns)) {
          out[key] = { task: entry.task, conversationId: entry.conversationId, cwd: entry.cwd, model: entry.model, turns: entry.turns, updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0 }
        }
      }
      return out
    } catch (error) {
      throw new Error('gateway conversation map is corrupt; refusing to overwrite it', { cause: error })
    }
  }

  find(prefixHash: string, cwd: string, model: string): ConversationEntry | undefined {
    try {
      const entry = this.read()[prefixHash]
      if (entry === undefined || entry.model !== model) return undefined
      if (entry.cwd.toLowerCase() !== cwd.toLowerCase()) return undefined
      return entry
    } catch (error) {
      this.log('gateway: could not read conversation map: ' + String(error))
      return undefined
    }
  }

  remember(prefixHash: string, entry: Omit<ConversationEntry, 'updatedAt'>, consumedHash?: string): void {
    try {
      const all = this.read()
      if (consumedHash !== undefined && all[consumedHash]?.task === entry.task) delete all[consumedHash]
      all[prefixHash] = { ...entry, updatedAt: Date.now() }
      const kept = Object.entries(all).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_CONVERSATION_ENTRIES)
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = this.file + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp'
      try {
        writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept), null, 2), 'utf8')
        renameSync(tmp, this.file)
      } finally {
        rmSync(tmp, { force: true })
      }
    } catch (error) {
      this.log('gateway: could not persist the conversation map: ' + String(error))
    }
  }
}

// ── Anthropic request → turns → prompt ──────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function blockText(block: Record<string, unknown>): string {
  const type = typeof block.type === 'string' ? block.type : ''
  if (type === 'text' && typeof block.text === 'string') return block.text
  if (type === 'tool_result') return '[tool result omitted]'
  if (type === 'tool_use') return '[tool call omitted]'
  if (type === 'image') return '[image omitted]'
  return '' // thinking, redacted_thinking, unknown blocks carry no prompt text
}

function turnsOf(messages: unknown): Turn[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new GatewayHttpError(400, 'invalid_request_error', '"messages" must be a non-empty array')
  }
  const turns: Turn[] = []
  for (const raw of messages) {
    if (!isRecord(raw)) throw new GatewayHttpError(400, 'invalid_request_error', 'each message must be an object')
    const role = raw.role
    if (role !== 'user' && role !== 'assistant') {
      throw new GatewayHttpError(400, 'invalid_request_error', 'message roles must be "user" or "assistant"')
    }
    const content = raw.content
    let text: string
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) text = content.filter(isRecord).map(blockText).join('')
    else throw new GatewayHttpError(400, 'invalid_request_error', 'message content must be a string or a block array')
    turns.push({ role, text })
  }
  return turns
}

/**
 * Fresh-run prompt: the single message verbatim, or a transcript when the
 * history cannot be resumed (unknown prefix / first contact).
 */
function transcriptPrompt(turns: readonly Turn[]): string {
  if (turns.length === 1) return turns[0].text
  const lines = [
    'You are continuing a chat with the user. Below is the prior conversation transcript; reply to the LAST user message, continuing naturally.',
    '',
    '[Conversation history]',
  ]
  for (const turn of turns.slice(0, -1)) {
    if (turn.text.length === 0) continue
    lines.push((turn.role === 'user' ? 'User: ' : 'Assistant: ') + turn.text)
  }
  const last = turns[turns.length - 1]
  if (last.role === 'user') {
    lines.push('', '[End of history]', '', '[The user now says]', last.text)
  } else {
    lines.push('', '[End of history — continue from the assistant message above]')
  }
  return lines.join('\n')
}

function requestWorkspace(system: unknown, fallback: string): string {
  const text = typeof system === 'string' ? system : Array.isArray(system)
    ? system.filter(isRecord).map((block) => typeof block.text === 'string' ? block.text : '').join('\n') : ''
  const match = /(?:^|\n)Working directory:[ \t]*([^\r\n]+)/i.exec(text)
  if (match === null) return fallback
  try {
    return validateWorkspace(match[1].trim())
  } catch {
    return fallback
  }
}

// ── Usage accounting (prompt side: last call; output side: sum) ─────────────

class UsageTracker {
  constructor(private readonly resumed: boolean) {}
  private lastInput: number | undefined
  private lastCacheRead: number | undefined
  private stepOutputSum = 0
  private resultInput: number | undefined
  private resultOutput: number | undefined

  observe(usage: AgyUsage | undefined, isResult: boolean): void {
    if (usage === undefined) return
    if (usage.input_tokens !== undefined) {
      this.lastInput = usage.input_tokens
      if (isResult) this.resultInput = usage.input_tokens
    }
    if (usage.cache_read_tokens !== undefined) this.lastCacheRead = usage.cache_read_tokens
    if (usage.output_tokens !== undefined) {
      if (isResult) this.resultOutput = usage.output_tokens
      else this.stepOutputSum += usage.output_tokens
    }
  }

  final(): { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } {
    const usage = {
      input_tokens: this.resumed ? this.lastInput ?? 0 : this.resultInput ?? this.lastInput ?? 0,
      output_tokens: this.resumed && this.stepOutputSum > 0 ? this.stepOutputSum : this.resultOutput ?? this.stepOutputSum,
    }
    return this.lastCacheRead !== undefined ? { ...usage, cache_read_input_tokens: this.lastCacheRead } : usage
  }
}

// ── SSE plumbing ────────────────────────────────────────────────────────────

function sseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n')
}

function sseComment(res: ServerResponse, text: string): void {
  res.write(': ' + text.replace(/\s+/g, ' ').slice(0, 160) + '\n\n')
}

/**
 * Periodic SSE pings for the whole life of a streaming response, including the
 * window before the first model output. ZCode kills a stream that stays idle
 * for 5 minutes (stream idle timeout); a long agy cold start or a long
 * thinking phase with no chunk yet would otherwise look dead. Returns a stop
 * function (idempotent) — always call it when the response ends.
 */
function startSsePing(res: ServerResponse): () => void {
  const timer = setInterval(() => {
    if (!res.destroyed) res.write('event: ping\ndata: {"type":"ping"}\n\n')
  }, PING_MS)
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }
}

// ── The gateway server ──────────────────────────────────────────────────────

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        reject(new GatewayHttpError(413, 'request_too_large', 'request body exceeds ' + MAX_BODY_BYTES + ' bytes'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => reject(new GatewayHttpError(400, 'invalid_request_error', 'could not read the request body')))
  })
}

function toolActivity(event: Extract<AgyStreamEvent, { kind: 'step' }>): string | undefined {
  if (event.stepType === 'tool' || event.toolInfo !== undefined) {
    const state = event.state === 'ERROR' ? 'failed' : event.state === 'DONE' ? 'done' : 'running'
    return 'agy tool ' + (event.toolName ?? 'tool') + ' ' + state
  }
  if (event.state === 'ERROR') return 'agy step error'
  return undefined
}

// ── ACP transport: streams agy thoughts as Anthropic thinking blocks ────────
// agy's stream-json print mode drops thought content (only usage counters
// survive); the ACP protocol emits agent_thought_chunk session updates. One
// persistent `agy acp` child serves all gateway requests, one ACP session per
// conversation prefix, so multi-turn chats keep server-side context.

const ACP_PROMPT_TIMEOUT_MS = 30 * 60 * 1000
const MAX_ACP_SESSION_ENTRIES = 256

class AcpUnavailableError extends Error {}

interface AcpRpcMessage {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code?: number; message?: string }
}

interface AcpSessionInfo {
  sessionId: string
  configOptions?: { id: string; currentValue?: string; options?: { value: string }[] }[]
}

interface AcpPromptResult {
  stopReason?: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

class AcpClient {
  private child: ChildProcess | null = null
  private ready: Promise<void> | null = null
  private nextId = 1
  private buffer = ''
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private readonly handlers = new Map<string, (update: Record<string, unknown> | undefined) => void>()
  private readonly hashSessions = new Map<string, { sessionId: string; model: string; cwd: string }>()
  private readonly log: (message: string) => void

  constructor(private readonly options: GatewayOptions) {
    this.log = options.log ?? (() => {})
  }

  ensure(): Promise<void> {
    if (this.child !== null && this.ready !== null) return this.ready
    this.buffer = ''
    const env = this.options.runner.baseEnv()
    const exe = resolveAgy(this.options.config.command, env)
    const child = spawn(exe, [...this.options.config.commandPrefixArgs, 'acp'], {
      cwd: tmpdir(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    })
    this.child = child
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => this.onData(chunk))
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', () => {})
    const cleanup = (why: string): void => {
      if (this.child !== child) return
      this.child = null
      this.ready = null
      const err = new Error('agy acp ' + why)
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(err)
      }
      this.pending.clear()
      this.handlers.clear()
      this.hashSessions.clear()
      this.log('gateway-acp: ' + why)
    }
    child.once('exit', (code) => cleanup('exited (' + String(code) + ')'))
    child.once('error', (err) => cleanup('failed to start: ' + String(err)))
    this.ready = this.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 30_000)
      .then(() => {})
      .catch((err: unknown) => {
        try {
          child.kill()
        } catch {
          // already gone
        }
        throw err
      })
    return this.ready
  }

  /** Like ConversationMap.find: model and workspace are part of the resume route. */
  sessionFor(hash: string, model: string, cwd: string): string | undefined {
    const entry = this.hashSessions.get(hash)
    if (entry === undefined || entry.model !== model) return undefined
    if (entry.cwd.toLowerCase() !== cwd.toLowerCase()) return undefined
    return entry.sessionId
  }

  /** A completed follow-up consumes its prior prefix so branches replay a transcript. */
  rememberSession(hash: string, sessionId: string, model: string, cwd: string, consumedHash?: string): void {
    if (consumedHash !== undefined && this.hashSessions.get(consumedHash)?.sessionId === sessionId) {
      this.hashSessions.delete(consumedHash)
    }
    this.hashSessions.set(hash, { sessionId, model, cwd })
    if (this.hashSessions.size > MAX_ACP_SESSION_ENTRIES) {
      const oldest = this.hashSessions.keys().next().value
      if (oldest !== undefined) this.hashSessions.delete(oldest)
    }
  }

  setHandler(sessionId: string, handler: (update: Record<string, unknown> | undefined) => void): void {
    this.handlers.set(sessionId, handler)
  }

  deleteHandler(sessionId: string): void {
    this.handlers.delete(sessionId)
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (line.length === 0) continue
      let msg: AcpRpcMessage
      try {
        msg = JSON.parse(line) as AcpRpcMessage
      } catch {
        continue
      }
      this.dispatch(msg)
    }
  }

  private dispatch(msg: AcpRpcMessage): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id as number)
      if (p !== undefined) {
        this.pending.delete(msg.id as number)
        clearTimeout(p.timer)
        if (msg.error !== undefined) p.reject(new Error(msg.error.message ?? 'acp error ' + String(msg.error.code)))
        else p.resolve(msg.result)
      }
      return
    }
    if (msg.method === 'session/update') {
      const sessionId = typeof msg.params?.sessionId === 'string' ? msg.params.sessionId : undefined
      const update = isRecord(msg.params?.update) ? msg.params.update : undefined
      if (sessionId !== undefined) this.handlers.get(sessionId)?.(update)
      return
    }
    if (msg.method === 'session/request_permission' && msg.id !== undefined) {
      // Match the legacy always-proceed behaviour: approve with the strongest
      // allow option offered, cancel when nothing is selectable.
      const opts = Array.isArray(msg.params?.options) ? (msg.params.options as { optionId: string; kind?: string }[]) : []
      const opt = opts.find((o) => o.kind === 'allow_always') ?? opts.find((o) => o.kind === 'allow_once') ?? opts[0]
      this.respond(msg.id, { outcome: opt !== undefined ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' } })
      return
    }
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this.respond(msg.id, undefined, { code: -32601, message: 'unsupported client method: ' + msg.method })
    }
  }

  private respond(id: number | string, result: unknown, error?: { code: number; message: string }): void {
    if (this.child === null) return
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error !== undefined ? { error } : { result }) }) + '\n')
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 120_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.child === null) {
        reject(new Error('agy acp is not running'))
        return
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('acp ' + method + ' timed out'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.child === null) return
    try {
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    } catch {
      // child died between the check and the write; cleanup rejects pending requests
    }
  }
}

let acpClientSingleton: AcpClient | undefined

function getAcpClient(options: GatewayOptions): AcpClient {
  acpClientSingleton ??= new AcpClient(options)
  return acpClientSingleton
}

async function handleMessages(options: GatewayOptions, body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await handleMessagesAcp(options, body, req, res)
  } catch (error) {
    if (error instanceof AcpUnavailableError && !res.headersSent) {
      (options.log ?? (() => {}))('gateway: ACP unavailable (' + error.message + '); using stream-json fallback')
      await handleMessagesLegacy(options, body, req, res)
      return
    }
    throw error
  }
}

async function handleMessagesAcp(options: GatewayOptions, body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { runner, cwd: configuredCwd, log = () => {} } = options
  const requestCwd = requestWorkspace(body.system, configuredCwd)
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (model.length === 0) throw new GatewayHttpError(400, 'invalid_request_error', '"model" is required')
  const stream = body.stream === true
  const turns = turnsOf(body.messages)
  const last = turns[turns.length - 1]
  if (last.text.trim().length === 0) {
    throw new GatewayHttpError(400, 'invalid_request_error', 'the final message contains no text content (agy has no image input on this path)')
  }
  const wantThinking = !(isRecord(body.thinking) && body.thinking.type === 'disabled')

  // Start the stream (and its keep-alive pings) BEFORE any slow setup work:
  // acp ensure/session setup, model validation and agy cold start can all take
  // minutes, and ZCode's stream idle watchdog would kill a silent response.
  // Fast request-level validation above still throws before this, so
  // malformed requests keep their clean JSON error responses.
  const stopPing = stream ? startSsePing(res) : undefined
  if (stream && !res.headersSent) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    sseEvent(res, 'message_start', {
      type: 'message_start',
      message: { id: 'msg_agy_pending', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    })
  }

  let baseModel = model
  let effort = ''
  try {
    const listed = await runner.models.list()
    const resolved = resolveSelection(listed, model)
    baseModel = resolved.args.model ?? model
    effort = resolved.args.effort ?? ''
  } catch (error) {
    if (error instanceof AgyModelSelectionError) {
      // The stream may already be open (early headers for the idle watchdog):
      // report through SSE instead of falling back to a bare res.end().
      stopPing?.()
      if (stream && res.headersSent) {
        sseEvent(res, 'error', anthropicError('invalid_request_error', error.message))
        res.end()
        return
      }
      throw new GatewayHttpError(400, 'invalid_request_error', error.message)
    }
    log('gateway-acp: cannot validate model ' + model + ' (' + String(error) + '); passing it to agy unvalidated')
  }
  // ZCode's reasoningLevel selector arrives as an Anthropic thinking budget
  // (the provider optionSpec map turns low/medium/high into budget_tokens).
  // It overrides the model's default effort; without it the default stands.
  if (isRecord(body.thinking) && body.thinking.type === 'enabled' && typeof body.thinking.budget_tokens === 'number') {
    const budget = body.thinking.budget_tokens
    effort = budget <= 4096 ? 'low' : budget <= 16384 ? 'medium' : 'high'
  }

  const acp = getAcpClient(options)
  try {
    await acp.ensure()
  } catch (error) {
    stopPing?.()
    if (stream && res.headersSent) {
      // Headers are already out, so the legacy fallback (which would restart
      // the response) is impossible: report the failure over SSE instead.
      const detail = error instanceof Error ? error.message : String(error)
      log('gateway-acp: unavailable after stream start (' + detail + '); reporting over SSE')
      sseEvent(res, 'error', anthropicError('api_error', 'agy acp unavailable: ' + detail))
      res.end()
      return
    }
    throw new AcpUnavailableError(error instanceof Error ? error.message : String(error))
  }

  const consumedHash = historyHash(turns.slice(0, -1))
  let sessionId = acp.sessionFor(consumedHash, model, requestCwd)
  let resumed = sessionId !== undefined
  let promptText = resumed ? last.text : transcriptPrompt(turns)

  const createSession = async (): Promise<void> => {
    const created = await acp.request('session/new', { cwd: requestCwd, mcpServers: [] }, 60_000) as AcpSessionInfo
    sessionId = created.sessionId
    const modelOpt = (created.configOptions ?? []).find((o) => o.id === 'model')
    const values = (modelOpt?.options ?? []).map((o) => o.value)
    const target = values.includes(baseModel) ? baseModel
      : effort.length > 0 && values.includes(baseModel + '-' + effort) ? baseModel + '-' + effort
      : undefined
    if (target !== undefined && target !== modelOpt?.currentValue) {
      try {
        await acp.request('session/set_config_option', { sessionId, configId: 'model', value: target }, 30_000)
      } catch (error) {
        log('gateway-acp: set model failed: ' + String(error))
      }
    }
    if (effort.length > 0) {
      try {
        await acp.request('session/set_config_option', { sessionId, configId: 'thought_level', value: effort }, 30_000)
      } catch (error) {
        log('gateway-acp: set thought_level failed: ' + String(error))
      }
    }
  }
  if (!resumed) {
    try {
      await createSession()
    } catch (error) {
      stopPing?.()
      if (stream && res.headersSent) {
        const detail = error instanceof Error ? error.message : String(error)
        log('gateway-acp: session setup failed after stream start (' + detail + '); reporting over SSE')
        sseEvent(res, 'error', anthropicError('api_error', 'agy acp session setup failed: ' + detail))
        res.end()
        return
      }
      throw new AcpUnavailableError(error instanceof Error ? error.message : String(error))
    }
  }

  if (stream && !res.headersSent) {
    // Only reached if an error above threw before the early writeHead and the
    // caller still wants a stream: keep the original late-start fallback.
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    sseEvent(res, 'message_start', {
      type: 'message_start',
      message: { id: 'msg_agy_' + String(sessionId), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    })
  }

  let blockIndex = -1
  let openKind: 'thinking' | 'text' | null = null
  let streamedText = ''
  let streamedThinking = ''
  let finished = false
  const closeBlock = (): void => {
    if (openKind === null) return
    if (stream && !res.destroyed) sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex })
    openKind = null
  }
  const openBlock = (kind: 'thinking' | 'text'): void => {
    closeBlock()
    blockIndex++
    openKind = kind
    if (stream && !res.destroyed) {
      sseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: kind === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' },
      })
    }
  }
  const sendThinking = (text: string): void => {
    if (text.length === 0) return
    streamedThinking += text
    if (!wantThinking) return
    if (openKind !== 'thinking') openBlock('thinking')
    if (stream && !res.destroyed) sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: text } })
  }
  const sendText = (text: string): void => {
    if (text.length === 0) return
    streamedText += text
    if (openKind !== 'text') openBlock('text')
    if (stream && !res.destroyed) sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text } })
  }
  const onUpdate = (update: Record<string, unknown> | undefined): void => {
    const kind = update?.sessionUpdate
    const content = isRecord(update?.content) ? update.content : undefined
    if (kind === 'agent_thought_chunk') sendThinking(typeof content?.text === 'string' ? content.text : '')
    else if (kind === 'agent_message_chunk') sendText(typeof content?.text === 'string' ? content.text : '')
    else if ((kind === 'tool_call' || kind === 'tool_call_update') && stream && !res.destroyed) {
      sseComment(res, 'agy tool ' + String(update?.title ?? update?.toolCallId ?? 'tool') + ' ' + String(update?.status ?? ''))
    }
  }
  acp.setHandler(String(sessionId), onUpdate)
  res.on('close', () => {
    if (!finished) acp.notify('session/cancel', { sessionId: String(sessionId) })
  })
  const fail = (message: string): void => {
    log('gateway-acp: ' + message)
    if (!res.headersSent) respondJson(res, 500, anthropicError('api_error', message))
    else if (stream && !res.destroyed) {
      closeBlock()
      sseEvent(res, 'error', anthropicError('api_error', message))
      res.end()
    } else if (!res.destroyed) res.end()
  }

  let result: AcpPromptResult
  // If the client gave up (idle watchdog, user stop), do not keep the agy turn
  // waiting on a dead response: race the prompt against connection close.
  const clientGone = new Promise<never>((_, reject) => {
    res.once('close', () => reject(new Error('client disconnected; agy turn abandoned')))
  })
  try {
    try {
      result = await Promise.race([acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: promptText }] }, ACP_PROMPT_TIMEOUT_MS) as Promise<AcpPromptResult>, clientGone])
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (res.destroyed) throw error
      if (resumed && /unknown|not found|no such|expired|invalid session/i.test(msg)) {
        log('gateway-acp: stale session, starting fresh (' + msg + ')')
        acp.deleteHandler(String(sessionId))
        resumed = false
        promptText = transcriptPrompt(turns)
        await createSession()
        acp.setHandler(String(sessionId), onUpdate)
        result = await Promise.race([acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: promptText }] }, ACP_PROMPT_TIMEOUT_MS) as Promise<AcpPromptResult>, clientGone]) as AcpPromptResult
      } else {
        if (/timed out/i.test(msg)) acp.notify('session/cancel', { sessionId: String(sessionId) })
        throw error
      }
    }
  } catch (error) {
    finished = true
    stopPing?.()
    acp.deleteHandler(String(sessionId))
    fail(error instanceof Error ? error.message : String(error))
    return
  }
  finished = true
  stopPing?.()
  acp.deleteHandler(String(sessionId))
  if (res.destroyed) return
  acp.rememberSession(historyHash([...turns, { role: 'assistant', text: streamedText }]), String(sessionId), model, requestCwd, resumed ? consumedHash : undefined)
  const usage = {
    input_tokens: typeof result.usage?.inputTokens === 'number' ? result.usage.inputTokens : 0,
    output_tokens: typeof result.usage?.outputTokens === 'number' ? result.usage.outputTokens : 0,
  }
  closeBlock()
  if (stream) {
    sseEvent(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage })
    sseEvent(res, 'message_stop', { type: 'message_stop' })
    res.end()
  } else {
    const content: Record<string, unknown>[] = []
    if (wantThinking && streamedThinking.length > 0) content.push({ type: 'thinking', thinking: streamedThinking })
    content.push({ type: 'text', text: streamedText })
    respondJson(res, 200, {
      id: 'msg_agy_' + String(sessionId),
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage,
    })
  }
}

async function handleMessagesLegacy(options: GatewayOptions, body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { runner, config, cwd: configuredCwd, log = () => {} } = options
  const requestCwd = requestWorkspace(body.system, configuredCwd)
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (model.length === 0) throw new GatewayHttpError(400, 'invalid_request_error', '"model" is required')
  const stream = body.stream === true
  const turns = turnsOf(body.messages)
  const last = turns[turns.length - 1]
  if (last.text.trim().length === 0) {
    throw new GatewayHttpError(400, 'invalid_request_error', 'the final message contains no text content (agy has no image input on this path)')
  }

  const conversations = new ConversationMap(config.dataDir, log)
  const consumedHash = historyHash(turns.slice(0, -1))
  const resumable = conversations.find(consumedHash, requestCwd, model)
  let actuallyResumed = resumable !== undefined
  let run: AgyRun
  try {
    run = await runner.start({
      label: 'zcode ' + model,
      prompt: resumable !== undefined ? last.text : transcriptPrompt(turns),
      cwd: requestCwd,
      background: true,
      model,
      ...(resumable !== undefined ? { task: resumable.task } : {}),
    })
  } catch (error) {
    if (error instanceof AgyModelSelectionError) throw new GatewayHttpError(400, 'invalid_request_error', error.message)
    if (resumable !== undefined && error instanceof Error && /no such task|still running/.test(error.message)) {
      try {
        run = await runner.start({ label: 'zcode ' + model, prompt: transcriptPrompt(turns), cwd: requestCwd, background: true, model })
        actuallyResumed = false
      } catch (fallbackError) {
        if (fallbackError instanceof AgyModelSelectionError) throw new GatewayHttpError(400, 'invalid_request_error', fallbackError.message)
        throw new GatewayHttpError(500, 'api_error', 'could not start agy: ' + String(fallbackError))
      }
    } else {
      throw new GatewayHttpError(500, 'api_error', 'could not start agy: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  if (stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    sseEvent(res, 'message_start', {
      type: 'message_start',
      message: { id: 'msg_agy_' + run.runId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    })
  }

  const usage = new UsageTracker(actuallyResumed)
  let streamedText = ''
  let contentOpen = false
  let finished = false
  const sendDelta = (text: string): void => {
    if (text.length === 0) return
    if (stream) {
      if (!contentOpen) {
        sseEvent(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        contentOpen = true
      }
      sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    }
    streamedText += text
  }
  const unsubscribe = run.subscribe((event) => {
    if (event.kind === 'step') {
      usage.observe(event.usage, false)
      if (event.textDelta !== undefined) sendDelta(event.textDelta)
      else if (stream && !finished) {
        const activity = toolActivity(event)
        if (activity !== undefined && !res.destroyed) sseComment(res, activity)
      }
    } else if (event.kind === 'result') {
      usage.observe(event.usage, true)
    }
  })
  const stopPing = stream ? startSsePing(res) : undefined
  res.on('close', () => {
    if (!finished) run.cancel()
  })
  try {
    await run.done
  } finally {
    unsubscribe()
    stopPing?.()
  }
  finished = true

  if (run.status === 'completed') {
    // result.response equals the concatenated deltas; never append it twice.
    const response = run.response ?? ''
    if (response.startsWith(streamedText) && response.length > streamedText.length) sendDelta(response.slice(streamedText.length))
    else if (streamedText.length === 0) sendDelta(response)
    else if (!response.startsWith(streamedText)) log('gateway: final response diverged from the streamed text; keeping the streamed text')
    const finalUsage = usage.final()
    if (run.conversationId !== undefined) {
      // The client echoes our assistant reply back in its next request, so the
      // resumable key is the history INCLUDING the reply we just produced.
      const history = response.length > 0 ? [...turns, { role: 'assistant' as const, text: response }] : turns
      conversations.remember(historyHash(history), { task: run.task, conversationId: run.conversationId, cwd: requestCwd, model, turns: history.length }, resumable?.task === run.task ? consumedHash : undefined)
    }
    if (stream) {
      if (contentOpen) sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      sseEvent(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: finalUsage })
      sseEvent(res, 'message_stop', { type: 'message_stop' })
      res.end()
    } else {
      respondJson(res, 200, {
        id: 'msg_agy_' + run.runId,
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: response }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: finalUsage,
      })
    }
    return
  }

  const message = 'agy run ' + run.status + ': ' + (run.error ?? 'no detail')
  log('gateway: run ' + run.runId + ' ended ' + run.status)
  if (!res.headersSent) {
    respondJson(res, 500, anthropicError('api_error', message))
  } else if (stream) {
    if (contentOpen) sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
    sseEvent(res, 'error', anthropicError('api_error', message))
    res.end()
  }
}

export async function startGateway(options: GatewayOptions): Promise<GatewayHandle> {
  const log = options.log ?? ((): void => {})
  const server = createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0]
    void (async () => {
      try {
        if (req.method === 'GET' && url === '/health') {
          respondJson(res, 200, { ok: true, version: VERSION, pid: process.pid, cwd: options.cwd, dataDir: options.config.dataDir })
          return
        }
        if (req.method === 'POST' && (url === '/messages' || url === '/v1/messages')) {
          const bearer = bearerOf(req)
          if (bearer === undefined || !tokenMatches(bearer, options.token)) {
            respondJson(res, 401, anthropicError('authentication_error', 'invalid or missing x-api-key / bearer token'))
            return
          }
          const raw = await readBody(req)
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            throw new GatewayHttpError(400, 'invalid_request_error', 'request body is not valid JSON')
          }
          if (!isRecord(parsed)) throw new GatewayHttpError(400, 'invalid_request_error', 'request body must be a JSON object')
          await handleMessages(options, parsed, req, res)
          return
        }
        respondJson(res, 404, anthropicError('not_found_error', 'unknown route ' + req.method + ' ' + url))
      } catch (error) {
        if (error instanceof GatewayHttpError) {
          if (!res.headersSent) respondJson(res, error.status, anthropicError(error.type, error.message))
          else if (!res.destroyed) res.end()
        } else {
          log('gateway: internal error: ' + (error instanceof Error ? error.message : String(error)))
          if (!res.headersSent) respondJson(res, 500, anthropicError('api_error', 'internal gateway error'))
          else if (!res.destroyed) res.end()
        }
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host ?? '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('gateway could not determine its listening port')
  return {
    server,
    port: address.port,
    close: async () => {
      await options.runner.terminateAll(options.config.graceMs + 3000)
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

// ── Autostart from the MCP server ───────────────────────────────────────────

export function gatewayPortFromEnv(): number {
  const raw = Number.parseInt((process.env.AGY_GATEWAY_PORT ?? '').trim(), 10)
  if (!Number.isFinite(raw)) return DEFAULT_GATEWAY_PORT
  return Math.max(0, Math.min(65_535, Math.round(raw)))
}

export async function pingGateway(port: number, timeoutMs = 800): Promise<boolean> {
  if (port <= 0) return false
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

async function gatewayHealth(port: number): Promise<{ version: string; dataDir: string } | undefined> {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return undefined
    const body: unknown = await res.json()
    if (!isRecord(body) || typeof body.version !== 'string' || typeof body.dataDir !== 'string') return undefined
    return { version: body.version, dataDir: body.dataDir }
  } catch {
    return undefined
  }
}

/**
 * Make sure a detached gateway process owns the port: ping it, else spawn the
 * sibling bundle (it outlives this MCP server; the next session re-checks).
 */
export async function ensureGatewayRunning(config: RunnerConfig, log: (message: string) => void): Promise<void> {
  if (process.env.AGY_GATEWAY_AUTOSTART === 'false') return
  const port = gatewayPortFromEnv()
  if (port <= 0) return
  const existing = await gatewayHealth(port)
  if (existing !== undefined) {
    if (existing.version === VERSION && existing.dataDir === config.dataDir) {
      log('[agy-gateway] already running on port ' + port)
    } else {
      log('[agy-gateway] port ' + port + ' is occupied by gateway v' + existing.version + ' (data ' + existing.dataDir + '); expected v' + VERSION + ' (data ' + config.dataDir + '). Not replacing a running gateway; stop it after active requests finish, then restart this plugin.')
    }
    return
  }
  if (await pingGateway(port)) {
    log('[agy-gateway] port ' + port + ' answers /health but does not identify a compatible gateway; refusing to claim it')
    return
  }
  const entry = join(dirname(fileURLToPath(import.meta.url)), 'agy-gateway.mjs')
  if (!existsSync(entry)) {
    log('[agy-gateway] bundle agy-gateway.mjs not found next to the MCP server; the native model gateway is not started')
    return
  }
  try {
    const child = spawn(process.execPath, [entry], {
      cwd: homedir(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, AGY_GATEWAY_PORT: String(port), AGY_GATEWAY_CWD: config.projectDir, AGY_MCP_DATA_DIR: config.dataDir },
    })
    child.unref()
  } catch (error) {
    log('[agy-gateway] could not spawn the gateway: ' + String(error))
    return
  }
  const deadline = Date.now() + AUTOSTART_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 250))
    if (await pingGateway(port)) {
      log('[agy-gateway] started on port ' + port + ' (register a ZCode provider with baseUrl http://127.0.0.1:' + port + ')')
      return
    }
  }
  log('[agy-gateway] did not answer /health within ' + AUTOSTART_WAIT_MS + ' ms; run "node ' + entry + '" once to see its error')
}
