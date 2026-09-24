/*
 * 跨设备同步测试（语文）
 *
 * 盯的都是"跑不通就出事"的地方：
 *  1. 笔迹必须按格子存 —— 平板写的字要在手机上回放，存像素坐标就会偏出格子，
 *     家长看到的就不是孩子写的那个字。
 *  2. 家长在别处批的结果回到本机：出队、进历史、更新复习排期、批注带回来。
 *  3. 同一条不能被算两遍（幂等）。
 *  4. 没开家庭码时一次网络请求都不许发 —— 这个项目原本是纯本地的。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const KEY = 'chinese-coach-v1';
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

function boot() {
  const els = { app: makeEl('app') };
  const canvas = makeCanvas('writeCanvas');
  const review = makeCanvas('reviewCanvas');
  const bag = {};
  const calls = [];      // 记下所有发给云函数的请求

  const sandbox = {
    console,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
    localStorage: {
      getItem: k => (k in bag ? bag[k] : null),
      setItem: (k, v) => { bag[k] = String(v); },
      removeItem: k => { delete bag[k]; }
    },
    document: {
      readyState: 'complete',
      activeElement: { tagName: 'BODY' },
      getElementById: id => els[id] || (id === 'writeCanvas' ? canvas : (id === 'reviewCanvas' ? review : null)),
      addEventListener: noop
    },
    scrollTo: noop,
    confirm: () => true,
    alert: noop,
    addEventListener: noop,
    visualViewport: { addEventListener: noop },
    requestAnimationFrame: fn => fn(),
    // 云函数替身：把请求记下来，永远返回成功
    fetch: (url, opts) => {
      calls.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 0, data: {} }) });
    },
    Date, Math, JSON, Promise, Object, Array, String, Number, Error
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  ['data', 'recite', 'jiaoan', 'store', 'cloud', 'app'].forEach(name => {
    const file = path.join(ROOT, 'js', name + '.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  });

  function click(dataAct, attrs) {
    const handler = els.app._click[0];
    const a = { 'data-act': dataAct };
    Object.keys(attrs || {}).forEach(k => { a[k.indexOf('data-') === 0 ? k : 'data-' + k] = attrs[k]; });
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
    els.app._input[0]({ target: { id, value } });
  }

  function draw() {
    const fire = (t, x, y) => (canvas._ptr[t] || []).forEach(fn => fn({
      pointerId: 1, clientX: x, clientY: y, preventDefault: noop
    }));
    fire('pointerdown', 30, 30);
    fire('pointermove', 60, 50);
    fire('pointerup', 60, 50);
  }

  return { sandbox, els, calls, click, type, draw, bag };
}

function flush() { return new Promise(r => setImmediate(r)); }

test('笔迹按格子存：存下来的是 u/v，不是像素', () => {
  const t = boot();
  t.click('start');
  t.draw();
  t.click('submit');

  const p = t.sandbox.__cc.app.state.pending[0];
  assert.ok(p.strokes.length, '写一提交就该有笔迹');
  const pt = p.strokes[0].pts[0];
  assert.strictEqual(typeof pt.u, 'number', '必须存归一化坐标');
  assert.strictEqual(typeof pt.v, 'number');
  assert.strictEqual(pt.x, undefined, '像素坐标不该进存储 —— 跨设备回放会错位');
  // 运行时字段也不该带上去
  assert.deepStrictEqual(Object.keys(p.strokes[0]).sort(), ['cell', 'pts']);
});

test('跨屏宽回放：同一个字落在同一个格子的同一个位置', () => {
  const t = boot();
  const { cellLayout, pointXY } = t.sandbox.__cc;

  // 平板 700px 宽、手机 320px 宽，同一个 5 字词（每行 3 格）、第 3 格、格内 (0.5, 0.5)
  // 用 5 个字是因为：4 字及以下时格子有 118px 上限，两种屏宽算出来恰好一样大，
  // 看不出差别；字一多，窄屏的格子是真的小一圈 —— 这才是要归一化的理由。
  const geos = [700, 320].map(W => {
    const L = cellLayout(5, W, 'tian', 0);
    return { n: 5, W, H: L.pad * 2 + L.rows * L.h + (L.rows - 1) * L.gap, L };
  });

  const at = geos.map(g => {
    const cell = 2;
    const col = cell % g.L.cols, row = Math.floor(cell / g.L.cols);
    const ox = g.L.pad + col * (g.L.w + g.L.gap);
    const oy = g.L.pad + row * (g.L.h + g.L.gap);
    const p = pointXY({ u: 0.5, v: 0.5 }, { cell }, g);
    return { u: (p.x - ox) / g.L.w, v: (p.y - oy) / g.L.h };
  });

  // 两台设备上还原出来的相对位置必须一致（都落在格子正中）
  assert.ok(Math.abs(at[0].u - 0.5) < 1e-6 && Math.abs(at[0].v - 0.5) < 1e-6);
  assert.ok(Math.abs(at[1].u - 0.5) < 1e-6 && Math.abs(at[1].v - 0.5) < 1e-6);
  assert.ok(geos[0].L.w > geos[1].L.w, '窄屏的格子确实小一圈，这正是要归一化的原因');
});

test('历史笔迹（像素格式）照原样回放，不会变成乱线', () => {
  const t = boot();
  const { pointXY, cellLayout } = t.sandbox.__cc;
  const L = cellLayout(4, 360, 'tian', 0);
  const geo = { n: 4, W: 360, H: 100, L };
  const p = pointXY({ x: 12, y: 34 }, { cell: 0 }, geo);
  assert.strictEqual(p.x, 12);
  assert.strictEqual(p.y, 34);
});

test('家长在别处批的结果回到本机：出队、进历史、批注带回来', () => {
  const t = boot();
  t.click('start');
  t.draw();
  t.click('submit');

  const app = t.sandbox.__cc.app;
  const id = app.state.pending[0].id;
  assert.strictEqual(app.state.history.length, 0, '没批改就不该进历史');

  t.sandbox.__cc.applyRemoteGrades([{ id: id, ok: false, note: '崩少了山字头' }]);

  assert.strictEqual(app.state.pending.length, 0, '批完要出队');
  assert.strictEqual(app.state.history.length, 1);
  assert.strictEqual(app.state.history[0].isCorrect, false);
  assert.strictEqual(app.state.history[0].note, '崩少了山字头');
  assert.strictEqual(app.state.feedback.length, 1, '结果要立刻摆给孩子看');
  assert.strictEqual(app.state.feedback[0].note, '崩少了山字头');
  const stat = app.state.stats[app.state.history[0].key];
  assert.strictEqual(stat.wrongs, 1);
  assert.strictEqual(stat.dueAt <= Date.now(), true, '写错了当天就到期，可以马上订正');
});

test('同一条不会被算两遍（幂等）：认不出来的 id 直接跳过', () => {
  const t = boot();
  t.click('start');
  t.draw();
  t.click('submit');

  const app = t.sandbox.__cc.app;
  const id = app.state.pending[0].id;
  t.sandbox.__cc.applyRemoteGrades([{ id: id, ok: true, note: '' }]);
  assert.strictEqual(app.state.history.length, 1);

  // 同一条又传了一次（云端还没收到 ack、或家长在另一台又批了一遍）
  t.sandbox.__cc.applyRemoteGrades([{ id: id, ok: false, note: '又批一次' }]);
  assert.strictEqual(app.state.history.length, 1, '掌握度不能被算两遍');
  assert.strictEqual(app.state.history[0].isCorrect, true, '先落地的那次为准');
});

test('没开家庭码：一次网络请求都不发，还是原来那个纯本地项目', async () => {
  const t = boot();
  t.click('start');
  t.draw();
  t.click('submit');
  t.click('parent');
  t.type('passInput', '1234');
  t.click('set-pass');
  t.click('grade-bad');
  await flush();

  assert.strictEqual(t.calls.length, 0, '没开家庭码就不该联网');
  assert.strictEqual(t.sandbox.__cc.app.state.history.length, 1, '本地批改照常生效');
});

test('开了家庭码：批改会传上去，别处写的作业不进本机统计', async () => {
  const t = boot();
  const app = t.sandbox.__cc.app;

  // 开启同步（模拟家长在报告页生成了家庭码）
  t.sandbox.FamilySync.enable('k3f9-7wq2-xm4p');
  assert.ok(t.sandbox.FamilySync.on());

  // 本机先清空 pending，再放一条"别的设备"传上来的作业
  app.state.pending = [];
  const other = {
    id: 'other-1', ts: Date.now(), dev: 'otherdev', devName: '平板',
    item: { kind: 'w', text: '奇观', py: 'qí guān', unit: 'U1', mode: 'py2word' },
    strokes: []
  };
  app.cloudWork = [other];

  const q = t.sandbox.__cc.gradingQueue();
  assert.strictEqual(q.length, 1);
  assert.strictEqual(q[0].dev, 'otherdev');

  t.click('parent');
  t.type('passInput', '1234');
  t.click('set-pass');
  t.click('grade-bad');
  await flush();

  const push = t.calls.filter(c => c.action === 'grade.push');
  assert.strictEqual(push.length, 1, '批改要传上去');
  assert.strictEqual(push[0].grades[0].dev, 'otherdev', '结果要送回产出它的那台设备');
  assert.strictEqual(push[0].grades[0].ok, false);

  // 别的设备上写的字：复习排期在那台设备上算，本机不记
  assert.strictEqual(app.state.history.length, 0);
  assert.strictEqual(app.state.feedback.length, 0);
  assert.strictEqual(app.cloudWork.length, 0, '批完就从队列里划掉');
});

test('作业是整轮写完才传一次，不是写一个传一个', async () => {
  const t = boot();
  t.sandbox.FamilySync.enable('k3f9-7wq2-xm4p');
  t.click('start');

  // 一课的字太多，截成 2 条好把这一轮跑完
  const app = t.sandbox.__cc.app;
  app.session = [app.session[0], app.session[1]];

  t.draw();
  t.click('submit');
  await flush();
  assert.strictEqual(t.calls.filter(c => c.action === 'work.push').length, 0,
    '写到一半不该传 —— 家长这会儿也来不及批');

  t.draw();
  t.click('submit');
  await flush();

  const pushes = t.calls.filter(c => c.action === 'work.push');
  assert.strictEqual(pushes.length, 1, '整轮写完才传，而且只传一次');
  assert.strictEqual(pushes[0].items.length, 2, '两条一起传上去');
});

test('写到一半退出：已经写的那几条也要传上去', async () => {
  const t = boot();
  t.sandbox.FamilySync.enable('k3f9-7wq2-xm4p');
  t.click('start');
  t.draw();
  t.click('submit');
  await flush();
  assert.strictEqual(t.calls.filter(c => c.action === 'work.push').length, 0);

  t.click('quit');
  await flush();
  assert.strictEqual(t.calls.filter(c => c.action === 'work.push').length, 1,
    '中途退出不能把刚写的那几条落下');
});

test('家庭码格式不对：等于没开，也不会发请求（不能出现"开着但永远失败"）', async () => {
  const t = boot();
  assert.strictEqual(t.sandbox.FamilySync.enable('abc'), false, '格式不对就开不了');
  assert.strictEqual(t.sandbox.FamilySync.enable('1234'), false);
  assert.strictEqual(t.sandbox.FamilySync.on(), false);

  t.click('start');
  t.draw();
  t.click('submit');
  await flush();
  assert.strictEqual(t.calls.length, 0, '没开就一次请求都不发');

  // 换成正确的码就能开
  assert.strictEqual(t.sandbox.FamilySync.enable('k3f9-7wq2-xm4p'), true);
  assert.strictEqual(t.sandbox.FamilySync.on(), true);
});

test('上传失败：dirty 恢复，下一次 flush 把积压的带走', async () => {
  const t = boot();
  t.sandbox.FamilySync.enable('k3f9-7wq2-xm4p');

  // 第一次：网络断了
  t.sandbox.fetch = (url, opts) => {
    t.calls.push(JSON.parse(opts.body));
    return Promise.reject(new Error('网络断了'));
  };
  t.click('start');
  t.draw();
  t.click('submit');
  t.click('quit');   // 中途退出 → 触发上传（整轮没写完，得靠退出）
  await flush();

  assert.strictEqual(t.calls.filter(c => c.action === 'work.push').length, 1, '发过了，但没成功');
  assert.strictEqual(t.sandbox.FamilySync.isDirty(), true, '失败要把 dirty 恢复回来');
  assert.ok(t.sandbox.FamilySync.statusText().indexOf('切到后台再回来') >= 0,
    '得给家长一条自己能动手恢复的路');

  // 第二次：网好了，再传一次
  t.sandbox.fetch = (url, opts) => {
    t.calls.push(JSON.parse(opts.body));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 0, data: {} }) });
  };
  await t.sandbox.FamilySync.flushWork();

  assert.strictEqual(t.calls.filter(c => c.action === 'work.push').length, 2, '补传了一次');
  assert.strictEqual(t.sandbox.FamilySync.isDirty(), false, '传完就不再脏了');
});

// 造几条待批改的本机作业（题目字段够批改页渲染就行）
function seedPending(app, n) {
  app.state.pending = [];
  for (var i = 0; i < n; i++) {
    app.state.pending.push({
      id: 'p' + i, ts: Date.now() + i, unit: 'U1',
      item: { kind: 'w', text: '字' + i, py: 'zì', mode: 'py2word', unit: 'U1' },
      strokes: []
    });
  }
}

test('批改攒一批才传：批 3 条只发一次请求', async () => {
  const t = boot();
  const app = t.sandbox.__cc.app;
  t.sandbox.FamilySync.enable('k3f9-7wq2-xm4p');
  seedPending(app, 3);

  t.click('parent');
  t.type('passInput', '1234');
  t.click('set-pass');

  t.click('grade-ok');
  await flush();
  t.click('grade-ok');
  await flush();
  assert.strictEqual(t.calls.filter(c => c.action === 'grade.push').length, 0, '还没批完就不传');

  t.click('grade-bad');
  await flush();

  const pushes = t.calls.filter(c => c.action === 'grade.push');
  assert.strictEqual(pushes.length, 1, '这一批批完一起传，而且只传一次');
  assert.strictEqual(pushes[0].grades.length, 3, '三条一起发出去');
  assert.strictEqual(pushes[0].grades[2].ok, false);
});

test('批到一半离开批改页：攒下的也要传走，不能丢', async () => {
  const t = boot();
  const app = t.sandbox.__cc.app;
  t.sandbox.FamilySync.enable('k3f9-7wq2-xm4p');
  seedPending(app, 3);

  t.click('parent');
  t.type('passInput', '1234');
  t.click('set-pass');
  t.click('grade-ok');
  await flush();
  assert.strictEqual(t.calls.filter(c => c.action === 'grade.push').length, 0);

  t.click('home');   // 批到一半走了
  await flush();
  const pushes = t.calls.filter(c => c.action === 'grade.push');
  assert.strictEqual(pushes.length, 1, '离开批改页要把攒下的传走');
  assert.strictEqual(pushes[0].grades.length, 1);
});

test('两个家长同时批同一条：先到的为准，后到的要说一句', async () => {
  const t = boot();
  const app = t.sandbox.__cc.app;
  t.sandbox.FamilySync.enable('k3f9-7wq2-xm4p');
  seedPending(app, 1);

  // 服务端说：这条别人已经批过了（先到为准，我这条没生效）
  t.sandbox.fetch = () => Promise.resolve({
    ok: true, json: () => Promise.resolve({ code: 0, data: { applied: 0, dup: 1 } })
  });

  t.click('parent');
  t.type('passInput', '1234');
  t.click('set-pass');
  t.click('grade-ok');
  await flush();

  assert.ok(app.cloudMsg.indexOf('另一台设备批过') >= 0, '要告诉家长这条别人已经批了');
  assert.ok(t.els.app.innerHTML.indexOf('另一台设备批过') >= 0, '批改页上看得见这句');
});

test('家长在自己手机上看报告：本机一条记录都没有，也能看到孩子那台设备练的', async () => {
  const t = boot();
  const app = t.sandbox.__cc.app;

  // 这台设备（家长的手机）从没练过
  app.state.history = [];
  t.sandbox.FamilySync.enable('k3f9-7wq2-xm4p');

  // 云端只有孩子那台设备上传的快照
  t.sandbox.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      code: 0,
      data: {
        reports: [{
          dev: 'otherdev', ts: Date.now(),
          snapshot: {
            devName: '平板',
            history: [
              { ts: Date.now() - 1000, key: 'w:奇观', text: '奇观', py: 'qíguān', isCorrect: false, note: '崩少了山字头', unit: 'U1' },
              { ts: Date.now(), key: 'w:逐渐', text: '逐渐', py: 'zhújiàn', isCorrect: true, unit: 'U1' }
            ],
            stats: {}
          }
        }]
      }
    })
  });

  t.click('parent');
  t.type('passInput', '1234');
  t.click('set-pass');
  t.click('report');
  await flush();

  const html = t.els.app.innerHTML;
  assert.ok(html.indexOf('奇观') >= 0, '报告里要出现孩子练过的词');
  assert.ok(html.indexOf('50%') >= 0, '2 条对 1 条 = 50%');
  assert.ok(html.indexOf('崩少了山字头') >= 0, '家长的批注也要看得到');
});

test('统计快照：只带最近 200 条历史，不把全量搬上去', () => {
  const t = boot();
  const app = t.sandbox.__cc.app;
  app.state.history = [];
  for (let i = 0; i < 500; i++) {
    app.state.history.push({ ts: Date.now(), key: 'w:字' + i, text: '字' + i, isCorrect: i % 2 === 0, unit: 'U1' });
  }
  const snap = t.sandbox.__cc.reportSnapshot();
  assert.strictEqual(snap.history.length, 200);
  assert.strictEqual(snap.history[snap.history.length - 1].text, '字499', '留最近的那 200 条');
  assert.ok(snap.devName, '带个设备名，家长才分得清是哪一台');
});
