/**
 * Antigravity (agy) account library and quota-driven rotation.
 *
 * agy itself keeps exactly ONE login, in <home>/.gemini/oauth_creds.json plus
 * google_accounts.json; /logout discards the old credentials. This module keeps
 * a per-account snapshot of those files so several logins can be kept and the
 * live pair swapped atomically. The storage and switching policy follow the
 * approach validated by the Antigravity-Manager / agy-switch projects (per-
 * account files, a switch journal, a cross-process switch lock, a cooldown
 * after each switch, and an explicit candidate list); the implementation here
 * is TypeScript so the plugin has no Rust/Tauri dependency.
 *
 * Hard limit, same as those projects document: a RUNNING agy process cannot be
 * migrated to another account. Rotation only changes which account the NEXT
 * process uses; a quota-killed conversation is resumed with agy_followup.
 *
 * Tokens never leave this directory: tool responses and logs carry emails and
 * file paths only, never credential contents.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileIfExists, withFileLock, writeFileAtomic } from './filelock.js'

export interface AccountEntry {
  id: string
  email: string
  label: string
  disabled: boolean
  /** Lower runs earlier in priority order. */
  priority: number
  addedAt: number
  lastUsedAt?: number
  /** Set when agy reported this account out of quota; skipped until then. */
  exhaustedUntil?: number
  lastError?: string
}

export interface RotationSettings {
  enabled: boolean
  strategy: 'priority' | 'round-robin'
  /** How long an exhausted account is skipped (default 5 h, the quota window). */
  exhaustedMs: number
  /** Minimum gap between two automatic switches (default 120 s, anti-flap). */
  cooldownMs: number
}

export interface AccountSnapshot {
  savedAt: number
  oauthCreds: string
  googleAccounts: string | undefined
}

interface AccountFile {
  accounts: AccountEntry[]
  activeId?: string
  rotation: RotationSettings
  lastSwitchAt?: number
}

export interface AccountStoreOptions {
  dataDir: string
  /** Directory holding agy's live credentials; defaults to <home>/.gemini. */
  geminiDir?: string
  log?: (message: string) => void
  now?: () => number
}

export const DEFAULT_ROTATION: RotationSettings = {
  enabled: false,
  strategy: 'priority',
  exhaustedMs: 5 * 60 * 60 * 1000,
  cooldownMs: 120_000,
}

/** agy/stream-json text that means "this account is out of quota right now". */
export function isQuotaError(text: string | undefined): boolean {
  if (text === undefined) return false
  return /429|resource[_ ]exhausted|quota|rate.?limit|too many requests|usage limit/i.test(text)
}

function emptyFile(): AccountFile {
  return { accounts: [], rotation: { ...DEFAULT_ROTATION } }
}

export class AccountStore {
  readonly dir: string
  readonly geminiDir: string
  private readonly file: string
  private readonly lock: string
  private readonly journal: string
  private readonly log: (message: string) => void
  private readonly now: () => number
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: AccountStoreOptions) {
    this.dir = join(options.dataDir, 'accounts')
    this.file = join(this.dir, 'accounts.json')
    this.lock = join(this.dir, 'accounts.lock')
    this.journal = join(this.dir, 'switch-journal.json')
    this.geminiDir = options.geminiDir ?? join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), '.gemini')
    this.log = options.log ?? ((message) => process.stderr.write(message + '\n'))
    this.now = options.now ?? Date.now
  }

  private get oauthPath(): string {
    return join(this.geminiDir, 'oauth_creds.json')
  }

  private get googleAccountsPath(): string {
    return join(this.geminiDir, 'google_accounts.json')
  }

  private profilePath(id: string): string {
    return join(this.dir, 'profiles', id + '.json')
  }

  /** Serialized read-modify-write, locked across the MCP server and gateway processes. */
  private update<T>(mutate: (state: AccountFile) => T | Promise<T>): Promise<T> {
    // The lock file lives next to accounts.json; create the dir before locking.
    mkdirSync(this.dir, { recursive: true })
    const run = this.tail.then(() => withFileLock(this.lock, async () => {
      mkdirSync(this.dir, { recursive: true })
      const raw = await readFileIfExists(this.file)
      let state = emptyFile()
      if (raw !== undefined) {
        try {
          const parsed = JSON.parse(raw) as Partial<AccountFile>
          state = {
            accounts: Array.isArray(parsed.accounts) ? parsed.accounts.filter((a) => a !== null && typeof a === 'object' && typeof a.id === 'string' && typeof a.email === 'string') : [],
            ...(typeof parsed.activeId === 'string' ? { activeId: parsed.activeId } : {}),
            rotation: { ...DEFAULT_ROTATION, ...(parsed.rotation ?? {}) },
            ...(typeof parsed.lastSwitchAt === 'number' ? { lastSwitchAt: parsed.lastSwitchAt } : {}),
          }
        } catch {
          const backup = this.file + '.corrupt-' + this.now()
          writeFileSync(backup, raw, 'utf8')
          this.log('[agy-accounts] accounts.json was corrupt; backed up to ' + backup)
        }
      }
      const result = await mutate(state)
      await writeFileAtomic(this.file, JSON.stringify(state, null, 2))
      return result
    }, { staleMs: 30_000 }))
    this.tail = run.catch(() => undefined)
    return run
  }

  private readLive(): { oauthCreds: string; googleAccounts: string | undefined } {
    if (!existsSync(this.oauthPath)) throw new Error('no agy login found at ' + this.oauthPath + ' — sign in first (agy_login or the panel\'s Add account)')
    const oauthCreds = readFileSync(this.oauthPath, 'utf8')
    // Validate it is real JSON before archiving it as an account.
    JSON.parse(oauthCreds)
    const googleAccounts = existsSync(this.googleAccountsPath) ? readFileSync(this.googleAccountsPath, 'utf8') : undefined
    return { oauthCreds, googleAccounts }
  }

  /** The email agy currently considers active, if its files name one. */
  currentEmail(): string | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.googleAccountsPath, 'utf8')) as { active?: unknown }
      return typeof parsed.active === 'string' && parsed.active.length > 0 ? parsed.active : undefined
    } catch {
      return undefined
    }
  }

  private saveProfile(id: string, live: { oauthCreds: string; googleAccounts: string | undefined }): void {
    const snapshot: AccountSnapshot = { savedAt: this.now(), oauthCreds: live.oauthCreds, googleAccounts: live.googleAccounts }
    mkdirSync(join(this.dir, 'profiles'), { recursive: true })
    writeFileSync(this.profilePath(id), JSON.stringify(snapshot), 'utf8')
  }

  private loadProfile(id: string): AccountSnapshot {
    const raw = readFileSync(this.profilePath(id), 'utf8')
    const parsed = JSON.parse(raw) as AccountSnapshot
    if (typeof parsed.oauthCreds !== 'string') throw new Error('account profile ' + id + ' has no credentials')
    return parsed
  }

  /**
   * Archive the CURRENT agy login as a library account. Call right after a
   * successful sign-in (the login window flow) or to import an existing login.
   * Re-importing the same email refreshes its stored tokens.
   */
  async captureCurrent(label = ''): Promise<AccountEntry> {
    const live = this.readLive()
    const email = this.currentEmail() ?? emailFromCredentials(live.oauthCreds) ?? 'account-' + createHash('sha256').update(live.oauthCreds).digest('hex').slice(0, 8)
    return this.update((state) => {
      const existing = state.accounts.find((a) => a.email === email)
      const entry: AccountEntry = existing ?? {
        id: randomBytes(6).toString('hex'),
        email,
        label: label.trim(),
        disabled: false,
        priority: state.accounts.length,
        addedAt: this.now(),
      }
      if (label.trim().length > 0) entry.label = label.trim()
      entry.lastUsedAt = this.now()
      entry.exhaustedUntil = undefined
      entry.lastError = undefined
      if (existing === undefined) state.accounts.push(entry)
      this.saveProfile(entry.id, live)
      state.activeId = entry.id
      return entry
    })
  }

  /** Public view: no credential material, safe to return from tools. */
  async list(): Promise<{ accounts: AccountEntry[]; activeId?: string; currentEmail?: string; rotation: RotationSettings; lastSwitchAt?: number; geminiDir: string }> {
    let state = emptyFile()
    try {
      const raw = await readFileIfExists(this.file)
      if (raw !== undefined) state = { ...emptyFile(), ...(JSON.parse(raw) as AccountFile) }
    } catch {
      // listing stays available even when the file is being written
    }
    return {
      accounts: state.accounts,
      ...(state.activeId !== undefined ? { activeId: state.activeId } : {}),
      ...(this.currentEmail() !== undefined ? { currentEmail: this.currentEmail() } : {}),
      rotation: { ...DEFAULT_ROTATION, ...state.rotation },
      ...(state.lastSwitchAt !== undefined ? { lastSwitchAt: state.lastSwitchAt } : {}),
      geminiDir: this.geminiDir,
    }
  }

  async remove(id: string): Promise<void> {
    await this.update((state) => {
      const index = state.accounts.findIndex((a) => a.id === id)
      if (index < 0) throw new Error('no account "' + id + '"')
      state.accounts.splice(index, 1)
      if (state.activeId === id) state.activeId = state.accounts[0]?.id
      rmSync(this.profilePath(id), { force: true })
    })
  }

  async configure(rotation: Partial<RotationSettings> & { disabled?: string; enableAccount?: string }): Promise<RotationSettings> {
    return this.update((state) => {
      if (rotation.enabled !== undefined) state.rotation.enabled = rotation.enabled
      if (rotation.strategy !== undefined) {
        if (rotation.strategy !== 'priority' && rotation.strategy !== 'round-robin') throw new Error('strategy must be priority or round-robin')
        state.rotation.strategy = rotation.strategy
      }
      if (rotation.exhaustedMs !== undefined) state.rotation.exhaustedMs = Math.max(60_000, rotation.exhaustedMs)
      if (rotation.cooldownMs !== undefined) state.rotation.cooldownMs = Math.max(0, rotation.cooldownMs)
      if (rotation.disabled !== undefined) {
        const account = state.accounts.find((a) => a.id === rotation.disabled)
        if (account === undefined) throw new Error('no account "' + rotation.disabled + '"')
        account.disabled = !account.disabled
      }
      return state.rotation
    })
  }

  /**
   * Swap the live agy credentials to a stored account. Journaled: if the process
   * dies mid-switch the journal names the account whose snapshot must be
   * re-applied, rather than leaving an untracked half-written login.
   */
  async switchTo(id: string, reason = 'manual'): Promise<AccountEntry> {
    return this.update(async (state) => {
      const account = state.accounts.find((a) => a.id === id)
      if (account === undefined) throw new Error('no account "' + id + '"')
      const snapshot = this.loadProfile(id)
      mkdirSync(this.geminiDir, { recursive: true })
      writeFileSync(this.journal, JSON.stringify({ targetId: id, reason, startedAt: this.now(), pid: process.pid }), 'utf8')
      await writeFileAtomic(this.oauthPath, snapshot.oauthCreds)
      if (snapshot.googleAccounts !== undefined) await writeFileAtomic(this.googleAccountsPath, snapshot.googleAccounts)
      else rmSync(this.googleAccountsPath, { force: true })
      rmSync(this.journal, { force: true })
      const from = state.activeId
      state.activeId = id
      state.lastSwitchAt = this.now()
      account.lastUsedAt = this.now()
      this.log('[agy-accounts] switched ' + (from ?? '(none)') + ' -> ' + id + ' (' + account.email + '): ' + reason)
      return account
    })
  }

  /** Next eligible account after `excludeId`, or undefined when none is usable. */
  private pick(state: AccountFile, excludeId: string | undefined): AccountEntry | undefined {
    const now = this.now()
    const usable = state.accounts.filter((a) => !a.disabled && a.id !== excludeId && (a.exhaustedUntil === undefined || a.exhaustedUntil <= now))
    if (usable.length === 0) return undefined
    const sorted = [...usable].sort((a, b) => a.priority - b.priority)
    if (state.rotation.strategy === 'round-robin' && excludeId !== undefined) {
      const order = [...state.accounts].sort((a, b) => a.priority - b.priority)
      const at = order.findIndex((a) => a.id === excludeId)
      for (let step = 1; step <= order.length; step++) {
        const candidate = order[(at + step + order.length) % order.length]
        if (usable.includes(candidate)) return candidate
      }
    }
    return sorted[0]
  }

  /**
   * Before a run: when rotation is on and the active account is still in its
   * exhausted window, move to the next eligible one. Never switches when the
   * current account is healthy.
   */
  async ensureUsableAccount(): Promise<{ from?: string; to: AccountEntry } | undefined> {
    if (!existsSync(this.file)) return undefined
    const { accounts, activeId, rotation, lastSwitchAt } = await this.list()
    if (!rotation.enabled || activeId === undefined) return undefined
    const active = accounts.find((a) => a.id === activeId)
    if (active === undefined || active.exhaustedUntil === undefined || active.exhaustedUntil <= this.now()) return undefined
    if (lastSwitchAt !== undefined && this.now() - lastSwitchAt < rotation.cooldownMs) return undefined
    return this.rotate('previous account ' + active.email + ' is exhausted until ' + new Date(active.exhaustedUntil).toISOString())
  }

  /** Rotate away from the active account; undefined when no candidate is eligible. */
  async rotate(reason: string): Promise<{ from?: string; to: AccountEntry } | undefined> {
    return this.update(async (state) => {
      if (state.lastSwitchAt !== undefined && this.now() - state.lastSwitchAt < state.rotation.cooldownMs) return undefined
      const next = this.pick(state, state.activeId)
      if (next === undefined) return undefined
      const from = state.activeId
      const snapshot = this.loadProfile(next.id)
      mkdirSync(this.geminiDir, { recursive: true })
      writeFileSync(this.journal, JSON.stringify({ targetId: next.id, reason, startedAt: this.now(), pid: process.pid }), 'utf8')
      await writeFileAtomic(this.oauthPath, snapshot.oauthCreds)
      if (snapshot.googleAccounts !== undefined) await writeFileAtomic(this.googleAccountsPath, snapshot.googleAccounts)
      rmSync(this.journal, { force: true })
      state.activeId = next.id
      state.lastSwitchAt = this.now()
      next.lastUsedAt = this.now()
      this.log('[agy-accounts] rotation: ' + (from ?? '(none)') + ' -> ' + next.id + ' (' + next.email + '): ' + reason)
      return { ...(from !== undefined ? { from } : {}), to: next }
    })
  }

  /**
   * A run failed with a quota error: park the active account for one quota
   * window and rotate. Returns a human-readable note for the run's error text,
   * or undefined when rotation is off / no other account is available.
   */
  async onQuotaFailure(errorText: string): Promise<string | undefined> {
    if (!existsSync(this.file)) return undefined
    const { activeId, rotation } = await this.list()
    if (!rotation.enabled || activeId === undefined) return undefined
    const now = this.now()
    await this.update((state) => {
      const active = state.accounts.find((a) => a.id === activeId)
      if (active !== undefined) {
        active.exhaustedUntil = now + state.rotation.exhaustedMs
        active.lastError = errorText.slice(0, 200)
      }
    })
    const rotated = await this.rotate('quota exhausted: ' + errorText.slice(0, 120))
    if (rotated === undefined) {
      return 'Account rotation: active account marked exhausted; no other eligible account in the library (add one in the panel, or wait for the quota window to reset).'
    }
    return 'Account rotation: switched to ' + rotated.to.email + '. The failed run was NOT migrated — resume this conversation with agy_followup { task } to continue on the new account.'
  }

  /** Journal left by a crash mid-switch (surfaced in the panel; never auto-retried). */
  pendingSwitch(): { targetId: string; reason: string; startedAt: number } | undefined {
    try {
      return JSON.parse(readFileSync(this.journal, 'utf8')) as { targetId: string; reason: string; startedAt: number }
    } catch {
      return undefined
    }
  }
}

function emailFromCredentials(oauthCreds: string): string | undefined {
  try {
    const parsed = JSON.parse(oauthCreds) as Record<string, unknown>
    for (const key of ['email', 'account', 'id']) {
      const value = parsed[key]
      if (typeof value === 'string' && value.includes('@')) return value
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Re-export for tests that build fake stores without touching real credentials. */
export function listProfiles(dir: string): string[] {
  try {
    return readdirSync(join(dir, 'profiles'))
  } catch {
    return []
  }
}
