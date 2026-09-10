/**
 * Streaming parser for the <changes> edit format (BUILD-PROMPT §6c).
 *
 * Feed it model text as it arrives. It emits prose, per-file progress and
 * complete operations incrementally, so files appear in the UI while they
 * are still being written. Tags split across chunk boundaries are handled by
 * holding back any tail that could be the start of the tag being searched for.
 *
 * A <write> or <edit> that never closes (truncated output) is DISCARDED with a
 * warning: a partial file is never applied.
 */

export type ChangeOp =
  | { type: 'write'; path: string; content: string }
  | { type: 'edit'; path: string; instruction: string; body: string }
  | { type: 'rename'; from: string; to: string }
  | { type: 'delete'; path: string }
  | { type: 'add-dependency'; spec: string };

export type ParseEvent =
  | { type: 'text'; text: string; phase: 'before' | 'after' }
  | { type: 'file-start'; kind: 'write' | 'edit'; path: string }
  | { type: 'file-chunk'; path: string; text: string }
  | { type: 'op'; op: ChangeOp }
  | { type: 'warning'; message: string };

type BodyKind = 'write' | 'edit' | 'add-dependency';

type State =
  | { name: 'prose' }
  | { name: 'changes' }
  | { name: 'body'; kind: BodyKind; path: string; instruction: string; content: string };

const OPEN_CHANGES = '<changes>';
const CLOSE_TAG: Record<BodyKind, string> = {
  write: '</write>',
  edit: '</edit>',
  'add-dependency': '</add-dependency>',
};

/** Length of the longest suffix of `buf` that is a proper prefix of `token`. */
export function partialSuffix(buf: string, token: string): number {
  const max = Math.min(buf.length, token.length - 1);
  for (let k = max; k > 0; k--) {
    if (buf.endsWith(token.slice(0, k))) return k;
  }
  return 0;
}

const ENTITIES: Record<string, string> = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };

export function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const m of tag.matchAll(re)) {
    const raw = m[2] ?? m[3] ?? '';
    attrs[m[1]] = raw.replace(/&(quot|apos|lt|gt|amp);/g, (e) => ENTITIES[e]);
  }
  return attrs;
}

/** Strip the newline that follows the opening tag and normalise the file ending. */
function normaliseFileContent(content: string): string {
  const body = content.replace(/^\r?\n/, '').replace(/\r\n/g, '\n');
  return body.replace(/\s+$/, '') + '\n';
}

export class ChangesParser {
  private buf = '';
  private state: State = { name: 'prose' };
  private seenChanges = false;

  push(chunk: string): ParseEvent[] {
    this.buf += chunk;
    return this.drain(false);
  }

  /** Flush everything. Call once when the model stream ends. */
  end(): ParseEvent[] {
    return this.drain(true);
  }

  /** True once a <changes> block has opened. */
  get sawChanges(): boolean {
    return this.seenChanges;
  }

  private drain(final: boolean): ParseEvent[] {
    const out: ParseEvent[] = [];
    for (;;) {
      const s = this.state;

      if (s.name === 'prose') {
        const i = this.buf.indexOf(OPEN_CHANGES);
        const phase = this.seenChanges ? 'after' : 'before';
        if (i === -1) {
          const keep = final ? 0 : partialSuffix(this.buf, OPEN_CHANGES);
          const text = this.buf.slice(0, this.buf.length - keep);
          if (text) out.push({ type: 'text', text, phase });
          this.buf = this.buf.slice(this.buf.length - keep);
          return out;
        }
        const text = this.buf.slice(0, i);
        if (text) out.push({ type: 'text', text, phase });
        this.buf = this.buf.slice(i + OPEN_CHANGES.length);
        this.state = { name: 'changes' };
        this.seenChanges = true;
        continue;
      }

      if (s.name === 'changes') {
        const lt = this.buf.indexOf('<');
        if (lt === -1) {
          this.buf = ''; // whitespace (or stray prose) between tags is ignored
          if (final) out.push({ type: 'warning', message: 'The <changes> block was never closed.' });
          return out;
        }
        const gt = this.buf.indexOf('>', lt);
        if (gt === -1) {
          this.buf = this.buf.slice(lt);
          if (final) {
            out.push({ type: 'warning', message: `Unterminated tag discarded: ${this.buf.slice(0, 60)}` });
            this.buf = '';
          }
          return out;
        }
        const tag = this.buf.slice(lt, gt + 1);
        this.buf = this.buf.slice(gt + 1);
        this.handleTag(tag, out);
        continue;
      }

      // Inside a <write>, <edit> or <add-dependency> body.
      const close = CLOSE_TAG[s.kind];
      const i = this.buf.indexOf(close);
      if (i === -1) {
        const keep = final ? 0 : partialSuffix(this.buf, close);
        const text = this.buf.slice(0, this.buf.length - keep);
        this.appendBody(s, text, out);
        this.buf = this.buf.slice(this.buf.length - keep);
        if (final) {
          const what = s.kind === 'add-dependency' ? '<add-dependency>' : `<${s.kind}> for ${s.path}`;
          out.push({ type: 'warning', message: `${what} was cut off before it closed — discarded, nothing applied.` });
          this.state = { name: 'prose' };
        }
        return out;
      }
      this.appendBody(s, this.buf.slice(0, i), out);
      this.buf = this.buf.slice(i + close.length);
      this.finishBody(s, out);
      this.state = { name: 'changes' };
    }
  }

  private appendBody(s: Extract<State, { name: 'body' }>, text: string, out: ParseEvent[]) {
    if (!text) return;
    s.content += text;
    if (s.kind !== 'add-dependency' && s.path) out.push({ type: 'file-chunk', path: s.path, text });
  }

  private finishBody(s: Extract<State, { name: 'body' }>, out: ParseEvent[]) {
    if (s.kind === 'add-dependency') {
      const spec = s.content.trim();
      if (spec) out.push({ type: 'op', op: { type: 'add-dependency', spec } });
      else out.push({ type: 'warning', message: 'Empty <add-dependency> ignored.' });
      return;
    }
    if (!s.path) {
      out.push({ type: 'warning', message: `<${s.kind}> without a path attribute ignored.` });
      return;
    }
    if (s.kind === 'write') {
      out.push({ type: 'op', op: { type: 'write', path: s.path, content: normaliseFileContent(s.content) } });
    } else {
      out.push({
        type: 'op',
        op: { type: 'edit', path: s.path, instruction: s.instruction, body: s.content.replace(/^\r?\n/, '').replace(/\r\n/g, '\n') },
      });
    }
  }

  private handleTag(tag: string, out: ParseEvent[]) {
    const name = /^<\/?\s*([a-zA-Z-]+)/.exec(tag)?.[1]?.toLowerCase() ?? '';
    const attrs = parseAttributes(tag);

    if (tag.startsWith('</') && name === 'changes') {
      this.state = { name: 'prose' };
      return;
    }
    switch (name) {
      case 'write':
      case 'edit': {
        const path = (attrs.path ?? '').trim();
        this.state = { name: 'body', kind: name, path, instruction: attrs.instruction ?? '', content: '' };
        if (path) out.push({ type: 'file-start', kind: name, path });
        return;
      }
      case 'add-dependency':
        this.state = { name: 'body', kind: 'add-dependency', path: '', instruction: '', content: '' };
        return;
      case 'rename':
        if (attrs.from && attrs.to) out.push({ type: 'op', op: { type: 'rename', from: attrs.from.trim(), to: attrs.to.trim() } });
        else out.push({ type: 'warning', message: `<rename> needs from and to: ${tag}` });
        return;
      case 'delete':
        if (attrs.path) out.push({ type: 'op', op: { type: 'delete', path: attrs.path.trim() } });
        else out.push({ type: 'warning', message: `<delete> needs a path: ${tag}` });
        return;
      default:
        out.push({ type: 'warning', message: `Unknown tag inside <changes> ignored: ${tag.slice(0, 60)}` });
    }
  }
}
