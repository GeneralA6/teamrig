import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { heavyStepOf } from './heavy-steps.ts';
import { programsOf, type ProgramsContext } from './programs.ts';

const CONTEXT: ProgramsContext = { cwd: resolve('/', 'work', 'app'), home: resolve('/', 'u'), dialect: 'bash' };

/** Each program the line starts, as `name: step`, `-` for one that is no heavy step. */
function stepsOf(command: string): string {
  return programsOf(command, CONTEXT)
    .map((run) => `${run.name}: ${heavyStepOf(run) ?? '-'}`)
    .join(', ');
}

function expectSteps(cases: Readonly<Record<string, string>>): void {
  for (const [command, expected] of Object.entries(cases)) {
    assert.equal(stepsOf(command), expected, command);
  }
}

describe('heavyStepOf', () => {
  it('reads a package script as a test or a build, through run and its options', () => {
    expectSteps({
      'npm test': 'npm: test',
      'npm t': 'npm: test',
      'npm run test:cli -- --watch=false': 'npm: test',
      'pnpm verify': 'pnpm: test',
      'yarn check': 'yarn: test',
      'npm run-script coverage': 'npm: test',
      'npm --prefix app run tst': 'npm: test',
      'npm run build': 'npm: build',
      'pnpm typecheck': 'pnpm: build',
      'yarn run lint:fix': 'yarn: build',
      'npm -w pkg run build': 'npm: build',
    });
  });

  it('reads a test or build program, run alone or by npx', () => {
    expectSteps({
      tsc: 'tsc: build',
      'tsc --noEmit': 'tsc: build',
      'jest src': 'jest: test',
      'vitest run': 'vitest: test',
      'npx vitest run src/a.test.ts': 'npx: test',
      'npx -p typescript tsc': 'npx: build',
      'node --test src/a.test.ts': 'node: test',
    });
  });

  it('leaves out every other program and script', () => {
    expectSteps({
      'npm install': 'npm: -',
      'npm run dev': 'npm: -',
      'npm run testing': 'npm: -',
      'npm run prebuild': 'npm: -',
      'npx eslint src': 'npx: -',
      'node scripts/build-report.ts': 'node: -',
      'git status': 'git: -',
      bun: 'bun: -',
    });
  });

  it('leaves out a tool that only prints its version or usage, but not a flag handed on to a script', () => {
    expectSteps({
      'tsc --version': 'tsc: -',
      'jest --help': 'jest: -',
      'npx vitest --version': 'npx: -',
      'npx -p typescript tsc --help': 'npx: -',
      'node --test --help': 'node: -',
      'npx vitest run -- --help': 'npx: test',
      'pnpm run build --version': 'pnpm: build',
      'npm run build -- --help': 'npm: build',
      'npm test -- --version': 'npm: test',
      'tsc --versions': 'tsc: build',
    });
  });
});
