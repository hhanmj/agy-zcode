/**
 * Process plumbing for the ZCode MCP server: executable lookup, a scrubbed
 * child environment, and spawning with whole-tree termination. This replaces
 * the DSH "ctx.subprocess" seam the DSH plugin uses.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'

/** Same heuristic as DSH's scrubbedParentEnv: credential-shaped names never leak implicitly. */
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i
/** Variables that only make sense for the MCP server itself, never for agy. */
const SERVER_ONLY_ENV = /^(ZCODE_|CLAUDE_|AGY_MCP_|ELECTRON_RUN_AS_NODE$)/i

export function scrubbedEnv(overlay: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV_PATTERN.test(key) || SERVER_ONLY_ENV.test(key)) continue
    env[key] = value
  }
  return { ...env, ...overlay }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function envValue(env: Record<string, string>, name: string): string | undefined {
  const hit = Object.keys(env).find((key) => key.toUpperCase() === name)
  return hit === undefined ? undefined : env[hit]
}

/** PATH (+PATHEXT on Windows) lookup; absolute or relative paths are checked directly. */
export function findExecutable(command: string, env: Record<string, string>): string | undefined {
  const exts = process.platform === 'win32'
    ? ['', ...(envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => ext.toLowerCase())]
    : ['']
  const candidates = (base: string): string[] => exts.map((ext) => base + ext)
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return candidates(command).find(isFile)
  }
  for (const dir of (envValue(env, 'PATH') ?? '').split(delimiter)) {
    if (dir.trim().length === 0) continue
    const hit = candidates(join(dir.replace(/^"|"$/g, ''), command)).find(isFile)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** agy executable: configured command on PATH, then AGY_BIN and the official install locations. */
export function resolveAgy(command: string, env: Record<string, string>): string {
  const direct = findExecutable(command, env)
  if (direct !== undefined) return direct
  const exe = process.platform === 'win32' ? 'agy.exe' : 'agy'
  const home = process.env.USERPROFILE ?? process.env.HOME
  const fallbacks = [
    process.env.AGY_BIN,
    process.env.LOCALAPPDATA !== undefined ? join(process.env.LOCALAPPDATA, 'agy', 'bin', exe) : undefined,
    home !== undefined ? join(home, '.local', 'bin', exe) : undefined,
    home !== undefined ? join(home, '.gemini', 'bin', exe) : undefined,
    home !== undefined ? join(home, 'go', 'bin', exe) : undefined,
  ]
  for (const candidate of fallbacks) {
    if (candidate !== undefined && candidate.length > 0 && existsSync(candidate) && isFile(candidate)) return candidate
  }
  throw new Error('cannot find the agy executable ("' + command + '" is not on PATH, and AGY_BIN, %LOCALAPPDATA%\\agy\\bin and ~/.local/bin do not contain it). Install agy, or set the plugin option agyPath to its absolute path.')
}

/** Bounded tail buffer for diagnostic streams. */
class TailBuffer {
  private text = ''
  constructor(private readonly max: number) {}
  push(chunk: string): void {
    this.text += chunk
    if (this.text.length > this.max) this.text = this.text.slice(this.text.length - this.max)
  }
  value(): string {
    return this.text
  }
}

export interface ExitInfo {
  exitCode: number | null
  signal: string | null
  /** Spawn failure (e.g. ENOENT); the process never ran. */
  error?: string
}

export interface ManagedProcess {
  readonly pid: number | undefined
  /** Raw stdout when stdout is 'pipe'; undefined in collect mode. */
  readonly stdout: Readable | undefined
  readonly stdin: Writable | undefined
  readonly done: Promise<ExitInfo>
  /** Collected stdout (collect mode only, bounded head). */
  collectedStdout(): string
  stderrTail(): string
  /** Terminate the whole process tree (idempotent). */
  terminate(): void
}

export interface SpawnOptions {
  cwd: string
  env: Record<string, string>
  stdin?: 'pipe' | 'ignore'
  /** 'pipe' hands the raw stream to the caller; 'collect' buffers up to maxStdout chars. */
  stdout?: 'pipe' | 'collect'
  maxStdout?: number
  maxStderr?: number
  /** Grace between the polite and the forced termination (POSIX only). */
  graceMs?: number
}

function killTree(child: ChildProcess, graceMs: number): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    // /T walks the child tree; /F because agy (a console app without windows) ignores the polite form.
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => child.kill())
    } catch {
      child.kill()
    }
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }, graceMs)
  timer.unref()
}

export function spawnManaged(argv: readonly string[], options: SpawnOptions): ManagedProcess {
  const [file, ...args] = argv
  if (file === undefined) throw new Error('spawnManaged: empty argv')
  const graceMs = options.graceMs ?? 5_000
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // POSIX: own process group so the whole tree can be signalled.
    detached: process.platform !== 'win32',
    shell: false,
  })
  const stderr = new TailBuffer(options.maxStderr ?? 64 * 1024)
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => stderr.push(chunk))
  let collected = ''
  const maxStdout = options.maxStdout ?? 1024 * 1024
  const collect = (options.stdout ?? 'collect') === 'collect'
  if (collect) {
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (collected.length < maxStdout) collected += chunk.slice(0, maxStdout - collected.length)
    })
  }
  let terminated = false
  const done = new Promise<ExitInfo>((resolve) => {
    let settled = false
    child.once('error', (error) => {
      if (settled) return
      settled = true
      resolve({ exitCode: null, signal: null, error: error.message })
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      resolve({ exitCode: code, signal: signal ?? null })
    })
  })
  return {
    pid: child.pid,
    stdout: collect ? undefined : (child.stdout ?? undefined),
    stdin: child.stdin ?? undefined,
    done,
    collectedStdout: () => collected,
    stderrTail: () => stderr.value(),
    terminate: () => {
      if (terminated) return
      terminated = true
      if (child.exitCode !== null || child.signalCode !== null) return
      killTree(child, graceMs)
    },
  }
}
