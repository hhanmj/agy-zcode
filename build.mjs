// Build the ZCode plugin: bundle the MCP server with esbuild and lay out a
// local plugin marketplace under dist/market (add that directory in ZCode).
import { build } from 'esbuild'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const template = join(here, 'plugin')
const market = join(here, 'dist', 'market')
const pluginDir = join(market, 'plugins', 'agy-delegate')
const templateMarketplace = join(template, 'marketplace.json')

const manifest = JSON.parse(readFileSync(join(template, '.zcode-plugin', 'plugin.json'), 'utf8'))
const marketplace = JSON.parse(readFileSync(templateMarketplace, 'utf8'))
const entry = marketplace.plugins.find((plugin) => plugin.name === manifest.name)
if (entry === undefined || entry.version !== manifest.version) {
  throw new Error('marketplace.json must list ' + manifest.name + ' with version ' + manifest.version + ' (ZCode compares them for updates)')
}
// One version everywhere: the manifest is the source of truth, and the same
// string is baked into both bundles (agy-mcp serverInfo, gateway /health).
const packageVersion = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version
if (packageVersion !== manifest.version) {
  throw new Error('zcode/package.json version ' + packageVersion + ' must equal plugin.json version ' + manifest.version)
}

rmSync(market, { recursive: true, force: true })
mkdirSync(pluginDir, { recursive: true })
cpSync(template, pluginDir, { recursive: true, filter: (src) => src !== templateMarketplace })
writeFileSync(join(market, 'marketplace.json'), JSON.stringify(marketplace, null, 2) + '\n')
const license = [join(here, 'LICENSE'), join(here, '..', 'LICENSE')].find((file) => existsSync(file))
if (license === undefined) throw new Error('LICENSE not found in repo root or parent')
copyFileSync(license, join(pluginDir, 'LICENSE'))

await build({
  entryPoints: [join(here, 'src', 'server.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(pluginDir, 'server', 'agy-mcp.mjs'),
  // Bundled CommonJS dependencies (ajv) still call require().
  banner: { js: "import { createRequire as __agyCreateRequire } from 'node:module';\nconst require = __agyCreateRequire(import.meta.url);" },
  define: { __AGY_MCP_VERSION__: JSON.stringify(manifest.version) },
  legalComments: 'eof',
  logLevel: 'warning',
})

await build({
  entryPoints: [join(here, 'src', 'gateway-main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(pluginDir, 'server', 'agy-gateway.mjs'),
  banner: { js: "import { createRequire as __agyCreateRequire } from 'node:module';\nconst require = __agyCreateRequire(import.meta.url);" },
  define: { __AGY_MCP_VERSION__: JSON.stringify(manifest.version) },
  legalComments: 'eof',
  logLevel: 'warning',
})

// Standalone agy command hook for opt-in supervision. The MCP server copies
// server/supervisor-hook.mjs into each supervised run's directory and agy runs
// it with plain node, so it must be self-contained (Node built-ins only).
// A ZCode-specific hook in zcode/src wins; otherwise reuse the shared DSH one.
const hookEntry = [join(here, 'src', 'supervisor-hook.ts'), join(here, 'shared', 'supervisor-hook.ts'), join(here, '..', 'src', 'supervisor-hook.ts')].find((file) => existsSync(file))
if (hookEntry === undefined) throw new Error('supervisor-hook.ts not found in src/, shared/ or ../src')
await build({
  entryPoints: [hookEntry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(pluginDir, 'server', 'supervisor-hook.mjs'),
  define: { __AGY_MCP_VERSION__: JSON.stringify(manifest.version) },
  legalComments: 'eof',
  logLevel: 'warning',
})
const hookImports = [...readFileSync(join(pluginDir, 'server', 'supervisor-hook.mjs'), 'utf8').matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map((match) => match[1])
const foreign = hookImports.filter((spec) => !spec.startsWith('node:'))
if (foreign.length > 0) throw new Error('supervisor-hook.mjs must only import node: built-ins, found ' + foreign.join(', '))

// MCP App panel: self-contained offline bundle (SDK inlined), inlined into the
// HTML resource the MCP server serves, so the panel is exactly one resource.
await build({
  entryPoints: [join(here, 'src', 'panel.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  outfile: join(pluginDir, 'server', 'panel.js'),
  legalComments: 'eof',
  logLevel: 'warning',
})
const panelJs = readFileSync(join(pluginDir, 'server', 'panel.js'), 'utf8')
const panelHtml = readFileSync(join(here, 'src', 'panel.html'), 'utf8')
  .replace('<script type="module" src="./panel.js"></script>', () => '<script type="module">\n' + panelJs.replaceAll('</script', '<\\/script') + '\n</script>')
writeFileSync(join(pluginDir, 'server', 'panel.html'), panelHtml)
rmSync(join(pluginDir, 'server', 'panel.js'))
if (Buffer.byteLength(panelHtml) > 4 * 1024 * 1024) throw new Error('panel.html exceeds the host 4 MiB resource limit')

const size = statSync(join(pluginDir, 'server', 'agy-mcp.mjs')).size
const gatewaySize = statSync(join(pluginDir, 'server', 'agy-gateway.mjs')).size
console.log('built ' + manifest.name + ' ' + manifest.version + ' -> ' + market + ' (server bundle ' + Math.round(size / 1024) + ' KiB, gateway bundle ' + Math.round(gatewaySize / 1024) + ' KiB)')
console.log('ZCode only sees this build after `zcode plugins marketplace update agy-local`; check with `npm run install:status`.')
