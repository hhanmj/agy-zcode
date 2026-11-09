/**
 * ZCode plugin MCP server (stdio): delegate tasks to Google Antigravity CLI
 * (agy) from ZCode. Tools: agy_run, agy_followup, agy_status, agy_tasks,
 * agy_cancel, agy_evidence, agy_trace, agy_models, agy_login.
 * stdout carries the MCP protocol only; diagnostics go to stderr.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import { existsSync, readFileSync, watch as watchFile, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { readEvidence } from '../shared/evidence.js'
import { defaultEffortFor } from '../shared/models.js'
import { renderTraceRecord, summarizeTrace, type TraceRecord, type TraceSummary } from '../shared/trace.js'
import { loadConfig, MAX_FOREGROUND_MS } from './config.js'
import { ensureGatewayRunning } from './gateway.js'
import { AgyRunner, validateWorkspace, type AgyRun, type RunMarker } from './runner.js'

const PANEL_URI = 'ui://agy-delegate/panel.html'
const PANEL_HTML = existsSync(join(import.meta.dirname, 'panel.html'))
  ? readFileSync(join(import.meta.dirname, 'panel.html'), 'utf8')
  : '<!doctype html><title>agy panel</title><p>panel.html was not bundled with this build.</p>'

declare const __AGY_MCP_VERSION__: string
const VERSION = typeof __AGY_MCP_VERSION__ === 'string' ? __AGY_MCP_VERSION__ : '0.0.0-dev'

const MAX_WAIT_SECONDS = 300
const HEARTBEAT_MS = 20_000
const MAX_RESPONSE_CHARS = 60_000

const config = loadConfig()
const log = (message: string): void => {
  process.stderr.write('[agy-mcp] ' + message + '\n')
}
const runner = new AgyRunner(config, log)

/** ZCode's session panel: agy_tasks carries the resource link; the rest is page-only. */
const panelMeta = {
  ui: { resourceUri: PANEL_URI },
}
const appOnly = { visibility: ['app'] as string[] }

// ── Formatting helpers ─────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return seconds + 's'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + 'm' + String(seconds % 60).padStart(2, '0') + 's'
  return Math.floor(minutes / 60) + 'h' + String(minutes % 60).padStart(2, '0') + 'm'
}

function formatMs(ms: number): string {
  if (ms % 3_600_000 === 0) return ms / 3_600_000 + ' h'
  if (ms % 60_000 === 0) return ms / 60_000 + ' min'
  return Math.round(ms / 1000) + ' s'
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return '[… ' + (text.length - max) + ' earlier chars omitted …]\n' + text.slice(text.length - max)
}

function elapsed(run: AgyRun): string {
  return formatDuration((run.finishedAt ?? Date.now()) - run.startedAt)
}

function statusLine(run: AgyRun): string {
  const parts = ['status: ' + run.status, 'elapsed: ' + elapsed(run), 'agy tools: ' + run.toolCalls + (run.toolErrors > 0 ? ' (' + run.toolErrors + ' failed)' : '')]
  if (run.status === 'running') parts.push('now: ' + run.lastActivity)
  if (run.exit !== undefined && run.status !== 'running') parts.push('exit: ' + String(run.exit.exitCode ?? run.exit.signal ?? 'n/a'))
  if (run.selection.model !== undefined) parts.push('model: ' + run.selection.model + (run.selection.effort !== undefined ? '/' + run.selection.effort : ''))
  return parts.join(' | ')
}

function evidenceLine(run: AgyRun): string {
  const evidence = run.evidence
  if (evidence === undefined) return '[evidence: not collected]'
  const d = evidence.diff_summary
  const lines = d.added_lines !== null ? ', +' + d.added_lines + '/-' + d.deleted_lines + ' lines (git, cumulative)' : ''
  return '[evidence: ' + d.changed_files_total + ' file(s) changed (added ' + d.added_files + ', modified ' + d.modified_files + ', deleted ' + d.deleted_files + ')' + lines +
    '; complete=' + String(evidence.evidence_complete) + '; review=pending — verify the diff, build and tests yourself; details: agy_evidence { task: "' + run.task + '" }]'
}

function finishedText(run: AgyRun): string {
  const out: string[] = []
  if (run.status === 'completed') {
    out.push(clip(run.response ?? '', MAX_RESPONSE_CHARS))
  } else {
    out.push('agy run ' + run.status + ': ' + (run.error ?? 'no detail'))
    if (run.response !== undefined && run.response.trim().length > 0) out.push('Partial output before the run ended:\n' + clip(run.response, 20_000))
  }
  out.push('')
  out.push('[task: ' + run.task + ' — continue this conversation with agy_followup { task: "' + run.task + '" }]')
  out.push('[' + statusLine(run) + ']')
  out.push(evidenceLine(run))
  if (runner.traces !== undefined) out.push('[trace: agy_trace { id: "' + run.task + '" }]')
  return out.join('\n')
}

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) }
}

// ── Tool argument helpers ──────────────────────────────────────────────────

type Args = Record<string, unknown>

function str(args: Args, key: string, required = false): string | undefined {
  const value = args[key]
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error('missing required argument "' + key + '"')
    return undefined
  }
  if (typeof value !== 'string') throw new Error('argument "' + key + '" must be a string')
  return value
}

function num(args: Args, key: string): number | undefined {
  const value = args[key]
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) throw new Error('argument "' + key + '" must be a number')
  return n
}

function strings(args: Args, key: string): string[] {
  const value = args[key]
  if (value === undefined || value === null) return []
  if (typeof value === 'string') return value.trim().length > 0 ? [value] : []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error('argument "' + key + '" must be an array of strings')
  return value as string[]
}

function bool(args: Args, key: string): boolean {
  const value = args[key]
  return value === true || value === 'true'
}

/** ZCode attaches the session workspace to every tool call as _meta.workspace_path. */
function workspaceOf(meta: Record<string, unknown> | undefined): string {
  const fromMeta = meta?.workspace_path
  return typeof fromMeta === 'string' && fromMeta.length > 0 ? fromMeta : config.projectDir
}

// ── Progress (keeps ZCode's per-call timeout alive while agy works) ───────

interface Extra {
  signal: AbortSignal
  _meta?: Record<string, unknown>
  sendNotification: (notification: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>
}

function progressReporter(extra: Extra): (message: string, force?: boolean) => void {
  const token = extra._meta?.progressToken
  if (typeof token !== 'string' && typeof token !== 'number') return () => {}
  let count = 0
  let last = 0
  return (message: string, force = false) => {
    const now = Date.now()
    if (!force && now - last < 1000) return
    last = now
    count += 1
    void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: count, message } }).catch(() => {})
  }
}

/** Wait for a run while reporting progress; resolves early when waitMs elapses or the call is cancelled. */
async function watch(run: AgyRun, extra: Extra, waitMs: number, cancelOnAbort: boolean): Promise<void> {
  const report = progressReporter(extra)
  const describe = (): string => 'agy ' + run.status + ' · ' + elapsed(run) + ' · ' + run.lastActivity + ' · tools ' + run.toolCalls
  const unsubscribe = run.subscribe(() => report(describe()))
  const heartbeat = setInterval(() => report(describe(), true), HEARTBEAT_MS)
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    await Promise.race([
      run.done,
      new Promise<void>((done) => {
        timer = setTimeout(done, waitMs)
      }),
      new Promise<void>((done) => {
        onAbort = () => {
          if (cancelOnAbort) run.cancel()
          done()
        }
        if (extra.signal.aborted) onAbort()
        else extra.signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
    if (extra.signal.aborted && cancelOnAbort) await run.done
  } finally {
    unsubscribe()
    clearInterval(heartbeat)
    clearTimeout(timer)
    if (onAbort !== undefined) extra.signal.removeEventListener('abort', onAbort)
  }
}

// ── Tools ──────────────────────────────────────────────────────────────────

const RUN_DESCRIPTION =
  'Delegate a self-contained coding task to Google Antigravity CLI (agy), a separate Gemini-powered coding agent on this machine that uses the user\'s Antigravity login (no API key). It works in the current ZCode workspace (or the absolute cwd you pass), edits files there itself, and returns its final answer plus a task key. It does NOT see this conversation: give it a complete, standalone prompt (goal, files, constraints, acceptance checks, what to report). ' +
  'Foreground calls wait up to ' + formatMs(config.printTimeoutMs) + '; for anything longer set background: true, then poll agy_status { task, wait_seconds } and keep the user informed until it reports a final status. ' +
  'Pass absolute dirs for targets outside the workspace (headless agy cannot ask for access and would hang). Its claims are not proof: check the reported evidence, the git diff and the tests yourself. Continue the same conversation with agy_followup.'

const TOOLS = [
  {
    name: 'agy_run',
    description: RUN_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short (3-6 word) label for the task, shown in task lists.' },
        prompt: { type: 'string', description: 'The complete, self-contained task for agy. Keep it under 30000 characters; put bulky context into workspace files and reference them.' },
        cwd: { type: 'string', description: 'Optional absolute working directory. Defaults to the current ZCode workspace. Evidence is collected here.' },
        dirs: { type: 'array', items: { type: 'string' }, description: 'Optional absolute directories OUTSIDE cwd that agy may access (--add-dir).' },
        model: { type: 'string', description: 'Optional agy model id (see agy_models). Follow-ups keep it.' },
        effort: { type: 'string', description: 'Optional effort: low | medium | high | xhigh | max (only for models with effort variants).' },
        background: { type: 'boolean', description: 'Run in the background (ceiling ' + formatMs(config.backgroundTimeoutMs) + '). Returns the task key immediately; poll agy_status.' },
      },
      required: ['description', 'prompt'],
    },
    annotations: { title: 'Delegate to agy', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'agy_followup',
    description: 'Send a follow-up prompt to an existing agy task: agy resumes the same conversation with its full prior context (same working directory and model unless overridden). Use the task key from agy_run / agy_tasks. Use it for rework after your own verification fails. Same foreground ceiling as agy_run; set background: true for long rework.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task key returned by agy_run (also listed by agy_tasks).' },
        prompt: { type: 'string', description: 'The follow-up instruction. agy remembers the earlier work; state only what is new or what failed.' },
        description: { type: 'string', description: 'Optional short label for this follow-up.' },
        dirs: { type: 'array', items: { type: 'string' }, description: 'Optional extra absolute directories (--add-dir).' },
        model: { type: 'string', description: 'Optional model override.' },
        effort: { type: 'string', description: 'Optional effort override.' },
        background: { type: 'boolean', description: 'Run in the background and poll agy_status.' },
      },
      required: ['task', 'prompt'],
    },
    annotations: { title: 'Follow up an agy task', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'agy_status',
    description: 'Status and live progress of an agy task (by task key or run id): streamed answer text and [agy: tool ...] step markers since offset, then the final answer, evidence summary and task key once it finishes. wait_seconds blocks until the run finishes or the wait elapses (max ' + MAX_WAIT_SECONDS + '). Pass the returned next_offset as offset on the next poll.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task key or run id.' },
        offset: { type: 'number', description: 'Return progress after this offset (default 0). Use next_offset from the previous call.' },
        wait_seconds: { type: 'number', description: 'Block up to this many seconds for the run to finish (0-' + MAX_WAIT_SECONDS + ', default 0).' },
        max_chars: { type: 'number', description: 'Maximum progress characters to return (default 6000, max 30000).' },
      },
      required: ['task'],
    },
    annotations: { title: 'agy task status', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'agy_tasks',
    description: 'List agy tasks: runs in progress, runs finished since the plugin started, and recorded task keys (these survive restarts and can be resumed with agy_followup). Also the entry point of the interactive task panel.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many recorded tasks to list, newest first (default 20, max 100).' } },
    },
    annotations: { title: 'List agy tasks', readOnlyHint: true, openWorldHint: false },
    _meta: { ...panelMeta },
  },
  {
    name: 'agy_cancel',
    description: 'Stop a running agy task (task key or run id). The agy process tree is terminated; the run settles as cancelled and its conversation stays resumable with agy_followup.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'Task key or run id of a running task.' } },
      required: ['task'],
    },
    annotations: { title: 'Cancel an agy task', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'agy_evidence',
    description: 'Independently collected file-change evidence for the latest finished run of an agy task (local workspace snapshot before vs after, never agy\'s self-report): changed files, git line counts, warnings. review_status is always pending: run the build/tests and inspect behavior yourself before accepting the work.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'Task key (or run id).' } },
      required: ['task'],
    },
    annotations: { title: 'agy change evidence', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'agy_trace',
    description: 'Durable execution trace of an agy task, live or finished: agy\'s own steps, agy-internal tool calls (redacted parameters, output previews, errors), the final result, cancellation/timeout and linked evidence. These are agy\'s records, not ZCode tool calls. Page with cursor = previous next_cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task key.' },
        cursor: { type: 'number', description: 'Return records with seq greater than this (default 0).' },
        limit: { type: 'number', description: 'Maximum records (default 40, max 200).' },
      },
      required: ['id'],
    },
    annotations: { title: 'agy execution trace', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'agy_models',
    description: 'List the models this machine\'s agy can use (straight from "agy models"; no agent turn, no quota). Pass a base id as model and one of its efforts as effort.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'agy models', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'agy_login',
    description: 'Open the interactive Antigravity (agy) login window on this machine so the user can sign in. Use it when a run failed with "authentication required" and no window opened automatically; then ask the user to finish the sign-in. To keep the login as a library account afterwards, call agy_accounts { action: "capture" }.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'agy login', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'agy_accounts',
    description:
      'Antigravity account library and quota-driven rotation. agy holds ONE login in ~/.gemini; this tool archives per-account snapshots so several logins can be kept. ' +
      'Actions: list (accounts, active, rotation settings), capture (archive the CURRENT agy login after a sign-in; same email refreshes its tokens), ' +
      'switch { id } (make a stored account the live agy login), remove { id }, config { enabled, strategy, cooldown_ms, exhausted_ms, toggle_account } (rotation policy; off by default). ' +
      'A running agy process can never be migrated: rotation picks the account for the NEXT run. When a run fails on quota the active account is parked for one window and the next eligible account is activated; resume the failed conversation with agy_followup.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'capture', 'switch', 'remove', 'config'], description: 'Default: list.' },
        id: { type: 'string', description: 'Account id (switch/remove/toggle_account).' },
        label: { type: 'string', description: 'Optional display name for capture.' },
        enabled: { type: 'boolean', description: 'config: turn automatic rotation on/off.' },
        strategy: { type: 'string', enum: ['priority', 'round-robin'], description: 'config: candidate selection order.' },
        cooldown_ms: { type: 'number', description: 'config: minimum gap between switches (default 120000).' },
        exhausted_ms: { type: 'number', description: 'config: how long an exhausted account is skipped (default 5h).' },
        toggle_account: { type: 'string', description: 'config: account id to enable/disable as a rotation candidate.' },
      },
    },
    annotations: { title: 'agy account library', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  // ── Page-only tools: the panel calls these directly, the model never sees them.
  {
    name: 'agy_panel_data',
    description: 'Panel-only: structured task, account and gateway state.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Panel data', readOnlyHint: true },
    _meta: appOnly,
  },
  {
    name: 'agy_panel_task',
    description: 'Panel-only: full detail of one task (progress text, evidence, trace summary).',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string' }, offset: { type: 'number' }, max_chars: { type: 'number' } },
      required: ['task'],
    },
    annotations: { title: 'Panel task detail', readOnlyHint: true },
    _meta: appOnly,
  },
  {
    name: 'agy_panel_action',
    description: 'Panel-only: start, follow up or cancel a task from the panel.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'followup', 'cancel'] },
        task: { type: 'string' },
        description: { type: 'string' },
        prompt: { type: 'string' },
        background: { type: 'boolean' },
      },
      required: ['action'],
    },
    annotations: { title: 'Panel task action' },
    _meta: appOnly,
  },
  {
    name: 'agy_panel_account',
    description: 'Panel-only: capture / switch / remove / configure accounts (same store as agy_accounts).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['capture', 'switch', 'remove', 'config'] },
        id: { type: 'string' },
        label: { type: 'string' },
        enabled: { type: 'boolean' },
        strategy: { type: 'string' },
        toggle_account: { type: 'string' },
      },
      required: ['action'],
    },
    annotations: { title: 'Panel account action' },
    _meta: appOnly,
  },
]

async function startRun(args: Args, extra: Extra, followup: boolean): Promise<CallToolResult> {
  const background = bool(args, 'background')
  const prompt = str(args, 'prompt', true) as string
  const options = {
    label: str(args, 'description') ?? '',
    prompt,
    cwd: followup ? '' : validateWorkspace(str(args, 'cwd') ?? workspaceOf(extra._meta)),
    dirs: strings(args, 'dirs'),
    background,
    ...(str(args, 'model') !== undefined ? { model: str(args, 'model') } : {}),
    ...(str(args, 'effort') !== undefined ? { effort: str(args, 'effort') } : {}),
    ...(followup ? { task: str(args, 'task', true) as string } : {}),
  }
  const run = await runner.start(options)
  if (background) {
    return text([
      'Started background agy ' + (followup ? 'follow-up' : 'task') + ': task ' + run.task + (run.runId !== run.task ? ' (run ' + run.runId + ')' : '') + ' in ' + run.cwd + '.',
      'Poll progress with agy_status { task: "' + run.task + '", wait_seconds: 60 } and pass next_offset back as offset; stop it with agy_cancel.',
      'Keep the user informed while it runs and do not report it as finished until agy_status shows a final status.',
    ].join('\n'))
  }
  await watch(run, extra, MAX_FOREGROUND_MS + config.watchdogMarginMs + 30_000, true)
  if (run.status === 'running') return text('agy run ' + run.runId + ' is still running; poll agy_status { task: "' + run.task + '" }.')
  return text(finishedText(run), run.status !== 'completed')
}

async function status(args: Args, extra: Extra): Promise<CallToolResult> {
  const id = str(args, 'task', true) as string
  const run = runner.get(id)
  if (run === undefined) {
    const lost = runner.lostRunsFor(id)
    if (lost.length > 0) {
      const marker = lost[0]
      const lines = [
        'Task ' + id + ' (run ' + marker.runId + ', "' + marker.label + '") was started ' + stamp(marker.startedAt) + ' in ' + marker.cwd + ', but the MCP server process restarted while it ran, so the run was LOST: in-flight agy processes do not survive a server restart.',
        'Treat the run\'s work as incomplete: check the workspace yourself (git diff, build, tests), then either resume the conversation with agy_followup or start a corrective run.',
      ]
      const lostRecord = runner.loadRegistry()[id]
      if (lostRecord !== undefined) lines.push('Last recorded conversation for this task: ' + lostRecord.conversationId + ' (from ' + stamp(lostRecord.createdAt) + ').')
      return text(lines.join('\n'), true)
    }
    const foreign = runner.foreignRunsFor(id)
    if (foreign.length > 0) {
      const marker = foreign[0]
      return text('Task ' + id + ' (run ' + marker.runId + ', "' + marker.label + '") is currently running in another ZCode session (started ' + stamp(marker.startedAt) + ' in ' + marker.cwd + '). Each session runs its own agy server instance, so its live progress is only visible there.')
    }
    const record = runner.loadRegistry()[id]
    if (record !== undefined) {
      return text('Task ' + id + ' is not running in this ZCode session (last activity ' + stamp(record.createdAt) + ', cwd ' + record.cwd + '). Its conversation can be resumed with agy_followup; its latest evidence is available via agy_evidence.')
    }
    throw new Error('no agy task or run "' + id + '" (see agy_tasks)')
  }
  const waitSeconds = Math.max(0, Math.min(MAX_WAIT_SECONDS, num(args, 'wait_seconds') ?? 0))
  if (run.status === 'running' && waitSeconds > 0) await watch(run, extra, waitSeconds * 1000, false)
  const maxChars = Math.max(500, Math.min(30_000, num(args, 'max_chars') ?? 6000))
  const offset = Math.max(0, num(args, 'offset') ?? 0)
  const header = 'task ' + run.task + (run.runId !== run.task ? ' (run ' + run.runId + ')' : '') + ' | ' + statusLine(run) + '\nlabel: ' + run.label + ' | cwd: ' + run.cwd + ' | ' + (run.background ? 'background' : 'foreground') + ' | started ' + stamp(run.startedAt)
  if (run.status !== 'running') return text(header + '\n\n' + finishedText(run), run.status !== 'completed')
  const page = run.read(offset, maxChars)
  return text(header + '\n--- progress' + (page.skipped ? ' (older text skipped)' : '') + ', next_offset: ' + page.next + ' ---\n' + (page.text.length > 0 ? page.text : '(no new output yet)'))
}

function tasks(args: Args): CallToolResult {
  const limit = Math.max(0, Math.min(100, Math.floor(num(args, 'limit') ?? 20)))
  const lines: string[] = []
  const active = runner.activeRuns()
  lines.push(active.length === 0 ? 'Running: none' : 'Running (' + active.length + '):')
  for (const run of active) lines.push('  task ' + run.task + (run.runId !== run.task ? ' run ' + run.runId : '') + ' | ' + run.label + ' | ' + (run.background ? 'background' : 'foreground') + ' | ' + elapsed(run) + ' | ' + run.lastActivity)
  const scan = runner.scanRunMarkers()
  const markerRows = (title: string, markers: RunMarker[]): void => {
    const seen = new Set<string>()
    const rows = markers.filter((marker) => (seen.has(marker.task) ? false : (seen.add(marker.task), true)))
    if (rows.length === 0) return
    lines.push(title.replace('{n}', String(rows.length)))
    for (const marker of rows) lines.push('  task ' + marker.task + (marker.runId !== marker.task ? ' run ' + marker.runId : '') + ' | ' + marker.label + ' | started ' + stamp(marker.startedAt) + ' | ' + marker.cwd)
  }
  markerRows('Running in other ZCode session(s) ({n} task(s)):', scan.foreign)
  markerRows('Lost to MCP server restart ({n} task(s), work incomplete — details: agy_status):', scan.lost)
  const finished = runner.finishedRuns().slice(0, 20)
  if (finished.length > 0) {
    lines.push('Finished in this session (' + finished.length + '):')
    for (const run of finished) lines.push('  task ' + run.task + (run.runId !== run.task ? ' run ' + run.runId : '') + ' | ' + run.label + ' | ' + run.status + ' | ' + elapsed(run) + ' | ' + stamp(run.finishedAt ?? run.startedAt))
  }
  const records = Object.entries(runner.loadRegistry()).sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, limit)
  lines.push(records.length === 0 ? 'Recorded tasks: none' : 'Recorded tasks (resumable with agy_followup, newest first):')
  for (const [task, record] of records) lines.push('  task ' + task + ' | ' + record.label + ' | ' + stamp(record.createdAt) + ' | ' + record.cwd + (record.model !== undefined ? ' | ' + record.model + (record.effort !== undefined ? '/' + record.effort : '') : ''))
  return text(lines.join('\n'))
}

function renderTrace(id: string, summary: TraceSummary, events: TraceRecord[], nextCursor: number, hasMore: boolean): string {
  const lines: string[] = []
  const life = summary.lifecycle
  lines.push('agy trace ' + id + ' — agy-cli stream-json records (agy-internal, not ZCode tool calls; hidden reasoning is not exposed)')
  lines.push('lifecycle: started=' + (life.started ? 'yes' : 'no') + ' execution=' + life.execution + ' evidence=' + life.evidence + ' review=pending (verify yourself)')
  const run = summary.current_run
  if (run !== null) {
    const parts = ['runs=' + summary.runs, 'current run ' + String(run.run), 'mode=' + String(run.mode), 'transport=' + String(run.transport)]
    if (run.conversation_id) parts.push('conversation=' + String(run.conversation_id))
    parts.push('steps=' + String(run.steps), 'tool_calls=' + String(run.tool_calls), 'tool_errors=' + String(run.tool_errors))
    if (run.result_status) parts.push('result=' + String(run.result_status))
    lines.push(parts.join(' '))
    const running = run.running_tool as { step?: unknown; tool?: unknown } | null
    if (running) lines.push('running now: ' + String(running.tool) + ' (step ' + String(running.step) + ')')
  }
  const used = Object.entries(summary.tools_used)
  if (used.length > 0) lines.push('agy tools: ' + used.map(([name, count]) => name + '×' + count.calls + (count.errors > 0 ? ' (' + count.errors + ' error)' : '')).join(', '))
  if (summary.truncated) lines.push('note: trace reached its cap; later step records were dropped (lifecycle records kept)')
  lines.push('records (' + events.length + ' of ' + summary.total_events + '):')
  for (const record of events) lines.push('  ' + renderTraceRecord(record))
  lines.push('next_cursor: ' + nextCursor + '  has_more: ' + (hasMore ? 'true' : 'false'))
  return lines.join('\n')
}

function trace(args: Args): CallToolResult {
  if (runner.traces === undefined) throw new Error('tracing is disabled (AGY_MCP_TRACE=false)')
  const raw = str(args, 'id', true) as string
  const id = runner.get(raw)?.task ?? raw
  const all = runner.traces.readAll(id)
  if (all === undefined) throw new Error('no trace "' + id + '" (traces exist for runs started by this plugin with tracing on)')
  const cursor = Math.max(0, Math.floor(num(args, 'cursor') ?? 0))
  const limit = Math.max(1, Math.min(200, Math.floor(num(args, 'limit') ?? 40)))
  const after = all.records.filter((record) => record.seq > cursor)
  const events = after.slice(0, limit)
  const summary = summarizeTrace(all.meta, all.records, runner.activeRunIdsFor(id))
  return text(renderTrace(id, summary, events, events.at(-1)?.seq ?? cursor, after.length > events.length))
}

async function models(): Promise<CallToolResult> {
  let listed
  try {
    listed = await runner.models.list()
  } catch (error) {
    throw new Error('could not list agy models: ' + (error instanceof Error ? error.message : String(error)) + '. You can still pass a model id from "agy models" directly; agy rejects unknown ids.')
  }
  const lines = ['agy models (from "agy models"); omit model to use the CLI default' + (config.model.length > 0 ? ' (plugin default: ' + config.model + (config.effort.length > 0 ? '/' + config.effort : '') + ')' : '') + ':']
  for (const model of listed) {
    lines.push('- ' + model.id + ' — ' + model.name + '; ' + (model.efforts.length > 0 ? 'efforts: ' + model.efforts.join(' | ') + ' (default ' + (defaultEffortFor(model) ?? '-') + ')' : 'no effort variants') + '; CLI ids: ' + model.variants.join(', '))
  }
  return text(lines.join('\n'))
}

async function handle(name: string, args: Args, extra: Extra): Promise<CallToolResult> {
  switch (name) {
    case 'agy_run':
      return startRun(args, extra, false)
    case 'agy_followup':
      return startRun(args, extra, true)
    case 'agy_status':
      return status(args, extra)
    case 'agy_tasks':
      return tasks(args)
    case 'agy_cancel': {
      const id = str(args, 'task', true) as string
      const run = runner.cancel(id)
      if (run === undefined) {
        if (runner.lostRunsFor(id).length > 0) throw new Error('task "' + id + '" has no live run in this session — its last run was lost to an MCP server restart (details: agy_status { task: "' + id + '" })')
        if (runner.foreignRunsFor(id).length > 0) throw new Error('task "' + id + '" is running in another ZCode session; cancel it there')
        throw new Error('no running agy task "' + id + '" (finished tasks cannot be cancelled; see agy_tasks)')
      }
      await Promise.race([run.done, new Promise((done) => setTimeout(done, config.graceMs + 2000))])
      return text('Cancellation requested for task ' + run.task + ' (run ' + run.runId + '); status now: ' + run.status + '. Its conversation stays resumable with agy_followup.')
    }
    case 'agy_evidence': {
      const raw = str(args, 'task', true) as string
      const task = runner.get(raw)?.task ?? raw
      const evidence = readEvidence(task, runner.evidenceDir)
      if (evidence === undefined) throw new Error('no evidence for task "' + task + '" yet (it may still be running)')
      return text(JSON.stringify(evidence, null, 2))
    }
    case 'agy_trace':
      return trace(args)
    case 'agy_models':
      return models()
    case 'agy_accounts':
      return accountsTool(args)
    case 'agy_panel_data':
      return panelData()
    case 'agy_panel_task':
      return panelTask(args)
    case 'agy_panel_action':
      return panelAction(args, extra)
    case 'agy_panel_account':
      return accountsTool(args)
    case 'agy_login':
      return text(await runner.launchLogin())
    default:
      throw new Error('unknown tool "' + name + '"')
  }
}

// ── Account tools and panel data ───────────────────────────────────────────

async function accountsTool(args: Args): Promise<CallToolResult> {
  const store = runner.accounts
  const action = str(args, 'action') ?? 'list'
  switch (action) {
    case 'list': {
      const state = await store.list()
      const lines = ['agy account library (' + state.geminiDir + '):']
      lines.push('live agy login: ' + (state.currentEmail ?? '(unknown)') + ' | rotation: ' + (state.rotation.enabled ? state.rotation.strategy : 'off'))
      if (state.accounts.length === 0) lines.push('No accounts stored. Sign in with agy_login, then capture the login with agy_accounts { action: "capture" }.')
      for (const a of state.accounts) {
        const marks = [a.id === state.activeId ? 'active' : '', a.disabled ? 'disabled' : '',
          a.exhaustedUntil !== undefined && a.exhaustedUntil > Date.now() ? 'exhausted until ' + stamp(a.exhaustedUntil) : ''].filter(Boolean).join(', ')
        lines.push('- ' + a.id + ' | ' + a.email + (a.label.length > 0 ? ' (' + a.label + ')' : '') + ' | priority ' + a.priority + (marks.length > 0 ? ' | ' + marks : ''))
      }
      const pending = store.pendingSwitch()
      if (pending !== undefined) lines.push('WARNING: an interrupted switch to ' + pending.targetId + ' was journalled at ' + stamp(pending.startedAt) + '; verify the live login before enabling rotation.')
      lines.push('Rotation changes only which account the NEXT run uses; a running agy process is never migrated. After a quota failure, resume with agy_followup.')
      return text(lines.join('\n'))
    }
    case 'capture': {
      const entry = await store.captureCurrent(str(args, 'label') ?? '')
      return text('Captured current agy login as account ' + entry.id + ' (' + entry.email + '). It is now the active library account. Enable rotation with agy_accounts { action: "config", enabled: true } once at least two accounts are stored.')
    }
    case 'switch': {
      const entry = await store.switchTo(str(args, 'id', true) as string)
      return text('Live agy login switched to ' + entry.email + ' (account ' + entry.id + '). Already-running tasks keep their old process; new runs and follow-ups use this account.')
    }
    case 'remove': {
      await store.remove(str(args, 'id', true) as string)
      return text('Account removed from the library. The live agy login files were not touched.')
    }
    case 'config': {
      const rotation = await store.configure({
        ...(args.enabled !== undefined ? { enabled: bool(args, 'enabled') } : {}),
        ...(str(args, 'strategy') !== undefined ? { strategy: str(args, 'strategy') as 'priority' | 'round-robin' } : {}),
        ...(num(args, 'cooldown_ms') !== undefined ? { cooldownMs: num(args, 'cooldown_ms') } : {}),
        ...(num(args, 'exhausted_ms') !== undefined ? { exhaustedMs: num(args, 'exhausted_ms') } : {}),
        ...(str(args, 'toggle_account') !== undefined ? { disabled: str(args, 'toggle_account') } : {}),
      })
      return text('Rotation: ' + (rotation.enabled ? 'enabled (' + rotation.strategy + ', cooldown ' + Math.round(rotation.cooldownMs / 1000) + 's, exhausted window ' + Math.round(rotation.exhaustedMs / 60000) + 'min)' : 'disabled') + '.')
    }
    default:
      throw new Error('unknown agy_accounts action "' + action + '"')
  }
}

function runView(run: AgyRun): Record<string, unknown> {
  return {
    task: run.task,
    runId: run.runId,
    label: run.label,
    cwd: run.cwd,
    status: run.status,
    background: run.background,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    lastActivity: run.lastActivity,
    toolCalls: run.toolCalls,
    toolErrors: run.toolErrors,
    model: run.selection.model,
    effort: run.selection.effort,
    conversationId: run.conversationId,
    error: run.error,
    response: run.status === 'running' ? undefined : run.response,
    evidence: run.evidence === undefined ? undefined : {
      complete: run.evidence.evidence_complete,
      diff: run.evidence.diff_summary,
      warnings: run.evidence.warnings,
    },
  }
}

async function panelData(): Promise<CallToolResult> {
  const accounts = await runner.accounts.list()
  return text(JSON.stringify({
    version: VERSION,
    workspace: config.projectDir,
    runs: [...runner.activeRuns(), ...runner.finishedRuns().slice(0, 30)].map(runView),
    markers: runner.scanRunMarkers(),
    recorded: Object.entries(runner.loadRegistry()).sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, 50)
      .map(([task, record]) => ({ task, ...record })),
    accounts,
    pendingSwitch: runner.accounts.pendingSwitch(),
    defaults: { model: config.model, effort: config.effort, printTimeoutMs: config.printTimeoutMs },
  }))
}

async function panelTask(args: Args): Promise<CallToolResult> {
  const id = str(args, 'task', true) as string
  const run = runner.get(id)
  const task = run?.task ?? id
  const result: Record<string, unknown> = { task, run: run === undefined ? undefined : runView(run) }
  if (run !== undefined && run.status === 'running') {
    const page = run.read(Math.max(0, num(args, 'offset') ?? 0), Math.max(500, Math.min(30_000, num(args, 'max_chars') ?? 12_000)))
    result.progress = page
  }
  const evidence = readEvidence(task, runner.evidenceDir)
  if (evidence !== undefined) result.evidence = evidence
  if (runner.traces !== undefined) {
    const all = runner.traces.readAll(task)
    if (all !== undefined) {
      result.trace = {
        summary: summarizeTrace(all.meta, all.records, runner.activeRunIdsFor(task)),
        records: all.records.slice(-60),
      }
    }
  }
  if (run === undefined && evidence === undefined && result.trace === undefined) {
    result.recorded = runner.loadRegistry()[task]
  }
  return text(JSON.stringify(result))
}

async function panelAction(args: Args, extra: Extra): Promise<CallToolResult> {
  const action = str(args, 'action', true) as string
  if (action === 'cancel') {
    const run = runner.cancel(str(args, 'task', true) as string)
    if (run === undefined) throw new Error('no running task "' + String(args.task) + '" in this session')
    return text(JSON.stringify({ ok: true, status: run.status }))
  }
  const prompt = str(args, 'prompt', true) as string
  const run = await runner.start({
    label: str(args, 'description') ?? 'panel task',
    prompt,
    cwd: action === 'run' ? validateWorkspace(workspaceOf(extra._meta)) : '',
    dirs: [],
    background: true,
    ...(action === 'followup' ? { task: str(args, 'task', true) as string } : {}),
  })
  return text(JSON.stringify({ ok: true, task: run.task, runId: run.runId }))
}

// ── Server wiring ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'agy-delegate', version: VERSION },
  {
    capabilities: { tools: {}, resources: { subscribe: true } },
    instructions: 'Tools for delegating coding work to Google Antigravity CLI (agy), a separate Gemini-based agent that edits files in the workspace. Give agy standalone prompts; prefer background: true plus agy_status polling for tasks over a few minutes; reuse the task key with agy_followup for rework; treat agy\'s report as a claim and verify the diff, build and tests yourself (agy_evidence helps). agy_accounts manages a library of Antigravity logins with quota-driven rotation; rotation only affects new runs, never a live process.',
  },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

// ── Panel resource + push channel ──────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{
    uri: PANEL_URI,
    name: 'agy task & account panel',
    mimeType: 'text/html;profile=mcp-app',
    description: 'Interactive agy task list, live progress, evidence, and the Antigravity account library with rotation settings.',
  }],
}))

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri !== PANEL_URI) throw new Error('unknown resource ' + request.params.uri)
  return { contents: [{ uri: PANEL_URI, mimeType: 'text/html;profile=mcp-app', text: PANEL_HTML }] }
})

let panelSubscribers = 0
const stateWatchers = new Map<string, FSWatcher>()
let notifyTimer: NodeJS.Timeout | undefined

function notifyPanel(): void {
  if (panelSubscribers === 0) return
  clearTimeout(notifyTimer)
  notifyTimer = setTimeout(() => {
    void server.notification({ method: 'notifications/resources/updated', params: { uri: PANEL_URI } }).catch(() => {})
  }, 300)
}

/** The panel's refresh signal: registry / account / active-run files changed on disk. */
function watchStateFile(file: string): void {
  if (stateWatchers.has(file) || !existsSync(file)) return
  try {
    const watcher = watchFile(file, { persistent: false }, () => notifyPanel())
    watcher.on('error', () => {})
    stateWatchers.set(file, watcher)
  } catch {
    // A file that cannot be watched just means the panel falls back to its own refresh.
  }
}

server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  if (request.params.uri !== PANEL_URI) throw new Error('unknown resource ' + request.params.uri)
  panelSubscribers += 1
  watchStateFile(runner.registryFile)
  watchStateFile(join(runner.accounts.dir, 'accounts.json'))
  if (existsSync(runner.activeRunDir)) {
    try {
      const watcher = watchFile(runner.activeRunDir, { persistent: false }, () => notifyPanel())
      watcher.on('error', () => {})
      stateWatchers.set(runner.activeRunDir, watcher)
    } catch { /* optional */ }
  }
  return {}
})

server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
  if (request.params.uri === PANEL_URI) panelSubscribers = Math.max(0, panelSubscribers - 1)
  return {}
})

// Live task updates also push to the panel (not only disk changes).
const originalRemember = runner.remember.bind(runner)
runner.remember = (run: AgyRun): void => {
  originalRemember(run)
  notifyPanel()
}

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const args = (request.params.arguments ?? {}) as Args
  const meta = request.params._meta as Record<string, unknown> | undefined
  const context: Extra = {
    signal: extra.signal,
    _meta: { ...(meta ?? {}), ...(extra._meta as Record<string, unknown> | undefined ?? {}) },
    sendNotification: (notification) => extra.sendNotification(notification),
  }
  try {
    return await handle(request.params.name, args, context)
  } catch (error) {
    return text('agy_mcp error: ' + (error instanceof Error ? error.message : String(error)), true)
  }
})

let shuttingDown = false
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  const count = await runner.terminateAll(config.graceMs + 3000)
  if (count > 0) log('stopped ' + count + ' running agy task(s) on shutdown (' + reason + ')')
  process.exit(0)
}

const transport = new StdioServerTransport()
transport.onclose = () => void shutdown('transport closed')
process.stdin.on('end', () => void shutdown('stdin closed'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
await server.connect(transport)
// Fire-and-forget: keep a detached Anthropic-compatible gateway alive so agy
// can also be registered as a ZCode custom model provider (native subagents).
void ensureGatewayRunning(config, log).catch((error) => log('[agy-gateway] autostart failed: ' + String(error)))
log('ready v' + VERSION + ' (data: ' + config.dataDir + ', workspace fallback: ' + config.projectDir + ')')
