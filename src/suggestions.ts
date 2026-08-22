import { newSideLines } from "./context.js";
import type { Finding } from "./schema.js";

/** How far past a declared edge the block's edge line is looked for. */
const SNAP_WINDOW = 10;

/** Braces, brackets, and blank lines recur legitimately; a line with a word in it does not. */
function substantive(line: string): boolean {
  return /[A-Za-z0-9]/.test(line);
}

function blank(line: string | undefined): boolean {
  return line !== undefined && line.trim() === "";
}

/** Positions where block lines from `from` equal file lines from `at`, over `span` lines. */
function agreement(
  lines: string[],
  from: number,
  file: Map<number, string>,
  at: number,
  span: number,
): number {
  let n = 0;
  for (let i = 0; i < span; i++) {
    if (lines[from + i] === file.get(at + i)) n++;
  }
  return n;
}

/**
 * The line the block's first line names as the range start: the declared one
 * when it matches, else the nearest match inward across blank lines only, or
 * outward within the window when most of the lines in between agree too.
 */
function snapStart(
  lines: string[],
  file: Map<number, string>,
  start: number,
  end: number,
): number {
  const first = lines[0];
  if (first === undefined || !substantive(first)) return start;
  if (file.get(start) === first) return start;
  for (let s = start + 1; s <= end; s++) {
    if (!blank(file.get(s - 1))) break;
    if (file.get(s) === first) return s;
  }
  for (let s = start - 1; s >= start - SNAP_WINDOW; s--) {
    if (file.get(s) !== first) continue;
    const span = start - s;
    if (span > lines.length) return start;
    return agreement(lines, 0, file, s, span) * 2 > span ? s : start;
  }
  return start;
}

/** Mirror of snapStart for the block's last line and the range end. */
function snapEnd(
  lines: string[],
  file: Map<number, string>,
  start: number,
  end: number,
): number {
  const last = lines[lines.length - 1];
  if (last === undefined || !substantive(last)) return end;
  if (file.get(end) === last) return end;
  for (let e = end - 1; e >= start; e--) {
    if (!blank(file.get(e + 1))) break;
    if (file.get(e) === last) return e;
  }
  for (let e = end + 1; e <= end + SNAP_WINDOW; e++) {
    if (file.get(e) !== last) continue;
    const span = e - end;
    if (span > lines.length) return end;
    return agreement(lines, lines.length - span, file, end + 1, span) * 2 > span
      ? e
      : end;
  }
  return end;
}

/**
 * Fits a suggestion block to the range it replaces, so committing it on
 * GitHub changes exactly the lines the block rewrites. The range's edges snap
 * to the lines the block's first and last lines match, then the lines the
 * block shares with the range's edges are cut from both, leaving the block
 * that changes something. snapped reports a moved edge, trimmed the lines cut;
 * dropped is set when nothing worth posting remains (an empty block, or one
 * identical to the range).
 */
export function fitSuggestion(
  finding: Finding,
  patch: string | undefined,
): { finding: Finding; snapped: boolean; trimmed: number; dropped: boolean } {
  const keep = { finding, snapped: false, trimmed: 0, dropped: false };
  if (!finding.suggestion || patch === undefined) return keep;
  const declaredStart = finding.startLine ?? finding.line;
  const declaredEnd = finding.line;
  if (declaredStart > declaredEnd) return keep;

  const lines = finding.suggestion.split("\n");
  while (lines.length > 0 && blank(lines.at(-1))) lines.pop();
  const file = newSideLines(patch);

  let start = snapStart(lines, file, declaredStart, declaredEnd);
  let end = snapEnd(lines, file, start, declaredEnd);
  if (start > end) {
    start = declaredStart;
    end = declaredEnd;
  }
  const snapped = start !== declaredStart || end !== declaredEnd;

  let trimmed = 0;
  let prefix = 0;
  while (
    prefix < lines.length &&
    start + prefix <= end &&
    lines[prefix] === file.get(start + prefix)
  ) {
    prefix++;
  }
  // a block that only appends after the range has no line to anchor on;
  // keep the range's last line in both
  if (start + prefix > end && prefix < lines.length) prefix--;
  if (lines.slice(0, prefix).some(substantive)) {
    lines.splice(0, prefix);
    start += prefix;
    trimmed += prefix;
  }
  let suffix = 0;
  while (
    suffix < lines.length &&
    end - suffix >= start &&
    lines[lines.length - 1 - suffix] === file.get(end - suffix)
  ) {
    suffix++;
  }
  if (end - suffix < start && suffix < lines.length) suffix--;
  if (lines.slice(lines.length - suffix).some(substantive)) {
    lines.splice(lines.length - suffix);
    end -= suffix;
    trimmed += suffix;
  }

  const noop =
    lines.length === end - start + 1 &&
    lines.every((l, i) => l === file.get(start + i));
  if (lines.length === 0 || noop) {
    return {
      finding: { ...finding, suggestion: undefined },
      snapped,
      trimmed,
      dropped: true,
    };
  }
  const suggestion = lines.join("\n");
  if (
    suggestion === finding.suggestion &&
    start === declaredStart &&
    end === declaredEnd
  ) {
    return keep;
  }
  const { startLine: _declared, ...rest } = finding;
  return {
    finding: {
      ...rest,
      ...(start < end ? { startLine: start } : {}),
      line: end,
      suggestion,
    },
    snapped,
    trimmed,
    dropped: false,
  };
}
