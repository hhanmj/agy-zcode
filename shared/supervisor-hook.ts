/**
 * Standalone Antigravity CLI command hook used by optional DSH supervision.
 *
 * The plugin copies this compiled file into a per-run supervisor directory as
 * ".agents/hook.mjs" and hands that directory to agy with "--add-dir"
 * (verified on agy 1.4.0: hooks.json in an added directory is loaded; the
 * hook process inherits agy's environment and runs with cwd = .agents).
 *
 * Verified agy 1.4.0 semantics this hook relies on:
 * - PreToolUse {"decision":"allow"} runs the tool; "deny" blocks it even
 *   under --dangerously-skip-permissions and the reason reaches the model and
 *   the stream-json tool error. An empty decision, malformed output, non-zero
 *   exit or timeout ALSO block the tool (fail-closed).
 * - Stop {"decision":"continue","reason":...} re-enters the agent loop with
 *   the reason injected as a system message; any other value lets it stop.
 * - Hook output is parsed with protojson, so only documented fields
 *   ("decision", "reason", "overwrite") are ever written to stdout.
 * - agy lists the added supervisor directory among its workspaces and may pick
 *   it as the default run_command Cwd. {"decision":"allow","overwrite":{"Cwd":
 *   <workspace>}} (verified) moves such a command back into the delegated
 *   workspace instead of denying it.
 *
 * This is a guardrail against mistakes, not a security boundary: an agent
 * running with skip-permissions has the user's file access. Integrity of the
 * supervisor directory is therefore re-checked by the plugin after the run.
 *
 * Only Node built-ins are imported, so the file runs on its own.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface SupervisorStopCheck {
  command: string
  cwd: string
  timeoutMs: number
  maxReworks: number
}
export interface SupervisorPolicy {
  version: 1
  runId: string
  /** Directories AGY may write to (workspace + explicit add-dirs). */
  roots: string[]
  /** Readable even inside a protected location (shared DSH skill folders); never writable. */
  readRoots?: string[]
  /** Never read or written, unless inside a root (credentials, AGY/DSH state). */
  protectedPaths: string[]
  /** Always protected: the supervisor directory itself. */
  supervisorDir: string
  home: string
  builtinRules: boolean
  /** Extra case-insensitive regular expressions matched against run_command lines. */
  denyCommands: string[]
  stopCheck?: SupervisorStopCheck
  logPath: string
  statePath: string
}
export interface HookDecision {
  decision: string
  reason?: string
  rule?: string
  /** Shallow-merged into the tool arguments by agy before the tool runs. */
  overwrite?: Record<string, string>
}

const BUILTIN_COMMAND_RULES: { id: string; pattern: RegExp; reason: string }[] = [
  { id: 'git-push', pattern: /\bgit\b[^\n|;&]*\bpush\b/i, reason: 'publishing to a remote (git push) is reserved for the supervising DSH agent' },
  {
    id: 'git-destructive',
    pattern: /\bgit\b[^\n|;&]*\b(?:reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.(?:\s|$)|restore\s+(?:--staged\s+|--worktree\s+)*\.(?:\s|$))/i,
    reason: 'discarding working-tree changes wholesale can destroy pre-existing user work; revert specific files instead',
  },
  { id: 'package-publish', pattern: /\b(?:npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgh\s+release\s+create\b/i, reason: 'publishing packages or releases is reserved for the supervising DSH agent' },
  {
    id: 'pipe-to-shell',
    pattern: /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|iex|Invoke-Expression|pwsh|powershell)\b/i,
    reason: 'executing downloaded scripts directly is not allowed',
  },
  {
    id: 'recursive-delete-root',
    pattern: /\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*r[a-zA-Z]*\s+(?:-[a-zA-Z]+\s+)*(?:\/|~|\$HOME|\*)(?:\s|$)|\bRemove-Item\b[^\n]*-Recurse[^\n]*?(?:\s|['"])(?:[A-Za-z]:\\?|~|\$HOME|\$env:USERPROFILE)(?:['"]|\s|$)|\brd\s+\/s\b[^\n]*\s[A-Za-z]:\\?(?:\s|$)/i,
    reason: 'recursive deletion of a drive, home or root directory is not allowed',
  },
  {
    id: 'system-destructive',
    pattern: /\bformat(?:\.com)?\s+[A-Za-z]:|\bmkfs(?:\.\w+)?\b|\bdiskpart\b|\bshutdown\b|\bStop-Computer\b|\bRestart-Computer\b|\breg\s+delete\s+HK/i,
    reason: 'system-level destructive commands are not allowed',
  },
]

const WRITE_TOOL = /write|replace|edit|sed|delete|remove|move|rename|notebook/i
const PATH_KEY = /path|file|target|dir|cwd|folder/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalize(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function inside(child: string, parent: string): boolean {
  const c = normalize(child)
  const p = normalize(parent).replace(/[\\/]+$/, '')
  return c === p || c.startsWith(p + sep)
}

function insideRoots(path: string, policy: SupervisorPolicy): boolean {
  return policy.roots.some((root) => inside(path, root))
}

function looksAbsolute(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('file://')
}

function toPath(value: string): string {
  if (value.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(value).pathname).replace(/^\/([A-Za-z]:)/, '$1')
    } catch {
      return value
    }
  }
  return value
}

/** Absolute path-like string arguments found under path-ish keys (top-level Cwd excluded). */
function collectPaths(value: unknown, key = '', depth = 0, out: string[] = []): string[] {
  if (depth > 4) return out
  if (typeof value === 'string') {
    if (PATH_KEY.test(key) && looksAbsolute(value) && !(depth === 1 && key === 'Cwd')) out.push(toPath(value))
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 64)) collectPaths(item, key, depth + 1, out)
    return out
  }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value).slice(0, 64)) collectPaths(v, k, depth + 1, out)
  }
  return out
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Does a command line mention a protected location (absolute or home-relative spelling)? */
function mentionsPath(command: string, target: string, home: string): boolean {
  const forms = new Set<string>()
  const trimmed = target.replace(/[\\/]+$/, '')
  forms.add(trimmed)
  forms.add(trimmed.replace(/\\/g, '/'))
  if (home && inside(trimmed, home)) {
    const rel = trimmed.slice(home.replace(/[\\/]+$/, '').length).replace(/^[\\/]+/, '')
    if (rel.length > 0) {
      for (const prefix of ['~', '$HOME', '%USERPROFILE%', '$env:USERPROFILE', '${HOME}']) {
        forms.add(prefix + '/' + rel.replace(/\\/g, '/'))
        forms.add(prefix + '\\' + rel.replace(/\//g, '\\'))
      }
    }
  }
  for (const form of forms) {
    if (form.length < 3) continue
    if (new RegExp(escapeRegExp(form) + '(?:$|[\\\\/\\s"\'`;|&)])', 'i').test(command)) return true
  }
  return false
}

const deny = (rule: string, reason: string): HookDecision => ({ decision: 'deny', rule, reason: `DSH supervision blocked this tool call (${rule}): ${reason}` })

/** PreToolUse policy. Never throws; unknown input is treated as an ordinary call. */
export function evaluatePreToolUse(input: unknown, policy: SupervisorPolicy): HookDecision {
  const call = isRecord(input) && isRecord(input.toolCall) ? input.toolCall : {}
  const tool = typeof call.name === 'string' ? call.name : ''
  const args = isRecord(call.args) ? call.args : {}
  const workspace = policy.roots[0] ?? ''
  const integrity = `the DSH supervisor directory must not be read or modified; the delegated workspace is ${workspace}`
  const paths = collectPaths(args)
  const readable = (path: string): boolean => !WRITE_TOOL.test(tool) && (policy.readRoots ?? []).some((root) => inside(path, root))
  for (const path of paths) {
    if (inside(path, policy.supervisorDir)) return deny('supervisor-integrity', integrity)
    if (!insideRoots(path, policy) && !readable(path) && policy.protectedPaths.some((p) => inside(path, p))) {
      return deny('protected-path', `${path} is a credential or agent-state location outside the workspace`)
    }
  }
  if (WRITE_TOOL.test(tool) && tool !== 'run_command') {
    for (const path of paths) {
      if (!insideRoots(path, policy)) return deny('write-outside-workspace', `${tool} targets ${path}, outside the delegated workspace`)
    }
  }
  const command = typeof args.CommandLine === 'string' ? args.CommandLine : typeof args.command === 'string' ? args.command : undefined
  let overwrite: Record<string, string> | undefined
  if (command !== undefined) {
    let cwd = typeof args.Cwd === 'string' && looksAbsolute(args.Cwd) ? args.Cwd : undefined
    if (cwd !== undefined && inside(cwd, policy.supervisorDir) && workspace.length > 0) {
      // agy defaulted to the supervisor workspace: run in the delegated workspace instead.
      overwrite = { Cwd: workspace }
      cwd = workspace
    }
    if (cwd !== undefined && !insideRoots(cwd, policy)) return deny('command-outside-workspace', `the command would run in ${cwd}, outside the delegated workspace ${workspace}`)
    if (mentionsPath(command, policy.supervisorDir, policy.home)) return deny('supervisor-integrity', integrity)
    // Shared skill folders may be read (e.g. a skill's own scripts) even under ~/.dsh.
    let scrubbed = command
    for (const root of policy.readRoots ?? []) {
      for (const form of new Set([root, root.replace(/\\/g, '/')])) scrubbed = scrubbed.split(form).join('<shared-skill>')
    }
    for (const protectedPath of policy.protectedPaths) {
      if (policy.roots.some((root) => inside(root, protectedPath))) continue
      if (mentionsPath(scrubbed, protectedPath, policy.home)) return deny('protected-path', `the command references ${protectedPath}`)
    }
    if (policy.builtinRules) {
      for (const rule of BUILTIN_COMMAND_RULES) if (rule.pattern.test(command)) return deny(rule.id, rule.reason)
    }
    for (const source of policy.denyCommands) {
      let pattern: RegExp
      try {
        pattern = new RegExp(source, 'i')
      } catch {
        continue
      }
      if (pattern.test(command)) return deny('custom-deny', `the command matches the configured pattern /${source}/`)
    }
  }
  return overwrite !== undefined ? { decision: 'allow', rule: 'cwd-redirected', overwrite } : { decision: 'allow' }
}

export interface StopState {
  reworks: number
}
export type CheckRunner = (check: SupervisorStopCheck) => { exitCode: number | null; output: string; error?: string }

export const defaultCheckRunner: CheckRunner = (check) => {
  const result = spawnSync(check.command, {
    shell: true, cwd: check.cwd, timeout: check.timeoutMs, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 20,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return { exitCode: result.status, output, ...(result.error ? { error: String(result.error.message) } : {}) }
}

/** Stop policy: optional verification command; a failure asks AGY to rework, bounded by maxReworks. */
export function evaluateStop(policy: SupervisorPolicy, state: StopState, runCheck: CheckRunner = defaultCheckRunner): { decision: HookDecision; state: StopState } {
  const check = policy.stopCheck
  if (check === undefined || check.command.trim().length === 0) return { decision: { decision: '', rule: 'no-stop-check' }, state }
  if (state.reworks >= check.maxReworks) {
    return { decision: { decision: '', rule: 'rework-limit', reason: `rework limit (${check.maxReworks}) reached; stopping without a passing check` }, state }
  }
  const result = runCheck(check)
  if (result.exitCode === 0) return { decision: { decision: '', rule: 'stop-check-passed' }, state }
  const tail = result.output.trim().slice(-2000)
  const detail = result.error ? `, ${result.error}` : ''
  return {
    decision: {
      decision: 'continue',
      rule: 'stop-check-failed',
      reason: `DSH supervision: the verification command "${check.command}" failed (exit ${String(result.exitCode)}${detail}). Fix the cause, then finish again.${tail ? '\nOutput tail:\n' + tail : ''}`,
    },
    state: { reworks: state.reworks + 1 },
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolveText) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      text += chunk
    })
    process.stdin.on('end', () => resolveText(text))
    process.stdin.on('error', () => resolveText(text))
  })
}

function log(policy: SupervisorPolicy, record: Record<string, unknown>): void {
  try {
    appendFileSync(policy.logPath, JSON.stringify({ ts: Date.now(), ...record }) + '\n', 'utf8')
  } catch {
    // logging must not change the decision
  }
}

/** Only documented protojson fields leave the hook. */
function emit(decision: HookDecision | Record<string, never>): void {
  const out: Record<string, unknown> = {}
  if ('decision' in decision) {
    out.decision = decision.decision
    if (decision.reason) out.reason = decision.reason
    if (decision.overwrite) out.overwrite = decision.overwrite
  }
  process.stdout.write(JSON.stringify(out))
}

export async function main(event: string): Promise<void> {
  const raw = await readStdin()
  let policy: SupervisorPolicy | undefined
  try {
    policy = JSON.parse(readFileSync(process.env.DSH_AGY_SUPERVISOR_POLICY ?? '', 'utf8')) as SupervisorPolicy
  } catch {
    policy = undefined
  }
  if (policy === undefined) {
    // Without a policy the hook cannot vouch for anything: block tools, never trap Stop.
    emit(event === 'PreToolUse' ? { decision: 'deny', reason: 'DSH supervision policy unavailable' } : event === 'Stop' ? { decision: '' } : {})
    return
  }
  let input: unknown = {}
  try {
    input = JSON.parse(raw || '{}')
  } catch {
    input = {}
  }
  const record = isRecord(input) ? input : {}
  if (event === 'PreToolUse') {
    const decision = evaluatePreToolUse(input, policy)
    const call = isRecord(record.toolCall) ? record.toolCall : {}
    const args = isRecord(call.args) ? call.args : {}
    log(policy, {
      event, decision: decision.decision, rule: decision.rule ?? null, reason: decision.reason ?? null,
      step: typeof record.stepIdx === 'number' ? record.stepIdx : null,
      tool: typeof call.name === 'string' ? call.name : null,
      command: typeof args.CommandLine === 'string' ? args.CommandLine.slice(0, 400) : null,
      model: typeof record.modelName === 'string' ? record.modelName : null,
      ...(decision.overwrite ? { overwrite: decision.overwrite } : {}),
    })
    emit(decision)
    return
  }
  if (event === 'Stop') {
    let state: StopState = { reworks: 0 }
    try {
      if (existsSync(policy.statePath)) state = JSON.parse(readFileSync(policy.statePath, 'utf8')) as StopState
    } catch {
      state = { reworks: 0 }
    }
    const outcome = evaluateStop(policy, state)
    try {
      writeFileSync(policy.statePath, JSON.stringify(outcome.state), 'utf8')
    } catch {
      // state loss only resets the rework counter
    }
    log(policy, {
      event, decision: outcome.decision.decision, rule: outcome.decision.rule ?? null, reason: outcome.decision.reason ?? null,
      termination_reason: typeof record.terminationReason === 'string' ? record.terminationReason : null,
      reworks: outcome.state.reworks,
      model: typeof record.modelName === 'string' ? record.modelName : null,
    })
    emit(outcome.decision)
    return
  }
  emit({})
}

const invoked = process.argv[1]
if (invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  void main(process.argv[2] ?? '').catch(() => {
    emit(process.argv[2] === 'PreToolUse' ? { decision: 'deny', reason: 'DSH supervision hook failed' } : { decision: '' })
  })
}
