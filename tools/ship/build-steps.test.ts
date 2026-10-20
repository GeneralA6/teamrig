import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildScriptOf, buildSteps } from './build-steps.ts';

describe('buildSteps', () => {
  it('runs each node and tsc step of the build script, in order', () => {
    const script = 'node tools/build/clean.ts && tsc -p tsconfig.build.json && node tools/build/integrity.ts';
    assert.deepEqual(buildSteps(script), [
      ['tools/build/clean.ts'],
      ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
      ['tools/build/integrity.ts'],
    ]);
  });

  it('refuses another program, a bare node, a quote or a shell operator', () => {
    for (const script of ['node a.ts && npm run x', 'node', 'node a.ts && ', 'node "a b.ts"', 'node a.ts | tee x', 'tsc -p a.json; rm -rf x']) {
      assert.throws(() => buildSteps(script), /REFUSED the build step/u, script);
    }
  });
});

describe('buildScriptOf', () => {
  it('reads scripts.build', () => {
    assert.equal(buildScriptOf(JSON.stringify({ scripts: { build: 'node a.ts', test: 'node --test' } })), 'node a.ts');
  });

  it('refuses a package.json with no build script', () => {
    assert.throws(() => buildScriptOf(JSON.stringify({ scripts: { test: 'node --test' } })));
    assert.throws(() => buildScriptOf(JSON.stringify({ name: 'x' })));
  });
});
