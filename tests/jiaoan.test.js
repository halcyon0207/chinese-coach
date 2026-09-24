/*
 * 教案数据体检 —— js/jiaoan.js 由 scripts/gen_jiaoan.py 从教案 docx 生成。
 *
 * 这里守的不是"格式对不对"，而是两件真会坑到孩子的事：
 *
 *  1. **课次必须以课本为准，不能跟着教案走。** 教案把第七单元的《陀螺》标成
 *     23*、《王戎不取道旁李》标成 22，和课本正好是反的；"方帽子店"前面还漏了
 *     课次号。生成脚本按课文名去 js/data.js 里认课次，这条测试盯住结果。
 *
 *  2. **课文原文不进这份数据。** 教案是二手整理，默写判的是"和课本一不一样"，
 *     一旦有人把教案里的句子当成必背内容录进来，孩子就会背错。
 *     所以这里检查的是：这份数据里不该出现"日积月累 / 默写 / 背诵段落原文"
 *     这类字段 —— 要背的内容只能走 js/recite.js（那条链是对过教材 PDF 的）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Data = require('../js/data.js');
const Jiaoan = require('../js/jiaoan.js');

const allLessons = () => Jiaoan.units.reduce(
  (acc, u) => acc.concat(u.lessons.map(l => Object.assign({ unit: u.id }, l))), []);

test('教案的周次进度表完整：19 周、周次连续、日期能解析', () => {
  const w = Jiaoan.weeks;
  assert.ok(w.length >= 18, '周次太少：' + w.length);
  w.forEach((row, i) => {
    assert.strictEqual(row.w, i + 1, '周次必须连续，第 ' + (i + 1) + ' 条是 ' + row.w);
    assert.ok(/^\d{1,2}\.\d{1,2}\s*[-—~]\s*\d{1,2}\.\d{1,2}$/.test(row.date),
      '第 ' + row.w + ' 周的日期解析不出来：' + row.date);
  });
});

test('8 个单元、课时齐全，每节都有课型 / 第几课时 / 周次节次', () => {
  assert.strictEqual(Jiaoan.units.length, 8);
  const les = allLessons();
  assert.ok(les.length >= 100, '课时太少：' + les.length);
  les.forEach(l => {
    assert.ok(l.name, '有课时没有课题');
    assert.ok(l.period, l.name + ' 缺"第几课时"');
    assert.ok(/^\d+\s*周\s*\d+\s*节$/.test(l.slot || ''),
      l.name + ' 的课节格式不对：' + l.slot);
  });
});

test('课次以课本为准：陀螺是 22、王戎不取道旁李是 23（教案里这两个是反的）', () => {
  const u7 = Jiaoan.byId('U7');
  assert.ok(u7, '没有第七单元');
  const find = name => u7.lessons.filter(l => l.name === name);
  const tuo = find('陀螺');
  const wang = find('王戎不取道旁李');
  assert.ok(tuo.length && wang.length, '第七单元里没找到《陀螺》或《王戎不取道旁李》');
  tuo.forEach(l => assert.strictEqual(l.no, 22, '《陀螺》必须是第 22 课'));
  wang.forEach(l => assert.strictEqual(l.no, 23, '《王戎不取道旁李》必须是第 23 课'));
});

test('课次和 js/data.js 对得上：教案点到的课，课次就是课本上的课次', () => {
  const byUnit = {};
  Data.UNITS.forEach(u => {
    byUnit[u.id] = {};
    u.lessons.forEach(l => { byUnit[u.id][l.title.split(/[《（(]/)[0]] = l.no; });
  });
  let checked = 0;
  allLessons().forEach(l => {
    if (l.kind !== '课文') return;
    const table = byUnit[l.unit];
    assert.ok(table, '教案里有 js/data.js 不认识的单元：' + l.unit);
    const no = table[l.name];
    assert.notStrictEqual(no, undefined,
      '教案里的《' + l.name + '》在 ' + l.unit + ' 找不到对应的课');
    assert.strictEqual(l.no, no,
      '《' + l.name + '》课次对不上：教案给了 ' + l.no + '，课本是 ' + no);
    checked++;
  });
  assert.ok(checked > 60, '匹配上的课文太少：' + checked);
});

test('写字要点：每条只讲一个字，提示不是空话', () => {
  let n = 0;
  allLessons().forEach(l => {
    (l.writing || []).forEach(t => {
      assert.ok(/^[\u4e00-\u9fa5]$/.test(t.c), '写字要点的字不是一个汉字：' + t.c);
      assert.ok(t.tip && t.tip.length >= 6, '「' + t.c + '」的提示太短：' + t.tip);
      // 提示里不该夹带习作批改符号那类误收的内容（"改：错别字、病句"）
      assert.ok(!/^错别字|病句/.test(t.tip), '「' + t.c + '」收进了非书写提示：' + t.tip);
      n++;
    });
  });
  assert.ok(n >= 15, '写字要点太少，提取规则可能失效了：' + n);
});

test('这份数据里不含"要背的原文"字段 —— 默写只认 js/recite.js', () => {
  const ban = ['日积月累', '默写', '原文填空', '必背'];
  const raw = JSON.stringify(Jiaoan);
  // 允许出现在"作业"里（"巩固作业：背诵第 2 自然段"是任务，不是原文），
  // 但不允许出现一个专门存原文的字段名。
  ban.forEach(k => {
    assert.ok(raw.indexOf('"' + k + '"') < 0, '教案数据里不该有字段：' + k);
  });
});
