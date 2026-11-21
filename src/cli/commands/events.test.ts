import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRecord, type JsonRecord } from '../../core/guards.ts';
import { inboxLineOf } from '../../inbox/inbox.ts';
import { DOCUMENTS, INTERFACE_VERSION } from '../../interface/index.ts';
import { GITHUB_ACTOR } from '../../register/policy.ts';
import { CliHarness, CONFIG_PATH, type CliResult } from '../../testing/cli-harness.ts';
import { FakeStarterWatch } from '../../testing/fake-starter-watch.ts';
import { FaultyFiles, systemError } from '../../testing/faulty-files.ts';
import { served } from '../../testing/read-answers.ts';
import { teamInboxOf } from '../../testing/team-tree.ts';
import { WatchedFiles } from '../../testing/watched-files.ts';
import type { Sleep } from '../../core/lock.ts';
import { EXIT } from '../runtime.ts';
import { EVENTS_PASS_MS } from './events.ts';

const EVENTS = ['events', '--json', '--session', 'alpha'] as const;
const ALPHA_INBOX = teamInboxOf('app', 'alpha');
const REVISION = /^[0-9a-f]{16}$/;
/** What a run with no --documents follows: history is one task's, so it is followed only when --task names one. */
const UNNAMED = DOCUMENTS.filter((document) => document !== 'history');

/** What one wait of the follower does to the world, by the wait's number from 0; a wait with no step changes nothing. */
type Step = () => Promise<void> | void;

/** A `sleep` that runs `steps` in turn, one a wait, and ends the run's starter after the last: the follower's whole life in a spec. */
function waits(starters: FakeStarterWatch, steps: readonly Step[]): { readonly sleep: Sleep; readonly asked: number[] } {
  const asked: number[] = [];
  const sleep: Sleep = async (ms) => {
    const step = steps[asked.length];
    asked.push(ms);
    if (step === undefined) {
      starters.end();
      return;
    }
    await step();
  };
  return { sleep, asked };
}

async function post(kit: CliHarness, text: string): Promise<void> {
  await kit.files.append(ALPHA_INBOX, `${inboxLineOf(new Date(kit.clock.now()), GITHUB_ACTOR, text)}\n`);
}

function framesOf(result: CliResult): JsonRecord[] {
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
  assert.deepEqual(result.stderr, []);
  return result.stdout.map((line) => {
    const frame: unknown = JSON.parse(line);
    assert.ok(isRecord(frame), line);
    return frame;
  });
}

function namedIn(frame: JsonRecord | undefined): unknown[] {
  const documents = frame?.['documents'];
  assert.ok(Array.isArray(documents));
  return documents.map((entry: unknown) => (isRecord(entry) ? entry['document'] : entry));
}

function revisionIn(frame: JsonRecord | undefined, document: string): unknown {
  const documents = frame?.['documents'];
  assert.ok(Array.isArray(documents));
  const found = documents.find((entry: unknown) => isRecord(entry) && entry['document'] === document);
  assert.ok(isRecord(found), `no ${document} in the frame`);
  return found['revision'];
}

describe('teamrig events', () => {
  it('says hello with every document but history and the revision read answers, then ends with its starter', async () => {
    const kit = new CliHarness();
    const starters = new FakeStarterWatch();
    const { sleep, asked } = waits(starters, []);
    const frames = framesOf(await kit.run(EVENTS, { starters, sleep }));
    assert.equal(frames.length, 1);
    const [hello] = frames;
    assert.equal(hello?.['interface'], INTERFACE_VERSION);
    assert.equal(hello?.['event'], 'hello');
    assert.deepEqual(namedIn(hello), UNNAMED);
    for (const document of UNNAMED) {
      const read = served(await kit.run(['read', document, '--json', '--session', 'alpha']))['revision'];
      assert.match(String(read), REVISION);
      assert.equal(revisionIn(hello, document), read, document);
    }
    assert.deepEqual(asked, [EVENTS_PASS_MS]);
    assert.equal(starters.openWatches, 0);
  });

  it('names in a changed frame only the documents that moved, with the revision read now answers', async () => {
    const kit = new CliHarness();
    const starters = new FakeStarterWatch();
    const { sleep } = waits(starters, [() => post(kit, 'one')]);
    const frames = framesOf(await kit.run([...EVENTS, '--documents', 'tasks,inbox'], { starters, sleep }));
    assert.deepEqual(frames.map((frame) => frame['event']), ['hello', 'changed']);
    const [hello, changed] = frames;
    assert.deepEqual(namedIn(hello), ['tasks', 'inbox']);
    assert.deepEqual(namedIn(changed), ['inbox']);
    assert.equal(changed?.['interface'], INTERFACE_VERSION);
    assert.notEqual(revisionIn(changed, 'inbox'), revisionIn(hello, 'inbox'));
    assert.equal(revisionIn(changed, 'inbox'), served(await kit.run(['read', 'inbox', '--json', '--session', 'alpha']))['revision']);
  });

  it('sends one frame for every change inside one wait and none for a wait that changed nothing', async () => {
    const kit = new CliHarness();
    const starters = new FakeStarterWatch();
    const twice: Step = async () => {
      await post(kit, 'one');
      await post(kit, 'two');
    };
    const { sleep, asked } = waits(starters, [twice, () => undefined, () => undefined, () => post(kit, 'three')]);
    const frames = framesOf(await kit.run([...EVENTS, '--documents', 'inbox'], { starters, sleep }));
    assert.deepEqual(frames.map((frame) => frame['event']), ['hello', 'changed', 'changed']);
    assert.equal(asked.length, 5);
  });

  it('names a document whose files cannot be stamped with no revision, and again with one once they can', async () => {
    const kit = new CliHarness();
    const starters = new FakeStarterWatch();
    const files = new FaultyFiles(kit.files);
    const refused = systemError('EACCES');
    const { sleep } = waits(starters, [() => void files.fail('stamp', ALPHA_INBOX, refused), () => void files.mend('stamp', ALPHA_INBOX)]);
    const frames = framesOf(await kit.run([...EVENTS, '--documents', 'inbox,config'], { starters, sleep, files }));
    assert.deepEqual(frames.map((frame) => namedIn(frame)), [['inbox', 'config'], ['inbox'], ['inbox']]);
    const [hello, lost, back] = frames;
    assert.equal(revisionIn(lost, 'inbox'), null);
    assert.equal(revisionIn(back, 'inbox'), revisionIn(hello, 'inbox'));
  });

  it('ends once the reader of its stdout is gone, its starter still running', async () => {
    const kit = new CliHarness();
    const starters = new FakeStarterWatch();
    const reader = new AbortController();
    const asked: number[] = [];
    const sleep: Sleep = async (ms) => {
      asked.push(ms);
      await post(kit, 'unread by anyone');
      reader.abort();
    };
    const frames = framesOf(await kit.run([...EVENTS, '--documents', 'inbox'], { starters, sleep, outputClosed: reader.signal }));
    assert.deepEqual(frames.map((frame) => frame['event']), ['hello']);
    assert.deepEqual(asked, [EVENTS_PASS_MS]);
    assert.equal(starters.openWatches, 0);
  });

  it('writes no file and opens none after its scope is read: a pass only stamps', async () => {
    const kit = new CliHarness();
    const starters = new FakeStarterWatch();
    const files = new WatchedFiles(kit.files);
    let openedAtHello: string[] = [];
    const { sleep } = waits(starters, [() => void (openedAtHello = files.opened()), () => post(kit, 'one')]);
    const frames = framesOf(await kit.run(EVENTS, { starters, sleep, files }));
    assert.equal(frames.length, 2);
    assert.deepEqual(files.written(), []);
    assert.deepEqual(files.opened(), openedAtHello);
  });

  it('refuses on stderr before any frame, as read does, and watches no starter', async () => {
    const kit = new CliHarness();
    const starters = new FakeStarterWatch();
    const result = await kit.run(['events', '--json', '--session', 'gone', '--documents', 'inbox'], { starters });
    assert.equal(result.code, EXIT.refused);
    assert.deepEqual(result.stdout, []);
    assert.match(result.stderr.join('\n'), /^REFUSED gone is not a session on this team/);
    assert.equal(starters.openWatches, 0);
  });

  it('refuses a team that is neither its own nor above it', async () => {
    const kit = new CliHarness();
    const result = await kit.run(['events', '--json', '--documents', 'tasks', '--team', 'other']);
    assert.equal(result.code, EXIT.refused);
    assert.deepEqual(result.stdout, []);
    assert.match(result.stderr.join('\n'), /^REFUSED read serves your own team \(app\)/);
  });

  for (const [what, argv, words] of [
    ['a run without --json', ['events'], /add --json/],
    ['a document as an argument', ['events', 'tasks', '--json'], /unexpected "tasks": events names its documents with --documents/],
    ['an unknown document', ['events', '--json', '--documents', 'tasks,notes'], /--documents takes <document>\[,<document>\.\.\.\].*got "notes"/],
    ['a document named twice', ['events', '--json', '--documents', 'tasks,tasks'], /--documents names tasks twice/],
    ['an inbox with no session to serve', ['events', '--json'], /inbox is one session's/],
    ['history named with no task', ['events', '--json', '--documents', 'history'], /history is one task's: name it with --task T<id>/],
    ['a --task with no history followed', ['events', '--json', '--documents', 'tasks', '--task', 'T1'], /--task names the task history is asked of, and this run does not ask for history/],
    ['a --range with no stats followed', ['events', '--json', '--documents', 'tasks', '--range', '30d'], /--range names the days stats is counted over, and this run does not ask for stats/],
  ] as const) {
    it(`takes ${what} as a usage error, with no frame`, async () => {
      const kit = new CliHarness();
      const result = await kit.run(argv);
      assert.equal(result.code, EXIT.usage);
      assert.deepEqual(result.stdout, []);
      assert.match(result.stderr.join('\n'), words);
    });
  }

  it('follows history too once --task names the task, with the revision read answers of it', async () => {
    const kit = new CliHarness();
    const starters = new FakeStarterWatch();
    const { sleep } = waits(starters, []);
    const [hello] = framesOf(await kit.run([...EVENTS, '--task', 'T1'], { starters, sleep }));
    assert.deepEqual(namedIn(hello), [...DOCUMENTS]);
    const read = served(await kit.run(['read', 'history', '--json', '--task', 'T1', '--session', 'alpha']))['revision'];
    assert.match(String(read), REVISION);
    assert.equal(revisionIn(hello, 'history'), read);
  });

  it('follows stats over the range --range names, with the revision read answers of that range', async () => {
    const kit = new CliHarness();
    const starters = new FakeStarterWatch();
    const { sleep } = waits(starters, []);
    const [hello] = framesOf(await kit.run([...EVENTS, '--documents', 'stats', '--range', '30d'], { starters, sleep }));
    const read = served(await kit.run(['read', 'stats', '--json', '--range', '30d', '--session', 'alpha']))['revision'];
    assert.equal(revisionIn(hello, 'stats'), read);
  });

  it('keeps the scope it opened: a config edit moves every revision and ends no run', async () => {
    const kit = new CliHarness();
    const starters = new FakeStarterWatch();
    const { sleep } = waits(starters, [() => kit.files.append(CONFIG_PATH, '\n')]);
    const frames = framesOf(await kit.run([...EVENTS, '--documents', 'tasks,inbox'], { starters, sleep }));
    assert.deepEqual(frames.map((frame) => namedIn(frame)), [['tasks', 'inbox'], ['tasks', 'inbox']]);
  });
});
