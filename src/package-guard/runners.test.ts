import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { programsOf } from './programs.ts';
import { runnerCallOf } from './runners.ts';

/**
 * The first program's runner call as `none`, `fetch <call>`, `bin <bin> <call>` (plus ` prefix <dir>` when given) or
 * `lost <bin> <flag>`.
 */
function callOf(line: string): string {
  const [run] = programsOf(line, { cwd: resolve('/', 'app'), home: resolve('/', 'u'), dialect: 'bash' });
  assert.ok(run !== undefined, line);
  const call = runnerCallOf(run);
  switch (call.kind) {
    case 'none':
      return 'none';
    case 'fetch':
      return `fetch ${call.call}`;
    case 'bin':
      return `bin ${call.bin} ${call.call}${call.prefix === undefined ? '' : ` prefix ${call.prefix.text}`}`;
    case 'lost-flag':
      return `lost ${call.bin} ${call.flag}`;
  }
}

function expectCalls(cases: Readonly<Record<string, string>>): void {
  for (const [line, expected] of Object.entries(cases)) {
    assert.equal(callOf(line), expected, line);
  }
}

describe('runnerCallOf', () => {
  it('reads npx: a bare name runs an installed bin, a package option or spec fetches, --no never fetches', () => {
    expectCalls({
      'npx eslint .': 'bin eslint npx eslint',
      'npx --yes -q eslint --fix': 'bin eslint npx eslint',
      'npx -- eslint': 'bin eslint npx eslint',
      'npx --prefix sub eslint': 'bin eslint npx eslint prefix sub',
      'npx --no eslint': 'none',
      'npx --no-install eslint': 'none',
      'npx -p typescript tsc': 'fetch npx --package typescript',
      'npx --package=typescript tsc': 'fetch npx --package typescript',
      'npx eslint@8.57.0': 'fetch npx eslint@8.57.0',
      'npx @biomejs/biome check': 'fetch npx @biomejs/biome',
      'npx github:user/repo': 'fetch npx github:user/repo',
      'npx user/repo': 'fetch npx user/repo',
      'npx "$TOOL"': 'fetch npx <a value only known when it runs>',
      'npx -p': 'fetch npx --package <a value only known when it runs>',
    });
  });

  it('reads a bare --no right before the bin, with a flag right after it, as handing that flag to npm', () => {
    expectCalls({
      'npx --no tsc --version': 'lost tsc --version',
      'npx --yes --no eslint -p x': 'lost eslint -p',
      'npx --no -- tsc --version': 'none',
      'npx --no-install tsc --version': 'none',
      'npx --no tsc': 'none',
      'npx --no tsc x.ts --noEmit': 'none',
      'npx --no tsc -- --version': 'none',
      'npx --no --prefix . tsc --version': 'none',
      'npx --no=true tsc --version': 'none',
      'npx --no tsc "$FLAG"': 'none',
      'npx --no "$BIN" --version': 'none',
    });
  });

  it('reads an npx that runs a file or a shell line, or nothing, as fetching nothing', () => {
    expectCalls({ 'npx ./bin/tool.js': 'none', 'npx ../x': 'none', 'npx /opt/x': 'none', 'npx -c "eslint ."': 'none', npx: 'none', 'npx -': 'none' });
  });

  it('reads npm exec like npx, and npm create or init with an initializer as a fetch', () => {
    expectCalls({
      'npm exec eslint': 'bin eslint npm exec eslint',
      'npm x -- eslint': 'bin eslint npm exec eslint',
      'npm --prefix sub exec eslint': 'bin eslint npm exec eslint prefix sub',
      'npm exec --no eslint': 'none',
      'npm create vite@latest my-app': 'fetch npm create vite@latest',
      'npm init react-app x': 'fetch npm init react-app',
      'npm innit x': 'fetch npm innit x',
      'npm init': 'none',
      'npm init -y': 'none',
      'npm init -w packages/a': 'none',
      'npm install': 'none',
      'npm run build': 'none',
      'npm "$SUB" x': 'none',
    });
  });

  it('reads pnpm, pnpx, yarn and bun: dlx and create fetch, exec and scripts run what is installed', () => {
    expectCalls({
      'pnpm dlx cowsay hi': 'fetch pnpm dlx cowsay',
      'pnpm -C sub dlx x': 'fetch pnpm dlx x',
      'pnpm create vite': 'fetch pnpm create vite',
      'pnpm dlx': 'none',
      'pnpm exec eslint': 'none',
      'pnpm eslint': 'none',
      'pnpx cowsay': 'fetch pnpx cowsay',
      'yarn dlx -p typescript tsc': 'fetch yarn dlx --package typescript',
      'yarn create next-app': 'fetch yarn create next-app',
      'yarn --cwd sub exec eslint': 'none',
      yarn: 'none',
      'bunx cowsay': 'bin cowsay bunx cowsay',
      'bunx --no-install cowsay': 'bin cowsay bunx cowsay',
      'bun x cowsay': 'bin cowsay bun x cowsay',
      'bun create vite': 'fetch bun create vite',
      'bun run build': 'none',
      'node x.js': 'none',
    });
  });
});
