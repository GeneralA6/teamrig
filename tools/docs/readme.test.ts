import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MARKETPLACE, readCatalog } from '../ci/plugin-version.ts';
import { isRecord, stringField } from '../lib/guards.ts';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');
const README = read('README.md');

/** The targets of the README's Markdown images and links, in order. */
const targets = (kind: 'image' | 'link'): string[] =>
  [...README.matchAll(kind === 'image' ? /!\[[^\]]*\]\(([^)\s]+)\)/g : /(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g)].map((found) => found[1] ?? '');

/** The text under `heading` (its whole line), up to the next heading of the same level or higher. */
function section(heading: string): string {
  const from = README.indexOf(`\n${heading}\n`);
  assert.ok(from >= 0, `the README has a "${heading}" heading`);
  const body = README.slice(from + heading.length + 2);
  const level = heading.indexOf(' ');
  const next = new RegExp(`^#{1,${level}} `, 'm').exec(body);
  return next === null ? body : body.slice(0, next.index);
}

describe('README.md', () => {
  it("shows its pictures in order: hero, how it works, a task's trip, a lead's morning, why it is different, your terminal, your meeting, the plan, a skill, a reboot, growth", () => {
    assert.deepEqual(
      targets('image'),
      ['hero', 'how-it-works', 'task-flow', 'lead-morning', 'why', 'terminal-view', 'lead-meeting', 'plan', 'skill', 'reboot', 'growth'].map((name) => `docs/images/${name}.svg`),
    );
  });

  it('gives every picture a text alternative', () => {
    for (const found of README.matchAll(/!\[([^\]]*)\]\(/g)) assert.ok((found[1] ?? '').length > 40, found[0]);
  });

  it("captions the lead's morning, the meeting, the skill and the reboot demos with one line under each", () => {
    const lines = README.split('\n');
    for (const name of ['lead-morning', 'lead-meeting', 'skill', 'reboot']) {
      const at = lines.findIndex((line) => line.startsWith('![') && line.endsWith(`(docs/images/${name}.svg)`));
      const caption = lines.slice(at + 1).find((text) => text.trim() !== '') ?? '';
      assert.match(caption, /^\*[^*]{20,120}\*$/, `${name} has a one-line caption under it`);
    }
  });

  it('puts text before every picture, never a picture straight under its heading', () => {
    const lines = README.split('\n');
    lines.forEach((line, at) => {
      if (!line.startsWith('![')) return;
      const before = lines.slice(0, at).filter((text) => text.trim() !== '').at(-1) ?? '';
      assert.doesNotMatch(before, /^#/, `${line.slice(0, 60)}... sits straight under "${before}"`);
    });
  });

  it('links the details: how it works, updating, every command, every config key, every check flag, contributing and the guide for language models', () => {
    const links = targets('link');
    for (const path of [
      'docs/how-it-works.md',
      'docs/how-it-works.md#updating-the-plugin',
      'docs/commands.md',
      'docs/configuration.md',
      'plugins/teamrig/skills/teamrig-guide/tasks.md#check-flags',
      'CONTRIBUTING.md',
      'llms.txt',
    ]) {
      assert.ok(links.includes(path), path);
    }
  });

  it("installs every plugin this repo ships, by the marketplace catalog's names, and teamrig-pane", () => {
    const install = /```sh\n([\s\S]*?)```/.exec(section('## Get started'))?.[1] ?? '';
    const lines = install.split('\n').filter((line) => line !== '');
    const text = read(MARKETPLACE);
    const catalog: unknown = JSON.parse(text);
    const marketplace = isRecord(catalog) ? stringField(catalog, 'name') : undefined;
    assert.ok(marketplace !== undefined, `${MARKETPLACE} names its marketplace`);
    const shipped = readCatalog(text).plugins;
    assert.ok(shipped.length > 0, `${MARKETPLACE} lists a plugin`);
    for (const plugin of shipped) assert.ok(lines.includes(`claude plugin install ${plugin.name}@${marketplace}`), plugin.name);
    assert.ok(lines.includes('claude plugin marketplace add GeneralA6/teamrig-pane'), 'adds the teamrig-pane marketplace');
    assert.ok(lines.includes('claude plugin install teamrig-pane@teamrig-pane'), 'installs teamrig-pane');
  });

  it('names only the major needs under Get started, Claude Code and Node.js, and says teamrig checks the rest', () => {
    const requirements = section('### Requirements').trim();
    assert.match(requirements, /^Claude Code 2\.1\.139 or later and Node\.js 22\.18 or later\./);
    assert.match(requirements, /teamrig checks for anything else when you set up a team and\nwhen a session starts/);
    assert.match(requirements, /in default mode, allow `Bash\(teamrig:\*\)` \(\[permissions\]\(plugins\/teamrig\/skills\/teamrig-guide\/hooks\.md#permissions\)\)/);
    assert.doesNotMatch(requirements, /^\*Coming: /m);
    assert.match(requirements, /^Windows and Linux: a fresh install, a first team and every hook pass on both; /m, 'names the systems it is proven on (T1175, T1176)');
    assert.ok(requirements.split('\n').length <= 4, `Requirements is ${requirements.split('\n').length} lines; keep it to the major needs`);
  });

  it("tells why it's different in seven blocks, in order", () => {
    assert.deepEqual(
      [...section("## Why it's different").matchAll(/^### (.+)$/gm)].map((found) => found[1]),
      [
        'A project manager built in',
        'Your day back',
        'Never runs out mid-task',
        'Improves itself',
        'Survives a crash, a reboot and a full context',
        'Grows with your project',
        "Safe while you're away",
      ],
    );
  });

  it('marks what is not built yet with a Coming line', () => {
    for (const heading of ['### Never runs out mid-task', '### Survives a crash, a reboot and a full context']) {
      assert.match(section(heading), /^\*Coming: .+/m, heading);
    }
  });

  it('links the task pane, teamrig-pane, and names its command', () => {
    assert.ok(targets('link').includes('https://github.com/GeneralA6/teamrig-pane'));
    assert.match(README, /\[teamrig-pane\]\([^)]+\) and run `\/teamrig-pane`/);
  });

  it('draws no pictographs (emoji)', () => {
    assert.doesNotMatch(README, /\p{Extended_Pictographic}/u);
  });
});
