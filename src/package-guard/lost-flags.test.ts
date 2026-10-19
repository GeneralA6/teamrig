import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { lostFlagsOf } from './lost-flags.ts';

const CONTEXT = { cwd: resolve('/', 'work', 'app'), home: resolve('/', 'u'), dialect: 'bash' } as const;

describe('lostFlagsOf', () => {
  it('lists each npx call that hands its bin a flag npm takes, once, across a chain', () => {
    assert.deepEqual(lostFlagsOf('npx --no tsc --version; npx --no tsc --version && (npx --no eslint --fix src)', CONTEXT), [
      { bin: 'tsc', flag: '--version' },
      { bin: 'eslint', flag: '--fix' },
    ]);
  });

  it('lists nothing for a line whose npx calls keep their flags, or that runs no npx', () => {
    for (const line of ['npx --no -- tsc --version', 'npx --no-install tsc --version', 'npx tsc --version', 'npm test']) {
      assert.deepEqual(lostFlagsOf(line, CONTEXT), [], line);
    }
  });
});
