// Version consistency across source / dist build / ZCode install, and the
// local-install script's safety rails (dry run, hot-patch refusal, rollback).
// Everything runs against a temporary fake ~/.zcode/cli/plugins.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_ID, bundleVersion, collectState, diagnose } from '../scripts/install-state.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ZCODE = join(here, '..')
const SCRIPT = join(ZCODE, 'scripts', 'local-install.mjs')
const MARKET = join(ZCODE, 'dist', 'market')
const BUILT = join(MARKET, 'plugins', 'agy-delegate')
const VERSION = JSON.parse(readFileSync(join(ZCODE, 'plugin', '.zcode-plugin', 'plugin.json'), 'utf8')).version
const codes = (findings) => findings.map((finding) => finding.code)

/** Fake plugins root with agy-delegate installed at `version`, optionally hand-patched. */
function fakePluginsRoot({ version, hotpatch = false, withGateway = false, mirrorVersion = version }) {
  const root = mkdtempSync(join(tmpdir(), 'agy-install-test-'))
  const cache = join(root, 'cache', 'agy-local', 'agy-delegate', version)
  mkdirSync(join(cache, 'server'), { recursive: true })
  mkdirSync(join(cache, '.zcode-plugin'), { recursive: true })
  writeFileSync(join(cache, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name: 'agy-delegate', version }))
  const bundleTag = hotpatch ? version + '-fix1' : version
  writeFileSync(join(cache, 'server', 'agy-mcp.mjs'), 'var VERSION = true ? "' + bundleTag + '" : "0.0.0-dev";\n')
  if (withGateway) writeFileSync(join(cache, 'server', 'agy-gateway.mjs'), 'var VERSION = true ? "' + version + '" : "0.0.0-dev";\n')
  writeFileSync(join(cache, '.mcp.json'), JSON.stringify({ mcpServers: { agy: { env: {} } } }))
  const other = { id: 'other@elsewhere', name: 'other', version: '9.9.9', installPath: join(root, 'other') }
  writeFileSync(join(root, 'installed_plugins.json'), JSON.stringify({
    version: 1,
    plugins: [other, { id: PLUGIN_ID, name: 'agy-delegate', marketplace: 'agy-local', version, installPath: cache, scope: 'user', source: './plugins/agy-delegate' }],
  }, null, 2))
  writeFileSync(join(root, 'known_marketplaces.json'), JSON.stringify({
    version: 1,
    marketplaces: [{ id: 'agy-local', name: 'agy-local', source: { source: 'directory', path: MARKET } }],
  }, null, 2))
  const mirror = join(root, 'marketplaces', 'agy-local')
  mkdirSync(mirror, { recursive: true })
  writeFileSync(join(mirror, 'marketplace.json'), JSON.stringify({ name: 'agy-local', plugins: [{ name: 'agy-delegate', version: mirrorVersion }] }))
  return { root, cache }
}

function runScript(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AGY_SKIP_GATEWAY_PROBE: '1', ...env },
  })
}

test('source manifests, package.json and the dist build agree on one version', () => {
  const state = collectState({ zcodeDir: ZCODE, pluginsRoot: mkdtempSync(join(tmpdir(), 'agy-empty-')) })
  assert.equal(state.source.marketplaceVersion, VERSION)
  assert.equal(state.source.packageVersion, VERSION)
  assert.equal(state.build.manifestVersion, VERSION)
  assert.equal(state.build.marketplaceVersion, VERSION)
  assert.equal(bundleVersion(join(BUILT, 'server', 'agy-mcp.mjs')), VERSION)
  assert.equal(bundleVersion(join(BUILT, 'server', 'agy-gateway.mjs')), VERSION)
  assert.deepEqual(diagnose(state).filter((finding) => finding.level === 'error'), [])
  // The gateway env must reach the MCP server, or autostart cannot be configured.
  assert.ok(state.build.mcpEnvKeys.includes('AGY_GATEWAY_AUTOSTART'))
  assert.ok(state.build.mcpEnvKeys.includes('AGY_GATEWAY_PORT'))
})

test('a stale, hand-patched install without a gateway is reported precisely', () => {
  const { root } = fakePluginsRoot({ version: '0.1.0', hotpatch: true })
  const found = codes(diagnose(collectState({ zcodeDir: ZCODE, pluginsRoot: root }), {
    gatewayHealth: { ok: true, version: VERSION, pid: 42 },
  }))
  for (const code of ['INSTALL_STALE', 'INSTALL_HOTPATCHED', 'MIRROR_STALE', 'INSTALL_HAS_NO_GATEWAY', 'GATEWAY_NOT_FROM_INSTALL']) {
    assert.ok(found.includes(code), code + ' missing from ' + found.join(', '))
  }
  assert.ok(!found.includes('MARKETPLACE_PATH_MISMATCH'))
})

test('an install matching the build has no warnings; an old gateway is flagged', () => {
  const { root } = fakePluginsRoot({ version: VERSION, withGateway: true })
  const state = collectState({ zcodeDir: ZCODE, pluginsRoot: root })
  const clean = diagnose(state, { gatewayHealth: { ok: true, version: VERSION, pid: 1 } })
  assert.deepEqual(clean.filter((finding) => finding.level !== 'info'), [])
  assert.ok(codes(diagnose(state, { gatewayHealth: { ok: true, version: '0.1.0', pid: 7 } })).includes('GATEWAY_VERSION_SKEW'))
})

test('install refuses to displace a hand-patched cache, even with --apply, and changes nothing', () => {
  const { root, cache } = fakePluginsRoot({ version: '0.1.0', hotpatch: true })
  const registryBefore = readFileSync(join(root, 'installed_plugins.json'), 'utf8')
  const result = runScript(['install', '--apply'], { AGY_ZCODE_PLUGINS_DIR: root, AGY_ZCODE_CLI: join(root, 'must-not-run') })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /edited by hand/)
  assert.equal(readFileSync(join(root, 'installed_plugins.json'), 'utf8'), registryBefore)
  assert.match(readFileSync(join(cache, 'server', 'agy-mcp.mjs'), 'utf8'), /0\.1\.0-fix1/)
})

test('install is a dry run by default', () => {
  const { root } = fakePluginsRoot({ version: '0.1.0' })
  const result = runScript(['install'], { AGY_ZCODE_PLUGINS_DIR: root, AGY_ZCODE_CLI: join(root, 'must-not-run') })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /Dry run/)
  assert.match(result.stdout, /zcode plugins marketplace update agy-local/)
  assert.match(result.stdout, /zcode plugins update agy-delegate@agy-local/)
})

test('install --apply backs up, drives the zcode CLI, and rollback restores only our entries', () => {
  const { root, cache: oldCache } = fakePluginsRoot({ version: '0.1.0' })
  // Fake `zcode`: logs argv and mimics marketplace refresh + update into a new cache dir.
  const fake = join(root, 'fake-zcode.mjs')
  writeFileSync(fake, [
    "import { appendFileSync, cpSync, readFileSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const root = process.env.AGY_ZCODE_PLUGINS_DIR',
    'const args = process.argv.slice(2)',
    "appendFileSync(join(root, 'zcode-calls.log'), args.join(' ') + '\\n')",
    "if (args[1] === 'marketplace') cpSync(" + JSON.stringify(MARKET) + ", join(root, 'marketplaces', 'agy-local'), { recursive: true })",
    "if (args[1] === 'update') {",
    "  const dest = join(root, 'cache', 'agy-local', 'agy-delegate', " + JSON.stringify(VERSION) + ')',
    '  cpSync(' + JSON.stringify(BUILT) + ', dest, { recursive: true })',
    "  const file = join(root, 'installed_plugins.json')",
    "  const reg = JSON.parse(readFileSync(file, 'utf8'))",
    "  const entry = reg.plugins.find((p) => p.id === 'agy-delegate@agy-local')",
    '  entry.version = ' + JSON.stringify(VERSION) + '; entry.installPath = dest',
    '  writeFileSync(file, JSON.stringify(reg, null, 2))',
    '}',
  ].join('\n'))
  const env = { AGY_ZCODE_PLUGINS_DIR: root, AGY_INSTALL_BACKUP_DIR: join(root, 'backups'), AGY_ZCODE_CLI: process.execPath, AGY_ZCODE_CLI_PREFIX_ARGS: JSON.stringify([fake]) }
  const result = runScript(['install', '--apply'], env)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(readFileSync(join(root, 'zcode-calls.log'), 'utf8').trim().split('\n'), ['plugins marketplace update agy-local', 'plugins update ' + PLUGIN_ID])
  const after = collectState({ zcodeDir: ZCODE, pluginsRoot: root })
  assert.equal(after.installed.version, VERSION)
  assert.equal(after.installed.mcpBundleVersion, VERSION)
  assert.ok(existsSync(oldCache), 'old cache dir must be kept')

  const backup = /Backup: (.+)/.exec(result.stdout)?.[1]?.trim()
  assert.ok(backup !== undefined && existsSync(join(backup, 'backup.json')), result.stdout)
  assert.ok(readdirSync(join(root, 'backups')).length > 0)

  // Something else changes the registry after our install; rollback must keep it.
  const regFile = join(root, 'installed_plugins.json')
  const reg = JSON.parse(readFileSync(regFile, 'utf8'))
  reg.plugins.push({ id: 'later@elsewhere', name: 'later', version: '1.0.0' })
  writeFileSync(regFile, JSON.stringify(reg))

  const dry = runScript(['rollback', backup], env)
  assert.equal(dry.status, 0, dry.stdout + dry.stderr)
  assert.equal(collectState({ zcodeDir: ZCODE, pluginsRoot: root }).installed.version, VERSION)

  const rolled = runScript(['rollback', backup, '--apply'], env)
  assert.equal(rolled.status, 0, rolled.stdout + rolled.stderr)
  const restored = JSON.parse(readFileSync(regFile, 'utf8'))
  assert.equal(restored.plugins.find((p) => p.id === PLUGIN_ID).version, '0.1.0')
  assert.ok(restored.plugins.some((p) => p.id === 'later@elsewhere'))
  assert.ok(restored.plugins.some((p) => p.id === 'other@elsewhere'))
  assert.equal(collectState({ zcodeDir: ZCODE, pluginsRoot: root }).mirror.marketplaceVersion, '0.1.0')
  assert.ok(existsSync(join(root, 'cache', 'agy-local', 'agy-delegate', VERSION)), 'rollback must not delete the newer cache dir')
})

test('status --json exits 0 for a consistent repo', () => {
  const { root } = fakePluginsRoot({ version: VERSION, withGateway: true })
  const result = runScript(['status', '--json'], { AGY_ZCODE_PLUGINS_DIR: root })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.installed.version, VERSION)
  assert.deepEqual(report.findings.filter((finding) => finding.level === 'error'), [])
})
