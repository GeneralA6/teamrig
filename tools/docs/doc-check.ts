import { posix } from 'node:path';

/**
 * Checks the repo's Markdown the way a reader meets it on GitHub: every relative link and image points at a file
 * that exists, every `#anchor` at a heading that exists, and every Mermaid block opens with a diagram type GitHub
 * draws. It reads only the texts it is given, so it runs the same in a test and in CI.
 */

export interface DocFile {
  /** The path from the repo root, with forward slashes (`README.md`, `docs/how-it-works.md`). */
  readonly path: string;
  readonly text: string;
}

export interface DocProblem {
  readonly path: string;
  readonly line: number;
  readonly message: string;
}

export interface DocReport {
  readonly links: number;
  readonly diagrams: number;
  readonly problems: readonly DocProblem[];
}

/** The diagram types GitHub's Mermaid renders that these docs may use. */
export const MERMAID_TYPES = ['flowchart', 'graph', 'sequenceDiagram', 'stateDiagram-v2', 'stateDiagram', 'classDiagram', 'erDiagram', 'timeline', 'mindmap'] as const;

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w-]*)/;
/** The target of every inline link or image, nested ones included (`[![badge](a.svg)](b.md)` gives both). */
const INLINE_TARGET = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const REFERENCE_TARGET = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/g;
const HTML_TARGET = /<(?:img|a|source)\b[^>]*?\s(?:src|href|srcset)="([^"]+)"/g;
const INLINE_CODE = /`+[^`]*`+/g;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

interface Block {
  readonly language: string;
  readonly line: number;
  readonly body: readonly string[];
  readonly closed: boolean;
}

interface Row {
  /** 1-based. */
  readonly line: number;
  readonly text: string;
}

interface Scan {
  /** The lines outside fenced blocks. */
  readonly prose: readonly Row[];
  readonly blocks: readonly Block[];
}

function scan(text: string): Scan {
  const prose: Row[] = [];
  const blocks: Block[] = [];
  let open: { fence: string; language: string; line: number; body: string[] } | null = null;
  for (const [index, row] of text.split(/\r?\n/).entries()) {
    const fence = FENCE.exec(row);
    if (open === null) {
      if (fence === null) prose.push({ line: index + 1, text: row });
      else open = { fence: fence[1] ?? '```', language: fence[2] ?? '', line: index + 1, body: [] };
    } else if (fence !== null && (fence[1] ?? '').startsWith(open.fence) && fence[2] === '') {
      blocks.push({ ...open, closed: true });
      open = null;
    } else open.body.push(row);
  }
  if (open !== null) blocks.push({ ...open, closed: false });
  return { prose, blocks };
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens; a repeat gets `-1`, `-2`, ... */
export function headingAnchors(text: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const { text: row } of scan(text).prose) {
    const heading = HEADING.exec(row);
    if (heading === null) continue;
    const words = (heading[1] ?? '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '');
    const slug = words.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

function targetsIn(row: string): string[] {
  const prose = row.replace(INLINE_CODE, '');
  return [INLINE_TARGET, REFERENCE_TARGET, HTML_TARGET].flatMap((pattern) => [...prose.matchAll(pattern)].map((match) => match[1] ?? ''));
}

function decoded(file: string): string | null {
  try {
    return decodeURI(file);
  } catch {
    return null;
  }
}

/**
 * Checks each doc. `exists` answers for a path from the repo root; an anchor into another doc is checked when that
 * doc is one of `docs`, and only the file's existence otherwise.
 */
export function checkDocs(docs: readonly DocFile[], exists: (path: string) => boolean): DocReport {
  const anchorsOf = new Map(docs.map((doc) => [doc.path, headingAnchors(doc.text)] as const));
  const problems: DocProblem[] = [];
  let links = 0;
  let diagrams = 0;
  for (const doc of docs) {
    const report = (line: number, message: string): void => {
      problems.push({ path: doc.path, line, message });
    };
    const { prose, blocks } = scan(doc.text);
    for (const { line, text } of prose) {
      for (const target of targetsIn(text)) {
        if (EXTERNAL.test(target)) continue;
        links += 1;
        const [file = '', anchor = ''] = target.split('#', 2);
        const name = decoded(file);
        // GitHub resolves `/x` from the repo root and anything else from the doc's folder.
        const from = name?.startsWith('/') === true ? name.slice(1) : posix.join(posix.dirname(doc.path), name ?? '');
        const path = name === null || name === '' ? doc.path : posix.normalize(from);
        if (name === null) report(line, `${target}: not a valid link`);
        else if (path === '..' || path.startsWith('../')) report(line, `${target} points outside the repo`);
        else if (name !== '' && !exists(path)) report(line, `${target}: no file ${path}`);
        else if (anchor !== '' && anchorsOf.get(path)?.has(anchor.toLowerCase()) === false) report(line, `${target}: no heading #${anchor} in ${path}`);
      }
    }
    for (const block of blocks) {
      if (!block.closed) report(block.line, `a ${block.language === '' ? 'code' : block.language} block is never closed`);
      if (block.language !== 'mermaid') continue;
      diagrams += 1;
      const first = block.body.map((row) => row.trim()).find((row) => row !== '' && !row.startsWith('%%'));
      if (first === undefined) report(block.line, 'an empty mermaid block');
      else if (!MERMAID_TYPES.some((type) => first === type || first.startsWith(`${type} `))) {
        report(block.line, `a mermaid block opens with "${first}", not one of: ${MERMAID_TYPES.join(', ')}`);
      }
    }
  }
  return { links, diagrams, problems };
}

/** One line per problem, `path:line message`, in the order found. */
export function describeProblems(problems: readonly DocProblem[]): string[] {
  return problems.map((problem) => `${problem.path}:${problem.line} ${problem.message}`);
}
