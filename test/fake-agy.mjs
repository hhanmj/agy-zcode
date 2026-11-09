#!/usr/bin/env node
// Offline stand-in for the agy CLI, driven by directives inside the prompt:
//   SLEEP=<ms>   pause mid-run (a tool step stays ACTIVE meanwhile)
//   WRITE=<name> create <name> in the working directory
//   FAIL         finish with an error result (exit 3 / JSON-RPC error in ACP)
//   AUTH         print an authentication error on stderr (exit 1 / RPC error)
// Every invocation is appended to $FAKE_AGY_LOG as one JSON line.
// `acp` runs a persistent JSON-RPC Agent Client Protocol agent instead of the
// print mode; FAKE_AGY_NO_ACP=1 makes it reject `acp` so gateway tests can
// exercise the stream-json fallback.
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const HELP = [
  'Usage of agy.exe:',
  '  --add-dir                       Add a directory to the workspace (repeatable) (default [])',
  '  --conversation                  Resume a previous conversation by ID',
  '  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting',
  '  --effort                        Reasoning effort (low|medium|high|xhigh|max)',
  '  --input-format                  Input format for print mode (text, stream-json). stream-json reads one NDJSON message per line from stdin',
  '  --model                         Model for the current CLI session',
  '  --output-format                 Output format for print mode (text, json, stream-json) (default text)',
  '  --print                         Run a single prompt non-interactively and print the response',
  '  --print-timeout                 Optional time limit for print mode',
  '  --sandbox                       Run in a sandbox with terminal restrictions enabled',
  '',
].join('\n')
const MODELS = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n'

const args = process.argv.slice(2)
const log = (entry) => {
  if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(entry) + '\n')
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const flag = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

if (args[0] === 'help') {
  process.stdout.write(HELP)
  process.exit(0)
}
if (args[0] === 'models') {
  process.stdout.write(MODELS)
  process.exit(0)
}

if (args[0] === 'acp') {
  if (process.env.FAKE_AGY_NO_ACP === '1') {
    process.stderr.write('Error: unknown subcommand "acp"\n')
    process.exit(1)
  }
  const sessions = new Map()
  const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  const notify = (method, params) => send({ method, params })
  const configOptions = (s) => [
    { id: 'model', currentValue: s.model, options: [{ value: 'gemini-3.8-flash' }, { value: 'claude-sonnet-4-6' }, { value: 'claude-opus-4-6-thinking' }, { value: 'gpt-oss-120b-medium' }] },
    { id: 'thought_level', currentValue: s.effort, options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
  ]
  const handle = async (msg) => {
    const { id, method, params } = msg
    if (method === 'initialize') {
      send({ id, result: { protocolVersion: 1, agentCapabilities: {} } })
    } else if (method === 'session/new') {
      const sessionId = 'conv-' + randomUUID()
      const s = { cwd: params.cwd, model: 'gemini-3.8-flash', effort: 'high', prompts: 0, cancel: null }
      sessions.set(sessionId, s)
      send({ id, result: { sessionId, configOptions: configOptions(s) } })
    } else if (method === 'session/set_config_option') {
      const s = sessions.get(params.sessionId)
      if (s !== undefined) {
        if (params.configId === 'model') s.model = params.value
        if (params.configId === 'thought_level') s.effort = params.value
      }
      send({ id, result: { configOptions: s !== undefined ? configOptions(s) : [] } })
    } else if (method === 'session/prompt') {
      const s = sessions.get(params.sessionId)
      if (s === undefined) {
        send({ id, error: { code: -32602, message: 'unknown session ' + String(params.sessionId) } })
        return
      }
      const prompt = (params.prompt ?? []).map((b) => b.text ?? '').join('')
      s.prompts += 1
      const resumed = s.prompts > 1
      log({ pid: process.pid, cwd: s.cwd, conversation: params.sessionId, args: ['acp'], prompt, model: s.model, effort: s.effort, resumed, proxy: process.env.HTTPS_PROXY ?? null, leakedSecret: process.env.SHOULD_NOT_LEAK_TOKEN ?? null })
      if (prompt.includes('AUTH')) {
        send({ id, error: { code: -32000, message: 'authentication required' } })
        return
      }
      const sleepMs = Number((/SLEEP=(\d+)/.exec(prompt) ?? [])[1] ?? 0)
      let cancelled = false
      s.cancel = () => { cancelled = true }
      if (sleepMs > 0) await sleep(sleepMs)
      if (cancelled) {
        s.cancel = null
        send({ id, result: { stopReason: 'cancelled' } })
        return
      }
      const write = (/WRITE=([\w.-]+)/.exec(prompt) ?? [])[1]
      if (write) writeFileSync(join(s.cwd, write), 'written by fake agy\n')
      if (prompt.includes('FAIL')) {
        const detail = (/FAIL=([^\n]+)/.exec(prompt) ?? [])[1] ?? 'boom from fake agy'
        s.cancel = null
        send({ id, error: { code: -32000, message: detail } })
        return
      }
      const firstLine = prompt.split('\n')[0]
      const answer = 'Echo: ' + firstLine + (resumed ? ' (resumed ' + params.sessionId + ')' : '')
      notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking about: ' + firstLine.slice(0, 40) } } })
      for (const piece of [answer.slice(0, 6), answer.slice(6)]) {
        if (cancelled) break
        notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } } })
      }
      s.cancel = null
      send({ id, result: { stopReason: cancelled ? 'cancelled' : 'end_turn', usage: { inputTokens: 10, outputTokens: 5, thoughtTokens: 3 } } })
    } else if (method === 'session/cancel') {
      sessions.get(params.sessionId)?.cancel?.()
    } else if (id !== undefined) {
      send({ id, error: { code: -32601, message: 'method not found: ' + String(method) } })
    }
  }
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line.length === 0) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      void handle(msg)
    }
  })
  process.stdin.on('end', () => process.exit(0))
} else {
  let prompt = flag('-p')
  if (flag('--input-format') === 'stream-json') {
    let input = ''
    for await (const chunk of process.stdin) input += chunk
    const first = JSON.parse(input.split('\n')[0])
    prompt = first.message.content
  }
  const format = flag('--output-format') ?? 'text'
  const conversation = flag('--conversation') ?? 'conv-' + randomUUID()
  log({ pid: process.pid, cwd: process.cwd(), conversation, args, prompt, proxy: process.env.HTTPS_PROXY ?? null, leakedSecret: process.env.SHOULD_NOT_LEAK_TOKEN ?? null })

  const emit = (event) => {
    if (format === 'stream-json') process.stdout.write(JSON.stringify(event) + '\n')
  }
  emit({ event: 'init', conversation_id: conversation, init: { cwd: process.cwd(), tools: ['run_command', 'write_to_file'], permission_mode: 'always-proceed' } })
  emit({ event: 'step_update', step_update: { conversation_id: conversation, step_index: 0, state: 'DONE', step_type: 'user_input' } })

  if (prompt.includes('AUTH')) {
    process.stderr.write('Error: authentication required\n')
    process.exit(1)
  }
  const sleepMs = Number((/SLEEP=(\d+)/.exec(prompt) ?? [])[1] ?? 0)
  emit({ event: 'step_update', step_update: { conversation_id: conversation, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo working' } } } })
  if (sleepMs > 0) await sleep(sleepMs)
  const write = (/WRITE=([\w.-]+)/.exec(prompt) ?? [])[1]
  if (write) writeFileSync(join(process.cwd(), write), 'written by fake agy\n')
  emit({ event: 'step_update', step_update: { conversation_id: conversation, step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'run_command', duration_seconds: 0.2, tool_info: { name: 'run_command', parameters: { CommandLine: 'echo working' }, output: 'working\n' } } })

  if (prompt.includes('FAIL')) {
    const detail = (/FAIL=([^\n]+)/.exec(prompt) ?? [])[1] ?? 'boom from fake agy'
    emit({ event: 'result', result: { conversation_id: conversation, status: 'ERROR', error: detail } })
    if (format === 'json') process.stdout.write(JSON.stringify({ conversation_id: conversation, status: 'ERROR', error: detail }) + '\n')
    process.exit(3)
  }
  const firstLine = prompt.split('\n')[0]
  const answer = 'Echo: ' + firstLine + (flag('--conversation') ? ' (resumed ' + conversation + ')' : '')
  for (const piece of [answer.slice(0, 6), answer.slice(6)]) {
    emit({ event: 'step_update', step_update: { conversation_id: conversation, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: piece } })
  }
  emit({ event: 'step_update', step_update: { conversation_id: conversation, step_index: 2, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 10, output_tokens: 5 } } })
  emit({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: answer, num_turns: 1 } })
  if (format === 'json') process.stdout.write(JSON.stringify({ conversation_id: conversation, status: 'SUCCESS', response: answer }) + '\n')
  if (format === 'text') process.stdout.write(answer + '\n')
}
