import { printable } from '../core/printable.ts';
import type { ChangeEntry, ChangeKind, ChangePoint, ChangeQuery, ChangeSource, ChangeSourceDeps, Release, ResolvedPoint } from './source.ts';

/** What `teamrig changes` asks: the range, the narrowing, and the sources the config picks. */
export interface ChangesAsk {
  readonly since: ChangePoint;
  readonly until: ChangePoint | undefined;
  readonly file: string | undefined;
  readonly area: string | undefined;
  /** `auto`: every source whose `detect` is true; else these ids, in this order. */
  readonly sources: 'auto' | readonly string[];
}

export interface ChangesReport {
  readonly kind: 'report';
  readonly since: ResolvedPoint;
  readonly until: ResolvedPoint | undefined;
  /** The sources read, in the order their entries won over later ones'. */
  readonly read: readonly string[];
  /** Newest version first, the unreleased ones before every release; in a version, actions, then behaviour changes, then the rest by area. */
  readonly entries: readonly ChangeEntry[];
  /** `<source>: <what it could not read>`. */
  readonly warnings: readonly string[];
  readonly failed: readonly { readonly source: string; readonly error: string }[];
  /** The project's releases, newest first, which name each version's day. */
  readonly releases: readonly Release[];
}

/** A version the project's release index does not hold: its releases are named, so the reader can pick one. */
export interface UnknownVersion {
  readonly kind: 'unknown-version';
  readonly version: string;
  readonly known: readonly string[];
}

/** A config naming a source this teamrig does not have. */
export interface UnknownSource {
  readonly kind: 'unknown-source';
  readonly source: string;
  readonly known: readonly string[];
}

const KIND_ORDER: readonly ChangeKind[] = ['action', 'behaviour', 'feature', 'fix', 'other'];

/** `1.2.3` against `1.10.0`, by number; a pre-release (`1.2.3-rc.1`) comes before its release. */
export function compareVersions(a: string, b: string): number {
  const [aCore = '', aPre] = a.split('-', 2);
  const [bCore = '', bPre] = b.split('-', 2);
  const aParts = aCore.split('.').map(Number);
  const bParts = bCore.split('.').map(Number);
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const diff = (aParts[index] ?? 0) - (bParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  if (aPre === bPre) {
    return 0;
  }
  return aPre === undefined ? 1 : bPre === undefined ? -1 : aPre.localeCompare(bPre);
}

/**
 * A typed `--since` or `--until`: a version (`0.447.0`, `v0.447.0`), else a time `instantOf` reads, which knows the
 * reader's zone; kept as an ISO time, so every source compares it alike.
 */
export function parsePoint(text: string, instantOf: (text: string) => Date | undefined): ChangePoint | undefined {
  const version = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(text.trim())?.[1];
  if (version !== undefined) {
    return { kind: 'version', version };
  }
  const at = instantOf(text.trim());
  return at === undefined ? undefined : { kind: 'date', at: at.toISOString() };
}

/** A point by the release index: a version is its release's commit and time; a time has no version or commit. */
function resolve(point: ChangePoint, releases: readonly Release[]): ResolvedPoint | UnknownVersion {
  if (point.kind === 'date') {
    return { version: undefined, at: point.at, ref: undefined };
  }
  const release = releases.find((candidate) => candidate.version === point.version);
  return release === undefined
    ? { kind: 'unknown-version', version: point.version, known: releases.map((known) => known.version) }
    : { version: release.version, at: release.at, ref: release.sha };
}

/** The release an entry shipped in, by its time: the oldest release made at or after it; none when it is newer than every one. */
function versionByTime(at: string | undefined, oldestFirst: readonly Release[]): string | undefined {
  return at === undefined ? undefined : oldestFirst.find((release) => release.at >= at)?.version;
}

/** Whether an entry is past `since` and up to `until`, by version where both have one, else by time; an entry with neither is kept. */
function inRange(entry: ChangeEntry, since: ResolvedPoint, until: ResolvedPoint | undefined): boolean {
  const after = entry.version !== undefined && since.version !== undefined ? compareVersions(entry.version, since.version) > 0 : entry.at === undefined || since.at === undefined || entry.at > since.at;
  if (!after || until === undefined) {
    return after;
  }
  if (until.version !== undefined) {
    return entry.version !== undefined ? compareVersions(entry.version, until.version) <= 0 : entry.at !== undefined && until.at !== undefined && entry.at <= until.at;
  }
  return entry.at === undefined || until.at === undefined || entry.at <= until.at;
}

function touches(entry: ChangeEntry, file: string): boolean {
  const path = file.replace(/\\/g, '/').replace(/^\.\//, '');
  return entry.files.some((touched) => touched === path || touched.startsWith(path.endsWith('/') ? path : `${path}/`));
}

/** Entries from earlier sources win: a later entry whose every ref an earlier one already names (the same commit, the same task) is the same change. */
function withoutRepeats(bySource: readonly (readonly ChangeEntry[])[]): ChangeEntry[] {
  const named = new Set<string>();
  const kept: ChangeEntry[] = [];
  for (const entries of bySource) {
    const fresh = entries.filter((entry) => entry.refs.length === 0 || !entry.refs.every((ref) => named.has(ref)));
    kept.push(...fresh);
    for (const entry of fresh) {
      for (const ref of entry.refs) {
        named.add(ref);
      }
    }
  }
  return kept;
}

/**
 * An entry as it may be shown: a commit subject, a note or a release's text comes from whoever wrote it, an outside
 * contributor too, so every control character and bidi mark in it is escaped (core/printable.ts), and it cannot send
 * escape sequences to the reader's terminal nor add lines of its own. The text keeps its own lines, each escaped.
 */
function shownEntry(entry: ChangeEntry): ChangeEntry {
  return {
    ...entry,
    area: printable(entry.area),
    text: entry.text.split('\n').map(printable).join('\n'),
    action: entry.action === undefined ? undefined : printable(entry.action),
    files: entry.files.map(printable),
    refs: entry.refs.map(printable),
  };
}

function byShowOrder(a: ChangeEntry, b: ChangeEntry): number {
  if (a.version !== b.version) {
    return a.version === undefined ? -1 : b.version === undefined ? 1 : compareVersions(b.version, a.version);
  }
  const kind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  if (kind !== 0) {
    return kind;
  }
  return a.area.localeCompare(b.area) || (b.at ?? '').localeCompare(a.at ?? '');
}

/** The sources the ask picks: every one that applies to the project under `auto`, else the named ones, which must exist. */
async function picked(deps: ChangeSourceDeps, registry: readonly ChangeSource[], sources: ChangesAsk['sources']): Promise<ChangeSource[] | UnknownSource> {
  if (sources === 'auto') {
    const applies = await Promise.all(registry.map((source) => source.detect(deps).catch(() => false)));
    return registry.filter((_, index) => applies[index] === true);
  }
  const chosen: ChangeSource[] = [];
  for (const id of sources) {
    const source = registry.find((candidate) => candidate.id === id);
    if (source === undefined) {
      return { kind: 'unknown-source', source: id, known: registry.map((known) => known.id) };
    }
    chosen.push(source);
  }
  return chosen;
}

/**
 * What changed in the project in the asked range: each picked source read with the range resolved by the release
 * index, its entries given the version they shipped in, narrowed to `file` and `area`, the same change named by two
 * sources kept once (the earlier source's), in show order. A failed source is reported beside the others' entries.
 */
export async function readChanges(deps: ChangeSourceDeps, registry: readonly ChangeSource[], ask: ChangesAsk): Promise<ChangesReport | UnknownVersion | UnknownSource> {
  const sources = await picked(deps, registry, ask.sources);
  if (!Array.isArray(sources)) {
    return sources;
  }
  const releases = await deps.git.releases(deps.project).catch((): readonly Release[] => []);
  const since = resolve(ask.since, releases);
  if ('kind' in since) {
    return since;
  }
  const until = ask.until === undefined ? undefined : resolve(ask.until, releases);
  if (until !== undefined && 'kind' in until) {
    return until;
  }
  const area = ask.area?.toLowerCase();
  const reads = await Promise.all(
    sources.map(async (source) => {
      const query: ChangeQuery = { since, until, file: source.capabilities.byFile ? ask.file : undefined, area: source.capabilities.byArea ? area : undefined };
      return { source, read: await source.read(deps, query).catch((error: unknown) => ({ kind: 'failed' as const, error: error instanceof Error ? error.message : String(error) })) };
    }),
  );
  const oldestFirst = [...releases].reverse();
  const bySource = reads.map(({ read }) =>
    read.kind === 'read'
      ? read.entries
          .map((entry) => (entry.version === undefined ? { ...entry, version: versionByTime(entry.at, oldestFirst) } : entry))
          .filter((entry) => inRange(entry, since, until))
          .filter((entry) => ask.file === undefined || touches(entry, ask.file))
          .filter((entry) => area === undefined || entry.area === area)
      : [],
  );
  return {
    kind: 'report',
    since,
    until,
    read: sources.map((source) => source.id),
    entries: withoutRepeats(bySource).map(shownEntry).sort(byShowOrder),
    warnings: reads.flatMap(({ source, read }) => (read.kind === 'read' ? read.warnings.map((warning) => `${source.id}: ${printable(warning)}`) : [])),
    failed: reads.flatMap(({ source, read }) => (read.kind === 'failed' ? [{ source: source.id, error: printable(read.error) }] : [])),
    releases,
  };
}
