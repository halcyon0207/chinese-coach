#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从教材 PDF 的识字表（课本 P122 起）解析二类字，按课分。

注意：PDF 里的拼音被字体编码打乱了（yWn 其实是 yán）。
这里把"字 + 原始拼音串"一起存下来，交给 gen_data.py 解码，
并和 pypinyin 的结果交叉校验 —— 两边一致才用，不一致以教材为准并记下来。
"""
import io
import json
import os
import re
import sys
from pypdf import PdfReader

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

PDF = r'C:\Users\JM\CodeBuddy\工作区\01_学习资料库\01_教材课本\四年级上册\语文·部编版.pdf'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'shizi.raw.json')

START, END = 127, 132
CJK = re.compile(r'^[\u4e00-\u9fff]$')
PINYIN = re.compile(r'^[A-Za-z]{1,7}$')          # 乱码拼音全是 ASCII 字母
LESSON = re.compile(r'^(\d{1,2})\s*(.*)$')

reader = PdfReader(PDF)
text = ''
for p in range(START, min(END, len(reader.pages)) + 1):
    text += (reader.pages[p - 1].extract_text() or '') + '\n'

lesson = None
pending = None
result = []
seen = set()

def add(char, raw):
    if not char:
        return
    if not result or result[-1]['no'] != lesson:
        result.append({'no': lesson, 'chars': []})
    if char not in seen:
        seen.add(char)
        result[-1]['chars'].append({'c': char, 'raw': raw})
    else:
        result[-1]['chars'].append({'c': char, 'raw': raw})   # 多课出现的也各留一条

for raw_line in text.split('\n'):
    s = raw_line.strip()
    if not s:
        continue
    plain = s.replace(' ', '')
    if '识字表' in plain:
        continue                                    # 表头
    if plain.startswith('语文园地'):
        lesson = 0
        rest = s[len('语文园地'):].strip()
        pending = rest if CJK.match(rest) else None
        continue
    m = LESSON.match(s)
    if m and int(m.group(1)) <= 27 and not CJK.match(s):
        lesson = int(m.group(1))
        rest = m.group(2).strip()
        pending = rest if CJK.match(rest) else None
        continue
    if CJK.match(s):
        pending = s
        continue
    if PINYIN.match(s) and pending:
        add(pending, s)
        pending = None

with open(OUT, 'w', encoding='utf-8') as f:
    json.dump({'book': '部编版语文四年级上册 识字表（二类字，课本 P122—124）',
               'lessons': result}, f, ensure_ascii=False, indent=2)

n = sum(len(r['chars']) for r in result)
for r in result:
    print('课%s: %d 字' % (r['no'] or '园地', len(r['chars'])))
print('共 %d 个二类字（含跨课重复）' % n)
