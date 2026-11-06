// Start the plugin's MCP server the way ZCode does: read .mcp.json from an
// installed (or built) plugin directory, substitute ZCode's variables and
// userConfig defaults, then list tools and call two tools that need no agy
// quota (agy_models, agy_tasks).
//   node test/zcode-env-smoke.mjs [pluginRoot] [dataDir]
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = process.argv[2] ?? join(here, '..', 'dist', 'market', 'plugins', 'agy-delegate')
const data = process.argv[3] ?? mkdtempSync(join(tmpdir(), 'agy-mcp-data-'))
const workspace = mkdtempSync(join(tmpdir(), 'agy-mcp-ws-'))
const manifest = JSON.parse(readFileSync(join(root, '.zcode-plugin', 'plugin.json'), 'utf8'))
const server = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers.agy
const defaults = Object.fromEntries(Object.entries(manifest.userConfig ?? {}).map(([key, spec]) => [key, spec.default]))
const substitute = (value) => value.replace(/\$\{([^}]+)\}/g, (_, name) => {
  if (name === 'ZCODE_PLUGIN_ROOT' || name === 'CLAUDE_PLUGIN_ROOT') return root
  if (name === 'ZCODE_PLUGIN_DATA' || name === 'CLAUDE_PLUGIN_DATA') return data
  if (name === 'ZCODE_PROJECT_DIR' || name === 'CLAUDE_PROJECT_DIR') return workspace
  if (name.startsWith('user_config.')) {
    const value = defaults[name.slice(12)]
    if (value === undefined) throw new Error('Missing plugin user_config value: ' + name)
    return String(value)
  }
  throw new Error('unknown variable ' + name)
})
const env = Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, substitute(value)]))
console.log('server env:', env)
const transport = new StdioClientTransport({
  command: server.command,
  args: server.args.map(substitute),
  env: { ...process.env, ZCODE_PLUGIN_ROOT: root, ZCODE_PLUGIN_DATA: data, ZCODE_PROJECT_DIR: workspace, ...env },
  stderr: 'inherit',
})
const client = new Client({ name: 'zcode-env-smoke', version: '0.0.0' })
await client.connect(transport)
console.log('server:', client.getServerVersion())
const { tools } = await client.listTools()
console.log('tools:', tools.map((tool) => tool.name).join(', '))
for (const [name, args] of [['agy_models', {}], ['agy_tasks', { limit: 3 }]]) {
  const result = await client.callTool({ name, arguments: args })
  console.log('\n=== ' + name + (result.isError ? ' (isError)' : '') + ' ===\n' + result.content.map((block) => block.text).join('\n'))
}
await client.close()
