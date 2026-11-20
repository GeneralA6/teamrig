import { isRecord, recordField, stringField, withoutStampFooter, type JsonRecord, type StampCredit } from '../../../plugin-api/index.ts';

/**
 * Jira's document format (ADF), read to plain text and written from it. Jira Cloud's API version 3 gives and takes
 * every description and comment as an ADF tree, where teamrig's own texts are plain lines; a document read is outside
 * input, so every field of it is narrowed before use.
 */

/** How deep a document is read. Jira nests a few levels (a list in a table cell in an expand); past this it is no real document. */
const MAX_DEPTH = 50;

/** A line that would open or close a fenced block in the text. */
const FENCE_LINE = /^\s*(?:```|~~~)/;

function contentOf(node: JsonRecord): readonly unknown[] {
  const content: unknown = node['content'];
  return Array.isArray(content) ? content : [];
}

function attrText(node: JsonRecord, key: string): string {
  const attrs = recordField(node, 'attrs');
  return (attrs === undefined ? undefined : stringField(attrs, key)) ?? '';
}

/** The text of a node that sits inside a line, or undefined when the node is a block or an unknown one. */
function inlineText(node: JsonRecord): string | undefined {
  switch (node['type']) {
    case 'text':
      return stringField(node, 'text') ?? '';
    case 'hardBreak':
      return '\n';
    case 'mention':
    case 'emoji':
    case 'status':
      return attrText(node, 'text');
    case 'inlineCard':
      return attrText(node, 'url');
    default:
      return undefined;
  }
}

/** Each line of `text` behind `first` on its first line and `rest` on the others. */
function prefixed(text: string, first: string, rest: string): string {
  return text
    .split('\n')
    .map((line, index) => `${index === 0 ? first : rest}${line}`.trimEnd())
    .join('\n');
}

/** A list as one block, each item behind its mark and an item's later lines under its first. */
function listBlock(node: JsonRecord, depth: number, markOf: (index: number) => string): string {
  return contentOf(node)
    .map((item) => blocksOf(item, depth + 1).join('\n'))
    .filter((item) => item !== '')
    .map((item, index) => prefixed(item, markOf(index), '  '))
    .join('\n');
}

/**
 * A code block behind a fence, so a reader of the text (the claim line's matcher) passes over it as it passes over a
 * fenced block on a Markdown host. A line of the code that is itself a fence gets a backslash, or it would end the
 * block early and put the code after it back in the text.
 */
function codeBlock(node: JsonRecord): string {
  const code = contentOf(node)
    .map((child) => (isRecord(child) ? (inlineText(child) ?? '') : ''))
    .join('')
    .split('\n')
    .map((line) => (FENCE_LINE.test(line) ? `\\${line}` : line))
    .join('\n');
  return `\`\`\`\n${code}\n\`\`\``;
}

/** The node's children as blocks: a run of inline children is one block, every other child gives its own. */
function childBlocks(node: JsonRecord, depth: number): string[] {
  const blocks: string[] = [];
  let line: string | undefined;
  for (const child of contentOf(node)) {
    const inline = isRecord(child) ? inlineText(child) : undefined;
    if (inline !== undefined) {
      line = `${line ?? ''}${inline}`;
      continue;
    }
    if (line !== undefined) {
      blocks.push(line);
      line = undefined;
    }
    blocks.push(...blocksOf(child, depth + 1));
  }
  return line === undefined ? blocks : [...blocks, line];
}

/** The blocks of text under `node`, top to bottom, none of them empty. A node of an unknown type gives what its children hold. */
function blocksOf(node: unknown, depth: number): string[] {
  if (!isRecord(node) || depth > MAX_DEPTH) {
    return [];
  }
  const blocks = ((): string[] => {
    switch (node['type']) {
      case 'codeBlock':
        return [codeBlock(node)];
      case 'blockquote': {
        // Quoted lines are someone else's words: behind `> `, a claim line in them starts no line of the text.
        const quoted = childBlocks(node, depth).join('\n\n');
        return quoted === '' ? [] : [prefixed(quoted, '> ', '> ')];
      }
      case 'bulletList':
        return [listBlock(node, depth, () => '- ')];
      case 'orderedList':
        return [listBlock(node, depth, (index) => `${index + 1}. `)];
      default:
        return [inlineText(node) ?? '', ...childBlocks(node, depth)];
    }
  })();
  return blocks.map((block) => block.replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '')).filter((block) => block !== '');
}

/**
 * The plain text of an ADF document (or of any node of one), its blocks a blank line apart. A hard break is a new
 * line, a mention and an emoji their own text, a card its address. Anything that is no document gives the empty text.
 */
export function adfText(node: unknown): string {
  return blocksOf(node, 0).join('\n\n');
}

/** A link on a text. */
interface AdfLink {
  readonly type: 'link';
  readonly attrs: { readonly href: string };
}

/** What a paragraph teamrig writes holds: text, some of it a link, and line breaks. */
type AdfInline = { readonly type: 'text'; readonly text: string; readonly marks?: readonly AdfLink[] } | { readonly type: 'hardBreak' };

interface AdfParagraph {
  readonly type: 'paragraph';
  readonly content: readonly AdfInline[];
}

/** A document as teamrig writes one: paragraphs only. */
export interface AdfDoc {
  readonly type: 'doc';
  readonly version: 1;
  readonly content: readonly AdfParagraph[];
}

/** Whether a paragraph is the credit of an earlier write, as it reads once its document is flattened: `Made with <name> <version>`. */
function isCredit(lines: readonly string[], name: string): boolean {
  const [line, ...more] = lines;
  const start = `Made with ${name} `;
  return line !== undefined && more.length === 0 && line.startsWith(start) && /^\S+$/.test(line.slice(start.length));
}

function paragraph(lines: readonly string[]): AdfParagraph {
  return {
    type: 'paragraph',
    content: lines.flatMap((line, index): AdfInline[] => (index === 0 ? [{ type: 'text', text: line }] : [{ type: 'hardBreak' }, { type: 'text', text: line }])),
  };
}

function creditParagraph(credit: StampCredit): AdfParagraph {
  return {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Made with ' },
      { type: 'text', text: credit.name, marks: [{ type: 'link', attrs: { href: credit.link } }] },
      { type: 'text', text: ` ${credit.version}` },
    ],
  };
}

/**
 * `text` as an ADF document: a paragraph for each run of lines between blank ones, its lines apart by hard breaks.
 * With a `credit`, the made-with footer is the last paragraph, once: a Markdown footer on the text, or the credit
 * paragraph of an earlier write read back with the text, is taken off first.
 */
export function textAdf(text: string, credit?: StampCredit): AdfDoc {
  // Jira refuses an empty text node, so a line with no text is left out here, before any node is made of it.
  const paragraphs = withoutStampFooter(text)
    .split(/\r?\n(?:[ \t]*\r?\n)+/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line !== ''),
    )
    .filter((lines) => lines.length > 0);
  const kept = credit === undefined ? paragraphs : paragraphs.filter((lines, index) => index !== paragraphs.length - 1 || !isCredit(lines, credit.name));
  return {
    type: 'doc',
    version: 1,
    content: [...kept.map(paragraph), ...(credit === undefined ? [] : [creditParagraph(credit)])],
  };
}
