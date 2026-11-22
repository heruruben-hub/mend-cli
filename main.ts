// main.ts is mend, the CLI SPEC.md specifies (the kit's starting point for it was MIT). It does all of SPEC.md:
// the command line, the output and exit codes, safe paths and format detection (sections 1 to 4), matching lines
// at three tiers (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches
// (section 8), JSON edits (section 9) and the all-or-nothing write (section 10). Node 22, the standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves the edits made: new path -> old path, for the `R` output row (SPEC.md section 2). */
  readonly moves = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------- files as lines (SPEC.md section 3) ---------- */

interface FileModel {
  lines: string[];
  /** The file's own line break. */
  br: string;
  /** It ends with a line break. */
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/* ---------- matching lines at three tiers (SPEC.md section 5) ---------- */

/** The highest tier tried: 2, or 0 with --strict. Set by run() before a patch is read. */
let maxTier = 2;

const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstrip(a) === rstrip(b);
  return trimWs(a) === trimWs(b);
}

/** Every start position at or after `from` where O occurs in lines at the given tier. */
function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      if (!tierEq(lines[i + k]!, O[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions; null when it occurs at no tier. */
function findTier(lines: string[], O: string[], from: number): { tier: number; at: number[] } | null {
  for (let tier = 0; tier <= maxTier; tier += 1) {
    const at = occurrences(lines, O, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/**
 * The lines N becomes when it replaces the file lines matched at `pos`: a context line (ctxO[k] is its
 * index in O) is written as the file's own matched line, and at tier 2 every other line is re-indented
 * from O's first line's leading whitespace P to the file's first matched line's F (SPEC.md section 5).
 */
function buildN(fileLines: string[], pos: number, O: string[], N: string[], ctxO: (number | null)[], tier: number): string[] {
  const F = leadWs(fileLines[pos] ?? '');
  const P = leadWs(O[0] ?? '');
  return N.map((line, k) => {
    const oi = ctxO[k];
    if (oi !== null && oi !== undefined) return fileLines[pos + oi]!;
    if (tier === 2 && trimWs(line) !== '' && (P === '' || line.startsWith(P))) return F + line.slice(P.length);
    return line;
  });
}

/* ---------- unified diffs (SPEC.md section 6) ---------- */

interface UBodyLine {
  kind: 'ctx' | 'old' | 'new' | 'eol';
  text: string;
  /** The patch line was completely empty (an empty context line, or a separator after the body). */
  rawBlank: boolean;
}

interface UHunk {
  a: number;
  body: UBodyLine[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  oldNull: boolean;
  newNull: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

function newUSection(): USection {
  return { gitOld: null, gitNew: null, oldPath: null, newPath: null, oldNull: false, newNull: false, renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] };
}

/** A --- or +++ line's path: after the four characters, up to the first tab, spaces removed, a/ or b/ stripped. */
function headerPath(line: string): { path: string | null; isNull: boolean } {
  let raw = line.slice(4);
  const tab = raw.indexOf('\t');
  if (tab >= 0) raw = raw.slice(0, tab);
  raw = raw.trim();
  if (raw === '/dev/null') return { path: null, isNull: true };
  if (raw.startsWith('a/') || raw.startsWith('b/')) raw = raw.slice(2);
  return { path: raw, isNull: false };
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const isPairStart = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      if (!line.startsWith('diff --git ')) throw new Exit2(`error: parse ${i + 1}`);
      const rest = line.slice(11);
      const bi = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
      if (bi < 0 || bi === 2 || bi + 3 >= rest.length) throw new Exit2(`error: parse ${i + 1}`);
      cur = newUSection();
      cur.gitOld = rest.slice(2, bi);
      cur.gitNew = rest.slice(bi + 3);
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (isPairStart(i)) {
      if (cur === null || !inHeader) {
        cur = newUSection();
        sections.push(cur);
        inHeader = true;
      }
      const o = headerPath(lines[i]!);
      const n = headerPath(lines[i + 1]!);
      cur.oldPath = o.path;
      cur.oldNull = o.isNull;
      cur.newPath = n.path;
      cur.newNull = n.isNull;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      // A --- line not followed by a +++ line, inside a section's header, is a parse fault; elsewhere ignored.
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const hunk: UHunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ') || isPairStart(i)) break;
        const c = bl[0];
        if (c === ' ') hunk.body.push({ kind: 'ctx', text: bl.slice(1), rawBlank: bl.length === 1 });
        else if (c === '-') hunk.body.push({ kind: 'old', text: bl.slice(1), rawBlank: false });
        else if (c === '+') hunk.body.push({ kind: 'new', text: bl.slice(1), rawBlank: false });
        else if (c === '\\') hunk.body.push({ kind: 'eol', text: '', rawBlank: false });
        else if (bl === '') hunk.body.push({ kind: 'ctx', text: '', rawBlank: true });
        else break;
        i += 1;
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.rawBlank) hunk.body.pop();
        else break;
      }
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      // index, mode, similarity and any other header line are ignored.
      i += 1;
      continue;
    }
    // Outside bodies and headers, lines are ignored (prose, code fences).
    i += 1;
  }
  return sections.map(unifiedSectionEdit);
}

/** A section's hunks applied in order to a file's text; a hunk's failure is the section's. */
function applyHunks(before: string, hunks: UHunk[], path: string): string {
  const model = splitFile(before);
  let lines = model.lines;
  let final = model.final;
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: string[] = [];
    const ctxO: (number | null)[] = [];
    for (const b of h.body) {
      if (b.kind === 'ctx') {
        O.push(b.text);
        N.push(b.text);
        ctxO.push(O.length - 1);
      } else if (b.kind === 'old') O.push(b.text);
      else if (b.kind === 'new') {
        N.push(b.text);
        ctxO.push(null);
      }
    }
    // A `\` line after the hunk's last context or + line takes the result's final line break away.
    let lastN = -1;
    h.body.forEach((b, k) => {
      if (b.kind === 'ctx' || b.kind === 'new') lastN = k;
    });
    const noBreak = lastN >= 0 && h.body[lastN + 1]?.kind === 'eol';
    if (O.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const atEnd = at === lines.length;
      lines = [...lines.slice(0, at), ...N, ...lines.slice(at)];
      if (atEnd) final = !noBreak;
      d += N.length;
      continue;
    }
    const found = findTier(lines, O, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.at[0]!;
    for (const p of found.at) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    const written = buildN(lines, pos, O, N, ctxO, found.tier);
    const toEnd = pos + O.length === lines.length;
    lines = [...lines.slice(0, pos), ...written, ...lines.slice(pos + O.length)];
    if (toEnd) final = !noBreak;
    d += N.length - O.length;
  }
  return joinFile({ lines, br: model.br, final });
}

function unifiedSectionEdit(s: USection): Edit {
  const oldP = s.oldPath ?? s.renameFrom ?? s.gitOld;
  const newP = s.newPath ?? s.renameTo ?? s.gitNew;
  const creation = s.oldNull || s.newFile;
  const deletion = s.newNull || s.delFile;
  return (tree) => {
    if (creation) {
      const p = newP ?? oldP;
      if (p === null) throw new Fail('missing', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const content: string[] = [];
      let lastPlus = -1;
      let flat = 0;
      let noBreak = false;
      for (const h of s.hunks) {
        for (const b of h.body) {
          if (b.kind === 'new') {
            content.push(b.text);
            lastPlus = flat;
            noBreak = false;
          } else if (b.kind === 'eol' && flat === lastPlus + 1) noBreak = true;
          flat += 1;
        }
      }
      tree.now.set(p, content.length === 0 ? '' : content.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (deletion) {
      const p = oldP ?? newP;
      if (p === null) throw new Fail('missing', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      // A move: the hunks apply to the old file and the result is written at the new path.
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.now.set(newP, applyHunks(before, s.hunks, oldP));
      tree.now.set(oldP, null);
      tree.moves.set(newP, oldP);
      return;
    }
    const p = newP ?? oldP;
    if (p === null) throw new Fail('missing', '');
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, s.hunks, p));
  };
}

/* ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ---------- */

function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (rstrip(lines[i]!) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (rstrip(lines[j]!) === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rp = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (rstrip(lines[j]!) === '>>>>>>> REPLACE') {
        rp = j;
        break;
      }
    }
    if (rp < 0) throw new Exit2(`error: parse ${searchLine}`);
    // The path is the nearest line before the SEARCH line, after the previous block, that is not blank
    // and does not start with three backticks; with none, the block takes the previous block's path.
    let path: string | null = null;
    for (let j = i - 1; j >= searchFrom; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    prevPath = path;
    edits.push(searchReplaceEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rp)));
    searchFrom = rp + 1;
    i = rp + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      // An empty SEARCH part creates the file with the new lines.
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = splitFile(before);
    const found = findTier(model.lines, oldLines, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const pos = found.at[0]!;
    const written = buildN(model.lines, pos, oldLines, newLines, newLines.map(() => null), found.tier);
    const lines = [...model.lines.slice(0, pos), ...written, ...model.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile({ lines, br: model.br, final: model.final }));
  };
}

/* ---------- V4A patches (SPEC.md section 8) ---------- */

interface VBodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** The patch line was completely empty (an empty context line, or a separator after the section). */
  rawBlank: boolean;
}

interface VChunk {
  anchor: string | null;
  body: VBodyLine[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  line: number;
  moveTo: string | null;
  addLines: { text: string; rawBlank: boolean }[];
  chunks: VChunk[];
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let chunk: VChunk | null = null;
  // Blank lines at the end of a chunk or section are not part of it.
  const closeChunk = (): void => {
    if (chunk === null) return;
    while (chunk.body.length > 0) {
      const last = chunk.body[chunk.body.length - 1]!;
      if (last.kind === 'ctx' && last.rawBlank) chunk.body.pop();
      else break;
    }
    chunk = null;
  };
  const endSection = (): void => {
    if (cur === null) return;
    closeChunk();
    if (cur.kind === 'add') {
      while (cur.addLines.length > 0 && cur.addLines[cur.addLines.length - 1]!.rawBlank) cur.addLines.pop();
    }
    sections.push(cur);
    cur = null;
  };
  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    const no = i + 1;
    if (line.startsWith('*** Add File: ')) {
      endSection();
      cur = { kind: 'add', path: line.slice(14).trim(), line: no, moveTo: null, addLines: [], chunks: [] };
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      endSection();
      cur = { kind: 'del', path: line.slice(17).trim(), line: no, moveTo: null, addLines: [], chunks: [] };
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      endSection();
      cur = { kind: 'upd', path: line.slice(17).trim(), line: no, moveTo: null, addLines: [], chunks: [] };
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${no}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) cur.addLines.push({ text: line.slice(1), rawBlank: false });
      else if (line === '') cur.addLines.push({ text: '', rawBlank: true });
      else throw new Exit2(`error: parse ${no}`);
      continue;
    }
    if (cur.kind === 'del') throw new Exit2(`error: parse ${no}`);
    // An Update File section: an optional Move to first, then chunks.
    if (line === '*** End of File') {
      if (chunk !== null) chunk.eof = true;
      continue;
    }
    if (line.startsWith('*** Move to: ')) {
      if (cur.chunks.length === 0 && chunk === null && cur.moveTo === null) {
        cur.moveTo = line.slice(13).trim();
        continue;
      }
      throw new Exit2(`error: parse ${no}`);
    }
    if (line.startsWith('@@')) {
      closeChunk();
      chunk = { anchor: line.slice(2).trim() || null, body: [], eof: false };
      cur.chunks.push(chunk);
      continue;
    }
    const c = line[0];
    if (c === ' ' || c === '-' || c === '+' || line === '') {
      if (chunk === null) {
        chunk = { anchor: null, body: [], eof: false };
        cur.chunks.push(chunk);
      }
      if (line === '') chunk.body.push({ kind: 'ctx', text: '', rawBlank: true });
      else chunk.body.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', text: line.slice(1), rawBlank: c === ' ' && line.length === 1 });
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  endSection();
  for (const s of sections) {
    if (s.kind === 'upd' && s.chunks.length === 0 && s.moveTo === null) throw new Exit2(`error: parse ${s.line}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map(v4aSectionEdit);
}

function v4aSectionEdit(s: VSection): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      const content = s.addLines.map((l) => l.text);
      tree.now.set(s.path, content.length === 0 ? '' : `${content.join('\n')}\n`);
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const model = splitFile(before);
    let lines = model.lines;
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const foundAnchor = findTier(lines, [ch.anchor], cursor);
        if (foundAnchor === null) throw new Fail('no-match', s.path);
        cursor = foundAnchor.at[0]! + 1;
      }
      const O: string[] = [];
      const N: string[] = [];
      const ctxO: (number | null)[] = [];
      for (const b of ch.body) {
        if (b.kind === 'ctx') {
          O.push(b.text);
          N.push(b.text);
          ctxO.push(O.length - 1);
        } else if (b.kind === 'old') O.push(b.text);
        else {
          N.push(b.text);
          ctxO.push(null);
        }
      }
      if (O.length === 0) {
        const at = ch.eof ? lines.length : Math.min(cursor, lines.length);
        lines = [...lines.slice(0, at), ...N, ...lines.slice(at)];
        cursor = at + N.length;
        continue;
      }
      const found = findTier(lines, O, cursor);
      if (found === null) throw new Fail('no-match', s.path);
      let pos = -1;
      for (const p of found.at) {
        if (ch.eof && p + O.length !== lines.length) continue;
        pos = p;
        break;
      }
      if (pos < 0) throw new Fail('no-match', s.path);
      const written = buildN(lines, pos, O, N, ctxO, found.tier);
      lines = [...lines.slice(0, pos), ...written, ...lines.slice(pos + O.length)];
      cursor = pos + written.length;
    }
    const out = joinFile({ lines, br: model.br, final: model.final });
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, out);
      tree.now.set(s.path, null);
      tree.moves.set(s.moveTo, s.path);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  maxTier = strict ? 0 : 2;
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines)
            : v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move that succeeded (old path gone, new path created by it) is one R row sorted by the new path,
  // replacing that pair's D and A rows (SPEC.md section 2).
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();
  for (const [np, op] of tree.moves) {
    if (tree.original(op) !== null && tree.now.get(op) === null && tree.original(np) === null && tree.now.get(np) !== null) {
      movedFrom.add(op);
      movedTo.add(np);
    }
  }
  const rows: { key: string; line: string; path: string; now: string | null }[] = [];
  for (const np of movedTo) rows.push({ key: np, line: `R ${tree.moves.get(np)!} -> ${np}`, path: np, now: tree.now.get(np)! });
  for (const p of tree.now.keys()) {
    if (movedFrom.has(p) || movedTo.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, path: p, now });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out: string[] = [];
  for (const r of rows) {
    out.push(r.line);
    if (check) continue;
    if (r.now === null) rmSync(r.path, { force: true });
    else {
      mkdirSync(dirname(r.path), { recursive: true });
      writeFileSync(r.path, r.now);
    }
  }
  if (!check) for (const op of movedFrom) rmSync(op, { force: true });
  return { code: 0, out: [...out, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
