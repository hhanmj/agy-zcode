/**
 * Runtime configuration for the ZCode MCP server. ZCode passes plugin
 * userConfig values through the .mcp.json "env" block (an unset value arrives
 * as an empty string), and injects ZCODE_PLUGIN_DATA / ZCODE_PROJECT_DIR.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface RunnerConfig {
  /** Executable name or absolute path of agy. */
  command: string
  /** Arguments inserted right after the executable (e.g. a script run by node); tests use it. */
  commandPrefixArgs: string[]
  /** Default --model / --effort (empty: agy's own default). */
  model: string
  effort: string
  /** Explicit proxy URL for agy (empty: AGY_PROXY env, then agy-proxy.txt files). */
  proxy: string
  /** Foreground ceiling; capped so one MCP call stays under the server timeout. */
  printTimeoutMs: number
  backgroundTimeoutMs: number
  watchdogMarginMs: number
  skipPermissions: boolean
  sandbox: boolean
  avoidBrowser: boolean
  avoidLargeReads: boolean
  autoLoginWindow: boolean
  loginWindowMinimized: boolean
  traceEnabled: boolean
  /** Extra --add-dir directories for every run. */
  addDirs: string[]
  /** Plugin-owned state: task registry, evidence, traces. */
  dataDir: string
  /** Workspace fallback when a call carries neither cwd nor workspace metadata. */
  projectDir: string
  graceMs: number
  /** Task registry file name inside dataDir (the gateway uses its own). */
  registryName: string
  /** Opt-in per-run agy hook supervision (needs skipPermissions; fails closed). */
  supervisionEnabled: boolean
  supervisionBuiltinRules: boolean
  supervisionDenyCommands: string[]
  supervisionStopCheck: string
  supervisionStopCheckTimeoutMs: number
  supervisionMaxReworks: number
  /** Parent of the per-run supervisor directories (outside any workspace). */
  supervisionDir: string
  /** Explicit path of the compiled supervisor hook (default: supervisor-hook.mjs next to the bundle). */
  supervisorHookPath: string
  /** Opt-in: one long-lived stream-json agy process per task, reused by follow-ups. */
  persistentSessions: boolean
  /** Close an idle persistent process after this many ms (0 = keep until shutdown). */
  persistentIdleMs: number
}

export const DEFAULT_REGISTRY_NAME = 'tasks.json'
export const GATEWAY_REGISTRY_NAME = 'gateway-tasks.json'

function registryName(name: string): string {
  const raw = text(name)
  return /^[\w.-]+\.json$/.test(raw) ? raw : DEFAULT_REGISTRY_NAME
}

/** Foreground runs must finish inside one MCP call; the plugin's .mcp.json timeout is 15 min. */
export const MAX_FOREGROUND_MS = 13 * 60 * 1000

function text(name: string): string {
  const value = process.env[name]
  if (value === undefined) return ''
  const trimmed = value.trim()
  // An unresolved placeholder means ZCode had no value for it.
  return /^\$\{[^}]*\}$/.test(trimmed) ? '' : trimmed
}

function bool(name: string, fallback: boolean): boolean {
  const value = text(name).toLowerCase()
  if (value === 'true' || value === '1' || value === 'yes') return true
  if (value === 'false' || value === '0' || value === 'no') return false
  return fallback
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = text(name)
  if (raw.length === 0) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

function list(name: string): string[] {
  const raw = text(name)
  if (raw.length === 0) return []
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    } catch {
      // fall through to delimiter parsing
    }
  }
  return raw.split(/[;\n]/).map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

export function loadConfig(): RunnerConfig {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  const dataDir = text('AGY_MCP_DATA_DIR') || text('ZCODE_PLUGIN_DATA') || join(home, '.zcode', 'agy-delegate')
  return {
    command: text('AGY_MCP_COMMAND') || 'agy',
    commandPrefixArgs: list('AGY_MCP_COMMAND_PREFIX_ARGS'),
    model: text('AGY_MCP_MODEL'),
    effort: text('AGY_MCP_EFFORT').toLowerCase(),
    proxy: text('AGY_MCP_PROXY'),
    printTimeoutMs: int('AGY_MCP_PRINT_TIMEOUT_MS', 5 * 60 * 1000, 10_000, MAX_FOREGROUND_MS),
    backgroundTimeoutMs: int('AGY_MCP_BACKGROUND_TIMEOUT_MS', 60 * 60 * 1000, 10_000, 6 * 60 * 60 * 1000),
    watchdogMarginMs: int('AGY_MCP_WATCHDOG_MARGIN_MS', 60_000, 5_000, 600_000),
    skipPermissions: bool('AGY_MCP_SKIP_PERMISSIONS', true),
    sandbox: bool('AGY_MCP_SANDBOX', false),
    avoidBrowser: bool('AGY_MCP_AVOID_BROWSER', true),
    avoidLargeReads: bool('AGY_MCP_AVOID_LARGE_READS', true),
    autoLoginWindow: bool('AGY_MCP_AUTO_LOGIN_WINDOW', true),
    loginWindowMinimized: bool('AGY_MCP_LOGIN_WINDOW_MINIMIZED', true),
    traceEnabled: bool('AGY_MCP_TRACE', true),
    addDirs: list('AGY_MCP_ADD_DIRS'),
    dataDir,
    projectDir: text('AGY_MCP_PROJECT_DIR') || text('ZCODE_PROJECT_DIR') || process.cwd(),
    graceMs: int('AGY_MCP_GRACE_MS', 5_000, 100, 120_000),
    registryName: registryName('AGY_MCP_REGISTRY_NAME'),
    supervisionEnabled: bool('AGY_MCP_SUPERVISION', false),
    supervisionBuiltinRules: bool('AGY_MCP_SUPERVISION_BUILTIN_RULES', true),
    supervisionDenyCommands: list('AGY_MCP_SUPERVISION_DENY_COMMANDS'),
    supervisionStopCheck: text('AGY_MCP_SUPERVISION_STOP_CHECK'),
    supervisionStopCheckTimeoutMs: int('AGY_MCP_SUPERVISION_STOP_CHECK_TIMEOUT_MS', 120_000, 1_000, 600_000),
    supervisionMaxReworks: int('AGY_MCP_SUPERVISION_MAX_REWORKS', 2, 0, 10),
    supervisionDir: text('AGY_MCP_SUPERVISION_DIR') || join(dataDir, 'agy-supervisor'),
    supervisorHookPath: text('AGY_MCP_SUPERVISOR_HOOK'),
    persistentSessions: bool('AGY_MCP_PERSISTENT', false),
    persistentIdleMs: int('AGY_MCP_PERSISTENT_IDLE_MS', 600_000, 0, 24 * 3_600_000),
  }
}
