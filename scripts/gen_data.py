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

改完务必看一眼 data/pinyin-review.md：那是所有"程序拿不准"的地方。
"""
import json
import os
import unicodedata
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

# 写字表里的单个字，靠整课的字词也推不出读音时，手工钉死。
# key 是 (课次, 字)，value 是 (读音, 依据)。依据必须能翻课本查到，不要凭感觉。
LESSON_CHAR_PY = {
    # 《暮江吟》"一道残阳铺水中"；本单元多音字表：pū = 铺展、铺开。
    (8, '铺'): ('pū', '《暮江吟》"一道残阳铺水中"'),
    # 《出塞》"但使龙城飞将在"；本单元多音字表：jiàng = 将领、飞将。
    (27, '将'): ('jiàng', '《出塞》"但使龙城飞将在"'),
}

# 教材 PDF 里拼音字体的字形映射（ā 被存成了 Q 之类）。
# 反推依据：盐 yán→yWn、鼎 dǐng→dJng、余 yú→yP、吼 hǒu→hGu 等几十个样本。
# 一个字母只能对应一个带调韵母：这里曾经是 O 和 G 都写成了 ǒ，
# 于是所有 ū 的字（输 shO、曲 qO、躯 qO、诸 zhO、君 jOn）被标成 ǒ，
# 还被"以教材为准"这条规则一路放行 —— 所以现在加了 LEGAL_SYLLABLES 这道闸。
# 不在表里的字母解不出来，那个字就退回 pypinyin 的读音并记进"需核对"清单。
GLYPH = {
    'Q': 'ā', 'W': 'á', 'E': 'ē', 'R': 'é', 'T': 'ō', 'Y': 'ó',
    'U': 'ī', 'I': 'í', 'O': 'ū', 'P': 'ú',
    'A': 'ǎ', 'S': 'à', 'D': 'ě', 'F': 'è', 'G': 'ǒ', 'H': 'ò',
    'J': 'ǐ', 'K': 'ì', 'L': 'ǔ', 'M': 'ù',
}

# 合法的零声母/整体认读音节，PDF 解出来是空骨架时兜底用。
try:
    from pypinyin.pinyin_dict import pinyin_dict as _PYDICT
except Exception:
    _PYDICT = {}


def _strip_tone(s):
    """去掉声调符号：shū -> shu，jǒn -> jon（用来判断这个音节存不存在）。"""
    out = []
    for ch in s:
        d = unicodedata.normalize('NFD', ch)
        out.append(d[0] if len(d) > 1 and unicodedata.combining(d[1]) else ch)
    return ''.join(out).lower()


# 音节表从 pypinyin 的字词典里剥声调得到（420 多个），不手抄。
# 它是这道闸的判据：映射表错一个字母，解出来的东西多半根本不是普通话音节。
LEGAL_SYLLABLES = set()
for _v in _PYDICT.values():
    for _r in _v.split(','):
        _r = _r.strip()
        if _r:
            LEGAL_SYLLABLES.add(_strip_tone(_r))


def decode_pdf_py(raw):
    """把 PDF 里的乱码拼音还原成正常拼音；解不出、或解出个不存在的音节，返回 None。"""
    out = []
    for ch in raw:
        if ch.isupper():
            v = GLYPH.get(ch)
            if not v:
                return None
            out.append(v)
        else:
            out.append(ch)
    result = ''.join(out)
    if LEGAL_SYLLABLES and _strip_tone(result) not in LEGAL_SYLLABLES:
        return None
    return result

def py_of(text):
    """返回带声调的拼音音节列表。"""
    return [s[0] for s in pinyin(text, style=Style.TONE, heteronym=False)]


def word_syllables(word):
    """词语表里一个词的读音（手工覆盖优先于 pypinyin 的词组切分）。"""
    return OVERRIDE[word] if word in OVERRIDE else py_of(word)


def context_readings(words):
    """{字: (读音, 出自哪个词)} —— 同一个字在同课不同词里读音不同时丢掉，宁可不认。"""
    ctx = {}
    ambiguous = set()
    for w in words:
        syl = word_syllables(w)
        for ch, s in zip(w, syl):
            if ch in ctx and ctx[ch][0] != s:
                ambiguous.add(ch)
            ctx.setdefault(ch, (s, w))
    for ch in ambiguous:
        ctx.pop(ch, None)
    return ctx


def main():
    with open(SRC, encoding='utf-8') as f:
        raw = json.load(f)
    with open(SHIZI, encoding='utf-8') as f:
        shizi_raw = json.load(f)
    with open(ZUCI, encoding='utf-8') as f:
        zuci_map = json.load(f)

    # 识字表（二类字）：字和拼音都来自教材 PDF；pypinyin 只用来交叉校验。
    # 注意：四个「语文园地」在原始数据里都用 no:0，不能用 no 当字典键（会互相覆盖），
    # 所以园地单独按出现顺序放到 shizi_gardens 列表里，下面再按顺序对应到各单元园地课。
    shizi_by_no = {}
    shizi_gardens = []
    pdf_py = {}          # {课次: {字: 教材读音}}，写字表可以借用同课的这条证据
    conflicts = []       # 教材读音和 pypinyin 默认不一致（多音字，正常）
    rejects = []         # PDF 拼音解不出来 / 解出非法音节 —— 映射表出问题的信号
    for ln in shizi_raw['lessons']:
        items = []
        for it in ln['chars']:
            c, raw_py = it['c'], it['raw']
            mine = py_of(c)[0]
            pdf = decode_pdf_py(raw_py)
            if pdf is None:
                rejects.append((ln.get('no'), c, raw_py, mine))
            elif pdf != mine:
                conflicts.append((ln.get('no'), c, mine, pdf))
            if pdf:
                pdf_py.setdefault(ln.get('no'), {})[c] = pdf
            items.append({'c': c, 'p': pdf or mine, 'zuci': zuci_map.get(c, [])})
        if ln.get('no') == 0:
            shizi_gardens.append(items)
        else:
            shizi_by_no[ln['no']] = items

    # 写字表（一类字）：单个字没有语境，多音字必须靠语境定读音。
    # 优先级：手工钉死 → 同课词语表里的读法 → 同课识字表的教材读音 → pypinyin 默认。
    chars_fixed = []     # (课次, 字, 采用的读音, 依据, pypinyin 默认)
    for_no_char = []     # 是多音字但只拿到 pypinyin 默认读音 —— 给家长留个心眼

    units = []
    total_chars = 0
    total_words = 0
    total_shizi = 0
    garden_idx = 0

    for u in raw['units']:
        polyphone = u.get('polyphone', [])
        poly_chars = {p['char'] for p in polyphone}
        lessons = []
        for ln in u.get('lessons', []):
            words = [{'w': w, 'p': word_syllables(w)} for w in ln.get('words', [])]
            ctx = context_readings(ln.get('words', []))
            same_lesson_pdf = pdf_py.get(ln.get('no'), {})

            chars = []
            for c in ln.get('chars', []):
                mine = py_of(c)[0]
                if (ln.get('no'), c) in LESSON_CHAR_PY:
                    p, why = LESSON_CHAR_PY[(ln.get('no'), c)]
                    src = '手工钉死：' + why
                elif c in ctx:
                    p, w = ctx[c]
                    src = '同课词语「%s」' % w
                elif c in same_lesson_pdf:
                    p = same_lesson_pdf[c]
                    src = '同课识字表（教材注音）'
                else:
                    p = mine
                    src = ''
                if p != mine:
                    chars_fixed.append((ln.get('no'), c, p, src, mine))
                elif c in poly_chars and c not in ctx:
                    entry = next(x for x in polyphone if x['char'] == c)
                    for_no_char.append((ln.get('no'), c, p,
                                        '/'.join(r['py'] for r in entry['readings'])))
                chars.append({'c': c, 'p': p})

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
            'polyphone': polyphone,
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
        ' * 多音字的读法按语境定：手工钉死 → 同课词语 → 同课识字表教材注音 → pypinyin 默认。\n'
        ' * 拿不准的都列在 data/pinyin-review.md 里。\n'
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

    write_review(conflicts, rejects, chars_fixed, for_no_char)

    print('units=%d chars=%d words=%d shizi=%d' %
          (len(units), total_chars, total_words, total_shizi))
    print('conflicts=%d rejects=%d chars_fixed=%d' %
          (len(conflicts), len(rejects), len(chars_fixed)))
    if rejects:
        print('!! 有 %d 个字的教材拼音解不出来，已退回 pypinyin —— 检查 GLYPH 表' % len(rejects))
    print('written: %s' % OUT)


def write_review(conflicts, rejects, chars_fixed, for_no_char):
    """核对清单单独写成 UTF-8 文件 —— Windows 控制台是 GBK，直接 print 中文会乱码。"""
    review = os.path.join(ROOT, 'data', 'pinyin-review.md')
    with open(review, 'w', encoding='utf-8') as f:
        f.write('# 拼音核对清单\n\n')
        f.write('生成 js/data.js 时顺带产出的，**程序拿不准的地方都在这里**。\n')
        f.write('不用逐字看，扫一眼有没有「解不出来」那一节就行。\n\n')

        f.write('## 一、教材拼音解不出来（必须处理）\n\n')
        f.write('这些字课本上有注音，但字形映射表解不出来、或者解出一个普通话里不存在的音节，\n')
        f.write('**已退回 pypinyin 的读音**。出现这一节通常说明 `GLYPH` 表错了某个字母。\n\n')
        if rejects:
            f.write('| 课次 | 字 | 课本里的乱码 | 退回的读音 |\n|---|---|---|---|\n')
            for no, c, r, mine in rejects:
                f.write('| %s | %s | %s | %s |\n' % (no, c, r, mine))
        else:
            f.write('（无）\n')

        f.write('\n## 二、二类字：课本注音和 pypinyin 不一致（已按课本）\n\n')
        f.write('基本都是多音字（课本取的是课文里那个读音）。有空翻课本核对一遍更稳。\n\n')
        f.write('| 课次 | 字 | pypinyin 默认 | 课本（已采用） |\n|---|---|---|---|\n')
        for no, c, mine, pdf in conflicts:
            f.write('| %s | %s | %s | %s |\n' % (no, c, mine, pdf))

        f.write('\n## 三、写字表里的多音字：读音是按语境定的\n\n')
        f.write('写字表只有一个字，没有词，pypinyin 只能给"最常用的那个读音"，\n')
        f.write('对多音字常常是错的。下面是程序改过读音的地方和改的依据。\n\n')
        if chars_fixed:
            f.write('| 课次 | 字 | 采用 | pypinyin 默认 | 依据 |\n|---|---|---|---|---|\n')
            for no, c, p, src, mine in chars_fixed:
                f.write('| %s | %s | %s | %s | %s |\n' % (no, c, p, mine, src))
        else:
            f.write('（无）\n')

        f.write('\n## 四、是本单元的多音字，但没有任何语境线索（用的是常用读音）\n\n')
        f.write('这些没有改，用的是 pypinyin 默认读音。要是孩子按课文读法背了另一个音，\n')
        f.write('就把它加进 `gen_data.py` 的 `LESSON_CHAR_PY`。\n\n')
        if for_no_char:
            f.write('| 课次 | 字 | 采用的读音 | 本单元列出的读音 |\n|---|---|---|---|\n')
            for no, c, p, pys in for_no_char:
                f.write('| %s | %s | %s | %s |\n' % (no, c, p, pys))
        else:
            f.write('（无）\n')


if __name__ == '__main__':
    main()
