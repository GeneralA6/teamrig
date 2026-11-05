import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { DASH_QUOTES, NOTHING_QUOTES } from '../testing/ansi-c-quotes.ts';
import { installCallsOf, type InstallTarget } from './installs.ts';

function targetText(target: InstallTarget): string {
  if (target.kind === 'unvetted') {
    return `${target.spec}: ${target.why}`;
  }
  const { wanted } = target;
  return `${target.name} ${wanted.kind === 'version' ? `version ${wanted.version}` : `tag ${wanted.tag}`}`;
}

/** Each install the line runs as `<call>: <target>; <target>`. */
function installsOf(line: string): string[] {
  return installCallsOf(line, { cwd: resolve('/', 'app'), home: resolve('/', 'u'), dialect: 'bash' }).map(
    ({ call, targets }) => `${call}: ${targets.map(targetText).join('; ')}`,
  );
}

describe('installCallsOf', () => {
  it('reads an exact version or a dist-tag as a registry package to vet', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['npm install lodash@4.17.21', 'npm install: lodash version 4.17.21'],
      ['npm i @types/node@v22.10.1 -D', 'npm i: @types/node version 22.10.1'],
      ['bun add zod@=3.23.8+build.1', 'bun add: zod version 3.23.8'],
      ['npm i left-pad@1.3.0-rc.1', 'npm i: left-pad version 1.3.0-rc.1'],
      ['pnpm add typescript', 'pnpm add: typescript tag latest'],
      ['npm i react --tag next', 'npm i: react tag next'],
      ['npm i react --tag=canary', 'npm i: react tag canary'],
      ['yarn add vite@beta', 'yarn add: vite tag beta'],
      ['npm i -g npm@latest', 'npm i: npm tag latest'],
      ['yarn global add serve@14.2.4', 'yarn global add: serve version 14.2.4'],
      ['npm i JSONStream@1.3.5', 'npm i: JSONStream version 1.3.5'],
      ['npm i my-lodash@npm:lodash@4.17.21', 'npm i: lodash version 4.17.21'],
      ['npm i lodash@4.17.21 chalk@5.3.0', 'npm i: lodash version 4.17.21; chalk version 5.3.0'],
    ];
    for (const [line, expected] of cases) {
      assert.deepEqual(installsOf(line), [expected], line);
    }
  });

  it('names why a range, a git or URL source, or a package only known when it runs cannot be vetted', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['npm i lodash@^4.17.21', 'npm i: lodash@^4.17.21: a range, not an exact version'],
      ['npm i lodash@4', 'npm i: lodash@4: a range, not an exact version'],
      ['npm i lodash@x', 'npm i: lodash@x: a range, not an exact version'],
      ['npm i lodash@v4', 'npm i: lodash@v4: a range, not an exact version'],
      ['pnpm add "lodash@>=4 <5"', 'pnpm add: lodash@>=4 <5: a range, not an exact version'],
      ['npm i x@npm:lodash@^4', 'npm i: x@npm:lodash@^4: a range, not an exact version'],
      ['npm i user/repo', 'npm i: user/repo: a GitHub repository, not a registry version'],
      ['npm i lodash@user/repo', 'npm i: lodash@user/repo: a GitHub repository, not a registry version'],
      ['npm i github:user/repo', 'npm i: github:user/repo: a git or URL source, not a registry version'],
      ['npm i git+https://example.com/x.git', 'npm i: git+https://example.com/x.git: a git or URL source, not a registry version'],
      ['npm i https://example.com/x.tgz', 'npm i: https://example.com/x.tgz: a git or URL source, not a registry version'],
      ['npm i x@https://example.com/x.tgz', 'npm i: x@https://example.com/x.tgz: a git or URL source, not a registry version'],
      ['npm i "$PKG"', 'npm i: <a value only known when it runs>: a package only known when the line runs'],
      ['npm i react --tag "$T"', 'npm i: react: its tag is only known when the line runs'],
      ['npm i react --before 2024-01-01', 'npm i: react: --before picks its version by date, not by its tag'],
      ['npm i "bad name"', 'npm i: bad name: not a package name'],
    ];
    for (const [line, expected] of cases) {
      assert.deepEqual(installsOf(line), [expected], line);
    }
  });

  it('keeps an exact version under --before, which vets as any exact version does', () => {
    assert.deepEqual(installsOf('npm i react@18.3.1 --before 2024-01-01'), ['npm i: react version 18.3.1']);
  });

  it('passes an install from the lockfile alone and one of a local folder or file', () => {
    for (const line of [
      'npm install',
      'npm ci',
      'npm i --omit dev',
      'npm i -g',
      'npm --prefix ./web install',
      'pnpm i --frozen-lockfile',
      'pnpm install',
      'yarn',
      'yarn install',
      'bun i',
      'npm i ./pkg',
      'npm i ../x.tgz',
      'npm i file:../lib',
      'pnpm add lib@workspace:*',
      'yarn add lib@link:../lib',
      'npm run build',
      'npm test',
    ]) {
      assert.deepEqual(installsOf(line), [], line);
    }
  });

  it('does not read the value of an option as a package, before or after the packages', () => {
    assert.deepEqual(installsOf('npm i --registry https://r.example lodash@4.17.21'), ['npm i: lodash version 4.17.21']);
    assert.deepEqual(installsOf('npm --prefix web i lodash@4.17.21 --omit dev'), ['npm i: lodash version 4.17.21']);
    assert.deepEqual(installsOf('pnpm --filter web add zod@3.23.8 --reporter silent'), ['pnpm add: zod version 3.23.8']);
    assert.deepEqual(installsOf('yarn --cwd web add zod@3.23.8'), ['yarn add: zod version 3.23.8']);
    assert.deepEqual(installsOf('bun add --cwd web zod@3.23.8'), ['bun add: zod version 3.23.8']);
  });

  it('reads every word after -- as a package', () => {
    assert.deepEqual(installsOf('npm i -- lodash@4.17.21'), ['npm i: lodash version 4.17.21']);
  });

  it('refuses an update without a version, which floats, and reads one with a version as an add except by npm', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['npm update', 'npm update: npm update: moves every dependency to the newest version its range allows'],
      ['npm update lodash', 'npm update: lodash: moves to the newest version its range allows'],
      ['npm up lodash@4.17.21', 'npm up: lodash@4.17.21: moves to the newest version its range allows'],
      ['pnpm up typescript', 'pnpm up: typescript: moves to the newest version its range allows'],
      ['pnpm up typescript@5.9.3', 'pnpm up: typescript version 5.9.3'],
      ['yarn upgrade', 'yarn upgrade: yarn upgrade: moves every dependency to the newest version its range allows'],
      ['yarn up lodash@^4', 'yarn up: lodash@^4: a range, not an exact version'],
      ['bun update zod@latest', 'bun update: zod tag latest'],
    ];
    for (const [line, expected] of cases) {
      assert.deepEqual(installsOf(line), [expected], line);
    }
  });

  it("reads an install behind a $'...' string whose value is nothing as the plain line", () => {
    for (const quote of NOTHING_QUOTES) {
      const cases: readonly (readonly [string, string])[] = [
        [`npm ${quote}i lodash@4.17.21`, 'npm i: lodash version 4.17.21'],
        [`npm ${quote}install lodash@4.17.21`, 'npm install: lodash version 4.17.21'],
        [`${quote}npm i lodash@4.17.21`, 'npm i: lodash version 4.17.21'],
        [`npm i ${quote}lodash@4.17.21`, 'npm i: lodash version 4.17.21'],
        [`npm i lodash@${quote}4.17.21`, 'npm i: lodash version 4.17.21'],
        [`npm i react ${quote}--tag next`, 'npm i: react tag next'],
        [`pnpm ${quote}add typescript`, 'pnpm add: typescript tag latest'],
        [`yarn ${quote}add vite@beta`, 'yarn add: vite tag beta'],
      ];
      for (const [line, expected] of cases) {
        assert.deepEqual(installsOf(line), [expected], line);
      }
    }
  });

  it('reads an option whose dash only bash spells out', () => {
    for (const dash of DASH_QUOTES) {
      assert.deepEqual(installsOf(`npm i react ${dash}-tag next`), ['npm i: react tag next'], dash);
    }
  });

  it('finds installs through cd, chains and a launcher', () => {
    assert.deepEqual(installsOf('cd web && npm i zod@3.23.8 && npm test'), ['npm i: zod version 3.23.8']);
    assert.deepEqual(installsOf('bash -c "pnpm add zod@3.23.8"'), ['pnpm add: zod version 3.23.8']);
    assert.deepEqual(installsOf('npm ci; yarn add a@1.0.0; bun add b'), ['yarn add: a version 1.0.0', 'bun add: b tag latest']);
  });
});
