import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Files } from '../core/files.ts';
import type { PathProbe } from '../core/path-probe.ts';
import { expandHome, pathKey } from '../core/paths.ts';
import { claudeMdPaths, claudeMemoryDir, skillFolders } from '../doctor/context-files.ts';
import { markdownBelow } from '../rules/places.ts';
import { descriptionOf, splitFrontmatter } from '../skills/lint.ts';
import { SkillDir } from '../skills/store.ts';

/** Where a file every session loads comes from: a CLAUDE.md, a file one imports, an unconditional rule, the memory index or the team's rules. */
export type ContextKind = 'claude-md' | 'import' | 'rules' | 'memory' | 'team-rules';

/** A file Claude Code puts in every call's context, with the text it loads (for the memory index, its first lines only). */
export interface LoadedFile {
  readonly kind: ContextKind;
  readonly path: string;
  readonly text: string;
}

/** A user or project skill, and the line Claude Code lists it by in every call's context. */
export interface ListedSkill {
  readonly name: string;
  readonly path: string;
  readonly description: string;
  readonly line: string;
}

/** The files and skills a session in a project loads at its start. */
export interface SessionContext {
  readonly files: readonly LoadedFile[];
  readonly skills: readonly ListedSkill[];
}

export interface SessionContextLocations {
  /** Claude Code's own folder (`claudeConfigDir`). */
  readonly claudeDir: string;
  readonly userHome: string;
  /** The project folder sessions start in. */
  readonly project: string;
  /** The skills folder Claude Code lists the user's skills from: the team's, else `<claudeDir>/skills`. */
  readonly skills: string;
  /** The team's rules file; none before a team exists. */
  readonly teamRules: string | undefined;
}

/** Claude Code loads this many lines of the memory index. */
export const MEMORY_INDEX_LINES = 200;
/** Claude Code follows `@path` imports this many hops deep. */
export const IMPORT_DEPTH = 5;

/** Fenced blocks and inline code spans, where an `@` is not an import. */
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
/** An `@path` import: an `@` at a line's start or after a space, so an e-mail address is not one. */
const IMPORT = /(?:^|\s)@(\S+)/g;
/** A frontmatter `paths:` key: the rule loads only when a session works on a matching file. */
const PATHS_KEY = /^paths\s*:/m;

/** The files `text` imports, as absolute paths: `~/` from the home folder, a relative one from the importing file's folder. */
export function importsOf(text: string, importer: string, userHome: string): string[] {
  const prose = text.replace(CODE, ' ');
  return Array.from(prose.matchAll(IMPORT), (match) => {
    const path = expandHome(match[1] ?? '', userHome);
    return isAbsolute(path) ? path : resolve(dirname(importer), path);
  });
}

/** The listing line of a skill: `- name: description`, as Claude Code lists it. */
export function listingLineOf(name: string, description: string): string {
  return `- ${name}: ${description}\n`;
}

/** Reads each path once, in order, as `kind`, skipping a missing file and one already loaded. */
class LoadedFiles {
  readonly files: LoadedFile[] = [];
  private readonly seen = new Set<string>();
  private readonly reader: Files;

  constructor(reader: Files) {
    this.reader = reader;
  }

  async add(kind: ContextKind, path: string, cut: (text: string) => string = (text) => text): Promise<LoadedFile | undefined> {
    if (this.seen.has(pathKey(path))) {
      return undefined;
    }
    const text = await this.reader.read(path);
    return text === undefined ? undefined : this.keep(kind, path, cut(text));
  }

  /** Keeps a file already read, unless it was loaded before. */
  keep(kind: ContextKind, path: string, text: string): LoadedFile | undefined {
    const key = pathKey(path);
    if (this.seen.has(key)) {
      return undefined;
    }
    this.seen.add(key);
    const file: LoadedFile = { kind, path, text };
    this.files.push(file);
    return file;
  }
}

async function addImports(loaded: LoadedFiles, file: LoadedFile, userHome: string, depth: number): Promise<void> {
  if (depth > IMPORT_DEPTH) {
    return;
  }
  for (const path of importsOf(file.text, file.path, userHome)) {
    const imported = await loaded.add('import', path);
    if (imported !== undefined) {
      await addImports(loaded, imported, userHome, depth + 1);
    }
  }
}

async function readSkills(files: Files, at: SessionContextLocations): Promise<ListedSkill[]> {
  const listed: ListedSkill[] = [];
  for (const folder of skillFolders(at.skills, at.project)) {
    const dir = new SkillDir(files, folder);
    for (const skill of await dir.readAll()) {
      const description = descriptionOf(splitFrontmatter(skill.text).front) ?? '';
      listed.push({ name: skill.name, path: dir.pathOf(skill.name), description, line: listingLineOf(skill.name, description) });
    }
  }
  return listed;
}

/**
 * What every session in `at.project` loads at its start: the user's and the project's CLAUDE.md files and the files
 * they import with `@path`, the `.claude/rules` files without a `paths:` frontmatter, the first lines of the memory
 * index, the team's rules, and the listing of the user's and project's skills. It only reads.
 */
export async function readSessionContext(files: Files, probe: PathProbe, at: SessionContextLocations): Promise<SessionContext> {
  const loaded = new LoadedFiles(files);
  for (const path of claudeMdPaths(at.claudeDir, at.project)) {
    const file = await loaded.add('claude-md', path);
    if (file !== undefined) {
      await addImports(loaded, file, at.userHome, 1);
    }
  }
  const rules = [...(await markdownBelow(files, probe, join(at.project, '.claude', 'rules'))), ...(await markdownBelow(files, probe, join(at.claudeDir, 'rules')))];
  for (const path of rules) {
    const text = await files.read(path);
    if (text !== undefined && !PATHS_KEY.test(splitFrontmatter(text).front)) {
      loaded.keep('rules', path, text);
    }
  }
  await loaded.add('memory', join(claudeMemoryDir(at.claudeDir, at.project), 'MEMORY.md'), (text) => text.split('\n').slice(0, MEMORY_INDEX_LINES).join('\n'));
  if (at.teamRules !== undefined) {
    await loaded.add('team-rules', at.teamRules);
  }
  return { files: loaded.files, skills: await readSkills(files, at) };
}
