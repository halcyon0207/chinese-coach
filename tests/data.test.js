/*
 * 数据体检 —— js/data.js 是 scripts/gen_data.py 生成的，运行时没法重算，
 * 所以这里钉几条"错一个字母就会整批废掉"的硬规则。
 *
 * 起因：教材 PDF 的拼音是乱码字形，靠一张映射表还原。表里 O 和 G 都曾映射到 ǒ，
 * 于是所有 ū 的字（输 shO、曲 qO、躯 qO、诸 zhO、君 jOn）被标成 ǒ，
 * 还打着"以教材为准"的名义写进了数据 —— 生成的时候没人发现，孩子天天看。
 * 生成脚本现在有了同样的音节合法性检查，这条测试是它的第二道闸。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Data = require('../js/data.js');

// 汉语拼音的全部韵母（按书写形式，不是按韵腹韵尾拆）。声母随便配，韵母必须是这里面的。
const FINALS = [
  'a', 'o', 'e', 'ai', 'ei', 'ao', 'ou', 'an', 'en', 'ang', 'eng', 'ong', 'er',
  'i', 'ia', 'ie', 'iao', 'iu', 'ian', 'in', 'iang', 'ing', 'iong',
  'u', 'ua', 'uo', 'uai', 'ui', 'uan', 'un', 'uang', 'ueng',
  'ü', 'üe', 'üan', 'ün',
];
const TONE_MAP = {
  'ā': 'a', 'á': 'a', 'ǎ': 'a', 'à': 'a',
  'ē': 'e', 'é': 'e', 'ě': 'e', 'è': 'e',
  'ī': 'i', 'í': 'i', 'ǐ': 'i', 'ì': 'i',
  'ō': 'o', 'ó': 'o', 'ǒ': 'o', 'ò': 'o',
  'ū': 'u', 'ú': 'u', 'ǔ': 'u', 'ù': 'u',
  'ǖ': 'ü', 'ǘ': 'ü', 'ǚ': 'ü', 'ǜ': 'ü',
};
const VOWELS = 'aoeiü';

function stripTone(s) {
  return s.split('').map(c => TONE_MAP[c] || c).join('');
}

// o 这个韵母只跟 b p m f w（和零声母）拼：sho / qo / zho 这些都不存在
function finalIsLegal(initial, final) {
  if (FINALS.indexOf(final) < 0) return false;
  if (final === 'o') return ['', 'b', 'p', 'm', 'f', 'w'].indexOf(initial) >= 0;
  return true;
}

function checkSyllable(syl, where) {
  assert.ok(typeof syl === 'string' && syl.length > 0, `${where} 拼音是空的`);
  assert.strictEqual(syl, syl.toLowerCase(), `${where} 拼音「${syl}」里有大写字母 —— 字形映射没解干净`);
  assert.ok(!/[^\w\u00c0-\u02ffà-˿]/.test(syl), `${where} 拼音「${syl}」含非法字符`);

  let marked = 0;
  for (const ch of syl) if (TONE_MAP[ch]) marked++;
  assert.ok(marked <= 1, `${where} 拼音「${syl}」声调符号不止一个`);

  const plain = stripTone(syl);
  const m = /^([^aeiouü]*)(.*)$/.exec(plain);
  const initial = m[1].replace(/v/g, 'ü');
  let final = m[2].replace(/v/g, 'ü');
  // j q x y 后面的 u 写出来是 u、其实是 ü：que 的真身是 qüe、yuan 是 üan
  if (['j', 'q', 'x', 'y'].indexOf(initial) >= 0 && final.charAt(0) === 'u') {
    final = 'ü' + final.slice(1);
  }
  assert.ok(final.length > 0, `${where} 拼音「${syl}」没有韵母`);
  // 儿化、哼叹词（ng 之类）不算常规音节，这里的数据不该出现
  assert.ok(finalIsLegal(initial, final),
    `${where} 拼音「${syl}」不是合法的汉语音节（声母 ${initial || '零'} + 韵母 ${final}）`);
}

function allSyllables() {
  const out = [];
  Data.UNITS.forEach(u => u.lessons.forEach(l => {
    l.chars.forEach(c => out.push([`${l.no} 写字表 ${c.c}`, c.p]));
    l.shizi.forEach(c => out.push([`${l.no} 识字表 ${c.c}`, c.p]));
    l.words.forEach(w => {
      assert.strictEqual(w.p.length, w.w.length,
        `词语「${w.w}」的拼音个数和字数对不上：${JSON.stringify(w.p)}`);
      w.p.forEach((s, i) => out.push([`${l.no} 词语「${w.w}」第${i + 1}字`, s]));
    });
  }));
  return out;
}

test('数据能加载，八个单元都有内容', () => {
  assert.ok(Data.UNITS.length === 8, '应当是 8 个单元');
  Data.UNITS.forEach(u => {
    assert.ok(u.lessons.length > 0, `${u.id} 没有课`);
    u.lessons.forEach(l => {
      assert.ok(l.chars.length + l.words.length + l.shizi.length > 0,
        `第 ${l.no} 课 ${l.title} 一个字都没有`);
    });
  });
});

test('每个字的拼音都是合法音节（守住字形映射表那类错）', () => {
  const list = allSyllables();
  assert.ok(list.length > 600, '扫描到的音节太少，八成是遍历写错了');
  list.forEach(([where, syl]) => checkSyllable(syl, where));
});

test('二类字不许出现课本里没有的"平翘舌混读"式错音', () => {
  // 这几个字是那次字形映射事故里被改错的，钉死具体读音。
  // 一旦映射表或生成脚本再退化，这条会直接指出是哪个字。
  const pinned = {
    '输': 'shū', '曲': 'qū', '躯': 'qū', '诸': 'zhū', '君': 'jūn',
  };
  const shizi = {};
  Data.UNITS.forEach(u => u.lessons.forEach(l =>
    l.shizi.forEach(c => { shizi[c.c] = c.p; })));
  Object.keys(pinned).forEach(c => {
    assert.strictEqual(shizi[c], pinned[c], `二类字「${c}」应当读 ${pinned[c]}`);
  });
});

test('写字表里的多音字按课文语境定读音', () => {
  function charOf(no, c) {
    let hit = null;
    Data.UNITS.forEach(u => u.lessons.forEach(l => {
      if (l.no === no) l.chars.forEach(x => { if (x.c === c) hit = x; });
    }));
    return hit;
  }
  // 《雪梅》"梅雪争春未肯降"、《出塞》、《凉州词》、《暮江吟》、《一只窝囊的大老虎》
  const cases = [
    [8, '降', 'xiáng'], [8, '铺', 'pū'], [21, '哄', 'hōng'],
    [27, '塞', 'sài'], [27, '将', 'jiàng'],
  ];
  cases.forEach(([no, c, want]) => {
    const item = charOf(no, c);
    assert.ok(item, `第 ${no} 课写字表里应当有「${c}」`);
    assert.strictEqual(item.p, want, `第 ${no} 课的「${c}」应读 ${want}`);
  });
});

test('多音字表里的读音和字词数据用的读音对得上', () => {
  // 每个单元都带了课本的多音字表。数据里出现的读音必须是表里列出的那一个，
  // 或者压根不在这个字的多音字范围里（说明课本没标，用常用音没问题）。
  Data.UNITS.forEach(u => {
    const poly = {};
    (u.polyphone || []).forEach(p => { poly[p.char] = p.readings.map(r => r.py); });
    u.lessons.forEach(l => {
      l.chars.forEach(c => {
        if (poly[c.c]) {
          assert.ok(poly[c.c].indexOf(c.p) >= 0,
            `第 ${l.no} 课「${c.c}」用了 ${c.p}，课本多音字表只有 ${poly[c.c].join('/')}`);
        }
      });
      l.words.forEach(w => {
        for (let i = 0; i < w.w.length; i++) {
          const ch = w.w[i];
          if (poly[ch]) {
            assert.ok(poly[ch].indexOf(w.p[i]) >= 0,
              `词语「${w.w}」里「${ch}」用了 ${w.p[i]}，课本只有 ${poly[ch].join('/')}`);
          }
        }
      });
    });
  });
});
