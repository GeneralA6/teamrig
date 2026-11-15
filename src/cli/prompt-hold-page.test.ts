import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { JsonRecord } from '../core/guards.ts';
import { SecretScanner } from '../core/secrets.ts';
import { formatTabNeed, type TabNeed } from '../tabs/need.ts';
import { CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { FakeWebhook } from '../testing/fake-webhook.ts';
import { openKit } from './kit.ts';
import { pagePromptHolds } from './prompt-hold-page.ts';
import { EXIT } from './runtime.ts';

const HOOK_FILE = '/chat/page-url';
const HOOK_URL = 'https://chat.example/x';
const PAGED = { ...TEAM, alerts: { pageWebhookFile: HOOK_FILE } };
/** The harness's clock. */
const NOW = Date.parse('2030-01-08T10:00:00Z');
const HELD: TabNeed = { session: 'bravo', state: 'waiting', kind: 'permission', text: 'Bash: git push origin /srv/data', task: null, pid: null, since: '2030-01-08T09:45:00.000Z' };

async function harness(config: JsonRecord = PAGED, need: TabNeed = HELD): Promise<CliHarness> {
  const kit = new CliHarness(config);
  await kit.files.write(HOOK_FILE, `${HOOK_URL}\n`);
  await kit.files.write(join(TEAM_HOME, 'state', 'tabs', `${need.session}.json`), formatTabNeed(need));
  return kit;
}

async function pageOnce(kit: CliHarness, webhook: FakeWebhook): Promise<string[]> {
  const runtime = kit.runtime({ webhook });
  return pagePromptHolds(runtime, await openKit(runtime, 'app'), new SecretScanner(), NOW);
}

describe('pagePromptHolds (T2927)', () => {
  it('pages the owner once for a tab held 15 min, naming the first plain words only', async () => {
    const kit = await harness();
    const webhook = new FakeWebhook();
    assert.deepEqual(await pageOnce(kit, webhook), []);
    assert.deepEqual(webhook.posts, [
      { url: HOOK_URL, content: 'app/bravo holds on a permission prompt since 09:45 UTC (15 min): Bash git push origin; answer it in that tab' },
    ]);
    assert.deepEqual(await pageOnce(kit, webhook), []);
    assert.equal(webhook.posts.length, 1, 'the second pass pages the same hold no more');
  });

  it('pages nothing for a prompt 9 min old, or one answered', async () => {
    const webhook = new FakeWebhook();
    await pageOnce(await harness(PAGED, { ...HELD, since: '2030-01-08T09:51:00.000Z' }), webhook);
    await pageOnce(await harness(PAGED, { ...HELD, state: 'working', kind: null, text: null }), webhook);
    assert.deepEqual(webhook.posts, []);
  });

  it('returns why a page failed and tries it again at the next pass', async () => {
    const kit = await harness();
    const refused = new FakeWebhook('the webhook answered HTTP 404');
    assert.deepEqual(await pageOnce(kit, refused), [
      "the page of app/bravo's permission prompt hold failed (the webhook answered HTTP 404); the next idle pass tries again",
    ]);
    const webhook = new FakeWebhook();
    await pageOnce(kit, webhook);
    assert.equal(webhook.posts.length, 1);
  });

  it('pages nobody with no webhook up the tree, and check still names the hold to the lead', async () => {
    const kit = await harness(TEAM);
    const webhook = new FakeWebhook();
    assert.deepEqual(await pageOnce(kit, webhook), []);
    assert.deepEqual(webhook.posts, []);
    const result = await kit.run(['check', '--all'], { env: { TEAMRIG_SESSION: 'lead' } });
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.deepEqual(
      result.stdout.filter((line) => line.includes('PROMPT-HELD')).map((line) => line.trim()),
      ['from the prompt-hold check of the tab files: PROMPT-HELD app/bravo holds on a permission prompt since 09:45 UTC (15 min): Bash git push origin; answer it in that tab'],
    );
  });
});
