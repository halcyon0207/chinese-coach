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
  var R = window.ReciteData;
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
    parentUnlocked: false,
    passInput: '',
    note: '',
    // 默写/打字题的输入内容。手写题走的是 strokes（笔迹），两套互不干扰。
    typed: '',
    // 这一轮自动判分题的成绩。手写题不统计 —— 它们要等家长批才算数。
    roundOk: 0,
    roundTotal: 0,
    message: '',
    // 存不进去时给家长看的一句话，见 saveState()
    storageWarn: ''
  };

  function el(id) { return document.getElementById(id); }

  // 保存必须看结果。隐私模式、空间满、被沙箱拦住时 setItem 会抛，
  // 只 console.warn 的表现就是"写了一晚上，下次打开全没了"，家长查都查不出来。
  function saveState() {
    if (S.save(app.state)) { app.storageWarn = ''; return true; }
    app.storageWarn = '这台设备现在存不下练习记录（可能是无痕模式或空间已满）。' +
      '今天还能继续练，但关掉页面就不会保存，先告诉家长。';
    return false;
  }

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
        out.push({ kind: 'w', text: w.w, py: w.p.join(' '), no: ln.no, unit: unitId, title: ln.title });
      });
      ln.chars.forEach(function (c) {
        out.push({ kind: 'c', text: c.c, py: c.p, no: ln.no, unit: unitId, title: ln.title });
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
          no: ln.no, unit: unitId, title: ln.title
        });
      });
    });
    return out;
  }

  function itemsForUnit(unitId) { return itemsForLesson(unitId, 'all'); }

  /* ---------- 多音字选择题 ---------- */
  // 素材是现成的：data.js 里每单元都有 polyphone（字 + 每个读音 + 课文里的例子）。
  // 出题方式：拿一个例子问"这个字在这里读什么"，选项就是这个字的全部读音。
  // 不用另外整理资料 —— 当初把它们录进来就是为了这一天。
  function itemsForPoly(unitId) {
    var u = D.byId(unitId);
    if (!u) return [];
    var out = [];
    (u.polyphone || []).forEach(function (p) {
      (p.readings || []).forEach(function (rd) {
        var eg = String(rd.eg || '').split('、')[0].trim();
        if (!eg) return;
        out.push({
          kind: 'p',
          // text 要能唯一标识这道题：统计和复习排队都按 kind + text 记
          text: p.char + '·' + eg,
          char: p.char,
          eg: eg,
          py: rd.py,
          unit: unitId,
          options: (p.readings || []).map(function (x) { return x.py; })
        });
      });
    });
    return out;
  }

  /* ---------- 默写（日积月累 / 古诗）---------- */
  // 每一句一道题：给上一句（第一句给标题）当提示，让孩子把这一句打出来。
  //
  // 用打字而不是手写，是刻意的：默写考的是"记不记得住内容"，
  // 不是"字写得对不对"。"点、出头、包围结构"那些是手写题在管的事，
  // 让默写字字都去手写，孩子一晚上就写不动了，反而练不到"背"。
  function itemsForRecite(unitId) {
    var out = [];
    (R ? R.forUnit(unitId) : []).forEach(function (item) {
      (item.lines || []).forEach(function (line, i) {
        out.push({
          kind: 'r',
          text: line,
          title: item.title,
          py: '',
          // 第一句没有"上一句"可给。原来这里塞的是标题，
          // 孩子看到标题并不知道该从哪儿写起 —— 直接说明是开头。
          hint: i > 0 ? item.lines[i - 1] : '',
          idx: i + 1,
          total: item.lines.length
        });
      });
    });
    return out;
  }

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
  //
  // 这个顺序四种题型都得守。以前只有"看拼音写词语"排队，
  // 组词和多音字是整批打乱 —— 到期的字照样排不到前面，复习等于没做。
  function orderByDue(rng, all) {
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

  function buildSession(unitId, lesson) {
    var rng = mulberry32((Date.now() ^ ((unitId || '').length * 2654435761)) >>> 0);
    return orderByDue(rng, itemsForLesson(unitId, lesson));
  }

  // 到期时间按"日历天"算，不按 24 小时整点。
  // 晚上 9 点练的字，隔 1 天 = 明天 0 点起就到期；按 now + 24h 的话，
  // 第二天晚上 8 点开软件时它还没到期，于是被整个跳过，实际隔了两天。
  function dayAfter(n) {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime() + n * DAY;
  }

  // level 是"连对了几次"：连对 1 次隔 1 天，连对 2 次隔 2 天……
  // 以前这里直接拿 level 当阶梯下标，第一次连对就跳到 2 天，1 天那一档永远用不上。
  function dueAtFor(level) {
    var i = Math.max(0, Math.min(level - 1, REVIEW_STEPS.length - 1));
    return dayAfter(REVIEW_STEPS[i]);
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
    // 取整：笔迹是一笔一笔存进 localStorage 的，小数点能省掉三分之一的体积
    return {
      x: Math.round(e.clientX - r.left),
      y: Math.round(e.clientY - r.top)
    };
  }

  // 每次渲染后都要重来一遍：画布是新的，尺寸也可能变了
  // gridType: 'tian' 田字格（写汉字）；'pinyin' 四线三格（写拼音）
  // forceCols: 每行固定几格（组词用，0/省略则自动排）
  //
  // 转屏之后格子会变多变少，所以尺寸和格位放在 cv._ccGeo 这个可变的盒子里，
  // 事件只绑一次（cv._ccBound）并随时从盒子里读最新的格位 ——
  // 要是 resize 时再绑一遍，一次落笔就会被当成两笔，家长看到的全是重影。
  var lastCanvas = null;

  function setupCanvas(cv, n, strokes, editable, gridType, forceCols, retry) {
    if (!cv || typeof cv.getContext !== 'function') return;
    var host = cv.parentNode;
    if (!host) return;
    var W = host.clientWidth;
    if (!W) {
      // 布局还没定（刚插入 DOM）。这时候放手，画笔整个是死的：
      // 孩子点了没反应，也不知道为什么 —— 等一帧再量一次（只再试一次，
      // 容器一直是 0 宽的说明这一屏根本没有画布，别把 rAF 转成死循环）。
      if (!retry && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () {
          setupCanvas(cv, n, strokes, editable, gridType, forceCols, true);
        });
      }
      return;
    }
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

    var geo = cv._ccGeo;
    if (!geo) geo = cv._ccGeo = {};
    geo.n = n;
    geo.L = L;
    geo.W = W;
    geo.H = H;
    geo.ctx = ctx;
    geo.grid = gridType || 'tian';
    geo.cols = forceCols;
    geo.list = strokes || app.strokes;
    lastCanvas = { cv: cv, n: n, strokes: strokes, editable: editable, gridType: gridType, forceCols: forceCols };

    function redraw() {
      ctx.clearRect(0, 0, W, H);
      drawCells(ctx, n, W, geo.grid, forceCols);
      drawStrokes(ctx, geo.list);
    }
    geo.redraw = redraw;
    redraw();

    if (!editable) return;

    // 点哪个格子，就只清那个格子的笔迹 —— 可以单独重写某一个字
    function cellAt(pos) {
      var lay = geo.L;
      for (var i = 0; i < geo.n; i++) {
        var c = i % lay.cols, r = Math.floor(i / lay.cols);
        var x = lay.pad + c * (lay.w + lay.gap);
        var y = lay.pad + r * (lay.h + lay.gap);
        if (pos.x >= x && pos.x <= x + lay.w && pos.y >= y && pos.y <= y + lay.h) return i;
      }
      return -1;
    }
    function clearCell(idx) {
      var list = geo.list;
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] && list[i].cell === idx) list.splice(i, 1);
      }
    }

    // 每根手指各记各的一笔。以前全页共用一个"正在画"开关和一条折线，
    // 两根手指同时写（手掌蹭到屏、换手时没抬起来）会把两笔连成一条线，
    // 家长看到的就是一个从来没写过的怪符号。
    var live = {};

    if (cv._ccBound) return;   // 事件已经绑好了，上面的 geo 一换就接着画
    cv._ccBound = true;

    function stopHold(s) {
      if (s && s.holdTimer) { clearTimeout(s.holdTimer); s.holdTimer = null; }
    }
    function dropStroke(s) {
      var at = geo.list.indexOf(s);
      if (at >= 0) geo.list.splice(at, 1);
    }

    cv.addEventListener('pointerdown', function (e) {
      if (cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (err) {} }
      var p = posOf(cv, e);
      var s = { cell: cellAt(p), pts: [p], downPos: p, moved: false, holdTimer: null };
      geo.list.push(s);
      live[e.pointerId] = s;
      // 长按（按住不动约 0.55 秒）= 清空该格，单独重写这一个字。
      // 不能再用"轻点"：写拼音时 i、j、ü 的"点"本身就是一次极短的落笔，
      // 轻点会被误判成清空，把刚写好的字母一起抹掉。长按写字时不会发生，就区分开了。
      s.holdTimer = setTimeout(function () {
        s.holdTimer = null;
        if (s.moved) return;
        s.dead = true;
        dropStroke(s);          // 这次长按本身不算一笔字
        if (s.cell >= 0) clearCell(s.cell);
        geo.redraw();
      }, 550);
      geo.redraw();
      e.preventDefault();
    });
    cv.addEventListener('pointermove', function (e) {
      var s = live[e.pointerId];
      if (!s || s.dead) return;
      var p = posOf(cv, e);
      if (Math.abs(p.x - s.downPos.x) > 4 || Math.abs(p.y - s.downPos.y) > 4) {
        s.moved = true;
        stopHold(s); // 已经动笔，就不再算"长按清空"
      }
      s.pts.push(p);
      geo.redraw();
      e.preventDefault();
    });
    function endStroke(e) {
      var s = live[e.pointerId];
      if (!s) return;
      stopHold(s);
      delete live[e.pointerId];
      if (s.dead) return;
      // 在格子外点了一下（不是写字）：不留痕迹
      if (s.pts.length === 1 && s.cell < 0) dropStroke(s);
    }
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) {
      cv.addEventListener(t, endStroke);
    });
  }

  // 转屏、软键盘收起都会改画布尺寸。位图尺寸是渲染时定的，之后只靠 CSS
  // 拉伸的话笔迹会和格子错位 —— 得重新量一次再重画。
  function refitCanvas() {
    var c = lastCanvas;
    if (!c || !c.cv) return;
    // 页面早就换掉了：lastCanvas 指向的是一个已经离开 DOM 的节点
    if (el(c.cv.id) !== c.cv) return;
    setupCanvas(c.cv, c.n, c.editable ? null : c.strokes, c.editable, c.gridType, c.forceCols);
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

    // 先数清楚这个单元有没有题。没有就把按钮换成一句说明 ——
    // 点下去才说"没有内容"、还顺带把页面弹回顶部，是很糟糕的体验。
    var polyCount = itemsForPoly(unit).length;
    var reciteCount = itemsForRecite(unit).length;

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

      '<div class="card">' +
      '<h2 class="card-title">选择题与默写</h2>' +
      '<p class="card-note">这两种由程序自己判，不用等家长批改 —— 当场就知道对错，错了马上能订正。</p>' +
      (polyCount
        ? '<button class="btn btn-soft btn-block" data-act="start-poly">多音字选读音（' + polyCount + ' 题）</button>'
        : '<p class="card-note">本单元还没有多音字数据。</p>') +
      (reciteCount
        ? '<button class="btn btn-soft btn-block" data-act="start-recite">日积月累 / 古诗默写（' + reciteCount + ' 句）</button>'
        : '<p class="card-note">本单元没有要背的内容（日积月累 / 古诗），换一个单元试试。</p>') +
      '</div>' +

      '<div class="card card-quiet">' +
      '<h2 class="card-title">家长</h2>' +
      '<button class="btn btn-ghost btn-block" data-act="parent">家长批改' +
      (pending ? '（' + pending + ' 条待批）' : '') + '</button>' +
      '<button class="btn btn-ghost btn-block" data-act="report">练习报告（家长 · 需口令）</button>' +
      '</div>' +

      '<p class="footnote">数据只保存在这台设备上，不会上传。</p>';
  }

  /* ============================== 视图：练习 ============================== */

  // 多音字 / 默写不走田字格：它们由程序判分，也不进"等家长批改"的队列
  function isTypedKind(it) { return !!it && (it.kind === 'p' || it.kind === 'r'); }

  function typedProgress() {
    var total = app.session.length;
    return total > 20
      ? '<span class="bar"><i style="width:' + Math.round(app.cursor / total * 100) + '%"></i></span>'
      : app.session.map(function (_, i) {
          var cls = i < app.cursor ? 'dot done' : (i === app.cursor ? 'dot now' : 'dot');
          return '<i class="' + cls + '"></i>';
        }).join('');
  }

  function typedShell(tag, stemLabel, stemBody, body, note) {
    return '' +
      '<div class="topbar">' +
      '<button class="btn-icon" data-act="quit" title="退出">✕</button>' +
      '<div class="dots">' + typedProgress() + '</div>' +
      '<span class="topbar-right">' + (app.cursor + 1) + '/' + app.session.length + '</span>' +
      '</div>' +
      '<div class="card card-q">' +
      '<div class="lesson-tag">' + esc(tag) + '</div>' +
      '<div class="stem"><span class="stem-label">' + esc(stemLabel) + '</span>' + stemBody + '</div>' +
      body +
      (note ? '<p class="card-note">' + esc(note) + '</p>' : '') +
      (app.message ? '<div class="feedback info">' + esc(app.message) + '</div>' : '') +
      '</div>';
  }

  function viewPracticePoly(it) {
    var body = '<div class="opt-col">' + it.options.map(function (py) {
      return '<button class="btn btn-soft btn-block" data-act="choose" data-v="' + esc(py) + '">' +
        esc(py) + '</button>';
    }).join('') + '</div>';
    return typedShell('多音字', '选读音',
      '「<b>' + esc(it.char) + '</b>」在「' + esc(it.eg) + '」里读什么？',
      body, '选对了往后推一档复习；选错了今天还会再出现一次。');
  }

  function viewPracticeRecite(it) {
    // 光说"写下一句"太含糊：孩子不知道自己背到第几句、这一句接在哪后面。
    // 把"第几句 / 共几句"和上一句原文都摆出来，他才知道该接什么。
    var lead = it.idx > 1
      ? '上一句是：「' + esc(it.hint) + '」'
      : '这是开头第一句。';
    var body = '' +
      '<div class="card-note">接着写第 ' + it.idx + ' 句（这一段共 ' + it.total + ' 句）</div>' +
      // class 复用 note-input：现成的文本输入框样式，不必再新增一套
      '<input id="typedInput" class="note-input" type="text" inputmode="text" ' +
      'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" ' +
      'placeholder="把这一句打出来" value="' + esc(app.typed || '') + '">' +
      '<div class="action-row">' +
      '<button class="btn btn-soft" data-act="give-up">想不起来</button>' +
      '<button class="btn btn-primary" data-act="submit-typed">写好了</button>' +
      '</div>';
    return typedShell(it.title || '默写', '第 ' + it.idx + ' / ' + it.total + ' 句',
      '<span class="py-hint">' + lead + '</span>',
      body, '不会就点「想不起来」，别硬猜 —— 猜错也会被记成还没掌握。');
  }

  function viewPractice() {
    var it = app.session[app.cursor];
    if (!it) return '<div class="card">没有题目。</div>';
    if (it.kind === 'p') return viewPracticePoly(it);
    if (it.kind === 'r') return viewPracticeRecite(it);
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

    // 家长批改时写的批注，下次再练到这个字时要摆出来 ——
    // 不然"崩少了山字头"这句话家长写完就再也没人看过。
    var rec = (app.state.stats || {})[keyOf(it)];
    var parentNote = rec && rec.note
      ? '<div class="fb-note">家长上次说：' + esc(rec.note) + '</div>' : '';

    return '' +
      '<div class="topbar">' +
      '<button class="btn-icon" data-act="quit" title="退出">✕</button>' +
      '<div class="dots">' + progress + '</div>' +
      '<span class="topbar-right">' + (app.cursor + 1) + '/' + total + '</span>' +
      '</div>' +

      '<div class="card card-q">' +
      '<div class="lesson-tag">' + esc(it.no ? (lessonLabel({ no: it.no }) + '《' + it.title + '》') : it.title) + '</div>' +
      '<div class="stem"><span class="stem-label">' + stemLabel + '</span>' + stemBody + '</div>' +
      parentNote +
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
    var hist = st.history || [];
    var done = hist.length;
    if (!done) return '';
    var ok = hist.filter(function (h) { return h.isCorrect; }).length;

    // 光给一个百分比不够用：孩子（和家长）真正想知道的是"我哪一句写错了"。
    // 所以把最近做过的题也列出来，对错标在每一条后面。
    // 手写题要等家长批改才进 history，所以这里不会混入"还没批"的题。
    var recent = hist.slice(-12).reverse().map(function (r) {
      return '<li><b>' + esc(r.text) + '</b>　' +
        (r.isCorrect ? '写对了' : '写错了') + '</li>';
    }).join('');

    return '<div class="card card-quiet">' +
      '<h2 class="card-title">做过的情况</h2>' +
      '<p class="card-note">一共 ' + done + ' 条，写对 ' + ok + ' 条（' +
      Math.round(ok / done * 100) + '%）。</p>' +
      '<ul class="tag-list">' + recent + '</ul>' +
      '</div>';
  }

  /* ============================== 视图：练习报告 ============================== */
  // 题型名称。history 里存的是 key（形如 "p:薄·薄雾"），从这里反查题型。
  var KIND_NAME = {
    w: '看拼音写词语', c: '看拼音写生字', z: '组词', p: '多音字选读音', r: '默写'
  };

  function reportBodyHtml() {
    var hist = app.state.history || [];
    if (!hist.length) {
      return '<div class="card"><h2 class="card-title">练习报告</h2>' +
        '<p class="card-note">还没有做题记录。练过一次之后，这里会按题型和单元分开统计。</p></div>';
    }
    var ok = hist.filter(function (h) { return h.isCorrect; }).length;

    function group(nameOf) {
      var g = {};
      hist.forEach(function (h) {
        var n = nameOf(h);
        var b = g[n] = g[n] || { total: 0, correct: 0 };
        b.total++;
        if (h.isCorrect) b.correct++;
      });
      return '<ul class="tag-list">' + Object.keys(g)
        .sort(function (a, b) { return g[b].total - g[a].total; })
        .map(function (n) {
          var b = g[n];
          return '<li><b>' + esc(n) + '</b>　' + b.total + ' 题，对 ' + b.correct +
            ' 题（' + Math.round(b.correct / b.total * 100) + '%）</li>';
        }).join('') + '</ul>';
    }

    var byKind = group(function (h) {
      return KIND_NAME[String(h.key || '').split(':')[0]] || '其他';
    });
    var byUnit = group(function (h) {
      var info = D.byId(h.unit || '');
      return info ? info.name : (h.unit || '未记录');
    });

    var wrong = hist.filter(function (h) { return !h.isCorrect; }).slice(-15).reverse();
    var wrongList = wrong.length
      ? '<ul class="tag-list">' + wrong.map(function (h) {
          // 多音字把正确读音一起列出来：家长得知道孩子到底选错了哪个音
          var ans = String(h.key || '').indexOf('p:') === 0 && h.py
            ? '（读 ' + esc(h.py) + '）' : '';
          return '<li><b>' + esc(h.text) + '</b>' + ans +
            (h.note ? '　' + esc(h.note) : '') + '</li>';
        }).join('') + '</ul>'
      : '<p class="card-note">还没有错题。</p>';

    var due = 0, now = Date.now(), st = app.state.stats || {};
    Object.keys(st).forEach(function (k) {
      if (st[k] && st[k].dueAt && st[k].dueAt <= now) due++;
    });

    return '' +
      '<div class="card">' +
      '<h2 class="card-title">总览</h2>' +
      '<p class="card-note">一共 ' + hist.length + ' 题，写对 ' + ok + ' 题（' +
      Math.round(ok / hist.length * 100) + '%）。</p>' +
      '<p class="card-note">今天到期该复习：' + due + ' 个；' +
      '还有 ' + app.state.pending.length + ' 条等家长批改。</p>' +
      '</div>' +
      '<div class="card"><h2 class="card-title">按题型</h2>' + byKind + '</div>' +
      '<div class="card"><h2 class="card-title">按单元</h2>' + byUnit + '</div>' +
      '<div class="card"><h2 class="card-title">最近的错题（最多 15 条）</h2>' +
      '<p class="card-note">后面那句是家长批改时写的批注。</p>' + wrongList + '</div>';
  }

  function viewReport() {
    return '' +
      '<div class="topbar">' +
      '<button class="btn-icon" data-act="home">←</button>' +
      '<span class="topbar-title">练习报告</span><span class="topbar-right"></span></div>' +
      reportBodyHtml();
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
    app.session = orderByDue(rng, all).slice(0, SESSION_SIZE);
    app.cursor = 0;
    app.strokes = [];
    app.message = '';
    app.view = 'practice';
    render();
  }

  // 多音字 / 默写由程序自己判，不进"等家长批改"的队列。
  //
  // 这不是要取代家长批改 —— 手写题（看拼音写词语）仍然是手写 + 家长看，
  // 因为"点、出头、全包围半包围"只有真的落笔才看得出来，打字完全绕过去了。
  // 分流的理由是另一条：这两类题**有唯一正确答案**，硬让它们卡在队列里等家长，
  // 孩子当天就看不到对错，错了也没法马上订正。
  function startPoly() {
    var all = itemsForPoly(app.state.unit);
    if (!all.length) {
      app.message = '本单元还没有多音字数据。';
      return render();
    }
    var rng = mulberry32((Date.now() ^ 0x5bf03635) >>> 0);
    app.session = orderByDue(rng, all);
    // 选项也得打乱。readings 的顺序是照教材抄的，正确的永远排在第一个 ——
    // 孩子练到第三题就发现"点最上面那个准没错"，这题等于没出。
    app.session.forEach(function (it) { it.options = shuffle(rng, it.options); });
    app.cursor = 0;
    app.typed = '';
    app.roundOk = 0;
    app.roundTotal = 0;
    app.message = '';
    app.view = 'practice';
    render();
  }

  function startRecite() {
    var all = itemsForRecite(app.state.unit);
    if (!all.length) {
      app.message = '这个单元还没有要背的内容，换个单元试试。';
      return render();
    }
    // 不打乱：背诵是有顺序的，第二句本来就该接在第一句后面
    app.session = all;
    app.cursor = 0;
    app.typed = '';
    app.roundOk = 0;
    app.roundTotal = 0;
    app.message = '';
    app.view = 'practice';
    render();
  }

  // 默写判分要容错。孩子用的是手机输入法，多打一个空格、少打一个标点
  // 不该算错 —— 去掉空白和标点只比"字对不对"。
  function normRecite(s) {
    return String(s == null ? '' : s)
      .replace(/\s+/g, '')
      .replace(/[，。、？！；：""''（）「」《》·—…．,.?!;:'"()]/g, '');
  }

  function submitTyped(isGiveUp) {
    var it = app.session[app.cursor];
    if (!it) return;

    if (it.kind === 'p') {
      var picked = String(app.typed || '').trim();
      if (!picked) {
        app.message = '先选一个读音。';
        return render();
      }
      finishTyped(it, picked === it.py,
        '「' + it.eg + '」里的「' + it.char + '」读 ' + it.py);
      return;
    }

    if (isGiveUp) {
      finishTyped(it, false, '这一句是：' + it.text);
      return;
    }
    var typed = String(app.typed || '').trim();
    if (!typed) {
      app.message = '先把这一句打出来；实在想不起来就点「想不起来」。';
      return render();
    }
    finishTyped(it, normRecite(typed) === normRecite(it.text), '这一句是：' + it.text);
  }

  function finishTyped(it, ok, answerText) {
    // 注意这里不往 recordResult 传 note：自动判分给的那句正确答案不是家长的批注。
    // 报告里"家长说："和"正确答案"必须是两回事，否则等于把程序的话冒充成家长的话。
    recordResult(it, ok);
    app.roundTotal = (app.roundTotal || 0) + 1;
    if (ok) app.roundOk = (app.roundOk || 0) + 1;
    app.typed = '';
    app.cursor++;
    // 错了当场就把正确的摆出来：错的内容拖几天再纠正，
    // 他这几天里多半已经把错的记牢了，改起来比当时贵得多。
    app.message = ok ? '✓ 对了。' : ('✗ ' + answerText);
    if (app.cursor >= app.session.length) {
      // 留一个收尾页。原来这里直接切回首页，结果最后一句对没对、本轮
      // 做了几题对了几题，全都一闪而过 —— 尤其是最后一句错了，
      // 正确答案刚显示出来页面就跳走了，等于没订正。
      app.view = 'done';
    }
    saveState();
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
        perRow: it.kind === 'z' ? it.perRow : 0,
        // 单元在"写"的这一刻就钉死。批改往往是几天以后，那时候家长可能
        // 已经把单元切到别处 —— 再拿当前的 unit 记账，统计就串到别的单元去了。
        unit: app.state.unit,
        no: it.no
      },
      strokes: JSON.parse(JSON.stringify(app.strokes))
    });
    saveState();

    app.strokes = [];
    app.cursor++;
    app.message = '';
    if (app.cursor >= app.session.length) {
      app.view = 'home';
      app.session = null;
    }
    render();
  }

  // 一次作答落下去了：更新掌握情况、排下次复习、记一条历史。
  //
  // 家长批改（手写题）和程序自动判分（多音字 / 默写）走的是同一套，
  // 复习节奏才不会出现两套标准 —— 否则"错一次"在两种题型里含义不同，
  // 到期排队就乱了。
  function recordResult(item, isCorrect, note) {
    var k = keyOf(item);
    var r = app.state.stats[k] || { attempts: 0, corrects: 0, wrongs: 0, level: 0 };

    r.attempts++;
    if (isCorrect) {
      r.corrects++;
      r.level = Math.min(r.level + 1, REVIEW_STEPS.length);
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
    if (note) r.note = note;
    app.state.stats[k] = r;

    app.state.history.push({
      ts: Date.now(), key: k, text: item.text, py: item.py || '',
      isCorrect: !!isCorrect, note: note || '',
      // 记下单元：报告要按单元分开统计，光有 key 反查不出来是哪一课的
      unit: item.unit || app.state.unit || ''
    });
    if (app.state.history.length > 2000) {
      app.state.history = app.state.history.slice(-2000);
    }
  }

  function gradeCurrent(isCorrect) {
    var p = app.state.pending[0];
    if (!p) return;
    recordResult(p.item, isCorrect, app.note);

    // 批改完立刻把结果摆给孩子看。隔几天再看，他早忘了自己当时怎么写的，
    // 家长那句批注也就失去了上下文。
    app.state.feedback.push({
      ts: Date.now(), key: keyOf(p.item), text: p.item.text, py: p.item.py,
      isCorrect: !!isCorrect, note: app.note || ''
    });
    // 家长连着批几十条时，这一堆"还没给孩子看"的也会一直涨。
    // 孩子一次看得过来的就最近那些，留个上限就够了（history 那边同理）。
    if (app.state.feedback.length > 60) {
      app.state.feedback = app.state.feedback.slice(-60);
    }

    app.state.pending.shift();
    app.note = '';
    saveState();
    render();
  }

  /* ============================== 渲染与事件 ============================== */
  // 一轮做完的收尾页。
  // 原来做完最后一句直接切回首页：这句对没对、本轮做了几题，全都一闪而过。
  // 尤其最后一句错了的时候 —— 正确答案刚显示出来页面就跳走了，等于没订正。
  function viewDone() {
    var total = app.roundTotal || 0;
    var ok = app.roundOk || 0;
    return '' +
      '<div class="card card-cta">' +
      '<div class="cta-line">共 ' + total + ' 题，对了 ' + ok + ' 题</div>' +
      '<div class="cta-sub">' +
      (total === ok ? '全对，不错。' : '错的那些今天还会再出现一次，趁热再看一眼。') +
      '</div>' +
      '</div>' +
      '<div class="card">' +
      '<h2 class="card-title">最后一题</h2>' +
      '<p class="card-note">' + esc(app.message || '') + '</p>' +
      '<button class="btn btn-primary btn-block" data-act="home">回首页</button>' +
      '</div>';
  }

  // 记住上一次的"页面 / 第几题"，用来判断这次 render 要不要把页面拉回顶部
  var lastView = null, lastCursor = -1;

  function render() {
    // 家长端只在家长端这两个页面里算"已解锁"，一离开就锁上。
    // 解锁一次就一直开着的话，家长批到一半把手机递给孩子，孩子接着点就能
    // 翻到全部答案、还能替自己点"写对了" —— 口令等于只挡第一次。
    if (app.view !== 'parent' && app.view !== 'report') {
      app.parentUnlocked = false;
      app.passInput = '';
    }
    var root = el('app');
    var html = app.view === 'practice' ? viewPractice()
      : app.view === 'done' ? viewDone()
        : app.view === 'report' ? viewReport()
          : app.view === 'parent' ? viewParent()
            : app.view === 'ref' ? viewRef()
              : viewHome();
    root.innerHTML = '<div class="view view-' + app.view + '">' +
      (app.storageWarn ? '<div class="card card-warn">' + esc(app.storageWarn) + '</div>' : '') +
      html + '</div>';

    // 打字/选择题没有画布，setupCanvas 要跳过 —— 否则会拿到 null 报错
    if (app.view === 'practice' && app.session && !isTypedKind(app.session[app.cursor])) {
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
    // 只在"换了页面"或"做到下一题"时才回到顶部。
    //
    // 原来每次 render 都无条件 scrollTo(0,0)，于是选单元、选课时、切换
    // 看拼音/看词语，页面都会猛地弹回顶部 —— 手指停在半空，下一指就点错了。
    // 这类原地刷新不该动滚动位置。
    var needTop = (app.view !== lastView) ||
      (app.view === 'practice' && app.cursor !== lastCursor);
    lastView = app.view;
    lastCursor = app.cursor;
    if (needTop) window.scrollTo(0, 0);
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
      saveState();
      return render();
    }
    if (act === 'lesson') {
      app.state.lesson = t.getAttribute('data-l') || 'all';
      saveState();
      return render();
    }
    if (act === 'ack-feedback') {
      app.state.feedback = [];
      saveState();
      return render();
    }
    if (act === 'mode') { app.state.mode = t.getAttribute('data-m') || 'py2word'; saveState(); return render(); }
    if (act === 'start') return startSession();
    if (act === 'start-zuci') return startZuci();
    if (act === 'start-poly') return startPoly();
    if (act === 'start-recite') return startRecite();
    // 选了读音就直接判：少一次"确认"的点击，孩子不容易走神
    if (act === 'choose') {
      app.typed = t.getAttribute('data-v') || '';
      return submitTyped(false);
    }
    if (act === 'submit-typed') return submitTyped(false);
    if (act === 'give-up') return submitTyped(true);
    if (act === 'home') { app.view = 'home'; app.session = null; return render(); }
    if (act === 'quit') {
      app.view = 'home';
      app.session = null;
      return render();
    }
    if (act === 'clear') { app.strokes = []; app.message = ''; return render(); }
    if (act === 'submit') return submitWriting();
    if (act === 'ref') { app.view = 'ref'; return render(); }
    if (act === 'report') {
      // 报告里有错题和正确答案，给孩子看不合适：他会照着答案把错字抄一遍，
      // 而不是真的重写一次。所以报告走家长口令，和批改页同一个门。
      if (!app.parentUnlocked) {
        app.view = 'parent';
        app.passInput = '';
        app.message = '练习报告也要口令 —— 里面有正确答案，别让孩子照着抄。';
        return render();
      }
      app.view = 'report';
      return render();
    }
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
      saveState();
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
    // 只记下来，不 render —— render 会整块换掉 innerHTML，输入框会失焦
    if (t.id === 'typedInput') app.typed = t.value;
  }

  function init() {
    app.state = S.load();
    // 读不出来 = 之前练的全没了。这必须说出来：静默回到空白状态，
    // 家长只会以为孩子自己清掉了。
    if (S.loadFailed && S.loadFailed()) {
      app.storageWarn = '上一次的练习记录读不出来，已经从空白开始。' +
        '如果不是自己清的，请告诉家长，可能需要重装或换浏览器。';
    }
    el('app').addEventListener('click', onClick);
    el('app').addEventListener('input', onInput);

    // 转屏、软键盘收起都会改画布宽度，量错一次笔迹就和格子错位
    window.addEventListener('resize', refitCanvas);
    if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
      window.visualViewport.addEventListener('resize', refitCanvas);
    }

    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
