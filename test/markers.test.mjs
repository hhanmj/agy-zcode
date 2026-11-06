// Active-run markers: a run lost to a crashed MCP server is reported as lost
// (and stays resumable thanks to the early registry write); a run live in
// another ZCode session (another server on the same data dir) is visible and
// blocks follow-ups there.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { alive, startServer, taskOf, tempRoot, waitFor } from './helpers/harness.mjs'

const markers = (dataDir) => {
  const dir = join(dataDir, 'active-runs')
  return existsSync(dir) ? readdirSync(dir).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8'))) : []
}

test('a run lost to a crashed server is reported as lost and resumable; the marker clears after a follow-up', async (t) => {
  const root = tempRoot(t, 'agy-marker-lost-')
  const a = await startServer(t, { root })
  const started = await a.call('agy_run', { description: 'doomed', prompt: 'long SLEEP=30000', background: true })
  const task = taskOf(started.text)
  assert.ok(await waitFor(() => markers(a.dataDir).length === 1 && a.calls().length === 1))
  const [marker] = markers(a.dataDir)
  assert.equal(marker.task, task)
  // Crash: hard-kill the server (no graceful shutdown, so the marker stays), then the orphaned fake.
  process.kill(marker.serverPid)
  assert.ok(await waitFor(() => !alive(marker.serverPid)))
  const orphan = a.calls()[0].pid
  if (alive(orphan)) process.kill(orphan)

  const b = await startServer(t, { root })
  const status = await b.call('agy_status', { task })
  assert.equal(status.isError, true)
  assert.match(status.text, /was LOST/)
  assert.match(status.text, /Last recorded conversation for this task: conv-/, 'the conversation was recorded before the crash')
  const tasks = await b.call('agy_tasks')
  assert.match(tasks.text, /Lost to MCP server restart \(1 task/)
  const cancel = await b.call('agy_cancel', { task })
  assert.match(cancel.text, /lost to an MCP server restart/)

  const resumed = await b.call('agy_followup', { task, prompt: 'pick up' })
  assert.equal(resumed.isError, false, resumed.text)
  const last = b.calls().at(-1)
  assert.equal(last.args[last.args.indexOf('--conversation') + 1], a.calls()[0].conversation)
  const after = await b.call('agy_tasks')
  assert.doesNotMatch(after.text, /Lost to MCP server restart/, 'a newer finished run supersedes the lost marker')
  assert.equal(markers(b.dataDir).length, 0)
})

test('a run live in another session is listed there and blocks a concurrent follow-up', async (t) => {
  const root = tempRoot(t, 'agy-marker-foreign-')
  const a = await startServer(t, { root })
  const b = await startServer(t, { root })
  const first = await a.call('agy_run', { description: 'shared', prompt: 'first' })
  const task = taskOf(first.text)
  await a.call('agy_followup', { task, prompt: 'slow SLEEP=20000', background: true })
  assert.ok(await waitFor(() => a.calls().length === 2))

  const status = await b.call('agy_status', { task })
  assert.match(status.text, /currently running in another ZCode session/)
  const tasks = await b.call('agy_tasks')
  assert.match(tasks.text, /Running in other ZCode session\(s\) \(1 task/)
  const clash = await b.call('agy_followup', { task, prompt: 'me too' })
  assert.equal(clash.isError, true)
  assert.match(clash.text, /running in another ZCode session/)
  assert.equal(a.calls().length, 2, 'no second agy process on the same conversation')

  const cancelled = await a.call('agy_cancel', { task })
  assert.match(cancelled.text, /status now: cancelled/)
  const now = await b.call('agy_followup', { task, prompt: 'my turn' })
  assert.equal(now.isError, false, now.text)
})
