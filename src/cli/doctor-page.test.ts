import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness, TEAM } from '../testing/cli-harness.ts';
import { FakeWebhook } from '../testing/fake-webhook.ts';

const HOOK_FILE = '/chat/secrets.yaml';

/** The harness with app's alerts naming the page URL by `PAGE_URL` in a secrets file holding `text`. */
async function keyedHarness(text: string): Promise<CliHarness> {
  const kit = new CliHarness({ ...TEAM, alerts: { pageWebhookFile: HOOK_FILE, pageWebhookKey: 'PAGE_URL' } });
  await kit.holdSecretDeny();
  await kit.files.write(HOOK_FILE, text);
  return kit;
}

describe('teamrig doctor: the page webhook', () => {
  it('flags a page URL that is not https, naming the team and key, never the URL, and posts nothing', async () => {
    const kit = await keyedHarness('OTHER: "x"\nPAGE_URL: "http://chat.example/secret-token"\n');
    const webhook = new FakeWebhook();
    const { stdout } = await kit.run(['doctor'], { webhook });
    assert.deepEqual(stdout, [
      'DOCTOR 1 finding(s), team app',
      "WARN page-webhook team app's alerts.pageWebhookFile gives no page URL (the webhook URL alerts.pageWebhookFile gives is not an https URL), so an expired Claude login pages nobody: fix alerts.pageWebhookFile or what it names, then run teamrig page test",
    ]);
    assert.doesNotMatch(stdout.join('\n'), /secret-token|chat\.example|\/chat\//);
    assert.deepEqual(webhook.posts, []);
  });

  it('flags a secrets file with no line for the key', async () => {
    const kit = await keyedHarness('OTHER: "https://chat.example/other"\n');
    const { stdout } = await kit.run(['doctor']);
    assert.match(stdout[1] ?? '', /^WARN page-webhook .*\(the file alerts\.pageWebhookFile names has no PAGE_URL line, or its quote is not closed\)/);
  });

  it('stays clean when the page URL resolves to https, posting nothing', async () => {
    const kit = await keyedHarness('PAGE_URL: "https://chat.example/x"\n');
    const webhook = new FakeWebhook();
    assert.deepEqual((await kit.run(['doctor'], { webhook })).stdout, ['DOCTOR clean, team app']);
    assert.deepEqual(webhook.posts, []);
  });

  it('stays clean when no team names a page webhook', async () => {
    const kit = new CliHarness();
    await kit.holdSecretDeny();
    assert.deepEqual((await kit.run(['doctor'])).stdout, ['DOCTOR clean, team app']);
  });
});
