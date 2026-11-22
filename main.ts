// mend: one patch tool for every AI edit format (SPEC.md version 1).
//
// Run as `node main.ts [options] [PATCH]` with the working directory as the
// root of a tree of text files. It reads a patch in one of four formats
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines an
// edit names at the first of three matching tiers, and writes every change or
// none. Node 22, the standard library alone.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below).

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

/** A file split into lines: its break, its lines, and whether it ends with one. */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** Line equality at one matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

/** Every position where O occurs in lines at one tier, from `from` on. */
function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier (0, 1, 2, or only 0 with --strict) at which O occurs at or
 * after `from`, and every occurrence there. With `endOnly` only occurrences
 * ending at the file's last line count.
 */
function findFirstTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from: number,
  endOnly: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let pos = occurrencesAt(lines, o, t, from);
    if (endOnly) pos = pos.filter((p) => p + o.length === lines.length);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

type BodyLine = { kind: 'ctx' | 'old' | 'new'; text: string };

/** A hunk or chunk body, as raw patch lines, split into context/old/new lines. */
function parseBody(raw: string[]): BodyLine[] {
  const out: BodyLine[] = [];
  for (const l of raw) {
    if (l.startsWith('\\')) continue;
    if (l === '') out.push({ kind: 'ctx', text: '' });
    else if (l[0] === ' ') out.push({ kind: 'ctx', text: l.slice(1) });
    else if (l[0] === '-') out.push({ kind: 'old', text: l.slice(1) });
    else if (l[0] === '+') out.push({ kind: 'new', text: l.slice(1) });
  }
  return out;
}

/**
 * Replace O (the context and old lines of `body`) at `pos` by N (its context
 * and new lines). A context line is written as the file's own matched line;
 * at tier 2 every other new line is re-indented from O's first line to the
 * file's first matched line (SPEC.md section 5).
 */
function applyBody(fileLines: string[], pos: number, body: BodyLine[], tier: number): string[] {
  const o = body.filter((b) => b.kind !== 'new').map((b) => b.text);
  let f = '';
  let p = '';
  if (o.length > 0) {
    f = leadingST(fileLines[pos] ?? '');
    p = leadingST(o[0]!);
  }
  const out: string[] = [];
  let j = 0;
  for (const b of body) {
    if (b.kind === 'ctx') {
      out.push(fileLines[pos + j]!);
      j++;
    } else if (b.kind === 'old') {
      j++;
    } else {
      let t = b.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return [...fileLines.slice(0, pos), ...out, ...fileLines.slice(pos + o.length)];
}

/**
 * The tree as the edits leave it: changed paths in `now` (null: deleted),
 * the rest read from disk. `origin` remembers, for a path that holds a file
 * moved here by an edit, the path that file had before the patch, so a
 * successful move prints as one `R old -> new` line.
 */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly origin = new Map<string, string>();
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
  setCreate(p: string, text: string): void {
    this.now.set(p, text);
    this.origin.delete(p);
  }
  setDelete(p: string): void {
    this.now.set(p, null);
    this.origin.delete(p);
  }
  setModify(p: string, text: string): void {
    this.now.set(p, text);
  }
  setMove(oldP: string, newP: string, text: string): void {
    const o = this.origin.get(oldP) ?? oldP;
    this.now.set(oldP, null);
    this.now.set(newP, text);
    this.origin.delete(oldP);
    this.origin.set(newP, o);
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
      tree.setCreate(p, text);
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
      tree.setModify(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const lines = f.lines.slice();
      lines.splice(line, 0, ...add);
      tree.setModify(p, joinFile({ br: f.br, lines, final: f.final }));
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

/** Unified diffs (SPEC.md section 6). */

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameOld: string | null;
  renameNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a `--- ` or `+++ ` line names, or null for `/dev/null`. */
function diffPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/')) rest = rest.slice(2);
  else if (rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function isDiffGit(l: string): boolean {
  return l === 'diff --git' || l.startsWith('diff --git ');
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(body: string[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l === '' || l[0] === ' ' || l[0] === '+') last = k;
  }
  if (last < 0) return false;
  const next = body[last + 1];
  return next !== undefined && next[0] === '\\';
}

/**
 * Apply a section's hunks in order to a file's lines. `d` is the running
 * length delta of the hunks applied so far; each hunk takes the occurrence
 * nearest to A - 1 + d, the earlier of two equally near.
 */
function applyHunks(f: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let lines = f.lines.slice();
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const body = parseBody(h.body);
    const o = body.filter((b) => b.kind !== 'new').map((b) => b.text);
    const n = body.filter((b) => b.kind !== 'old').map((b) => b.text);
    if (o.length === 0) {
      const idx = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = idx === lines.length;
      const built = body.filter((b) => b.kind === 'new').map((b) => b.text);
      lines = [...lines.slice(0, idx), ...built, ...lines.slice(idx)];
      if (atEnd) final = !hunkNoEol(h.body);
    } else {
      const found = findFirstTier(lines, o, strict, 0, false);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.positions[0]!;
      let best = Math.abs(pos - target);
      for (const q of found.positions) {
        const dist = Math.abs(q - target);
        if (dist < best) {
          pos = q;
          best = dist;
        }
      }
      const runsToEnd = pos + o.length === lines.length;
      lines = applyBody(lines, pos, body, found.tier);
      if (runsToEnd) final = !hunkNoEol(h.body);
    }
    d += n.length - o.length;
  }
  return { br: f.br, lines, final };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (isDiffGit(l)) {
      const m = DIFF_GIT_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        diffOld: m[1]!,
        diffNew: m[2]!,
        pairOld: null,
        pairNew: null,
        hasPair: false,
        renameOld: null,
        renameNew: null,
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      sections.push(cur);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0) {
        cur.pairOld = diffPath(l);
        cur.pairNew = diffPath(lines[i + 1]!);
        cur.hasPair = true;
      } else {
        cur = {
          diffOld: null,
          diffNew: null,
          pairOld: diffPath(l),
          pairNew: diffPath(lines[i + 1]!),
          hasPair: true,
          renameOld: null,
          renameNew: null,
          isCreate: false,
          isDelete: false,
          hunks: [],
        };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (isDiffGit(b)) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          hunk.body.push(b);
          i++;
        } else break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('new file mode')) cur.isCreate = true;
      else if (l.startsWith('deleted file mode')) cur.isDelete = true;
      else if (l.startsWith('rename from ')) cur.renameOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice('rename to '.length).trim();
    }
    i++;
  }
  return sections.map((sec) => {
    const oldPath = sec.hasPair ? sec.pairOld : sec.renameOld ?? sec.diffOld;
    const newPath = sec.hasPair ? sec.pairNew : sec.renameNew ?? sec.diffNew;
    if (sec.isCreate || oldPath === null) {
      const np = newPath ?? '';
      return (tree: Tree) => {
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const added: string[] = [];
        let lastPlus: { h: number; k: number } | null = null;
        sec.hunks.forEach((h, hi) => {
          h.body.forEach((b, bi) => {
            if (b[0] === '+') {
              added.push(b.slice(1));
              lastPlus = { h: hi, k: bi };
            }
          });
        });
        let final = true;
        if (lastPlus !== null) {
          const h = sec.hunks[lastPlus.h]!;
          const next = h.body[lastPlus.k + 1];
          if (next !== undefined && next[0] === '\\') final = false;
        }
        tree.setCreate(np, added.length === 0 ? '' : added.join('\n') + (final ? '\n' : ''));
      };
    }
    if (sec.isDelete || newPath === null) {
      const op = oldPath ?? '';
      return (tree: Tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.setDelete(op);
      };
    }
    if (oldPath !== newPath) {
      const op = oldPath ?? '';
      const np = newPath ?? '';
      return (tree: Tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(op) === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const res = applyHunks(splitFile(tree.get(op)!), sec.hunks, strict, op);
        tree.setMove(op, np, joinFile(res));
      };
    }
    const op = oldPath ?? '';
    return (tree: Tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      const res = applyHunks(splitFile(tree.get(op)!), sec.hunks, strict, op);
      tree.setModify(op, joinFile(res));
    };
  });
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */

interface SearchBlock {
  path: string;
  old: string[];
  nw: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SearchBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, old: lines.slice(s + 1, eq), nw: lines.slice(eq + 1, rep) });
    prevEnd = rep;
    prevPath = path;
    i = rep + 1;
  }
  return blocks.map((b) => {
    if (b.old.length === 0) {
      return (tree: Tree) => {
        if (!safe(b.path)) throw new Fail('unsafe', b.path);
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.setCreate(b.path, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      };
    }
    return (tree: Tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      const cur = tree.get(b.path);
      if (cur === null) throw new Fail('missing', b.path);
      const f = splitFile(cur);
      const found = findFirstTier(f.lines, b.old, strict, 0, false);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
      const body: BodyLine[] = [
        ...b.old.map((t): BodyLine => ({ kind: 'old', text: t })),
        ...b.nw.map((t): BodyLine => ({ kind: 'new', text: t })),
      ];
      const out = applyBody(f.lines, found.positions[0]!, body, found.tier);
      tree.setModify(b.path, joinFile({ br: f.br, lines: out, final: f.final }));
    };
  });
}

/** V4A patches (SPEC.md section 8). */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (!isSectionStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) j++;
    const raw = lines.slice(i + 1, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    const rawNo = (k: number): number => i + 1 + k + 1;
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      for (let k = 0; k < raw.length; k++) {
        const rl = raw[k]!;
        if (rl !== '' && rl[0] !== '+') throw new Exit2(`error: parse ${rawNo(k)}`);
      }
      const fileLines = raw.map((rl) => (rl === '' ? '' : rl.slice(1)));
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.setCreate(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      for (let k = 0; k < raw.length; k++) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${rawNo(k)}`);
      }
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.setDelete(p);
      });
    } else {
      const p = l.slice('*** Update File: '.length).trim();
      const updateLineNo = i + 1;
      let k = 0;
      let moveTo: string | null = null;
      if (k < raw.length && raw[k]!.startsWith('*** Move to: ')) {
        moveTo = raw[k]!.slice('*** Move to: '.length).trim();
        k++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      while (k < raw.length) {
        const rl = raw[k]!;
        if (rl.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = rl.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          k++;
        } else if (rl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${rawNo(k)}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          k++;
        } else if (rl === '' || rl[0] === ' ' || rl[0] === '-' || rl[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${rawNo(k)}`);
            cur = { anchor: null, eof: false, body: [] };
          }
          cur.body.push(rl);
          k++;
        } else {
          throw new Exit2(`error: parse ${rawNo(k)}`);
        }
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (moveTo !== null) {
          if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
          if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        }
        let f = splitFile(before);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const found = findFirstTier(f.lines, [ch.anchor], strict, cursor, false);
            if (found === null) throw new Fail('no-match', p);
            cursor = found.positions[0]! + 1;
          }
          const body = parseBody(ch.body);
          const o = body.filter((b) => b.kind !== 'new').map((b) => b.text);
          if (o.length === 0) {
            const n = body.filter((b) => b.kind === 'new').map((b) => b.text);
            const idx = ch.eof ? f.lines.length : cursor;
            f = { br: f.br, lines: [...f.lines.slice(0, idx), ...n, ...f.lines.slice(idx)], final: f.final };
            cursor = idx + n.length;
          } else {
            const found = findFirstTier(f.lines, o, strict, cursor, ch.eof);
            if (found === null) throw new Fail('no-match', p);
            const pos = found.positions[0]!;
            const out = applyBody(f.lines, pos, body, found.tier);
            cursor = pos + (out.length - f.lines.length + o.length);
            f = { br: f.br, lines: out, final: f.final };
          }
        }
        const text = joinFile(f);
        if (moveTo !== null) tree.setMove(p, moveTo, text);
        else tree.setModify(p, text);
      });
    }
    i = j;
  }
  return edits;
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
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeOrigin = new Map(tree.origin);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.origin.clear();
      for (const [k, v] of beforeOrigin) tree.origin.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [newP, oldP] of [...tree.origin.entries()]) {
    if (oldP === newP) continue;
    if (tree.original(oldP) === null) continue;
    if (tree.original(newP) !== null) continue;
    if (tree.get(oldP) !== null) continue;
    if (tree.get(newP) === null) continue;
    const di = rows.findIndex((r) => r.line === `D ${oldP}`);
    const ai = rows.findIndex((r) => r.line === `A ${newP}`);
    if (di < 0 || ai < 0) continue;
    rows.splice(di, 1);
    const aj = rows.findIndex((r) => r.line === `A ${newP}`);
    if (aj >= 0) rows.splice(aj, 1);
    rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
