import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness, TEAM } from '../testing/cli-harness.ts';
import { FakeWebhook } from '../testing/fake-webhook.ts';
import { treeHarness } from '../testing/team-tree.ts';

const HOOK_FILE = '/chat/secrets.yaml';
const HOOK_URL = 'https://chat.example/x';

/** The harness with app's alerts naming the page URL by `PAGE_URL` in a secrets file holding `text`. */
async function keyedHarness(text: string): Promise<CliHarness> {
  const kit = new CliHarness({ ...TEAM, timeZone: 'UTC', alerts: { pageWebhookFile: HOOK_FILE, pageWebhookKey: 'PAGE_URL' } });
  await kit.files.write(HOOK_FILE, text);
  return kit;
}

describe('teamrig page test', () => {
  it("posts one page marked TEST through the URL the team's key holds, and names the key, never the URL", async () => {
    const kit = await keyedHarness(`OTHER: "x"\nPAGE_URL: "${HOOK_URL}"\n`);
    const webhook = new FakeWebhook();
    const result = await kit.run(['page', 'test'], { webhook });
    assert.deepEqual([result.code, result.stdout, result.stderr], [0, ["PAGED a test page through app's alerts.pageWebhookFile"], []]);
    assert.equal(webhook.posts.length, 1);
    assert.equal(webhook.posts[0]?.url, HOOK_URL);
    assert.match(webhook.posts[0]?.content ?? '', /^TEST page from teamrig page test, team app, at \d\d:\d\d UTC: an expired Claude login would page you here\. Nothing to do\.$/);
  });

  it('prints why no page went, never the URL, and fails, when the URL is not https', async () => {
    const kit = await keyedHarness('PAGE_URL: "http://chat.example/secret-token"\n');
    const webhook = new FakeWebhook();
    const result = await kit.run(['page', 'test'], { webhook });
    assert.deepEqual(
      [result.code, result.stdout],
      [1, ["NO PAGE app's alerts.pageWebhookFile: the webhook URL alerts.pageWebhookFile gives is not an https URL"]],
    );
    assert.deepEqual(webhook.posts, []);
  });

  it("fails with the webhook's answer when the post is refused", async () => {
    const kit = await keyedHarness(`PAGE_URL: "${HOOK_URL}"\n`);
    const result = await kit.run(['page', 'test'], { webhook: new FakeWebhook('the webhook answered HTTP 404') });
    assert.deepEqual([result.code, result.stdout], [1, ["NO PAGE app's alerts.pageWebhookFile: the webhook answered HTTP 404"]]);
  });

  it('fails, naming both keys, when no team up the tree names a page webhook', async () => {
    const kit = new CliHarness();
    const webhook = new FakeWebhook();
    const result = await kit.run(['page', 'test'], { webhook });
    assert.deepEqual(
      [result.code, result.stdout],
      [1, ['NO PAGE no team from app up names alerts.pageWebhookFile or alerts.pageWebhookEnv, so an expired Claude login pages nobody']],
    );
    assert.deepEqual(webhook.posts, []);
  });

  it("pages through a parent team's key when the team's own alerts name none", async () => {
    const kit = await treeHarness({ timeZone: 'UTC', alerts: { pageWebhookFile: HOOK_FILE } });
    await kit.files.write(HOOK_FILE, `${HOOK_URL}\n`);
    const webhook = new FakeWebhook();
    const result = await kit.run(['page', 'test'], { webhook, env: { TEAMRIG_TEAM: 'ui', TEAMRIG_SESSION: 'pixel' } });
    assert.deepEqual([result.code, result.stdout], [0, ["PAGED a test page through app's alerts.pageWebhookFile"]]);
    assert.equal(webhook.posts[0]?.url, HOOK_URL);
    assert.match(webhook.posts[0]?.content ?? '', /, team ui, /);
  });
});
