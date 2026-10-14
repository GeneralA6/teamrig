import type { ScrubRule } from './rules.ts';

export interface Finding {
  readonly ruleId: string;
  readonly description: string;
  readonly source: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
  readonly match: string;
  readonly revealMatch: boolean;
}

export function scanText(source: string, text: string, rules: readonly ScrubRule[]): Finding[] {
  const lineStarts = lineStartOffsets(text);
  const findings: Finding[] = [];
  for (const rule of rules) {
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`;
    for (const match of text.matchAll(new RegExp(rule.pattern.source, flags))) {
      if (match[0] === '' || rule.isAllowed?.(match) === true) {
        continue;
      }
      const lineIndex = lineIndexOf(lineStarts, match.index);
      findings.push({
        ruleId: rule.id,
        description: rule.description,
        source,
        line: lineIndex + 1,
        column: match.index - (lineStarts[lineIndex] ?? 0) + 1,
        match: match[0],
        revealMatch: rule.revealMatch,
      });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

export function formatFinding(finding: Finding): string {
  const shown = finding.revealMatch
    ? JSON.stringify(finding.match)
    : `${JSON.stringify(finding.match.slice(0, 3))}... (${finding.match.length} chars)`;
  return `${finding.source}:${finding.line}:${finding.column} ${finding.ruleId}: ${finding.description} ${shown}`;
}

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function lineIndexOf(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}
