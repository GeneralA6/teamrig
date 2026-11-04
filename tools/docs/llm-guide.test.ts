import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSnapshot, parseSnapshot } from '../../src/budget/snapshot.ts';
import { HELP_FLAGS } from '../../src/cli/args.ts';
import { COMMAND_FLAGS, COMMAND_SWITCHES, HELP, VERSION } from '../../src/cli/run.ts';
import { DEFAULT_LEAD_LAUNCH } from '../../src/config/defaults.ts';
import { headingAnchors, type DocFile } from './doc-check.ts';

/**
 * The LLM guide (the plugin's teamrig-guide skill) and the root llms.txt, held to the code: each CLI command has
 * exactly one section and each section a command, with the command's flags and no others; every teamrig command
 * line the guide shows is one the CLI reads; every GitHub link into this repository resolves; the requirements match
 * package.json and CI; and the lead's default model and effort, wherever the docs name them, match the code. Its
 * frontmatter and relative links are held with the other plugin skills' in plugin-skills.test.ts.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GUIDE = 'plugins/teamrig/skills/teamrig-guide';
const BLOB = 'https://github.com/GeneralA6/teamrig/blob/main/';
/** `teamrig help` and `teamrig version` are words `runCli` answers before the command table. */
const HELP_COMMAND = 'help';
const VERSION_COMMAND = 'version';

const SECTION = /^### teamrig (.+?)\s*$/;
const HEADING = /^#{1,3}\s/;
const FLAG_BULLET = /^- `--([a-z][a-z-]*)/;
const FENCE = /^\s*(`{3,})\s*([\w-]*)/;
const INLINE_COMMAND = /`(teamrig [^`]+)`/g;
const QUOTED = /"[^"]*"/g;
const BLOB_LINK = /https:\/\/github\.com\/GeneralA6\/teamrig\/blob\/main\/([^)\s#]+)(?:#([^)\s]+))?/g;
const NO_EMOJI = /\p{Emoji_Presentation}|\u{FE0F}/u;

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

const guide: readonly DocFile[] = readdirSync(join(ROOT, GUIDE))
  .filter((name) => name.endsWith('.md'))
  .sort()
  .map((name) => ({ path: `${GUIDE}/${name}`, text: read(`${GUIDE}/${name}`) }));
const llms: DocFile = { path: 'llms.txt', text: read('llms.txt') };

function guideText(name: string): string {
  const doc = guide.find((file) => file.path === `${GUIDE}/${name}`);
  if (doc === undefined) {
    throw new Error(`${GUIDE}/${name} is missing`);
  }
  return doc.text;
}

const CODE_COMMANDS: readonly string[] = [...Object.keys(COMMAND_FLAGS), HELP_COMMAND, VERSION_COMMAND].sort();

/** The flags and switches the CLI accepts for a command, sorted; none for help and version. */
function codeFlags(command: string): string[] {
  return [...(COMMAND_FLAGS[command] ?? []), ...(COMMAND_SWITCHES[command] ?? [])].sort();
}

interface Section {
  readonly command: string;
  readonly line: number;
  readonly body: readonly string[];
}

/**
 * Each `### teamrig <command>` section of commands.md, up to the next heading. A `#` line inside a code block, such
 * as a markdown template the section shows, is the block's text and no heading.
 */
function sections(text: string): Section[] {
  const found: { command: string; line: number; body: string[] }[] = [];
  let current: { command: string; line: number; body: string[] } | null = null;
  let fence: string | null = null;
  for (const [index, row] of text.split(/\r?\n/).entries()) {
    const opened = FENCE.exec(row);
    if (fence !== null) {
      if (opened !== null && (opened[1] ?? '').startsWith(fence) && opened[2] === '') {
        fence = null;
      }
      current?.body.push(row);
      continue;
    }
    if (opened !== null) {
      fence = opened[1] ?? '```';
    }
    const heading = SECTION.exec(row);
    if (heading !== null) {
      current = { command: heading[1] ?? '', line: index + 1, body: [] };
      found.push(current);
    } else if (HEADING.test(row)) {
      current = null;
    } else {
      current?.body.push(row);
    }
  }
  return found;
}

function documentedFlags(section: Section): string[] {
  return section.body.flatMap((row) => {
    const flag = FLAG_BULLET.exec(row)?.[1];
    return flag === undefined ? [] : [flag];
  });
}

interface CommandLine {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** Every teamrig command the guide shows: in `sh` blocks, and in inline code in prose. Other blocks are output. */
function commandLines(doc: DocFile): CommandLine[] {
  const lines: CommandLine[] = [];
  let fence: { readonly marker: string; readonly shell: boolean } | null = null;
  for (const [index, row] of doc.text.split(/\r?\n/).entries()) {
    const opened = FENCE.exec(row);
    const at = { path: doc.path, line: index + 1 };
    if (fence === null) {
      if (opened !== null) {
        fence = { marker: opened[1] ?? '```', shell: opened[2] === 'sh' };
      } else {
        lines.push(...Array.from(row.matchAll(INLINE_COMMAND), (match) => ({ ...at, text: match[1] ?? '' })));
      }
    } else if (opened !== null && (opened[1] ?? '').startsWith(fence.marker) && opened[2] === '') {
      fence = null;
    } else if (fence.shell && !row.trimStart().startsWith('#')) {
      lines.push(...row.split(/&&|\|\||;| \| /).map((part) => ({ ...at, text: part.trim() })));
    }
  }
  return lines.filter(({ text }) => text.startsWith('teamrig '));
}

/** `teamrig <command> --help` or `teamrig inbox -h`: one command's or one group's help, read like `teamrig help`. */
function isCommandHelp(first: string, second: string): boolean {
  return HELP_FLAGS.has(second) && (first === '<command>' || Object.keys(COMMAND_FLAGS).some((name) => name === first || name.startsWith(`${first} `)));
}

/**
 * The command a line runs and the flags it passes, or the reason the CLI would not read it. Words after
 * a bare `--` are the command line `teamrig test` runs, not flags.
 */
function parseCommand(text: string): { readonly command: string; readonly flags: readonly string[] } | string {
  const words = text.replace(QUOTED, '""').split(/\s+/).slice(1);
  const [first = '', second = ''] = words;
  if (isCommandHelp(first, second)) {
    return { command: HELP_COMMAND, flags: [] };
  }
  const pair = `${first} ${second}`;
  let command: string;
  let rest: readonly string[];
  if (Object.hasOwn(COMMAND_FLAGS, pair)) {
    command = pair;
    rest = words.slice(2);
  } else if (Object.hasOwn(COMMAND_FLAGS, first)) {
    command = first;
    rest = words.slice(1);
  } else if (HELP.has(first) || VERSION.has(first)) {
    command = HELP.has(first) ? HELP_COMMAND : VERSION_COMMAND;
    rest = words.slice(1);
  } else {
    return `no command "${first}"`;
  }
  const end = rest.indexOf('--');
  const flags = (end === -1 ? rest : rest.slice(0, end)).filter((word) => word.startsWith('--')).map((word) => word.slice(2).split('=')[0] ?? '');
  return { command, flags };
}

describe('the LLM guide documents the CLI', () => {
  const all = sections(guideText('commands.md'));

  it('answers help and version under those words', () => {
    assert.ok(HELP.has(HELP_COMMAND));
    assert.ok(VERSION.has(VERSION_COMMAND));
  });

  it('has one section per command and no section for a command that does not exist', () => {
    const documented = all.map((section) => section.command).sort();
    assert.deepEqual(
      CODE_COMMANDS.filter((command) => !documented.includes(command)),
      [],
      'commands with no ### teamrig <command> section in commands.md',
    );
    assert.deepEqual(
      documented.filter((command) => !CODE_COMMANDS.includes(command)),
      [],
      'sections in commands.md for commands the CLI does not have',
    );
    assert.deepEqual(
      documented.filter((command, index) => documented.indexOf(command) !== index),
      [],
      'commands with two sections',
    );
  });

  it("lists exactly each command's flags, or says it has none", () => {
    for (const section of all) {
      const flags = documentedFlags(section);
      assert.deepEqual([...flags].sort(), codeFlags(section.command), `the flags of teamrig ${section.command} (commands.md:${section.line})`);
      assert.equal(section.body.includes('Flags: none.'), flags.length === 0, `teamrig ${section.command} says "Flags: none." exactly when it has none`);
    }
  });

  it('gives each command an example that runs it, and its output', () => {
    for (const section of all) {
      const example = section.body.indexOf('```sh');
      assert.ok(example !== -1, `teamrig ${section.command} has a sh example (commands.md:${section.line})`);
      assert.ok((section.body[example + 1] ?? '').startsWith(`teamrig ${section.command}`), `the example of teamrig ${section.command} runs it`);
      assert.ok(section.body.some((row) => row.startsWith('Output')), `teamrig ${section.command} shows its output`);
    }
  });

  it('shows only command lines the CLI reads, with flags their command takes', () => {
    const problems = [...guide, llms].flatMap(commandLines).flatMap(({ path, line, text }) => {
      const parsed = parseCommand(text);
      if (typeof parsed === 'string') {
        return [`${path}:${line} ${text}: ${parsed}`];
      }
      const allowed = codeFlags(parsed.command);
      return parsed.flags.filter((flag) => !allowed.includes(flag)).map((flag) => `${path}:${line} ${text}: teamrig ${parsed.command} takes no --${flag}`);
    });
    assert.deepEqual(problems, []);
  });
});

describe('the LLM guide skill', () => {
  const skill = guideText('SKILL.md');

  it('links each of its reference files', () => {
    const files = guide.map((doc) => doc.path.slice(GUIDE.length + 1)).filter((name) => name !== 'SKILL.md');
    assert.deepEqual(
      files.filter((name) => !skill.includes(`](${name})`)),
      [],
    );
  });

  it('has no emoji', () => {
    assert.deepEqual(
      [...guide, llms].filter((doc) => NO_EMOJI.test(doc.text)).map((doc) => doc.path),
      [],
    );
  });

  it('has links into this repository that resolve, anchors included', () => {
    const problems = [...guide, llms].flatMap((doc) =>
      Array.from(doc.text.matchAll(BLOB_LINK), (match) => {
        const path = match[1] ?? '';
        const anchor = match[2];
        if (!existsSync(join(ROOT, path))) {
          return `${doc.path}: ${path} does not exist`;
        }
        return anchor === undefined || headingAnchors(read(path)).has(anchor) ? undefined : `${doc.path}: ${path} has no #${anchor}`;
      }).filter((problem) => problem !== undefined),
    );
    assert.deepEqual(problems, []);
  });
});

describe('llms.txt', () => {
  it('only links: a title, a one-line summary, headings and link bullets', () => {
    const other = llms.text
      .split(/\r?\n/)
      .filter((row) => row !== '' && !/^# \S/.test(row) && !/^> \S/.test(row) && !/^## \S/.test(row) && !/^- \[[^\]]+\]\(https:\/\/[^)]+\)/.test(row));
    assert.deepEqual(other, []);
  });

  it('links every guide file', () => {
    assert.deepEqual(
      guide.filter((doc) => !llms.text.includes(`${BLOB}${doc.path})`)).map((doc) => doc.path),
      [],
    );
  });
});

describe('the requirements in the guide', () => {
  const requirements = guideText('requirements.md');

  it('name the Node.js version package.json requires', () => {
    const node = /"node":\s*">=([\d.]+)"/.exec(read('package.json'))?.[1];
    assert.ok(node !== undefined, 'package.json gives engines.node as >=x.y');
    assert.ok(requirements.includes(`${node} or later`), `requirements.md names Node.js ${node} or later`);
  });

  it('name the operating systems and Node.js versions CI tests on', () => {
    const ci = read('.github/workflows/ci.yml');
    const list = (key: string): string[] =>
      (new RegExp(`^\\s*${key}: \\[([^\\]]+)\\]`, 'm').exec(ci)?.[1] ?? '').split(',').map((item) => item.trim().replace(/-latest$/, ''));
    const systems = list('os');
    const nodes = list('node');
    assert.ok(systems.length > 1 && nodes.length > 1, 'ci.yml has an os and node matrix');
    assert.ok(requirements.includes(`CI runs the tests on ${systems.slice(0, -1).join(', ')} and ${systems.at(-1) ?? ''}`), `requirements.md names ${systems.join(', ')}`);
    assert.ok(requirements.includes(`Node ${nodes.join(' and ')}`), `requirements.md names Node ${nodes.join(' and ')}`);
  });

  it('give the one allow rule default mode needs, wherever a new user looks', () => {
    const rule = '`Bash(teamrig:*)`';
    for (const [name, text] of [['requirements.md', requirements], ['setup-by-hand.md', read('docs/setup-by-hand.md')], ['README.md', read('README.md')]] as const) {
      assert.ok(text.includes(rule) || text.includes('"Bash(teamrig:*)"'), `${name} names ${rule}`);
    }
    const permissions = guideText('hooks.md').split('## Permissions\n')[1] ?? '';
    assert.match(permissions, /\{ "permissions": \{ "allow": \["Bash\(teamrig:\*\)"\] \} \}/);
    assert.doesNotMatch(permissions, /Default mode\*\*: not tested/);
  });
});

/** The sentence of `text` that holds `marker`, its line breaks read as spaces; empty when none does. */
function sentenceWith(text: string, marker: string): string {
  const flat = text.replace(/\s*\r?\n\s*/g, ' ');
  const at = flat.indexOf(marker);
  if (at < 0) return '';
  const start = flat.lastIndexOf('. ', at);
  const end = flat.indexOf('. ', at);
  return flat.slice(start < 0 ? 0 : start + 2, end < 0 ? undefined : end + 1);
}

describe("the lead's default launch in the docs", () => {
  const { model, effort } = DEFAULT_LEAD_LAUNCH;
  const tick = (word: string): string => `\`${word}\``;

  it('is the model and effort the code starts the lead on', () => {
    const guide = sentenceWith(guideText('commands.md'), "the lead's unset keys default to");
    assert.ok(guide.includes(`model ${tick(model)} at ${tick(effort)} effort`), `commands.md: ${guide}`);
    const growTheTeam = sentenceWith(read('docs/guides/grow-the-team.md'), 'The lead, for each it leaves unset');
    assert.ok(growTheTeam.includes(`starts on ${tick(model)}`) && growTheTeam.includes(`at ${tick(effort)} effort`), `grow-the-team.md: ${growTheTeam}`);
    const setup = read('plugins/teamrig/skills/team-setup/SKILL.md');
    assert.ok(setup.includes(`${tick(`/model ${model}`)} and ${tick(`/effort ${effort}`)}`), 'team-setup names the /model and /effort to type');
  });

  it('finds a sentence across line breaks, and nothing for a missing marker', () => {
    assert.equal(sentenceWith('One. The lead\nstarts on `x`. Two.', 'The lead'), 'The lead starts on `x`.');
    assert.equal(sentenceWith('The lead starts', 'The lead'), 'The lead starts');
    assert.equal(sentenceWith('One.', 'The lead'), '');
  });
});

describe('the status line snapshot in the guide', () => {
  it('is the pinned format teamrig budget reads, so a status line of your own can copy it', () => {
    const commands = guideText('commands.md');
    const from = commands.indexOf('Bring your own status line');
    const example = /^```json\n(.+)\n```$/m.exec(commands.slice(from))?.[1];
    assert.ok(from >= 0 && example !== undefined, 'commands.md shows the snapshot JSON after "Bring your own status line"');
    const parsed = parseSnapshot(example);
    assert.ok(parsed !== undefined, 'the example parses as a snapshot');
    assert.equal(formatSnapshot(parsed), example);
    assert.ok(parsed.rateLimits?.sevenDay !== null && parsed.rateLimits?.sevenDay !== undefined, 'the example carries the week');
  });
});
