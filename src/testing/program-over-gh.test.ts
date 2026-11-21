import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GH_PROGRAM, type GhRequest, type GhResult, type GhRunner } from '../adapters/connectors/github/gh.ts';
import { NotGhError, programOverGh } from './program-over-gh.ts';

const RESULT: GhResult = { end: { kind: 'exited', code: 0 }, stdout: 'out', stderr: 'err' };

/** A GhRunner that keeps each request and answers RESULT. */
function recordingGh(): { readonly gh: GhRunner; readonly asked: GhRequest[] } {
  const asked: GhRequest[] = [];
  return {
    gh: {
      run: (request) => {
        asked.push(request);
        return Promise.resolve(RESULT);
      },
    },
    asked,
  };
}

describe('programOverGh', () => {
  it("hands a run of gh to the runner, in the request's environment", async () => {
    const { gh, asked } = recordingGh();
    const result = await programOverGh(gh)({ program: GH_PROGRAM, args: ['api', 'user'], env: { GH_TOKEN: 'a-key' } });
    assert.deepEqual(asked, [{ args: ['api', 'user'], env: { GH_TOKEN: 'a-key' } }]);
    assert.equal(result, RESULT);
  });

  it('runs gh in an empty environment when the request sets none', async () => {
    const { gh, asked } = recordingGh();
    await programOverGh(gh)({ program: GH_PROGRAM, args: ['api', 'user'] });
    assert.deepEqual(asked, [{ args: ['api', 'user'], env: {} }]);
  });

  it('rejects any other program and runs nothing', async () => {
    const { gh, asked } = recordingGh();
    await assert.rejects(programOverGh(gh)({ program: 'git', args: ['status'] }), new NotGhError('git'));
    assert.deepEqual(asked, []);
  });

  it("passes the runner's own rejection on", async () => {
    const refused = new Error('gh may not run that');
    const gh: GhRunner = { run: () => Promise.reject(refused) };
    await assert.rejects(programOverGh(gh)({ program: GH_PROGRAM, args: ['auth', 'token'] }), refused);
  });
});
