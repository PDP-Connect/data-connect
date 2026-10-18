// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Line-level rules shared by the accounting reporter and the runner for the
// output of a test file that never finishes. A credential redactor works on
// text it can see whole, so both sides work on whole lines: they cap each
// line, and they drop the lines after a credential label whose value may sit
// on the next line instead of trusting the redactor to find it.

/** No diagnostic line is longer than this; a longer line is cut and marked. */
export const MAX_DIAGNOSTIC_LINE_LENGTH = 2048;
export const LINE_TRUNCATED_MARKER = "…[line truncated]";
export const CREDENTIAL_CONTINUATION_MARKER = "[REDACTED: possible credential continuation]";

const LABEL = "(?:authorization|cookie|token|password|secret|api[_-]?key)";
// A label followed by a separator: the value starts after it, maybe on the next line.
const LABELLED_LINE = new RegExp(`${LABEL}["']?\\s*[:=]`, "i");
// A label whose value has not started: nothing, an opening quote or bracket, or a bare scheme word.
const OPEN_LABEL_LINE = new RegExp(
  `${LABEL}["']?\\s*[:=]\\s*["'{\\[]*\\s*(?:(?:bearer|basic|digest|negotiate)\\s*)?["']?\\s*$`,
  "i"
);
const BARE_LABEL_LINE = new RegExp(`^\\s*["']?${LABEL}["']?\\s*$`, "i");

/** `line` cut to the line cap, with a marker when it was cut. */
export function capDiagnosticLine(line: string): string {
  if (line.length <= MAX_DIAGNOSTIC_LINE_LENGTH) {
    return line;
  }
  let end = MAX_DIAGNOSTIC_LINE_LENGTH;
  // Do not leave half of a surrogate pair at the cut.
  const last = line.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return `${line.slice(0, end)}${LINE_TRUNCATED_MARKER}`;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function continuesAbove(line: string): boolean {
  return /^[ \t]/.test(line) && !isBlank(line);
}

export interface FailClosedLines {
  lines: string[];
  /**
   * Set when a credential region is still open at the last line: the index of
   * the line that opened it. More lines could extend the region, so a caller
   * that can wait for them should hold lines from this index.
   */
  openFrom: number | undefined;
}

/**
 * Fail closed on a credential value that may sit on a later line. After a line
 * with a credential label (Authorization, Cookie, Set-Cookie, token, password,
 * secret, api_key), when the label is still open (no value yet) and another
 * line follows, or when an indented continuation line follows, drop the
 * following lines up to the next blank line and put a marker in their place. A
 * label on the last line with text gets the marker too: its value may be cut off.
 *
 * The first `contextLines` lines are read for their labels but not returned:
 * they are lines a caller cut off the front of its output, kept so a region
 * that began before the cut still drops its continuation.
 */
export function failCloseCredentialContinuations(lines: readonly string[], contextLines = 0): FailClosedLines {
  const kept: string[] = [];
  const lastText = lines.findLastIndex((line) => !isBlank(line));
  let dropping = false;
  let openFrom: number | undefined;
  for (const [index, line] of lines.entries()) {
    if (dropping) {
      if (isBlank(line)) {
        dropping = false;
        openFrom = undefined;
        kept.push(line);
      }
      continue;
    }
    if (index >= contextLines) {
      kept.push(line);
    }
    if (!LABELLED_LINE.test(line) && !BARE_LABEL_LINE.test(line)) {
      continue;
    }
    const next = lines[index + 1];
    if (next === undefined || index === lastText) {
      kept.push(CREDENTIAL_CONTINUATION_MARKER);
      openFrom = index;
      continue;
    }
    const open = OPEN_LABEL_LINE.test(line) || BARE_LABEL_LINE.test(line);
    if ((open && !isBlank(next)) || continuesAbove(next)) {
      kept.push(CREDENTIAL_CONTINUATION_MARKER);
      dropping = true;
      openFrom = index;
    }
  }
  return { lines: kept, openFrom };
}
