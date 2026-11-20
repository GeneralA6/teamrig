import { isStringArray, type ConfigReport, type JsonRecord } from '../../../plugin-api/index.ts';
import { isSite, projectKey } from './site.ts';

/**
 * The Jira connector's section of the team config (`connectors.jira`): which site the team's issues live on, which
 * of its projects the team works in, and the type a new issue opens as. Every key may be left out.
 */
export interface JiraConfig {
  /** The site's name, the part before `.atlassian.net`, in lowercase; undefined while the section names none. */
  readonly site: string | undefined;
  /** The keys of the site's projects the team works in, as Jira spells them, each once. */
  readonly projects: readonly string[];
  /** The name of the type a new issue opens as; undefined for the connector's own pick (issue-type.ts). */
  readonly issueType: string | undefined;
}

/** The section's keys, each beside the line the declaration says of it. */
export const CONFIG_KEYS = {
  site: "the Jira Cloud site's name, the part before .atlassian.net",
  projects: "the keys of the site's projects the team works in, as Jira spells them (ENG)",
  issueType: "the issue type a new issue opens as; without it a Task, or the project's first type that is no sub-task",
} as const;

function shown(value: unknown): string {
  return JSON.stringify(value);
}

function siteOf(value: unknown, report: ConfigReport): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (isSite(name)) {
    return name;
  }
  report('site', `must be the site's name, the part before .atlassian.net (acme for acme.atlassian.net), not ${shown(value)}`);
  return undefined;
}

function projectsOf(value: unknown, report: ConfigReport): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!isStringArray(value)) {
    report('projects', 'must be a list of project keys, as Jira spells them (["ENG"])');
    return [];
  }
  const keys: string[] = [];
  value.forEach((entry, index) => {
    const key = projectKey(entry.trim());
    if (key === undefined) {
      report(`projects[${index}]`, `must be a project key, a letter then letters, digits or _ (ENG), not ${shown(entry)}`);
    } else if (keys.includes(key)) {
      report(`projects[${index}]`, `names ${key} a second time`);
    } else {
      keys.push(key);
    }
  });
  return keys;
}

function issueTypeOf(value: unknown, report: ConfigReport): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const name = typeof value === 'string' ? value.trim() : '';
  if (name !== '' && !/[\r\n]/.test(name)) {
    return name;
  }
  report('issueType', `must be the name of an issue type on one line, as the project lists it (Task), not ${shown(value)}`);
  return undefined;
}

/**
 * Reads the section as the team's JSON holds it. Total: a wrong key is reported and reads as if it were left out.
 * A project is named by its key alone, so a section that lists projects and no site is reported too: nothing says
 * where they live.
 */
export function parseJiraConfig(section: JsonRecord, report: ConfigReport): JiraConfig {
  const site = siteOf(section['site'], report);
  const projects = projectsOf(section['projects'], report);
  if (section['site'] === undefined && projects.length > 0) {
    report('site', 'must name the site its projects live on');
  }
  return { site, projects, issueType: issueTypeOf(section['issueType'], report) };
}
