// End-to-end tests: the built MCP server bundle driven over stdio by the MCP
// SDK client, with test/fake-agy.mjs standing in for the agy CLI.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
const SERVER = join(here, '..', 'dist', 'market', 'plugins', 'agy-delegate', 'server', 'agy-mcp.mjs')
const FAKE = join(here, 'fake-agy.mjs')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const same = (a, b) => realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase()

async function startServer(t, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agy-mcp-test-'))
  const workspace = join(root, 'ws')
  mkdirSync(workspace)
  const log = join(root, 'agy.log')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      AGY_MCP_DATA_DIR: join(root, 'data'),
      AGY_MCP_COMMAND: process.execPath,
      AGY_MCP_COMMAND_PREFIX_ARGS: JSON.stringify([FAKE]),
      AGY_MCP_PROJECT_DIR: workspace,
      AGY_MCP_AUTO_LOGIN_WINDOW: 'false',
      AGY_MCP_PROXY: 'http://127.0.0.1:9',
      // Tests must not leave a detached model gateway bound to the real port.
      AGY_GATEWAY_AUTOSTART: 'false',
      FAKE_AGY_LOG: log,
      SHOULD_NOT_LEAK_TOKEN: 'secret-value',
      ...extraEnv,
      // The account library must never touch the developer's real ~/.gemini.
      AGY_MCP_GEMINI_DIR: join(root, 'gemini'),
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'agy-mcp-test', version: '0.0.0' })
  await client.connect(transport)
  t.after(async () => {
    await client.close()
    await sleep(200)
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
  const call = async (name, args = {}, options = {}, meta) => {
    const result = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }, undefined, options)
    return { text: result.content.map((block) => block.text ?? '').join('\n'), isError: result.isError === true }
  }
  return { client, root, workspace, calls, call }
}

const taskOf = (text) => /\[task: (agy-[\w-]+)/.exec(text)?.[1]

test('lists the model-facing agy tools plus the app-only panel tools', async (t) => {
  const { client } = await startServer(t)
  const { tools } = await client.listTools()
  const modelFacing = tools.filter((tool) => tool._meta?.visibility === undefined).map((tool) => tool.name).sort()
  assert.deepEqual(modelFacing, ['agy_accounts', 'agy_cancel', 'agy_evidence', 'agy_followup', 'agy_login', 'agy_models', 'agy_run', 'agy_status', 'agy_tasks', 'agy_trace'])
  const appOnly = tools.filter((tool) => Array.isArray(tool._meta?.visibility) && tool._meta.visibility.length === 1 && tool._meta.visibility[0] === 'app').map((tool) => tool.name).sort()
  assert.deepEqual(appOnly, ['agy_panel_account', 'agy_panel_action', 'agy_panel_data', 'agy_panel_task'])
  assert.equal(tools.find((tool) => tool.name === 'agy_status').annotations.readOnlyHint, true)
  assert.equal(tools.find((tool) => tool.name === 'agy_tasks')._meta.ui.resourceUri, 'ui://agy-delegate/panel.html')
})

test('serves the panel as a self-contained MCP App resource with subscription support', async (t) => {
  const { client } = await startServer(t)
  const { resources } = await client.listResources()
  assert.equal(resources[0].uri, 'ui://agy-delegate/panel.html')
  assert.equal(resources[0].mimeType, 'text/html;profile=mcp-app')
  const read = await client.readResource({ uri: resources[0].uri })
  const html = read.contents[0].text
  assert.match(html, /<script type="module">/)
  assert.ok(!html.includes('src="./panel.js"'), 'the UI bundle is inlined (offline, single resource)')
  assert.ok(html.length < 4 * 1024 * 1024)
  await client.subscribeResource({ uri: resources[0].uri })
  await client.unsubscribeResource({ uri: resources[0].uri })
})

test('account library: capture, list, config and switch never expose tokens', async (t) => {
  const { call, root } = await startServer(t)
  const gemini = join(root, 'gemini')
  mkdirSync(gemini, { recursive: true })
  writeFileSync(join(gemini, 'oauth_creds.json'), JSON.stringify({ access_token: 'SECRET-A', refresh_token: 'REFRESH-A' }))
  writeFileSync(join(gemini, 'google_accounts.json'), JSON.stringify({ active: 'a@example.com', old: [] }))
  const captured = await call('agy_accounts', { action: 'capture', label: 'first' })
  assert.equal(captured.isError, false, captured.text)
  assert.match(captured.text, /a@example\.com/)
  assert.ok(!captured.text.includes('SECRET-A') && !captured.text.includes('REFRESH-A'))

  writeFileSync(join(gemini, 'oauth_creds.json'), JSON.stringify({ access_token: 'SECRET-B', refresh_token: 'REFRESH-B' }))
  writeFileSync(join(gemini, 'google_accounts.json'), JSON.stringify({ active: 'b@example.com', old: [] }))
  await call('agy_accounts', { action: 'capture' })
  const listed = await call('agy_accounts', { action: 'list' })
  assert.match(listed.text, /a@example\.com/)
  assert.match(listed.text, /b@example\.com/)
  assert.ok(!listed.text.includes('SECRET-'), listed.text)

  await call('agy_accounts', { action: 'config', enabled: true, strategy: 'round-robin' })
  const state = JSON.parse(readFileSync(join(root, 'data', 'accounts', 'accounts.json'), 'utf8'))
  assert.equal(state.rotation.enabled, true)
  const other = state.accounts.find((a) => a.email === 'a@example.com')
  await call('agy_accounts', { action: 'switch', id: other.id })
  assert.equal(JSON.parse(readFileSync(join(gemini, 'oauth_creds.json'), 'utf8')).access_token, 'SECRET-A')
  assert.equal(existsSync(join(root, 'data', 'accounts', 'switch-journal.json')), false)
})

test('quota failure parks the active account and rotates to the next one', async (t) => {
  const { call, root } = await startServer(t)
  const gemini = join(root, 'gemini')
  mkdirSync(gemini, { recursive: true })
  writeFileSync(join(gemini, 'oauth_creds.json'), JSON.stringify({ access_token: 'SECRET-A' }))
  writeFileSync(join(gemini, 'google_accounts.json'), JSON.stringify({ active: 'a@example.com' }))
  await call('agy_accounts', { action: 'capture' })
  writeFileSync(join(gemini, 'oauth_creds.json'), JSON.stringify({ access_token: 'SECRET-B' }))
  writeFileSync(join(gemini, 'google_accounts.json'), JSON.stringify({ active: 'b@example.com' }))
  await call('agy_accounts', { action: 'capture' })
  await call('agy_accounts', { action: 'config', enabled: true })

  const failed = await call('agy_run', { description: 'quota', prompt: 'go FAIL=Error 429 RESOURCE_EXHAUSTED: quota exceeded' })
  assert.equal(failed.isError, true)
  assert.match(failed.text, /Account rotation: switched to a@example\.com/)
  assert.match(failed.text, /resume this conversation with agy_followup/)
  assert.equal(JSON.parse(readFileSync(join(gemini, 'oauth_creds.json'), 'utf8')).access_token, 'SECRET-A')
  const state = JSON.parse(readFileSync(join(root, 'data', 'accounts', 'accounts.json'), 'utf8'))
  assert.ok(state.accounts.find((a) => a.email === 'b@example.com').exhaustedUntil > Date.now())
})

test('panel data and panel actions drive the same runner', async (t) => {
  const { call } = await startServer(t)
  const started = await call('agy_panel_action', { action: 'run', description: 'panel task', prompt: 'build it WRITE=panel.txt' })
  assert.equal(started.isError, false, started.text)
  const { task } = JSON.parse(started.text)
  let data
  for (let attempt = 0; attempt < 50; attempt++) {
    data = JSON.parse((await call('agy_panel_data')).text)
    if (data.runs.find((r) => r.task === task)?.status === 'completed') break
    await sleep(100)
  }
  const run = data.runs.find((r) => r.task === task)
  assert.equal(run.status, 'completed')
  assert.ok(run.evidence.diff.changed_files_total >= 1)
  const detail = JSON.parse((await call('agy_panel_task', { task })).text)
  assert.ok(detail.evidence)
  const cancelled = await call('agy_panel_action', { action: 'cancel', task })
  assert.equal(cancelled.isError, true)
})

test('foreground run returns the answer, task key and independent evidence', async (t) => {
  const { call, calls, workspace } = await startServer(t)
  const result = await call('agy_run', { description: 'write hello', prompt: 'build it WRITE=hello.txt' })
  assert.equal(result.isError, false, result.text)
  assert.match(result.text, /^Echo: build it WRITE=hello\.txt/)
  assert.ok(taskOf(result.text), result.text)
  assert.match(result.text, /\[evidence: 1 file\(s\) changed \(added 1, modified 0, deleted 0\)/)
  assert.ok(existsSync(join(workspace, 'hello.txt')))
  const [invocation] = calls()
  assert.ok(same(invocation.cwd, workspace))
  for (const flag of ['-p', '--print-timeout', '--dangerously-skip-permissions', '--output-format']) assert.ok(invocation.args.includes(flag), flag)
  assert.equal(invocation.args[invocation.args.indexOf('--output-format') + 1], 'stream-json')
  assert.match(invocation.prompt, /headless browser tools are unreliable/)
  assert.equal(invocation.proxy, 'http://127.0.0.1:9')
  assert.equal(invocation.leakedSecret, null)
})

test('follow-up resumes the recorded agy conversation', async (t) => {
  const { call, calls } = await startServer(t)
  const first = await call('agy_run', { description: 'first', prompt: 'first turn' })
  const task = taskOf(first.text)
  assert.ok(!calls()[0].args.includes('--conversation'))
  const second = await call('agy_followup', { task, prompt: 'second turn' })
  assert.equal(second.isError, false, second.text)
  assert.match(second.text, /Echo: second turn \(resumed conv-/)
  assert.equal(taskOf(second.text), task)
  const resumed = calls()[1]
  assert.equal(resumed.args[resumed.args.indexOf('--conversation') + 1], calls()[0].conversation)
  const tasks = await call('agy_tasks')
  assert.match(tasks.text, new RegExp('task ' + task + ' \\| first'))
  // A background follow-up: status by task key must follow the NEW run, not the finished first one.
  const third = await call('agy_followup', { task, prompt: 'third turn SLEEP=800', background: true })
  const run = /\(run (agy-[\w-]+)\)/.exec(third.text)?.[1]
  assert.ok(run, third.text)
  const live = await call('agy_status', { task })
  assert.match(live.text, new RegExp('\\(run ' + run + '\\) \\| status: running'))
  const done = await call('agy_status', { task, wait_seconds: 30 })
  assert.match(done.text, /Echo: third turn SLEEP=800 \(resumed conv-/)
})

test('a follow-up for an unknown task fails clearly', async (t) => {
  const { call } = await startServer(t)
  const result = await call('agy_followup', { task: 'agy-nope', prompt: 'x' })
  assert.equal(result.isError, true)
  assert.match(result.text, /no such task "agy-nope"/)
})

test('background run reports progress, then the final answer', async (t) => {
  const { call } = await startServer(t)
  const started = await call('agy_run', { description: 'slow', prompt: 'slow job SLEEP=1500', background: true })
  assert.equal(started.isError, false, started.text)
  const task = /task (agy-[\w-]+)/.exec(started.text)[1]
  const running = await call('agy_status', { task })
  assert.match(running.text, /status: running/)
  assert.match(running.text, /next_offset: \d+/)
  const finished = await call('agy_status', { task, wait_seconds: 30 })
  assert.match(finished.text, /status: completed/)
  assert.match(finished.text, /Echo: slow job SLEEP=1500/)
})

test('cancel terminates a running background task', async (t) => {
  const { call, calls } = await startServer(t)
  const started = await call('agy_run', { description: 'endless', prompt: 'never ends SLEEP=60000', background: true })
  const task = /task (agy-[\w-]+)/.exec(started.text)[1]
  for (let i = 0; i < 50 && calls().length === 0; i += 1) await sleep(100)
  const pid = calls()[0].pid
  const cancelled = await call('agy_cancel', { task })
  assert.match(cancelled.text, /status now: cancelled/, cancelled.text)
  const status = await call('agy_status', { task })
  assert.match(status.text, /status: cancelled/)
  await sleep(500)
  assert.throws(() => process.kill(pid, 0), 'fake agy process should be gone')
})

test('closing the server stops running agy processes', async (t) => {
  const { client, call, calls } = await startServer(t)
  await call('agy_run', { description: 'orphan', prompt: 'orphan SLEEP=60000', background: true })
  for (let i = 0; i < 50 && calls().length === 0; i += 1) await sleep(100)
  const pid = calls()[0].pid
  await client.close()
  let alive = true
  for (let i = 0; i < 40 && alive; i += 1) {
    await sleep(250)
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
  }
  assert.equal(alive, false, 'agy should be terminated when the MCP server shuts down')
})

test('agy failures come back as tool errors with guidance', async (t) => {
  const { call } = await startServer(t)
  const failed = await call('agy_run', { description: 'fail', prompt: 'FAIL please' })
  assert.equal(failed.isError, true)
  assert.match(failed.text, /agy run failed: boom from fake agy/)
  assert.ok(taskOf(failed.text))
  const auth = await call('agy_run', { description: 'auth', prompt: 'AUTH please' })
  assert.equal(auth.isError, true)
  assert.match(auth.text, /authentication required/)
  assert.match(auth.text, /agy_login/)
})

test('evidence, trace and models tools', async (t) => {
  const { call } = await startServer(t)
  const run = await call('agy_run', { description: 'evidence', prompt: 'make WRITE=a.txt' })
  const task = taskOf(run.text)
  const evidence = JSON.parse((await call('agy_evidence', { task })).text)
  assert.equal(evidence.execution_status, 'completed')
  assert.equal(evidence.review_status, 'pending')
  assert.deepEqual(evidence.changed_files.map((file) => file.path), ['a.txt'])
  const trace = await call('agy_trace', { id: task })
  assert.match(trace.text, /lifecycle: started=yes execution=completed/)
  assert.match(trace.text, /tool_calls=1/)
  const models = await call('agy_models')
  assert.match(models.text, /gemini-3\.8-flash — Gemini 3\.8 Flash; efforts: low \| medium \| high/)
})

test('model selection is validated against agy models', async (t) => {
  const { call, calls } = await startServer(t)
  const ok = await call('agy_run', { description: 'model', prompt: 'with model', model: 'gemini-3.8-flash', effort: 'low' })
  assert.equal(ok.isError, false, ok.text)
  const args = calls()[0].args
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.8-flash')
  assert.equal(args[args.indexOf('--effort') + 1], 'low')
  const bad = await call('agy_run', { description: 'model', prompt: 'with model', model: 'no-such-model' })
  assert.equal(bad.isError, true)
  assert.match(bad.text, /agy_models/)
})

test('foreground runs send MCP progress notifications', async (t) => {
  const { call } = await startServer(t)
  const progress = []
  const result = await call('agy_run', { description: 'progress', prompt: 'with progress SLEEP=1200' }, { onprogress: (event) => progress.push(event) })
  assert.equal(result.isError, false, result.text)
  assert.ok(progress.length >= 1, 'expected at least one progress notification')
  assert.match(progress[0].message, /^agy running/)
})

test('prompts longer than the argv limit travel over stdin', async (t) => {
  const { call, calls } = await startServer(t)
  const prompt = 'LONG ' + 'x'.repeat(31_000)
  const result = await call('agy_run', { description: 'long', prompt })
  assert.equal(result.isError, false, result.text)
  const invocation = calls()[0]
  assert.ok(invocation.args.includes('--input-format'))
  assert.ok(!invocation.args.includes('-p'))
  assert.ok(invocation.prompt.length > 31_000)
})

test('the workspace comes from ZCode tool-call metadata', async (t) => {
  const { call, calls, root } = await startServer(t)
  const other = join(root, 'other')
  mkdirSync(other)
  const result = await call('agy_run', { description: 'meta', prompt: 'where am i' }, {}, { workspace_path: other })
  assert.equal(result.isError, false, result.text)
  assert.ok(same(calls()[0].cwd, other))
  const relative = await call('agy_run', { description: 'bad cwd', prompt: 'x', cwd: 'relative/dir' })
  assert.equal(relative.isError, true)
  assert.match(relative.text, /cwd must be an absolute path/)
})
