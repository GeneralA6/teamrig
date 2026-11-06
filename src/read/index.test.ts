import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as read from './index.ts';

const ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));
const SRC = dirname(dirname(ENTRY));

interface ImportClosure {
  /** Every file reached, relative to `root`, with forward slashes. */
  readonly files: readonly string[];
  /** Each import of something that is not a relative file: `node:` modules and packages alike. */
  readonly outside: readonly string[];
}

/**
 * Follows every import from `entry` (static, `import type`, `export ... from`, side-effect and
 * dynamic), the way TypeScript itself finds them, so comments and strings never count.
 */
function importClosure(entry: string, root: string, readText: (file: string) => string): ImportClosure {
  const seen = new Set<string>();
  const outside: string[] = [];
  const queue = [entry];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    for (const { fileName } of ts.preProcessFile(readText(file), true, true).importedFiles) {
      if (fileName.startsWith('./') || fileName.startsWith('../')) {
        queue.push(resolve(dirname(file), fileName));
      } else {
        outside.push(`${relative(root, file).replaceAll('\\', '/')} imports ${fileName}`);
      }
    }
  }
  return { files: [...seen].map((file) => relative(root, file).replaceAll('\\', '/')).sort(), outside };
}

describe('the read entry', () => {
  it('reaches no node: module and no package, so a reader without Node built-ins can run it', () => {
    const closure = importClosure(ENTRY, SRC, (file) => readFileSync(file, 'utf8'));
    assert.deepEqual(closure.outside, []);
    for (const file of ['register/events.ts', 'register/fold.ts', 'register/layout.ts', 'register/marker.ts', 'register/stats.ts', 'register/stats-health.ts', 'inbox/unread.ts', 'config/parse.ts', 'config/tree.ts', 'hiring/record.ts', 'budget/team-week-summary.ts', 'budget/session-week-summary.ts']) {
      assert.ok(closure.files.includes(file), `${file} is part of the read side`);
    }
    assert.ok(!closure.files.some((file) => file.endsWith('.test.ts')), 'no test file is reachable');
  });

  it('catches an outside import wherever it hides, the dynamic and re-exported ones too', () => {
    const root = resolve('/x');
    const files = new Map([
      [resolve(root, 'entry.ts'), "export { a } from './a.ts';\n// import 'node:comment';\n"],
      [resolve(root, 'a.ts'), "export * from 'node:fs';\nimport type { B } from './b.ts';\nexport const a = 'import \"node:string\"';\n"],
      [resolve(root, 'b.ts'), "import './a.ts';\nexport const b = await import('node:path');\nimport {\n  c,\n} from 'some-package';\n"],
    ]);
    const closure = importClosure(resolve(root, 'entry.ts'), root, (file) => files.get(file) ?? '');
    assert.deepEqual(closure.outside, ['a.ts imports node:fs', 'b.ts imports node:path', 'b.ts imports some-package']);
    assert.deepEqual(closure.files, ['a.ts', 'b.ts', 'entry.ts']);
  });

  it('shows no line from a newer teamrig and counts it as teamrig list warns', () => {
    const create = (id: string, version: number): string =>
      JSON.stringify({ v: version, type: 'create', id, at: '2030-01-07T09:00:00.000Z', by: 'lead', task: { title: id, owner: 'alpha', source: 'owner', ref: null, priority: 7, due: null, goals: [], week: null } });
    const snapshot = read.readRegister([create('T1', read.EVENT_VERSION), create('T2', read.EVENT_VERSION + 1), '{torn'].join('\n'));
    assert.deepEqual([...snapshot.state.tasks.keys()], ['T1']);
    assert.deepEqual([snapshot.read.newer, snapshot.read.unreadable, snapshot.state.orphans], [1, 1, 0]);
    assert.equal(read.priorityText(snapshot.state.tasks.get('T1')?.priority ?? 0), 'p7');
  });

  it('finds a session by its id, its name or a former name, from the config and the rename log', () => {
    const config = read.parseConfigText('{"configVersion": 1, "sessions": ["lead", "alpha"], "roles": {"lead": "lead"}}');
    assert.ok(config.status === 'loaded');
    const rename = { v: read.RENAME_VERSION, id: 'alpha', from: 'app-alpha', to: 'scout', at: '2030-01-08T09:00:00.000Z', by: 'alpha' };
    const roster = new read.Roster(config.config, 'app', read.readRenames(`${JSON.stringify(rename)}\n`).renames);
    assert.deepEqual(['alpha', 'scout', 'app-alpha'].map((text) => roster.lookup(text)), [
      { ok: true, id: 'alpha' },
      { ok: true, id: 'alpha' },
      { ok: true, id: 'alpha' },
    ]);
    assert.deepEqual(roster.ids, ['lead', 'alpha']);
  });

  it("finds a session's leader and a leader's group from the config's lead tree", () => {
    const config = read.parseConfigText(
      JSON.stringify({ configVersion: read.CONFIG_VERSION, sessions: ['lead', 'sub', 'alpha', 'beta'], roles: { lead: 'lead' }, leads: { sub: ['alpha'] } }),
    );
    assert.ok(config.status === 'loaded');
    const tree = new read.LeadTree(config.config);
    assert.deepEqual(['alpha', 'beta', 'sub', 'lead'].map((id) => tree.leaderOf(id)), ['sub', 'lead', 'lead', undefined]);
    assert.deepEqual([tree.membersOf('sub'), tree.membersOf('lead'), tree.groupOf('lead')], [['alpha'], ['sub', 'beta'], ['sub', 'alpha', 'beta']]);
  });

  it("finds a team's parent, children, root and lead from each team config's parent link", () => {
    const nodeOf = (team: string, text: string): read.TeamNode => {
      const config = read.parseConfigText(text);
      assert.ok(config.status === 'loaded');
      return read.teamNodeOf(team, config.config, new read.Roster(config.config, team));
    };
    const tree = new read.TeamTree([
      nodeOf('acme', JSON.stringify({ configVersion: read.CONFIG_VERSION, sessions: ['lead', 'alpha'], roles: { lead: 'lead' } })),
      nodeOf('web', JSON.stringify({ configVersion: read.CONFIG_VERSION, team: { id: 'web', parent: 'acme' }, sessions: ['wlead'], roles: { lead: 'wlead' } })),
    ]);
    assert.deepEqual([tree.parentOf('web'), tree.parentOf('acme'), tree.childrenOf('acme'), tree.rootOf('web'), tree.leadOf('web')], [
      'acme',
      undefined,
      ['web'],
      'acme',
      'wlead',
    ]);
    assert.deepEqual(tree.node('acme')?.sessions, ['lead', 'alpha']);
  });

  it("gives a session's model and effort as teamrig launches it: its own entry, the lead's defaults under it", () => {
    const config = read.parseConfigText(
      JSON.stringify({ configVersion: read.CONFIG_VERSION, sessions: ['lead', 'alpha', 'beta'], roles: { lead: 'lead' }, launch: { alpha: { model: 'sonnet' }, lead: { effort: 'high' } } }),
    );
    assert.ok(config.status === 'loaded');
    const launches: read.LaunchConfig[] = ['lead', 'alpha', 'beta'].map((id) => read.launchOf(config.config, id));
    assert.deepEqual(launches, [{ model: 'opus', effort: 'high' }, { model: 'sonnet' }, {}]);
    assert.deepEqual(launches.map(read.describeLaunch), ['model opus at high effort', 'model sonnet at the default effort', 'the default model and effort']);
  });

  it('reads the hire log as the hire and retire commands count it, and skips a line from a newer teamrig', () => {
    const at = '2030-01-08T10:00:00.000Z';
    const hire = (session: string, version = read.HIRE_FORMAT): string =>
      JSON.stringify({ v: version, kind: 'hire', session, scope: 'port the importer', reason: 'release week', reviewBy: '2030-01-15', by: 'lead', at });
    const retire = JSON.stringify({ v: read.HIRE_FORMAT, kind: 'retire', session: 'helper', reason: 'job done', heir: 'alpha', by: 'lead', at });
    const log = read.readHiringLog([hire('helper'), hire('scout'), retire, hire('later', read.HIRE_FORMAT + 1), ''].join('\n'));
    assert.equal(log.skipped, 1);
    assert.deepEqual(read.activeHires(log.records).map((record) => record.session), ['scout']);
    assert.deepEqual(read.retiredSessions(log.records).map((record) => [record.session, record.heir]), [['helper', 'alpha']]);
    const again = read.readHiringLog([hire('helper'), retire, hire('helper'), ''].join('\n'));
    assert.equal(read.rehiredFrom(again.records, 'helper')?.reason, 'job done');
  });

  it('finds the unread inbox lines with the line hash the reader hands in', () => {
    const hash: read.LineHash = (line) => `fake:${line}`;
    const lines = read.inboxLines('- 2030-01-07 09:00 lead: first\r\n- 2030-01-07 10:00 lead: second\r\n');
    const marks = read.readMarks(
      `${JSON.stringify({ v: read.MARK_VERSION, area: 'alpha', line: 1, at: '2030-01-07T09:30:00.000Z', claudeSession: null, lastLineHash: hash(lines[0] ?? '') })}\n`,
    );
    const unread = read.unreadOf('alpha', lines, read.indexMarks(marks.marks).byArea.get('alpha') ?? null, hash);
    assert.deepEqual([unread.resume, unread.lines], ['grew', ['- 2030-01-07 10:00 lead: second']]);
  });

  it('names a priority from the config text, as written by any config version', () => {
    const config = read.parseConfigText(JSON.stringify({ configVersion: 1, sessions: ['alpha'], roles: { lead: 'alpha' }, register: { tiers: [{ id: 7, name: 'someday' }] } }));
    assert.equal(config.status, 'loaded');
    if (config.status === 'loaded') {
      assert.equal(read.priorityName(config.config.register.priorities, 7), 'someday');
    }
  });

  it('names a priority with no config at all, as a config that sets no register does', () => {
    const config = read.parseConfigText(JSON.stringify({ configVersion: read.CONFIG_VERSION, sessions: ['alpha'], roles: { lead: 'alpha' } }));
    assert.equal(config.status, 'loaded');
    if (config.status === 'loaded') {
      assert.deepEqual(config.config.register, read.DEFAULT_REGISTER);
    }
    assert.deepEqual([1, 2, 6].map((id) => read.priorityName(read.DEFAULT_REGISTER.priorities, id)), ['keep the lights on', 'correctness', undefined]);
  });

  it("sorts a reader's own rows in plan order when they carry only an id and a due", () => {
    const rows: read.PlanOrdered[] = [
      { id: 'T10', due: null },
      { id: 'T3', due: '2030-01-09' },
      { id: 'T4', due: '2030-01-08 12:00' },
      { id: 'T9', due: null },
    ];
    assert.deepEqual(rows.sort((a, b) => read.byPlanOrder(a, b, read.TimeZone.UTC)).map((row) => row.id), ['T4', 'T3', 'T9', 'T10']);
    assert.equal(read.dueTime({ due: null }, read.TimeZone.UTC), undefined);
  });

  it("finds the week plan in force from a reader's own rows, a week tag starting at midnight on the team's clock", () => {
    const rows = [{ week: '2030-01-02' }, { week: null }, { week: '2030-01-09' }, {}];
    // 22:30 UTC on 01-08 is already 01-09 in a zone two hours ahead, not yet in UTC.
    const now = new Date(Date.UTC(2030, 0, 8, 22, 30));
    const ahead = read.TimeZone.of('Africa/Cairo');
    assert.ok(ahead !== undefined);
    assert.equal(read.currentWeek(rows, now, ahead), '2030-01-09');
    assert.equal(read.currentWeek(rows, now, read.TimeZone.UTC), '2030-01-02');
    assert.equal(read.currentWeek([{ week: null }], now, read.TimeZone.UTC), null);
  });

  it('checks a session name with the rule teamrig names inbox files by', () => {
    assert.deepEqual(['alpha', 'a-2', 'Alpha', '2a', '../x', ''].map((name) => read.SESSION_NAME.test(name)), [true, true, false, false, false, false]);
  });

  it('words a session as the tab titles do: its team in brackets, then its name without the team prefix', () => {
    assert.deepEqual(['acme-lead', 'team-lead', 'acme-', 'acmes-web'].map((name) => read.sessionDisplay('acme', name)), [
      '[acme] lead',
      '[acme] team-lead',
      '[acme] acme-',
      '[acme] acmes-web',
    ]);
    assert.deepEqual(['acme-lead', 'lead'].map((name) => read.bareName('acme', name)), ['lead', 'lead']);
  });

  it('reads a turn-log line as the hooks write it, and none from a newer teamrig', () => {
    const reply = { at: '2030-01-08T09:00:00.000Z', kind: 'reply', text: 'shipped', claude: 'claude-1', truncated: true, upTo: 'u-7' };
    assert.deepEqual(read.parseEntry({ v: read.TURN_LOG_VERSION, ...reply, later: 'a field it does not know' }), reply);
    assert.equal(read.parseEntry({ v: read.TURN_LOG_VERSION + 1, ...reply }), undefined);
  });
});
