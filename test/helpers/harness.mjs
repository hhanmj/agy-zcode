// Shared helpers for the runner feature tests (registry, supervision,
// persistent sessions): start the built MCP server bundle over stdio with a
// fake agy, read the fake's per-turn log, check process liveness.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
export const ZCODE = join(here, '..', '..')
export const SERVER_DIR = join(ZCODE, 'dist', 'market', 'plugins', 'agy-delegate', 'server')
export const SERVER = join(SERVER_DIR, 'agy-mcp.mjs')
export const GATEWAY = join(SERVER_DIR, 'agy-gateway.mjs')
export const FAKE = join(ZCODE, 'test', 'fake-agy.mjs')
export const FAKE_STREAM = join(ZCODE, 'test', 'fake-agy-stream.mjs')

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

export function tempRoot(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  t.after(async () => {
    // Windows: a just-killed child can hold its cwd for a moment; never let cleanup mask the real failure.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(root, { recursive: true, force: true })
        return
      } catch {
        await sleep(250)
      }
    }
  })
  return root
}

export function readLog(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
}

export function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export async function waitFor(predicate, timeoutMs = 10_000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(stepMs)
  }
  return predicate()
}

/** Start the MCP server bundle (default: the built one) against a fake agy. */
export async function startServer(t, { fake = FAKE_STREAM, env = {}, server = SERVER, root } = {}) {
  root ??= tempRoot(t, 'agy-feat-')
  const workspace = join(root, 'ws')
  mkdirSync(workspace, { recursive: true })
  const log = join(root, 'agy.log')
  const dataDir = join(root, 'data')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: {
      ...process.env,
      AGY_MCP_DATA_DIR: dataDir,
      AGY_MCP_COMMAND: process.execPath,
      AGY_MCP_COMMAND_PREFIX_ARGS: JSON.stringify([fake]),
      AGY_MCP_PROJECT_DIR: workspace,
      AGY_MCP_AUTO_LOGIN_WINDOW: 'false',
      AGY_MCP_AVOID_BROWSER: 'false',
      AGY_MCP_AVOID_LARGE_READS: 'false',
      AGY_MCP_PROXY: 'http://127.0.0.1:9',
      AGY_GATEWAY_AUTOSTART: 'false',
      FAKE_AGY_LOG: log,
      ...env,
    },
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => { stderr += chunk })
  const client = new Client({ name: 'agy-feature-test', version: '0.0.0' })
  await client.connect(transport)
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await client.close()
    await sleep(300)
  }
  t.after(close)
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
    return { text: result.content.map((block) => block.text ?? '').join('\n'), isError: result.isError === true }
  }
  return { root, workspace, dataDir, logFile: log, calls: () => readLog(log), call, close, stderr: () => stderr }
}

export const taskOf = (text) => /\[task: (agy-[\w-]+)/.exec(text)?.[1] ?? /task (agy-[\w-]+)/.exec(text)?.[1]
