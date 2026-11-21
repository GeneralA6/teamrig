import type { HostGroup } from '../feature.ts';

/** What a session is told and keeps: the start text, the files read on every turn and the memory. */
export const RULES_FEATURES = {
  'rules.session-start': { doc: 'team rules, identity and live tasks at a session start', byDefault: 'on' },
  'rules.instruction-files': { doc: 'the rules files read on every turn', byDefault: 'on' },
  'rules.rules-folder': { doc: 'the rules folder of a project', byDefault: 'on' },
  'rules.memory': { doc: 'memory files kept between sessions', byDefault: 'on' },
  'rules.start-size': { doc: "the CLI's limits on the start text, a rules file and a skill's listing", byDefault: 'on' },
} as const satisfies HostGroup<'rules'>;
