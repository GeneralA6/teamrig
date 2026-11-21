import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../../config/load.ts';
import { isRecord, recordField, type JsonRecord } from '../../core/guards.ts';
import { toJsonlLine } from '../../core/jsonl.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { HiringLog } from '../../hiring/log.ts';
import { inboxLineOf } from '../../inbox/inbox.ts';
import { lineHash } from '../../inbox/line-hash.ts';
import { EVENT_VERSION } from '../../register/events.ts';
import { layoutPaths } from '../../register/layout.ts';
import { GITHUB_ACTOR } from '../../register/policy.ts';
import { formatSessionRecord } from '../../sessions/record.ts';
import { formatTabNeed } from '../../tabs/need.ts';
import { CliHarness, CONFIG_PATH, EVENTS_PATH, TEAM, TEAM_HOME, type CliResult } from '../../testing/cli-harness.ts';
import { rotateRegister } from '../../testing/rotation.ts';
import { normalisePath } from '../../testing/memory-files.ts';
import { answersOf, problemsOf, rowsOf, served } from '../../testing/read-answers.ts';
import { teamConfigOf, teamHomeOf, teamInboxOf, treeHarness } from '../../testing/team-tree.ts';
import { WatchedFiles } from '../../testing/watched-files.ts';
import { EXIT } from '../runtime.ts';

const READ_TASKS = ['read', 'tasks', '--json'] as const;
const READ_INBOX = ['read', 'inbox', '--json', '--session', 'alpha'] as const;
const READ_SESSIONS = ['read', 'sessions', '--json'] as const;
/** A host's conversation id, as a start record holds one. */
const CONVERSATION = '0123abcd-0000-4000-8000-0000000000c1';
const ALPHA_INBOX = teamInboxOf('app', 'alpha');
const INBOX_MARKS = join(TEAM_HOME, 'state', 'inbox-marks.jsonl');
const HOUR_MS = 3_600_000;
const REVISION = /^[0-9a-f]{16}$/;
/** A revision of the shape `read` serves, which no document of these specs has. */
const HELD = '0123456789abcdef';
/**
 * Every document in one run, the inbox being alpha's and the history that of the first task a team adds: the five of
 * interface 1.0 and those a minor added, so the specs that hold the store unwritten cover each new one.
 */
const ALL_DOCUMENTS = ['tasks', 'inbox', 'sessions', 'meetings', 'config', 'plan', 'goals', 'history'] as const;
const READ_ALL = ['read', ...ALL_DOCUMENTS, '--task', 'T1', '--json', '--session', 'alpha'] as const;
const ALL_UNCHANGED = ALL_DOCUMENTS.map(() => true);
/** A text one of teamrig's own secret shapes matches, built from parts so this file holds none. */
const SECRET = ['pass', 'word', '=', 'hunter2'].join('');

function tasksOf(answer: JsonRecord): JsonRecord[] {
  return rowsOf(answer, 'tasks');
}

function titlesOf(answer: JsonRecord): unknown[] {
  return tasksOf(answer).map((task) => recordField(task, 'title')?.['text']);
}

async function add(kit: CliHarness, title: string, owner: string, env: Readonly<Record<string, string>> = {}): Promise<void> {
  const added = await kit.run(['add', '--session', 'lead', '--title', title, '--description', 'what and why', '--priority', 'p2', '--owner', owner], { env });
  assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
}

/** Rewrites each task the register holds as one an import from outside wrote, with the title given. */
async function importedFrom(kit: CliHarness, source: string, title: string): Promise<void> {
  const lines = (kit.files.get(EVENTS_PATH) ?? '').split('\n').filter((line) => line !== '');
  const rewritten = lines.map((line) => {
    const event: unknown = JSON.parse(line);
    const task = isRecord(event) ? recordField(event, 'task') : undefined;
    return isRecord(event) && task !== undefined ? toJsonlLine({ ...event, task: { ...task, source, title } }) : `${line}\n`;
  });
  await kit.files.write(EVENTS_PATH, rewritten.join(''));
}

/** Posts one inbox line as the CLI does, and gives the line the inbox file then holds. */
async function post(kit: CliHarness, from: string, to: string, text: string): Promise<string> {
  const posted = await kit.run(['inbox', 'add', '--session', from, '--to', to, '--text', text]);
  assert.equal(posted.code, EXIT.ok, posted.stderr.join('\n'));
  return inboxLineOf(new Date(kit.clock.now()), from, text);
}

/** Alpha reads its inbox, which marks every line it holds as read. */
async function markRead(kit: CliHarness): Promise<void> {
  const read = await kit.run(['inbox', 'read', '--session', 'alpha']);
  assert.equal(read.code, EXIT.ok, read.stderr.join('\n'));
}

function linesOf(answer: JsonRecord): JsonRecord[] {
  return rowsOf(answer, 'lines');
}

/** Each served line as its words and whether it is unread. */
function wordsOf(answer: JsonRecord): unknown[][] {
  return linesOf(answer).map((line) => [recordField(line, 'text')?.['text'], line['unread']]);
}

function sessionsOf(answer: JsonRecord): JsonRecord[] {
  return rowsOf(answer, 'sessions');
}

function sessionOf(answer: JsonRecord, team: string, id: string): JsonRecord {
  const found = sessionsOf(answer).find((row) => row['team'] === team && row['id'] === id);
  if (found === undefined) {
    throw new Error(`the answer serves no session ${team}/${id}`);
  }
  return found;
}

function tabOf(team: string, id: string): string {
  return join(teamHomeOf(team), 'state', 'tabs', `${id}.json`);
}

/** Where a session's last start is recorded, with the host's conversation it started in. */
function startRecordOf(team: string, id: string): string {
  return join(teamHomeOf(team), 'state', 'sessions', `${id}.json`);
}

/** Every file with its bytes and its stamp, so a rewrite with the same bytes shows too. */
async function storeOf(kit: CliHarness): Promise<(string | undefined)[][]> {
  const rows: (string | undefined)[][] = [];
  for (const path of kit.files.paths()) {
    rows.push([path, kit.files.get(path), await kit.files.stamp(path)]);
  }
  return rows;
}

describe('teamrig read tasks', () => {
  it('answers one JSON line with the envelope and the working set', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    const answer = served(await kit.run(READ_TASKS));
    assert.deepEqual([answer['interface'], answer['document'], answer['problems'], answer['cuts']], ['1.3', 'tasks', [], []]);
    assert.match(String(answer['revision']), REVISION);
    const [task] = tasksOf(answer);
    assert.deepEqual([task?.['id'], task?.['title'], task?.['owner']], ['T1', { text: 'Ship the gate', source: 'team' }, 'alpha']);
    assert.deepEqual(task?.['source'], { kind: 'session', id: 'lead', name: 'app-lead' });
  });

  it('serves an empty register as no task', async () => {
    assert.deepEqual(tasksOf(served(await new CliHarness().run(READ_TASKS))), []);
  });

  it('marks text from outside the team and escapes what a terminal would act on', async () => {
    const kit = new CliHarness();
    await add(kit, 'Placeholder', 'alpha');
    await importedFrom(kit, 'github', 'Fix \u001b[31mred‮ gate');
    const [task] = tasksOf(served(await kit.run(READ_TASKS)));
    assert.deepEqual(task?.['title'], { text: 'Fix \\x1b[31mred\\u202e gate', source: 'outside' });
    assert.deepEqual(task?.['source'], { kind: 'connector', id: 'github', name: 'GitHub' });
  });

  it('cuts a text matching a secret shape and lists the cut, never serving the text', async () => {
    const kit = new CliHarness();
    await add(kit, 'Tidy the zebra gate', 'alpha');
    await kit.files.write(CONFIG_PATH, formatConfig({ ...TEAM, register: { secretPatterns: ['zebra'] } }));
    const shape = new SecretScanner(['zebra']).find('zebra')?.description;
    const result = await kit.run(READ_TASKS);
    const answer = served(result);
    assert.deepEqual(tasksOf(answer)[0]?.['title'], { text: `[cut: ${shape}]`, source: 'team' });
    assert.deepEqual(answer['cuts'], [{ id: 'T1', field: 'title', shape }]);
    assert.equal(result.stdout.join('\n').includes('zebra'), false);
  });

  it('keeps one session\'s tasks with --owner, by id or by name, as one revision', async () => {
    const kit = new CliHarness();
    await add(kit, 'For alpha', 'alpha');
    await add(kit, 'For bravo', 'bravo');
    const all = served(await kit.run(READ_TASKS));
    const byId = served(await kit.run([...READ_TASKS, '--owner', 'alpha']));
    const byName = served(await kit.run([...READ_TASKS, '--owner', 'app-alpha']));
    assert.deepEqual([titlesOf(all), titlesOf(byId), titlesOf(byName)], [['For alpha', 'For bravo'], ['For alpha'], ['For alpha']]);
    assert.equal(byName['revision'], byId['revision']);
    assert.notEqual(byId['revision'], all['revision']);
  });

  it('serves no task for an owner that holds none, a session the team no longer has too', async () => {
    const kit = new CliHarness();
    await add(kit, 'For alpha', 'alpha');
    assert.deepEqual(tasksOf(served(await kit.run([...READ_TASKS, '--owner', 'gone']))), []);
  });

  it('holds its revision until a file it reads changes', async () => {
    const kit = new CliHarness();
    await add(kit, 'First', 'alpha');
    const first = served(await kit.run(READ_TASKS))['revision'];
    assert.equal(served(await kit.run(READ_TASKS))['revision'], first);
    await add(kit, 'Second', 'alpha');
    assert.notEqual(served(await kit.run(READ_TASKS))['revision'], first);
  });

  it('writes no file', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    const before = await storeOf(kit);
    served(await kit.run(READ_TASKS));
    assert.deepEqual(await storeOf(kit), before);
  });
});

describe('teamrig read inbox', () => {
  it('serves a session that never read its inbox every line as unread, with no count', async () => {
    const kit = new CliHarness();
    const line = await post(kit, 'lead', 'alpha', 'Ship the gate');
    const answer = served(await kit.run(READ_INBOX));
    assert.deepEqual([answer['interface'], answer['document'], answer['problems'], answer['cuts']], ['1.3', 'inbox', [], []]);
    assert.match(String(answer['revision']), REVISION);
    assert.deepEqual([answer['session'], answer['unread']], [{ id: 'alpha', name: 'app-alpha' }, null]);
    assert.deepEqual(linesOf(answer), [
      { key: lineHash(line), at: '2030-01-08T10:00:00.000Z', from: 'lead', text: { text: 'Ship the gate', source: 'team' }, unread: true },
    ]);
  });

  it('counts the lines posted since the session last read, and still serves the read ones', async () => {
    const kit = new CliHarness();
    await post(kit, 'lead', 'alpha', 'First');
    await markRead(kit);
    const read = served(await kit.run(READ_INBOX));
    await post(kit, 'bravo', 'alpha', 'Second');
    const next = served(await kit.run(READ_INBOX));
    assert.deepEqual([read['unread'], wordsOf(read)], [0, [['First', false]]]);
    assert.deepEqual([next['unread'], wordsOf(next)], [1, [['First', false], ['Second', true]]]);
  });

  it('leaves out a read line posted before the last --since hours, its revision not moving with the clock', async () => {
    const kit = new CliHarness();
    await post(kit, 'lead', 'alpha', 'First');
    await markRead(kit);
    await post(kit, 'lead', 'alpha', 'Second');
    const fresh = served(await kit.run(READ_INBOX));
    kit.clock.advance(25 * HOUR_MS);
    const later = served(await kit.run(READ_INBOX));
    const wider = served(await kit.run([...READ_INBOX, '--since', '48']));
    const none = served(await kit.run([...READ_INBOX, '--since', '0']));
    assert.deepEqual(
      [wordsOf(fresh), wordsOf(later), wordsOf(wider), wordsOf(none)],
      [[['First', false], ['Second', true]], [['Second', true]], [['First', false], ['Second', true]], [['Second', true]]],
    );
    assert.equal(later['revision'], fresh['revision']);
    assert.equal(new Set([later['revision'], wider['revision'], none['revision']]).size, 3);
  });

  it('answers the same for the session by id, by name and by the session variable, and another for another session', async () => {
    const kit = new CliHarness();
    await post(kit, 'lead', 'alpha', 'First');
    const byId = served(await kit.run(READ_INBOX));
    const byName = served(await kit.run(['read', 'inbox', '--json', '--session', 'app-alpha']));
    const byVariable = served(await kit.run(['read', 'inbox', '--json'], { env: { TEAMRIG_SESSION: 'alpha' } }));
    const other = served(await kit.run(['read', 'inbox', '--json', '--session', 'bravo']));
    assert.deepEqual([byName, byVariable], [byId, byId]);
    assert.deepEqual([other['session'], other['lines']], [{ id: 'bravo', name: 'app-bravo' }, []]);
    assert.notEqual(other['revision'], byId['revision']);
  });

  it('marks a line a connector posted as text from outside and escapes what a terminal would act on', async () => {
    const kit = new CliHarness();
    await kit.files.append(ALPHA_INBOX, `${inboxLineOf(new Date(kit.clock.now()), GITHUB_ACTOR, 'Fix \u001b[31mred gate')}\n`);
    const [line] = linesOf(served(await kit.run(READ_INBOX)));
    assert.deepEqual([line?.['from'], line?.['text']], ['github', { text: 'Fix \\x1b[31mred gate', source: 'outside' }]);
  });

  it('cuts a line matching a secret shape and lists the cut under the line\'s key, never serving the words', async () => {
    const kit = new CliHarness();
    const line = await post(kit, 'lead', 'alpha', 'Tidy the zebra gate');
    await kit.files.write(CONFIG_PATH, formatConfig({ ...TEAM, register: { secretPatterns: ['zebra'] } }));
    const shape = new SecretScanner(['zebra']).find('zebra')?.description;
    const result = await kit.run(READ_INBOX);
    const answer = served(result);
    assert.deepEqual(linesOf(answer)[0]?.['text'], { text: `[cut: ${shape}]`, source: 'team' });
    // A cut line is keyed by its place in the file: its fingerprint would let a reader confirm a guess of its words.
    assert.deepEqual([linesOf(answer)[0]?.['key'], answer['cuts']], ['cut-1', [{ id: 'cut-1', field: 'text', shape }]]);
    assert.equal(result.stdout.join('\n').includes('zebra'), false);
    assert.equal(result.stdout.join('\n').includes(lineHash(line)), false);
  });

  it('serves the lines and counts a damaged read mark in problems', async () => {
    const kit = new CliHarness();
    await post(kit, 'lead', 'alpha', 'First');
    await markRead(kit);
    await kit.files.append(INBOX_MARKS, '{not json\n');
    const answer = served(await kit.run(READ_INBOX));
    assert.deepEqual([answer['unread'], wordsOf(answer)], [0, [['First', false]]]);
    assert.deepEqual(problemsOf(answer), ['app/state/inbox-marks.jsonl: 1 unreadable line(s) left out']);
  });

  it('holds its revision until a line is posted to the session or it reads its inbox', async () => {
    const kit = new CliHarness();
    await post(kit, 'lead', 'alpha', 'First');
    const first = served(await kit.run(READ_INBOX))['revision'];
    await post(kit, 'lead', 'bravo', 'For bravo');
    assert.equal(served(await kit.run(READ_INBOX))['revision'], first);
    await markRead(kit);
    const read = served(await kit.run(READ_INBOX))['revision'];
    await post(kit, 'lead', 'alpha', 'Second');
    const posted = served(await kit.run(READ_INBOX))['revision'];
    assert.equal(new Set([first, read, posted]).size, 3);
  });

  it('refuses a session the team does not have, naming no inbox file for it', async () => {
    const kit = new CliHarness();
    const files = new WatchedFiles(kit.files);
    const result = await kit.run(['read', 'inbox', '--json', '--session', 'gone'], { files });
    assert.deepEqual(result, {
      code: EXIT.refused,
      stdout: [],
      stderr: ['REFUSED gone is not a session on this team (sessions: lead (app-lead), alpha (app-alpha), bravo (app-bravo))'],
    });
    assert.deepEqual(files.touched().filter((path) => path.includes('gone')), []);
  });

  it('writes no file, so no line is marked read', async () => {
    const kit = new CliHarness();
    await post(kit, 'lead', 'alpha', 'First');
    const before = await storeOf(kit);
    assert.equal(served(await kit.run(READ_INBOX))['unread'], null);
    assert.deepEqual(await storeOf(kit), before);
  });
});

const AS_UI = { env: { TEAMRIG_TEAM: 'ui' } };

describe('teamrig read sessions', () => {
  const NO_TAB = { unread: null, state: null, ask: null, since: null, host: { id: 'claude-code', name: 'Claude Code' }, conversation: null };

  it('serves every team of the tree, the root first, and each team\'s sessions in its config\'s order', async () => {
    const kit = await treeHarness();
    const answer = served(await kit.run(READ_SESSIONS, AS_UI));
    assert.deepEqual(
      [answer['self'], answer['teams'], answer['failures'], answer['cuts'], problemsOf(answer)],
      [
        null,
        [
          { id: 'app', parent: null, active: 3, retired: 0 },
          { id: 'ops', parent: 'app', active: 2, retired: 0 },
          { id: 'web', parent: 'app', active: 3, retired: 0 },
          { id: 'ui', parent: 'web', active: 2, retired: 0 },
        ],
        [],
        [],
        [],
      ],
    );
    assert.deepEqual(
      sessionsOf(answer).map((row) => `${String(row['team'])}/${String(row['id'])}`),
      ['app/lead', 'app/alpha', 'app/bravo', 'ops/lead', 'ops/run', 'web/lead', 'web/front', 'web/back', 'ui/lead', 'ui/pixel'],
    );
    assert.match(String(answer['revision']), REVISION);
  });

  it('serves a session\'s name, its place under its leader and what it starts on', async () => {
    const kit = await treeHarness({ leads: { alpha: ['bravo'] }, launch: { bravo: { model: 'sonnet', effort: 'high' } } });
    const answer = served(await kit.run(READ_SESSIONS));
    const member = { formerNames: [], active: true, hire: null, rehiredFrom: null, retire: null, ...NO_TAB };
    assert.deepEqual(sessionOf(answer, 'app', 'bravo'), {
      team: 'app',
      id: 'bravo',
      name: 'app-bravo',
      roles: [],
      leader: 'alpha',
      ledBy: ['alpha', 'lead'],
      leads: 0,
      launch: { model: 'sonnet', effort: 'high', text: 'model sonnet at high effort' },
      ...member,
    });
    const lead = sessionOf(answer, 'app', 'lead');
    assert.deepEqual([lead['roles'], lead['leader'], lead['ledBy'], lead['leads']], [['lead'], null, [], 1]);
    assert.deepEqual(sessionOf(answer, 'app', 'alpha')['launch'], { model: null, effort: null, text: 'the default model and effort' });
  });

  it('serves no leader, never an empty id, for the sessions of a team whose config names no lead', async () => {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('new'), JSON.stringify({ configVersion: 1, team: { id: 'new', parent: 'app' }, sessions: ['solo', 'duo'], roles: {}, leads: { solo: ['duo'] } }));
    const answer = served(await kit.run(READ_SESSIONS));
    const solo = sessionOf(answer, 'new', 'solo');
    const duo = sessionOf(answer, 'new', 'duo');
    assert.deepEqual([solo['leader'], solo['ledBy'], solo['leads']], [null, [], 1]);
    assert.deepEqual([duo['leader'], duo['ledBy']], ['solo', ['solo']]);
  });

  it('reads a session\'s state from its tab file and serves the ask\'s kind and task, never its words', async () => {
    const kit = await treeHarness();
    const since = new Date(kit.clock.now()).toISOString();
    await kit.files.write(tabOf('ui', 'pixel'), formatTabNeed({ session: 'pixel', state: 'waiting', kind: 'permission', text: 'Run the wipe?', task: 'T12', pid: 7, since }));
    await kit.files.write(tabOf('app', 'alpha'), formatTabNeed({ session: 'alpha', state: 'working', kind: null, text: null, task: null, pid: 7, since }));
    const result = await kit.run(READ_SESSIONS);
    const answer = served(result);
    const stateOf = (team: string, id: string): unknown[] => ['state', 'ask', 'since'].map((field) => sessionOf(answer, team, id)[field]);
    assert.deepEqual(
      [stateOf('ui', 'pixel'), stateOf('app', 'alpha'), stateOf('app', 'bravo')],
      [
        ['asking', { kind: 'permission', task: 'T12' }, since],
        ['busy', null, since],
        [null, null, null],
      ],
    );
    assert.doesNotMatch(result.stdout.join('\n'), /Run the wipe/);
  });

  it('counts a session\'s unread inbox lines, and serves null for one that never read its inbox', async () => {
    const kit = new CliHarness();
    await post(kit, 'lead', 'alpha', 'First');
    await markRead(kit);
    await post(kit, 'lead', 'alpha', 'Second');
    await post(kit, 'lead', 'bravo', 'Third');
    const answer = served(await kit.run(READ_SESSIONS));
    assert.deepEqual([sessionOf(answer, 'app', 'alpha')['unread'], sessionOf(answer, 'app', 'bravo')['unread']], [1, null]);
  });

  it('serves a retired session after its team\'s own, on no team and with its retirement', async () => {
    const kit = await treeHarness();
    const at = kit.clock.now();
    await new HiringLog(kit.files, join(TEAM_HOME, 'state', 'hires.jsonl')).append({ kind: 'retire', session: 'gone', reason: 'The job is done', heir: 'alpha', by: 'lead', at });
    const answer = served(await kit.run(READ_SESSIONS));
    assert.deepEqual(Array.isArray(answer['teams']) ? answer['teams'][0] : undefined, { id: 'app', parent: null, active: 3, retired: 1 });
    assert.deepEqual(
      sessionsOf(answer).map((row) => `${String(row['team'])}/${String(row['id'])}`).slice(0, 5),
      ['app/lead', 'app/alpha', 'app/bravo', 'app/gone', 'ops/lead'],
    );
    const gone = sessionOf(answer, 'app', 'gone');
    assert.deepEqual(
      [gone['name'], gone['active'], gone['host'], gone['retire']],
      ['app-gone', false, null, { at: new Date(at).toISOString(), by: 'lead', reason: 'The job is done', heir: 'alpha' }],
    );
  });

  it('answers self with the session the conversation runs in, the newest start when two sessions hold it', async () => {
    const kit = await treeHarness();
    const startOf = (at: string): string => formatSessionRecord({ claudePid: 7, claudeSession: CONVERSATION, at });
    await kit.files.write(startRecordOf('ui', 'pixel'), startOf('2030-01-08T09:00:00.000Z'));
    const asked = [...READ_SESSIONS, '--conversation', CONVERSATION];
    const one = served(await kit.run(asked, AS_UI));
    assert.deepEqual([one['self'], sessionOf(one, 'ui', 'pixel')['conversation']], [{ team: 'ui', session: 'pixel' }, CONVERSATION]);
    await kit.files.write(startRecordOf('web', 'front'), startOf('2030-01-08T09:30:00.000Z'));
    const two = served(await kit.run(asked, AS_UI));
    // A conversation id is served for the caller's own team only, so the team above answers `self` and keeps its id.
    assert.deepEqual([two['self'], sessionOf(two, 'web', 'front')['conversation']], [{ team: 'web', session: 'front' }, null]);
    const unasked = served(await kit.run(READ_SESSIONS));
    const unknown = served(await kit.run([...READ_SESSIONS, '--conversation', 'no-such-conversation']));
    assert.deepEqual([unasked['self'], unknown['self']], [null, null]);
    assert.equal(new Set([unasked['revision'], unknown['revision'], served(await kit.run(asked))['revision']]).size, 3);
  });

  it('serves the inbox of the conversation\'s session when no session is named, and --session\'s when one is', async () => {
    const kit = await treeHarness();
    await kit.files.write(startRecordOf('app', 'alpha'), formatSessionRecord({ claudePid: 7, claudeSession: CONVERSATION, at: '2030-01-08T09:00:00.000Z' }));
    await post(kit, 'lead', 'alpha', 'For alpha');
    await post(kit, 'lead', 'bravo', 'For bravo');
    const own = served(await kit.run(['read', 'inbox', '--json', '--conversation', CONVERSATION]));
    const named = served(await kit.run(['read', 'inbox', '--json', '--conversation', CONVERSATION, '--session', 'bravo']));
    assert.deepEqual([wordsOf(own), wordsOf(named)], [[['For alpha', true]], [['For bravo', true]]]);
  });

  it('is a usage error for inbox when no session of the caller\'s team holds the conversation', async () => {
    const kit = await treeHarness();
    await kit.files.write(startRecordOf('ui', 'pixel'), formatSessionRecord({ claudePid: 7, claudeSession: CONVERSATION, at: '2030-01-08T09:00:00.000Z' }));
    const result = await kit.run(['read', 'inbox', '--json', '--conversation', CONVERSATION]);
    assert.deepEqual([result.code, result.stdout], [EXIT.usage, []]);
    assert.match(result.stderr.join('\n'), new RegExp(`inbox is one session's: no session of team app holds conversation ${CONVERSATION}; name it with --session`));
  });

  it('serves the same whatever --team names: the tree is the caller\'s own', async () => {
    const kit = await treeHarness();
    assert.deepEqual(served(await kit.run([...READ_SESSIONS, '--team', 'web'], AS_UI)), served(await kit.run(READ_SESSIONS, AS_UI)));
  });

  it('names a team folder whose config cannot be read in failures and problems, and serves the rest', async () => {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('torn'), `{ not json ${SECRET}`);
    await kit.files.write(join(teamHomeOf('bare'), 'state', 'note.md'), 'no config here');
    const result = await kit.run(READ_SESSIONS);
    const answer = served(result);
    assert.deepEqual(answer['failures'], [{ team: 'torn', reason: 'torn/config.json cannot be read as a team config' }]);
    assert.deepEqual(problemsOf(answer), ['torn/config.json cannot be read as a team config']);
    assert.equal(sessionsOf(answer).length, 10);
    assert.equal(result.stdout.join('\n').includes(SECRET), false);
  });

  it('counts a damaged line of a hire log in problems', async () => {
    const kit = new CliHarness();
    const hires = join(TEAM_HOME, 'state', 'hires.jsonl');
    await kit.files.write(hires, '{not json\n');
    assert.deepEqual(problemsOf(served(await kit.run(READ_SESSIONS))), ['app/state/hires.jsonl: 1 damaged or newer line(s) left out']);
  });

  it('keeps its revision while no file it reads changes, and moves it with a tab file, a start record and a new team', async () => {
    const kit = await treeHarness();
    const revision = async (): Promise<unknown> => served(await kit.run(READ_SESSIONS))['revision'];
    const first = await revision();
    assert.equal(await revision(), first);
    const since = new Date(kit.clock.now()).toISOString();
    await kit.files.write(tabOf('ui', 'pixel'), formatTabNeed({ session: 'pixel', state: 'ready', kind: null, text: null, task: null, pid: 7, since }));
    const withTab = await revision();
    await kit.files.write(startRecordOf('ops', 'run'), formatSessionRecord({ claudePid: 7, claudeSession: CONVERSATION, at: since }));
    const withStart = await revision();
    await kit.files.write(teamConfigOf('new'), formatConfig({ configVersion: 1, team: { id: 'new', parent: 'app' }, sessions: ['lead'], roles: { lead: 'lead' } }));
    assert.equal(new Set([first, withTab, withStart, await revision()]).size, 4);
  });

  it('serves a hire\'s words for the caller\'s own team and the teams above it, and null for a team beside or below', async () => {
    const kit = await treeHarness();
    const hired = async (team: string, session: string): Promise<void> => {
      const log = new HiringLog(kit.files, join(teamHomeOf(team), 'state', 'hires.jsonl'));
      await log.append({ kind: 'hire', session, scope: `the ${team} job`, reason: `${team} fell behind`, reviewBy: '2030-01-16', by: 'lead', at: kit.clock.now() });
    };
    await hired('ops', 'run');
    await hired('web', 'front');
    await hired('ui', 'pixel');
    const wordsOfHire = (answer: JsonRecord, team: string, id: string): unknown[] => {
      const hire = sessionOf(answer, team, id)['hire'];
      return isRecord(hire) ? [hire['scope'], hire['reason'], hire['by'], hire['reviewBy']] : [];
    };
    const launchTextOf = (answer: JsonRecord, team: string, id: string): unknown => recordField(sessionOf(answer, team, id), 'launch')?.['text'];
    const fromUi = served(await kit.run(READ_SESSIONS, AS_UI));
    const fromApp = served(await kit.run(READ_SESSIONS));
    assert.deepEqual(
      [wordsOfHire(fromUi, 'ui', 'pixel'), wordsOfHire(fromUi, 'web', 'front'), wordsOfHire(fromUi, 'ops', 'run'), wordsOfHire(fromApp, 'ui', 'pixel')],
      [
        ['the ui job', 'ui fell behind', 'lead', '2030-01-16'],
        ['the web job', 'web fell behind', 'lead', '2030-01-16'],
        [null, null, 'lead', '2030-01-16'],
        [null, null, 'lead', '2030-01-16'],
      ],
    );
    const DEFAULT_LAUNCH = 'the default model and effort';
    assert.deepEqual(
      [launchTextOf(fromUi, 'ui', 'pixel'), launchTextOf(fromUi, 'app', 'alpha'), launchTextOf(fromUi, 'ops', 'run'), launchTextOf(fromApp, 'ui', 'pixel')],
      [DEFAULT_LAUNCH, DEFAULT_LAUNCH, null, null],
    );
    assert.deepEqual([fromUi['cuts'], fromApp['cuts']], [[], []]);
  });

  it('writes no file', async () => {
    const kit = await treeHarness();
    await post(kit, 'lead', 'alpha', 'First');
    const before = await storeOf(kit);
    served(await kit.run([...READ_SESSIONS, '--conversation', CONVERSATION]));
    assert.deepEqual(await storeOf(kit), before);
  });
});

describe('teamrig read --team', () => {

  it('is a usage error for inbox, which is the asking session\'s own team\'s', async () => {
    const kit = await treeHarness();
    const result = await kit.run(['read', 'inbox', '--json', '--session', 'pixel', '--team', 'web'], AS_UI);
    assert.deepEqual([result.code, result.stdout], [EXIT.usage, []]);
    assert.match(result.stderr.join('\n'), /inbox is the asking session's own, in its own team \(ui\): ask for it without --team/);
  });

  it('serves a team above the caller\'s', async () => {
    const kit = await treeHarness();
    await add(kit, 'Of app', 'alpha');
    await add(kit, 'Of web', 'front', { TEAMRIG_TEAM: 'web' });
    await add(kit, 'Of ui', 'pixel', { TEAMRIG_TEAM: 'ui' });
    const own = served(await kit.run(READ_TASKS, AS_UI));
    const parent = served(await kit.run([...READ_TASKS, '--team', 'web'], AS_UI));
    const root = served(await kit.run([...READ_TASKS, '--team', 'app'], AS_UI));
    assert.deepEqual([titlesOf(own), titlesOf(parent), titlesOf(root)], [['Of ui'], ['Of web'], ['Of app']]);
    assert.equal(new Set([own['revision'], parent['revision'], root['revision']]).size, 3);
  });

  it('refuses a team beside the caller\'s and one below it, on stderr', async () => {
    const kit = await treeHarness();
    const beside = await kit.run([...READ_TASKS, '--team', 'ops'], AS_UI);
    const below = await kit.run([...READ_TASKS, '--team', 'ui'], { env: { TEAMRIG_TEAM: 'web' } });
    assert.deepEqual(
      [beside, below],
      [
        { code: EXIT.refused, stdout: [], stderr: ['REFUSED read serves your own team (ui) and the teams above it; --team ops names neither'] },
        { code: EXIT.refused, stdout: [], stderr: ['REFUSED read serves your own team (web) and the teams above it; --team ui names neither'] },
      ],
    );
  });
});

describe('teamrig read: an argument never becomes a path as typed', () => {
  const NO_IDS = ['../x', '..\\x', '/etc/x', 'C:\\x', 'a/b', 'App', '.'] as const;
  const ASKED: readonly (readonly [string, readonly string[], RegExp])[] = [
    ['--team', READ_TASKS, /is not a team id/],
    ['--owner', READ_TASKS, /is not a session id or name/],
    ['--session', ['read', 'inbox', '--json'], /is not a session id or name/],
  ];

  for (const [flag, argv, message] of ASKED) {
    it(`is a usage error for a ${flag} that has no id's shape, before any file is touched`, async () => {
      for (const typed of NO_IDS) {
        const kit = new CliHarness();
        const files = new WatchedFiles(kit.files);
        const result = await kit.run([...argv, flag, typed], { files });
        assert.deepEqual([typed, result.code, result.stdout], [typed, EXIT.usage, []]);
        assert.match(result.stderr.join('\n'), message);
        assert.deepEqual(files.touched(), []);
      }
    });
  }

  it('refuses inbox for a session of another team, touching no inbox file', async () => {
    const kit = await treeHarness();
    const files = new WatchedFiles(kit.files);
    const result = await kit.run(['read', 'inbox', '--json', '--session', 'front'], { ...AS_UI, files });
    assert.deepEqual([result.code, result.stdout], [EXIT.refused, []]);
    assert.match(result.stderr.join('\n'), /^REFUSED front is not a session on this team \(sessions: lead \(ui-lead\), pixel \(ui-pixel\)\)$/);
    assert.deepEqual(files.touched().filter((path) => /inbox/.test(path)), []);
  });

  it('reads of a team beside the caller\'s, when --team names it, only what placing the teams in the tree reads', async () => {
    const kit = await treeHarness();
    const beside = `${normalisePath(teamHomeOf('ops'))}/`;
    const readOfOps = async (team: string): Promise<[number, string[]]> => {
      const files = new WatchedFiles(kit.files);
      const result = await kit.run([...READ_TASKS, '--team', team], { ...AS_UI, files });
      return [result.code, [...new Set(files.touched().filter((path) => path.startsWith(beside)))].sort()];
    };
    const [served, forTheTree] = await readOfOps('web');
    assert.deepEqual([served, forTheTree.includes(normalisePath(teamConfigOf('ops')))], [EXIT.ok, true]);
    assert.deepEqual(await readOfOps('ops'), [EXIT.refused, forTheTree]);
  });
});

describe('teamrig read: what is asked', () => {
  const USAGE_ERRORS: readonly (readonly [string, readonly string[], RegExp])[] = [
    ['no document', ['read', '--json'], /read needs a document: tasks, inbox, sessions, meetings, config/],
    ['an unknown document', ['read', 'weather', '--json'], /unknown document "weather"; the documents are tasks, inbox, sessions, meetings, config, plan, goals/],
    ['a document twice', ['read', 'tasks', 'tasks', '--json'], /document tasks is asked twice/],
    ['a --conversation no host would give', [...READ_SESSIONS, '--conversation', 'a b'], /--conversation takes the host's conversation id/],
    ['inbox with no session named', ['read', 'inbox', '--json'], /inbox is one session's: name it with --session/],
    ['a --since that is no count of hours', [...READ_INBOX, '--since', 'x'], /--since takes whole hours, such as 24; got "x"/],
    ['no --json', ['read', 'tasks'], /read answers only as JSON in interface 1: add --json/],
    ['a malformed --interface', [...READ_TASKS, '--interface', 'x'], /--interface takes <major\.minor>, such as 1\.0; got "x"/],
    ['an --unless entry with no revision', [...READ_TASKS, '--unless', 'tasks'], /--unless takes <document>=<revision>.*; got "tasks"/],
    ['an --unless entry left empty', [...READ_TASKS, '--unless', `tasks=${HELD},`], /--unless takes <document>=<revision>.*; got ""/],
    ['an --unless revision that is a path', [...READ_TASKS, '--unless', 'tasks=../../config'], /--unless takes <document>=<revision>.*; got "tasks=\.\.\/\.\.\/config"/],
    ['an --unless revision one character short', [...READ_TASKS, '--unless', `tasks=${HELD.slice(1)}`], /--unless takes <document>=<revision>/],
    ['an --unless revision in capitals', [...READ_TASKS, '--unless', `tasks=${HELD.toUpperCase()}`], /--unless takes <document>=<revision>/],
    ['an --unless revision with a second "="', [...READ_TASKS, '--unless', `tasks=${HELD}=x`], /--unless takes <document>=<revision>/],
    ['an --unless document read does not have', [...READ_TASKS, '--unless', `weather=${HELD}`], /--unless names an unknown document "weather"; the documents are tasks, inbox/],
    ['an --unless document the run does not ask', [...READ_TASKS, '--unless', `inbox=${HELD}`], /--unless names inbox, which this run does not ask for/],
    ['an --unless document named twice', [...READ_TASKS, '--unless', `tasks=${HELD},tasks=${HELD}`], /--unless names tasks twice/],
  ];

  for (const [what, argv, message] of USAGE_ERRORS) {
    it(`is a usage error, with no document printed, for ${what}`, async () => {
      const result = await new CliHarness().run(argv);
      assert.deepEqual([result.code, result.stdout], [EXIT.usage, []]);
      assert.match(result.stderr.join('\n'), message);
    });
  }

  it('answers a reader of the served version or an older minor with the version it serves', async () => {
    for (const asked of ['1.3', '1.2', '1.1', '1.0']) {
      assert.equal(served(await new CliHarness().run([...READ_TASKS, '--interface', asked]))['interface'], '1.3');
    }
  });

  for (const version of ['2.0', '0.9', '1.4']) {
    it(`refuses --interface ${version} on stderr and prints no document`, async () => {
      const result = await new CliHarness().run([...READ_TASKS, '--interface', version]);
      assert.deepEqual([result.code, result.stdout, result.stderr.length], [EXIT.refused, [], 1]);
      assert.match(result.stderr.join('\n'), /^REFUSED /);
    });
  }
});

/** A run's answers after a clean exit, however many documents it asked. */
function allServed(result: CliResult): JsonRecord[] {
  assert.deepEqual([result.code, result.stderr], [EXIT.ok, []]);
  return answersOf(result);
}

/** What `--unless` takes to say the reader holds every one of these answers. */
function heldOf(answers: readonly JsonRecord[]): string {
  return answers.map((answer) => `${String(answer['document'])}=${String(answer['revision'])}`).join(',');
}

/** Each answer as its document and whether it came as unchanged. */
function unchangedOf(answers: readonly JsonRecord[]): unknown[][] {
  return answers.map((answer) => [answer['document'], answer['unchanged'] === true]);
}

/** The register files a call took the text of: what a fold of the working set reads. */
function foldedOf(files: WatchedFiles): string[] {
  return files.opened().filter((path) => /events|snapshot/.test(path));
}

describe('teamrig read --unless', () => {
  it('answers a document the reader holds as unchanged and nothing more, in the order asked', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    const first = allServed(await kit.run(READ_ALL));
    const [tasks, , , meetings] = first;
    assert.ok(tasks !== undefined && meetings !== undefined);
    const again = allServed(await kit.run([...READ_ALL, '--unless', heldOf([meetings, tasks])]));
    assert.deepEqual(unchangedOf(again), [['tasks', true], ['inbox', false], ['sessions', false], ['meetings', true], ['config', false], ['plan', false], ['goals', false], ['history', false]]);
    assert.deepEqual(again[0], { interface: '1.3', document: 'tasks', revision: tasks['revision'], unchanged: true });
    assert.deepEqual(again.slice(1, 3), first.slice(1, 3));
  });

  it('folds no register file for an unchanged document, and folds it for a revision the document no longer has', async () => {
    const kit = new CliHarness();
    await add(kit, 'First', 'alpha');
    const held = heldOf([served(await kit.run(READ_TASKS))]);
    const unchanged = new WatchedFiles(kit.files);
    assert.equal(served(await kit.run([...READ_TASKS, '--unless', held], { files: unchanged }))['unchanged'], true);
    assert.deepEqual(foldedOf(unchanged), []);
    await add(kit, 'Second', 'alpha');
    const stale = new WatchedFiles(kit.files);
    const answer = served(await kit.run([...READ_TASKS, '--unless', held], { files: stale }));
    assert.deepEqual([titlesOf(answer), 'unchanged' in answer], [['First', 'Second'], false]);
    assert.ok(foldedOf(stale).includes(normalisePath(EVENTS_PATH)));
  });

  it('answers in full again only the documents that read a file that changed', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    const held = heldOf(allServed(await kit.run(READ_ALL)));
    assert.deepEqual(unchangedOf(allServed(await kit.run([...READ_ALL, '--unless', held]))).map(([, unchanged]) => unchanged), ALL_UNCHANGED);
    await post(kit, 'lead', 'alpha', 'the gate is merged');
    assert.deepEqual(
      unchangedOf(allServed(await kit.run([...READ_ALL, '--unless', held]))),
      [['tasks', true], ['inbox', false], ['sessions', false], ['meetings', true], ['config', true], ['plan', true], ['goals', true], ['history', true]],
    );
  });

  it('answers config as unchanged to a run with no team', async () => {
    const kit = new CliHarness(null, null);
    const first = served(await kit.run(['read', 'config', '--json']));
    assert.deepEqual(
      served(await kit.run(['read', 'config', '--json', '--unless', heldOf([first])])),
      { interface: '1.3', document: 'config', revision: first['revision'], unchanged: true },
    );
  });
});

describe('teamrig read: the store is left as it was', () => {
  const STATE = `${normalisePath(join(TEAM_HOME, 'state'))}/`;

  it('writes no byte and calls for no write over every document, served in full or as unchanged', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    await post(kit, 'lead', 'alpha', 'the gate is merged');
    const before = await storeOf(kit);
    const files = new WatchedFiles(kit.files);
    const held = heldOf(allServed(await kit.run(READ_ALL, { files })));
    assert.deepEqual(unchangedOf(allServed(await kit.run([...READ_ALL, '--unless', held], { files }))).map(([, unchanged]) => unchanged), ALL_UNCHANGED);
    assert.deepEqual([files.written(), await storeOf(kit)], [[], before]);
  });

  it('makes no file and no folder in a team that has no state folder yet', async () => {
    const kit = new CliHarness();
    assert.deepEqual(kit.files.paths().filter((path) => path.startsWith(STATE)), []);
    const before = await storeOf(kit);
    const files = new WatchedFiles(kit.files);
    assert.equal(allServed(await kit.run(READ_ALL, { files })).length, ALL_DOCUMENTS.length);
    assert.deepEqual([files.written(), await storeOf(kit)], [[], before]);
    assert.ok(files.touched().some((path) => path.startsWith(STATE)));
  });
});

describe('teamrig read: what could not be read', () => {
  it('refuses on stderr, with no document, in a team with no config', async () => {
    const result = await new CliHarness(null).run(READ_TASKS);
    assert.deepEqual([result.code, result.stdout, result.stderr.length], [EXIT.refused, [], 1]);
    assert.match(result.stderr.join('\n'), /^REFUSED /);
  });

  it('carries a config problem in problems, where a text command warns on stderr', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    await kit.files.write(CONFIG_PATH, formatConfig({ ...TEAM, pushGuard: { protectedBranches: SECRET } }));
    const result = await kit.run(READ_TASKS);
    const answer = served(result);
    assert.deepEqual(problemsOf(answer), ['app/config.json: 1 problem(s), defaults used; run: teamrig config validate']);
    assert.deepEqual(titlesOf(answer), ['Ship the gate']);
    assert.equal(result.stdout.join('\n').includes(SECRET), false);
  });

  it('serves the tasks it can read and counts a damaged line in problems', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    await kit.files.append(EVENTS_PATH, '{not json\n');
    const answer = served(await kit.run(READ_TASKS));
    assert.deepEqual(titlesOf(answer), ['Ship the gate']);
    assert.deepEqual(problemsOf(answer), ['app/state/events.jsonl: 1 unreadable line(s) left out']);
  });

  it('names a damaged register line by its file and a count, never by the parser\'s words, which quote the line', async () => {
    const kit = new CliHarness();
    await kit.files.append(EVENTS_PATH, `{"note": "${SECRET}", torn\n`);
    const result = await kit.run(READ_TASKS);
    assert.deepEqual(problemsOf(served(result)), ['app/state/events.jsonl: 1 unreadable line(s) left out']);
    assert.equal(result.stdout.join('\n').includes(SECRET), false);
  });

  it('leaves out, as a damaged line, an event whose time is not the stamp the register writes, and serves none of its text', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    const started = { v: EVENT_VERSION, id: 'T1', by: 'alpha', type: 'status', status: 'in-progress', note: null };
    const worded = `Jan 8 2030 10:00 UTC (${SECRET})`;
    assert.equal(Number.isNaN(Date.parse(worded)), false, 'the engine reads it as a time');
    await kit.files.append(EVENTS_PATH, toJsonlLine({ ...started, at: worded }));
    const result = await kit.run(READ_TASKS);
    const answer = served(result);
    assert.deepEqual(problemsOf(answer), ['app/state/events.jsonl: 1 unreadable line(s) left out']);
    assert.deepEqual(rowsOf(answer, 'tasks').map((task) => task['status']), ['open'], 'the line set no status');
    assert.equal(result.stdout.join('\n').includes(SECRET), false);
    const at = new Date(kit.clock.now()).toISOString();
    await kit.files.append(EVENTS_PATH, toJsonlLine({ ...started, at }));
    assert.deepEqual(rowsOf(served(await kit.run(READ_TASKS)), 'tasks').map((task) => [task['status'], task['statusAt']]), [['in-progress', at]], 'the same line with the stamp is read');
  });

  it('serves no task and says why when an archive segment is gone, changing its revision when it is back', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    const layout = layoutPaths(EVENTS_PATH);
    await rotateRegister(kit.files, EVENTS_PATH, { now: new Date(kit.clock.now()) });
    const segment = kit.files.get(layout.segment(1)) ?? '';
    await kit.files.remove(layout.snapshot);
    await kit.files.remove(layout.segment(1));
    const broken = served(await kit.run(READ_TASKS));
    assert.deepEqual(tasksOf(broken), []);
    const segment1 = normalisePath(layout.segment(1)).slice(normalisePath(TEAM_HOME).length);
    assert.deepEqual(problemsOf(broken), [`app${segment1}: missing, so the register's archive is incomplete and its tasks cannot be read`]);
    await kit.files.write(layout.segment(1), segment);
    const whole = served(await kit.run(READ_TASKS));
    assert.deepEqual([titlesOf(whole), problemsOf(whole)], [['Ship the gate'], []]);
    assert.notEqual(whole['revision'], broken['revision']);
  });
});
