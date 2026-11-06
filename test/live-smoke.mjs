// Opt-in live smoke test against the REAL agy CLI (uses a little agy quota):
//   node test/live-smoke.mjs
// Runs one foreground task and one background follow-up in a temp workspace.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
const SERVER = join(here, '..', 'dist', 'market', 'plugins', 'agy-delegate', 'server', 'agy-mcp.mjs')
const root = mkdtempSync(join(tmpdir(), 'agy-mcp-live-'))
const workspace = join(root, 'ws')
mkdirSync(workspace)
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: { ...process.env, AGY_MCP_DATA_DIR: join(root, 'data'), AGY_MCP_PROJECT_DIR: workspace },
  stderr: 'inherit',
})
const client = new Client({ name: 'agy-mcp-live', version: '0.0.0' })
await client.connect(transport)
const call = async (name, args, options = {}) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 900_000, ...options })
  const text = result.content.map((block) => block.text ?? '').join('\n')
  console.log('\n=== ' + name + (result.isError ? ' (isError)' : '') + ' ===\n' + text)
  return text
}
try {
  let progress = 0
  const first = await call('agy_run', { description: 'live pong', prompt: 'Reply with exactly the word PONG and nothing else. Do not run any tools or edit any files.' }, { onprogress: () => { progress += 1 } })
  console.log('(progress notifications: ' + progress + ')')
  const task = /\[task: (agy-[\w-]+)/.exec(first)?.[1]
  if (task === undefined) throw new Error('no task key in the first answer')
  await call('agy_followup', { task, prompt: 'Now reply with exactly PONG2 and nothing else.', background: true })
  await call('agy_status', { task, wait_seconds: 240 })
  await call('agy_tasks', {})
  await call('agy_trace', { id: task, limit: 8 })
} finally {
  await client.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
