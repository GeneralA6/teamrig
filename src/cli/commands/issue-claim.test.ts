import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CLAIM_DAYS, formatClaims } from '../../issues/claim.ts';
import { CliHarness, TEAM_HOME } from '../../testing/cli-harness.ts';
import { FakeIssueHost } from '../../testing/fake-issue-host.ts';
import { testHostIssue } from '../../testing/host-issue.ts';
import { openTeamKit, requireConfig } from '../kit.ts';
import { claimWrites, recordClaims, RELEASE_REPLY } from './issue-claim.ts';

const REPO = 'acme/web';
const CLAIMS = join(TEAM_HOME, 'state', 'github-claims.json');
const HOUR = 3_600_000;

describe('recordClaims on a tracker that holds a label under another name (T4754)', () => {
  it("swaps a run-out claim's status label by the names the tracker holds the two under, and counts the swap's writes", async () => {
    const harness = new CliHarness();
    const runtime = harness.runtime();
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const now = harness.clock.now();
    const made = now - (CLAIM_DAYS * 24 * HOUR + HOUR);
    await harness.files.write(CLAIMS, formatClaims({ claims: [{ repo: REPO, number: 8, login: 'ada', at: made }], checked: new Map([[REPO, made]]) }));
    const host = new FakeIssueHost().namesLabels((label) => label.toUpperCase()).hasLabels('STATUS:OPEN');
    const target = { repo: REPO, number: 8 };
    const outcome = await recordClaims(runtime, kit, config, {
      host,
      labelFiles: host,
      read: new Map([[REPO, [testHostIssue(8, { assignees: ['ada'], labels: ['STATUS:CLAIMED'] })]]]),
      started: now,
      writes: 10,
    });
    assert.deepEqual(host.calls, [
      { kind: 'unassign', target, login: 'ada' },
      { kind: 'label-add', target, labels: ['STATUS:OPEN'] },
      { kind: 'label-remove', target, label: 'STATUS:CLAIMED' },
      { kind: 'comment', target, body: RELEASE_REPLY },
    ]);
    assert.equal(outcome.writes, claimWrites(true));
  });
});
