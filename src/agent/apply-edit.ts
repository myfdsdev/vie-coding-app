/**
 * Deterministic application of a lazy <edit> (BUILD-PROMPT §6c).
 *
 * The body holds the new text of each changed region; every untouched region
 * is replaced by a marker line such as `// ... existing code ...`. Each run of
 * lines between markers must begin and end with lines copied unchanged from
 * the current file. Those anchors locate the run, and the original lines
 * between them are replaced by it. A run that cannot be located exactly once
 * fails the whole edit: a wrong splice is worse than asking for the full file.
 */

export type EditResult = { ok: true; content: string } | { ok: false; reason: string };

/** `// ... existing code ...`, `{/* ... existing code ... *\/}`, `# ...`, `<!-- ... -->` */
const MARKER = /^\s*(?:\/\/|#|\/\*|\{\s*\/\*|<!--)?\s*(?:\.{3}|…)\s*existing code\s*(?:\.{3}|…)\s*(?:\*\/\s*\}?|-->)?\s*$/i;

/** Lines one run may remove beyond its own length before the edit is refused as implausible. */
const MAX_EXTRA_REMOVED = 60;

export function isEditMarker(line: string): boolean {
  return MARKER.test(line);
}

type Eq = (a: string, b: string) => boolean;
const exact: Eq = (a, b) => a.trimEnd() === b.trimEnd();
// Second pass: models often re-indent the lines they copy.
const loose: Eq = (a, b) => a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ');

export function applyEdit(original: string, body: string): EditResult {
  const orig = original.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  if (!lines.length) return { ok: false, reason: 'The edit is empty.' };

  if (!lines.some(isEditMarker)) {
    // No markers: the model sent a whole file inside <edit>. Accept it only if it plausibly is one.
    if (lines.length >= orig.length * 0.7) return { ok: true, content: finish(lines) };
    return { ok: false, reason: 'The edit has no "// ... existing code ..." markers and is much shorter than the file.' };
  }

  const leading = isEditMarker(lines[0]);
  const trailing = isEditMarker(lines[lines.length - 1]);
  const runs = toRuns(lines);
  if (!runs.length) return { ok: false, reason: 'The edit contains only markers.' };

  const placed: { start: number; end: number; lines: string[] }[] = [];
  let cursor = 0;
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    const spot = place(orig, run, cursor, r === 0 && !leading, r === runs.length - 1 && !trailing);
    if (typeof spot === 'string') return { ok: false, reason: spot };
    const removed = spot.end - spot.start + 1 - run.length;
    if (removed > MAX_EXTRA_REMOVED) {
      return { ok: false, reason: `Placing the change after "${run[0].trim()}" would delete ${removed} lines.` };
    }
    placed.push({ ...spot, lines: run });
    cursor = spot.end + 1;
  }

  const out: string[] = [];
  let pos = 0;
  for (const p of placed) {
    out.push(...orig.slice(pos, p.start), ...p.lines);
    pos = p.end + 1;
  }
  out.push(...orig.slice(pos));
  return { ok: true, content: finish(out) };
}

function finish(lines: string[]): string {
  return lines.join('\n') + '\n';
}

/** Runs of non-marker lines, with blank lines at their edges trimmed. */
function toRuns(lines: string[]): string[][] {
  const runs: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    while (current.length && !current[0].trim()) current.shift();
    while (current.length && !current[current.length - 1].trim()) current.pop();
    if (current.length) runs.push(current);
    current = [];
  };
  for (const line of lines) {
    if (isEditMarker(line)) flush();
    else current.push(line);
  }
  flush();
  return runs;
}

/** How many of the run's first lines match the file from index i. */
function prefixMatch(orig: string[], run: string[], i: number, eq: Eq): number {
  let k = 0;
  while (k < run.length && i + k < orig.length && eq(orig[i + k], run[k])) k++;
  return k;
}

/** How many of the run's last lines match the file ending at index j (never before `floor`). */
function suffixMatch(orig: string[], run: string[], j: number, floor: number, eq: Eq): number {
  let k = 0;
  while (k < run.length && j - k >= floor && eq(orig[j - k], run[run.length - 1 - k])) k++;
  return k;
}

/**
 * Where the run replaces original lines. Start and end are judged together:
 * a start line that occurs twice is fine if only one occurrence is followed
 * by the run's end line. Ties at the best score are refused as ambiguous.
 */
function place(
  orig: string[],
  run: string[],
  from: number,
  atFileStart: boolean,
  atFileEnd: boolean,
): { start: number; end: number } | string {
  const first = run[0].trim();
  const last = run[run.length - 1].trim();
  let sawStart = false;
  for (const eq of [exact, loose]) {
    const starts: { at: number; score: number }[] = [];
    if (atFileStart) starts.push({ at: 0, score: 0 });
    else {
      for (let i = from; i < orig.length; i++) {
        const score = prefixMatch(orig, run, i, eq);
        if (score) starts.push({ at: i, score });
      }
    }
    if (starts.length) sawStart = true;

    const pairs: { start: number; end: number; score: number; ambiguous: boolean }[] = [];
    for (const s of starts) {
      if (atFileEnd) {
        pairs.push({ start: s.at, end: orig.length - 1, score: s.score, ambiguous: false });
        continue;
      }
      let top = 0;
      let ends: number[] = [];
      for (let j = s.at; j < orig.length; j++) {
        const score = suffixMatch(orig, run, j, s.at, eq);
        if (!score || score < top) continue;
        if (score > top) {
          top = score;
          ends = [j];
        } else ends.push(j);
      }
      if (ends.length) pairs.push({ start: s.at, end: ends[0], score: s.score + top, ambiguous: ends.length > 1 });
    }
    if (!pairs.length) continue;

    const topScore = Math.max(...pairs.map((p) => p.score));
    const winners = pairs.filter((p) => p.score === topScore);
    if (winners.length > 1 || winners[0].ambiguous) {
      return `The lines around "${first}" appear more than once, so the change can't be placed.`;
    }
    return { start: winners[0].start, end: winners[0].end };
  }
  return sawStart
    ? `"${last}" isn't in the file after "${first}", so the change can't be placed.`
    : `"${first}" isn't in the file, so the change can't be placed.`;
}
