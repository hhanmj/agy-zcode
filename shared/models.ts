/**
 * Antigravity CLI model catalog for per-child model/effort selection.
 *
 * Verified on agy 1.4.0, listing format re-verified on 1.4.7 and 1.5.5 (real
 * captures in scripts/fixtures/agy-1.4.7-models*.txt and
 * agy-1.5.5-models*.txt, see scripts/fixtures/manifest.json):
 * - "agy models" prints one "<id>\t<display name>" line per model; progress
 *   ("Fetching available models...") goes to stderr. "agy models
 *   --output-format json" is still rejected on 1.5.5 (exit 1, "flags provided
 *   but not defined"); the subcommand has no flags besides -h/--help.
 * - The catalog is account/server dependent, not tied to the CLI version: on
 *   1.4.7 every listed model happened to have effort variants; 1.5.5 added
 *   gemini-4-carbon-{low,medium,high} ahead of the argon entries.
 * - Effort variants share a base: gemini-3.8-flash-{low,medium,high} with
 *   display names "... (Low|Medium|High)". "--model <base> --effort <e>" runs
 *   the variant <base>-<e>; a variant id plus a different --effort is an error.
 * - Models without variants (e.g. claude-sonnet-4-6 on 1.4.0) take no --effort.
 * - Resuming a conversation without --model falls back to the CLI default, so
 *   callers must send the resolved arguments on every turn.
 *
 * Grouping variants into base model + efforts follows the approach of
 * Jonah-Wu23/dsh-agy-safe (MIT). Nothing here invents a model: an empty or
 * failed listing is reported, never replaced by a guessed list.
 */
export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type AgyEffort = (typeof EFFORT_ORDER)[number]

export interface AgyListedModel {
  id: string
  name: string
}

export interface AgyBaseModel {
  /** Base id passed to --model (a raw id when the model has no variants). */
  id: string
  name: string
  /** Efforts that exist as variants, low → max. Empty: the model takes no --effort. */
  efforts: AgyEffort[]
  /** Raw "agy models" ids folded into this entry. */
  variants: string[]
}

/** The CLI arguments one resolved selection produces. */
export interface AgyModelArgs {
  model?: string
  effort?: string
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** Strict "<id>\t<name>" parsing; any other line is ignored. */
export function parseAgyModelsOutput(output: string): AgyListedModel[] {
  const listed: AgyListedModel[] = []
  const seen = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const tab = line.indexOf('\t')
    if (tab <= 0 || tab === line.length - 1) continue
    const id = line.slice(0, tab).trim()
    const name = line.slice(tab + 1).trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id) || name.length === 0 || seen.has(id)) continue
    seen.add(id)
    listed.push({ id, name })
  }
  return listed
}

/** "<base>-<effort>" with display name "... (<Effort>)" — both must match to count as a variant. */
export function splitEffortVariant(id: string, name: string): { base: string; baseName: string; effort: AgyEffort } | null {
  for (const effort of EFFORT_ORDER) {
    const idSuffix = '-' + effort
    const nameSuffix = ' (' + capitalize(effort) + ')'
    if (id.endsWith(idSuffix) && name.endsWith(nameSuffix) && id.length > idSuffix.length) {
      return { base: id.slice(0, -idSuffix.length), baseName: name.slice(0, -nameSuffix.length), effort }
    }
  }
  return null
}

export function groupBaseModels(listed: readonly AgyListedModel[]): AgyBaseModel[] {
  const bases = new Map<string, { name: string; efforts: Set<AgyEffort>; variants: string[] }>()
  for (const { id, name } of listed) {
    const variant = splitEffortVariant(id, name)
    const baseId = variant?.base ?? id
    let entry = bases.get(baseId)
    if (entry === undefined) {
      entry = { name: variant?.baseName ?? name, efforts: new Set(), variants: [] }
      bases.set(baseId, entry)
    }
    if (variant) entry.efforts.add(variant.effort)
    entry.variants.push(id)
  }
  return [...bases].map(([id, entry]) => ({
    id,
    name: entry.name,
    efforts: EFFORT_ORDER.filter((effort) => entry.efforts.has(effort)),
    variants: entry.variants,
  }))
}

/** Default effort for a base model: high when it exists (matches the CLI default), else the deepest. */
export function defaultEffortFor(model: AgyBaseModel): AgyEffort | undefined {
  if (model.efforts.length === 0) return undefined
  return model.efforts.includes('high') ? 'high' : model.efforts[model.efforts.length - 1]
}

export class AgyModelSelectionError extends Error {}

/**
 * Resolve a requested model (base id or raw variant id) and optional effort
 * into CLI arguments, rejecting combinations agy would reject.
 */
export function resolveSelection(models: readonly AgyBaseModel[], requested: string, effort?: string): { model: AgyBaseModel; effort?: AgyEffort; args: AgyModelArgs } {
  const wanted = effort?.trim().toLowerCase() || undefined
  let base = models.find((m) => m.id === requested)
  let impliedEffort: AgyEffort | undefined
  if (base === undefined) {
    base = models.find((m) => m.variants.includes(requested) && m.efforts.length > 0)
    const suffix = base === undefined ? '' : requested.slice(base.id.length + 1)
    if ((EFFORT_ORDER as readonly string[]).includes(suffix)) impliedEffort = suffix as AgyEffort
  }
  if (base === undefined) {
    throw new AgyModelSelectionError(`unknown AGY model "${requested}"; available: ${models.map((m) => m.id).join(', ') || '(none listed)'}`)
  }
  if (wanted !== undefined && !(EFFORT_ORDER as readonly string[]).includes(wanted)) {
    throw new AgyModelSelectionError(`effort must be one of ${EFFORT_ORDER.join(' | ')}`)
  }
  if (impliedEffort !== undefined && wanted !== undefined && wanted !== impliedEffort) {
    throw new AgyModelSelectionError(`"${requested}" already fixes effort ${impliedEffort}; it conflicts with effort ${wanted}`)
  }
  if (base.efforts.length === 0) {
    if (wanted !== undefined) throw new AgyModelSelectionError(`AGY model "${base.id}" has no effort variants; omit effort`)
    return { model: base, args: { model: base.id } }
  }
  const chosen = (impliedEffort ?? wanted ?? defaultEffortFor(base)) as AgyEffort
  if (!base.efforts.includes(chosen)) {
    throw new AgyModelSelectionError(`AGY model "${base.id}" supports efforts ${base.efforts.join(' | ')}, not ${chosen}`)
  }
  return { model: base, effort: chosen, args: { model: base.id, effort: chosen } }
}

/** TTL-cached catalog over an injected "agy models" runner; failures are never cached. */
export class AgyModelCatalog {
  private models: AgyBaseModel[] | undefined
  private fetchedAt = 0
  private inflight: Promise<AgyBaseModel[]> | undefined

  constructor(
    private readonly fetchOutput: () => Promise<string>,
    private readonly ttlMs = 5 * 60 * 1000,
  ) {}

  async list(): Promise<AgyBaseModel[]> {
    if (this.models !== undefined && Date.now() - this.fetchedAt < this.ttlMs) return this.models
    this.inflight ??= this.fetchOutput()
      .then((output) => {
        const grouped = groupBaseModels(parseAgyModelsOutput(output))
        if (grouped.length === 0) throw new AgyModelSelectionError('"agy models" returned no parseable "<id>\\t<name>" lines')
        this.models = grouped
        this.fetchedAt = Date.now()
        return grouped
      })
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /** Cached view only (no CLI call); undefined before the first successful listing. */
  peek(): AgyBaseModel[] | undefined {
    return this.models
  }
}
