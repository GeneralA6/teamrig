import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { RENAMED } from '../../src/cli/renamed.ts';
import { CONFIG_VERSION } from '../../src/config/types.ts';
import {
  type Caller,
  type CallersScan,
  type Entry,
  type GrepHit,
  type RenamedCallersDeps,
  type RenamedCallersRequest,
  RENAMED_FILE,
  newlyRenamed,
  parseGrep,
  parseRenamedCommands,
  refusalOf,
  scanRenamedCallers,
} from './renamed-callers.ts';

const KIT = join('/kit');
const CLAUDE = join('/claude');
const API = join('/src/api');
const SHIPPED = join('/src/teamrig');
const WEB = join(KIT, 'teams', 'shop', 'repos', 'web');
const OLD = join('/src/old');
const BASE = 'refs/remotes/origin/main';
const TIP = 'abc1234def';
const REQUEST: RenamedCallersRequest = { base: BASE, tip: TIP, repo: 'owner/Teamrig', kitHome: KIT, claudeDir: CLAUDE };

const renamedText = (entries: readonly (readonly [string, string])[], eol = '\n'): string =>
  ['export const RENAMED: Renamed = {', "  flags: { tier: 'priority' },", '  commands: {', ...entries.map(([old, renamed]) => `    ${old}: '${renamed}',`), '  },', '};', ''].join(eol);

const BASE_TEXT = renamedText([['integrate', 'merge']]);
const TIP_TEXT = renamedText([
  ['integrate', 'merge'],
  ['heavy', 'queue'],
  ['claim', 'freeze'],
]);

interface World {
  files?: Readonly<Record<string, string>>;
  greps?: Readonly<Record<string, readonly GrepHit[] | null>>;
  origins?: Readonly<Record<string, string>>;
  /** `<rev>:<file>` to its text. */
  shows?: Readonly<Record<string, string>>;
}

/** Files, folders and git from plain records: a folder is any prefix of a file's path. */
function fakeWorld(world: World): { deps: RenamedCallersDeps; logs: string[]; listed: string[]; grepped: { checkout: string; pattern: string }[] } {
  const files = new Map(Object.entries(world.files ?? {}).map(([path, text]) => [join(path), text]));
  const logs: string[] = [];
  const listed: string[] = [];
  const grepped: { checkout: string; pattern: string }[] = [];
  const list = (dir: string): Entry[] => {
    listed.push(dir);
    const prefix = join(dir) + sep;
    const entries = new Map<string, boolean>();
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const [name, ...rest] = path.slice(prefix.length).split(sep);
      if (name !== undefined) entries.set(name, (entries.get(name) ?? false) || rest.length > 0);
    }
    return [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([name, folder]) => ({ name, folder }));
  };
  return {
    deps: {
      readText: path => files.get(join(path)) ?? null,
      list,
      gitGrep: (checkout, pattern) => {
        grepped.push({ checkout, pattern });
        const hits = world.greps?.[checkout];
        return hits === undefined ? [] : hits === null ? null : [...hits];
      },
      originOf: checkout => world.origins?.[checkout] ?? null,
      gitShow: (rev, file) => world.shows?.[`${rev}:${file}`] ?? null,
      log: line => logs.push(line),
    },
    logs,
    listed,
    grepped,
  };
}

const shows = (base: string | null, tip: string | null): Record<string, string> => ({
  ...(base === null ? {} : { [`${BASE}:${RENAMED_FILE}`]: base }),
  ...(tip === null ? {} : { [`${TIP}:${RENAMED_FILE}`]: tip }),
});

test('the real renamed.ts parses to exactly the renamed commands the CLI refuses', () => {
  const text = readFileSync(new URL(`../../${RENAMED_FILE}`, import.meta.url), 'utf8');
  const read = parseRenamedCommands(text);
  const expected = new Map(Object.entries(RENAMED.commands ?? {}).flatMap(([old, renamed]) => (renamed === undefined ? [] : [[old, renamed] as const])));
  assert.deepEqual(read, { ok: true, commands: expected });
});

test('parses CRLF text and quoted names; refuses a line that is not old to new, a missing or an unclosed block', () => {
  const quoted = renamedText([["'deploy-x'", 'deploy-status']], '\r\n');
  assert.deepEqual(parseRenamedCommands(quoted), { ok: true, commands: new Map([['deploy-x', 'deploy-status']]) });
  assert.deepEqual(parseRenamedCommands(renamedText([['heavy', 'Queue']])), {
    ok: false,
    reason: `line 4 of ${RENAMED_FILE} is not "old: 'new',": heavy: 'Queue',`,
  });
  assert.deepEqual(parseRenamedCommands('export const RENAMED = { commands: { heavy: "queue" } };'), { ok: false, reason: `${RENAMED_FILE} has no "commands: {" line` });
  assert.deepEqual(parseRenamedCommands("  commands: {\n    heavy: 'queue',\n"), { ok: false, reason: `${RENAMED_FILE} never closes its "commands: {" block` });
});

test('a command is newly renamed when main lacks it or maps it to another name', () => {
  const base = new Map([
    ['a', 'b'],
    ['c', 'd'],
  ]);
  const tip = new Map([
    ['a', 'b'],
    ['c', 'e'],
    ['f', 'g'],
  ]);
  assert.deepEqual(newlyRenamed(base, tip), new Map([
    ['c', 'e'],
    ['f', 'g'],
  ]));
  assert.deepEqual(newlyRenamed(tip, tip), new Map());
});

test('nothing to scan: a tip without renamed.ts says nothing, a main without it is logged, no new rename reads no folder', () => {
  const noTip = fakeWorld({ shows: shows(BASE_TEXT, null) });
  assert.deepEqual(scanRenamedCallers(REQUEST, noTip.deps), { kind: 'none' });
  assert.deepEqual([noTip.logs, noTip.listed], [[], []]);

  const noBase = fakeWorld({ shows: shows(null, TIP_TEXT) });
  assert.deepEqual(scanRenamedCallers(REQUEST, noBase.deps), { kind: 'none' });
  assert.deepEqual(noBase.logs, [`renamed callers: ${BASE} has no ${RENAMED_FILE}, so no command counts as newly renamed`]);
  assert.deepEqual(noBase.listed, []);

  const same = fakeWorld({ shows: shows(TIP_TEXT, TIP_TEXT) });
  assert.deepEqual(scanRenamedCallers(REQUEST, same.deps), { kind: 'none' });
  assert.deepEqual([same.logs, same.listed], [[], []]);
});

test('a renamed.ts that does not parse, at the tip or on main, is unreadable', () => {
  const broken = 'export const RENAMED = {};';
  assert.deepEqual(scanRenamedCallers(REQUEST, fakeWorld({ shows: shows(BASE_TEXT, broken) }).deps), {
    kind: 'unreadable',
    reason: `${RENAMED_FILE} has no "commands: {" line at abc1234`,
  });
  assert.deepEqual(scanRenamedCallers(REQUEST, fakeWorld({ shows: shows(broken, TIP_TEXT) }).deps), {
    kind: 'unreadable',
    reason: `${RENAMED_FILE} has no "commands: {" line at ${BASE}`,
  });
});

const shopConfig = JSON.stringify({
  configVersion: CONFIG_VERSION,
  delivery: { repos: { api: { mainCheckout: API }, teamrig: { mainCheckout: SHIPPED }, web: { mainCheckout: 'repos/web' } } },
});
/** A config still at v7, read through the in-memory migration like every teamrig command reads it. */
const v7Config = JSON.stringify({ configVersion: 7, coordinator: { repos: { old: { mainCheckout: OLD } } } });

const CONSUMERS: World = {
  shows: shows(BASE_TEXT, TIP_TEXT),
  files: {
    [join(KIT, 'teams', 'shop', 'config.json')]: shopConfig,
    [join(KIT, 'teams', 'broken', 'config.json')]: '{ not json',
    [join(KIT, 'teams', 'v7', 'config.json')]: v7Config,
    [join(API, '.git', 'hooks', 'pre-push')]: '#!/bin/sh\nteamrig claim api\n',
    [join(API, '.git', 'hooks', 'pre-commit.sample')]: 'teamrig heavy\n',
    [join(CLAUDE, 'skills', 'ship', 'SKILL.md')]: '# Ship\nRun `teamrig heavy -- npm test`.\n',
    [join(CLAUDE, 'skills', 'ship', 'words.md')]: 'teamrig heavyweight, myteamrig heavy, teamrig heavy-x, teamrig claims\n',
    [join(CLAUDE, 'skills', 'ship', 'logo.png')]: 'teamrig heavy',
    [join(CLAUDE, 'skills', 'ship', 'node_modules', 'pkg', 'README.md')]: 'teamrig heavy',
    [join(CLAUDE, 'skills', '.trash', 'old.md')]: 'teamrig heavy',
    [join(CLAUDE, 'projects', 'p1', 'memory', 'note.md')]: 'teamrig claim before a deploy',
    [join(CLAUDE, 'projects', 'p1', 'memory', 'note.txt')]: 'teamrig claim',
  },
  greps: {
    [API]: [
      { path: '.husky/run-checks.sh', line: 4, text: 'teamrig heavy --what checks -- npm test' },
      { path: 'docs/moved.md', line: 2, text: 'teamrig queue (teamrig heavy before 0.243.0)' },
      { path: 'docs/moved.md', line: 9, text: 'then teamrig heavy again' },
    ],
    [SHIPPED]: [{ path: 'docs/history.md', line: 1, text: 'teamrig heavy' }],
    [WEB]: null,
    [OLD]: [{ path: 'hooks/check.sh', line: 1, text: 'teamrig heavy' }],
  },
  origins: { [API]: 'git@github.com:Owner/api.git', [SHIPPED]: 'https://github.com/Owner/teamrig.git', [OLD]: 'not a github remote' },
};

test('finds every consumer still calling only an old name: checkouts, their hooks, skills and memory', () => {
  const { deps, logs, grepped } = fakeWorld(CONSUMERS);
  const scan = scanRenamedCallers(REQUEST, deps);
  const callers: Caller[] = [
    { path: join(API, '.husky/run-checks.sh'), line: 4, old: 'heavy', renamed: 'queue' },
    { path: join(API, '.git', 'hooks', 'pre-push'), line: 2, old: 'claim', renamed: 'freeze' },
    { path: join(OLD, 'hooks/check.sh'), line: 1, old: 'heavy', renamed: 'queue' },
    { path: join(CLAUDE, 'skills', 'ship', 'SKILL.md'), line: 2, old: 'heavy', renamed: 'queue' },
    { path: join(CLAUDE, 'projects', 'p1', 'memory', 'note.md'), line: 1, old: 'claim', renamed: 'freeze' },
  ];
  const expected: CallersScan = {
    kind: 'callers',
    renames: new Map([
      ['heavy', 'queue'],
      ['claim', 'freeze'],
    ]),
    callers,
  };
  assert.deepEqual(scan, expected);
  assert.deepEqual(
    grepped.map(call => call.checkout),
    [API, WEB, OLD],
    'the shipped repo, matched by its origin slug in any case, is not scanned',
  );
  assert.ok(grepped.every(call => call.pattern === 'teamrig (heavy|claim|queue|freeze)'));
  assert.equal(logs[0], 'renamed callers: this change renames heavy to queue, claim to freeze; reading consumer checkouts, skills and memory');
  assert.match(logs[1] ?? '', /^renamed callers: broken's config does not parse \(.+\): its repos are not scanned$/);
  assert.deepEqual(logs.slice(2), [`renamed callers: git grep failed in ${WEB}: its files are not scanned`]);
});

test('the refusal names the renames called, counts files and lists the first callers', () => {
  const caller = (path: string, line: number): Caller => ({ path, line, old: 'heavy', renamed: 'queue' });
  const renames = new Map([
    ['heavy', 'queue'],
    ['claim', 'freeze'],
  ]);
  assert.equal(refusalOf({ kind: 'none' }), null);
  assert.equal(
    refusalOf({ kind: 'unreadable', reason: 'why' }),
    `the renamed-callers gate cannot read the renamed commands: why; keep "commands: {" with one "old: 'new'," per line`,
  );
  assert.equal(
    refusalOf({ kind: 'callers', renames, callers: [caller('a.sh', 1), caller('a.sh', 7), caller('b.md', 2)] }, 2),
    [
      'this change renames teamrig heavy to queue while 2 consumer file(s) still call only the old name: move them (or name both) and merge again',
      '  a.sh:1 teamrig heavy -> queue',
      '  a.sh:7 teamrig heavy -> queue',
      '  ... and 1 more',
    ].join('\n'),
  );
});

test('reads git grep -n -z output: path, line and the line text, which may hold a NUL', () => {
  assert.deepEqual(parseGrep('a.sh\u00004\u0000teamrig heavy\nsub/b.md\u000010\u0000x\u0000y\n'), [
    { path: 'a.sh', line: 4, text: 'teamrig heavy' },
    { path: 'sub/b.md', line: 10, text: 'x\u0000y' },
  ]);
  assert.deepEqual(parseGrep(''), []);
});
