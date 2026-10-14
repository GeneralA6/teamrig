import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runDemo } from './demo.ts';

const DOC = readFileSync(fileURLToPath(new URL('../../docs/commands.md', import.meta.url)), 'utf8').replaceAll('\r\n', '\n');

describe('docs/commands.md', () => {
  it("lists every command exactly as `teamrig help` prints it, so the page cannot drift from the CLI", async () => {
    const [help] = await runDemo([{ session: 'lead', argv: ['help'] }]);
    const printed = (help?.output ?? []).join('\n').replaceAll('\r\n', '\n').replace(/\n*$/, '\n');
    const listed = /^## Every command\n[\s\S]*?^```text\n([\s\S]*?)^```$/m.exec(DOC)?.[1];
    assert.equal(listed, printed, 'docs/commands.md is stale: copy the output of `teamrig help` into its text block');
  });

  it('shows the commands picture', () => {
    assert.match(DOC, /^## What a session sees\n[\s\S]*!\[[^\]]+\]\(images\/commands\.svg\)/m);
  });
});
