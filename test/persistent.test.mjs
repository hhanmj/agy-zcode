// Persistent agy sessions (AGY_MCP_PERSISTENT) end to end through the built
// MCP server with a stream-json fake that keeps one process per session.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { alive, sleep, startServer, taskOf, waitFor } from './helpers/harness.mjs'

const PERSISTENT = { AGY_MCP_PERSISTENT: 'true' }
const pidsOf = (calls) => [...new Set(calls.map((c) => c.pid))]

test('persistent off by default: every turn is its own -p process', async (t) => {
  const { call, calls } = await startServer(t)
  const run = await call('agy_run', { description: 'one', prompt: 'first' })
  await call('agy_followup', { task: taskOf(run.text), prompt: 'second' })
  const [a, b] = calls()
  assert.ok(a.args.includes('-p') && b.args.includes('-p'))
  assert.notEqual(a.pid, b.pid)
  assert.equal(b.args[b.args.indexOf('--conversation') + 1], a.conversation)
})

test('follow-ups reuse one warm agy process and conversation; evidence and registry still work', async (t) => {
  const { call, calls, workspace } = await startServer(t, { env: PERSISTENT })
  const first = await call('agy_run', { description: 'warm', prompt: 'first WRITE=one.txt' })
  assert.equal(first.isError, false, first.text)
  const task = taskOf(first.text)
  assert.match(first.text, /turn 1\]/)
  assert.match(first.text, /\[evidence: 1 file\(s\) changed/)
  const second = await call('agy_followup', { task, prompt: 'second' })
  const third = await call('agy_followup', { task, prompt: 'third', background: true })
  assert.match(second.text, /turn 2\]/)
  const status = await call('agy_status', { task, wait_seconds: 20 })
  assert.match(status.text, /status: completed/)
  assert.match(status.text, /turn 3\]/)
  assert.ok(existsSync(join(workspace, 'one.txt')))
  const turns = calls()
  assert.equal(turns.length, 3)
  assert.equal(pidsOf(turns).length, 1, 'one process served all three turns')
  assert.deepEqual(turns.map((c) => c.turn), [1, 2, 3])
  const argv = turns[0].args
  assert.ok(!argv.includes('-p') && !argv.includes('--print-timeout'))
  assert.equal(argv[argv.indexOf('--input-format') + 1], 'stream-json')
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json')
  assert.ok(argv.includes('--dangerously-skip-permissions'))
  assert.ok(!argv.includes('--conversation'), 'a new task starts a new conversation')
  const tasks = await call('agy_tasks')
  assert.match(tasks.text, new RegExp('task ' + task + ' \\| warm'))
  const trace = await call('agy_trace', { id: task, limit: 200 })
  assert.match(trace.text, /process pid=\d+ turn=1 new/)
  assert.match(trace.text, /process pid=\d+ turn=3 reused/)
})

test('a changed model restarts the process on the same conversation; a failed turn keeps it', async (t) => {
  const { call, calls } = await startServer(t, { env: PERSISTENT })
  const first = await call('agy_run', { description: 'm', prompt: 'first' })
  const task = taskOf(first.text)
  const failed = await call('agy_followup', { task, prompt: 'FAIL please' })
  assert.equal(failed.isError, true)
  assert.match(failed.text, /boom from fake agy/)
  const switched = await call('agy_followup', { task, prompt: 'other model', model: 'claude-sonnet-4-6' })
  assert.equal(switched.isError, false, switched.text)
  const [a, b, c] = calls()
  assert.equal(a.pid, b.pid, 'an ERROR result does not end the session')
  assert.notEqual(c.pid, a.pid)
  assert.equal(c.args[c.args.indexOf('--conversation') + 1], a.conversation)
  assert.equal(c.args[c.args.indexOf('--model') + 1], 'claude-sonnet-4-6')
  assert.ok(await waitFor(() => !alive(a.pid), 10_000), 'the old process was closed')
})

test('cancel kills the process; the next follow-up resumes the conversation in a new one', async (t) => {
  const { call, calls } = await startServer(t, { env: PERSISTENT })
  const first = await call('agy_run', { description: 'c', prompt: 'first' })
  const task = taskOf(first.text)
  await call('agy_followup', { task, prompt: 'slow SLEEP=20000', background: true })
  assert.ok(await waitFor(() => calls().length === 2))
  const cancelled = await call('agy_cancel', { task })
  assert.match(cancelled.text, /status now: cancelled/)
  const pid = calls()[0].pid
  assert.ok(await waitFor(() => !alive(pid), 10_000), 'the persistent process was killed')
  const after = await call('agy_followup', { task, prompt: 'after cancel' })
  assert.equal(after.isError, false, after.text)
  assert.match(after.text, /turn 1 resumed\]/)
  const last = calls().at(-1)
  assert.notEqual(last.pid, pid)
  assert.equal(last.args[last.args.indexOf('--conversation') + 1], calls()[0].conversation)
})

test('a process that dies mid-turn is reported as failed, never completed', async (t) => {
  const { call, calls } = await startServer(t, { env: PERSISTENT })
  const first = await call('agy_run', { description: 'lost', prompt: 'first' })
  const task = taskOf(first.text)
  const lost = await call('agy_followup', { task, prompt: 'die EXIT' })
  assert.equal(lost.isError, true)
  assert.match(lost.text, /agy run failed: .*exited without a result/s)
  const next = await call('agy_followup', { task, prompt: 'next' })
  assert.equal(next.isError, false, next.text)
  assert.notEqual(calls().at(-1).pid, calls()[0].pid)
})

test('idle processes are closed after AGY_MCP_PERSISTENT_IDLE_MS; slash prompts run one-shot', async (t) => {
  const { call, calls } = await startServer(t, { env: { ...PERSISTENT, AGY_MCP_PERSISTENT_IDLE_MS: '300' } })
  const first = await call('agy_run', { description: 'idle', prompt: 'first' })
  const pid = calls()[0].pid
  assert.ok(await waitFor(() => !alive(pid), 10_000), 'idle process closed')
  const slash = await call('agy_followup', { task: taskOf(first.text), prompt: '/help me' })
  assert.equal(slash.isError, false, slash.text)
  assert.ok(calls().at(-1).args.includes('-p'), 'a slash prompt never reaches the streaming stdin')
})

test('closing the server kills persistent processes', async (t) => {
  const { call, calls, close } = await startServer(t, { env: PERSISTENT })
  await call('agy_run', { description: 'bye', prompt: 'first' })
  const pid = calls()[0].pid
  assert.equal(alive(pid), true, 'warm process stays alive between turns')
  await close()
  assert.ok(await waitFor(() => !alive(pid), 10_000), 'no orphaned agy process after shutdown')
})

test('persistent + supervision: one supervisor per process, decisions sliced per turn, files removed on close', async (t) => {
  const { call, calls, close, dataDir } = await startServer(t, { env: { ...PERSISTENT, AGY_MCP_SUPERVISION: 'true', AGY_MCP_SUPERVISION_DENY_COMMANDS: '["FORBIDDEN_CMD"]' } })
  const first = await call('agy_run', { description: 'sup', prompt: 'one CMD=echo FORBIDDEN_CMD' })
  const task = taskOf(first.text)
  await call('agy_followup', { task, prompt: 'two CMD=echo fine' })
  const [a, b] = calls()
  assert.equal(a.pid, b.pid)
  assert.equal(a.hookDirs.length, 1)
  assert.deepEqual(b.hookDirs, a.hookDirs, 'the process keeps its supervisor directory')
  assert.match(a.prompt, /attached only for DSH supervision hooks/)
  assert.match(b.prompt, /attached only for DSH supervision hooks/, 'every turn carries the note')
  assert.equal(readdirSync(join(dataDir, 'agy-supervisor')).length, 1, 'the directory lives as long as the process')
  const trace = await call('agy_trace', { id: task, limit: 200 })
  assert.equal((trace.text.match(/PreToolUse decision=deny rule=custom-deny/g) ?? []).length, 1, 'the denial is attributed to turn 1 only')
  assert.doesNotMatch(trace.text, /supervision_tamper/)
  await close()
  await sleep(500)
  assert.ok(await waitFor(() => readdirSync(join(dataDir, 'agy-supervisor')).length === 0, 10_000), 'supervisor directory removed when the process closed')
})
