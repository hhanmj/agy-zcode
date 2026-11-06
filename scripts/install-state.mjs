// Read-only view of the agy-delegate plugin across its four copies, so a
// version mismatch between them is reported instead of discovered at runtime:
//
//   source    zcode/plugin/*.json + zcode/package.json
//   build     zcode/dist/market (what the agy-local marketplace points at)
//   mirror    <plugins>/marketplaces/agy-local (ZCode's snapshot of the build,
//             refreshed only by `zcode plugins marketplace update agy-local`)
//   installed <plugins>/cache/agy-local/agy-delegate/<version> (what runs)
//
// Nothing in this module writes to disk.
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const PLUGIN_NAME = 'agy-delegate'
export const MARKETPLACE_NAME = 'agy-local'
export const PLUGIN_ID = PLUGIN_NAME + '@' + MARKETPLACE_NAME

export function defaultPluginsRoot() {
  const override = process.env.AGY_ZCODE_PLUGINS_DIR
  if (override !== undefined && override.trim().length > 0) return resolve(override.trim())
  return join(homedir(), '.zcode', 'cli', 'plugins')
}

function readJson(file) {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Version baked into a bundle by build.mjs (`define: __AGY_MCP_VERSION__`). */
export function bundleVersion(file) {
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, 'utf8')
  const match = /\bVERSION = (?:true \? )?"([^"]+)" : "0\.0\.0-dev"/.exec(text)
  return match === null ? 'unknown' : match[1]
}

function sha256(file) {
  if (!existsSync(file)) return undefined
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function mtime(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return undefined
  }
}

function newestMtime(dir) {
  let newest = 0
  if (!existsSync(dir)) return newest
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const value = entry.isDirectory() ? newestMtime(full) : (mtime(full) ?? 0)
    if (value > newest) newest = value
  }
  return newest
}

function pluginCopy(dir) {
  const server = join(dir, 'server')
  return {
    dir,
    exists: existsSync(dir),
    manifestVersion: readJson(join(dir, '.zcode-plugin', 'plugin.json'))?.version,
    mcpBundleVersion: bundleVersion(join(server, 'agy-mcp.mjs')),
    mcpBundleSha256: sha256(join(server, 'agy-mcp.mjs')),
    gatewayBundleVersion: bundleVersion(join(server, 'agy-gateway.mjs')),
    mcpEnvKeys: Object.keys(readJson(join(dir, '.mcp.json'))?.mcpServers?.agy?.env ?? {}).sort(),
  }
}

function marketplaceVersion(file) {
  return readJson(file)?.plugins?.find((plugin) => plugin.name === PLUGIN_NAME)?.version
}

const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && resolve(a).toLowerCase() === resolve(b).toLowerCase()

/** Snapshot every copy. `zcodeDir` is the repo's zcode/ directory. */
export function collectState({ zcodeDir, pluginsRoot = defaultPluginsRoot() }) {
  const template = join(zcodeDir, 'plugin')
  const market = join(zcodeDir, 'dist', 'market')
  const builtPlugin = join(market, 'plugins', PLUGIN_NAME)

  const registry = readJson(join(pluginsRoot, 'installed_plugins.json'))
  const record = registry?.plugins?.find((plugin) => plugin.id === PLUGIN_ID)
  const known = readJson(join(pluginsRoot, 'known_marketplaces.json'))
  const knownMarket = known?.marketplaces?.find((entry) => entry.name === MARKETPLACE_NAME)
  const mirror = join(pluginsRoot, 'marketplaces', MARKETPLACE_NAME)

  const builtMcp = join(builtPlugin, 'server', 'agy-mcp.mjs')
  const sourceNewest = Math.max(newestMtime(join(zcodeDir, 'src')), newestMtime(template))

  return {
    pluginsRoot,
    source: {
      manifestVersion: readJson(join(template, '.zcode-plugin', 'plugin.json'))?.version,
      marketplaceVersion: marketplaceVersion(join(template, 'marketplace.json')),
      packageVersion: readJson(join(zcodeDir, 'package.json'))?.version,
      newestMtimeMs: sourceNewest,
    },
    build: {
      ...pluginCopy(builtPlugin),
      market,
      marketplaceVersion: marketplaceVersion(join(market, 'marketplace.json')),
      builtAtMs: mtime(builtMcp),
    },
    marketplace: {
      registered: knownMarket !== undefined,
      sourcePath: knownMarket?.source?.path,
      pointsAtBuild: samePath(knownMarket?.source?.path, market),
    },
    mirror: {
      ...pluginCopy(join(mirror, 'plugins', PLUGIN_NAME)),
      marketplaceVersion: marketplaceVersion(join(mirror, 'marketplace.json')),
    },
    installed: record === undefined
      ? { registered: false }
      : { registered: true, version: record.version, installPath: record.installPath, ...pluginCopy(record.installPath) },
  }
}

/**
 * Turn a snapshot into findings. `error` = the repo itself is inconsistent
 * (fix before building/installing); `warn` = ZCode is not running what the
 * repo builds; `info` = context.
 */
export function diagnose(state, { gatewayHealth } = {}) {
  const findings = []
  const add = (level, code, message) => findings.push({ level, code, message })
  const { source, build, marketplace, mirror, installed } = state
  const want = source.manifestVersion

  if (want === undefined) add('error', 'SOURCE_MANIFEST_MISSING', 'plugin/.zcode-plugin/plugin.json has no version')
  if (source.marketplaceVersion !== want) {
    add('error', 'SOURCE_VERSION_MISMATCH', 'plugin/marketplace.json lists ' + source.marketplaceVersion + ' but plugin.json is ' + want + ' (ZCode compares the marketplace version for updates)')
  }
  if (source.packageVersion !== want) {
    add('error', 'SOURCE_VERSION_MISMATCH', 'zcode/package.json is ' + source.packageVersion + ' but plugin.json is ' + want)
  }

  if (!build.exists || build.mcpBundleVersion === undefined) {
    add('error', 'BUILD_MISSING', 'dist/market has no built plugin; run npm run build')
  } else {
    for (const [label, value] of [['dist manifest', build.manifestVersion], ['dist marketplace.json', build.marketplaceVersion], ['agy-mcp.mjs', build.mcpBundleVersion], ['agy-gateway.mjs', build.gatewayBundleVersion]]) {
      if (value !== want) add('error', 'BUILD_STALE', label + ' is ' + value + ', source is ' + want + '; run npm run build')
    }
    if (build.builtAtMs !== undefined && source.newestMtimeMs > build.builtAtMs) {
      add('warn', 'BUILD_OLDER_THAN_SOURCE', 'zcode/src or zcode/plugin changed after the last build; run npm run build')
    }
  }

  if (!marketplace.registered) {
    add('info', 'MARKETPLACE_NOT_REGISTERED', 'ZCode does not know the ' + MARKETPLACE_NAME + ' marketplace; run zcode plugins marketplace add "' + build.market + '"')
  } else if (!marketplace.pointsAtBuild) {
    add('warn', 'MARKETPLACE_PATH_MISMATCH', MARKETPLACE_NAME + ' points at ' + marketplace.sourcePath + ', not this checkout (' + build.market + ')')
  }

  if (marketplace.registered && mirror.marketplaceVersion !== want) {
    add('warn', 'MIRROR_STALE', 'ZCode\'s marketplace snapshot still lists ' + mirror.marketplaceVersion + ' (source ' + want + '); `zcode plugins update` will report "up to date" until `zcode plugins marketplace update ' + MARKETPLACE_NAME + '` runs')
  }

  if (!installed.registered) {
    add('info', 'NOT_INSTALLED', PLUGIN_ID + ' is not installed')
  } else {
    if (!installed.exists) add('warn', 'INSTALL_MISSING', 'registry points at ' + installed.installPath + ' which does not exist')
    if (installed.version !== want) {
      add('warn', 'INSTALL_STALE', 'ZCode runs ' + PLUGIN_ID + ' ' + installed.version + ' from ' + installed.installPath + '; source is ' + want)
    }
    if (installed.exists && installed.mcpBundleVersion !== undefined && installed.mcpBundleVersion !== installed.manifestVersion) {
      add('warn', 'INSTALL_HOTPATCHED', 'installed agy-mcp.mjs reports ' + installed.mcpBundleVersion + ' but its manifest says ' + installed.manifestVersion + ': the cache was edited by hand. Port those changes into zcode/src before replacing it, or they are lost from the active install')
    } else if (installed.exists && installed.version === want && build.mcpBundleSha256 !== undefined && installed.mcpBundleSha256 !== build.mcpBundleSha256) {
      add('info', 'INSTALL_DIFFERS_FROM_BUILD', 'installed bundle has the source version but different bytes (rebuilt since install, or edited)')
    }
    if (installed.exists && installed.gatewayBundleVersion === undefined && build.gatewayBundleVersion !== undefined) {
      add('info', 'INSTALL_HAS_NO_GATEWAY', 'installed copy has no server/agy-gateway.mjs and its .mcp.json lacks AGY_GATEWAY_* env; gateway autostart only exists from ' + build.gatewayBundleVersion)
    }
  }

  if (gatewayHealth !== undefined && gatewayHealth.ok === true) {
    if (gatewayHealth.version !== want) {
      add('warn', 'GATEWAY_VERSION_SKEW', 'model gateway pid ' + gatewayHealth.pid + ' on the port reports ' + gatewayHealth.version + ' (source ' + want + '); autostart only pings /health, so it keeps serving until that process is stopped')
    } else if (installed.registered && installed.version !== want) {
      add('info', 'GATEWAY_NOT_FROM_INSTALL', 'gateway pid ' + gatewayHealth.pid + ' reports ' + gatewayHealth.version + ' but the installed plugin is ' + installed.version + ': it was started outside the plugin (e.g. node dist/.../agy-gateway.mjs)')
    }
  }

  return findings
}

/** GET /health on the local gateway; undefined when nothing answers. */
export async function probeGateway(port, timeoutMs = 800) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return undefined
    return await res.json()
  } catch {
    return undefined
  }
}
