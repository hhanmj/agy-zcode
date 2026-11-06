#!/usr/bin/env node
// Offline stand-in for the agy CLI, driven by directives inside the prompt:
//   SLEEP=<ms>   pause mid-run (a tool step stays ACTIVE meanwhile)
//   WRITE=<name> create <name> in the working directory
//   FAIL         finish with an error result (exit 3)
//   AUTH         print an authentication error on stderr (exit 1)
// Every invocation is appended to $FAKE_AGY_LOG as one JSON line.
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
