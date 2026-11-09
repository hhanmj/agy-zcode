/**
 * Independent, local evidence for Antigravity delegations.
 * Never accepts file lists, test claims, or review verdicts from the child model.
 * Snapshots are scoped to the delegated working directory.
 */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_FILES = 20_000
const MAX_LISTED_CHANGES = 1_000
const MAX_HASH_BYTES = 4 * 1024 * 1024
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.venv', '__pycache__'])
type FileEntry = { bytes: number; mtimeMs: number; sha256: string | null }
export type ExecutionStatus = 'completed' | 'failed' | 'cancelled' | 'timeout'

/** DSH Jobs exposes killed/completed/failed; the evidence report keeps timeout and cancellation distinct. */
export function classifyBackgroundTermination(input: {
  timedOut: boolean
  cancelledByRequest: boolean
  signal: string | null
  finalStatus?: string
  exitCode: number | null
}): { jobStatus: 'killed' | 'completed' | 'failed'; evidenceStatus: ExecutionStatus } {
  if (input.timedOut) return { jobStatus: 'killed', evidenceStatus: 'timeout' }
  if (input.cancelledByRequest) return { jobStatus: 'killed', evidenceStatus: 'cancelled' }
  if (input.signal !== null) return { jobStatus: 'killed', evidenceStatus: 'failed' }
  if (input.finalStatus === 'SUCCESS' && input.exitCode === 0) {
    return { jobStatus: 'completed', evidenceStatus: 'completed' }
  }
  return { jobStatus: 'failed', evidenceStatus: 'failed' }
}

export interface WorkspaceSnapshot {
  workspace: string
  git: boolean
  baselineCommit: string | null
  baselineDirty: boolean
  files: Record<string, FileEntry>
  warnings: string[]
  complete: boolean
}
export interface TaskEvidence {
  task_id: string
  execution_status: ExecutionStatus
  review_status: 'pending'
  conversation_id: string | null
  workspace: string
  baseline_commit: string | null
  changed_files: Array<{ path: string; change: 'added' | 'modified' | 'deleted'; bytes_before: number | null; bytes_after: number | null }>
  diff_summary: {
    added_files: number
    modified_files: number
    deleted_files: number
    changed_files_total: number
    added_lines: number | null
    deleted_lines: number | null
    line_counts_source: string | null
    includes_preexisting_changes: boolean
  }
  test_results: Array<{ command: string; exit_code: number }>
  artifacts: string[]
  warnings: string[]
  error: string | null
  evidence_complete: boolean
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 8_000,
    maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function fingerprint(path: string, warnings: string[]): FileEntry | undefined {
  try {
    const st = lstatSync(path)
    if (!st.isFile()) return undefined // avoid following symlinks outside the project
    const sha256 = st.size <= MAX_HASH_BYTES
      ? createHash('sha256').update(readFileSync(path)).digest('hex')
      : null
    return { bytes: st.size, mtimeMs: st.mtimeMs, sha256 }
  } catch (e) {
    warnings.push(`Could not inspect file: ${path}: ${String(e)}`)
    return undefined
  }
}

function gitFilePaths(cwd: string): string[] {
  return git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--'])
    .split('\0').filter(Boolean)
}

function walk(cwd: string, root: string, paths: string[], warnings: string[]): void {
  if (paths.length >= MAX_FILES) return
  let entries: import('node:fs').Dirent<string>[]
  try {
    entries = readdirSync(cwd, { withFileTypes: true })
  } catch (e) {
    warnings.push(`Unable to scan directory: ${cwd}: ${String(e)}`)
    return
  }
  for (const entry of entries) {
    if (paths.length >= MAX_FILES) return
    if (entry.isSymbolicLink()) continue
    const path = join(cwd, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) walk(path, root, paths, warnings)
    } else if (entry.isFile()) {
      paths.push(relative(root, path))
    }
  }
}

export function captureWorkspace(workspace: string): WorkspaceSnapshot {
  const cwd = resolve(workspace)
  const warnings: string[] = []
  let isGit = false
  let baselineCommit: string | null = null
  let baselineDirty = false
  let paths: string[] = []
  try {
    // Git file listing includes untracked, nonignored files and honors cwd scope.
    baselineCommit = git(cwd, ['rev-parse', 'HEAD']).trim() || null
    paths = gitFilePaths(cwd)
    isGit = true
    baselineDirty = git(cwd, ['status', '--porcelain', '--untracked-files=normal', '--']).trim().length > 0
  } catch {
    // In non-Git workspaces, scan the tree (except dependency/internal caches).
    walk(cwd, cwd, paths, warnings)
    warnings.push('No usable Git repository: file-change counts use local snapshots; Git line statistics are unavailable.')
  }
  const truncated = paths.length >= MAX_FILES
  if (truncated) warnings.push(`Workspace scan reached its ${MAX_FILES}-file cap; evidence may be incomplete.`)
  const files: Record<string, FileEntry> = Object.create(null) as Record<string, FileEntry>
  let largeCount = 0
  for (const rawPath of paths.slice(0, MAX_FILES)) {
    // Never escape the working tree even if a malicious path is returned.
    const absolute = resolve(cwd, rawPath)
    if (!(absolute.startsWith(cwd + sep) || absolute === cwd) || isAbsolute(rawPath)) continue
    const stat = fingerprint(absolute, warnings)
    if (!stat) continue
    const normalized = rawPath.replace(/\\/g, '/')
    files[normalized] = stat
    if (stat.sha256 === null) largeCount++
  }
  if (largeCount) warnings.push(`${largeCount} files exceeded ${MAX_HASH_BYTES} bytes; those files use size and mtime as approximate fingerprints.`)
  return { workspace: cwd, git: isGit, baselineCommit, baselineDirty, files, warnings, complete: !truncated && warnings.filter(w => w.startsWith('Unable') || w.startsWith('Could not')).length === 0 }
}

function lineCounts(cwd: string): { added: number; deleted: number } | undefined {
  try {
    let added = 0
    let deleted = 0
    const data = git(cwd, ['diff', 'HEAD', '--numstat', '--'])
    for (const line of data.split(/\r?\n/)) {
      const [a, d] = line.split('\t')
      if (a && d && /^\d+$/.test(a) && /^\d+$/.test(d)) {
        added += Number(a)
        deleted += Number(d)
      }
    }
    return { added, deleted }
  } catch {
    return undefined
  }
}

export function collectEvidence(
  before: WorkspaceSnapshot,
  taskId: string,
  status: ExecutionStatus,
  conversationId?: string,
  error?: string,
): TaskEvidence {
  const after = captureWorkspace(before.workspace)
  const warnings = [...before.warnings, ...after.warnings]
  const changed: TaskEvidence['changed_files'] = []
  let added = 0, modified = 0, deleted = 0
  const names = new Set([...Object.keys(before.files), ...Object.keys(after.files)])
  for (const path of [...names].sort()) {
    const b = before.files[path]
    const a = after.files[path]
    if (a && b && a.sha256 !== null && b.sha256 !== null && a.sha256 === b.sha256) continue
    if (a && b && a.sha256 === b.sha256 && a.bytes === b.bytes && a.mtimeMs === b.mtimeMs) continue
    if (!a && !b) continue
    const change = !b ? 'added' : !a ? 'deleted' : 'modified'
    if (change === 'added') added++
    else if (change === 'deleted') deleted++
    else modified++
    if (changed.length < MAX_LISTED_CHANGES) {
      changed.push({ path, change, bytes_before: b?.bytes ?? null, bytes_after: a?.bytes ?? null })
    }
  }
  const total = added + modified + deleted
  if (total > MAX_LISTED_CHANGES) warnings.push(`Changed-file list truncated at ${MAX_LISTED_CHANGES} entries (total: ${total}).`)
  if (before.baselineDirty) warnings.push('Git workspace was dirty before delegation. Cumulative Git line counts may include preexisting changes.')
  if (before.git && !after.git) warnings.push('Git metadata became unavailable during delegation.')
  if (before.git && after.baselineCommit !== before.baselineCommit) warnings.push('HEAD moved during delegation; line counts are relative to the new HEAD, not the baseline.')
  // Deliberately no tests are invented: the parent must run checks independently.
  warnings.push('No independent tests executed by the evidence collector; DSH must validate build, tests, and UI functionality.')
  const lines = after.git ? lineCounts(after.workspace) : undefined
  if (after.git && !lines) warnings.push('Could not obtain Git line counts.')
  return {
    task_id: taskId, execution_status: status, review_status: 'pending',
    conversation_id: conversationId ?? null, workspace: before.workspace,
    baseline_commit: before.baselineCommit,
    changed_files: changed,
    diff_summary: {
      added_files: added, modified_files: modified, deleted_files: deleted,
      changed_files_total: total, added_lines: lines?.added ?? null,
      deleted_lines: lines?.deleted ?? null,
      line_counts_source: lines ? 'git diff HEAD --numstat (tracked files; cumulative, excludes untracked)' : null,
      includes_preexisting_changes: before.baselineDirty,
    },
    test_results: [], artifacts: [], warnings, error: error ?? null,
    evidence_complete: before.complete && after.complete && total <= MAX_LISTED_CHANGES && (!before.git || (after.git && !!lines)),
  }
}

function evidencePath(taskId: string, registryPath = ''): string {
  const parent = registryPath.trim() ? resolve(registryPath) : join(homedir(), '.dsh', 'agy-evidence')
  const name = createHash('sha256').update(taskId).digest('hex') + '.json'
  return join(parent, name)
}

/** Evidence filenames are SHA-256 of task keys, so arbitrary keys cannot traverse paths. */
export function saveEvidence(report: TaskEvidence, registryPath = ''): string {
  const dest = evidencePath(report.task_id, registryPath)
  mkdirSync(resolve(dest, '..'), { recursive: true })
  const tmp = dest + '.' + process.pid + '.' + randomUUID() + '.tmp'
  writeFileSync(tmp, JSON.stringify(report, null, 2), 'utf8')
  renameSync(tmp, dest)
  return dest
}

export function readEvidence(taskId: string, registryPath = ''): TaskEvidence | undefined {
  const path = evidencePath(taskId, registryPath)
  if (!existsSync(path)) return undefined
  const data = JSON.parse(readFileSync(path, 'utf8')) as TaskEvidence
  if (data.task_id !== taskId || data.review_status !== 'pending') throw new Error('Invalid stored evidence record')
  return data
}
