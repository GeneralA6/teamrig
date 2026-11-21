import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe("the guide's teamrig test and teamrig queue text", () => {
  const guide = readFileSync(new URL('../../plugins/teamrig/skills/teamrig-guide/commands.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  /** The guide's section of one command, from its heading to the next one. */
  const section = (name: string): string => guide.split(`\n### teamrig ${name}\n`)[1]?.split('\n### ')[0]?.replaceAll('\n', ' ') ?? '';

  it('names the header a test log starts with, and the run outside git', () => {
    const text = section('test');
    for (const words of ['`# folder: <folder>`', '`# git: <top level> at <commit>, clean`', '`# git: none, it ran outside a git repository`']) {
      assert.ok(text.includes(words), words);
    }
  });

  it("names a detached run's header, a tree that changed while it waited, and the ledger's tree fields", () => {
    const text = section('queue');
    for (const words of ['`# folder:`, `# git:`', '`the tree changed while it waited; it runs on', '(`cwd`)', '(`gitTop`)', '(`head`,', '(`dirty`)']) {
      assert.ok(text.includes(words), words);
    }
  });
});
