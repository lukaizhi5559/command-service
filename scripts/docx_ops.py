#!/usr/bin/env python3
# docx_ops.py — deterministic .docx read/edit helper for edit.agent.
#
#   python3 docx_ops.py extract <in.docx>          → numbered paragraphs + tables on stdout
#   python3 docx_ops.py apply <in.docx> <out.docx> → reads {"ops":[...]} from stdin,
#                                                    writes edited copy to out.docx,
#                                                    prints {"applied":N,"missed":M,"missedOps":[...]}
#
# Ops (docx):
#   {"find": "<verbatim text>", "replace": "<new text>", "all": false}
#   {"append": "<new paragraph text>"}
#   {"para": N, "replace": "<new paragraph text>"}   — N = extract's [N] index
#   {"insert_after": N, "text": "<new paragraph>"}
#   {"delete_para": N}
#
# Find/replace works at paragraph level: the first paragraph whose .text
# contains `find` gets its runs rebuilt with the replacement. Matching tiers:
# exact → quote/dash/whitespace-normalized → whitespace-free. A `find`
# containing '\n' is matched segment-by-segment across consecutive paragraphs.
# Inline formatting inside an edited paragraph is flattened (single run) —
# acceptable because output is always a reviewable draft copy; originals are
# never written. With "all": true, every matching paragraph/cell is edited.
# Index ops are transcription-free addressing for whole-section rewrites.

import sys
import os
import re
import json
import shutil

import docx


def _normalize(s):
    # Port of edit.agent.cjs _normalizedIndexOf normalization: curly quotes →
    # straight, en/em dashes → '-', whitespace runs → single space.
    return re.sub(r'\s+', ' ', (s or '')
                  .replace('\u2018', "'").replace('\u2019', "'")
                  .replace('\u201C', '"').replace('\u201D', '"')
                  .replace('\u2013', '-').replace('\u2014', '-'))


def _match(text, needle, strip_all=False):
    # Returns (start, length) in the ORIGINAL text matching needle, or None.
    # Tiers: exact substring → quote/dash/whitespace normalized → (strip_all)
    # whitespace removed entirely, so "Exodus 2:1-3" matches "Exodus 2: 1-3".
    if not text or not needle:
        return None
    i = text.find(needle)
    if i >= 0:
        return (i, len(needle))
    norm_map = []  # norm index -> original index
    norm_chars = []
    prev_space = False
    for oi, ch in enumerate(text):
        nc = _normalize(ch)
        if not nc:
            continue
        if nc == ' ':
            if strip_all:
                continue
            if prev_space:
                continue
            prev_space = True
        else:
            prev_space = False
        norm_chars.append(nc)
        norm_map.append(oi)
    norm_text = ''.join(norm_chars)
    nn = _normalize(needle)
    norm_needle = re.sub(r'\s+', '', nn) if strip_all else nn.strip()
    if not norm_needle or not norm_text:
        return None
    ni = norm_text.find(norm_needle)
    if ni < 0:
        return None
    start = norm_map[ni]
    end = norm_map[ni + len(norm_needle) - 1] + 1
    return (start, end - start)


def _normalized_find(text, needle):
    return _match(text, needle, strip_all=False)


def _find_span(text, needle):
    # Strictest first: exact/normalized, then whitespace-free.
    return _normalized_find(text, needle) or _match(text, needle, strip_all=True)


def _set_para_text(p, text):
    # Rebuild the paragraph as a single run — flattens inline formatting
    # (bold/italic spans) inside the edited paragraph only. '\n' becomes a
    # real line break (w:br), not a new paragraph.
    for r in p.runs:
        r.text = ''
    run = p.runs[0] if p.runs else p.add_run()
    for i, part in enumerate(str(text).split('\n')):
        if i:
            run.add_break()
        if part:
            run.add_text(part)


def _iter_paragraphs(d):
    for p in d.paragraphs:
        yield p
    for tbl in d.tables:
        for row in tbl.rows:
            for cell in row.cells:
                for p in cell.paragraphs:
                    yield p


def extract(path):
    d = docx.Document(path)
    for i, p in enumerate(d.paragraphs):
        if p.text.strip():
            print(f"[{i}] {p.text}")
    for ti, tbl in enumerate(d.tables):
        for ri, row in enumerate(tbl.rows):
            cells = " | ".join(c.text for c in row.cells)
            if cells.strip():
                print(f"[T{ti}R{ri}] {cells}")


def _apply_multipara(d, find, repl):
    # find contains '\n' — match each segment (normalized) against consecutive
    # paragraphs and splice the replacement segments in pairwise. Extra
    # replacement lines merge into the last matched paragraph.
    fsegs = find.split('\n')
    if not fsegs or any(not s.strip() for s in fsegs):
        return False
    paras = list(d.paragraphs)
    for i in range(len(paras) - len(fsegs) + 1):
        spans = []
        ok = True
        for k, seg in enumerate(fsegs):
            sp = _find_span(paras[i + k].text, seg)
            if not sp:
                ok = False
                break
            spans.append(sp)
        if not ok:
            continue
        rsegs = repl.split('\n')
        for k, (s, ln) in enumerate(spans):
            p = paras[i + k]
            rep = rsegs[k] if k < len(rsegs) else ''
            if k == len(spans) - 1 and len(rsegs) > len(spans):
                rep = '\n'.join(rsegs[k:])
            _set_para_text(p, p.text[:s] + rep + p.text[s + ln:])
        return True
    return False


def _insert_para_after(d, paras, n, text):
    # Insert a new paragraph after index n (same numbering as extract's [N]).
    if n + 1 < len(paras):
        paras[n + 1].insert_paragraph_before(text)
    else:
        d.add_paragraph(text)


def apply_ops(src, dst):
    payload = json.load(sys.stdin)
    ops = payload.get('ops', [])[:40]
    # Converted drafts (rtf/doc) live at workPath — src==dst means apply in place.
    if os.path.realpath(src) != os.path.realpath(dst):
        shutil.copyfile(src, dst)
    d = docx.Document(dst)
    applied = 0
    missed_ops = []
    for oi, op in enumerate(ops):
        if not isinstance(op, dict):
            missed_ops.append(oi)
            continue
        paras = list(d.paragraphs)  # refreshed — indices match extract's [N]
        # ── Paragraph-indexed ops — no text to transcribe, exact addressing ──
        if 'insert_after' in op:
            n = op.get('insert_after')
            if not isinstance(n, int) or n < 0 or n >= len(paras):
                missed_ops.append(oi)
                continue
            _insert_para_after(d, paras, n, str(op.get('text', op.get('replace', ''))))
            applied += 1
            continue
        if 'para' in op or 'delete_para' in op:
            n = op.get('para', op.get('delete_para'))
            if not isinstance(n, int) or n < 0 or n >= len(paras):
                missed_ops.append(oi)
                continue
            if 'delete_para' in op:
                _set_para_text(paras[n], '')
            else:
                _set_para_text(paras[n], str(op.get('replace', op.get('text', ''))))
            applied += 1
            continue
        if 'append' in op:
            d.add_paragraph(str(op['append']))
            applied += 1
            continue
        find = str(op.get('find', ''))
        repl = str(op.get('replace', ''))
        if not find:
            missed_ops.append(oi)
            continue
        if '\n' in find:
            if _apply_multipara(d, find, repl):
                applied += 1
            else:
                missed_ops.append(oi)
            continue
        hit = False
        for p in _iter_paragraphs(d):
            # Exact/normalized match first; whitespace-free fallback so
            # "Exodus 2:1-3" matches stored "Exodus 2: 1-3".
            span = _find_span(p.text, find)
            if span is not None:
                s, ln = span
                _set_para_text(p, p.text[:s] + repl + p.text[s + ln:])
                applied += 1
                hit = True
                if not op.get('all'):
                    break
        if not hit:
            missed_ops.append(oi)
    d.save(dst)
    print(json.dumps({'applied': applied, 'missed': len(missed_ops),
                      'missedOps': missed_ops}))


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.stderr.write('usage: docx_ops.py extract <in.docx> | apply <in.docx> <out.docx>\n')
        sys.exit(2)
    cmd = sys.argv[1]
    if cmd == 'extract':
        extract(sys.argv[2])
    elif cmd == 'apply' and len(sys.argv) >= 4:
        apply_ops(sys.argv[2], sys.argv[3])
    else:
        sys.stderr.write('usage: docx_ops.py extract <in.docx> | apply <in.docx> <out.docx>\n')
        sys.exit(2)
