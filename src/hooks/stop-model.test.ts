import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { ModelNoticeStore } from './model-notices.ts';
import { stopModelNotices, type StopModelInput } from './stop-model.ts';

const FOLDER = join('/', 'team', 'state', 'model-notices');
const TRANSCRIPT = join('/', 'projects', 'app', 'session.jsonl');
const LEAD: StopModelInput = {
  id: 'lead',
  name: 'app-lead',
  launch: { model: 'opus', effort: 'xhigh' },
  claude: 'claude-session-1',
  effort: 'xhigh',
  transcript: TRANSCRIPT,
};
const EFFORT_LINE = 'MODEL app-lead runs at low effort; the team config asks for model opus at xhigh effort: type /effort xhigh';
const FALLBACK_LINE =
  'MODEL app-lead now runs model claude-opus-4-8, not claude-opus-5-5: Claude Code switched after its safeguards stopped a reply (cyber) and keeps it for this session; type /model opus to switch back';

/** A transcript in which Claude Code switched from Opus 5.5 to Opus 4.8 (`uuid` tells one switch from another). */
function switched(uuid = 'switch-1'): string {
  const entry = { type: 'system', subtype: 'model_refusal_fallback', isSidechain: false, originalModel: 'claude-opus-5-5', fallbackModel: 'claude-opus-4-8', apiRefusalCategory: 'cyber', uuid };
  return `${JSON.stringify(entry)}\n`;
}

function setup(): { files: MemoryFiles; store: ModelNoticeStore } {
  const files = new MemoryFiles();
  return { files, store: new ModelNoticeStore(files, FOLDER) };
}

describe('stopModelNotices', () => {
  it('says nothing, and writes nothing, when the session runs as configured', async () => {
    const { files, store } = setup();
    await files.write(TRANSCRIPT, '{"type":"assistant","isSidechain":false,"message":{"model":"claude-opus-5-5"}}\n');
    assert.deepEqual(await stopModelNotices(files, store, LEAD), []);
    assert.deepEqual(await stopModelNotices(files, store, { ...LEAD, effort: undefined, transcript: undefined }), []);
    assert.equal(files.paths().length, 1, 'only the transcript');
  });

  it('tells a session at another effort once per Claude Code session, and again for another level', async () => {
    const { files, store } = setup();
    const low = { ...LEAD, effort: 'low' };
    assert.deepEqual(await stopModelNotices(files, store, low), [EFFORT_LINE]);
    assert.deepEqual(await stopModelNotices(files, store, low), []);
    assert.deepEqual(await stopModelNotices(files, store, { ...low, effort: 'high' }), [EFFORT_LINE.replace('low', 'high')]);
    assert.deepEqual(await stopModelNotices(files, store, { ...low, claude: 'claude-session-2' }), [EFFORT_LINE]);
  });

  it('never checks the effort of a session whose launch entry leaves it unset', async () => {
    const { files, store } = setup();
    assert.deepEqual(await stopModelNotices(files, store, { ...LEAD, launch: {}, effort: 'low' }), []);
  });

  it('tells any session once of each model switch, with the command back to its team model', async () => {
    const { files, store } = setup();
    await files.write(TRANSCRIPT, switched());
    assert.deepEqual(await stopModelNotices(files, store, LEAD), [FALLBACK_LINE]);
    assert.deepEqual(await stopModelNotices(files, store, LEAD), []);
    await files.append(TRANSCRIPT, switched('switch-2'));
    assert.deepEqual(await stopModelNotices(files, store, { ...LEAD, effort: 'low' }), [EFFORT_LINE, FALLBACK_LINE]);
    const alpha = { ...LEAD, id: 'alpha', name: 'app-alpha', launch: {} };
    assert.deepEqual(await stopModelNotices(files, store, alpha), [FALLBACK_LINE.replace('app-lead', 'app-alpha').replace('/model opus', '/model claude-opus-5-5')]);
  });

  it('shows nothing when it cannot record what it showed, so a broken store never repeats a line', async () => {
    const { files, store } = setup();
    const faulty = new FaultyFiles(files).fail('write', join(FOLDER, 'lead.json'), systemError('EACCES'));
    await assert.rejects(stopModelNotices(faulty, new ModelNoticeStore(faulty, FOLDER), { ...LEAD, effort: 'low' }), /EACCES/);
    assert.deepEqual(await stopModelNotices(files, store, { ...LEAD, effort: 'low' }), [EFFORT_LINE]);
  });
});
