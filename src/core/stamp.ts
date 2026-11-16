import { KIT_NAME } from './home.ts';
import { KIT_VERSION } from './version.ts';

/**
 * The "made with teamrig" stamp (GeneralA6/teamrig#1102): credit on what teamrig writes, and a way for a reader to
 * find the project, as Claude Code's "Generated with" line does. This module is the one place its text is built;
 * every writer calls it rather than formatting its own, so the wording changes in one place.
 */

/** The project's home, the link of the footer; a test holds it to the plugin manifest's `repository`. */
export const STAMP_LINK = 'https://github.com/GeneralA6/teamrig';

/**
 * The hidden line that ends every footer. It is how a later write finds an earlier footer, whatever its version
 * or wording, so a rerun, a retry or an edit of a stamped text keeps one footer.
 */
export const STAMP_MARKER = '<!-- teamrig-stamp -->';

/**
 * What goes in front of the name in the footer: nothing until the logo lands (its own issue under #1104), then the
 * icon, 14 px high, with a space after it. The icon carries teamrig's palette in its own SVG, so the footer sets no
 * colour.
 */
export const STAMP_ICON = '';

/** The trailer key a commit teamrig makes carries; git matches trailer keys without case. */
export const STAMP_TRAILER_KEY = 'Made-with';

/** The Markdown footer: `<sub>Made with [teamrig](link) <version></sub>`, then the marker on its own line. */
export function stampFooter(version: string = KIT_VERSION): string {
  return `<sub>Made with ${STAMP_ICON}[${KIT_NAME}](${STAMP_LINK}) ${version}</sub>\n${STAMP_MARKER}`;
}

/**
 * A footer the marker ends: the blank lines before it, the `<sub>` line above the marker when there is one (an older
 * footer may say another version or wording), and the marker line. Line ends may be `\r\n`, as in a body file saved
 * on Windows.
 */
const FOOTER = new RegExp(`(?:\\r?\\n)*(?:^<sub>[^\\r\\n]*</sub>[ \\t]*\\r?\\n)?^[ \\t]*${STAMP_MARKER}[ \\t]*(?:(?:\\r?\\n)+|$)`, 'gmu');

/** `body` with every footer the marker finds taken out; text after a footer stays, a paragraph apart from what was before it. */
export function withoutStampFooter(body: string): string {
  return body.replace(FOOTER, (match: string, at: number, whole: string) => (at === 0 || at + match.length === whole.length ? '' : '\n\n')).trimEnd();
}

/**
 * `body` with one footer at its end: any earlier footer is taken out first, so stamping a stamped text, or one edited
 * after it was posted, leaves a single footer at `version`.
 */
export function withStampFooter(body: string, version: string = KIT_VERSION): string {
  const bare = withoutStampFooter(body);
  return bare === '' ? stampFooter(version) : `${bare}\n\n${stampFooter(version)}`;
}

/** The commit trailer: `Made-with: teamrig <version>`. */
export function stampTrailer(version: string = KIT_VERSION): string {
  return `${STAMP_TRAILER_KEY}: ${KIT_NAME} ${version}`;
}

/** A trailer line (`Key: value`) or the indented continuation of one, as git reads a trailer block. */
const TRAILER_LINE = /^(?:[A-Za-z0-9][A-Za-z0-9-]*:\s|[ \t]+\S)/u;

/** A `Made-with:` line, in any case. */
const STAMP_TRAILER_LINE = new RegExp(`^${STAMP_TRAILER_KEY}:`, 'iu');

/**
 * `message` with one `Made-with:` trailer in git's trailer block, its last paragraph when every line of that is a
 * trailer, else a new last paragraph. Any `Made-with:` line already in the block is dropped first, so a rerun or an
 * amend keeps one, at `version`.
 */
export function withStampTrailer(message: string, version: string = KIT_VERSION): string {
  const text = message.trimEnd();
  const split = text.lastIndexOf('\n\n');
  const head = split === -1 ? '' : text.slice(0, split);
  const last = split === -1 ? text : text.slice(split + 2);
  const lines = last.split('\n');
  // A subject alone is never a trailer block, even one shaped `fix: x`: git reads the first paragraph as the title.
  const isBlock = split !== -1 && lines.every((line) => TRAILER_LINE.test(line)) && !/^[ \t]/u.test(last);
  if (!isBlock) {
    return text === '' ? stampTrailer(version) : `${text}\n\n${stampTrailer(version)}`;
  }
  const kept = lines.filter((line) => !STAMP_TRAILER_LINE.test(line));
  return `${head}\n\n${[...kept, stampTrailer(version)].join('\n')}`;
}
