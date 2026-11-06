/**
 * One-time move of the model gateway's task records out of the shared MCP
 * registry (tasks.json) into its own file (gateway-tasks.json). Before the
 * split, gateway chats filled tasks.json, evicting resumable agy_run tasks.
 * Only keys referenced by gateway-conversations.json move: those tasks were
 * created by the gateway, so no MCP task is ever touched.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_REGISTRY_NAME, type RunnerConfig } from './config.js'
import { AgyRunner, type TaskRecord } from './runner.js'

function gatewayTaskKeys(dataDir: string): Set<string> {
  const keys = new Set<string>()
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, 'gateway-conversations.json'), 'utf8')) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const entry of Object.values(parsed as Record<string, unknown>)) {
        const task = (entry as { task?: unknown } | null)?.task
        if (typeof task === 'string' && task.length > 0) keys.add(task)
      }
    }
  } catch {
    // no conversation map yet: nothing to migrate
  }
  return keys
}

/** Returns how many records moved (0 when the gateway registry already exists or nothing matched). */
export async function migrateGatewayTasks(config: RunnerConfig, gateway: AgyRunner, log: (message: string) => void): Promise<number> {
  if (config.registryName === DEFAULT_REGISTRY_NAME || existsSync(gateway.registryFile)) return 0
  const keys = gatewayTaskKeys(config.dataDir)
  if (keys.size === 0) return 0
  const shared = new AgyRunner({ ...config, registryName: DEFAULT_REGISTRY_NAME, traceEnabled: false }, log)
  const legacy = shared.loadRegistry()
  const moving: Record<string, TaskRecord> = {}
  for (const key of keys) {
    const record = legacy[key]
    if (record !== undefined) moving[key] = record
  }
  const count = Object.keys(moving).length
  if (count === 0) return 0
  if (!(await gateway.updateRegistry((records) => {
    for (const [key, record] of Object.entries(moving)) records[key] ??= record
  }))) return 0
  // Copy first, delete second: a failure here leaves harmless duplicates, never a loss.
  await shared.updateRegistry((records) => {
    for (const key of Object.keys(moving)) delete records[key]
  })
  log('moved ' + count + ' gateway task record(s) from ' + DEFAULT_REGISTRY_NAME + ' to ' + config.registryName)
  return count
}
