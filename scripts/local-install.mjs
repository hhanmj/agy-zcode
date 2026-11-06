#!/usr/bin/env node
// Keep the installed agy-delegate plugin in step with this checkout.
//
//   node scripts/local-install.mjs status [--json]
//       Read-only report: source vs dist build vs ZCode marketplace snapshot
//       vs installed cache vs the running model gateway.
//
//   node scripts/local-install.mjs install [--apply] [--allow-hotpatch-replace]
//       Dry run unless --apply. With --apply: back up ZCode's registry entries
//       and marketplace snapshot to zcode/.install-backups/<stamp>/, then run
//       `zcode plugins marketplace update agy-local` and
//       `zcode plugins update agy-delegate@agy-local` (ZCode installs the new
//       version into a NEW cache/<version>/ directory; the old one is kept).
//       Refuses when the installed cache was hand-edited (INSTALL_HOTPATCHED)
//       unless --allow-hotpatch-replace is given.
//
//   node scripts/local-install.mjs rollback <backup-dir> [--apply]
//       Restore the agy-delegate registry entry, the agy-local marketplace
//       entry and the marketplace snapshot from a backup. Never deletes any
//       cache/<version>/ directory.
//
// AGY_ZCODE_PLUGINS_DIR overrides ~/.zcode/cli/plugins; AGY_ZCODE_CLI
// overrides the `zcode` executable; AGY_INSTALL_BACKUP_DIR overrides
// zcode/.install-backups.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MARKETPLACE_NAME, PLUGIN_ID, collectState, defaultPluginsRoot, diagnose, probeGateway } from './install-state.mjs'

const zcodeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const command = args[0] ?? 'status'
const flag = (name) => args.includes(name)
const pluginsRoot = defaultPluginsRoot()
const gatewayPort = Number(process.env.AGY_GATEWAY_PORT) > 0 ? Number(process.env.AGY_GATEWAY_PORT) : 8378

async function snapshot() {
  const state = collectState({ zcodeDir, pluginsRoot })
  const gatewayHealth = process.env.AGY_SKIP_GATEWAY_PROBE === '1' ? undefined : await probeGateway(gatewayPort)
  return { state, gatewayHealth, findings: diagnose(state, { gatewayHealth }) }
}

function printReport({ state, gatewayHealth, findings }) {
  const row = (label, value) => console.log('  ' + label.padEnd(28) + (value ?? '-'))
  console.log('agy-delegate versions (plugins root: ' + state.pluginsRoot + ')')
  row('source plugin.json', state.source.manifestVersion)
  row('source marketplace.json', state.source.marketplaceVersion)
  row('zcode/package.json', state.source.packageVersion)
  row('dist manifest', state.build.manifestVersion)
  row('dist agy-mcp.mjs', state.build.mcpBundleVersion)
  row('dist agy-gateway.mjs', state.build.gatewayBundleVersion)
  row('ZCode marketplace path', state.marketplace.sourcePath)
  row('ZCode marketplace snapshot', state.mirror.marketplaceVersion)
  row('installed (registry)', state.installed.version)
  row('installed path', state.installed.installPath)
  row('installed manifest', state.installed.manifestVersion)
  row('installed agy-mcp.mjs', state.installed.mcpBundleVersion)
  row('installed agy-gateway.mjs', state.installed.gatewayBundleVersion)
  row('gateway :' + gatewayPort + ' /health', gatewayHealth === undefined ? 'not answering' : gatewayHealth.version + ' (pid ' + gatewayHealth.pid + ')')
  console.log(findings.length === 0 ? 'OK: every copy matches ' + state.source.manifestVersion : 'Findings:')
  for (const finding of findings) console.log('  [' + finding.level + '] ' + finding.code + ': ' + finding.message)
}

function runZcode(zargs) {
  // AGY_ZCODE_CLI_PREFIX_ARGS (JSON array) lets tests run a fake CLI as
  // `<AGY_ZCODE_CLI> ...prefix ...args` without going through a shell.
  const prefix = process.env.AGY_ZCODE_CLI_PREFIX_ARGS ? JSON.parse(process.env.AGY_ZCODE_CLI_PREFIX_ARGS) : []
  const cli = process.env.AGY_ZCODE_CLI || 'zcode'
  console.log('$ zcode ' + zargs.join(' '))
  // The real `zcode` on Windows is a .cmd shim, which needs a shell.
  const result = spawnSync(cli, [...prefix, ...zargs], { stdio: 'inherit', shell: process.platform === 'win32' && prefix.length === 0 })
  if (result.status !== 0) throw new Error(cli + ' ' + zargs.join(' ') + ' exited with ' + (result.status ?? result.signal))
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeJsonAtomic(file, value) {
  const tmp = file + '.' + process.pid + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}

function backup(state) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(process.env.AGY_INSTALL_BACKUP_DIR || join(zcodeDir, '.install-backups'), stamp)
  mkdirSync(dir, { recursive: true })
  const registry = readJson(join(pluginsRoot, 'installed_plugins.json'))
  const known = readJson(join(pluginsRoot, 'known_marketplaces.json'))
  const meta = {
    createdAt: new Date().toISOString(),
    pluginsRoot,
    pluginEntry: registry.plugins.find((plugin) => plugin.id === PLUGIN_ID) ?? null,
    marketplaceEntry: known.marketplaces.find((entry) => entry.name === MARKETPLACE_NAME) ?? null,
    installedVersion: state.installed.version ?? null,
    installedBundleVersion: state.installed.mcpBundleVersion ?? null,
  }
  // Full copies too, for manual inspection; rollback only restores our entries.
  cpSync(join(pluginsRoot, 'installed_plugins.json'), join(dir, 'installed_plugins.json'))
  cpSync(join(pluginsRoot, 'known_marketplaces.json'), join(dir, 'known_marketplaces.json'))
  const mirror = join(pluginsRoot, 'marketplaces', MARKETPLACE_NAME)
  if (existsSync(mirror)) cpSync(mirror, join(dir, 'marketplace-snapshot'), { recursive: true })
  writeFileSync(join(dir, 'backup.json'), JSON.stringify(meta, null, 2) + '\n')
  return dir
}

function replaceEntry(list, match, entry) {
  const rest = list.filter((item) => !match(item))
  return entry === null ? rest : [...rest, entry]
}

async function install() {
  const apply = flag('--apply')
  const before = await snapshot()
  printReport(before)
  const { state, findings } = before
  const errors = findings.filter((finding) => finding.level === 'error')
  if (errors.length > 0) throw new Error('fix the source/build errors above first (npm run build)')
  if (!state.marketplace.registered) throw new Error('add the marketplace first: zcode plugins marketplace add "' + state.build.market + '"')
  if (!state.marketplace.pointsAtBuild) throw new Error(MARKETPLACE_NAME + ' points at another checkout; refusing to update from it')
  if (findings.some((finding) => finding.code === 'INSTALL_HOTPATCHED') && !flag('--allow-hotpatch-replace')) {
    throw new Error('the installed cache was edited by hand (see INSTALL_HOTPATCHED). Its directory would be kept, but ZCode would stop using it. Port the changes into zcode/src, rebuild, then rerun with --allow-hotpatch-replace')
  }
  const want = state.source.manifestVersion
  const upToDate = state.installed.registered && state.installed.version === want && state.mirror.marketplaceVersion === want
  if (upToDate) {
    console.log('Installed version already matches ' + want + '; nothing to do.')
    return
  }
  const steps = [['plugins', 'marketplace', 'update', MARKETPLACE_NAME], state.installed.registered ? ['plugins', 'update', PLUGIN_ID] : ['plugins', 'install', PLUGIN_ID, '--scope', 'user']]
  if (!apply) {
    console.log('Dry run. With --apply this would back up the registry entries to zcode/.install-backups/ and run:')
    for (const step of steps) console.log('  zcode ' + step.join(' '))
    return
  }
  const dir = backup(state)
  console.log('Backup: ' + dir)
  for (const step of steps) runZcode(step)
  const after = await snapshot()
  printReport(after)
  console.log('Rollback: node scripts/local-install.mjs rollback "' + dir + '" --apply')
  console.log('Restart ZCode sessions (or reload the agy MCP server) to pick up the new install. A gateway still reporting the old version must be stopped by pid; the next session autostarts the new one.')
}

function rollback() {
  const dir = args[1]
  if (dir === undefined || !existsSync(join(dir, 'backup.json'))) throw new Error('usage: local-install.mjs rollback <backup-dir> [--apply]')
  const meta = readJson(join(dir, 'backup.json'))
  if (resolve(meta.pluginsRoot).toLowerCase() !== resolve(pluginsRoot).toLowerCase()) throw new Error('backup was taken for ' + meta.pluginsRoot + ', not ' + pluginsRoot)
  const registryFile = join(pluginsRoot, 'installed_plugins.json')
  const knownFile = join(pluginsRoot, 'known_marketplaces.json')
  const mirror = join(pluginsRoot, 'marketplaces', MARKETPLACE_NAME)
  console.log('Restore ' + PLUGIN_ID + ' registry entry -> ' + (meta.pluginEntry?.version ?? '(not installed)') + ' at ' + (meta.pluginEntry?.installPath ?? '-'))
  console.log('Restore ' + MARKETPLACE_NAME + ' marketplace entry and snapshot from ' + dir)
  if (meta.pluginEntry !== null && !existsSync(meta.pluginEntry.installPath)) throw new Error('backed-up install path no longer exists: ' + meta.pluginEntry.installPath)
  if (!flag('--apply')) {
    console.log('Dry run; add --apply.')
    return
  }
  const registry = readJson(registryFile)
  registry.plugins = replaceEntry(registry.plugins, (plugin) => plugin.id === PLUGIN_ID, meta.pluginEntry)
  writeJsonAtomic(registryFile, registry)
  const known = readJson(knownFile)
  known.marketplaces = replaceEntry(known.marketplaces, (entry) => entry.name === MARKETPLACE_NAME, meta.marketplaceEntry)
  writeJsonAtomic(knownFile, known)
  const snapshotDir = join(dir, 'marketplace-snapshot')
  if (existsSync(snapshotDir)) {
    rmSync(mirror, { recursive: true, force: true })
    cpSync(snapshotDir, mirror, { recursive: true })
  }
  console.log('Rolled back. Newer cache/<version>/ directories were left in place. Restart ZCode sessions.')
}

try {
  if (command === 'status') {
    const result = await snapshot()
    if (flag('--json')) console.log(JSON.stringify({ ...result.state, gatewayHealth: result.gatewayHealth ?? null, findings: result.findings }, null, 2))
    else printReport(result)
    process.exitCode = result.findings.some((finding) => finding.level === 'error') ? 1 : 0
  } else if (command === 'install') {
    await install()
  } else if (command === 'rollback') {
    rollback()
  } else {
    throw new Error('unknown command ' + command + ' (status | install | rollback)')
  }
} catch (error) {
  console.error('local-install: ' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
}
