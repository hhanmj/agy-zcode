/**
 * Persistent AGY CLI sessions (opt-in): one long-lived
 * \`agy --input-format stream-json --output-format stream-json\` process per DSH
 * session, one turn per stdin line, a turn ending at its \`result\` event.
 *
 * Protocol facts (AGY headless docs, verified against agy 1.4.0):
 * - one \`init\` per process; every turn emits step_update events and ONE result;
 * - \`result.response\` belongs to the turn, while num_turns, usage and
 *   duration_seconds are CUMULATIVE over the conversation (also across a
 *   \`--conversation\` resume), so per-turn usage comes from step usage;
 * - closing stdin lets the in-flight turn finish, then the process exits 0;
 * - there is no per-turn cancel message: cancelling kills the process, and an
 *   unfinished turn is never assumed to be resumable.
 */
import type { SubprocessHandle } from './subprocess-types.js'
import { NdjsonLineSplitter, parseAgyStreamLine, type AgyStreamEvent } from './stream-events.js'

/** Everything needed to start one persistent process (argv already includes --conversation when resuming). */
export interface PersistentSpawnSpec {
  argv: string[]
  cwd: string
  env: Record<string, string>
}

/** Starts a process with stdin and stdout piped (the DSH subprocess seam in production). */
export type PersistentSpawnFn = (spec: PersistentSpawnSpec) => SubprocessHandle

export interface PersistentTurnOptions {
  /** Every decoded event of THIS turn, in order. */
  onEvent?: (event: AgyStreamEvent) => void
  /** Aborting kills the process (there is no per-turn cancel in the protocol). */
  signal?: AbortSignal
  /** Turn ceiling; the process is killed when exceeded. */
  timeoutMs: number
}

export type PersistentTurnStatus = 'completed' | 'failed' | 'cancelled' | 'timeout' | 'lost'

export interface PersistentTurnOutcome {
  status: PersistentTurnStatus
  /** result.response of this turn ('' unless completed). */
  response: string
  /** This turn's visible text deltas. */
  text: string
  error?: string
  /** AGY's own terminal status string, when a result arrived. */
  resultStatus?: string
  conversationId?: string
  pid?: number
  exitCode?: number | null
  stderrTail?: string
  /** 1-based turn number within this process. */
  turn: number
  /** The process already existed before this turn (warm turn). */
  reused: boolean
}

const STDERR_TAIL = 4000

function stderrTail(handle: SubprocessHandle): string {
  try {
    const text = handle.collected?.stderr?.readFrom(0).text ?? ''
    return text.length > STDERR_TAIL ? text.slice(-STDERR_TAIL) : text
  } catch {
    return ''
  }
}

/** One long-lived agy process. At most one turn at a time (the manager serializes). */
export class PersistentAgyProcess {
  readonly startedAt = Date.now()
  readonly pid: number | undefined
  conversationId: string | undefined
  turns = 0
  private state: 'idle' | 'busy' | 'closed' = 'idle'
  private readonly handle: SubprocessHandle
  private readonly splitter = new NdjsonLineSplitter()
  private listener: ((event: AgyStreamEvent) => void) | undefined
  private exitListener: (() => void) | undefined
  private exitInfo: { exitCode: number | null; signal: string | null } | undefined
  readonly exited: Promise<void>

  constructor(spawn: PersistentSpawnFn, spec: PersistentSpawnSpec, readonly key: string, private readonly onClosed?: () => void) {
    this.handle = spawn(spec)
    this.pid = (this.handle as unknown as { pid?: number }).pid
    const stdout = this.handle.stdout
    if (stdout === undefined || this.handle.stdin === undefined) {
      this.handle.terminate()
      throw new Error('persistent agy process needs piped stdin and stdout')
    }
    stdout.on('data', (chunk: Buffer | string) => {
      for (const line of this.splitter.push(chunk)) {
        const event = parseAgyStreamLine(line)
        if (event.kind === 'init' && event.conversationId) this.conversationId = event.conversationId
        if ((event.kind === 'result' || event.kind === 'step') && event.conversationId) this.conversationId = event.conversationId
        this.listener?.(event)
      }
    })
    // A broken pipe surfaces as an error on stdin; the exit handler settles the turn.
    this.handle.stdin.on('error', () => {})
    this.exited = this.handle.done.then(
      (outcome) => {
        this.exitInfo = { exitCode: outcome.exitCode, signal: outcome.signal ?? null }
      },
      () => {
        this.exitInfo = { exitCode: null, signal: null }
      },
    ).then(() => {
      for (const line of this.splitter.end()) {
        const event = parseAgyStreamLine(line)
        this.listener?.(event)
      }
      this.state = 'closed'
      this.exitListener?.()
      this.onClosed?.()
    })
  }

  get alive(): boolean {
    return this.state !== 'closed'
  }

  get busy(): boolean {
    return this.state === 'busy'
  }

  /** Run one turn: write the prompt line, settle on this turn's result (or on exit/abort/timeout). */
  turn(content: string, options: PersistentTurnOptions): Promise<PersistentTurnOutcome> {
    if (this.state === 'busy') return Promise.reject(new Error('a turn is already running on this AGY process'))
    const reused = this.turns > 0
    const base = (): Pick<PersistentTurnOutcome, 'turn' | 'reused' | 'pid' | 'conversationId'> => ({
      turn: this.turns, reused, ...(this.pid !== undefined ? { pid: this.pid } : {}), ...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
    })
    if (this.state === 'closed') {
      return Promise.resolve({ status: 'lost', response: '', text: '', error: 'the AGY process has already exited', ...base(), exitCode: this.exitInfo?.exitCode ?? null, stderrTail: stderrTail(this.handle) })
    }
    this.state = 'busy'
    this.turns += 1
    return new Promise<PersistentTurnOutcome>((resolve) => {
      let text = ''
      let settled = false
      let reason: 'cancelled' | 'timeout' | undefined
      const finish = (outcome: Omit<PersistentTurnOutcome, 'turn' | 'reused' | 'pid' | 'conversationId'>): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        this.listener = undefined
        this.exitListener = undefined
        if (this.alive && this.state === 'busy') this.state = 'idle'
        resolve({ ...outcome, ...base() })
      }
      const kill = (why: 'cancelled' | 'timeout'): void => {
        if (reason === undefined) reason = why
        this.handle.terminate()
      }
      const onAbort = (): void => kill('cancelled')
      const timer = setTimeout(() => kill('timeout'), options.timeoutMs)
      this.listener = (event) => {
        try {
          options.onEvent?.(event)
        } catch {
          // a consumer failure must not break the protocol loop
        }
        if (event.kind === 'step' && event.textDelta) text += event.textDelta
        if (event.kind !== 'result') return
        const status = event.status ?? ''
        if (status === 'SUCCESS') finish({ status: 'completed', response: event.response ?? text, text, resultStatus: status })
        else if (status === 'CANCELED' || status === 'INTERRUPTED') finish({ status: 'cancelled', response: '', text, resultStatus: status, ...(event.error ? { error: event.error } : {}) })
        else finish({ status: 'failed', response: '', text, resultStatus: status, error: event.error || ('AGY ended the turn with status ' + (status || 'unknown')) })
      }
      this.exitListener = () => {
        const exit = { exitCode: this.exitInfo?.exitCode ?? null, stderrTail: stderrTail(this.handle) }
        if (reason === 'cancelled') finish({ status: 'cancelled', response: '', text, ...exit })
        else if (reason === 'timeout') finish({ status: 'timeout', response: '', text, error: 'the turn exceeded ' + options.timeoutMs + ' ms and the AGY process was terminated', ...exit })
        else finish({ status: 'lost', response: '', text, error: 'the AGY process exited without a result for this turn', ...exit })
      }
      if (options.signal?.aborted) {
        kill('cancelled')
        return
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const line = JSON.stringify({ event: 'user', message: { content } }) + '\n'
      try {
        this.handle.stdin!.write(line, (error) => {
          if (error) {
            finish({ status: 'lost', response: '', text, error: 'writing the prompt to AGY stdin failed: ' + error.message, exitCode: null, stderrTail: stderrTail(this.handle) })
            this.handle.terminate()
          }
        })
      } catch (error) {
        finish({ status: 'lost', response: '', text, error: 'writing the prompt to AGY stdin failed: ' + (error instanceof Error ? error.message : String(error)), exitCode: null })
        this.handle.terminate()
      }
    })
  }

  /** Graceful close: end stdin (agy finishes the in-flight turn), then terminate after graceMs. */
  async close(graceMs: number): Promise<void> {
    if (this.state === 'closed') return
    try {
      this.handle.stdin?.end()
    } catch {
      // already closed
    }
    let timer: NodeJS.Timeout | undefined
    await Promise.race([this.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs) })])
    clearTimeout(timer)
    if (this.alive) {
      this.handle.terminate()
      await Promise.race([this.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs) })])
      clearTimeout(timer)
    }
  }

  kill(): void {
    if (this.state !== 'closed') this.handle.terminate()
  }
}

export interface PersistentSessionInfo {
  sessionKey: string
  pid?: number
  state: 'idle' | 'busy' | 'closed'
  conversationId?: string
  turns: number
  startedAt: number
  lastUsedAt: number
  key: string
}

interface SessionEntry {
  process: PersistentAgyProcess | undefined
  queue: Promise<unknown>
  idleTimer: NodeJS.Timeout | undefined
  lastUsedAt: number
}

/**
 * DSH session id -> one persistent agy process. Turns of one session run in
 * order; different sessions run concurrently. A changed process key (model,
 * effort, cwd, directories, permissions...) closes the old process and starts a
 * new one; idle processes are closed after idleMs.
 */
export class PersistentAgySessionManager {
  private readonly sessions = new Map<string, SessionEntry>()
  private disposed = false

  constructor(private readonly options: { spawn: PersistentSpawnFn; idleMs: number; graceMs: number; onWarn?: (message: string) => void }) {}

  /**
   * Run one turn for sessionKey. buildSpawn is called only when a new process
   * is needed (none, exited, or a different key); onProcess reports the process
   * the turn ran on (before the turn starts) and whether it was started now.
   */
  runTurn(
    sessionKey: string,
    key: string,
    buildSpawn: () => Promise<{ spec: PersistentSpawnSpec; onClosed?: () => void }>,
    /** The stdin prompt; a function is evaluated after onProcess (it may depend on the process). */
    content: string | (() => string),
    turn: PersistentTurnOptions,
    onProcess?: (process: PersistentAgyProcess, started: boolean) => void,
  ): Promise<PersistentTurnOutcome> {
    if (this.disposed) return Promise.reject(new Error('persistent AGY sessions are shut down'))
    const entry = this.sessions.get(sessionKey) ?? { process: undefined, queue: Promise.resolve(), idleTimer: undefined, lastUsedAt: Date.now() }
    this.sessions.set(sessionKey, entry)
    const run = async (): Promise<PersistentTurnOutcome> => {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
      let started = false
      if (entry.process === undefined || !entry.process.alive || entry.process.key !== key) {
        if (entry.process?.alive) await entry.process.close(this.options.graceMs)
        const { spec, onClosed } = await buildSpawn()
        if (this.disposed) throw new Error('persistent AGY sessions are shut down')
        entry.process = new PersistentAgyProcess(this.options.spawn, spec, key, onClosed)
        started = true
      }
      const process = entry.process
      onProcess?.(process, started)
      try {
        return await process.turn(typeof content === 'function' ? content() : content, turn)
      } finally {
        entry.lastUsedAt = Date.now()
        if (!process.alive) {
          if (entry.process === process) entry.process = undefined
        } else if (this.options.idleMs > 0) {
          entry.idleTimer = setTimeout(() => {
            if (entry.process === process && !process.busy) {
              entry.process = undefined
              void process.close(this.options.graceMs)
            }
          }, this.options.idleMs)
          entry.idleTimer.unref?.()
        }
      }
    }
    const next = entry.queue.then(run, run)
    entry.queue = next.catch(() => undefined)
    return next
  }

  /** Close (gracefully) the process of one session, e.g. when its child session goes away. */
  async drop(sessionKey: string): Promise<void> {
    const entry = this.sessions.get(sessionKey)
    if (entry === undefined) return
    this.sessions.delete(sessionKey)
    clearTimeout(entry.idleTimer)
    await entry.process?.close(this.options.graceMs)
  }

  list(): PersistentSessionInfo[] {
    return [...this.sessions].map(([sessionKey, entry]) => ({
      sessionKey,
      ...(entry.process?.pid !== undefined ? { pid: entry.process.pid } : {}),
      state: entry.process === undefined || !entry.process.alive ? 'closed' : entry.process.busy ? 'busy' : 'idle',
      ...(entry.process?.conversationId !== undefined ? { conversationId: entry.process.conversationId } : {}),
      turns: entry.process?.turns ?? 0,
      startedAt: entry.process?.startedAt ?? 0,
      lastUsedAt: entry.lastUsedAt,
      key: entry.process?.key ?? '',
    }))
  }

  /** Plugin teardown: kill every process (no new turns afterwards). */
  async dispose(): Promise<void> {
    this.disposed = true
    const closing: Promise<void>[] = []
    for (const entry of this.sessions.values()) {
      clearTimeout(entry.idleTimer)
      if (entry.process?.alive) {
        entry.process.kill()
        closing.push(entry.process.exited)
      }
    }
    this.sessions.clear()
    await Promise.race([Promise.allSettled(closing), new Promise((resolve) => setTimeout(resolve, this.options.graceMs))])
  }
}
