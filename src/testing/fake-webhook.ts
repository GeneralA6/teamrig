import type { ChatWebhook } from '../core/webhook.ts';

/** One post a command asked of the webhook. */
export interface WebhookPost {
  readonly url: string;
  readonly content: string;
}

/** A webhook in memory: it keeps every post asked of it, and answers each with the problem it was made with, if any. */
export class FakeWebhook implements ChatWebhook {
  readonly posts: WebhookPost[] = [];
  private readonly problem: string | undefined;

  constructor(problem: string | undefined = undefined) {
    this.problem = problem;
  }

  async post(url: string, content: string): Promise<string | undefined> {
    this.posts.push({ url, content });
    return this.problem;
  }
}
