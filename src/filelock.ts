/**
 * Cross-process file helpers for plugin state shared by several processes
 * (one MCP server per ZCode workspace plus the detached model gateway, all on
 * the same plugin data directory):
 *
 * - withFileLock: an advisory lock file created with O_EXCL ("wx"). The holder
 *   writes {pid, token, ts}; a waiter breaks the lock when the holder pid is
 *   gone or the lock is older than staleMs (critical sections are a small JSON
 *   read-modify-write, so a fresh lock is never legitimately that old).
 * - readFileIfExists: undefined ONLY for a missing file; any other read error
 *   is retried and then thrown, so a transient EBUSY/EPERM can never be
 *   mistaken for "empty registry" and wipe it on the next write.
 * - writeFileAtomic: unique temp file + rename, retried on Windows sharing errors.
 *
 * Known limit: breaking a stale lock is check-then-rename, so two waiters that
 * both judged the same lock stale can race in a window of microseconds; the
 * atomic rename still guarantees a whole file, at worst one update is lost.
 */
import { randomBytes } from 'node:crypto'
import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'

export interface LockOptions {
  /** Give up acquiring after this long (default 15 s). */
  timeoutMs?: number
  /** A lock older than this is considered abandoned (default 10 s). */
  staleMs?: number
}

const LOCK_BUSY = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY'])
const SHARING = new Set(['EPERM', 'EACCES', 'EBUSY'])

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errno(error) === 'EPERM'
  }
}

interface LockHolder {
  pid: number
  token: string
  ts: number
}

function readLock(lock: string): { raw: string; holder: LockHolder | undefined; mtimeMs: number } | undefined {
  try {
    const raw = readFileSync(lock, 'utf8')
    const mtimeMs = statSync(lock).mtimeMs
    let holder: LockHolder | undefined
    try {
      const parsed = JSON.parse(raw) as Partial<LockHolder>
      if (typeof parsed.pid === 'number' && typeof parsed.token === 'string') holder = { pid: parsed.pid, token: parsed.token, ts: Number(parsed.ts) || 0 }
    } catch {
      // being written right now, or garbage: only age can make it stale
    }
    return { raw, holder, mtimeMs }
  } catch {
    return undefined
  }
}

/** Remove the lock when its holder is dead or it is older than staleMs; true when it was removed. */
function breakIfStale(lock: string, staleMs: number): boolean {
  const seen = readLock(lock)
  if (seen === undefined) return false
  const dead = seen.holder !== undefined && !pidAlive(seen.holder.pid)
  const old = Date.now() - seen.mtimeMs > staleMs
  if (!dead && !old) return false
  // Re-check right before moving it away so a lock re-taken meanwhile survives.
  const again = readLock(lock)
  if (again === undefined || again.raw !== seen.raw) return false
  const aside = lock + '.stale-' + randomBytes(6).toString('hex')
  try {
    renameSync(lock, aside)
  } catch {
    return false
  }
  rmSync(aside, { force: true })
  return true
}

async function release(lock: string, token: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const seen = readLock(lock)
    if (seen?.holder?.token !== token) return
    try {
      rmSync(lock, { force: true })
      return
    } catch (error) {
      if (!SHARING.has(errno(error) ?? '')) return
      await sleep(15 * (attempt + 1))
    }
  }
}

/** Run fn while holding the lock file (created next to the protected file). */
export async function withFileLock<T>(lock: string, fn: () => Promise<T> | T, options: LockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const staleMs = options.staleMs ?? 10_000
  const token = process.pid + '-' + randomBytes(9).toString('hex')
  const deadline = Date.now() + timeoutMs
  let delay = 5
  for (;;) {
    let fd: number | undefined
    try {
      fd = openSync(lock, 'wx')
    } catch (error) {
      const code = errno(error) ?? ''
      if (!LOCK_BUSY.has(code)) throw error
      if (code === 'EEXIST' && breakIfStale(lock, staleMs)) continue
      if (Date.now() >= deadline) {
        const holder = readLock(lock)?.holder
        throw new Error('timed out after ' + timeoutMs + ' ms waiting for ' + lock + (holder !== undefined ? ' (held by pid ' + holder.pid + ')' : ''))
      }
      await sleep(delay + Math.random() * delay)
      delay = Math.min(delay * 2, 100)
      continue
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, token, ts: Date.now() }))
    } catch (error) {
      closeSync(fd)
      rmSync(lock, { force: true })
      throw error
    }
    closeSync(fd)
    break
  }
  try {
    return await fn()
  } finally {
    await release(lock, token)
  }
}

/** File text, or undefined when (and only when) the file does not exist. */
export async function readFileIfExists(file: string, attempts = 6): Promise<string | undefined> {
  for (let attempt = 1; ; attempt++) {
    try {
      return readFileSync(file, 'utf8')
    } catch (error) {
      const code = errno(error)
      if (code === 'ENOENT') return undefined
      if (attempt >= attempts || !SHARING.has(code ?? '')) throw error
      await sleep(20 * attempt)
    }
  }
}

/** Write via a unique temp file in the same directory, then rename over the target. */
export async function writeFileAtomic(file: string, data: string, attempts = 8): Promise<void> {
  const tmp = file + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp'
  writeFileSync(tmp, data, 'utf8')
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, file)
      return
    } catch (error) {
      if (attempt >= attempts || !SHARING.has(errno(error) ?? '')) {
        rmSync(tmp, { force: true })
        throw error
      }
      await sleep(20 * attempt)
    }
  }
}
