#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把（内容版）26秋四上语文教案.docx 拆成结构化数据，生成：
  data/jiaoan.raw.json   —— 中间产物，方便人眼核对
  js/jiaoan.js           —— 页面真正读的那一份

教案能给这个项目的东西，是字词表给不了的：
  · 教学进度表：哪一 Week 上到第几课、每课几节（"课堂进度"要用）
  · 每课的教学目标 / 重点 / 难点（家长辅导时知道这一课到底要掌握什么）
  · 写字指导里逐字的结构、笔顺、易错笔画（比"易错字：鼎（12 画）"具体得多）
  · 分层作业（基础 / 巩固 / 提升）

不能给的东西也写清楚，免得后面有人拿它当依据：
  · 课文原文、古诗、日积月累的**字句**一律不采信 —— 教案是二手整理，
    默写判的是"和课本一不一样"，那些内容只能从教材 PDF 取（见 js/recite.js）。
  · 教案自己就带着错：22/23 课的序号（《陀螺》《王戎不取道旁李》）和课本是反的，
    "方帽子店"前面漏了课次号。课次一律以 data/words.raw.json（对过 PDF）为准，
    教案只提供课次以外的字段。

用法：
  python scripts/gen_jiaoan.py
"""
import json
import os
import re
import zipfile
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORDS = os.path.join(ROOT, 'data', 'words.raw.json')
DOCX = os.path.join(
    os.path.dirname(ROOT), '01_学习资料库', '05_课件及辅导资料',
    '（内容版）26秋四上语文教案版本.docx')
RAW_OUT = os.path.join(ROOT, 'data', 'jiaoan.raw.json')
JS_OUT = os.path.join(ROOT, 'js', 'jiaoan.js')

NS = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'

# 课时教案里的字段名（docx 里是表格表头，值和它分成两段）。
# 只留这个项目用得上的：思政元素 / 教学准备 / 教学方法 / 教学反思 不收 ——
#   前三项是教师备课用的，跟孩子练字词没关系；
#   教学反思看着有用（"学生易错在哪"），但 114 节里是同一个模板套出来的
#   （"少数学生朗读时语气平淡"几乎每节都有），没有真实信息量，还占一半体积。
# 不收进数据、但要拿来"截断上一个字段"的表头。
# 少了这一组，"思政元素"会并进教学目标、"教学反思"会并进板书设计。
STOP_ONLY = ('思政元素', '教学准备', '教学方法', '教学反思')
# 顺带说明：'教  学  过  程' 后面紧跟着 '二次备课'（同一行的两列），
#   所以二次备课不进上面两组 —— 一旦当成分界，教学过程的内容就被截成空的。
FIELD_MAP = {
    '课    题': 'title',
    '课题': 'title',
    '课型': 'ctype',
    '课时': 'period',
    '课节': 'slot',
    '教学重点': 'key',
    '教学难点': 'hard',
    '教  学  过  程': 'process',
    '教学过程': 'process',
    '板书设计': 'board',
    '作业设计': 'homework',
    '教学目标': 'goals',
}

# 非课文类的课型：口语交际 / 习作 / 语文园地……不属于任何"第几课"。
SPECIAL_PREFIX = [
    ('快乐读书吧', '快乐读书吧'),
    ('口语交际', '口语交际'),
    ('习作例文', '习作例文'),
    ('习作', '习作'),
    ('交流平台', '交流平台'),
    ('语文园地', '语文园地'),
]

TIP_RE = re.compile(r'^([\u4e00-\u9fa5])\s*[：:]\s*(.+)$')
NUM_RE = re.compile(r'^\d{1,2}$')
DATE_RE = re.compile(r'^\d{1,2}\.\d{1,2}\s*[-—~]\s*\d{1,2}\.\d{1,2}$')
HOLIDAY = ('中秋', '国庆', '元旦', '清明', '劳动', '端午')
# 写字指导的引子，例如「指导书写：重点指导 "舒、适、弱"。」
WRITE_ANCHOR = re.compile(r'(指导书写|指导写字|重点指导|教师范写)')


def read_paragraphs(path):
    """按文档顺序取出所有段落文本（含文本框、结构体里的）。"""
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read('word/document.xml'))
    body = root.find(NS + 'body')
    out = []
    for p in body.iter(NS + 'p'):
        out.append(''.join(x.text or '' for x in p.iter(NS + 't')).strip())
    return out


def next_nonblank(paras, i):
    j = i + 1
    while j < len(paras) and not paras[j]:
        j += 1
    return paras[j] if j < len(paras) else ''


def strip_lesson_no(s):
    """「3*现代诗二首」→「现代诗二首」；「6.方帽子店」→「方帽子店」。"""
    s = s.strip()
    s = re.sub(r'^[\d０-９]+[\s．.、*＊]*', '', s)
    return s.strip()


def classify(title_raw):
    """判断这一课时属于第几课，还是口语交际 / 习作 / 语文园地这类。"""
    name = strip_lesson_no(title_raw)
    for pref, kind in SPECIAL_PREFIX:
        if name.startswith(pref):
            return name, kind
    return name, '课文'


def collect_lines(blk, i, stop_labels):
    """从一个字段名之后一直收值，收到下一个字段名 / 下一个课时为止。"""
    vals = []
    j = i + 1
    while j < len(blk):
        t = blk[j].strip()
        if t in stop_labels or t == '课 时 教 案':
            break
        if t:
            vals.append(t)
        j += 1
    return vals


def pick_writing_tips(process_lines):
    """从教学过程里挑出逐字的书写提示。

    教案里的样子是：
        指导书写：重点指导 "舒、适、弱"。
        舒：左右结构，左窄右宽。……
        适：半包围结构，内部 "舌" 要紧凑……
        弱: 两个 "弓" 大小一致……
        教师范写，学生练写，巡视纠正。
    只认「一个汉字 + 冒号」开头的行，而且必须紧跟在"指导书写 / 重点指导"
    这类引子之后 —— 不然会把习作批改符号（改：/ 补：/ 调：/ 优：）也收进来。
    """
    tips = []
    armed = False
    for ln in process_lines:
        s = ln.strip()
        if WRITE_ANCHOR.search(s[:30]) and not TIP_RE.match(s):
            armed = True
            continue
        m = TIP_RE.match(s)
        if m and armed:
            tips.append({'c': m.group(1), 'tip': m.group(2).strip()})
        elif s and not s.startswith('教师范写'):
            armed = False
    return [t for t in tips if len(t['tip']) >= 6]


def parse_weeks(paras):
    """教学进度表：周次 / 时间 / 天数 / 课时 / 教学内容 / 备注。"""
    try:
        head = paras.index('教学内容')
    except ValueError:
        return []

    rows = []
    cur = None
    state = 'week'
    i = head + 1
    while i < len(paras):
        t = paras[i].strip()
        i += 1
        if not t:
            continue
        # 进度表后面紧跟着单元整体教学设计，撞上就收手 ——
        # 不然会把后面的整份教案都当成第 19 周的"教学内容"吞进来。
        if '单元整体教学设计' in t or t.startswith('20') and '教学进度表' in t:
            break
        # 内容状态里来一个"上一个周次 + 1"的光杆数字，就是下一周开始了
        if state == 'content' and NUM_RE.match(t) and cur is not None \
                and int(t) == cur['w'] + 1:
            state = 'week'
        if state == 'week':
            if not NUM_RE.match(t):
                continue
            cur = {'w': int(t), 'date': '', 'days': '', 'periods': '',
                   'content': [], 'note': []}
            rows.append(cur)
            state = 'date'
        elif state == 'date':
            if DATE_RE.match(t):
                cur['date'] = t
            state = 'days'
        elif state == 'days':
            if NUM_RE.match(t):
                cur['days'] = t
            state = 'periods'
        elif state == 'periods':
            if NUM_RE.match(t):
                cur['periods'] = t
            state = 'content'
        else:
            if (t in HOLIDAY or t.endswith('假期')) and not t.startswith('期末'):
                cur['note'].append(t)
            else:
                cur['content'].append(t)
    return rows


def parse_units(paras, lesson_titles):
    """按「第X单元整体教学设计」切段，段内再切出课时教案。"""
    marks = [i for i, t in enumerate(paras)
             if re.match(r'^第[一二三四五六七八]单元整体教学设计$', t.strip())]
    marks.append(len(paras))

    units = []
    for k in range(len(marks) - 1):
        seg = paras[marks[k]:marks[k + 1]]
        uid = 'U%d' % (k + 1)
        u = {'id': uid, 'name': '', 'analysis': '', 'xueqing': '',
             'goals': [], 'core': [], 'key': [], 'hard': [], 'lessons': []}

        for i, t in enumerate(seg):
            if t.strip() == '单元名称':
                u['name'] = next_nonblank(seg, i)
                break

        # 一、教材分析 / 二、学情分析 / 三、教学目标 / 四、核心素养 / 五、重点 / 六、难点
        cur_key = None
        for t in seg:
            s = t.strip()
            if s == '课 时 教 案':
                cur_key = None
                continue
            m = re.match(r'^([一二三四五六七八九])、(单元)?(.+)$', s)
            if m and len(s) < 16:
                name = m.group(3)
                cur_key = None
                if '教材分析' in name:
                    cur_key = 'analysis'
                elif '学情分析' in name:
                    cur_key = 'xueqing'
                elif '教学目标' in name:
                    cur_key = 'goals'
                elif '核心素养' in name:
                    cur_key = 'core'
                elif '教学重点' in name:
                    cur_key = 'key'
                elif '教学难点' in name:
                    cur_key = 'hard'
                continue
            if not s or cur_key is None:
                continue
            if cur_key in ('analysis', 'xueqing'):
                u[cur_key] = s
                cur_key = None
                continue
            # 编号条目（1. …）或四条素养（文化自信 / 语言运用 / …）
            if re.match(r'^\d+[\.、]', s) or re.match(r'^(文化自信|语言运用|思维能力|审美创造)[：:]', s):
                u[cur_key].append(re.sub(r'^\d+[\.、]\s*', '', s))
            elif u[cur_key] and cur_key == 'core':
                u[cur_key][-1] += s

        # 课时教案
        labels = set(FIELD_MAP.keys()) | set(STOP_ONLY) | {'课 时 教 案'}
        idxs = [i for i, t in enumerate(seg) if t.strip() == '课 时 教 案']
        idxs.append(len(seg))
        for n in range(len(idxs) - 1):
            blk = seg[idxs[n]:idxs[n + 1]]
            les = {'ctype': '', 'period': '', 'slot': '', 'goals': [],
                   'key': '', 'hard': '', 'process': [],
                   'homework': [], 'board': [], 'writing': []}
            for i, t in enumerate(blk):
                s = t.strip()
                if s not in FIELD_MAP:
                    continue
                field = FIELD_MAP[s]
                vals = collect_lines(blk, i, labels)
                if field in ('goals', 'homework', 'board', 'process'):
                    les[field] = vals
                elif field in ('key', 'hard'):
                    les[field] = ' '.join(vals)
                elif vals:
                    les[field] = vals[0]
            les['writing'] = pick_writing_tips(les['process'])
            les.pop('process', None)

            name, kind = classify(les.pop('title', ''))
            les['name'] = name
            les['kind'] = kind
            les['no'] = match_lesson_no(uid, name, kind, lesson_titles)
            u['lessons'].append(les)
        units.append(u)
    return units


def match_lesson_no(uid, name, kind, lesson_titles):
    """课次以 data/words.raw.json（对过教材 PDF）为准，教案的序号只当参考。"""
    if kind != '课文':
        return 0
    titles = lesson_titles.get(uid, [])
    # 先整名匹配（去掉《…》括注），再用前三字前缀，最后用包含关系兜底
    for t in titles:
        tn = re.split(r'[《（(]', t['title'])[0].strip()
        if tn == name:
            return t['no']
    for t in titles:
        tn = re.split(r'[《（(]', t['title'])[0].strip()
        if len(name) >= 3 and tn.startswith(name[:3]):
            return t['no']
    for t in titles:
        if name and name in t['title']:
            return t['no']
    return 0


def write_js(data):
    # 压成一行：这是给页面读的数据，不是给人读的（要看内容翻 data/jiaoan.raw.json）。
    # 带缩进的话这份文件会到 370 KB，压完不到 200 KB —— 老机器和手机都有感。
    body = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    lines = [
        '/*',
        ' * 教案数据 —— 由 scripts/gen_jiaoan.py 生成，不要手改。',
        ' *',
        ' * 来源：01_学习资料库/05_课件及辅导资料/（内容版）26秋四上语文教案版本.docx',
        ' *   教学进度表（周次 → 上到第几课）、每课教学目标 / 重难点、',
        ' *   写字指导里的逐字提示、分层作业、板书。',
        ' *',
        ' * 课文原文、古诗、日积月累一律不取自教案 —— 那是二手整理，默写必须以教材 PDF 为准。',
        ' * 教案里的课次序号本身就有错（陀螺 / 王戎不取道旁李 标反了），',
        ' * 所以课次一律以 js/data.js 为准，这里只存课次以外的字段。',
        ' */',
        '(function (root, factory) {',
        '  var mod = factory();',
        "  if (typeof module !== 'undefined' && module.exports) module.exports = mod;",
        '  else root.JiaoanData = mod;',
        "})(typeof self !== 'undefined' ? self : this, function () {",
        "  'use strict';",
        '  var DATA = ' + body + ';',
        '  var INDEX = {};',
        '  DATA.units.forEach(function (u) { INDEX[u.id] = u; });',
        '  function byId(id) { return INDEX[id] || null; }',
        '  function lessonOf(unitId, no) {',
        '    var u = byId(unitId);',
        '    if (!u) return null;',
        '    var hit = null;',
        '    u.lessons.forEach(function (l) {',
        '      if (!hit && String(l.no) === String(no)) hit = l;',
        '    });',
        '    return hit;',
        '  }',
        '  return { book: DATA.book, source: DATA.source, weeks: DATA.weeks,',
        '           units: DATA.units, byId: byId, lessonOf: lessonOf };',
        '});',
        '',
    ]
    with open(JS_OUT, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))


def main():
    if not os.path.exists(DOCX):
        raise SystemExit('找不到教案文件：%s' % DOCX)

    with open(WORDS, encoding='utf-8') as f:
        words = json.load(f)
    lesson_titles = {}
    for idx, u in enumerate(words['units']):
        lesson_titles['U%d' % (idx + 1)] = [
            {'no': l.get('no', 0), 'title': l.get('title', '')}
            for l in u.get('lessons', [])]

    paras = read_paragraphs(DOCX)
    weeks = parse_weeks(paras)
    units = parse_units(paras, lesson_titles)

    data = {
        'book': words.get('book', ''),
        'source': os.path.basename(DOCX),
        'note': '课次/课文名以教材 PDF 为准；教案只提供进度、目标、重难点、写字要点、作业。',
        'weeks': weeks,
        'units': units,
    }

    with open(RAW_OUT, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    write_js(data)

    nles = sum(len(u['lessons']) for u in units)
    ntips = sum(len(l['writing']) for u in units for l in u['lessons'])
    nmatched = sum(1 for u in units for l in u['lessons']
                   if l['kind'] == '课文' and l['no'])
    print('周次 %d / 单元 %d / 课时 %d 节 / 写字提示 %d 条 / 课次匹配上 %d 节'
          % (len(weeks), len(units), nles, ntips, nmatched))


if __name__ == '__main__':
    main()
