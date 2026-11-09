/**
 * Runs Google Antigravity CLI (agy) for the ZCode MCP server: new tasks,
 * follow-ups that resume an agy conversation, foreground and background
 * runs, a local watchdog, a durable task registry, independent workspace
 * evidence and the durable execution trace. Ported from the DSH plugin's
 * provider (src/index.ts) without any DeepSeek Harness dependency.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { captureWorkspace, collectEvidence, saveEvidence, type ExecutionStatus, type TaskEvidence } from '../shared/evidence.js'
import { AccountStore, isQuotaError } from './accounts.js'
import { AgyStreamAccumulator, NdjsonLineSplitter, errorText, parseAgyErrorLine, parseAgyStreamLine, type AgyStreamEvent } from '../shared/stream-events.js'
import { DEFAULT_TRACE_LIMITS, RunTraceRecorder, TraceStore, sanitizeText, type RunStartInfo, type TraceTransport } from '../shared/trace.js'
import { AgyModelCatalog, AgyModelSelectionError, EFFORT_ORDER, resolveSelection, type AgyBaseModel } from '../shared/models.js'
import { PersistentAgySessionManager, type PersistentAgyProcess, type PersistentSessionInfo, type PersistentSpawnFn, type PersistentTurnOutcome } from '../shared/persistent.js'
import { prepareSupervisor, sliceSupervisionReport, supervisionPromptNote, supervisorDirFor, type SupervisionReport, type SupervisionSettings, type SupervisorHandle } from '../shared/supervision.js'
import type { RunnerConfig } from './config.js'
import { readFileIfExists, withFileLock, writeFileAtomic } from './filelock.js'
import { resolveAgy, scrubbedEnv, spawnManaged, type ExitInfo, type ManagedProcess } from './proc.js'

/** Windows CreateProcess caps the whole command line near 32767 chars. */
const MAX_ARGV_PROMPT_CHARS = 30_000
/** Prompt budget when the prompt travels over stdin (stream-json input). */
const STDIN_PROMPT_MAX_CHARS = 400_000
const PROBE_TIMEOUT_MS = 10_000
const MODELS_TIMEOUT_MS = 30_000
/** Live progress window kept per run (old text drops first). */
const MAX_VISIBLE_CHARS = 1 << 20
const MAX_STDOUT_CHARS = 4 << 20
const MAX_TASK_RECORDS = 100
const MAX_FINISHED_RUNS = 64
const LOGIN_LAUNCH_COOLDOWN_MS = 15_000
/** Trace reader identity: ZCode has one local user, so every trace belongs to it. */
export const TRACE_OWNER = 'zcode'

const AVOID_BROWSER_SUFFIX =
  '\n\n(Environment note: headless browser tools are unreliable in this environment and can hang the run indefinitely. Do NOT use browser_* tools, do NOT open URLs in a browser, and do NOT wait on page loads. Verify pages and UI by reading the source files and running commands instead.)'
const AVOID_LARGE_READ_SUFFIX =
  '\n\n(Environment note: files larger than 1 MB must NOT be read with your file-read tool — it fails above 4 MB, which large files like single-file components with embedded assets easily exceed. Inspect large files with grep, sed, head, tail, or python via run_command instead: first probe structure with head/grep, then extract only the slices you need. Never read a file whole when it is larger than 1 MB.)'

export type RunStatus = 'running' | ExecutionStatus

/** One durable task entry: the agy conversation a follow-up resumes. */
export interface TaskRecord {
  conversationId: string
  cwd: string
  label: string
  createdAt: number
  model?: string
  effort?: string
}

export interface StartOptions {
  label: string
  prompt: string
  /** Absolute working directory for a new task (follow-ups reuse the task's own). */
  cwd: string
  dirs?: string[]
  model?: string
  effort?: string
  background: boolean
  /** Follow-up: an existing task key whose conversation is resumed. */
  task?: string
}

interface FlagSupport {
  outputFormat: boolean
  conversation: boolean
  sandbox: boolean
  addDir: boolean
  streamJson: boolean
  streamInput: boolean
  probed: boolean
}

/** Probe failed: keep the historic behavior for the standard flags. */
const UNKNOWN_FLAG_SUPPORT: FlagSupport = {
  outputFormat: true, conversation: true, sandbox: true, addDir: true, streamJson: true, streamInput: false, probed: false,
}

function parseFlagSupport(text: string): FlagSupport {
  const has = (flag: string): boolean => new RegExp('--' + flag + '(?:\\s|=)').test(text)
  return {
    outputFormat: has('output-format'),
    conversation: has('conversation'),
    sandbox: has('sandbox'),
    addDir: has('add-dir'),
    streamJson: /\bstream-json\b/.test(text),
    streamInput: has('input-format') && /\bstream-json\b/.test(text),
    probed: has('print') || has('conversation'),
  }
}

function isUnknownFlagError(stderr: string): boolean {
  return /flag provided but not defined|unknown flag|not defined: -output-format/i.test(stderr)
}

function isAuthError(detail: string): boolean {
  return /authentication required|not logged in|please (log|sign) in|login required|unauthenticated/i.test(detail)
}

function authHintFor(detail: string): string {
  if (!isAuthError(detail)) return detail
  return detail + '\nHint: authenticate once by running "agy" interactively in a terminal, or call agy_login to open the login window.'
}

interface AgyJsonReply {
  conversation_id?: string
  status?: string
  response?: string
  error?: string
}

function parseJsonObject(text: string): AgyJsonReply | undefined {
  try {
    const obj = JSON.parse(text) as unknown
    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
      const reply = obj as AgyJsonReply
      if ('status' in reply || 'conversation_id' in reply || 'response' in reply) return reply
    }
  } catch {
    // not JSON
  }
  return undefined
}

/** The agy json reply in stdout: the whole output first, then line by line (a preamble cannot hide it). */
function tryParseJsonOutput(stdout: string): AgyJsonReply | undefined {
  const trimmed = stdout.trim()
  if (trimmed.startsWith('{')) {
    const whole = parseJsonObject(trimmed)
    if (whole !== undefined) return whole
  }
  for (const line of stdout.split(/\r?\n/)) {
    const candidate = line.trim()
    if (!candidate.startsWith('{')) continue
    const parsed = parseJsonObject(candidate)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/** Absolute, existing, real directories, deduplicated; fails before any spawn. */
function validateDirs(dirs: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of dirs) {
    const dir = raw.trim()
    if (dir.length === 0) continue
    if (!isAbsolute(dir)) throw new Error('dirs entries must be absolute paths (got "' + dir + '")')
    let isDir = false
    try {
      isDir = statSync(dir).isDirectory()
    } catch {
      throw new Error('dirs entry does not exist: ' + dir)
    }
    if (!isDir) throw new Error('dirs entry is not a directory: ' + dir)
    if (!out.includes(dir)) out.push(dir)
  }
  return out
}

export function validateWorkspace(dir: string): string {
  if (!isAbsolute(dir)) throw new Error('cwd must be an absolute path (got "' + dir + '")')
  let isDir = false
  try {
    isDir = statSync(dir).isDirectory()
  } catch {
    throw new Error('cwd does not exist: ' + dir)
  }
  if (!isDir) throw new Error('cwd is not a directory: ' + dir)
  return resolve(dir)
}

function applyProxyEnv(env: Record<string, string>, proxy: string): void {
  if (proxy.length === 0) return
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[name] = proxy
  if (env.NO_PROXY === undefined && env.no_proxy === undefined) env.NO_PROXY = 'localhost,127.0.0.1,::1'
}

function readFirstLine(file: string): string {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/)[0]?.trim() ?? ''
  } catch {
    return ''
  }
}

async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((done) => {
      timer = setTimeout(done, ms)
    }),
  ])
  clearTimeout(timer)
}

interface LiveStream {
  acc: AgyStreamAccumulator
  drained: Promise<void>
}

/** Decode a piped stdout as stream-json; each event goes to the accumulator, then onEvent. */
function attachStream(stdout: Readable | undefined, onEvent: (event: AgyStreamEvent) => void): LiveStream {
  const splitter = new NdjsonLineSplitter()
  const acc = new AgyStreamAccumulator()
  const feed = (lines: string[]): void => {
    for (const line of lines) {
      const event = parseAgyStreamLine(line)
      acc.apply(event)
      try {
        onEvent(event)
      } catch {
        // observers never break the transport
      }
    }
  }
  const drained = new Promise<void>((done) => {
    if (stdout === undefined) {
      done()
      return
    }
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      feed(splitter.end())
      done()
    }
    stdout.on('data', (chunk: Buffer | string) => feed(splitter.push(chunk)))
    stdout.once('end', finish)
    stdout.once('close', finish)
    stdout.once('error', finish)
  })
  return { acc, drained }
}

/** Compact one-line progress marker for tool and other finished steps. */
function progressMarker(event: AgyStreamEvent): string {
  if (event.kind !== 'step') return ''
  const state = event.state ?? ''
  if (state !== 'DONE' && state !== 'ERROR') return ''
  if (event.stepType === 'tool' || event.toolInfo !== undefined) {
    const tool = event.toolName ?? 'tool'
    if (state === 'ERROR' || (event.toolInfo?.error !== undefined && event.toolInfo.error !== null)) {
      const message = sanitizeText(errorText(event.toolInfo?.error) ?? 'error', {}, 160).replace(/\s+/g, ' ')
      return '\n[agy: tool ' + tool + ' error: ' + message + ']\n'
    }
    return '\n[agy: tool ' + tool + ' done]\n'
  }
  const stepType = event.stepType ?? ''
  if (state === 'DONE' && stepType.length > 0 && stepType !== 'agent_response' && stepType !== 'user_input' && stepType !== 'unknown') {
    return '\n[agy: ' + stepType + ' step done]\n'
  }
  return ''
}

/** One agy run (a new task or one follow-up turn), live or finished. */
export class AgyRun {
  private static created = 0
  /** Creation order (timestamps can tie). */
  readonly order = ++AgyRun.created
  status: RunStatus = 'running'
  finishedAt: number | undefined
  conversationId: string | undefined
  response: string | undefined
  error: string | undefined
  evidence: TaskEvidence | undefined
  exit: ExitInfo | undefined
  /** Hook supervision report of this run (supervision on). */
  supervision: SupervisionReport | undefined
  /** Persistent session: the agy process this turn ran on. */
  processInfo: { pid?: number; turn: number; reused: boolean } | undefined
  toolCalls = 0
  toolErrors = 0
  lastActivity = 'starting agy'
  readonly startedAt = Date.now()
  done!: Promise<AgyRun>
  private visible = ''
  private dropped = 0
  private readonly listeners = new Set<(event: AgyStreamEvent) => void>()
  /** Set by the runner once the process exists. */
  cancelHook: () => void = () => {}
  cancelRequested = false

  constructor(
    readonly runId: string,
    readonly task: string,
    readonly label: string,
    readonly cwd: string,
    readonly background: boolean,
    readonly followup: boolean,
    readonly selection: { model?: string; effort?: string; source: string },
  ) {}

  appendVisible(chunk: string): void {
    if (chunk.length === 0) return
    this.visible += chunk
    if (this.visible.length > MAX_VISIBLE_CHARS) {
      const drop = this.visible.length - MAX_VISIBLE_CHARS
      this.visible = this.visible.slice(drop)
      this.dropped += drop
    }
  }

  /** Progress text from a character offset; the newest maxChars when more is pending. */
  read(from: number, maxChars: number): { text: string; next: number; skipped: boolean } {
    const total = this.dropped + this.visible.length
    const start = Math.max(0, Math.min(Math.floor(from), total))
    let skipped = start < this.dropped
    let text = this.visible.slice(Math.max(start, this.dropped) - this.dropped)
    if (text.length > maxChars) {
      text = text.slice(text.length - maxChars)
      skipped = true
    }
    return { text, next: total, skipped }
  }

  subscribe(listener: (event: AgyStreamEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  observe(event: AgyStreamEvent): void {
    if (event.kind === 'step') {
      if (event.textDelta !== undefined && event.textDelta.length > 0) {
        this.appendVisible(event.textDelta)
        this.lastActivity = 'writing its answer'
      }
      const isTool = event.stepType === 'tool' || event.toolInfo !== undefined
      if (isTool && event.state !== 'DONE' && event.state !== 'ERROR') this.lastActivity = 'running tool ' + (event.toolName ?? 'tool')
      if (isTool && (event.state === 'DONE' || event.state === 'ERROR')) {
        this.toolCalls += 1
        if (event.state === 'ERROR' || (event.toolInfo?.error !== undefined && event.toolInfo.error !== null)) this.toolErrors += 1
        this.lastActivity = 'finished tool ' + (event.toolName ?? 'tool')
      }
      this.appendVisible(progressMarker(event))
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // listeners never break the run
      }
    }
  }

  cancel(): void {
    this.cancelRequested = true
    this.cancelHook()
  }
}

export class AgyRunner {
  private flagSupport: FlagSupport | undefined
  private readonly runs = new Map<string, AgyRun>()
  private readonly activeByTask = new Map<string, AgyRun>()
  private seq = 0
  private registryTail: Promise<void> = Promise.resolve()
  private lastLoginAt = 0
  private hookSource: string | undefined
  private streamInputWarned = false
  private persistentManager: PersistentAgySessionManager | undefined
  /** Supervisor and per-turn decision cursor of every live persistent process. */
  private readonly processStates = new WeakMap<PersistentAgyProcess, ProcessState>()
  readonly traces: TraceStore | undefined
  readonly models: AgyModelCatalog
  readonly accounts: AccountStore

  constructor(
    readonly config: RunnerConfig,
    private readonly log: (message: string) => void = (message) => process.stderr.write(message + '\n'),
  ) {
    this.accounts = new AccountStore({ dataDir: config.dataDir, geminiDir: process.env.AGY_MCP_GEMINI_DIR || undefined, log: this.log })
    this.traces = config.traceEnabled
      ? new TraceStore(join(config.dataDir, 'traces'), DEFAULT_TRACE_LIMITS, (message) => this.log(message))
      : undefined
    this.models = new AgyModelCatalog(() => this.fetchModelsOutput())
  }

  get evidenceDir(): string {
    return join(this.config.dataDir, 'evidence')
  }

  get registryFile(): string {
    return join(this.config.dataDir, this.config.registryName)
  }

  // ── Durable task registry ────────────────────────────────────────────────

  /** Lenient read for listings and lookups: any read problem shows as an empty registry. */
  loadRegistry(): Record<string, TaskRecord> {
    const file = this.registryFile
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      return {}
    }
    return this.parseRegistry(file, raw)
  }

  private parseRegistry(file: string, raw: string): Record<string, TaskRecord> {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.backupCorrupt(file, raw)
      return {}
    }
    const records: Record<string, TaskRecord> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<TaskRecord> | null
      if (entry !== null && typeof entry === 'object' && typeof entry.conversationId === 'string' && entry.conversationId.length > 0 &&
        typeof entry.cwd === 'string' && typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)) {
        records[key] = {
          conversationId: entry.conversationId,
          cwd: entry.cwd,
          label: typeof entry.label === 'string' ? entry.label : '',
          createdAt: entry.createdAt,
          ...(typeof entry.model === 'string' && entry.model.length > 0 ? { model: entry.model } : {}),
          ...(typeof entry.effort === 'string' && entry.effort.length > 0 ? { effort: entry.effort } : {}),
        }
      }
    }
    return records
  }

  private backupCorrupt(file: string, raw: string): void {
    if (raw.trim().length === 0) return
    const backup = file + '.corrupt'
    try {
      if (existsSync(backup) && statSync(backup).mtimeMs >= statSync(file).mtimeMs) return
      writeFileSync(backup, raw, 'utf8')
      this.log('agy-mcp: task registry ' + file + ' was corrupt; original backed up to ' + backup)
    } catch (error) {
      this.log('agy-mcp: task registry ' + file + ' is corrupt and could not be backed up: ' + String(error))
    }
  }

  /**
   * Read-modify-write of the registry: serialized inside this process, guarded
   * by a lock file across processes (other MCP servers, the gateway), with a
   * strict read (only a missing file counts as empty) and an atomic replace.
   * Resolves false when the update was not persisted (logged; never throws).
   */
  updateRegistry(mutate: (records: Record<string, TaskRecord>) => void): Promise<boolean> {
    const file = this.registryFile
    const run = this.registryTail.then(async () => {
      try {
        mkdirSync(this.config.dataDir, { recursive: true })
        await withFileLock(file + '.lock', async () => {
          const raw = await readFileIfExists(file)
          const records = raw === undefined ? {} : this.parseRegistry(file, raw)
          mutate(records)
          const kept = Object.entries(records).sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, MAX_TASK_RECORDS)
          await writeFileAtomic(file, JSON.stringify(Object.fromEntries(kept), null, 2))
        })
        return true
      } catch (error) {
        this.log('agy-mcp: failed to persist task registry ' + file + ': ' + String(error))
        return false
      }
    })
    this.registryTail = run.then(() => undefined)
    return run
  }

  /**
   * Upsert the task's record. The early write (conversation first seen, run
   * still going) is stamped with the run's start time so it never looks newer
   * than the run's own active-run marker (see scanRunMarkers).
   */
  private recordTask(run: AgyRun, conversationId: string, early = false): Promise<boolean> {
    return this.updateRegistry((records) => {
      const previous = records[run.task]
      records[run.task] = {
        conversationId,
        cwd: run.cwd,
        label: previous?.label || run.label,
        createdAt: early ? run.startedAt : Date.now(),
        ...(run.selection.model !== undefined ? { model: run.selection.model } : {}),
        ...(run.selection.effort !== undefined ? { effort: run.selection.effort } : {}),
      }
    })
  }

  // ── Active-run markers (survive server restarts, visible to other sessions) ──

  /** One marker file per live run; the gateway (own registry) keeps its own directory. */
  get activeRunDir(): string {
    const base = this.config.registryName.replace(/\.json$/, '')
    return join(this.config.dataDir, base === 'tasks' ? 'active-runs' : 'active-runs-' + base)
  }

  private markerPath(runId: string): string {
    return join(this.activeRunDir, runId + '.json')
  }

  private markRunStarted(run: AgyRun): void {
    try {
      mkdirSync(this.activeRunDir, { recursive: true })
      const marker: RunMarker = {
        task: run.task,
        runId: run.runId,
        label: run.label,
        cwd: run.cwd,
        background: run.background,
        startedAt: run.startedAt,
        serverPid: process.pid,
        ...(run.conversationId !== undefined ? { conversationId: run.conversationId } : {}),
        ...(run.selection.model !== undefined ? { model: run.selection.model } : {}),
        ...(run.selection.effort !== undefined && run.selection.effort.length > 0 ? { effort: run.selection.effort } : {}),
      }
      writeFileSync(this.markerPath(run.runId), JSON.stringify(marker, null, 2), 'utf8')
    } catch (error) {
      this.log('agy-mcp: failed to write run marker: ' + String(error))
    }
  }

  private markRunFinished(run: AgyRun): void {
    try {
      rmSync(this.markerPath(run.runId), { force: true })
    } catch {
      // a leftover marker is pruned by scanRunMarkers
    }
  }

  /**
   * Markers whose run is not in this instance's memory, split into:
   * lost — the owning server process is gone, so the run died with it (agy
   * processes do not survive the server); foreign — the owning server is still
   * alive, i.e. the run is live in another ZCode session (each session runs its
   * own server). A marker whose task has a registry record newer than the
   * marker, or older than 14 days, is stale and removed.
   */
  scanRunMarkers(): { lost: RunMarker[]; foreign: RunMarker[] } {
    let files: string[]
    try {
      files = readdirSync(this.activeRunDir)
    } catch {
      return { lost: [], foreign: [] }
    }
    const records = this.loadRegistry()
    const lost: RunMarker[] = []
    const foreign: RunMarker[] = []
    for (const name of files) {
      if (!name.endsWith('.json')) continue
      const file = join(this.activeRunDir, name)
      let marker: RunMarker
      try {
        marker = JSON.parse(readFileSync(file, 'utf8')) as RunMarker
      } catch {
        // torn or garbage; a live writer rewrites it whole, so drop it
        rmSync(file, { force: true })
        continue
      }
      if (marker === null || typeof marker !== 'object' || typeof marker.task !== 'string') continue
      if (marker.serverPid === process.pid && this.runs.get(marker.runId)?.status === 'running') continue
      const startedAt = typeof marker.startedAt === 'number' ? marker.startedAt : 0
      const record = records[marker.task]
      if ((record !== undefined && record.createdAt > startedAt) || Date.now() - startedAt > MARKER_MAX_AGE_MS) {
        rmSync(file, { force: true })
        continue
      }
      const ownerAlive = typeof marker.serverPid === 'number' && marker.serverPid !== process.pid && markerPidAlive(marker.serverPid)
      ;(ownerAlive ? foreign : lost).push(marker)
    }
    const byStart = (a: RunMarker, b: RunMarker): number => (b.startedAt ?? 0) - (a.startedAt ?? 0)
    return { lost: lost.sort(byStart), foreign: foreign.sort(byStart) }
  }

  lostRunsFor(task: string): RunMarker[] {
    return this.scanRunMarkers().lost.filter((marker) => marker.task === task)
  }

  foreignRunsFor(task: string): RunMarker[] {
    return this.scanRunMarkers().foreign.filter((marker) => marker.task === task)
  }

  // ── Environment, executable, flags, models, login ────────────────────────

  resolveProxy(): string {
    if (this.config.proxy.length > 0) return this.config.proxy
    const envProxy = process.env.AGY_PROXY?.trim()
    if (envProxy !== undefined && envProxy.length > 0) return envProxy
    const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
    return readFirstLine(join(this.config.dataDir, 'agy-proxy.txt')) || readFirstLine(join(home, '.dsh', 'agy-proxy.txt'))
  }

  baseEnv(): Record<string, string> {
    const env = scrubbedEnv()
    applyProxyEnv(env, this.resolveProxy())
    // Headless probes must not spawn agy's bg-updater: on Windows it opens a
    // visible Windows Terminal/ConPTY window (flash). Manual `agy update` and
    // interactive terminal sessions are unaffected. The value must be the
    // literal string 'true'; agy ignores '1'.
    env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true'
    return env
  }

  private async probeFlags(exe: string, env: Record<string, string>): Promise<FlagSupport> {
    if (this.flagSupport !== undefined) return this.flagSupport
    let support = UNKNOWN_FLAG_SUPPORT
    try {
      const proc = spawnManaged([exe, ...this.config.commandPrefixArgs, 'help'], { cwd: tmpdir(), env, stdout: 'collect', maxStdout: 64 * 1024, graceMs: this.config.graceMs })
      const timer = setTimeout(() => proc.terminate(), PROBE_TIMEOUT_MS)
      await proc.done
      clearTimeout(timer)
      support = parseFlagSupport(proc.collectedStdout() + proc.stderrTail())
    } catch (error) {
      this.log('agy-mcp: flag probe failed (' + String(error) + '); assuming standard flags')
    }
    this.flagSupport = support
    return support
  }

  private async fetchModelsOutput(): Promise<string> {
    const env = this.baseEnv()
    const exe = resolveAgy(this.config.command, env)
    const proc = spawnManaged([exe, ...this.config.commandPrefixArgs, 'models'], { cwd: tmpdir(), env, stdout: 'collect', maxStdout: 256 * 1024, graceMs: this.config.graceMs })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.terminate()
    }, MODELS_TIMEOUT_MS)
    const exit = await proc.done
    clearTimeout(timer)
    if (timedOut) throw new Error('"agy models" timed out after ' + MODELS_TIMEOUT_MS + ' ms')
    if (exit.error !== undefined) throw new Error('"agy models" could not start: ' + exit.error)
    if (exit.exitCode !== 0) {
      const last = proc.stderrTail().trim().split(/\r?\n/).pop() ?? ''
      throw new Error('"agy models" exited with code ' + String(exit.exitCode) + ': ' + last)
    }
    return proc.collectedStdout()
  }

  /** Open agy's interactive login in its own console window (Windows); instructions elsewhere. */
  async launchLogin(): Promise<string> {
    const env = this.baseEnv()
    const exe = resolveAgy(this.config.command, env)
    if (process.platform !== 'win32') {
      return 'This platform cannot open an interactive terminal from the plugin. Open a terminal, run "agy" and complete the sign-in, then retry.'
    }
    const style = this.config.loginWindowMinimized ? ' -WindowStyle Minimized' : ''
    const command = 'Start-Process -FilePath \'' + exe.replace(/'/g, "''") + '\'' + style
    const proc = spawnManaged(['powershell.exe', '-NoProfile', '-Command', command], { cwd: tmpdir(), env, stdout: 'collect', maxStdout: 4096 })
    const exit = await proc.done
    this.lastLoginAt = Date.now()
    if (exit.error !== undefined || exit.exitCode !== 0) {
      return 'Could not open a login window automatically (' + (exit.error ?? proc.stderrTail().trim() ?? 'exit ' + String(exit.exitCode)) + '). Open a terminal, run "agy" and complete the sign-in, then retry.'
    }
    return 'Opened the interactive Antigravity login window (' + exe + (this.config.loginWindowMinimized ? ', minimized in the taskbar' : '') + '). Complete the sign-in there (a browser may open for Google sign-in), close it, then retry.'
  }

  private maybeAutoLogin(detail: string): string {
    const hinted = authHintFor(detail)
    if (!isAuthError(detail) || !this.config.autoLoginWindow) return hinted
    if (Date.now() - this.lastLoginAt < LOGIN_LAUNCH_COOLDOWN_MS) return hinted
    this.lastLoginAt = Date.now()
    void this.launchLogin().then((message) => this.log('agy-mcp: ' + message), (error) => this.log('agy-mcp: could not open login window: ' + String(error)))
    return hinted + '\n(A login window has been opened on this machine — complete the sign-in there, then retry.)'
  }

  // ── Run lookup ───────────────────────────────────────────────────────────

  /**
   * The live run of a task key, else its newest run, else a run by run id.
   * A new task's first run id equals its task key, so the task lookup must win.
   */
  get(idOrTask: string): AgyRun | undefined {
    const active = this.activeByTask.get(idOrTask)
    if (active !== undefined) return active
    let newest: AgyRun | undefined
    for (const run of this.runs.values()) {
      if (run.task === idOrTask && (newest === undefined || run.order > newest.order)) newest = run
    }
    return newest ?? this.runs.get(idOrTask)
  }

  activeRuns(): AgyRun[] {
    return [...this.runs.values()].filter((run) => run.status === 'running').sort((a, b) => b.startedAt - a.startedAt)
  }

  finishedRuns(): AgyRun[] {
    return [...this.runs.values()].filter((run) => run.status !== 'running').sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
  }

  activeRunIdsFor(task: string): Set<string> {
    return new Set(this.activeRuns().filter((run) => run.task === task).map((run) => run.runId))
  }

  cancel(idOrTask: string): AgyRun | undefined {
    const run = this.activeByTask.get(idOrTask) ?? this.runs.get(idOrTask)
    if (run === undefined || run.status !== 'running') return undefined
    run.cancel()
    return run
  }

  /** Stop every live run (server shutdown) and wait briefly for them to settle; persistent processes are killed. */
  async terminateAll(waitMs: number): Promise<number> {
    const active = this.activeRuns()
    for (const run of active) run.cancel()
    await settleWithin(Promise.all(active.map((run) => run.done)), waitMs)
    await this.persistentManager?.dispose()
    return active.length
  }

  /** Live persistent agy processes (diagnostics). */
  persistentSessions(): PersistentSessionInfo[] {
    return this.persistentManager?.list() ?? []
  }

  private get persistent(): PersistentAgySessionManager {
    this.persistentManager ??= new PersistentAgySessionManager({
      spawn: persistentSpawn(this.config.graceMs),
      idleMs: this.config.persistentIdleMs,
      graceMs: this.config.graceMs,
      onWarn: (message) => this.log('agy-mcp: ' + message),
    })
    return this.persistentManager
  }

  /** Compiled supervisor hook text: explicit path, else supervisor-hook.mjs next to this bundle. */
  private supervisorHookSource(): string {
    if (this.hookSource !== undefined) return this.hookSource
    const candidates: string[] = []
    if (this.config.supervisorHookPath.length > 0) candidates.push(this.config.supervisorHookPath)
    try {
      candidates.push(join(dirname(fileURLToPath(import.meta.url)), 'supervisor-hook.mjs'))
    } catch {
      // not a file: URL (never in the shipped bundle)
    }
    for (const candidate of candidates) {
      try {
        const source = readFileSync(candidate, 'utf8')
        if (source.includes('PreToolUse')) {
          this.hookSource = source
          return source
        }
      } catch {
        // try the next location
      }
    }
    throw new Error('supervision is enabled but cannot be applied: the supervisor hook script was not found (looked in: ' + candidates.join(', ') + '). Reinstall/rebuild the plugin so server/supervisor-hook.mjs exists, or set AGY_MCP_SUPERVISOR_HOOK.')
  }

  private supervisionSettings(): SupervisionSettings {
    const config = this.config
    return {
      denyCommands: config.supervisionDenyCommands,
      builtinRules: config.supervisionBuiltinRules,
      stopCheck: config.supervisionStopCheck,
      stopCheckTimeoutMs: config.supervisionStopCheckTimeoutMs,
      maxReworks: config.supervisionMaxReworks,
    }
  }

  private prepareRunSupervisor(runId: string, dir: string, cwd: string, dirs: string[], hookSource: string): SupervisorHandle {
    try {
      return prepareSupervisor({
        baseDir: this.config.supervisionDir,
        dir,
        runId,
        roots: [cwd, ...dirs],
        cwd,
        home: process.env.USERPROFILE ?? process.env.HOME ?? homedir(),
        extraProtectedPaths: [join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), '.zcode'), this.config.dataDir],
        settings: this.supervisionSettings(),
        hookSource,
        execPath: process.execPath,
      })
    } catch (error) {
      throw new Error('supervision is enabled but cannot be applied: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  private nextRunId(): string {
    this.seq += 1
    return 'agy-' + Date.now().toString(36) + '-' + this.seq.toString(36)
  }

  /** Also called by the server after start/finish so the panel can be pushed an update. */
  remember(run: AgyRun): void {
    this.runs.set(run.runId, run)
    const finished = this.finishedRuns()
    for (const old of finished.slice(MAX_FINISHED_RUNS)) this.runs.delete(old.runId)
  }

  // ── Start a run ──────────────────────────────────────────────────────────

  async start(options: StartOptions): Promise<AgyRun> {
    const config = this.config
    const promptText = options.prompt
    if (promptText.trim().length === 0) throw new Error('prompt contains no text')
    // Rotation only ever picks the account for a NEW process, never mid-run.
    const rotated = await this.accounts.ensureUsableAccount()
    if (rotated !== undefined) this.log('agy-mcp: starting on rotated account ' + rotated.to.email)

    let task: string
    let cwd: string
    let conversationId: string | undefined
    let label = options.label.trim() || 'agy task'
    let model = options.model?.trim()
    let effort = options.effort?.trim().toLowerCase()
    if (options.task !== undefined) {
      task = options.task
      const record = this.loadRegistry()[task]
      if (record === undefined) {
        throw new Error('no such task "' + task + '" — start one with agy_run first, or list recorded keys with agy_tasks')
      }
      if (this.activeByTask.has(task)) {
        throw new Error('task "' + task + '" is still running — wait for it with agy_status, or stop it with agy_cancel, before sending a follow-up')
      }
      // Cross-process lease: two agy processes must never drive one conversation.
      const foreign = this.foreignRunsFor(task)
      if (foreign.length > 0) {
        throw new Error('task "' + task + '" is running in another ZCode session (run ' + foreign[0].runId + ', started ' + new Date(foreign[0].startedAt).toISOString() + '); wait for it to finish there before sending a follow-up')
      }
      conversationId = record.conversationId
      cwd = record.cwd
      if (options.label.trim().length === 0) label = record.label
      // agy resumes on its DEFAULT model unless --model is sent again: keep the recorded
      // model/effort unless overridden (a new model drops the old effort).
      if (model === undefined || model.length === 0) {
        model = record.model
        if (effort === undefined || effort.length === 0) effort = record.effort
      }
    } else {
      task = this.nextRunId()
      cwd = validateWorkspace(options.cwd)
    }
    const dirs = validateDirs([...config.addDirs, ...(options.dirs ?? [])])
    const env = this.baseEnv()
    const exe = resolveAgy(config.command, env)
    const support = await this.probeFlags(exe, env)

    let effectivePrompt = promptText
    if (config.avoidBrowser) effectivePrompt += AVOID_BROWSER_SUFFIX
    if (config.avoidLargeReads) effectivePrompt += AVOID_LARGE_READ_SUFFIX
    if (conversationId !== undefined && !support.conversation) {
      throw new Error('this agy build does not support --conversation, so task "' + task + '" cannot be resumed. Upgrade agy or start a new task.')
    }
    if (dirs.length > 0 && support.probed && !support.addDir) {
      throw new Error('this agy build does not support --add-dir. Upgrade agy, or move the target inside the workspace.')
    }

    // Persistent sessions need documented streaming input; prompts that look like
    // CLI slash commands would end a streaming session, so they always run one-shot.
    if (config.persistentSessions && !support.streamInput && !this.streamInputWarned) {
      this.streamInputWarned = true
      this.log('agy-mcp: AGY_MCP_PERSISTENT is on but this agy build does not document --input-format stream-json; using one process per run')
    }
    const persistent = config.persistentSessions && support.streamInput && !promptText.trimStart().startsWith('/')

    // Supervision fails closed: an explicitly enabled guardrail is never skipped silently.
    let hookSource: string | undefined
    if (config.supervisionEnabled) {
      if (!config.skipPermissions) {
        throw new Error('supervision is enabled but cannot be applied: it requires skipPermissions (a hook "allow" would otherwise change headless approval behavior)')
      }
      if (support.probed && !support.addDir) {
        throw new Error('supervision is enabled but cannot be applied: this agy build lacks --add-dir, which carries the per-run hooks')
      }
      hookSource = this.supervisorHookSource()
    }
    const runId = options.task !== undefined ? this.nextRunId() : task
    // One-shot: one supervisor directory per run. Persistent: one per process (created at spawn).
    const supervisorDir = hookSource !== undefined && !persistent ? supervisorDirFor(config.supervisionDir, runId) : undefined
    if (supervisorDir !== undefined) effectivePrompt += supervisionPromptNote(cwd, supervisorDir)

    const timeoutMs = options.background ? config.backgroundTimeoutMs : config.printTimeoutMs
    let stdinPrompt: string | undefined
    const argv: string[] = [exe, ...config.commandPrefixArgs]
    if (persistent) {
      // Prompts travel one stdin line per turn; -p and --print-timeout do not apply.
      if (effectivePrompt.length + PERSISTENT_NOTE_BUDGET > STDIN_PROMPT_MAX_CHARS) {
        throw new Error('prompt is ' + effectivePrompt.length + ' chars, more than this agy build accepts (' + STDIN_PROMPT_MAX_CHARS + '). Write the bulky context into files in the workspace and reference them from a short prompt.')
      }
      argv.push('--input-format', 'stream-json', '--output-format', 'stream-json')
    } else if (effectivePrompt.length > MAX_ARGV_PROMPT_CHARS) {
      if (!support.streamInput || effectivePrompt.length > STDIN_PROMPT_MAX_CHARS) {
        throw new Error('prompt is ' + effectivePrompt.length + ' chars, more than this agy build accepts (' + (support.streamInput ? STDIN_PROMPT_MAX_CHARS : MAX_ARGV_PROMPT_CHARS) + '). Write the bulky context into files in the workspace and reference them from a short prompt.')
      }
      stdinPrompt = effectivePrompt
      argv.push('--input-format', 'stream-json')
    } else {
      argv.push('-p', effectivePrompt, '--print-timeout', Math.max(1, Math.round(timeoutMs / 1000)) + 's')
    }

    let source = 'cli-default'
    if (options.model !== undefined || options.effort !== undefined) source = 'explicit'
    else if (options.task !== undefined && model !== undefined) source = 'task-record'
    else if (config.model.length > 0 || config.effort.length > 0) source = 'plugin-default'
    if (model === undefined || model.length === 0) model = config.model
    if (effort === undefined || effort.length === 0) effort = config.effort
    if (model.length > 0) {
      let listed: AgyBaseModel[] | undefined
      try {
        listed = await this.models.list()
      } catch (error) {
        this.log('agy-mcp: cannot validate model ' + model + ' (' + String(error) + '); passing it to agy unvalidated')
      }
      if (listed !== undefined) {
        try {
          const resolved = resolveSelection(listed, model, effort.length > 0 ? effort : undefined)
          model = resolved.args.model ?? model
          effort = resolved.args.effort ?? ''
        } catch (error) {
          if (error instanceof AgyModelSelectionError) throw new AgyModelSelectionError(error.message + ' (see agy_models)')
          throw error
        }
      }
      argv.push('--model', model)
    }
    if (effort.length > 0) {
      if (!(EFFORT_ORDER as readonly string[]).includes(effort)) throw new Error('effort must be one of ' + EFFORT_ORDER.join(' | '))
      argv.push('--effort', effort)
    }
    if (config.skipPermissions) argv.push('--dangerously-skip-permissions')
    if (config.sandbox && support.sandbox) argv.push('--sandbox')
    for (const dir of dirs) argv.push('--add-dir', dir)

    let format: TraceTransport
    if (persistent || stdinPrompt !== undefined || !support.probed || support.streamJson) format = 'stream-json'
    else if (support.outputFormat) format = 'json'
    else format = 'text'

    // The awaits above may have let another follow-up of this task start.
    if (this.activeByTask.has(task)) {
      throw new Error('task "' + task + '" is still running — wait for it with agy_status, or stop it with agy_cancel, before sending a follow-up')
    }

    let supervisor: SupervisorHandle | undefined
    if (supervisorDir !== undefined && hookSource !== undefined) {
      supervisor = this.prepareRunSupervisor(runId, supervisorDir, cwd, dirs, hookSource)
      argv.push('--add-dir', supervisor.dir)
      Object.assign(env, supervisor.env)
    }

    const selection = { ...(model.length > 0 ? { model } : {}), ...(effort.length > 0 ? { effort } : {}), source }
    const run = new AgyRun(runId, task, label, cwd, options.background, options.task !== undefined, selection)
    run.conversationId = conversationId
    try {
      this.remember(run)
      this.activeByTask.set(task, run)
      this.markRunStarted(run)
      const recorder = this.recorderFor(run)
      const startInfo: RunStartInfo = {
        mode: options.background ? 'background' : options.task !== undefined ? 'followup' : 'foreground',
        label,
        resumed: conversationId !== undefined,
        ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
        transport: format,
        supervision: supervisor !== undefined ? 'enforced' : 'off',
        model: selection.model ?? null,
        effort: selection.effort ?? null,
        model_source: source,
      }
      let baseline: ReturnType<typeof captureWorkspace> | undefined
      try {
        baseline = captureWorkspace(cwd)
      } catch (error) {
        this.log('agy-mcp: baseline snapshot failed: ' + String(error))
      }
      if (persistent) {
        const key = JSON.stringify({ argv, cwd, proxy: this.resolveProxy(), supervision: hookSource !== undefined ? this.supervisionSettings() : false })
        run.done = this.executePersistent(run, { argv, env, key, prompt: effectivePrompt, hookSource, timeoutMs, conversationId, dirs, baseline, recorder, startInfo })
      } else {
        recorder?.start(startInfo)
        run.done = this.execute(run, { argv, env, format, stdinPrompt, timeoutMs, support, conversationId, dirs, baseline, recorder, supervisor })
      }
    } catch (error) {
      supervisor?.dispose()
      if (this.activeByTask.get(task) === run) this.activeByTask.delete(task)
      this.markRunFinished(run)
      this.runs.delete(run.runId)
      throw error
    }
    return run
  }

  private recorderFor(run: AgyRun): RunTraceRecorder | undefined {
    const traces = this.traces
    if (traces === undefined) return undefined
    traces.ensure({ trace_key: run.task, kind: 'task', owner: TRACE_OWNER, child_id: null })
    return new RunTraceRecorder(traces, run.task, run.runId, { cwd: run.cwd, home: process.env.USERPROFILE ?? process.env.HOME ?? homedir() })
  }

  /** Stream observer shared by both transports; a new task records its conversation as soon as agy names it. */
  private observer(run: AgyRun, recorder: RunTraceRecorder | undefined): (event: AgyStreamEvent) => void {
    let recorded = run.followup
    return (event) => {
      recorder?.onEvent(event)
      run.observe(event)
      if (!recorded && 'conversationId' in event && typeof event.conversationId === 'string' && event.conversationId.length > 0) {
        recorded = true
        if (run.conversationId === undefined) run.conversationId = event.conversationId
        // Early record: a crash or shutdown mid-run must not lose the resumable conversation.
        void this.recordTask(run, event.conversationId, true)
      }
    }
  }

  private async execute(run: AgyRun, plan: {
    argv: string[]
    env: Record<string, string>
    format: TraceTransport
    stdinPrompt: string | undefined
    timeoutMs: number
    support: FlagSupport
    conversationId: string | undefined
    dirs: string[]
    baseline: ReturnType<typeof captureWorkspace> | undefined
    recorder: RunTraceRecorder | undefined
    supervisor: SupervisorHandle | undefined
  }): Promise<AgyRun> {
    const config = this.config
    const recorder = plan.recorder
    let proc: ManagedProcess | undefined
    let stream: LiveStream | undefined
    let timedOut = false
    let watchdog: NodeJS.Timeout | undefined
    let stderr = ''
    let exit: ExitInfo | undefined
    run.cancelHook = () => proc?.terminate()

    const onEvent = this.observer(run, recorder)
    const spawnOnce = (format: TraceTransport): void => {
      const argv = [...plan.argv]
      if (format !== 'text') argv.push('--output-format', format)
      if (plan.conversationId !== undefined) argv.push('--conversation', plan.conversationId)
      const live = format === 'stream-json'
      proc = spawnManaged(argv, {
        cwd: run.cwd,
        env: plan.env,
        stdin: plan.stdinPrompt !== undefined ? 'pipe' : 'ignore',
        stdout: live ? 'pipe' : 'collect',
        maxStdout: MAX_STDOUT_CHARS,
        graceMs: config.graceMs,
      })
      stream = live ? attachStream(proc.stdout, onEvent) : undefined
      if (plan.stdinPrompt !== undefined && proc.stdin !== undefined) {
        proc.stdin.on('error', () => {})
        proc.stdin.end(JSON.stringify({ event: 'user', message: { content: plan.stdinPrompt } }) + '\n')
      }
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        timedOut = true
        this.log('agy-mcp: run ' + run.runId + ' exceeded ' + (plan.timeoutMs + config.watchdogMarginMs) + ' ms, terminating the process tree')
        proc?.terminate()
      }, plan.timeoutMs + config.watchdogMarginMs)
      if (run.cancelRequested) proc.terminate()
    }

    let status: ExecutionStatus = 'failed'
    try {
      let format = plan.format
      spawnOnce(format)
      exit = await proc!.done
      if (stream !== undefined) await settleWithin((stream as LiveStream).drained, config.graceMs)
      stderr = proc!.stderrTail()
      if (!run.cancelRequested && !timedOut && format !== 'text' && !plan.support.probed && exit.exitCode !== 0 && isUnknownFlagError(stderr)) {
        format = 'text'
        recorder?.transport('text', 'agy rejected --output-format; retried once in text mode')
        spawnOnce(format)
        exit = await proc!.done
        stderr = proc!.stderrTail()
      }
      const live = stream as LiveStream | undefined
      const stdout = live !== undefined ? live.acc.fallbackText() : proc!.collectedStdout()
      const reply = live !== undefined ? live.acc.reply() : format === 'json' ? tryParseJsonOutput(stdout) : undefined
      run.conversationId = reply?.conversation_id ?? live?.acc.conversationId ?? run.conversationId
      if (timedOut) {
        status = 'timeout'
        run.error = authHintFor('agy did not finish within ' + (plan.timeoutMs + config.watchdogMarginMs) + ' ms (ceiling ' + plan.timeoutMs + ' ms + watchdog margin); the process tree was terminated.' + (stderr.trim().length > 0 ? '\n' + stderr.trim() : ''))
      } else if (run.cancelRequested) {
        status = 'cancelled'
        run.error = 'cancelled by request'
      } else if (exit.error !== undefined) {
        status = 'failed'
        run.error = 'could not start agy: ' + exit.error
      } else if (reply !== undefined) {
        if (reply.status === 'SUCCESS' && typeof reply.response === 'string') {
          status = 'completed'
          run.response = reply.response
        } else {
          status = 'failed'
          run.error = this.maybeAutoLogin(typeof reply.error === 'string' && reply.error.length > 0 ? reply.error : stderr.trim() || 'agy exited with code ' + String(exit.exitCode))
        }
      } else if (exit.exitCode === 0) {
        if (stdout.trim().length === 0) {
          status = 'failed'
          run.error = 'agy exited 0 but produced no output (stderr: ' + (stderr.trim() || '(empty)') + '). Some agy builds drop output under a non-TTY pipe; verify with an interactive "agy" run once, then retry or upgrade agy.'
        } else {
          status = 'completed'
          run.response = stdout
        }
      } else {
        status = 'failed'
        run.error = this.maybeAutoLogin(stderr.trim() || 'agy exited with code ' + String(exit.exitCode))
      }
      if (status !== 'completed' && run.response === undefined && stdout.trim().length > 0) run.response = stdout
      // Background readers see the final answer even when no text was streamed.
      if (status === 'completed' && live?.acc.sawDelta !== true && run.response !== undefined) run.appendVisible(run.response)
    } catch (error) {
      status = timedOut ? 'timeout' : run.cancelRequested ? 'cancelled' : 'failed'
      run.error = 'agy run failed: ' + (error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(watchdog)
    }

    let supervision: SupervisionReport | undefined
    if (plan.supervisor !== undefined) {
      try {
        supervision = plan.supervisor.collect()
      } catch (error) {
        this.log('agy-mcp: could not read supervision decisions: ' + String(error))
      } finally {
        plan.supervisor.dispose()
      }
    }
    return this.finish(run, { status, exit, stderr, timedOut, recorder, baseline: plan.baseline, dirs: plan.dirs, supervision })
  }

  /**
   * One turn on the task's persistent agy process (started, or restarted with
   * --conversation, when none is alive or its start options changed). Cancel
   * and timeout kill the process: an unfinished turn is never reported as
   * completed, and the next turn resumes the conversation in a new process.
   */
  private async executePersistent(run: AgyRun, plan: {
    argv: string[]
    env: Record<string, string>
    key: string
    prompt: string
    hookSource: string | undefined
    timeoutMs: number
    conversationId: string | undefined
    dirs: string[]
    baseline: ReturnType<typeof captureWorkspace> | undefined
    recorder: RunTraceRecorder | undefined
    startInfo: RunStartInfo
  }): Promise<AgyRun> {
    const config = this.config
    const recorder = plan.recorder
    const abort = new AbortController()
    run.cancelHook = () => abort.abort()
    if (run.cancelRequested) abort.abort()
    let turnProcess: PersistentAgyProcess | undefined
    let state: ProcessState | undefined
    let spawned: ProcessState | undefined
    let recorderStarted = false
    const turnTimeoutMs = plan.timeoutMs + config.watchdogMarginMs

    const buildSpawn = async (): Promise<{ spec: { argv: string[]; cwd: string; env: Record<string, string> }; onClosed: () => void }> => {
      const argv = [...plan.argv]
      const env = { ...plan.env }
      const fresh: ProcessState = { seen: 0 }
      if (plan.hookSource !== undefined) {
        fresh.supervisor = this.prepareRunSupervisor(run.runId, supervisorDirFor(config.supervisionDir, run.runId), run.cwd, plan.dirs, plan.hookSource)
        argv.push('--add-dir', fresh.supervisor.dir)
        Object.assign(env, fresh.supervisor.env)
      }
      // A new process resumes the task's conversation (the recorded one, or the one the last process used).
      const resume = run.conversationId ?? plan.conversationId
      if (resume !== undefined) argv.push('--conversation', resume)
      spawned = fresh
      return {
        spec: { argv, cwd: run.cwd, env },
        // Read the last decisions before the directory goes, so a dead process is not mistaken for tampering.
        onClosed: () => {
          if (fresh.supervisor === undefined) return
          try {
            fresh.final = fresh.supervisor.collect()
          } catch {
            // decisions lost; reported as no report
          }
          fresh.supervisor.dispose()
        },
      }
    }
    const onProcess = (proc: PersistentAgyProcess, startedNow: boolean): void => {
      turnProcess = proc
      if (startedNow && spawned !== undefined) this.processStates.set(proc, spawned)
      state = this.processStates.get(proc)
      const info = { ...(proc.pid !== undefined ? { pid: proc.pid } : {}), turn: proc.turns + 1, reused: !startedNow }
      run.processInfo = info
      const conversation = proc.conversationId ?? run.conversationId
      recorder?.start({
        ...plan.startInfo,
        resumed: !startedNow || conversation !== undefined,
        ...(conversation !== undefined ? { conversation_id: conversation } : {}),
        supervision: state?.supervisor !== undefined ? 'enforced' : 'off',
        process: info,
      })
      recorderStarted = true
    }
    const content = (): string => plan.prompt + (state?.supervisor !== undefined ? supervisionPromptNote(run.cwd, state.supervisor.dir) : '')

    let outcome: PersistentTurnOutcome | undefined
    let failure: string | undefined
    try {
      outcome = await this.persistent.runTurn(run.task, plan.key, buildSpawn, content, { onEvent: this.observer(run, recorder), signal: abort.signal, timeoutMs: turnTimeoutMs }, onProcess)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      // The process never came up: its supervisor directory must not linger.
      if (turnProcess === undefined && spawned?.supervisor !== undefined) spawned.supervisor.dispose()
    }
    if (!recorderStarted) recorder?.start(plan.startInfo)

    let supervision: SupervisionReport | undefined
    if (state?.supervisor !== undefined) {
      try {
        const report = state.final ?? state.supervisor.collect()
        supervision = sliceSupervisionReport(report, state.seen)
        state.seen = report.decisions.length
      } catch (error) {
        this.log('agy-mcp: could not read supervision decisions: ' + String(error))
      }
    }

    let status: ExecutionStatus
    const stderr = outcome?.stderrTail ?? ''
    if (outcome === undefined) {
      status = run.cancelRequested ? 'cancelled' : 'failed'
      run.error = run.cancelRequested ? 'cancelled by request' : 'agy run failed: ' + (failure ?? 'unknown error')
    } else {
      run.conversationId = outcome.conversationId ?? turnProcess?.conversationId ?? run.conversationId
      const detail = (fallback: string): string => [outcome!.error, stderr.trim()].filter((part) => part !== undefined && part.length > 0).join('\n') || fallback
      switch (outcome.status) {
        case 'completed':
          status = 'completed'
          run.response = outcome.response
          if (outcome.text.length === 0 && outcome.response.length > 0) run.appendVisible(outcome.response)
          break
        case 'cancelled':
          status = 'cancelled'
          run.error = run.cancelRequested ? 'cancelled by request' : detail('agy cancelled the turn')
          break
        case 'timeout':
          status = 'timeout'
          run.error = authHintFor('agy did not finish the turn within ' + turnTimeoutMs + ' ms (ceiling ' + plan.timeoutMs + ' ms + watchdog margin); the persistent process was terminated.' + (stderr.trim().length > 0 ? '\n' + stderr.trim() : ''))
          break
        default:
          status = 'failed'
          run.error = this.maybeAutoLogin(detail('agy ended the turn with ' + outcome.status))
      }
      if (status !== 'completed' && run.response === undefined && outcome.text.trim().length > 0) run.response = outcome.text
    }
    const exit: ExitInfo | undefined = outcome !== undefined ? { exitCode: outcome.exitCode ?? null, signal: null } : undefined
    return this.finish(run, { status, exit, stderr, timedOut: status === 'timeout', recorder, baseline: plan.baseline, dirs: plan.dirs, supervision })
  }

  /** Shared settlement: trace end, supervision records, evidence, registry, bookkeeping. */
  private async finish(run: AgyRun, result: {
    status: ExecutionStatus
    exit: ExitInfo | undefined
    stderr: string
    timedOut: boolean
    recorder: RunTraceRecorder | undefined
    baseline: ReturnType<typeof captureWorkspace> | undefined
    dirs: string[]
    supervision: SupervisionReport | undefined
  }): Promise<AgyRun> {
    const { status, exit, stderr, recorder, supervision } = result
    if (status === 'failed' && isQuotaError((run.error ?? '') + '\n' + stderr)) {
      try {
        const note = await this.accounts.onQuotaFailure(run.error ?? stderr)
        if (note !== undefined) run.error = (run.error ?? '') + '\n[' + note + ']'
      } catch (error) {
        this.log('agy-mcp: account rotation after quota failure failed: ' + String(error))
      }
    }
    run.exit = exit
    run.status = status
    run.supervision = supervision
    recorder?.end({
      outcome: status,
      exit_code: exit?.exitCode ?? null,
      signal: exit?.signal ?? null,
      timed_out: result.timedOut,
      cancelled: run.cancelRequested,
      stderr,
      agy_error: parseAgyErrorLine(stderr),
      ...(status === 'completed' ? {} : { diagnostic: (run.error ?? '').slice(0, 1000) }),
      ...(supervision !== undefined ? { supervision } : {}),
    })
    if (supervision !== undefined) recorder?.supervision(supervision)
    if (result.baseline !== undefined) {
      try {
        const evidence = collectEvidence(result.baseline, run.task, status, run.conversationId, status === 'completed' ? undefined : run.error)
        if (result.dirs.length > 0) evidence.warnings.push('Additional dirs (--add-dir) are not covered by workspace evidence: ' + result.dirs.join(', '))
        saveEvidence(evidence, this.evidenceDir)
        recorder?.evidence(evidence)
        run.evidence = evidence
      } catch (error) {
        this.log('agy-mcp: failed to collect evidence: ' + String(error))
      }
    }
    if (run.conversationId !== undefined) await this.recordTask(run, run.conversationId)
    run.finishedAt = Date.now()
    this.markRunFinished(run)
    if (this.activeByTask.get(run.task) === run) this.activeByTask.delete(run.task)
    this.remember(run)
    return run
  }
}

/** Durable marker of a live run (data/active-runs/<runId>.json). */
export interface RunMarker {
  task: string
  runId: string
  label: string
  cwd: string
  background: boolean
  startedAt: number
  serverPid: number
  conversationId?: string
  model?: string
  effort?: string
}

const MARKER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

function markerPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Per persistent process: its supervisor, the decisions already attributed to earlier turns, and the report read at exit. */
interface ProcessState {
  supervisor?: SupervisorHandle
  seen: number
  final?: SupervisionReport
}

/** Room reserved for the per-process supervision note appended to each persistent turn. */
const PERSISTENT_NOTE_BUDGET = 2_000

/** Long-lived agy process for PersistentAgySessionManager, on the plugin's own spawn plumbing. */
function persistentSpawn(graceMs: number): PersistentSpawnFn {
  return (spec) => {
    const proc = spawnManaged(spec.argv, { cwd: spec.cwd, env: spec.env, stdin: 'pipe', stdout: 'pipe', graceMs })
    const handle = {
      pid: proc.pid,
      stdout: proc.stdout,
      stdin: proc.stdin,
      done: proc.done,
      terminate: () => proc.terminate(),
      collected: { stderr: { readFrom: (_offset: number) => ({ text: proc.stderrTail() }) } },
    }
    return handle as unknown as ReturnType<PersistentSpawnFn>
  }
}
