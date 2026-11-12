import { noPositionals, type ParsedArgs } from '../args.ts';
import { openTeamKit } from '../kit.ts';
import { sendTestPage } from '../login-page.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';

/**
 * `page test`: posts one page marked TEST through the page webhook the team's alerts (or a team's above) name, the
 * same way an expired Claude login's page goes, so a silent pager shows before the day it is needed (T2349). It prints
 * which team's key paged, or why no page went; never the URL or the file's path. Exit 1 when no page went.
 */
export async function pageTest(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { paths } = await openTeamKit(runtime);
  const sent = await sendTestPage(runtime, paths.team);
  if (sent.status === 'ok') {
    runtime.out.stdout(`PAGED a test page through ${sent.source.team}'s alerts.${sent.source.key}`);
    return EXIT.ok;
  }
  runtime.out.stdout(
    sent.status === 'none'
      ? `NO PAGE no team from ${paths.team} up names alerts.pageWebhookFile or alerts.pageWebhookEnv, so an expired Claude login pages nobody`
      : `NO PAGE ${sent.source.team}'s alerts.${sent.source.key}: ${sent.problem}`,
  );
  return EXIT.failed;
}
