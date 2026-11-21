import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GITHUB_REPOS_HOST } from '../issues/host.ts';
import { refOf } from '../issues/ref.ts';
import type { ConnectorDeclaration } from '../plugin-api/index.ts';
import { ISSUE_REF_PREFIX } from '../register/model.ts';
import { loadConnector } from './loader.ts';

/**
 * The core holds two names the GitHub adapter declares as well: the kind of the host whose list is `github.repos`,
 * which is the id that adapter is loaded by, and what an issue ref starts with, which is its refPrefix. Neither side
 * can read the other's: the core imports no adapter, and an adapter imports the plugin API alone. So each is written
 * twice, and this spec, in the one folder that may reach both, holds the two writings equal.
 */

/** What the adapter the core's host kind names says of itself; the spec fails when no such adapter loads. */
async function declared(): Promise<ConnectorDeclaration> {
  const load = await loadConnector(GITHUB_REPOS_HOST);
  if (load.kind === 'refused') {
    assert.fail(`no connector adapter loads as ${GITHUB_REPOS_HOST}: ${load.notices.join('; ')}`);
  }
  return load.value.declaration;
}

describe("the core's names for the host of github.repos", () => {
  it('names its kind by the id of a connector adapter that is a tracker and a code host, as hostsOf asks of it', async () => {
    const declaration = await declared();
    assert.equal(declaration.id, GITHUB_REPOS_HOST);
    assert.deepEqual([...declaration.kinds].sort(), ['codehost', 'tracker']);
  });

  it('starts an issue ref with the prefix that adapter declares', async () => {
    const { refPrefix } = await declared();
    assert.equal(ISSUE_REF_PREFIX, refPrefix);
    assert.equal(refOf({ repo: 'acme/web', number: 7 }), `${refPrefix}acme/web#7`);
  });
});
