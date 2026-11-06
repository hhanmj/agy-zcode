// End-to-end tests for the Anthropic-compatible gateway bundle, with
// test/fake-agy.mjs standing in for the agy CLI. The gateway runs as a child
// process on an ephemeral port (AGY_GATEWAY_PORT=0) and reports the port in an
// AGY_GATEWAY_READY line on stdout.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const GATEWAY = join(here, '..', 'dist', 'market', 'plugins', 'agy-delegate', 'server', 'agy-gateway.mjs')
const FAKE = join(here, 'fake-agy.mjs')
const TOKEN = 'test-token-1234'
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function startGateway(t, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agy-gateway-test-'))
  const workspace = join(root, 'ws')
  mkdirSync(workspace)
  const log = join(root, 'agy.log')
  const child = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      AGY_MCP_DATA_DIR: join(root, 'data'),
      AGY_MCP_COMMAND: process.execPath,
      AGY_MCP_COMMAND_PREFIX_ARGS: JSON.stringify([FAKE]),
      AGY_MCP_PROJECT_DIR: workspace,
      AGY_MCP_AUTO_LOGIN_WINDOW: 'false',
      AGY_MCP_PROXY: 'http://127.0.0.1:9',
      AGY_GATEWAY_PORT: '0',
      AGY_GATEWAY_TOKEN: TOKEN,
      AGY_GATEWAY_CWD: workspace,
      FAKE_AGY_LOG: log,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway did not report a port; stderr: ' + stderr)), 20_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      const match = /AGY_GATEWAY_READY (\{.*\})/.exec(chunk)
      if (match !== null) {
        clearTimeout(timer)
        resolve(JSON.parse(match[1]).port)
      }
    })
    child.once('exit', (code) => reject(new Error('gateway exited early (' + code + '); stderr: ' + stderr)))
  })
  t.after(async () => {
    child.kill()
    await new Promise((done) => {
      if (child.exitCode !== null) return done()
      child.once('exit', done)
      setTimeout(done, 5000)
    })
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
  const base = 'http://127.0.0.1:' + port
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
  const post = async (body, headers = {}) => {
    const res = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': TOKEN, ...headers },
      body: JSON.stringify(body),
    })
    return { status: res.status, json: await res.json().catch(() => undefined) }
  }
  const postStream = async (body) => {
    const res = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': TOKEN },
      body: JSON.stringify({ ...body, stream: true }),
    })
    const text = await res.text()
    return { status: res.status, text, events: parseSse(text) }
  }
  return { root, workspace, base, calls, post, postStream, stderr: () => stderr }
}

function parseSse(text) {
  const events = []
  for (const frame of text.split('\n\n')) {
    let event
    let data
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim()
      else if (line.startsWith('data: ')) data = line.slice(6)
    }
    if (event !== undefined && data !== undefined) {
      events.push({ event, data: data === '' ? undefined : JSON.parse(data) })
    }
  }
  return events
}

const user = (text) => ({ role: 'user', content: text })

test('health answers without auth; /v1/messages requires the token', async (t) => {
  const { base, post } = await startGateway(t)
  const health = await fetch(base + '/health')
  assert.equal(health.status, 200)
  assert.equal((await health.json()).ok, true)
  const denied = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(denied.status, 401)
  assert.equal((await denied.json()).error.type, 'authentication_error')
  const wrong = await post({ model: 'gemini-3.8-flash', messages: [user('hi')] }, { 'x-api-key': 'nope' })
  assert.equal(wrong.status, 401)
})

test('non-streaming request returns an Anthropic message with usage; agy runs in the gateway workspace', async (t) => {
  const { workspace, calls, post } = await startGateway(t)
  const { status, json } = await post({ model: 'gemini-3.8-flash', max_tokens: 1024, messages: [user('hello WRITE=made.txt')] })
  assert.equal(status, 200, JSON.stringify(json))
  assert.equal(json.type, 'message')
  assert.equal(json.role, 'assistant')
  assert.equal(json.stop_reason, 'end_turn')
  assert.equal(json.content.length, 1)
  assert.equal(json.content[0].type, 'text')
  assert.match(json.content[0].text, /^Echo: hello WRITE=made\.txt/)
  assert.equal(json.usage.input_tokens, 10)
  assert.equal(json.usage.output_tokens, 5)
  assert.ok(existsSync(join(workspace, 'made.txt')), 'agy must work in the gateway cwd')
  const [invocation] = calls()
  assert.ok(invocation.args.includes('--model') && invocation.args[invocation.args.indexOf('--model') + 1] === 'gemini-3.8-flash')
  assert.equal(invocation.args[invocation.args.indexOf('--effort') + 1], 'high')
  assert.equal(invocation.args[invocation.args.indexOf('--output-format') + 1], 'stream-json')
  assert.ok(invocation.args.includes('--dangerously-skip-permissions'))
  assert.match(invocation.prompt, /^hello WRITE=made\.txt/)
})

test('streaming request emits the full Anthropic SSE sequence', async (t) => {
  const { postStream } = await startGateway(t)
  const { status, events } = await postStream({ model: 'gemini-3.8-flash', messages: [user('stream me')] })
  assert.equal(status, 200)
  const names = events.map((entry) => entry.event)
  assert.equal(names[0], 'message_start')
  assert.ok(names.includes('content_block_start'))
  assert.ok(names.includes('content_block_stop'))
  assert.equal(names[names.length - 1], 'message_stop')
  const deltas = events.filter((entry) => entry.event === 'content_block_delta')
  assert.ok(deltas.length >= 2, 'fake agy emits two text deltas')
  const text = deltas.map((entry) => entry.data.delta.text).join('')
  assert.match(text, /^Echo: stream me/)
  const messageDelta = events.find((entry) => entry.event === 'message_delta')
  assert.equal(messageDelta.data.delta.stop_reason, 'end_turn')
  assert.equal(messageDelta.data.usage.output_tokens, 5)
  assert.equal(messageDelta.data.usage.input_tokens, 10)
  const start = events.find((entry) => entry.event === 'message_start')
  assert.equal(start.data.message.role, 'assistant')
})

test('second turn resumes the stored agy conversation and sends only the new message', async (t) => {
  // Suffixes off so the logged follow-up prompt equals the raw message text.
  const { calls, post } = await startGateway(t, { AGY_MCP_AVOID_BROWSER: 'false', AGY_MCP_AVOID_LARGE_READS: 'false' })
  const first = await post({ model: 'gemini-3.8-flash', messages: [user('first turn')] })
  assert.equal(first.status, 200)
  const second = await post({
    model: 'gemini-3.8-flash',
    messages: [user('first turn'), { role: 'assistant', content: first.json.content[0].text }, user('second turn')],
  })
  assert.equal(second.status, 200, JSON.stringify(second.json))
  assert.match(second.json.content[0].text, /Echo: second turn \(resumed conv-/)
  const [firstCall, secondCall] = calls()
  assert.ok(!firstCall.args.includes('--conversation'))
  assert.equal(secondCall.args[secondCall.args.indexOf('--conversation') + 1], firstCall.conversation)
  assert.equal(secondCall.prompt, 'second turn')
})

test('a completed follow-up consumes its prior history; branching replays instead of resuming a contaminated conversation', async (t) => {
  const { calls, post } = await startGateway(t, { AGY_MCP_AVOID_BROWSER: 'false', AGY_MCP_AVOID_LARGE_READS: 'false' })
  const first = await post({ model: 'gemini-3.8-flash', messages: [user('first')] })
  assert.equal(first.status, 200)
  const prefix = [user('first'), { role: 'assistant', content: first.json.content[0].text }]
  const second = await post({ model: 'gemini-3.8-flash', messages: [...prefix, user('second')] })
  assert.equal(second.status, 200)
  const branch = await post({ model: 'gemini-3.8-flash', messages: [...prefix, user('different branch')] })
  assert.equal(branch.status, 200)
  const [initialCall, resumedCall, branchCall] = calls()
  assert.equal(resumedCall.args[resumedCall.args.indexOf('--conversation') + 1], initialCall.conversation)
  assert.ok(!branchCall.args.includes('--conversation'))
  assert.match(branchCall.prompt, /\[Conversation history\]/)
})

test('model and valid request workspace are part of the resume route', async (t) => {
  const { root, workspace, calls, post } = await startGateway(t)
  const other = join(root, 'other-workspace')
  mkdirSync(other)
  const first = await post({ model: 'gemini-3.8-flash', messages: [user('first')], system: '<env>\nWorking directory: ' + other + '\n</env>' })
  assert.equal(first.status, 200)
  const history = [user('first'), { role: 'assistant', content: first.json.content[0].text }, user('second')]
  const differentModel = await post({ model: 'claude-sonnet-4-6', messages: history, system: '<env>\nWorking directory: ' + other + '\n</env>' })
  assert.equal(differentModel.status, 200)
  const differentWorkspace = await post({ model: 'gemini-3.8-flash', messages: history })
  assert.equal(differentWorkspace.status, 200)
  const fallback = await post({ model: 'gemini-3.8-flash', messages: [user('invalid')], system: 'Working directory: /this/path/should/not/exist' })
  assert.equal(fallback.status, 200)
  const [initialCall, modelCall, cwdCall, fallbackCall] = calls()
  assert.equal(initialCall.cwd, other)
  assert.ok(!modelCall.args.includes('--conversation'))
  assert.ok(!cwdCall.args.includes('--conversation'))
  assert.equal(cwdCall.cwd, workspace)
  assert.equal(fallbackCall.cwd, workspace)
})


test('unknown history prefix falls back to a transcript prompt without --conversation', async (t) => {
  const { calls, post } = await startGateway(t)
  const { status, json } = await post({
    model: 'gemini-3.8-flash',
    messages: [user('earlier'), { role: 'assistant', content: 'different answer' }, user('fresh ask')],
  })
  assert.equal(status, 200)
  const [invocation] = calls()
  assert.ok(!invocation.args.includes('--conversation'))
  assert.match(invocation.prompt, /\[Conversation history\]/)
  assert.match(invocation.prompt, /User: earlier/)
  assert.match(invocation.prompt, /Assistant: different answer/)
  assert.match(invocation.prompt, /\[The user now says\]\nfresh ask/)
})

test('agy failures map to Anthropic errors (HTTP before streaming, SSE event after)', async (t) => {
  const { post, postStream } = await startGateway(t)
  const failed = await post({ model: 'gemini-3.8-flash', messages: [user('FAIL')] })
  assert.equal(failed.status, 500)
  assert.equal(failed.json.error.type, 'api_error')
  assert.match(failed.json.error.message, /boom from fake agy/)
  const failedStream = await postStream({ model: 'gemini-3.8-flash', messages: [user('FAIL')] })
  assert.equal(failedStream.status, 200)
  const errorEvent = failedStream.events.find((entry) => entry.event === 'error')
  assert.ok(errorEvent, 'stream must carry an error event')
  assert.match(errorEvent.data.error.message, /boom from fake agy/)
  assert.equal(failedStream.events[failedStream.events.length - 1].event !== 'message_stop', true, 'no message_stop after an error')
})

test('oversized prompts travel over stdin (stream-json input)', async (t) => {
  // Suffixes off so the logged prompt equals what the gateway received verbatim.
  const { calls, post } = await startGateway(t, { AGY_MCP_AVOID_BROWSER: 'false', AGY_MCP_AVOID_LARGE_READS: 'false' })
  const long = 'x'.repeat(31_000) + ' tail'
  const { status, json } = await post({ model: 'gemini-3.8-flash', messages: [user(long)] })
  assert.equal(status, 200)
  assert.match(json.content[0].text, /^Echo: x{20}/)
  const [invocation] = calls()
  assert.equal(invocation.args[invocation.args.indexOf('--input-format') + 1], 'stream-json')
  assert.equal(invocation.prompt, long)
})

test('client abort cancels the run and the gateway keeps serving', async (t) => {
  const { base, post } = await startGateway(t)
  const controller = new AbortController()
  const res = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': TOKEN },
    body: JSON.stringify({ model: 'gemini-3.8-flash', stream: true, messages: [user('abort me SLEEP=15000')] }),
    signal: controller.signal,
  })
  assert.equal(res.status, 200)
  const reader = res.body.getReader()
  await reader.read()
  controller.abort()
  try {
    await reader.cancel()
  } catch {
    // already aborted
  }
  await sleep(300)
  const after = await post({ model: 'gemini-3.8-flash', messages: [user('still alive')] })
  assert.equal(after.status, 200)
  assert.match(after.json.content[0].text, /still alive/)
})

test('unknown model ids are rejected with an invalid_request_error', async (t) => {
  const { post } = await startGateway(t)
  const { status, json } = await post({ model: 'not-a-model', messages: [user('hi')] })
  assert.equal(status, 400)
  assert.equal(json.error.type, 'invalid_request_error')
  assert.match(json.error.message, /unknown AGY model "not-a-model"/)
})
