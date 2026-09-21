/*
 * 界面冒烟测试
 *
 * 用一个极小的 DOM 替身把脚本按 index.html 的顺序跑起来，模拟真实点击。
 * 目的不是测样式，而是回答一个问题：**手机上打开它会不会白屏。**
 *
 * 画布给了个替身：能接住指针事件，所以测试是真的"写了一笔"再交上去的 ——
 * 不然碰不到"笔迹要一起存下来""没写就交会被拦"这几条路径。
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
    id,
    innerHTML: '',
    _click: [],
    _input: [],
    addEventListener(type, fn) {
      if (type === 'click') this._click.push(fn);
      if (type === 'input') this._input.push(fn);
    },
    getAttribute() { return null; }
  };
}

// 画布替身：ctx 上的一切都当空操作，指针事件则记下来供测试触发
function makeCanvas(id) {
  const ctx = new Proxy({}, { get: () => noop, set: () => true });
  return {
    id,
    style: {},
    width: 0,
    height: 0,
    _ptr: {},
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

  // 假定时器：app.js 里唯一的定时器是"长按清空"，测试里手动放行，
  // 免得真等 0.55 秒、也免得长按用例依赖真实时间。
  const timers = [];
  function flushTimers() {
    for (let i = 0; i < timers.length; i++) {
      const fn = timers[i];
      timers[i] = null;
      if (fn) fn();
    }
  }

  const sandbox = {
    console,
    setTimeout: fn => { timers.push(fn); return timers.length - 1; },
    clearTimeout: id => { if (id != null) timers[id] = null; },
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
    scrollTo: noop,
    confirm: () => true,
    alert: noop
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

  function type(id, value) {
    const input = els.app._input[0];
    assert.ok(input, '页面没有注册输入监听');
    input({ target: { id, value } });
  }

  // 真的写一笔
  function draw() {
    const fire = (t, x, y) => (canvas._ptr[t] || []).forEach(fn => fn({
      clientX: x, clientY: y, pointerId: 1, preventDefault: noop
    }));
    fire('pointerdown', 30, 50);
    fire('pointermove', 55, 80);
    fire('pointerup', 55, 80);
  }

  return {
    els, sandbox, canvas, click, type, draw, flushTimers,
    html: () => els.app.innerHTML,
    state: () => JSON.parse(bag[KEY] || '{}')
  };
}

/* ==================== 首页 ==================== */

test('页面能加载，首页列出全部单元', () => {
  const app = boot();
  const html = app.html();
  assert.ok(html.length > 200, '首页内容为空，多半是脚本报错了');
  assert.ok(html.includes('语文小教练'));
  assert.ok(html.includes('第一单元') && html.includes('第八单元'), '八个单元都要列出来');
});

test('能切换单元，切换后记在本机', () => {
  const app = boot();
  app.click('unit', { u: 'U3' });
  assert.ok(app.html().includes('on'), '选中的单元应当高亮');
  assert.strictEqual(app.state().unit, 'U3');
});

/* ==================== 练习 ==================== */

test('没写就交会被拦住', () => {
  const app = boot();
  app.click('start');
  app.click('submit');
  assert.ok(app.html().includes('先在田字格里写一下'), '一笔没画就交，应当提示先写');
  // 还没存过东西的时候 state() 是空的，别直接点 pending.length
  assert.strictEqual((app.state().pending || []).length, 0, '拦住就不该进待批改');
});

test('写完能交上去，笔迹要一起存下来', () => {
  const app = boot();
  app.click('start');
  app.draw();
  app.click('submit');

  const st = app.state();
  assert.strictEqual(st.pending.length, 1, '写完应当进"等家长批改"');
  assert.ok(st.pending[0].strokes.length > 0, '笔迹要存下来，家长端才看得到孩子写了什么');
});

function allAnswersOf(unitId) {
  const out = [];
  Data.byId(unitId).lessons.forEach(l => {
    l.words.forEach(w => out.push(w.w));
    l.chars.forEach(c => out.push(c.c));
  });
  return out;
}

test('写完不显示答案（一显示就成了自评）', () => {
  const app = boot();
  // 固定练第 1 课《观潮》：它的标题不会和本课任何字词撞车，避免误判
  app.click('lesson', { l: '1' });
  app.click('start');
  const html = app.html();
  allAnswersOf('U1').forEach(a => {
    assert.ok(!html.includes(a), `写完就把答案「${a}」显示出来了，那还不如直接抄`);
  });
});

test('能按课时练：选了第 5 课就只出第 5 课的字词', () => {
  const app = boot();
  app.click('unit', { u: 'U2' });
  app.click('lesson', { l: '5' });
  assert.strictEqual(app.state().lesson, '5');
  assert.ok(app.html().includes('夜间飞行的秘密'), '应当显示课文标题，不然不知道在练哪一课');

  const ln = Data.byId('U2').lessons.find(l => l.no === 5);
  const allowed = ln.words.map(w => w.w).concat(ln.chars.map(c => c.c));

  app.click('start');
  app.draw();
  app.click('submit');
  const text = app.state().pending[0].item.text;
  assert.ok(allowed.includes(text), `选了第 5 课，却出了「${text}」`);
});

test('略读课文没有字词时要明说，不能点了没反应', () => {
  const app = boot();
  app.click('unit', { u: 'U2' });
  assert.ok(app.html().includes('略读课文，无字词'), '略读课文应当标出来');
});

/* ==================== 家长口令 ==================== */

test('家长端要口令：位数不对要拦，设好才能进', () => {
  const app = boot();
  app.click('parent');
  assert.ok(app.html().includes('先设一个口令'), '第一次进来应当先设口令');

  app.type('passInput', '12');
  app.click('set-pass');
  assert.ok(app.html().includes('口令要 4～6 位数字'), '位数不对应当被拦住');

  app.type('passInput', '1234');
  app.click('set-pass');
  assert.ok(!app.html().includes('先设一个口令'), '设好之后应当能进去');
  assert.strictEqual(app.state().passcode, '1234');
});

test('设过口令之后，口令不对进不去批改', () => {
  const app = boot({ passcode: '1234' });
  app.click('parent');
  assert.ok(app.html().includes('请输入口令'));

  app.type('passInput', '0000');
  app.click('unlock');
  assert.ok(app.html().includes('口令不对'), '口令不对应当进不去');
  assert.ok(!app.html().includes('写对了'), '没解锁就不能看到批改按钮');

  app.type('passInput', '1234');
  app.click('unlock');
  assert.ok(!app.html().includes('口令不对'), '口令对了应当放行');
});

/* ==================== 批改 ==================== */

test('批改之后：出队、进历史、安排下次复习、批注留下', () => {
  const app = boot({ passcode: '1234' });
  app.click('start');
  app.draw();
  app.click('submit');
  assert.strictEqual(app.state().pending.length, 1);

  app.click('parent');
  app.type('passInput', '1234');
  app.click('unlock');
  assert.ok(app.html().includes('正确答案'), '批改时应当显示正确答案');

  app.type('noteInput', '崩少了山字头');
  app.click('grade-ok');

  const st = app.state();
  assert.strictEqual(st.pending.length, 0, '批完应当出队');
  assert.strictEqual(st.history.length, 1);
  assert.strictEqual(st.history[0].note, '崩少了山字头', '批注要跟着这个词存下来');

  const k = Object.keys(st.stats)[0];
  assert.ok(k, '批改后应当写进统计');
  assert.ok(st.stats[k].dueAt > Date.now(), '应当安排下次复习的时间');
});

test('写错了当天就能订正，不用等到明天', () => {
  const app = boot({ passcode: '1234' });
  app.click('start');
  app.draw();
  app.click('submit');

  app.click('parent');
  app.type('passInput', '1234');
  app.click('unlock');
  app.click('grade-bad');

  const st = app.state();
  const k = Object.keys(st.stats)[0];
  // 错的字拖几天才改，孩子多半已经把错的写法记牢了 —— 所以当天就该到期
  assert.ok(st.stats[k].dueAt <= Date.now() + 1000, '写错了应当当天就可以再练一次');
});

test('批改完孩子马上能看到结果和家长的批注', () => {
  const app = boot({ passcode: '1234' });
  app.click('start');
  app.draw();
  app.click('submit');

  app.click('parent');
  app.type('passInput', '1234');
  app.click('unlock');
  app.type('noteInput', '崩少了山字头');
  app.click('grade-ok');

  assert.strictEqual(app.state().feedback.length, 1, '批改结果应当立刻摆给孩子看');

  app.click('home');
  const html = app.html();
  assert.ok(html.includes('家长刚批改了'), '首页应当显示批改结果');
  assert.ok(html.includes('崩少了山字头'), '家长的批注要给孩子看到');

  app.click('ack-feedback');
  assert.strictEqual((app.state().feedback || []).length, 0, '点「知道了」之后应当清掉');
});

test('没批改的题不进统计（不能拿没批的东西算掌握度）', () => {
  const app = boot();
  app.click('start');
  app.draw();
  app.click('submit');
  assert.strictEqual(app.state().pending.length, 1);
  assert.deepStrictEqual(app.state().stats, {}, '没批改就不该有任何统计');
});

/* ==================== 资料查阅 ==================== */

test('资料页能打开，三类内容都显示出来', () => {
  const app = boot();
  app.click('ref');
  const html = app.html();
  assert.ok(html.includes('二类字'), '应当显示二类字（识字表）');
  assert.ok(html.includes('多音字'), '应当显示多音字');
  assert.ok(html.includes('易错字'), '应当显示易错字');
});

test('资料页的二类字来自数据，不是空壳', () => {
  const app = boot();
  app.click('ref');
  // U1 第1课的二类字里有「盐」（PDF 里是 yWn→yán），应当出现在页面上
  assert.ok(app.html().includes('盐'), '二类字应当从 data.js 渲染出来');

  // 多音字、易错字也都应当有具体内容
  const u1 = Data.byId('U1');
  assert.ok(u1.polyphone.length > 0, 'U1 有多音字数据');
  assert.ok(u1.tricky.length > 0, 'U1 有易错字数据');
  assert.ok(app.html().includes(u1.polyphone[0].char), '多音字的字应当渲染出来');
  assert.ok(app.html().includes(u1.tricky[0].slice(0, 2)), '易错字应当渲染出来');
});

/* ==================== 识字表数据完整性 ==================== */

test('识字表应与课本网格一致：共 265 个字（含「脏」两种读音各算一次）', () => {
  const Data = require('../js/data.js');
  let all = [];
  Data.UNITS.forEach(u => u.lessons.forEach(l => { all = all.concat(l.shizi.map(s => s.c)); }));
  assert.strictEqual(all.length, 265, '课本识字表网格实际印 265 个字');
  // 课本标注「共250个生字」是去掉 15 个蓝色多音字后的数；网格本身是 265
  assert.strictEqual(all.filter(c => c === '脏').length, 2, '「脏」在识字表里按 zāng/zàng 出现两次');
});

test('四个语文园地的二类字必须各自独立，不能互相覆盖', () => {
  const Data = require('../js/data.js');
  const gardens = [];
  Data.UNITS.forEach(u => u.lessons.forEach(l => {
    if ((l.title || '').includes('园地') && l.shizi.length) gardens.push(l.shizi.map(s => s.c).join(''));
  }));
  assert.strictEqual(gardens.length, 4, '应有 4 个语文园地');
  // 互不覆盖：任意两个园地的字集合不应完全相同
  for (let i = 0; i < gardens.length; i++) {
    for (let j = i + 1; j < gardens.length; j++) {
      assert.notStrictEqual(gardens[i], gardens[j], '园地之间不应互相覆盖');
    }
  }
  // 园地4 的「韭芹椒蒜薯藕芋姜」不应出现在其它园地
  const g4 = gardens.find(g => g.includes('韭'));
  assert.ok(g4, '应存在含「韭」的园地（园地4）');
  assert.ok(!gardens.filter(g => g !== g4).some(g => g.includes('韭')), '园地4 的字不应泄漏到别的园地');
});

/* ==================== 练习模式 & 田字格 ==================== */

// 轻点：极短落笔（写 i、j 的"点"就是这样），不应清空任何东西
function tap(app, x, y) {
  const c = app.canvas;
  const fire = (t, X, Y) => (c._ptr[t] || []).forEach(fn => fn({ clientX: X, clientY: Y, pointerId: 1, preventDefault: noop }));
  fire('pointerdown', x, y);
  fire('pointerup', x, y);
}

// 长按：按住不动再抬手，用来清空某一格
function longPress(app, x, y) {
  const c = app.canvas;
  const fire = (t, X, Y) => (c._ptr[t] || []).forEach(fn => fn({ clientX: X, clientY: Y, pointerId: 1, preventDefault: noop }));
  fire('pointerdown', x, y);
  app.flushTimers();   // 放行"长按"定时器
  fire('pointerup', x, y);
}

test('首页有两种练习模式，可切到「看词语写拼音」', () => {
  const app = boot();
  assert.ok(app.html().includes('看拼音写词语'), '默认应是看拼音写词语');
  assert.ok(app.html().includes('看词语写拼音'), '应当有看词语写拼音入口');
  app.click('mode', { m: 'word2py' });
  assert.strictEqual(app.state().mode, 'word2py', '模式要切过去并记住');
  app.click('start');
  assert.ok(app.html().includes('看词语写拼音'), '练习题干应提示看词语写拼音');
});

test('看词语写拼音模式写的题，会带上模式标签', () => {
  const app = boot();
  app.click('mode', { m: 'word2py' });
  app.click('start');
  app.draw();
  app.click('submit');
  const item = app.state().pending[0].item;
  assert.strictEqual(item.mode, 'word2py', '提交的题应当记下当时用的模式');
});

test('按课练习：该课字词全部排出，不再只出 10 个（看拼音写词语）', () => {
  const app = boot();
  app.click('unit', { u: 'U1' });
  app.click('lesson', { l: '1' });
  app.click('start');
  const ln = Data.byId('U1').lessons.find(l => l.no === 1);
  const total = ln.words.length + ln.chars.length;
  assert.ok(total > 10, '用例前提：第 1 课的字词应当多于 10 个（否则测不出上限问题）');
  assert.ok(app.html().includes('1/' + total), `应当按课全出，共 ${total} 题`);
});

test('按课练习：看词语写拼音模式同样全部排出', () => {
  const app = boot();
  app.click('unit', { u: 'U1' });
  app.click('lesson', { l: '1' });
  app.click('mode', { m: 'word2py' });
  app.click('start');
  const ln = Data.byId('U1').lessons.find(l => l.no === 1);
  const total = ln.words.length + ln.chars.length;
  assert.ok(app.html().includes('1/' + total), `看词语写拼音也应全出，共 ${total} 题`);
});

test('看词语写拼音模式，家长批改时题干是字词、答案是拼音', () => {
  const app = boot({ passcode: '1234' });
  app.click('mode', { m: 'word2py' });
  app.click('start');
  app.draw();
  app.click('submit');

  app.click('parent');
  app.type('passInput', '1234');
  app.click('unlock');

  const it = app.state().pending[0].item;
  assert.ok(app.html().includes(it.text), '题干应当显示字词本身');
  assert.ok(app.html().includes('正确答案'), '应当显示正确答案');
  assert.ok(app.html().includes(it.py), '正确答案应当是拼音');
});

test('长按某个格子，只清空那一个字（不是整张重写）', () => {
  const app = boot();
  app.click('unit', { u: 'U1' });
  app.click('lesson', { l: '1' }); // 观潮，单字练习，n=1
  app.click('start');
  app.draw();                       // 拖拽写一笔
  longPress(app, 30, 50);           // 长按第 1 格 → 单独清空它
  // 唯一一格被清掉后就没笔迹了，应当交不上
  app.click('submit');
  assert.ok(app.html().includes('先在田字格里写一下'), '清空唯一一格后应当交不上');
  assert.strictEqual((app.state().pending || []).length, 0, '清空后不该进待批改');
});

test('轻点一下（写拼音 i、j 的点）不会误清空格子', () => {
  const app = boot();
  app.click('unit', { u: 'U1' });
  app.click('lesson', { l: '1' }); // 单字练习，n=1
  app.click('start');
  app.draw();                       // 先写一笔
  tap(app, 60, 25);                 // 再轻点一下当"点" —— 不能被当成清空
  app.click('submit');
  const st = app.state();
  assert.strictEqual((st.pending || []).length, 1, '轻点写了个点，笔迹应当还在、能交上去');
  assert.ok(st.pending[0].strokes.length >= 2, '点的笔迹也要留在格子里');
});

/* ==================== 组词训练 ==================== */

test('资料页有练组词入口', () => {
  const app = boot();
  app.click('ref');
  assert.ok(app.html().includes('开始练组词'), '资料页应当有练组词入口');
});

test('练组词进练习：题干是字、每词一行 4 格、不显示答案', () => {
  const app = boot();
  app.click('ref');
  app.click('start-zuci');
  const html = app.html();
  assert.ok(html.includes('给它组 2 个词'), '应当提示"组两个词"');
  assert.ok(html.includes('zuci-char'), '应当用组词题干样式显示那个字');
  assert.ok(html.includes('一行写一个词'), '应说明每行写一个词（词有 2~4 字，不能只留 2 格）');
  assert.ok(!html.includes('每词一般两字'), '不应再写死"每词一般两字"');
  assert.ok(!html.includes('参考答案'), '练习页不应提前显示答案标签');
  assert.ok(!html.includes('食盐'), '练习页不应显示组词参考（如「食盐」）');
  // 8 格若按"每行 4 格"排是 2 行（画布高 166px）；若没传每行格数会排成 3 行、高得多
  assert.strictEqual(app.canvas.style.height, '166px', '组词格应排成每行 4 格、共 2 行');
});

test('组词提交后，家长批改页显示组词参考', () => {
  const app = boot({ passcode: '1234' });
  app.click('ref');
  app.click('start-zuci');
  app.draw();
  app.click('submit');

  const item = app.state().pending[0].item;
  assert.strictEqual(item.kind, 'z', '组词题的 kind 应为 z');
  assert.strictEqual(item.mode, 'zuci', '组词题应当标 zuci 模式');
  assert.ok(item.zuci && item.zuci.length >= 2, '应当带至少 2 个组词参考');
  assert.strictEqual(item.cells, 8, '2 个词 × 每词 4 格 = 8 格');
  assert.strictEqual(item.perRow, 4, '每行 4 格，4 字成语也放得下');

  app.click('parent');
  app.type('passInput', '1234');
  app.click('unlock');

  const html = app.html();
  assert.ok(html.includes('参考答案'), '批改页应当标「参考答案」');
  assert.ok(html.includes(item.zuci[0]), '批改页应当显示具体组词：' + item.zuci[0]);
});

