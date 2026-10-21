import { newestProjectTranscript, type TranscriptSource } from '../budget/discover.ts';
import { isRecord, isStringArray, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';

/** A list Claude Code announces in a session's context on top of the files `readContextFiles` measures. */
export type SessionListKind = 'skills' | 'tools' | 'agents' | 'instructions';

/** The lists, in the order they are reported. */
export const SESSION_LIST_KINDS: readonly SessionListKind[] = ['skills', 'tools', 'agents', 'instructions'];

/** Where some of a list's entries come from (a plugin, an MCP server, ...), and their share of it. */
export interface SessionListSource {
  readonly name: string;
  readonly count: number;
  readonly chars: number;
}

export interface SessionList {
  readonly kind: SessionListKind;
  readonly count: number;
  readonly chars: number;
  /** Largest first. */
  readonly sources: readonly SessionListSource[];
}

/** The lists one session's context holds, as its transcript announced them. */
export interface SessionLists {
  readonly transcript: string;
  readonly lists: readonly SessionList[];
}

/** The source of a skill from no plugin, or of an agent type from no plugin that Claude Code does not ship. */
export const SKILLS_FOLDERS_SOURCE = 'skills folders and built-in';
export const AGENTS_FOLDERS_SOURCE = 'agents folders';
export const BUILT_IN_SOURCE = 'built-in';

/** The attachment type Claude Code writes each list's changes under. */
const ATTACHMENT_KINDS: ReadonlyMap<string, SessionListKind> = new Map([
  ['skill_listing', 'skills'],
  ['deferred_tools_delta', 'tools'],
  ['agent_listing_delta', 'agents'],
  ['mcp_instructions_delta', 'instructions'],
]);

/** A cheap test before parsing: the line names one of the attachment types (quotes inside a JSON string are escaped, so tool output never matches). */
const KIND_MARKERS: readonly string[] = [...ATTACHMENT_KINDS.keys()].map((type) => `"type":"${type}"`);

const MCP_SERVER = /^mcp__(.+?)__/;

interface Entry {
  readonly source: string;
  readonly chars: number;
}

/** What one attachment changes in its list: an initial listing replaces it, then names are removed, then added. */
interface ListDelta {
  readonly replaces: boolean;
  readonly removed: readonly string[];
  readonly added: readonly (readonly [string, Entry])[];
}

function strings(record: JsonRecord, key: string): readonly string[] {
  const value = record[key];
  return isStringArray(value) ? value : [];
}

/** The part of a name before its first `:`, which Claude Code gives a plugin's skills and agent types; undefined without one. */
function pluginOf(name: string): string | undefined {
  const colon = name.indexOf(':');
  return colon > 0 ? name.slice(0, colon) : undefined;
}

/**
 * Each skill's share of the listing's text, `- name: description` per skill joined by line ends. A description can
 * hold line ends, so each skill runs from its `- name: ` to the next skill's; text before the first goes to the first,
 * and a name not found counts 0.
 */
function skillChars(content: string, names: readonly string[]): number[] {
  let cursor = 0;
  const starts = names.map((name) => {
    const start = content.indexOf(`- ${name}: `, cursor);
    if (start < 0) {
      return undefined;
    }
    cursor = start + 1;
    return start;
  });
  const found = starts.filter((start): start is number => start !== undefined);
  return starts.map((start) => {
    if (start === undefined) {
      return 0;
    }
    const at = found.indexOf(start);
    return (found[at + 1] ?? content.length) - (at === 0 ? 0 : start);
  });
}

function skillsDelta(attachment: JsonRecord): ListDelta {
  const names = strings(attachment, 'names');
  const chars = skillChars(stringField(attachment, 'content') ?? '', names);
  return {
    replaces: attachment['isInitial'] === true,
    removed: [],
    added: names.map((name, index) => [name, { source: pluginOf(name) ?? SKILLS_FOLDERS_SOURCE, chars: chars[index] ?? 0 }]),
  };
}

function toolSource(name: string): string {
  return MCP_SERVER.exec(name)?.[1] ?? BUILT_IN_SOURCE;
}

/** A surfaced tool is shown with its whole definition instead of its name. */
function surfacedChars(attachment: JsonRecord): Map<string, number> {
  const chars = new Map<string, number>();
  const definitions = attachment['surfacedDefinitions'];
  for (const surfaced of Array.isArray(definitions) ? definitions : []) {
    const name = isRecord(surfaced) ? stringField(surfaced, 'name') : undefined;
    const definition = isRecord(surfaced) ? recordField(surfaced, 'definition') : undefined;
    if (name !== undefined && definition !== undefined) {
      chars.set(name, JSON.stringify(definition).length);
    }
  }
  return chars;
}

function toolsDelta(attachment: JsonRecord): ListDelta {
  const names = strings(attachment, 'addedNames');
  const lines = strings(attachment, 'addedLines');
  const surfaced = surfacedChars(attachment);
  const listed = names.map((name, index): [string, Entry] => [name, { source: toolSource(name), chars: surfaced.get(name) ?? (lines[index] ?? name).length + 1 }]);
  const alone = [...surfaced].filter(([name]) => !names.includes(name)).map(([name, chars]): [string, Entry] => [name, { source: toolSource(name), chars }]);
  return { replaces: false, removed: strings(attachment, 'removedNames'), added: [...listed, ...alone] };
}

function agentsDelta(attachment: JsonRecord): ListDelta {
  const types = strings(attachment, 'addedTypes');
  const lines = strings(attachment, 'addedLines');
  const builtIn = new Set(strings(attachment, 'builtInTypes'));
  const sourceOf = (type: string): string => pluginOf(type) ?? (builtIn.has(type) ? BUILT_IN_SOURCE : AGENTS_FOLDERS_SOURCE);
  return {
    replaces: attachment['isInitial'] === true,
    removed: strings(attachment, 'removedTypes'),
    added: types.map((type, index) => [type, { source: sourceOf(type), chars: (lines[index] ?? '').length + 1 }]),
  };
}

function instructionsDelta(attachment: JsonRecord): ListDelta {
  const blocks = strings(attachment, 'addedBlocks');
  return {
    replaces: false,
    removed: strings(attachment, 'removedNames'),
    added: strings(attachment, 'addedNames').map((server, index) => [server, { source: server, chars: (blocks[index] ?? '').length + 1 }]),
  };
}

function deltaOf(kind: SessionListKind, attachment: JsonRecord): ListDelta {
  switch (kind) {
    case 'skills':
      return skillsDelta(attachment);
    case 'tools':
      return toolsDelta(attachment);
    case 'agents':
      return agentsDelta(attachment);
    case 'instructions':
      return instructionsDelta(attachment);
  }
}

function listOf(kind: SessionListKind, entries: ReadonlyMap<string, Entry>): SessionList {
  const sources = new Map<string, { count: number; chars: number }>();
  for (const entry of entries.values()) {
    const source = sources.get(entry.source) ?? { count: 0, chars: 0 };
    sources.set(entry.source, { count: source.count + 1, chars: source.chars + entry.chars });
  }
  return {
    kind,
    count: entries.size,
    chars: [...sources.values()].reduce((sum, source) => sum + source.chars, 0),
    sources: [...sources]
      .map(([name, source]) => ({ name, ...source }))
      .sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name)),
  };
}

/**
 * The lists a session's context holds, folded over its whole transcript: the skill listing, the deferred tools, the
 * agent types and the MCP servers' instructions. Claude Code announces each list's changes as an attachment line and
 * re-announces the lists after a compaction; entries are kept by name, so a re-announcement replaces, never adds.
 */
export function foldSessionLists(text: string): SessionList[] {
  const lists = new Map<SessionListKind, Map<string, Entry>>(SESSION_LIST_KINDS.map((kind) => [kind, new Map()]));
  for (const line of text.split('\n')) {
    if (!KIND_MARKERS.some((marker) => line.includes(marker))) {
      continue;
    }
    const record = parseObject(line);
    const attachment = record === undefined ? undefined : recordField(record, 'attachment');
    const kind = attachment === undefined ? undefined : ATTACHMENT_KINDS.get(stringField(attachment, 'type') ?? '');
    const entries = kind === undefined ? undefined : lists.get(kind);
    if (attachment === undefined || kind === undefined || entries === undefined) {
      continue;
    }
    const delta = deltaOf(kind, attachment);
    if (delta.replaces) {
      entries.clear();
    }
    delta.removed.forEach((name) => entries.delete(name));
    delta.added.forEach(([name, entry]) => entries.set(name, entry));
  }
  return SESSION_LIST_KINDS.map((kind) => listOf(kind, lists.get(kind) ?? new Map()));
}

/**
 * The lists in the context of the newest session in `project`: the one running there now, when there is one. Reads
 * its whole transcript and nothing else; undefined when the project has no session transcript.
 */
export async function readSessionLists(source: TranscriptSource, projectsDir: string, project: string): Promise<SessionLists | undefined> {
  const transcript = await newestProjectTranscript(source, projectsDir, project);
  if (transcript === undefined) {
    return undefined;
  }
  const size = (await source.size(transcript)) ?? 0;
  const text = size === 0 ? '' : (await source.read(transcript, 0, size)).toString('utf8');
  return { transcript, lists: foldSessionLists(text) };
}
