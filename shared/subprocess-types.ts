// Type-only surface of @deepseek-ai/dsh-subprocess (MIT, deepseek-ai/deepseek-harness),
// vendored so this plugin builds standalone. persistent.ts uses these types only;
// the runtime seam is injected by the caller (PersistentSpawnFn).
import type { Duplex, Readable, Writable } from 'node:stream'

export interface SubprocessOutputRead {
  /** Stream text from the requested offset (the whole retained tail when lossy). */
  text: string
  /** Whole-stream offset to resume from on the next read. */
  nextOffset: number
  /** True when the requested offset slid out of the in-memory tail window. */
  lossy: boolean
  /** Path to the full-stream spill file, when one was created and remains intact. */
  spillPath?: string
}

export interface SubprocessOutputReader {
  readFrom(fromByte: number): SubprocessOutputRead
}

export interface SubprocessCollectedOutputs {
  readonly stdout?: SubprocessOutputReader
  readonly stderr?: SubprocessOutputReader
}

export interface SubprocessOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export interface SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly control: Duplex | undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}
