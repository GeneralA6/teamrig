import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Roster } from '../config/roster.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { renameOf } from '../testing/rename.ts';
import { JsonlRenameLog } from './log.ts';
import { recordRename, type RenameDeps, type RenameOutcome, type RenameRequest } from './record.ts';

const PATH = join('/', 'state', 'renames.jsonl');
const CONFIG = { sessions: ['lead', 'alpha', 'bravo'], names: { lead: 'captain' }, roles: { lead: 'lead' } };

function setup(text?: string): { deps: RenameDeps; files: MemoryFiles; mutex: InlineMutex } {
  const files = new MemoryFiles(text === undefined ? {} : { [PATH]: text });
  const mutex = new InlineMutex();
  const deps: RenameDeps = {
    log: new JsonlRenameLog(files, PATH),
    mutex,
    clock: new FakeClock('2030-01-08T10:00:00Z'),
    rosterOf: (renames) => new Roster(CONFIG, 'app', renames),
  };
  return { deps, files, mutex };
}

function reasonOf(outcome: RenameOutcome): string | undefined {
  return outcome.kind === 'refused' ? outcome.reason : undefined;
}

describe('recordRename', () => {
  it("appends the session's own rename under the lock and returns the roster after it", async () => {
    const { deps, files, mutex } = setup();
    const outcome = await recordRename(deps, { id: 'alpha', to: 'scout', by: 'alpha' });
    assert.equal(outcome.kind, 'recorded');
    assert.equal(outcome.roster.nameOf('alpha'), 'scout');
    assert.equal(mutex.runs, 1);
    assert.deepEqual(JSON.parse(files.get(PATH) ?? ''), { v: 1, id: 'alpha', from: 'app-alpha', to: 'scout', at: '2030-01-08T10:00:00.000Z', by: 'alpha' });
  });

  it('records from the current name, so a chain of renames keeps every name', async () => {
    const { deps } = setup(JSON.stringify(renameOf('alpha', 'app-alpha', 'scout')));
    const outcome = await recordRename(deps, { id: 'alpha', to: 'ranger', by: 'lead' });
    assert.ok(outcome.kind === 'recorded');
    assert.deepEqual([outcome.rename.from, outcome.rename.by], ['scout', 'lead']);
    assert.deepEqual(outcome.roster.formerNamesOf('alpha'), ['app-alpha', 'scout']);
  });

  it('changes nothing when the session already has the name', async () => {
    const { deps, files } = setup();
    assert.equal((await recordRename(deps, { id: 'alpha', to: 'app-alpha', by: 'alpha' })).kind, 'unchanged');
    assert.equal(files.get(PATH), undefined);
  });

  it('refuses a stranger, a rename by another member, and a name that is not usable or is taken', async () => {
    const { deps, files } = setup();
    const requests: RenameRequest[] = [
      { id: 'zulu', to: 'ghost', by: 'lead' },
      { id: 'alpha', to: 'scout', by: 'bravo' },
      { id: 'alpha', to: 'Scout Two', by: 'alpha' },
      { id: 'alpha', to: 'bravo', by: 'alpha' },
      { id: 'alpha', to: 'captain', by: 'alpha' },
    ];
    const reasons = await Promise.all(requests.map(async (request) => reasonOf(await recordRename(deps, request))));
    assert.deepEqual(reasons, [
      'zulu is not a session on this team (sessions: lead (captain), alpha (app-alpha), bravo (app-bravo))',
      'only alpha itself or the lead may record its new name',
      '"Scout Two" cannot be a session name: a lowercase letter, then lowercase letters, digits or -, at most 65 characters',
      'bravo is the id of another session',
      'captain is already the name of lead',
    ]);
    assert.equal(files.get(PATH), undefined);
  });

  it('lets a session take its own id as its name, and a name another session left', async () => {
    const { deps } = setup(JSON.stringify(renameOf('bravo', 'app-bravo', 'scout')));
    assert.equal((await recordRename(deps, { id: 'alpha', to: 'alpha', by: 'alpha' })).kind, 'recorded');
    assert.equal((await recordRename(deps, { id: 'alpha', to: 'app-bravo', by: 'alpha' })).kind, 'recorded');
  });

  it('refuses to write beside records from a newer release', async () => {
    const { deps, files } = setup(JSON.stringify({ ...renameOf('bravo', 'app-bravo', 'scout'), v: 9 }));
    const outcome = await recordRename(deps, { id: 'alpha', to: 'ranger', by: 'alpha' });
    assert.match(reasonOf(outcome) ?? '', /holds renames from a newer teamrig; update teamrig/);
    assert.equal(files.get(PATH)?.split('\n').length, 1);
  });
});
