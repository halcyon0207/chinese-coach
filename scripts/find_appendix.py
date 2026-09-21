#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时脚本：从教材 PDF 里找识字表 / 写字表 / 词语表所在的页，并把文本抽出来。"""
import io
import sys
from pypdf import PdfReader

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

PDF = r'C:\Users\JM\CodeBuddy\工作区\01_学习资料库\01_教材课本\四年级上册\语文·部编版.pdf'
OUT = r'C:\Users\JM\CodeBuddy\工作区\09_语文小教练\data\appendix.txt'

reader = PdfReader(PDF)
hits = []
for i in range(len(reader.pages)):
    t = reader.pages[i].extract_text() or ''
    for kw in ('识字表', '写字表', '词语表'):
        if kw in t.replace(' ', ''):
            hits.append((i + 1, kw))

print('命中页码:', hits)

with open(OUT, 'w', encoding='utf-8') as f:
    pages = sorted({p for p, _ in hits})
    for p in pages:
        f.write('\n===== PDF 第 %d 页 =====\n' % p)
        f.write(reader.pages[p - 1].extract_text() or '')
print('已写出:', OUT)
