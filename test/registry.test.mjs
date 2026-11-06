// Task registry robustness: cross-process lock, strict reads, stale-lock
// recovery, and the gateway's separate registry (with one-time migration).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { build } from 'esbuild'
import { FAKE, GATEWAY, ZCODE, tempRoot } from './helpers/harness.mjs'

const WORKER = join(ZCODE, 'test', 'helpers', 'registry-worker.mjs')

/** Bundle the runner, config and lock helpers into one ESM file for direct use (esbuild may not write to %TEMP% under sandboxes). */
async function runnerBundle(t, root) {
  const outfile = join(ZCODE, 'dist', 'test', basename(root), 'runner-bundle.mjs')
  t.after(() => rmSync(dirname(outfile), { recursive: true, force: true }))
  await build({
    stdin: {
      contents: "export { AgyRunner } from './src/runner.ts'\nexport { loadConfig } from './src/config.ts'\nexport * from './src/filelock.ts'\n",
      resolveDir: ZCODE,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'silent',
  })
  return import('file:///' + outfile.replace(/\\/g, '/'))
}

function runWorker(bundle, dataDir, prefix, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, bundle, dataDir, prefix, String(count)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.once('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error('worker exited ' + code + ': ' + err))))
  })
}

const registry = (dataDir, name = 'tasks.json') => JSON.parse(readFileSync(join(dataDir, name), 'utf8'))

test('concurrent writers in several processes never lose registry updates', async (t) => {
  const root = tempRoot(t, 'agy-reg-')
  await runnerBundle(t, root)
  const bundle = join(ZCODE, 'dist', 'test', basename(root), 'runner-bundle.mjs')
  const dataDir = join(root, 'data')
  const workers = 4
  const each = 20
  const results = await Promise.all(Array.from({ length: workers }, (_, w) => runWorker(bundle, dataDir, 'w' + w, each)))
  for (const result of results) {
    assert.equal(result.ok, each, 'every update reports success: ' + result.errors.join('; '))
  }
  const keys = Object.keys(registry(dataDir))
  assert.equal(keys.length, workers * each, 'all ' + workers * each + ' records survive')
  assert.equal(existsSync(join(dataDir, 'tasks.json.lock')), false, 'the lock is released')
})

test('strict read: only a missing file counts as empty; other read errors abort the write', async (t) => {
  const root = tempRoot(t, 'agy-reg-')
  const mod = await runnerBundle(t, root)
  assert.equal(await mod.readFileIfExists(join(root, 'missing.json')), undefined)
  const dir = join(root, 'is-a-dir')
  mkdirSync(dir)
  await assert.rejects(mod.readFileIfExists(dir), (error) => error.code === 'EISDIR' || error.code === 'EPERM' || error.code === 'EACCES')

  // A registry path that cannot be read must not be "repaired" by an overwrite.
  const dataDir = join(root, 'data')
  mkdirSync(join(dataDir, 'tasks.json'), { recursive: true })
  process.env.AGY_MCP_DATA_DIR = dataDir
  const logs = []
  const runner = new mod.AgyRunner({ ...mod.loadConfig(), dataDir, traceEnabled: false }, (message) => logs.push(message))
  delete process.env.AGY_MCP_DATA_DIR
  const ok = await runner.updateRegistry((records) => { records.x = { conversationId: 'c', cwd: root, label: '', createdAt: 1 } })
  assert.equal(ok, false)
  assert.match(logs.join('\n'), /failed to persist task registry/)
  assert.equal(existsSync(join(dataDir, 'tasks.json.lock')), false)
})

test('corrupt registry is backed up and replaced; lock helpers recover stale locks', async (t) => {
  const root = tempRoot(t, 'agy-reg-')
  const mod = await runnerBundle(t, root)
  const dataDir = join(root, 'data')
  mkdirSync(dataDir)
  writeFileSync(join(dataDir, 'tasks.json'), '{ not json')
  const runner = new mod.AgyRunner({ ...mod.loadConfig(), dataDir, traceEnabled: false }, () => {})
  assert.equal(await runner.updateRegistry((records) => { records.a = { conversationId: 'c', cwd: root, label: '', createdAt: 1 } }), true)
  assert.equal(readFileSync(join(dataDir, 'tasks.json.corrupt'), 'utf8'), '{ not json')
  assert.deepEqual(Object.keys(registry(dataDir)), ['a'])

  // Dead holder: broken immediately.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  const lock = join(root, 'x.lock')
  writeFileSync(lock, JSON.stringify({ pid: Number(dead.stdout), token: 't', ts: Date.now() }))
  const started = Date.now()
  assert.equal(await mod.withFileLock(lock, () => 'ran', { timeoutMs: 2000 }), 'ran')
  assert.ok(Date.now() - started < 1500, 'a dead holder does not make us wait')
  assert.equal(existsSync(lock), false)

  // Live holder: respected until the timeout ...
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'other', ts: Date.now() }))
  await assert.rejects(mod.withFileLock(lock, () => 'never', { timeoutMs: 300 }), /timed out after 300 ms waiting for .*held by pid/)
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, 'other', 'someone else\'s lock is never removed on release')
  // ... unless it is older than staleMs (holder hung or pid reused).
  const past = new Date(Date.now() - 60_000)
  utimesSync(lock, past, past)
  assert.equal(await mod.withFileLock(lock, () => 'ran', { timeoutMs: 2000, staleMs: 10_000 }), 'ran')
  assert.equal(existsSync(lock), false)
})

test('the gateway uses gateway-tasks.json and migrates its own records out of tasks.json once', async (t) => {
  const root = tempRoot(t, 'agy-reg-gw-')
  const dataDir = join(root, 'data')
  const workspace = join(root, 'ws')
  mkdirSync(dataDir)
  mkdirSync(workspace)
  const record = (label) => ({ conversationId: 'conv-' + label, cwd: workspace, label, createdAt: Date.now() })
  writeFileSync(join(dataDir, 'tasks.json'), JSON.stringify({ 'agy-mcp-1': record('mcp task'), 'agy-gw-1': record('zcode gemini') }))
  writeFileSync(join(dataDir, 'gateway-conversations.json'), JSON.stringify({ somehash: { task: 'agy-gw-1', conversationId: 'conv-zcode gemini', cwd: workspace, turns: 2, updatedAt: Date.now() } }))
  const child = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      AGY_MCP_DATA_DIR: dataDir,
      AGY_MCP_COMMAND: process.execPath,
      AGY_MCP_COMMAND_PREFIX_ARGS: JSON.stringify([FAKE]),
      AGY_MCP_AUTO_LOGIN_WINDOW: 'false',
      AGY_MCP_PROXY: 'http://127.0.0.1:9',
      AGY_GATEWAY_PORT: '0',
      AGY_GATEWAY_TOKEN: 'tok',
      AGY_GATEWAY_CWD: workspace,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  t.after(async () => {
    child.kill()
    await new Promise((done) => (child.exitCode !== null ? done() : child.once('exit', done)))
  })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no READY line; stderr: ' + stderr)), 20_000)
    child.stdout.on('data', (chunk) => {
      const match = /AGY_GATEWAY_READY (\{.*\})/.exec(String(chunk))
      if (match) {
        clearTimeout(timer)
        resolve(JSON.parse(match[1]).port)
      }
    })
    child.once('exit', (code) => reject(new Error('gateway exited ' + code + ': ' + stderr)))
  })
  assert.deepEqual(Object.keys(registry(dataDir, 'gateway-tasks.json')), ['agy-gw-1'])
  assert.deepEqual(Object.keys(registry(dataDir)), ['agy-mcp-1'], 'MCP tasks stay; gateway tasks moved out')
  assert.match(stderr, /moved 1 gateway task record/)

  const res = await fetch('http://127.0.0.1:' + port + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'tok' },
    body: JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'fresh chat' }] }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  assert.equal(Object.keys(registry(dataDir, 'gateway-tasks.json')).length, 2, 'new chat recorded in the gateway registry')
  assert.deepEqual(Object.keys(registry(dataDir)), ['agy-mcp-1'], 'tasks.json untouched by chat traffic')
})
