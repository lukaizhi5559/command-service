#!/usr/bin/env python3
# pdf_extract.py — extract text from a PDF via pypdf.
#   python3 pdf_extract.py <in.pdf>  → extracted text on stdout
import sys
from pypdf import PdfReader

def main(path):
    reader = PdfReader(path)
    for i, page in enumerate(reader.pages, 1):
        text = page.extract_text() or ''
        print(f'--- page {i} ---')
        print(text)

if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.stderr.write('usage: pdf_extract.py <in.pdf>\n')
        sys.exit(2)
    main(sys.argv[1])
