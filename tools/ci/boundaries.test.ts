import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BOUNDARY_RULES, type SourceFile, boundaryCounts, boundaryFindings, findingLine } from './boundaries.ts';

const file = (path: string, ...lines: readonly string[]): SourceFile => ({ path, text: lines.join('\n') });
/** One file's findings, each as `<line> <rule> <detail>`. */
const found = (source: SourceFile): string[] => boundaryFindings([source]).map((finding) => `${finding.line} ${finding.rule} ${finding.detail}`);

describe('boundaryFindings: what the core imports', () => {
  it('finds a core file importing another src folder, by its line and the file it reaches', () => {
    const core = file('src/core/run.ts', "import { join } from 'node:path';", "import { a } from './a.ts';", "import { b } from '../cli/b.ts';", "export { c } from '../register/c.ts';");
    assert.deepEqual(found(core), ['3 core-imports src/cli/b.ts', '4 core-imports src/register/c.ts']);
  });

  it('reads a dynamic import, a bare import, double quotes and two imports on one line', () => {
    const core = file('src/core/run.ts', "const b = await import('../cli/b.ts');", "import '../cli/c.ts';", 'import { d } from "../cli/d.ts"; import { e } from "../cli/e.ts";');
    assert.deepEqual(found(core), ['1 core-imports src/cli/b.ts', '2 core-imports src/cli/c.ts', '3 core-imports src/cli/d.ts', '3 core-imports src/cli/e.ts']);
  });

  it('lets a core spec use the fakes, and no other core file', () => {
    assert.deepEqual(found(file('src/core/run.test.ts', "import { fake } from '../testing/fake.ts';", "import { b } from '../cli/b.ts';")), ['2 core-imports src/cli/b.ts']);
    assert.deepEqual(found(file('src/core/run.ts', "import { fake } from '../testing/fake.ts';")), ['1 core-imports src/testing/fake.ts', '1 fakes-reach src/testing/fake.ts']);
  });

  it('holds only what the core imports from src, and only the core', () => {
    assert.deepEqual(found(file('src/core/run.ts', "import { root } from '../../tools/lib/root.ts';")), []);
    assert.deepEqual(found(file('src/cli/run.ts', "import { b } from '../register/b.ts';")), []);
  });
});

describe('boundaryFindings: who imports an adapter', () => {
  it('finds an import of an adapter from another src folder and from the tools', () => {
    assert.deepEqual(found(file('src/cli/run.ts', "import host from '../adapters/hosts/first/index.ts';")), ['1 adapter-reach src/adapters/hosts/first/index.ts']);
    assert.deepEqual(found(file('tools/docs/pages/draw.ts', "import host from '../../../src/adapters/hosts/first/index.ts';")), ['1 adapter-reach src/adapters/hosts/first/index.ts']);
  });

  it('refuses shipped code importing an adapter, and lets the spec beside it and the fakes drive one', () => {
    const adapter = "import { isIssueQuery } from '../adapters/connectors/first/testing/requests.ts';";
    assert.deepEqual(found(file('src/cli/issue-sync.ts', adapter)), ['1 adapter-reach src/adapters/connectors/first/testing/requests.ts']);
    assert.deepEqual(found(file('src/cli/issue-sync.test.ts', adapter)), []);
    assert.deepEqual(found(file('src/testing/cli-harness.ts', adapter)), []);
  });

  it('lets no spec or fake outside src reach an adapter, and no shipped file whose name only holds the word test', () => {
    const adapter = "import host from '../../../src/adapters/hosts/first/index.ts';";
    assert.deepEqual(found(file('tools/docs/pages/draw.test.ts', adapter)), ['1 adapter-reach src/adapters/hosts/first/index.ts']);
    assert.deepEqual(found(file('tools/docs/testing/draw.ts', adapter)), ['1 adapter-reach src/adapters/hosts/first/index.ts']);
    assert.deepEqual(found(file('src/cli/test.ts', "import host from '../adapters/hosts/first/index.ts';")), ['1 adapter-reach src/adapters/hosts/first/index.ts']);
  });

  it('still holds a core spec importing an adapter to the core rule', () => {
    assert.deepEqual(found(file('src/core/run.test.ts', "import host from '../adapters/hosts/first/index.ts';")), ['1 core-imports src/adapters/hosts/first/index.ts']);
  });

  it('counts a core file importing an adapter under both rules', () => {
    assert.deepEqual(found(file('src/core/run.ts', "import host from '../adapters/hosts/first/index.ts';")), ['1 core-imports src/adapters/hosts/first/index.ts', '1 adapter-reach src/adapters/hosts/first/index.ts']);
  });

  it('lets the composition and its specs import an adapter', () => {
    assert.deepEqual(found(file('src/composition/loader.ts', "const host = await import('../adapters/hosts/first/index.ts');")), []);
    assert.deepEqual(found(file('src/composition/loader.test.ts', "import host from '../adapters/hosts/first/index.ts';")), []);
  });
});

describe('boundaryFindings: what an adapter imports', () => {
  it("lets an adapter import its own folder, from any depth in it, and the plugin API's one file", () => {
    assert.deepEqual(found(file('src/adapters/hosts/first/index.ts', "import { declaration } from './declaration.ts';", "import { defineHost } from '../../../plugin-api/index.ts';")), []);
    assert.deepEqual(found(file('src/adapters/hosts/first/hooks/read.ts', "import { declaration } from '../declaration.ts';")), []);
  });

  it('finds an adapter importing the core, a file inside the plugin API or another adapter', () => {
    const adapter = file('src/adapters/connectors/second/index.ts', "import { isRecord } from '../../../core/guards.ts';", "import type { Host } from '../../../plugin-api/host.ts';", "import other from '../third/index.ts';");
    assert.deepEqual(found(adapter), ['1 adapter-imports src/core/guards.ts', '2 adapter-imports src/plugin-api/host.ts', '3 adapter-imports src/adapters/connectors/third/index.ts']);
  });

  it('lets an adapter spec use the fakes, and no other adapter file', () => {
    assert.deepEqual(found(file('src/adapters/hosts/first/index.test.ts', "import { hostDeps } from '../../../testing/adapter-deps.ts';")), []);
    assert.deepEqual(found(file('src/adapters/hosts/first/index.ts', "import { hostDeps } from '../../../testing/adapter-deps.ts';")), ['1 adapter-imports src/testing/adapter-deps.ts', '1 fakes-reach src/testing/adapter-deps.ts']);
  });

  it("lets an adapter spec bind its contracts from the conformance kit's one file, and no other adapter file", () => {
    const kit = "import { bind } from '../../../conformance/index.ts';";
    assert.deepEqual(found(file('src/adapters/hosts/first/contracts.test.ts', kit, "import { defineContract } from '../../../conformance/contract.ts';")), ['2 adapter-imports src/conformance/contract.ts']);
    assert.deepEqual(found(file('src/adapters/hosts/first/index.ts', kit)), ['1 adapter-imports src/conformance/index.ts']);
  });

  it('holds a file above the adapter folders to its own folder', () => {
    const shared = file('src/adapters/hosts/shared.ts', "import first from './first/index.ts';", "import second from '../connectors/second/index.ts';");
    assert.deepEqual(found(shared), ['2 adapter-imports src/adapters/connectors/second/index.ts']);
  });
});

describe('boundaryFindings: who imports the fakes', () => {
  it('finds shipped code of src importing a fake, which may import an adapter, and lets a spec and another fake', () => {
    const fake = "import { FakeTool } from '../testing/fake-tool.ts';";
    assert.deepEqual(found(file('src/cli/issue-sync.ts', fake)), ['1 fakes-reach src/testing/fake-tool.ts']);
    assert.deepEqual(found(file('src/cli/issue-sync.test.ts', fake)), []);
    assert.deepEqual(found(file('src/testing/cli-harness.ts', "import { FakeTool } from './fake-tool.ts';")), []);
    assert.deepEqual(found(file('src/testing/cli-harness.test.ts', "import { FakeTool } from './fake-tool.ts';")), []);
  });

  it('holds the composition too, and a shipped file whose name only holds the word test', () => {
    assert.deepEqual(found(file('src/composition/adapters.ts', "import { FakeTool } from '../testing/fake-tool.ts';")), ['1 fakes-reach src/testing/fake-tool.ts']);
    assert.deepEqual(found(file('src/cli/test.ts', "import { FakeTool } from '../testing/fake-tool.ts';")), ['1 fakes-reach src/testing/fake-tool.ts']);
  });

  it('reads no file outside src: the tools ship nothing', () => {
    assert.deepEqual(found(file('tools/ci/draw.ts', "import { FakeTool } from '../../src/testing/fake-tool.ts';")), []);
  });
});

describe('boundaryFindings: lines naming a tool', () => {
  it('finds each line naming a tool, inside a longer word and in any case, each name once', () => {
    const core = file('src/core/run.ts', 'const claudeSession = claude();', 'const plain = 2;', 'const GITHUB_TOKEN = env.GitHub ?? codex;', '// jira and grok');
    assert.deepEqual(found(core), ['1 tool-names claude', '3 tool-names github, codex', '4 tool-names jira, grok']);
  });

  it('reads no adapter, composition, fake, spec or file outside src', () => {
    for (const path of ['src/adapters/hosts/first/index.ts', 'src/composition/adapters.ts', 'src/testing/fake-claude.ts', 'src/core/run.test.ts', 'tools/ci/run.ts']) {
      assert.deepEqual(found(file(path, 'const claudeSession = 1;')), [], path);
    }
  });

  it("lists the files in their order, a file's imports before its tool names", () => {
    const findings = boundaryFindings([file('src/cli/b.ts', 'const codexHome = 1;', "import host from '../adapters/hosts/first/index.ts';"), file('src/core/a.ts', "import { b } from '../cli/b.ts';")]);
    assert.deepEqual(findings.map(findingLine), ['src/cli/b.ts:2: adapter-reach: src/adapters/hosts/first/index.ts', 'src/cli/b.ts:1: tool-names: codex', 'src/core/a.ts:1: core-imports: src/cli/b.ts']);
  });
});

describe('boundaryCounts', () => {
  it('counts the findings of each rule, in the rules order', () => {
    const findings = boundaryFindings([file('src/core/run.ts', "import { b } from '../cli/b.ts';", 'const jiraKey = 1;', 'const grokKey = 2;'), file('src/adapters/hosts/first/index.ts', "import { isRecord } from '../../../core/guards.ts';")]);
    assert.deepEqual(boundaryCounts(findings), [
      '1 imports from src/core into another src folder',
      '0 imports of an adapter by shipped code outside src/adapters and src/composition',
      '1 imports by an adapter beyond its own folder and the plugin API',
      '0 imports of src/testing by shipped code of src',
      '2 lines naming a tool outside src/adapters and src/composition',
    ]);
  });

  it('gives every rule a line when nothing is found', () => {
    assert.deepEqual(boundaryCounts([]), BOUNDARY_RULES.map((rule) => `0 ${rule.title}`));
  });
});
