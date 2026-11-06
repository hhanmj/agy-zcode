// Packaging contract: manifest userConfig <-> .mcp.json env wiring, safe
// defaults (opt-in supervision/persistence, skip-permissions on), and the
// standalone supervisor hook bundle.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BUILT = join(here, '..', 'dist', 'market', 'plugins', 'agy-delegate')
const manifest = JSON.parse(readFileSync(join(BUILT, '.zcode-plugin', 'plugin.json'), 'utf8'))
const env = JSON.parse(readFileSync(join(BUILT, '.mcp.json'), 'utf8')).mcpServers.agy.env

test('every userConfig key is wired into the MCP env, and nothing else is referenced', () => {
  const referenced = new Set(Object.values(env).flatMap((value) => [...value.matchAll(/\$\{user_config\.([A-Za-z0-9_]+)\}/g)].map((match) => match[1])))
  assert.deepEqual([...referenced].sort(), Object.keys(manifest.userConfig).sort())
})

test('defaults: skip-permissions on, supervision and persistent sessions opt-in', () => {
  const config = manifest.userConfig
  assert.equal(config.skipPermissions.default, true)
  assert.equal(env.AGY_MCP_SKIP_PERMISSIONS, '${user_config.skipPermissions}')
  assert.equal(config.supervision.default, false)
  assert.equal(config.persistentSessions.default, false)
  assert.equal(env.AGY_MCP_SUPERVISION, '${user_config.supervision}')
  assert.equal(env.AGY_MCP_PERSISTENT, '${user_config.persistentSessions}')
  for (const [key, spec] of Object.entries(config)) {
    assert.equal(typeof spec.default, spec.type, key + ' default must match its type')
  }
})

test('supervisor-hook.mjs is self-contained and fails closed without a policy', () => {
  const hook = join(BUILT, 'server', 'supervisor-hook.mjs')
  const imports = [...readFileSync(hook, 'utf8').matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map((match) => match[1])
  assert.ok(imports.every((spec) => spec.startsWith('node:')), imports.join(', '))
  const result = spawnSync(process.execPath, [hook, 'PreToolUse'], { input: '{}', encoding: 'utf8', cwd: here, timeout: 30_000 })
  assert.equal(JSON.parse(result.stdout.trim()).decision, 'deny')
})

test('the panel surface is declared and the HTML resource is offline and self-contained', () => {
  const surface = manifest.ui.surfaces.find((s) => s.id === 'agy-panel')
  assert.equal(surface.server, 'agy')
  assert.equal(surface.resourceUri, 'ui://agy-delegate/panel.html')
  assert.equal(surface.availability, 'session')
  const html = readFileSync(join(BUILT, 'server', 'panel.html'), 'utf8')
  assert.ok(!/<script[^>]+src=/.test(html), 'no external script (the SDK is inlined)')
  assert.ok(!/<link[^>]+href=["']https?:/.test(html), 'no remote stylesheets or fonts')
  assert.ok(!/src=["']https?:/.test(html), 'no remote assets')
  assert.ok(Buffer.byteLength(html) < 4 * 1024 * 1024, 'host resource limit')
  // ext-apps SDK license notices travel with the bundle.
  assert.ok(html.includes('@license') || html.includes('MIT') || html.includes('Copyright'), 'third-party notices kept')
})
