// Hook supervision (AGY_MCP_SUPERVISION) end to end through the built MCP
// server: the fake agy loads .agents/hooks.json from the supervisor --add-dir
// and runs the real compiled hook (server/supervisor-hook.mjs), exactly like
// agy 1.4.x does.
import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SERVER, startServer, taskOf, tempRoot } from './helpers/harness.mjs'

const SUPERVISED = { AGY_MCP_SUPERVISION: 'true', AGY_MCP_SUPERVISION_DENY_COMMANDS: '["FORBIDDEN_CMD"]' }
const supervisorDirs = (dataDir) => (existsSync(join(dataDir, 'agy-supervisor')) ? readdirSync(join(dataDir, 'agy-supervisor')) : [])

test('supervision off by default: no supervisor directory, no policy env', async (t) => {
  const { call, calls, dataDir } = await startServer(t)
  const run = await call('agy_run', { description: 'plain', prompt: 'hello CMD=echo FORBIDDEN_CMD' })
  assert.equal(run.isError, false, run.text)
  const [turn] = calls()
  assert.equal(turn.policy, null)
  assert.deepEqual(turn.hookDirs, [])
  assert.equal(supervisorDirs(dataDir).length, 0)
})

test('one-shot run: the real hook denies a configured command, decisions reach the trace, files are removed', async (t) => {
  const { call, calls, dataDir, workspace } = await startServer(t, { env: SUPERVISED })
  const run = await call('agy_run', { description: 'supervised', prompt: 'deny me\nCMD=echo FORBIDDEN_CMD now' })
  assert.equal(run.isError, false, run.text)
  const task = taskOf(run.text)
  const [turn] = calls()
  assert.equal(turn.hookDirs.length, 1, 'the supervisor directory is passed with --add-dir')
  assert.ok(turn.hookDirs[0].startsWith(join(dataDir, 'agy-supervisor')), 'default supervision dir lives in the plugin data dir')
  assert.ok(turn.policy !== null && turn.policy.startsWith(turn.hookDirs[0]), 'DSH_AGY_SUPERVISOR_POLICY reaches agy')
  assert.ok(turn.protectedPaths.includes(dataDir), 'the hook protects its token and registry directory')
  assert.ok(turn.args.includes('--dangerously-skip-permissions'), 'skipPermissions stays on')
  assert.match(turn.prompt, /attached only for DSH supervision hooks/)
  assert.ok(turn.prompt.includes(workspace))
  assert.equal(supervisorDirs(dataDir).length, 0, 'per-run supervisor files are removed after the run')

  const trace = await call('agy_trace', { id: task, limit: 200 })
  assert.match(trace.text, /PreToolUse decision=deny rule=custom-deny/)
  assert.match(trace.text, /tool_result step \d+ run_command ERROR .*denied by pre-tool hook/)
  assert.doesNotMatch(trace.text, /supervision_tamper/)
})

test('an allowed command runs normally under supervision', async (t) => {
  const { call, calls } = await startServer(t, { env: SUPERVISED })
  const run = await call('agy_run', { description: 'allowed', prompt: 'fine CMD=echo hello' })
  assert.equal(run.isError, false, run.text)
  const trace = await call('agy_trace', { id: taskOf(run.text), limit: 200 })
  assert.match(trace.text, /run_command DONE/)
  assert.doesNotMatch(trace.text, /decision=deny/)
  assert.equal(calls().length, 1)
})

test('supervision fails closed without skipPermissions (agy never starts)', async (t) => {
  const { call, calls } = await startServer(t, { env: { ...SUPERVISED, AGY_MCP_SKIP_PERMISSIONS: 'false' } })
  const run = await call('agy_run', { description: 'x', prompt: 'go' })
  assert.equal(run.isError, true)
  assert.match(run.text, /supervision is enabled but cannot be applied: it requires skipPermissions/)
  assert.equal(calls().length, 0)
})

test('supervision fails closed when the hook script is missing next to the bundle', async (t) => {
  const root = tempRoot(t, 'agy-sup-nohook-')
  const lonely = join(root, 'server')
  mkdirSync(lonely)
  copyFileSync(SERVER, join(lonely, 'agy-mcp.mjs'))
  const { call, calls } = await startServer(t, { root, server: join(lonely, 'agy-mcp.mjs'), env: SUPERVISED })
  const run = await call('agy_run', { description: 'x', prompt: 'go' })
  assert.equal(run.isError, true)
  assert.match(run.text, /supervisor hook script was not found/)
  assert.equal(calls().length, 0)

  // An explicit AGY_MCP_SUPERVISOR_HOOK path makes it work again.
  const fixed = await startServer(t, { root: join(root, 'second'), server: join(lonely, 'agy-mcp.mjs'), env: { ...SUPERVISED, AGY_MCP_SUPERVISOR_HOOK: join(SERVER, '..', 'supervisor-hook.mjs') } })
  const ok = await fixed.call('agy_run', { description: 'x', prompt: 'go CMD=echo FORBIDDEN_CMD' })
  assert.equal(ok.isError, false, ok.text)
  assert.equal(fixed.calls()[0].hookDirs.length, 1)
})
