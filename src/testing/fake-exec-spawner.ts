import type { ExecSpawner, SpawnAsk, SpawnEnd } from '../exec/runner.ts';

/** A spawner that records what it was asked to start and ends as a test sets: `end`, or a throw when it is an Error. */
export class FakeExecSpawner implements ExecSpawner {
  readonly asks: SpawnAsk[] = [];
  end: SpawnEnd | Error = { exitCode: 0, timedOut: false, output: 'inserted 12\n' };

  async run(ask: SpawnAsk): Promise<SpawnEnd> {
    this.asks.push(ask);
    if (this.end instanceof Error) throw this.end;
    return this.end;
  }
}
