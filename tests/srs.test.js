/*
 * 间隔复习的节奏 —— 1 / 2 / 4 / 7 / 15 天真的一档一档生效吗
 *
 * 为什么单开一个文件：这是这个模块的**核心承诺**（app.js 顶上就写着
 * "间隔复习才是这个模块的重点，题量是次要的"）。孩子今天会写的字，
 * 下周还得会写 —— 靠的就是到期排队和阶梯推进，这两样错了表面看不出来。
 *
 * 走的是多音字那条路：它由程序当场判分，一次点击就落一次记录。
 * 手写题要先进家长端绕一轮，但两条路共用同一个 recordResult()，
 * 节奏是同一套 —— 所以在这儿测就等于两边都测了。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const KEY = 'chinese-coach-v1';
const Data = require('../js/data.js');
const noop = () => {};

function makeEl(id) {
  return {
    id, innerHTML: '', _click: [], _input: [],
    addEventListener(type, fn) {
      if (type === 'click') this._click.push(fn);
      if (type === 'input') this._input.push(fn);
    },
    getAttribute() { return null; }
  };
}

function makeCanvas(id) {
  const ctx = new Proxy({}, { get: () => noop, set: () => true });
  return {
    id, style: {}, width: 0, height: 0, _ptr: {},
    parentNode: { clientWidth: 320, clientHeight: 160 },
    getContext: () => ctx,
    addEventListener(type, fn) { (this._ptr[type] = this._ptr[type] || []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: noop
  };
}

function boot(seed) {
  const els = { app: makeEl('app') };
  const canvas = makeCanvas('writeCanvas');
  const bag = {};
  if (seed) bag[KEY] = JSON.stringify(seed);

  const sandbox = {
    console,
    setTimeout: fn => { fn(); return 0; },
    clearTimeout: noop,
    localStorage: {
      getItem: k => (k in bag ? bag[k] : null),
      setItem: (k, v) => { bag[k] = String(v); },
      removeItem: k => { delete bag[k]; }
    },
    document: {
      readyState: 'complete',
      activeElement: { tagName: 'BODY' },
      getElementById: id => els[id]
        || ((id === 'writeCanvas' || id === 'reviewCanvas') ? canvas : null),
      addEventListener: noop
    },
    scrollTo: noop, confirm: () => true, alert: noop,
    // app.js 会挂 resize / visualViewport 监听（转屏后要重量画布尺寸）
    addEventListener: noop,
    visualViewport: { addEventListener: noop },
    requestAnimationFrame: fn => fn()
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  ['data', 'store', 'app'].forEach(name => {
    const file = path.join(ROOT, 'js', name + '.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  });

  function click(dataAct, attrs) {
    const handler = els.app._click[0];
    assert.ok(handler, '页面没有注册点击监听，说明 app.js 没有正常初始化');
    const a = { 'data-act': dataAct };
    Object.keys(attrs || {}).forEach(k => {
      a[k.indexOf('data-') === 0 ? k : 'data-' + k] = attrs[k];
    });
    handler({
      target: {
        _a: a,
        closest() { return this; },
        getAttribute(n) { return n in this._a ? this._a[n] : null; },
        blur: noop
      }
    });
  }

  return {
    click, canvas,
    html: () => els.app.innerHTML,
    state: () => JSON.parse(bag[KEY] || '{}')
  };
}

/* ---------- 数据侧的小工具 ---------- */

function polyItems(unitId) {
  var out = [];
  (Data.byId(unitId).polyphone || []).forEach(function (p) {
    (p.readings || []).forEach(function (rd) {
      var eg = String(rd.eg || '').split('、')[0].trim();
      if (eg) out.push({ key: 'p:' + p.char + '·' + eg, char: p.char, eg: eg, py: rd.py });
    });
  });
  return out;
}

// 屏幕上现在这道多音字题，对应数据里的哪一条
function currentPoly(html, items) {
  var m = /在「([^」]+)」里读什么/.exec(html);
  assert.ok(m, '屏幕上应当是多音字的题干');
  var hit = items.filter(function (it) { return it.eg === m[1]; });
  assert.strictEqual(hit.length, 1, '例词「' + m[1] + '」在数据里不唯一，这个测例得换个单元');
  return hit[0];
}

// 到期时间按"日历天"算：明天 0 点起就算到期，不是"明天这个时刻"
function midnightIn(days) {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() + days * 86400000;
}

function stat(level, dueAt, right) {
  return {
    attempts: 1, corrects: right === false ? 0 : 1, wrongs: right === false ? 1 : 0,
    level: level, dueAt: dueAt
  };
}

/* ==================== 阶梯 ==================== */

test('第一次答对只隔 1 天 —— 阶梯的第一档不是 2 天', () => {
  const items = polyItems('U1');
  assert.ok(items.length >= 3, 'U1 多音字数据太少，换个单元');
  const app = boot();
  app.click('unit', { u: 'U1' });
  app.click('start-poly');

  const it = currentPoly(app.html(), items);
  app.click('choose', { v: it.py });

  const r = app.state().stats[it.key];
  assert.ok(r, '答完应当留下统计');
  assert.strictEqual(r.level, 1, '连对一次是一档');
  assert.strictEqual(r.dueAt, midnightIn(1),
    '以前拿"档"直接当阶梯下标，第一次连对就跳到 2 天，1 天那一档永远用不上');
});

test('晚上练的字，第二天晚上一定已经到期', () => {
  const items = polyItems('U1');
  const app = boot();
  app.click('unit', { u: 'U1' });
  app.click('start-poly');
  const it = currentPoly(app.html(), items);
  app.click('choose', { v: it.py });

  const dueAt = app.state().stats[it.key].dueAt;
  assert.ok(dueAt <= Date.now() + 86400000,
    '到期时间不该晚于"明天同一时刻" —— 否则孩子明天这场练不着它，实际隔了两天');
});

test('阶梯能一路走到 15 天那一档', () => {
  const items = polyItems('U1');
  const it = items[items.length - 1];
  const app = boot({ unit: 'U1', stats: { [it.key]: stat(4, Date.now() - 1000) } });
  app.click('start-poly');
  assert.strictEqual(currentPoly(app.html(), items), it, '到期的那条应当第一个出现');

  app.click('choose', { v: it.py });
  const r = app.state().stats[it.key];
  assert.strictEqual(r.level, 5, '连对五次到顶');
  assert.strictEqual(r.dueAt, midnightIn(15), '最高档应当是 15 天');
});

test('答错的当天就能再练，不推到明天', () => {
  const items = polyItems('U1');
  const app = boot();
  app.click('unit', { u: 'U1' });
  app.click('start-poly');
  const it = currentPoly(app.html(), items);
  const wrong = items.filter(function (x) {
    return x.char === it.char && x.py !== it.py;
  })[0];
  assert.ok(wrong, '这道题只有个读音，选不出错误选项');

  app.click('choose', { v: wrong.py });
  const r = app.state().stats[it.key];
  assert.strictEqual(r.level, 0, '答错应当退回第一档');
  assert.ok(r.dueAt <= Date.now() + 1000, '错了应当当天就到期，可以马上订正');
});

/* ==================== 到期优先排队 ==================== */

test('到期的排最前面：多音字轮次不再整批打乱', () => {
  const items = polyItems('U1');
  const due = items[items.length - 1];
  const stats = {};
  items.forEach(function (x) {
    stats[x.key] = stat(2, Date.now() + 10 * 86400000);
  });
  stats[due.key] = stat(0, Date.now() - 1, false);

  const app = boot({ unit: 'U1', stats: stats });
  app.click('start-poly');
  assert.strictEqual(currentPoly(app.html(), items), due,
    '到期的题应当第一个出现，不然间隔复习等于没做');
});

test('到期的排最前面：组词轮次也一样（只出 10 题，更要挑对该出哪 10 题）', () => {
  var pool = [];
  Data.byId('U1').lessons.forEach(function (ln) {
    (ln.shizi || []).forEach(function (s) {
      if (s.zuci && s.zuci.length) pool.push({ key: 'z:' + s.c, c: s.c });
    });
  });
  assert.ok(pool.length > 10, 'U1 二类字太少，测不出"每轮只出 10 题"');

  const last = pool[pool.length - 1];
  const stats = {};
  pool.forEach(function (x) {
    stats[x.key] = stat(3, Date.now() + 10 * 86400000);
  });
  stats[last.key] = stat(0, Date.now() - 1, false);

  const app = boot({ unit: 'U1', lesson: 'all', stats: stats });
  app.click('ref');
  app.click('start-zuci');
  assert.ok(app.html().indexOf('zuci-char">' + last.c) >= 0,
    '到期的「' + last.c + '」应当排在第一题');
});
