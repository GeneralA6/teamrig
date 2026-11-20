import { posix } from 'node:path';

/**
 * The layer boundaries of `src/`, checked over file text alone: what the core may import, who may import an
 * adapter, what an adapter may import, and which lines outside the adapters still name a tool. The last is the
 * backlog of the move into adapters, counted so it can only shrink.
 */

/** One source file: its path from the repo root with `/` separators, and its text. */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export const BOUNDARY_RULES = [
  { id: 'core-imports', title: 'imports from src/core into another src folder' },
  { id: 'adapter-reach', title: 'imports of an adapter by shipped code outside src/adapters and src/composition' },
  { id: 'adapter-imports', title: 'imports by an adapter beyond its own folder and the plugin API' },
  { id: 'tool-names', title: 'lines naming a tool outside src/adapters and src/composition' },
] as const;

export type BoundaryRule = (typeof BOUNDARY_RULES)[number]['id'];

export interface BoundaryFinding {
  readonly rule: BoundaryRule;
  readonly path: string;
  /** From 1. */
  readonly line: number;
  /** The import's target from the repo root, or the tools the line names. */
  readonly detail: string;
}

const SRC = 'src/';
const CORE = 'src/core/';
const ADAPTERS = 'src/adapters/';
const COMPOSITION = 'src/composition/';
const TESTING = 'src/testing/';
const PLUGIN_API = 'src/plugin-api/index.ts';
const CONFORMANCE_KIT = 'src/conformance/index.ts';
const SPEC = /\.test\.ts$/;
/** A relative specifier after `from`, `import(` or a bare `import`. */
const RELATIVE_IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
/** No word boundary: `claudeSession` and `GITHUB_TOKEN` name a tool as much as the bare word does. */
const TOOL_NAME = /claude|codex|github|jira|grok/gi;

interface ImportLine {
  readonly line: number;
  /** The imported file, from the repo root. */
  readonly target: string;
}

function importsOf(file: SourceFile): readonly ImportLine[] {
  const folder = posix.dirname(file.path);
  return file.text.split('\n').flatMap((text, index) => [...text.matchAll(RELATIVE_IMPORT)].flatMap((match) => (match[1] === undefined ? [] : [{ line: index + 1, target: posix.join(folder, match[1]) }])));
}

/** The folder of the adapter a file belongs to (`src/adapters/<side>/<id>/`); a file above one answers for its own folder. */
function adapterFolder(path: string): string {
  const parts = path.split('/');
  return parts.length > 4 ? `${parts.slice(0, 4).join('/')}/` : `${posix.dirname(path)}/`;
}

/** The core stands alone; its specs may use the fakes. */
function coreAllows(file: SourceFile, target: string): boolean {
  return !target.startsWith('src/') || target.startsWith(CORE) || (SPEC.test(file.path) && target.startsWith(TESTING));
}

/**
 * An adapter sees its own folder and the plugin API's one file; its specs may use the fakes and the conformance kit's
 * one file, which an adapter's `contracts.test.ts` binds its contracts from.
 */
function adapterAllows(file: SourceFile, target: string): boolean {
  return target.startsWith(adapterFolder(file.path)) || target === PLUGIN_API || (SPEC.test(file.path) && (target.startsWith(TESTING) || target === CONFORMANCE_KIT));
}

/**
 * Who may import an adapter: the adapters, the composition, and what never ships, the specs and fakes of `src`.
 * A command's spec drives the real adapter over a fake tool, so it needs the adapter's request shapes.
 */
function reachesAdapters(path: string): boolean {
  const unshipped = path.startsWith(SRC) && (SPEC.test(path) || path.startsWith(TESTING));
  return unshipped || [ADAPTERS, COMPOSITION].some((folder) => path.startsWith(folder));
}

function importFindings(file: SourceFile): readonly BoundaryFinding[] {
  const inCore = file.path.startsWith(CORE);
  const inAdapter = file.path.startsWith(ADAPTERS);
  const mayReachAdapters = reachesAdapters(file.path);
  return importsOf(file).flatMap(({ line, target }) => {
    const found = (rule: BoundaryRule): BoundaryFinding => ({ rule, path: file.path, line, detail: target });
    return [
      ...(inCore && !coreAllows(file, target) ? [found('core-imports')] : []),
      ...(!mayReachAdapters && target.startsWith(ADAPTERS) ? [found('adapter-reach')] : []),
      ...(inAdapter && !adapterAllows(file, target) ? [found('adapter-imports')] : []),
    ];
  });
}

/** Whether a file is shipped code the adapters must come to hold every tool's name for. */
function mustNameNoTool(path: string): boolean {
  return path.startsWith('src/') && !SPEC.test(path) && ![ADAPTERS, COMPOSITION, TESTING].some((folder) => path.startsWith(folder));
}

function toolNameFindings(file: SourceFile): readonly BoundaryFinding[] {
  if (!mustNameNoTool(file.path)) {
    return [];
  }
  return file.text.split('\n').flatMap((text, index) => {
    const names = [...new Set([...text.matchAll(TOOL_NAME)].map((match) => match[0].toLowerCase()))];
    return names.length === 0 ? [] : [{ rule: 'tool-names' as const, path: file.path, line: index + 1, detail: names.join(', ') }];
  });
}

/** Every finding in the files, in their order, a file's imports before its tool names. */
export function boundaryFindings(files: readonly SourceFile[]): readonly BoundaryFinding[] {
  return files.flatMap((file) => [...importFindings(file), ...toolNameFindings(file)]);
}

/** How many findings each rule has, in the order of `BOUNDARY_RULES`, as the line a person reads. */
export function boundaryCounts(findings: readonly BoundaryFinding[]): readonly string[] {
  return BOUNDARY_RULES.map(({ id, title }) => `${findings.filter((finding) => finding.rule === id).length} ${title}`);
}

export function findingLine(finding: BoundaryFinding): string {
  return `${finding.path}:${finding.line}: ${finding.rule}: ${finding.detail}`;
}
