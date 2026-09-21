/*
 * 语文小教练 —— 界面层
 *
 * 和数学那边最大的不同：**写字题不交给程序判。**
 *
 * 原因很实在：网页没法强制调出手机的手写输入法，网页内做手写识别
 * 要么塞一个几十 MB 的模型（离线就废了），要么把孩子写的字传到别人服务器上。
 * 所以流程改成：孩子真的手写 → 笔迹存下来 → 家长回头批改。
 *
 * 这样反而更好：家长看到的是孩子真实写的那个字，能看出笔画错、结构歪、
 * 少个偏旁 —— 这是自评看不到的，也是识别程序判断不准的。
 *
 * 几个刻意的选择：
 *  1. 写完**不显示答案**。一显示就变成自评了，那还不如让孩子直接对答案抄。
 *  2. 没批改的题**不计入掌握度**，不然"做了但没批"会把数据搅浑。
 *  3. 间隔复习（1/2/4/7/15 天）才是这个模块的重点 —— 生字最怕的就是
 *     "今天会写、下周就忘"，题量反而是次要的。
 */
(function () {
  'use strict';

  var D = window.ChineseData;
  var S = window.Store;

  // 间隔复习阶梯：答对就往后推一档，答错退回第一天
  var REVIEW_STEPS = [1, 2, 4, 7, 15];
  // 组词练习每轮题数上限。正式的字词练习（看拼音写词语 / 看词语写拼音）
  // 已改为"按课全出"，不再使用这个上限。
  var SESSION_SIZE = 10;
  var DAY = 24 * 60 * 60 * 1000;

  var app = {
    state: null,
    view: 'home',
    session: null,
    cursor: 0,
    strokes: [],
    drawing: false,
    parentUnlocked: false,
    passInput: '',
    note: '',
    message: ''
  };

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ============================== 出题 ============================== */
  function keyOf(it) { return it.kind + ':' + it.text; }

  function lessonLabel(ln) {
    return ln.no ? ('第 ' + ln.no + ' 课') : '语文园地';
  }

  // 按"课时"取题，不只按单元 —— 孩子得知道自己在练哪一课的字词。
  // lesson 传 'all' 就是整个单元。
  function itemsForLesson(unitId, lesson) {
    var u = D.byId(unitId);
    if (!u) return [];
    var out = [];
    u.lessons.forEach(function (ln) {
      if (lesson !== 'all' && String(ln.no) !== String(lesson)) return;
      ln.words.forEach(function (w) {
        out.push({ kind: 'w', text: w.w, py: w.p.join(' '), no: ln.no, title: ln.title });
      });
      ln.chars.forEach(function (c) {
        out.push({ kind: 'c', text: c.c, py: c.p, no: ln.no, title: ln.title });
      });
    });
    return out;
  }

  // 组词训练：只从二类字（识字表）出题。
  // 词语长度不统一（2~4 字都常见，成语是 4 字），所以不能写死"每词 2 格"：
  // 每个词单独占一行、每行预留 4 格 —— 2 字、3 字、4 字都写得下，写不满的空着即可。
  var ZUCI_WORDS = 2;      // 每个字组 2 个词
  var ZUCI_PER_ROW = 4;    // 每个词一行、最多 4 格
  function itemsForZuci(unitId, lesson) {
    var u = D.byId(unitId);
    if (!u) return [];
    var out = [];
    u.lessons.forEach(function (ln) {
      if (lesson !== 'all' && String(ln.no) !== String(lesson)) return;
      (ln.shizi || []).forEach(function (s) {
        if (!s.zuci || !s.zuci.length) return;
        out.push({
          kind: 'z', text: s.c, py: s.p, zuci: s.zuci,
          words: ZUCI_WORDS, perRow: ZUCI_PER_ROW, cells: ZUCI_WORDS * ZUCI_PER_ROW,
          no: ln.no, title: ln.title
        });
      });
    });
    return out;
  }

  function itemsForUnit(unitId) { return itemsForLesson(unitId, 'all'); }

  function mulberry32(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(rng, arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // 到期的先练（这是间隔复习的意义），再补没学过的，最后才是其余的。
  // 不再限制每轮题数：练哪一课，就把那一课（或那个单元）的字词全部排上，
  // 不再只出 10 个 —— 免得一课的常用词被随机漏掉。
  function buildSession(unitId, lesson) {
    var all = itemsForLesson(unitId, lesson);
    var rng = mulberry32((Date.now() ^ (all.length * 2654435761)) >>> 0);
    var st = app.state.stats || {};
    var now = Date.now();

    var due = [], fresh = [], rest = [];
    all.forEach(function (it) {
      var r = st[keyOf(it)];
      if (!r) fresh.push(it);
      else if (r.dueAt && r.dueAt <= now) due.push(it);
      else rest.push(it);
    });

    return shuffle(rng, due)
      .concat(shuffle(rng, fresh), shuffle(rng, rest));
  }

  function dueAtFor(level) {
    var d = REVIEW_STEPS[Math.min(level, REVIEW_STEPS.length - 1)];
    return Date.now() + d * DAY;
  }

  /* ============================== 田字格画笔 ============================== */
  // 格子怎么排：四个字并排会窄得没法写，所以
  //   1~3 个字 → 一行；4 个字 → 2×2；5 个字以上 → 每行 3 个，往下折行。
  // forceCols：指定每行格数（组词要"一行一个词"，每行固定 4 格）
  function cellLayout(n, W, type, forceCols) {
    var cols = forceCols || (n <= 3 ? n : (n === 4 ? 2 : 3));
    var rows = Math.ceil(n / cols);
    var pad = 10, gap = 8;
    var avail = (W - pad * 2 - gap * (cols - 1)) / cols;
    var w, h;
    if (type === 'pinyin') {
      // 拼音格更宽：一个音节占一格，大约 1.9:1
      h = Math.round(Math.min(64, Math.max(46, avail / 1.9)));
      w = Math.min(avail, Math.round(h * 1.9));
    } else {
      var side = Math.floor(Math.min(avail, 118));
      w = h = Math.max(side, 46);
    }
    return { cols: cols, rows: rows, pad: pad, gap: gap, w: w, h: h, type: type || 'tian' };
  }

  function drawCells(ctx, n, W, type, forceCols) {
    var L = cellLayout(n, W, type, forceCols);
    for (var i = 0; i < n; i++) {
      var c = i % L.cols, r = Math.floor(i / L.cols);
      var x = L.pad + c * (L.w + L.gap);
      var y = L.pad + r * (L.h + L.gap);
      if (L.type === 'pinyin') drawPinyinCell(ctx, x, y, L.w, L.h);
      else drawTianCell(ctx, x, y, L.w, L.h);
    }
  }

  function drawTianCell(ctx, x, y, w, h) {
    ctx.save();
    ctx.strokeStyle = '#c9ced6';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, y + h);
    ctx.moveTo(x, y + h / 2); ctx.lineTo(x + w, y + h / 2);
    ctx.stroke();
    ctx.restore();
  }

  // 四线三格：4 条横线 + 浅色外框，第 3 线（基线）稍深、稍粗，字母坐在这一条上
  function drawPinyinCell(ctx, x, y, w, h) {
    ctx.save();
    ctx.strokeStyle = '#d4d8de';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    var lines = [0, h / 3, 2 * h / 3, h];
    for (var k = 0; k < lines.length; k++) {
      ctx.beginPath();
      ctx.moveTo(x, y + lines[k]);
      ctx.lineTo(x + w, y + lines[k]);
      if (k === 2) { ctx.strokeStyle = '#aeb4be'; ctx.lineWidth = 1.6; }
      else { ctx.strokeStyle = '#d4d8de'; ctx.lineWidth = 1; }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawStrokes(ctx, strokes) {
    ctx.strokeStyle = '#e8590c';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    (strokes || []).forEach(function (st) {
      // 兼容两种格式：新格式 {cell, pts}，旧格式（历史笔迹）直接是点数组
      var pts = st && st.pts ? st.pts : st;
      if (!pts || !pts.length) return;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      if (pts.length === 1) ctx.lineTo(pts[0].x + 0.5, pts[0].y + 0.5);
      ctx.stroke();
    });
  }

  function posOf(cv, e) {
    var r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // 每次渲染后都要重来一遍：画布是新的，尺寸也可能变了
  // gridType: 'tian' 田字格（写汉字）；'pinyin' 四线三格（写拼音）
  // forceCols: 每行固定几格（组词用，0/省略则自动排）
  function setupCanvas(cv, n, strokes, editable, gridType, forceCols) {
    if (!cv || typeof cv.getContext !== 'function') return;
    var host = cv.parentNode;
    if (!host) return;
    var W = host.clientWidth;
    if (!W) return;
    // 高度由格子算出来：折行之后要跟着变高，不然下面的格子会被切掉
    var L = cellLayout(n, W, gridType || 'tian', forceCols);
    var H = L.pad * 2 + L.rows * L.h + (L.rows - 1) * L.gap;

    cv.style.height = H + 'px';
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);

    var ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var list = strokes || app.strokes;

    function redraw() {
      ctx.clearRect(0, 0, W, H);
      drawCells(ctx, n, W, gridType || 'tian', forceCols);
      drawStrokes(ctx, list);
    }
    redraw();

    if (!editable) return;

    // 点哪个格子，就只清那个格子的笔迹 —— 可以单独重写某一个字
    function cellAt(pos) {
      for (var i = 0; i < n; i++) {
        var c = i % L.cols, r = Math.floor(i / L.cols);
        var x = L.pad + c * (L.w + L.gap);
        var y = L.pad + r * (L.h + L.gap);
        if (pos.x >= x && pos.x <= x + L.w && pos.y >= y && pos.y <= y + L.h) return i;
      }
      return -1;
    }
    function clearCell(idx) {
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] && list[i].cell === idx) list.splice(i, 1);
      }
    }

    var downPos = null, moved = false, holdTimer = null;

    function stopHold() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    }

    cv.addEventListener('pointerdown', function (e) {
      if (cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (err) {} }
      app.drawing = true;
      downPos = posOf(cv, e);
      moved = false;
      list.push({ cell: cellAt(downPos), pts: [downPos] });
      // 长按（按住不动约 0.55 秒）= 清空该格，单独重写这一个字。
      // 不能再用"轻点"：写拼音时 i、j、ü 的"点"本身就是一次极短的落笔，
      // 轻点会被误判成清空，把刚写好的字母一起抹掉。长按写字时不会发生，就区分开了。
      stopHold();
      holdTimer = setTimeout(function () {
        holdTimer = null;
        if (!app.drawing || moved) return;
        var idx = cellAt(downPos);
        if (idx >= 0) clearCell(idx);
        app.drawing = false; // 这次落笔到此为止，抬手时不再补画
        redraw();
      }, 550);
      redraw();
      e.preventDefault();
    });
    cv.addEventListener('pointermove', function (e) {
      if (!app.drawing) return;
      var p = posOf(cv, e);
      if (Math.abs(p.x - downPos.x) > 4 || Math.abs(p.y - downPos.y) > 4) {
        moved = true;
        stopHold(); // 已经动笔，就不再算"长按清空"
      }
      var st = list[list.length - 1];
      if (st) st.pts.push(p);
      redraw();
      e.preventDefault();
    });
    function endDraw() {
      stopHold();
      if (!app.drawing) return;
      app.drawing = false;
      // 在格子外点了一下（不是写字）：不留痕迹
      var last = list[list.length - 1];
      if (last && last.pts && last.pts.length === 1 && last.cell < 0) list.pop();
    }
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) {
      cv.addEventListener(t, endDraw);
    });
  }

  /* ============================== 视图：首页 ============================== */
  function scopeTitle() {
    var st = app.state;
    var u = D.byId(st.unit);
    if (!u) return '';
    if (st.lesson === 'all') return u.name;
    var hit = null;
    u.lessons.forEach(function (l) { if (String(l.no) === String(st.lesson)) hit = l; });
    if (!hit) return u.name;
    return u.name.split('　')[0] + ' · ' + lessonLabel(hit) + '《' + hit.title + '》';
  }

  function feedbackCard() {
    var fb = app.state.feedback || [];
    if (!fb.length) return '';

    var rows = fb.map(function (f) {
      return '<div class="fb-row">' +
        '<span class="fb-mark ' + (f.isCorrect ? 'ok' : 'bad') + '">' +
        (f.isCorrect ? '✓' : '✗') + '</span>' +
        '<span class="fb-text"><b>' + esc(f.text) + '</b><i>' + esc(f.py) + '</i></span>' +
        (f.note ? '<div class="fb-note">家长说：' + esc(f.note) + '</div>' : '') +
        '</div>';
    }).join('');

    return '<div class="card card-cta">' +
      '<h2 class="card-title">家长刚批改了 ' + fb.length + ' 条</h2>' +
      '<p class="card-note">先看批注，想清楚错在哪 —— 再写一遍的时候别照着正确答案描。</p>' +
      rows +
      '<button class="btn btn-primary btn-block" data-act="ack-feedback">知道了</button>' +
      '</div>';
  }

  function viewHome() {
    var st = app.state;
    var pending = st.pending.length;
    var unit = st.unit;
    var lesson = st.lesson || 'all';

    var unitBtns = D.UNITS.map(function (u) {
      return '<button class="unit-btn' + (unit === u.id ? ' on' : '') +
        '" data-act="unit" data-u="' + esc(u.id) + '">' + esc(u.name.split('　')[0]) + '</button>';
    }).join('');

    var cur = D.byId(unit);
    var lessonBtns = '';
    if (cur) {
      lessonBtns = '<button class="unit-btn' + (lesson === 'all' ? ' on' : '') +
        '" data-act="lesson" data-l="all">整个单元</button>' +
        cur.lessons.map(function (ln) {
          var n = itemsForLesson(unit, ln.no).length;
          var label = lessonLabel(ln) + '《' + ln.title + '》';
          if (!n) {
            return '<span class="lesson-off">' + esc(label) +
              '（' + (ln.star ? '略读课文，无字词' : '本课没有字词') + '）</span>';
          }
          return '<button class="unit-btn' + (String(lesson) === String(ln.no) ? ' on' : '') +
            '" data-act="lesson" data-l="' + esc(ln.no) + '">' +
            esc(label) + '（' + n + '）</button>';
        }).join('');
    }

    var total = itemsForLesson(unit, lesson).length;

    return '' +
      '<div class="hero">' +
      '<h1>语文小教练</h1>' +
      '<p class="hero-sub">部编版 · 四年级上册 · 字词</p>' +
      '</div>' +

      feedbackCard() +

      '<div class="card">' +
      '<h2 class="card-title">练哪个单元</h2>' +
      '<div class="unit-row">' + unitBtns + '</div>' +
      '</div>' +

      '<div class="card">' +
      '<h2 class="card-title">练哪一课</h2>' +
      '<p class="card-note">跟课堂进度走，学到哪一课就练哪一课。</p>' +
      '<div class="unit-row">' + lessonBtns + '</div>' +
      '</div>' +

      '<div class="card card-cta">' +
      '<div class="cta-line">' + esc(scopeTitle()) + '　共 ' + total + ' 条</div>' +
      '<div class="cta-sub">在田字格里写。写完交给家长批改 —— 写完不显示答案。</div>' +
      '<div class="mode-row">' +
      '<button class="mode-btn' + ((app.state.mode || 'py2word') === 'py2word' ? ' on' : '') + '" data-act="mode" data-m="py2word">看拼音写词语</button>' +
      '<button class="mode-btn' + ((app.state.mode || 'py2word') === 'word2py' ? ' on' : '') + '" data-act="mode" data-m="word2py">看词语写拼音</button>' +
      '</div>' +
      '<button class="btn btn-primary btn-lg" data-act="start"' +
      (total ? '' : ' disabled') + '>开始写</button>' +
      '</div>' +

      (pending
        ? '<div class="card card-warn"><div class="cta-line">有 ' + pending +
          ' 条写完的，等家长批改</div>' +
          '<button class="btn btn-soft btn-block" data-act="parent">去批改</button></div>'
        : '') +

      '<div class="card card-quiet">' +
      '<h2 class="card-title">资料</h2>' +
      '<p class="card-note">只读查阅：二类字（识字表）、多音字、易错字。</p>' +
      '<button class="btn btn-ghost btn-block" data-act="ref">二类字 / 多音字 / 易错字</button>' +
      '</div>' +

      '<div class="card card-quiet">' +
      '<h2 class="card-title">家长</h2>' +
      '<button class="btn btn-ghost btn-block" data-act="parent">家长批改' +
      (pending ? '（' + pending + ' 条待批）' : '') + '</button>' +
      '</div>' +

      '<p class="footnote">数据只保存在这台设备上，不会上传。</p>';
  }

  /* ============================== 视图：练习 ============================== */
  function viewPractice() {
    var it = app.session[app.cursor];
    if (!it) return '<div class="card">没有题目。</div>';
    var isZ = it.kind === 'z';
    var n = isZ ? it.cells : it.text.length;
    var total = app.session.length;
    var isPy = !isZ && (app.state.mode || 'py2word') !== 'word2py';
    var stemLabel = isZ ? '给字组词' : (isPy ? '看拼音写' : '看词语写拼音');
    var stemBody = isZ
      ? '<span class="zuci-char">' + esc(it.text) + '</span>' +
        '<span class="zuci-py">' + esc(it.py) + '</span>' +
        '<span class="zuci-tip">给它组 ' + it.words + ' 个词</span>'
      : (isPy ? esc(it.py) : esc(it.text));
    var hint = isZ
      ? ('一行写一个词，共 ' + it.words + ' 个词（每个词 2～4 个字都行，写不满空着即可）')
      : (isPy ? ('共 ' + n + ' 个字') : ('共 ' + n + ' 个音节'));

    // 题目少 -> 进度点；题目多（按课全出后可能几十个）-> 进度条，免得点挤成一团
    var progress = total > 20
      ? '<span class="bar"><i style="width:' + Math.round(app.cursor / total * 100) + '%"></i></span>'
      : app.session.map(function (_, i) {
          var cls = i < app.cursor ? 'dot done' : (i === app.cursor ? 'dot now' : 'dot');
          return '<i class="' + cls + '"></i>';
        }).join('');

    return '' +
      '<div class="topbar">' +
      '<button class="btn-icon" data-act="quit" title="退出">✕</button>' +
      '<div class="dots">' + progress + '</div>' +
      '<span class="topbar-right">' + (app.cursor + 1) + '/' + total + '</span>' +
      '</div>' +

      '<div class="card card-q">' +
      '<div class="lesson-tag">' + esc(it.no ? (lessonLabel({ no: it.no }) + '《' + it.title + '》') : it.title) + '</div>' +
      '<div class="stem"><span class="stem-label">' + stemLabel + '</span>' + stemBody + '</div>' +
      '<div class="write-wrap"><canvas id="writeCanvas"></canvas></div>' +
      '<div class="py-hint">' + hint + '</div>' +
      '<p class="card-note">长按某个格子，可只清空并重写那一个字；写点（i、j 的点）不受影响。</p>' +
      (app.message ? '<div class="feedback info">' + esc(app.message) + '</div>' : '') +
      '<div class="action-row">' +
      '<button class="btn btn-soft" data-act="clear">重写全部</button>' +
      '<button class="btn btn-primary" data-act="submit">写好了</button>' +
      '</div>' +
      '</div>';
  }

  /* ============================== 视图：家长批改 ============================== */
  function viewParent() {
    var st = app.state;

    // 第一次进来先设口令
    if (!st.passcode) {
      return '' +
        '<div class="topbar"><button class="btn-icon" data-act="home">←</button>' +
        '<span class="topbar-title">家长批改</span><span class="topbar-right"></span></div>' +
        '<div class="card">' +
        '<h2 class="card-title">先设一个口令</h2>' +
        '<p class="card-note">孩子要是能自己进去点"全对"，这套就白做了。设个 4～6 位数字。</p>' +
        '<input id="passInput" class="pass-input" type="text" inputmode="numeric" ' +
        'placeholder="输入口令" value="' + esc(app.passInput) + '">' +
        '<div class="action-row"><button class="btn btn-primary" data-act="set-pass">设好，进去批改</button></div>' +
        (app.message ? '<div class="feedback warn">' + esc(app.message) + '</div>' : '') +
        '</div>';
    }

    if (!app.parentUnlocked) {
      return '' +
        '<div class="topbar"><button class="btn-icon" data-act="home">←</button>' +
        '<span class="topbar-title">家长批改</span><span class="topbar-right"></span></div>' +
        '<div class="card">' +
        '<h2 class="card-title">请输入口令</h2>' +
        '<input id="passInput" class="pass-input" type="password" inputmode="numeric" ' +
        'placeholder="家长口令" value="' + esc(app.passInput) + '">' +
        '<div class="action-row"><button class="btn btn-primary" data-act="unlock">确定</button></div>' +
        (app.message ? '<div class="feedback warn">' + esc(app.message) + '</div>' : '') +
        '</div>';
    }

    // 已解锁：逐条批改
    var p = st.pending[0];
    if (!p) {
      return '' +
        '<div class="topbar"><button class="btn-icon" data-act="home">←</button>' +
        '<span class="topbar-title">家长批改</span><span class="topbar-right"></span></div>' +
        '<div class="card">' +
        '<h2 class="card-title">没有待批改的</h2>' +
        '<p class="card-note">孩子写完这里就会出现。最近批过 ' + st.history.length + ' 条。</p>' +
        '</div>' +
        reviewStatsHtml();
    }

    var it = p.item;
    var isZ = it.kind === 'z';
    var isPy = !isZ && (it.mode || 'py2word') !== 'word2py';
    var stemTxt = isZ ? ('给「' + esc(it.text) + '」组词') : (isPy ? esc(it.py) : esc(it.text));
    var ansTxt = isZ ? (it.zuci || []).join('、') : (isPy ? esc(it.text) : esc(it.py));
    return '' +
      '<div class="topbar"><button class="btn-icon" data-act="home">←</button>' +
      '<span class="topbar-title">家长批改</span>' +
      '<span class="topbar-right">待批 ' + st.pending.length + ' 条</span></div>' +

      '<div class="card card-q">' +
      '<div class="stem"><span class="stem-label">题目</span>' + stemTxt + '</div>' +
      '<div class="write-wrap"><canvas id="reviewCanvas"></canvas></div>' +
      '<div class="answer-line">' + (isZ ? '参考答案（家长据此判断）：' : '正确答案：') + '<b>' + ansTxt + '</b></div>' +
      '<input id="noteInput" class="note-input" type="text" placeholder="批注（可选）：比如「崩少了山字头」" ' +
      'value="' + esc(app.note) + '">' +
      '<div class="action-row">' +
      '<button class="btn btn-soft" data-act="grade-bad">写错了</button>' +
      '<button class="btn btn-primary" data-act="grade-ok">写对了</button>' +
      '</div>' +
      '<p class="card-note">批注会跟着这个词存下来，下次复习时会再显示给孩子看。</p>' +
      '</div>' +

      reviewStatsHtml();
  }

  /* ============================== 视图：资料 ============================== */
  // 只读查阅：二类字（识字表，只认不写）、多音字、易错字。
  // 不进练习、不进统计 —— 这些是给"先过一遍、知道易错点在哪"用的。
  function viewRef() {
    var u = D.byId(app.state.unit);
    if (!u) return viewHome();

    function shiziSection() {
      var blocks = u.lessons.map(function (ln) {
        if (!ln.shizi || !ln.shizi.length) return '';
        var cells = ln.shizi.map(function (s) {
          return '<div class="ref-char"><b>' + esc(s.c) + '</b><i>' + esc(s.p) + '</i></div>';
        }).join('');
        return '<div class="ref-sub">' +
          '<div class="ref-sub-title">' + esc(lessonLabel(ln)) + '《' + esc(ln.title) + '》</div>' +
          '<div class="ref-chars">' + cells + '</div></div>';
      }).filter(Boolean).join('');
      return blocks || '<p class="card-note">本单元识字表暂无内容。</p>';
    }

    function polySection() {
      if (!u.polyphone || !u.polyphone.length) return '<p class="card-note">本单元无多音字。</p>';
      return u.polyphone.map(function (p) {
        var reads = p.readings.map(function (r) {
          return '<span class="poly-r"><b>' + esc(r.py) + '</b> ' + esc(r.eg) + '</span>';
        }).join('');
        return '<div class="ref-row"><b class="poly-c">' + esc(p.char) + '</b>' + reads + '</div>';
      }).join('');
    }

    function trickySection() {
      if (!u.tricky || !u.tricky.length) return '<p class="card-note">本单元无易错字提示。</p>';
      return u.tricky.map(function (t) {
        return '<div class="ref-tricky">· ' + esc(t) + '</div>';
      }).join('');
    }

    var unitBtns = D.UNITS.map(function (x) {
      return '<button class="unit-btn' + (app.state.unit === x.id ? ' on' : '') +
        '" data-act="unit" data-u="' + esc(x.id) + '">' + esc(x.name.split('　')[0]) + '</button>';
    }).join('');

    return '' +
      '<div class="topbar"><button class="btn-icon" data-act="home">←</button>' +
      '<span class="topbar-title">资料 · ' + esc(u.name.split('　')[0]) + '</span>' +
      '<span class="topbar-right"></span></div>' +
      '<div class="card"><div class="unit-row">' + unitBtns + '</div></div>' +
      '<div class="card"><h2 class="card-title">二类字（识字表 · 只认不写）</h2>' +
      '<p class="card-note">这些字要求会读、会认、会组词，不要求会写。跟着课堂进度过一遍。</p>' +
      shiziSection() + '</div>' +
      '<div class="card card-cta">' +
      '<div class="cta-line">练组词（二类字）</div>' +
      '<div class="cta-sub">给字组 2 个词，每行写一个词（2～4 个字都行），写在田字格里。组词参考答案只在家长批改时显示，练习时不提示。</div>' +
      '<button class="btn btn-primary btn-block" data-act="start-zuci">开始练组词</button>' +
      '</div>' +
      '<div class="card"><h2 class="card-title">多音字</h2>' + polySection() + '</div>' +
      '<div class="card"><h2 class="card-title">易错字提醒</h2>' + trickySection() + '</div>';
  }

  function reviewStatsHtml() {
    var st = app.state;
    var done = st.history.length;
    if (!done) return '';
    var ok = st.history.filter(function (h) { return h.isCorrect; }).length;
    return '<div class="card card-quiet">' +
      '<h2 class="card-title">批改情况</h2>' +
      '<p class="card-note">已批 ' + done + ' 条，写对 ' + ok + ' 条（' +
      Math.round(ok / done * 100) + '%）。</p>' +
      '</div>';
  }

  /* ============================== 动作 ============================== */
  function startSession() {
    app.session = buildSession(app.state.unit, app.state.lesson);
    app.cursor = 0;
    app.strokes = [];
    app.message = '';
    app.view = 'practice';
    render();
  }

  // 组词训练：从当前单元（或所选课）的二类字出题，写汉字用田字格
  function startZuci() {
    var all = itemsForZuci(app.state.unit, app.state.lesson);
    if (!all.length) {
      app.message = '本单元二类字还没有组词数据，先去资料页看看。';
      return render();
    }
    var rng = mulberry32((Date.now() ^ 0x9e3779b1) >>> 0);
    app.session = shuffle(rng, all).slice(0, SESSION_SIZE);
    app.cursor = 0;
    app.strokes = [];
    app.message = '';
    app.view = 'practice';
    render();
  }

  function submitWriting() {
    if (!app.strokes.length) {
      app.message = '先在田字格里写一下。';
      return render();
    }
    var it = app.session[app.cursor];
    app.state.pending.push({
      id: 'p' + Date.now() + Math.floor(Math.random() * 1000),
      ts: Date.now(),
      unit: app.state.unit,
      item: {
        kind: it.kind,
        text: it.text,
        py: it.py,
        mode: it.kind === 'z' ? 'zuci' : (app.state.mode || 'py2word'),
        zuci: it.zuci,
        cells: it.kind === 'z' ? it.cells : it.text.length,
        perRow: it.kind === 'z' ? it.perRow : 0
      },
      strokes: JSON.parse(JSON.stringify(app.strokes))
    });
    S.save(app.state);

    app.strokes = [];
    app.cursor++;
    app.message = '';
    if (app.cursor >= app.session.length) {
      app.view = 'home';
      app.session = null;
    }
    render();
  }

  function gradeCurrent(isCorrect) {
    var p = app.state.pending[0];
    if (!p) return;
    var k = keyOf(p.item);
    var r = app.state.stats[k] || { attempts: 0, corrects: 0, wrongs: 0, level: 0 };

    r.attempts++;
    if (isCorrect) {
      r.corrects++;
      r.level = Math.min(r.level + 1, REVIEW_STEPS.length - 1);
      r.dueAt = dueAtFor(r.level);
    } else {
      r.wrongs++;
      r.level = 0;
      // 错了就当天到期（可以立刻订正），而不是等到明天。
      // 错的字拖几天才改，孩子多半已经把错的写法记牢了 —— 错误先入为主，
      // 纠正的成本比当时改高得多。
      r.dueAt = Date.now();
    }
    r.lastAt = Date.now();
    if (app.note) r.note = app.note;
    app.state.stats[k] = r;

    // 批改完立刻把结果摆给孩子看。隔几天再看，他早忘了自己当时怎么写的，
    // 家长那句批注也就失去了上下文。
    app.state.feedback.push({
      ts: Date.now(),
      key: k,
      text: p.item.text,
      py: p.item.py,
      isCorrect: !!isCorrect,
      note: app.note || ''
    });

    app.state.history.push({
      ts: Date.now(),
      key: k,
      text: p.item.text,
      py: p.item.py,
      isCorrect: !!isCorrect,
      note: app.note || ''
    });
    if (app.state.history.length > 2000) {
      app.state.history = app.state.history.slice(-2000);
    }

    app.state.pending.shift();
    app.note = '';
    S.save(app.state);
    render();
  }

  /* ============================== 渲染与事件 ============================== */
  function render() {
    var root = el('app');
    var html = app.view === 'practice' ? viewPractice()
      : app.view === 'parent' ? viewParent()
        : app.view === 'ref' ? viewRef()
          : viewHome();
    root.innerHTML = '<div class="view view-' + app.view + '">' + html + '</div>';

    if (app.view === 'practice' && app.session) {
      var it = app.session[app.cursor];
      var isZ = it && it.kind === 'z';
      // 组词写汉字 → 田字格；看词语写拼音 → 拼音格；看拼音写词语 → 田字格
      var nCells = isZ ? (it ? it.cells : 8) : (it ? it.text.length : 1);
      var grid = isZ ? 'tian' : (((app.state.mode || 'py2word') === 'word2py') ? 'pinyin' : 'tian');
      // 组词：每词一行、固定 4 格（2~4 字的词都放得下）
      var zCols = isZ && it ? it.perRow : 0;
      setupCanvas(el('writeCanvas'), nCells, app.strokes, true, grid, zCols);
    }
    if (app.view === 'parent' && app.parentUnlocked && app.state.pending.length) {
      var p0 = app.state.pending[0];
      var pIsZ = p0.item.kind === 'z';
      var pGrid = pIsZ ? 'tian' : (((p0.item.mode || 'py2word') === 'word2py') ? 'pinyin' : 'tian');
      var pN = pIsZ ? (p0.item.cells || 8) : p0.item.text.length;
      var pCols = pIsZ ? (p0.item.perRow || 4) : 0;
      setupCanvas(el('reviewCanvas'), pN, p0.strokes, false, pGrid, pCols);
    }
    window.scrollTo(0, 0);
  }

  function onClick(e) {
    var t = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t) return;
    var act = t.getAttribute('data-act');
    if (typeof t.blur === 'function') t.blur();

    if (act === 'unit') {
      var nu = t.getAttribute('data-u') || 'U1';
      // 换单元就把课时退回"整个单元"，否则会停在上一单元那个课次上，题是空的
      if (nu !== app.state.unit) app.state.lesson = 'all';
      app.state.unit = nu;
      S.save(app.state);
      return render();
    }
    if (act === 'lesson') {
      app.state.lesson = t.getAttribute('data-l') || 'all';
      S.save(app.state);
      return render();
    }
    if (act === 'ack-feedback') {
      app.state.feedback = [];
      S.save(app.state);
      return render();
    }
    if (act === 'mode') { app.state.mode = t.getAttribute('data-m') || 'py2word'; S.save(app.state); return render(); }
    if (act === 'start') return startSession();
    if (act === 'start-zuci') return startZuci();
    if (act === 'home') { app.view = 'home'; app.session = null; return render(); }
    if (act === 'quit') {
      app.view = 'home';
      app.session = null;
      return render();
    }
    if (act === 'clear') { app.strokes = []; app.message = ''; return render(); }
    if (act === 'submit') return submitWriting();
    if (act === 'ref') { app.view = 'ref'; return render(); }
    if (act === 'parent') {
      app.view = 'parent';
      app.passInput = '';
      app.message = '';
      return render();
    }
    if (act === 'set-pass') {
      var v = (app.passInput || '').trim();
      if (!/^\d{4,6}$/.test(v)) {
        app.message = '口令要 4～6 位数字。';
        return render();
      }
      app.state.passcode = v;
      app.parentUnlocked = true;
      S.save(app.state);
      return render();
    }
    if (act === 'unlock') {
      if (app.passInput !== app.state.passcode) {
        app.message = '口令不对。';
        return render();
      }
      app.parentUnlocked = true;
      return render();
    }
    if (act === 'grade-ok') return gradeCurrent(true);
    if (act === 'grade-bad') return gradeCurrent(false);
  }

  function onInput(e) {
    var t = e.target;
    if (!t) return;
    if (t.id === 'passInput') app.passInput = t.value;
    if (t.id === 'noteInput') app.note = t.value;
  }

  function init() {
    app.state = S.load();
    if (!app.state.mode) app.state.mode = 'py2word';
    el('app').addEventListener('click', onClick);
    el('app').addEventListener('input', onInput);
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
