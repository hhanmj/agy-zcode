/**
 * Standalone entry for the agy Anthropic-compatible gateway. Normally spawned
 * detached by the MCP server (which re-checks /health each session); can also
 * be run directly:  AGY_GATEWAY_PORT=8378 node agy-gateway.mjs
 *
 * Prints one AGY_GATEWAY_READY JSON line on stdout when listening (the only
 * stdout output; diagnostics go to stderr).
 */
import { homedir } from 'node:os'
import { GATEWAY_REGISTRY_NAME, loadConfig } from './config.js'
import { gatewayPortFromEnv, loadOrCreateToken, startGateway } from './gateway.js'
import { migrateGatewayTasks } from './registry-migrate.js'
import { AgyRunner, validateWorkspace } from './runner.js'

declare const __AGY_MCP_VERSION__: string

const log = (message: string): void => {
  process.stderr.write('[agy-gateway] ' + message + '\n')
}

// The gateway keeps its own task registry: chat traffic must never evict the
// MCP server's resumable agy_run tasks, and the two never contend for one file.
const config = { ...loadConfig(), registryName: GATEWAY_REGISTRY_NAME }
const port = gatewayPortFromEnv()
let cwd = process.env.AGY_GATEWAY_CWD || process.env.ZCODE_PROJECT_DIR || process.cwd()
try {
  cwd = validateWorkspace(cwd)
} catch (error) {
  log('configured cwd is unusable (' + (error instanceof Error ? error.message : String(error)) + '); falling back to the home directory')
  cwd = homedir()
}
const token = process.env.AGY_GATEWAY_TOKEN?.trim() || loadOrCreateToken(config.dataDir)
const runner = new AgyRunner(config, log)
try {
  await migrateGatewayTasks(config, runner, log)
} catch (error) {
  log('gateway task migration skipped: ' + (error instanceof Error ? error.message : String(error)))
}
const handle = await startGateway({ runner, config, port, token, cwd, log })
process.stdout.write('AGY_GATEWAY_READY ' + JSON.stringify({ port: handle.port, pid: process.pid }) + '\n')
log('listening on http://127.0.0.1:' + handle.port + ' v' + (typeof __AGY_MCP_VERSION__ === 'string' ? __AGY_MCP_VERSION__ : '0.0.0-dev') + ' (agy cwd: ' + cwd + ', data: ' + config.dataDir + ')')

let shuttingDown = false
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down (' + reason + ')')
  await handle.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
