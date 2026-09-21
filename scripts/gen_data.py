#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 js/data.js —— 给每个字、每个词补上拼音。

为什么要有这一步：
  教材书后的写字表、词语表只有汉字，没有拼音，而"看拼音写词语"必须有拼音。
  手打 250 字 + 220 词的拼音既慢又容易标错声调，所以交给 pypinyin 生成，
  生成完写死进 js/data.js —— 运行时不依赖任何库，页面仍然是纯前端。

用法：
  pip install pypinyin
  python scripts/gen_data.py
"""
import json
import os
from pypinyin import pinyin, Style

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data', 'words.raw.json')
SHIZI = os.path.join(ROOT, 'data', 'shizi.raw.json')
ZUCI = os.path.join(ROOT, 'data', 'zuci.raw.json')
OUT = os.path.join(ROOT, 'js', 'data.js')

# 教材里明确标注的多音字读法，优先于 pypinyin 的默认读音。
# key 是"词语"，value 是这个词里那个字的读音（只在能确定的情况下才写）。
OVERRIDE = {
    '暖和': ['nuǎn', 'huo'],
    '的确': ['dí', 'què'],
    '似的': ['shì', 'de'],
    '一溜烟': ['yī', 'liù', 'yān'],
    '便宜': ['pián', 'yi'],
}

# 教材 PDF 里拼音字体的字形映射（ā 被存成了 Q 之类）。
# 反推依据：盐 yán→yWn、鼎 dǐng→dJng、余 yú→yP、吼 hǒu→hGu 等几十个样本。
# 不在表里的字母解不出来，那个字就退回 pypinyin 的读音并记进"需核对"清单。
GLYPH = {
    'Q': 'ā', 'W': 'á', 'E': 'ē', 'R': 'é', 'T': 'ō', 'Y': 'ó',
    'U': 'ī', 'I': 'í', 'O': 'ǒ', 'P': 'ú',
    'A': 'ǎ', 'S': 'à', 'D': 'ě', 'F': 'è', 'G': 'ǒ', 'H': 'ò',
    'J': 'ǐ', 'K': 'ì', 'L': 'ǔ', 'M': 'ù',
}


def decode_pdf_py(raw):
    """把 PDF 里的乱码拼音还原成正常拼音；解不出就返回 None。"""
    out = []
    for ch in raw:
        if ch.isupper():
            v = GLYPH.get(ch)
            if not v:
                return None
            out.append(v)
        else:
            out.append(ch)
    return ''.join(out)

def py_of(text):
    """返回带声调的拼音音节列表。"""
    return [s[0] for s in pinyin(text, style=Style.TONE, heteronym=False)]


def main():
    with open(SRC, encoding='utf-8') as f:
        raw = json.load(f)
    with open(SHIZI, encoding='utf-8') as f:
        shizi_raw = json.load(f)
    with open(ZUCI, encoding='utf-8') as f:
        zuci_map = json.load(f)

    # 识字表（二类字）：字来自教材 PDF；拼音先用 pypinyin，
    # 再和 PDF 里自带的拼音交叉校验 —— 不一致的以教材为准，并记下来给家长核对。
    # 注意：四个「语文园地」在原始数据里都用 no:0，不能用 no 当字典键（会互相覆盖），
    # 所以园地单独按出现顺序放到 shizi_gardens 列表里，下面再按顺序对应到各单元园地课。
    shizi_by_no = {}
    shizi_gardens = []
    conflicts = []
    for ln in shizi_raw['lessons']:
        items = []
        for it in ln['chars']:
            c, raw_py = it['c'], it['raw']
            mine = py_of(c)[0]
            pdf = decode_pdf_py(raw_py)
            if pdf and pdf != mine:
                conflicts.append('%s: pypinyin=%s 教材=%s' % (c, mine, pdf))
            items.append({'c': c, 'p': pdf or mine, 'zuci': zuci_map.get(c, [])})
        if ln.get('no') == 0:
            shizi_gardens.append(items)
        else:
            shizi_by_no[ln['no']] = items

    units = []
    total_chars = 0
    total_words = 0
    total_shizi = 0
    garden_idx = 0

    for u in raw['units']:
        lessons = []
        for ln in u.get('lessons', []):
            chars = [{'c': c, 'p': py_of(c)[0]} for c in ln.get('chars', [])]

            words = []
            for w in ln.get('words', []):
                syl = OVERRIDE[w] if w in OVERRIDE else py_of(w)
                words.append({'w': w, 'p': syl})

            # 二类字：识字表里的认读字，只要求会认会读，不要求会写。
            # 园地（no:0）按顺序从 shizi_gardens 取，避免四个园地互相覆盖。
            if ln.get('no') == 0:
                shizi = shizi_gardens[garden_idx] if garden_idx < len(shizi_gardens) else []
                garden_idx += 1
            else:
                shizi = shizi_by_no.get(ln['no'], [])
            total_shizi += len(shizi)

            total_chars += len(chars)
            total_words += len(words)

            lessons.append({
                'no': ln['no'],
                'title': ln['title'],
                'star': bool(ln.get('star')),
                'chars': chars,
                'words': words,
                'shizi': shizi,
            })

        units.append({
            'id': u['id'],
            'name': u['name'],
            'pages': u['pages'],
            'lessons': lessons,
            'polyphone': u.get('polyphone', []),
            'tricky': u.get('tricky', []),
        })

    body = json.dumps({'book': raw['book'], 'units': units},
                      ensure_ascii=False, indent=2)

    js = (
        '/*\n'
        ' * 字词数据 —— 由 scripts/gen_data.py 从 data/words.raw.json 生成，不要手改。\n'
        ' *\n'
        ' * 来源：四年级上册语文《单元知识要点与拓展》里逐单元摘录的\n'
        ' *       写字表 / 词语表 / 多音字 / 易错字。\n'
        ' * 拼音由 pypinyin 生成后写死在这里，页面运行时不依赖任何库。\n'
        ' *\n'
        ' * 要改内容请改 data/words.raw.json，再跑一次 python scripts/gen_data.py。\n'
        ' */\n'
        '(function (root, factory) {\n'
        '  var mod = factory();\n'
        '  if (typeof module !== \'undefined\' && module.exports) module.exports = mod;\n'
        '  else root.ChineseData = mod;\n'
        '})(typeof self !== \'undefined\' ? self : this, function () {\n'
        '  \'use strict\';\n'
        '  var DATA = ' + body + ';\n'
        '  return {\n'
        '    BOOK: DATA.book,\n'
        '    UNITS: DATA.units,\n'
        '    byId: function (id) {\n'
        '      var hit = null;\n'
        '      DATA.units.forEach(function (u) { if (u.id === id) hit = u; });\n'
        '      return hit;\n'
        '    }\n'
        '  };\n'
        '});\n'
    )

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(js)

    # 核对清单单独写成 UTF-8 文件 —— Windows 控制台是 GBK，直接 print 中文会乱码
    review = os.path.join(ROOT, 'data', 'pinyin-review.md')
    with open(review, 'w', encoding='utf-8') as f:
        f.write('# 拼音核对清单\n\n')
        f.write('> 这些字的读音，教材 PDF 和 pypinyin 默认不一致，**已按教材为准**。\n')
        f.write('> 基本都是多音字（教材取的是课文里那个读音）。有空翻课本核对一遍更稳。\n\n')
        f.write('| 字 | pypinyin 默认 | 教材（已采用） |\n|---|---|---|\n')
        for c in conflicts:
            f.write('| ' + c.replace(': pypinyin=', ' | ').replace(' 教材=', ' | ') + ' |\n')

    print('units=%d chars=%d words=%d shizi=%d conflicts=%d' %
          (len(units), total_chars, total_words, total_shizi, len(conflicts)))
    print('written: %s' % OUT)


if __name__ == '__main__':
    main()
