import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ProgramRequest, ProgramResult, ProgramRunner } from '../core/program-runner.ts';
import { GH_PROGRAM, NotGhError, ghOverProgram, programOverGh } from './gh-program.ts';
import type { GhRequest, GhResult, GhRunner } from './gh.ts';

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

/** A program runner that keeps each request and answers RESULT. */
function recordingProgram(): { readonly run: ProgramRunner; readonly asked: ProgramRequest[] } {
  const asked: ProgramRequest[] = [];
  const run: ProgramRunner = (request): Promise<ProgramResult> => {
    asked.push(request);
    return Promise.resolve(RESULT);
  };
  return { run, asked };
}

describe('ghOverProgram', () => {
  it('sends each request as one run of gh, with its arguments and its environment', async () => {
    const { run, asked } = recordingProgram();
    const result = await ghOverProgram(run).run({ args: ['api', 'user'], env: { GH_TOKEN: 'a-key' } });
    assert.deepEqual(asked, [{ program: GH_PROGRAM, args: ['api', 'user'], env: { GH_TOKEN: 'a-key' } }]);
    assert.equal(result, RESULT);
  });
});

describe('programOverGh', () => {
  it("hands a run of gh to the runner, in the request's environment", async () => {
    const { gh, asked } = recordingGh();
    const result = await programOverGh(gh, { HOME: '/own' })({ program: GH_PROGRAM, args: ['api', 'user'], env: { GH_TOKEN: 'a-key' } });
    assert.deepEqual(asked, [{ args: ['api', 'user'], env: { GH_TOKEN: 'a-key' } }]);
    assert.equal(result, RESULT);
  });

  it('runs gh in its own environment when the request sets none', async () => {
    const { gh, asked } = recordingGh();
    await programOverGh(gh, { HOME: '/own' })({ program: GH_PROGRAM, args: ['api', 'user'] });
    assert.deepEqual(asked, [{ args: ['api', 'user'], env: { HOME: '/own' } }]);
  });

  it('rejects any other program and runs nothing', async () => {
    const { gh, asked } = recordingGh();
    await assert.rejects(programOverGh(gh, {})({ program: 'git', args: ['status'] }), new NotGhError('git'));
    assert.deepEqual(asked, []);
  });

  it("passes the runner's own rejection on, so a refused command line stays refused", async () => {
    const refused = new Error('gh may not run that');
    const gh: GhRunner = { run: () => Promise.reject(refused) };
    await assert.rejects(programOverGh(gh, {})({ program: GH_PROGRAM, args: ['auth', 'token'] }), refused);
  });
});

describe('a GhRunner taken across and back', () => {
  it('gets every request as it was sent', async () => {
    const { gh, asked } = recordingGh();
    const request: GhRequest = { args: ['issue', 'list', '--repo', 'acme/web'], env: { GH_TOKEN: 'a-key', HOME: '/own' } };
    const result = await ghOverProgram(programOverGh(gh, {})).run(request);
    assert.deepEqual(asked, [request]);
    assert.equal(result, RESULT);
  });
});
