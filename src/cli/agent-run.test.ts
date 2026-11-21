import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HostSource } from '../composition/host-ports.ts';
import { bareHost } from '../testing/bare-host.ts';
import { HOOKS_ONLY_HOST, hostNaming, NO_SESSION_HOST, SHIPPED_HOST } from '../testing/host.ts';
import { quietWorld } from '../testing/quiet-world.ts';
import { NO_MARK_NAMED, refuseUnlessPerson, runBy, untoldRefusal, type RunBy } from './agent-run.ts';
import { RefusedError } from './runtime.ts';

const bare: HostSource = () => bareHost();
/** A host of its own, telling an agent's run by a variable no shipped host names. */
const OTHER_HOST = hostNaming({ marks: ['OTHER_AGENT', 'OTHER_TOOL'], identity: ['OTHER_SESSION'] });
/** A host whose launcher names no mark, which no adapter that loaded does. */
const MARKLESS_HOST = hostNaming({ marks: [], identity: [] });
const NO_SESSION = 'no session of the host is told';

function by(host: HostSource, env: Readonly<Record<string, string | undefined>>, shippedHosts: readonly HostSource[] = quietWorld().shippedHosts): RunBy {
  return runBy({ host, shippedHosts, env, platform: 'linux' });
}

describe('runBy', () => {
  it("takes a run with the shipped host's mark set as an agent's, and names the mark", () => {
    assert.deepEqual(by(SHIPPED_HOST, { CLAUDECODE: '1' }), { kind: 'agent', mark: 'CLAUDECODE' });
    assert.deepEqual(by(SHIPPED_HOST, { CLAUDECODE: ' ' }), { kind: 'agent', mark: 'CLAUDECODE' });
  });

  it("takes a run with no mark set, or an empty one, as the person's own where the running host names a mark", () => {
    assert.deepEqual(by(SHIPPED_HOST, {}), { kind: 'person' });
    assert.deepEqual(by(SHIPPED_HOST, { CLAUDECODE: '' }), { kind: 'person' });
    assert.deepEqual(by(SHIPPED_HOST, { CLAUDE_CODE_SESSION_ID: 's-1', CLAUDE_PROJECT_DIR: '/work' }), { kind: 'person' });
    assert.deepEqual(by(OTHER_HOST, {}), { kind: 'person' });
  });

  it("counts every shipped host's marks whatever host the run works in, the running host adding its own", () => {
    for (const host of [OTHER_HOST, MARKLESS_HOST, NO_SESSION_HOST, HOOKS_ONLY_HOST, bare]) {
      assert.deepEqual(by(host, { CLAUDECODE: '1' }), { kind: 'agent', mark: 'CLAUDECODE' });
    }
    assert.deepEqual(by(OTHER_HOST, { OTHER_AGENT: 'yes' }), { kind: 'agent', mark: 'OTHER_AGENT' });
    assert.deepEqual(by(OTHER_HOST, { OTHER_TOOL: '1' }), { kind: 'agent', mark: 'OTHER_TOOL' });
    assert.deepEqual(by(SHIPPED_HOST, { OTHER_AGENT: '1' }, [SHIPPED_HOST, OTHER_HOST]), { kind: 'agent', mark: 'OTHER_AGENT' });
  });

  it('takes no variable but a mark as one: an identity variable set alone is no mark', () => {
    assert.deepEqual(by(OTHER_HOST, { OTHER_SESSION: 's-1' }), { kind: 'person' });
    assert.deepEqual(by(SHIPPED_HOST, { OTHER_AGENT: '1' }), { kind: 'person' });
  });

  it("leaves a run untold, with the host's reason, where the running host tells nothing of its sessions and no mark is set", () => {
    for (const host of [NO_SESSION_HOST, HOOKS_ONLY_HOST, bare]) {
      assert.deepEqual(by(host, {}), { kind: 'untold', notice: NO_SESSION });
    }
    assert.deepEqual(by(bare, {}, []), { kind: 'untold', notice: NO_SESSION });
  });

  it('leaves a run untold where the launcher of the running host names no mark', () => {
    assert.deepEqual(by(MARKLESS_HOST, {}), { kind: 'untold', notice: NO_MARK_NAMED });
    assert.deepEqual(by(MARKLESS_HOST, { CLAUDECODE: '' }), { kind: 'untold', notice: NO_MARK_NAMED });
  });
});

describe('refuseUnlessPerson', () => {
  const { shippedHosts } = quietWorld();
  const refusal = (mark: string): string => `not where ${mark} is set`;
  const refused = (host: HostSource, env: Readonly<Record<string, string | undefined>>): string | undefined => {
    try {
      refuseUnlessPerson({ host, shippedHosts, env, platform: 'linux' }, 'the act', refusal);
      return undefined;
    } catch (error) {
      assert.ok(error instanceof RefusedError);
      return error.message;
    }
  };

  it("lets the person's own run through", () => {
    assert.equal(refused(SHIPPED_HOST, {}), undefined);
    assert.equal(refused(OTHER_HOST, {}), undefined);
  });

  it("refuses an agent's run in the caller's words, with the mark that is set", () => {
    assert.equal(refused(SHIPPED_HOST, { CLAUDECODE: '1' }), 'not where CLAUDECODE is set');
    assert.equal(refused(OTHER_HOST, { OTHER_AGENT: '1' }), 'not where OTHER_AGENT is set');
    assert.equal(refused(bare, { CLAUDECODE: '1' }), 'not where CLAUDECODE is set');
  });

  it("refuses an untold run with the host's reason and what its adapter must declare", () => {
    assert.equal(refused(NO_SESSION_HOST, {}), untoldRefusal('the act', NO_SESSION));
    assert.equal(refused(MARKLESS_HOST, {}), untoldRefusal('the act', NO_MARK_NAMED));
    assert.equal(
      untoldRefusal('the act', NO_SESSION),
      "the act is for the person alone, so it is refused on a host where an agent's run cannot be told from theirs (no session of the host is told); " +
        "the host's adapter must name a mark of an agent's run in its declaration's sessionVariables.marks and fill its session launcher port",
    );
  });
});
