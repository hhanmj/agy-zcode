// Child process for the cross-process registry test: N concurrent
// updateRegistry calls from one AgyRunner on a shared data directory.
//   node registry-worker.mjs <bundle> <dataDir> <prefix> <count>
import { pathToFileURL } from 'node:url'

const [bundle, dataDir, prefix, count] = process.argv.slice(2)
process.env.AGY_MCP_DATA_DIR = dataDir
process.env.AGY_MCP_TRACE = 'false'
const { AgyRunner, loadConfig } = await import(pathToFileURL(bundle).href)
const errors = []
const runner = new AgyRunner(loadConfig(), (message) => errors.push(message))
const results = await Promise.all(Array.from({ length: Number(count) }, (_, i) => runner.updateRegistry((records) => {
  records[prefix + '-' + i] = { conversationId: 'conv-' + prefix + '-' + i, cwd: dataDir, label: prefix, createdAt: Date.now() }
})))
process.stdout.write(JSON.stringify({ ok: results.filter(Boolean).length, errors }) + '\n')
