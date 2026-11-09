/**
 * Optional per-run DSH supervision of an Antigravity CLI run, built on agy's
 * own command hooks (see supervisor-hook.ts for the verified semantics).
 *
 * For each run the plugin writes a private supervisor directory outside the
 * delegated workspace (default ~/.dsh/agy-supervisor/<hash>) containing
 * .agents/hooks.json, the hook script and a policy, and passes it to agy with
 * --add-dir. Nothing is written into the user's repository or global agy
 * configuration. After the run, decisions are read back and the files are
 * re-hashed so tampering is reported instead of silently trusted.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { SupervisorPolicy } from './supervisor-hook.js'

export interface SupervisionSettings {
  denyCommands: string[]
  builtinRules: boolean
  stopCheck: string
  stopCheckTimeoutMs: number
  maxReworks: number
}

export interface SupervisionDecision {
  ts: number
  event: string
  decision: string
  rule: string | null
  reason: string | null
  step?: number | null
  tool?: string | null
  command?: string | null
  termination_reason?: string | null
  reworks?: number
  overwrite?: Record<string, string>
  model?: string | null
}

export interface SupervisionReport {
  decisions: SupervisionDecision[]
  allowed: number
  denied: number
  reworks: number
  /** Supervisor files whose content changed during the run (should be empty). */
  tampered: string[]
  /** Distinct modelName values agy passed to the hooks (what actually ran). */
  effectiveModels: string[]
}

/** The part of a report produced after the first `from` decisions (one turn of a persistent process). */
export function sliceSupervisionReport(report: SupervisionReport, from: number): SupervisionReport {
  const decisions = report.decisions.slice(from)
  const pre = decisions.filter((d) => d.event === 'PreToolUse')
  return {
    decisions,
    allowed: pre.filter((d) => d.decision === 'allow').length,
    denied: pre.filter((d) => d.decision !== 'allow').length,
    reworks: decisions.filter((d) => d.event === 'Stop' && d.decision === 'continue').length,
    tampered: report.tampered,
    effectiveModels: [...new Set(decisions.map((d) => d.model).filter((m): m is string => typeof m === 'string' && m.length > 0))],
  }
}

export interface SupervisorHandle {
  dir: string
  env: Record<string, string>
  collect(): SupervisionReport
  dispose(): void
}

const STALE_MS = 24 * 60 * 60 * 1000

function sha256(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return 'missing'
  }
}

/** Credential and agent-state locations the hook protects (outside the workspace). */
export function defaultProtectedPaths(home: string): string[] {
  const out = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.gemini', '.dsh', '.config/gcloud', '.config/gh', '.netrc', '.git-credentials', '.npmrc', '.pypirc']
    .map((rel) => join(home, rel))
  if (process.env.APPDATA) out.push(join(process.env.APPDATA, 'gcloud'), join(process.env.APPDATA, 'GitHub CLI'))
  return out
}

function hookCommand(event: string, execPath: string): string {
  if (process.platform === 'win32') return `hook.cmd ${event}`
  return `'${execPath.replace(/'/g, "'\\''")}' hook.mjs ${event}`
}

/** Remove supervisor directories left behind by crashed runs (best effort). */
function pruneStale(baseDir: string): void {
  let names: string[]
  try {
    names = readdirSync(baseDir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    if (!/^[0-9a-f]{24}$/.test(name)) continue
    const dir = join(baseDir, name)
    try {
      if (now - statSync(dir).mtimeMs > STALE_MS) rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

/** Fresh, unguessable supervisor directory path for one run (not created yet). */
export function supervisorDirFor(baseDir: string, runId: string): string {
  return join(baseDir, createHash('sha256').update(`${runId}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 24))
}

/** Environment note appended to the AGY prompt so it never mistakes the supervisor directory for its workspace. */
export function supervisionPromptNote(workspace: string, supervisorDir: string): string {
  return `

(Environment note: your delegated workspace is ${workspace}; run every command there and keep all files inside it. The directory ${supervisorDir} is attached only for DSH supervision hooks: never read, write or run commands in it. DSH supervision may block some tool calls; when a call is blocked, respect it and do not work around it.)`
}

/**
 * Write the supervisor directory for one run. hookSource is the compiled
 * supervisor-hook.js text; execPath the Node binary that runs it.
 */
export function prepareSupervisor(options: {
  baseDir: string
  runId: string
  roots: readonly string[]
  /** Readable even inside protected locations (shared DSH skill folders); never writable. */
  readRoots?: readonly string[]
  /** Additional host-owned paths to protect (for example the ZCode data directory). */
  extraProtectedPaths?: readonly string[]
  cwd: string
  home: string
  settings: SupervisionSettings
  hookSource: string
  execPath: string
  /** Pre-computed directory (see supervisorDirFor); generated when omitted. */
  dir?: string
}): SupervisorHandle {
  const { baseDir, runId, settings } = options
  pruneStale(baseDir)
  const dir = options.dir ?? supervisorDirFor(baseDir, runId)
  const agents = join(dir, '.agents')
  mkdirSync(agents, { recursive: true })
  const policyPath = join(dir, 'policy.json')
  const logPath = join(dir, 'decisions.ndjson')
  const statePath = join(dir, 'state.json')
  const policy: SupervisorPolicy = {
    version: 1,
    runId,
    roots: options.roots.map((root) => resolve(root)),
    readRoots: (options.readRoots ?? []).map((root) => resolve(root)),
    protectedPaths: [...defaultProtectedPaths(options.home), ...(options.extraProtectedPaths ?? []).map((path) => resolve(path))],
    supervisorDir: dir,
    home: options.home,
    builtinRules: settings.builtinRules,
    denyCommands: settings.denyCommands,
    ...(settings.stopCheck.trim().length > 0 ? {
      stopCheck: { command: settings.stopCheck, cwd: options.cwd, timeoutMs: settings.stopCheckTimeoutMs, maxReworks: settings.maxReworks },
    } : {}),
    logPath,
    statePath,
  }
  writeFileSync(policyPath, JSON.stringify(policy, null, 2), 'utf8')
  writeFileSync(join(agents, 'hook.mjs'), options.hookSource, 'utf8')
  if (process.platform === 'win32') {
    // cmd /c with several quoted tokens is fragile; a wrapper keeps quoting inside one file.
    writeFileSync(join(agents, 'hook.cmd'), `@"${options.execPath}" "%~dp0hook.mjs" %*\r\n`, 'utf8')
  }
  const stopTimeoutSec = Math.ceil(settings.stopCheckTimeoutMs / 1000) + 15
  const hooks = {
    'dsh-agy-supervisor': {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand('PreToolUse', options.execPath), timeout: 15 }] }],
      // Always present: without a stop check it only lets AGY stop, but it reports the model that actually ran.
      Stop: [{ type: 'command', command: hookCommand('Stop', options.execPath), timeout: policy.stopCheck ? stopTimeoutSec : 15 }],
    },
  }
  writeFileSync(join(agents, 'hooks.json'), JSON.stringify(hooks, null, 2), 'utf8')
  const guarded = [policyPath, join(agents, 'hooks.json'), join(agents, 'hook.mjs'), ...(process.platform === 'win32' ? [join(agents, 'hook.cmd')] : [])]
  const baseline = new Map(guarded.map((file) => [file, sha256(file)]))
  let disposed = false
  return {
    dir,
    env: { DSH_AGY_SUPERVISOR_POLICY: policyPath },
    collect(): SupervisionReport {
      const decisions: SupervisionDecision[] = []
      if (existsSync(logPath)) {
        for (const line of readFileSync(logPath, 'utf8').split('\n')) {
          if (line.trim().length === 0) continue
          try {
            const value = JSON.parse(line) as SupervisionDecision
            if (value && typeof value.event === 'string') decisions.push(value)
          } catch {
            // a torn line is skipped
          }
        }
      }
      const tampered = [...baseline].filter(([file, hash]) => sha256(file) !== hash).map(([file]) => file.slice(dir.length + 1))
      const pre = decisions.filter((d) => d.event === 'PreToolUse')
      return {
        decisions,
        allowed: pre.filter((d) => d.decision === 'allow').length,
        denied: pre.filter((d) => d.decision !== 'allow').length,
        reworks: decisions.filter((d) => d.event === 'Stop' && d.decision === 'continue').length,
        tampered,
        effectiveModels: [...new Set(decisions.map((d) => d.model).filter((m): m is string => typeof m === 'string' && m.length > 0))],
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // stale directories are pruned on a later run
      }
    },
  }
}
