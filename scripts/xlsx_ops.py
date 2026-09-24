#!/usr/bin/env python3
# xlsx_ops.py — deterministic .xlsx read/edit helper for edit.agent.
#
#   python3 xlsx_ops.py extract <in.xlsx>          → sheets + used-range cells on stdout
#   python3 xlsx_ops.py apply <in.xlsx> <out.xlsx> → reads {"ops":[...]} from stdin,
#                                                    writes edited copy to out.xlsx,
#                                                    prints {"applied":N,"missed":M}
#
# Ops (xlsx):
#   {"sheet": "<name, optional — defaults to active>", "cell": "A1",
#    "value": <new value>}            — set cell value
#   {"cell": "B2", "number_format": "$#,##0.00"} — set number format
#   {"cell": "C3", "bold": true}      — bold on/off (also "italic")
#   value/format/bold/italic may be combined in one op.
#
# Output is always a copy — originals are never written by this script.

import sys
import json
import copy

import openpyxl

MAX_EXTRACT_ROWS = 200
MAX_EXTRACT_COLS = 40


def extract(path):
    wb = openpyxl.load_workbook(path)
    for ws in wb.worksheets:
        print(f"=== sheet: {ws.title} (dims {ws.dimensions}) ===")
        rows = list(ws.iter_rows(
            max_row=min(ws.max_row or 0, MAX_EXTRACT_ROWS),
            max_col=min(ws.max_column or 0, MAX_EXTRACT_COLS),
        ))
        for row in rows:
            vals = [
                f"{c.coordinate}={c.value}" if c.value is not None else ''
                for c in row
            ]
            line = ' | '.join(v for v in vals if v)
            if line:
                print(line)


def apply_ops(src, dst):
    payload = json.load(sys.stdin)
    ops = payload.get('ops', [])[:40]
    wb = openpyxl.load_workbook(src)
    applied = 0
    missed = 0
    for op in ops:
        if not isinstance(op, dict) or 'cell' not in op:
            missed += 1
            continue
        try:
            ws = wb[op['sheet']] if op.get('sheet') else wb.active
        except KeyError:
            missed += 1
            continue
        try:
            cell = ws[str(op['cell'])]
            if 'value' in op:
                cell.value = op['value']
            if 'number_format' in op:
                cell.number_format = str(op['number_format'])
            if 'bold' in op or 'italic' in op:
                f = copy.copy(cell.font)
                if 'bold' in op:
                    f.bold = bool(op['bold'])
                if 'italic' in op:
                    f.italic = bool(op['italic'])
                cell.font = f
            applied += 1
        except Exception:
            missed += 1
    wb.save(dst)
    print(json.dumps({'applied': applied, 'missed': missed}))


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.stderr.write('usage: xlsx_ops.py extract <in.xlsx> | apply <in.xlsx> <out.xlsx>\n')
        sys.exit(2)
    cmd = sys.argv[1]
    if cmd == 'extract':
        extract(sys.argv[2])
    elif cmd == 'apply' and len(sys.argv) >= 4:
        apply_ops(sys.argv[2], sys.argv[3])
    else:
        sys.stderr.write('usage: xlsx_ops.py extract <in.xlsx> | apply <in.xlsx> <out.xlsx>\n')
        sys.exit(2)
