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
  var J = window.JiaoanData || null;   // 教案数据，没有也能跑（只是少了"课堂进度"这些）
  var S = window.Store;
  // 跨设备同步。没引 cloud.js 时这里是 null，所有同步调用都跳过，项目照常跑。
  var F = (typeof window !== 'undefined' && window.FamilySync) ? window.FamilySync : null;

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
    // 从首页点「跨设备同步」进来时，先过口令这道门；过了之后直接去同步页，
    // 不用家长再自己找一遍。见 onClick 的 'sync' 和 viewSync()。
    afterUnlock: '',
    note: '',
    // 别的设备传上来等批改的作业（只在内存里，不落本地存储）
    cloudWork: [],
    cloudReports: [],
    cloudMsg: '',
    famInput: '',
    acked: [],          // 已经应用过的批改结果 id，下次联网时回执给云端删掉
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
  // vertical：一列往下排（练习页用），格子靠右摆。
  function cellLayout(n, W, type, forceCols, vertical) {
    var cols = forceCols || (vertical ? 1 : (n <= 3 ? n : (n === 4 ? 2 : 3)));
    var rows = Math.ceil(n / cols);
    var pad = 10, gap = 8;
    var avail = (W - pad * 2 - gap * (cols - 1)) / cols;
    var w, h;
    if (type === 'pinyin') {
      // 拼音格更宽：一个音节占一格，大约 1.9:1
      h = Math.round(Math.min(vertical ? 76 : 64, Math.max(46, avail / 1.9)));
      w = Math.min(avail, Math.round(h * 1.9));
    } else {
      // 竖排一列的时候横向没有别人抢地方，格子能放大就放大（写起来更稳），
      // 但字一多就收一点，免得整页太长、写一个字就要滑一次屏。
      var cap = vertical ? (n >= 7 ? 96 : (n >= 5 ? 120 : 150)) : 118;
      if (vertical && typeof window !== 'undefined' && window.innerHeight) {
        // 竖排会变成一长条。格子还按 150 排的话，一屏只够看三格，
        // 剩下的得滑屏才够得着 —— 而画布上是 touch-action:none（不然写字会被
        // 滚动打断），在画布上根本滑不动。按屏幕高度收一收，尽量一屏写完；
        // 下限 72 是保证格子还写得开的底线。
        var room = window.innerHeight * 0.62 - pad * 2 - (n - 1) * gap;
        cap = Math.max(72, Math.min(cap, Math.floor(room / n)));
      }
      var side = Math.floor(Math.min(avail, cap));
      w = h = Math.max(side, 46);
    }
    return {
      cols: cols, rows: rows, pad: pad, gap: gap, w: w, h: h,
      type: type || 'tian', vertical: !!vertical
    };
  }

  function drawCells(ctx, n, W, type, forceCols, vertical) {
    var L = cellLayout(n, W, type, forceCols, vertical);
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

  // 笔迹存的是"格子里的相对位置"（cell + u/v），不是画布像素。
  //
  // 为什么必须改：跨设备批改之后，孩子在平板上写的字要在家长的手机上回放，
  // 两台设备画布宽度不一样（平板 700px、手机 360px），像素坐标画出来会偏出格子 ——
  // 家长看到的就不是孩子写的那个字了。存相对位置，回放时按本地格子还原，
  // 横屏竖屏、大屏小屏都落在同一个田字格的同一个位置。
  //
  // 旧格式（历史笔迹，直接是像素点）照原样画，不至于让老记录变成一片乱线。
  function pointXY(pt, st, geo) {
    if (!pt || typeof pt.u !== 'number') return { x: pt.x, y: pt.y };
    var lay = geo && geo.L;
    var cell = (st && typeof st.cell === 'number') ? st.cell : -1;
    if (lay && cell >= 0 && cell < (geo.n || 0) && lay.w > 0 && lay.h > 0) {
      var col = cell % lay.cols, row = Math.floor(cell / lay.cols);
      var x = lay.pad + col * (lay.w + lay.gap);
      var y = lay.pad + row * (lay.h + lay.gap);
      return { x: x + pt.u * lay.w, y: y + pt.v * lay.h };
    }
    // 落在格子外的点：按整块画布的比例还原
    return { x: pt.u * (geo.W || 1), y: pt.v * (geo.H || 1) };
  }

  var INK = '#e8590c';
  var INK_W = 3;

  // 笔画的线型只在这里设一次：整条重画和"只补一小段"必须长得一模一样，
  // 不然孩子写出来的笔画会一段粗一段细。
  function inkBegin(ctx) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = INK_W;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
  }

  // 落笔的那一下。写 i、j 的"点"本身就是一次极短的落笔，
  // 不给它画一个点的话，那个点写完就看不见了。
  function drawDot(ctx, p) {
    inkBegin(ctx);
    ctx.arc(p.x, p.y, INK_W / 2, 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
  }

  function drawStrokes(ctx, strokes, geo) {
    inkBegin(ctx);
    (strokes || []).forEach(function (st) {
      // 兼容两种格式：新格式 {cell, pts:[{u,v}]}，旧格式（历史笔迹）直接是点数组
      var pts = st && st.pts ? st.pts : st;
      if (!pts || !pts.length) return;
      ctx.beginPath();
      var first = pointXY(pts[0], st, geo);
      ctx.moveTo(first.x, first.y);
      for (var i = 1; i < pts.length; i++) {
        var p = pointXY(pts[i], st, geo);
        ctx.lineTo(p.x, p.y);
      }
      if (pts.length === 1) ctx.lineTo(first.x + 0.5, first.y + 0.5);
      ctx.stroke();
    });
  }

  // 画布的位置每帧只量一次。一次 pointermove 里有十几个采样点时，
  // 每个点都量一次会触发布局重算（低配平板上就是这样卡起来的），
  // 卡一次浏览器就丢一批采样 —— 孩子写出来的笔画跟着断。
  // 16 毫秒内复用同一个位置：滚动中的偏差不超过一帧的滚动量，看不出来。
  var rectCv = null, rectCache = null, rectAt = 0;
  function rectOf(cv) {
    var now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
    if (rectCv !== cv || !rectCache || now - rectAt > 16) {
      rectCache = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0, top: 0 };
      rectCv = cv;
      rectAt = now;
    }
    return rectCache;
  }

  function posOf(cv, e) {
    var r = rectOf(cv);
    // 取整：笔迹是一笔一笔存进 localStorage 的，小数点能省掉三分之一的体积
    return {
      x: Math.round(e.clientX - r.left),
      y: Math.round(e.clientY - r.top)
    };
  }

  // 一次 pointermove 里浏览器可能攒了好几个采样点（电容笔尤其明显）。
  // 只取最后一个的话，快写时笔画会变成几段直棱棱的折线 ——
  // 孩子写"一"写不直、写"撇"变成折线，看着就像"连着写会断笔"。
  function coalesced(e) {
    if (typeof e.getCoalescedEvents === 'function') {
      try {
        var list = e.getCoalescedEvents();
        if (list && list.length) return list;
      } catch (err) { /* 老浏览器：退回这一个点，照常能写 */ }
    }
    return [e];
  }

  // 每次渲染后都要重来一遍：画布是新的，尺寸也可能变了
  // gridType: 'tian' 田字格（写汉字）；'pinyin' 四线三格（写拼音）
  // forceCols: 每行固定几格（组词用，0/省略则自动排）
  // vertical: 一列往下排（练习页用）。格子靠右摆，左边空出来给手掌。
  //
  // 转屏之后格子会变多变少，所以尺寸和格位放在 cv._ccGeo 这个可变的盒子里，
  // 事件只绑一次（cv._ccBound）并随时从盒子里读最新的格位 ——
  // 要是 resize 时再绑一遍，一次落笔就会被当成两笔，家长看到的全是重影。
  var lastCanvas = null;

  function setupCanvas(cv, n, strokes, editable, gridType, forceCols, vertical, retry) {
    if (!cv || typeof cv.getContext !== 'function') return;
    var host = cv.parentNode;
    if (!host) return;
    // clientWidth 含容器的内边距，而画布只能占内容区那么宽 ——
    // 把内边距算成可用宽度的话，画布会宽出一点点、被 max-width 压回来，
    // 那就成了整块缩放：位图里的笔迹和屏幕上的格子会错开。
    var padX = 0;
    if (typeof getComputedStyle === 'function') {
      var cs = getComputedStyle(host);
      padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    }
    var W = Math.max(0, host.clientWidth - padX);
    if (!W) {
      // 布局还没定（刚插入 DOM）。这时候放手，画笔整个是死的：
      // 孩子点了没反应，也不知道为什么 —— 等一帧再量一次（只再试一次，
      // 容器一直是 0 宽的说明这一屏根本没有画布，别把 rAF 转成死循环）。
      if (!retry && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () {
          setupCanvas(cv, n, strokes, editable, gridType, forceCols, vertical, true);
        });
      }
      return;
    }
    // 高度由格子算出来：折行之后要跟着变高，不然下面的格子会被切掉
    var L = cellLayout(n, W, gridType || 'tian', forceCols, vertical);
    // 画布只做"格子实际占的那一块"，不再铺满整行：竖排时就是右边那么一列。
    // 右边空出来的地方全是留给手掌的 —— 手掌蹭在那儿根本落不到画布上，
    // 也就画不出痕迹（孩子写字时手掌就压在格子旁边的空白处）。
    var CW = L.pad * 2 + L.cols * L.w + (L.cols - 1) * L.gap;
    var H = L.pad * 2 + L.rows * L.h + (L.rows - 1) * L.gap;

    cv.style.width = CW + 'px';
    cv.style.height = H + 'px';
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(CW * dpr);
    cv.height = Math.round(H * dpr);

    var ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var geo = cv._ccGeo;
    if (!geo) geo = cv._ccGeo = {};
    geo.n = n;
    geo.L = L;
    geo.W = CW;
    geo.H = H;
    geo.ctx = ctx;
    geo.grid = gridType || 'tian';
    geo.cols = forceCols;
    geo.vertical = vertical;
    geo.list = strokes || app.strokes;
    lastCanvas = {
      cv: cv, n: n, strokes: strokes, editable: editable,
      gridType: gridType, forceCols: forceCols, vertical: vertical
    };

    function redraw() {
      ctx.clearRect(0, 0, CW, H);
      drawCells(ctx, n, CW, geo.grid, forceCols, vertical);
      drawStrokes(ctx, geo.list, geo);
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

    // 落笔的位置记成"第几个格子 + 格内相对位置"，不记像素。
    //
    // 整笔只用**起笔那一格**当基准（anchor），中途笔尖经过别的格子、扫到格外
    // 也不换参照系。以前是每个点各自找自己落在哪个格子里，回放时却按笔画起点
    // 的格子还原 —— 两套坐标系对不上，笔尖一越过格线就跳一个格宽，
    // 画出来是一条横穿格子的直线（孩子说的"写到格子那儿自动弹回来一条线"）。
    // 现在超出格子的部分就老老实实画在格子外面，和手写一样。
    function normAt(p, anchor) {
      var lay = geo.L;
      if (anchor >= 0 && lay && lay.w > 0 && lay.h > 0) {
        var col = anchor % lay.cols, row = Math.floor(anchor / lay.cols);
        var x = lay.pad + col * (lay.w + lay.gap);
        var y = lay.pad + row * (lay.h + lay.gap);
        return { u: (p.x - x) / lay.w, v: (p.y - y) / lay.h };
      }
      return { u: p.x / (CW || 1), v: p.y / (H || 1) };
    }

    // 每根手指各记各的一笔。以前全页共用一个"正在画"开关和一条折线，
    // 两根手指同时写（手掌蹭到屏、换手时没抬起来）会把两笔连成一条线，
    // 家长看到的就是一个从来没写过的怪符号。
    var live = {};
    // 电容笔最近一次落下 / 抬起的时间。电容笔在写的时候，手掌往往就贴在
    // 屏幕边上，浏览器把这种大接触面也报成一个触摸点 —— 不管它的话，
    // 孩子写的字上会多出一条掌痕。笔在写、或刚抬起的一瞬间，触摸就当手掌忽略。
    var penAt = 0;
    function penLive() {
      for (var k in live) { if (live[k] && live[k].pen) return true; }
      return false;
    }

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
      // 电容笔正在写、或刚抬起的那一下：这时的触摸基本都是手掌跟手指，
      // 让它也起一笔的话，孩子刚写的字上就糊一条痕。
      var isPen = e.pointerType === 'pen';
      if (isPen) penAt = Date.now();
      else if (penLive() || (penAt && Date.now() - penAt < 400)) return;
      if (cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (err) {} }
      var p = posOf(cv, e);
      // 存归一化坐标（跨设备回放要用）。像素位置只留在 downPos 里，用来判断"有没有真的动笔"
      var anchor = cellAt(p);
      var s = {
        cell: anchor, pts: [normAt(p, anchor)], downPos: p,
        moved: false, holdTimer: null, norm: true, pen: isPen
      };
      geo.list.push(s);
      live[e.pointerId] = s;
      drawDot(ctx, p);
      // 长按（按住不动约 0.7 秒）= 清空该格，单独重写这一个字。
      // 不能再用"轻点"：写拼音时 i、j、ü 的"点"本身就是一次极短的落笔，
      // 轻点会被误判成清空，把刚写好的字母一起抹掉。长按写字时不会发生，就区分开了。
      // 时间放宽到 0.7 秒、位移容差放到 6 像素：起笔时手一抖就会被当成"没动"，
      // 那样孩子刚写的那个字会被整格抹掉。
      s.holdTimer = setTimeout(function () {
        s.holdTimer = null;
        if (s.moved) return;
        s.dead = true;
        dropStroke(s);          // 这次长按本身不算一笔字
        if (s.cell >= 0) clearCell(s.cell);
        geo.redraw();
      }, 700);
      e.preventDefault();
    });
    cv.addEventListener('pointermove', function (e) {
      var s = live[e.pointerId];
      if (!s || s.dead) return;
      // 这一批采样点只补画新增的那一小段，不整块重画：
      // 整块重画在低配平板上每动一下就卡一次，卡的时候浏览器丢采样，
      // 写出来的笔画就是一段一段断的。
      var evts = coalesced(e);
      var from = pointXY(s.pts[s.pts.length - 1], s, geo);
      inkBegin(ctx);
      ctx.moveTo(from.x, from.y);
      var grew = false;
      for (var i = 0; i < evts.length; i++) {
        var p = posOf(cv, evts[i]);
        if (!s.moved && (Math.abs(p.x - s.downPos.x) > 6 || Math.abs(p.y - s.downPos.y) > 6)) {
          s.moved = true;
          stopHold(s); // 已经动笔，就不再算"长按清空"
        }
        var np = normAt(p, s.cell);
        s.pts.push(np);
        var px = pointXY(np, s, geo);
        ctx.lineTo(px.x, px.y);
        grew = true;
      }
      if (grew) ctx.stroke();
      e.preventDefault();
    });
    function endStroke(e) {
      var s = live[e.pointerId];
      if (!s) return;
      stopHold(s);
      delete live[e.pointerId];
      if (e.pointerType === 'pen') penAt = Date.now();
      if (s.dead) return;
      // 在格子外点了一下（不是写字）：不留痕迹。
      // 起点是刚落笔时补画上去的，得重画一遍才抹得掉。
      if (s.pts.length === 1 && s.cell < 0) {
        dropStroke(s);
        geo.redraw();
      }
    }
    // 不用 pointerleave：笔尖滑到画布边缘外（画布现在只有一列那么宽，
    // 很容易碰到）就被判成"这一笔写完了"，孩子接着写就从那儿断开。
    // 已经 setPointerCapture 了，出了画布 pointermove / pointerup 照样送到这里。
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) {
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
    rectCv = null;   // 尺寸变了，缓存的画布位置也得重量
    setupCanvas(c.cv, c.n, c.editable ? null : c.strokes, c.editable,
      c.gridType, c.forceCols, c.vertical);
  }

  /* ============================== 视图：首页 ============================== */
  /* ====================== 教案：课堂进度 / 本课重点 ====================== */
  /*
   * js/jiaoan.js 由 scripts/gen_jiaoan.py 从教案 docx 生成，能给的是三样东西：
   *   1. 教学进度表：这周课堂讲到第几课（首页「本周课堂」）
   *   2. 每课的教学目标 / 重点 / 难点 / 分层作业（资料页「本课重点」）
   *   3. 写字指导里逐字的结构、笔顺、易错笔画（资料页 + 家长批改时的参考）
   *
   * 它**不**提供课文原文、古诗、日积月累 —— 那是二手整理，默写必须以教材 PDF 为准。
   * 教案自己带的错（陀螺 / 王戎不取道旁李 的课次标反了）也已在生成时避开：
   * 课次一律按 js/data.js 认，教案只补课次以外的字段。
   */

  // 进度表里的日期没写年份（"9.1-9.4"），按"9 月开学"补：
  // 9—12 月算学期起始年，1 月算下一年。
  function weekRange(dateStr, startYear) {
    var m = /^(\d{1,2})\.(\d{1,2})\s*[-—~]\s*(\d{1,2})\.(\d{1,2})$/.exec(dateStr || '');
    if (!m) return null;
    var am = +m[1], ad = +m[2], bm = +m[3], bd = +m[4];
    return {
      from: new Date(am >= 9 ? startYear : startYear + 1, am - 1, ad),
      to: new Date(bm >= 9 ? startYear : startYear + 1, bm - 1, bd, 23, 59, 59)
    };
  }

  function currentWeek(today) {
    if (!J || !J.weeks || !J.weeks.length) return null;
    today = today || new Date();
    var sy = today.getMonth() + 1 >= 9 ? today.getFullYear() : today.getFullYear() - 1;
    var hit = null, next = null;
    J.weeks.forEach(function (w) {
      var r = weekRange(w.date, sy);
      if (!r) return;
      if (today >= r.from && today <= r.to) hit = { w: w, range: r, now: true };
      else if (!next && r.from > today) next = { w: w, range: r, now: false };
    });
    // 假期里（今天不在任何一周内）就给下一周，让家长提前知道开学要上什么
    return hit || next || null;
  }

  // "1.观潮（3）2.繁星（2）" → [{name:'观潮',periods:3},{name:'繁星',periods:2}]
  function weekItems(w) {
    var text = (w.content || []).join('');
    var out = [];
    var re = /([^（(]+)[（(](\d+)[）)]/g;
    var m;
    while ((m = re.exec(text))) {
      // "6.方帽子店" / "7*田忌赛马" / "3*现代诗二首" —— 前面的课次和星号都要去掉，
      // 漏了点号的话会留下 ".方帽子店"，就匹配不上第 6 课了
      var name = m[1].trim().replace(/^\d+\s*[.．、]?\s*[*＊]?\s*/, '');
      if (name) out.push({ name: name, periods: +m[2] });
    }
    return out;
  }

  // 进度表只写"1.观潮"，没写第几单元。课表是顺着上的，
  // 所以从第 1 周往后扫，单元指针只往前走、不回头 —— 这样第八单元的《古诗三首》
  // 不会被认成第三单元那一个。
  var weekPlanCache = null;
  function weekPlan() {
    if (weekPlanCache || !J) return weekPlanCache;
    weekPlanCache = [];
    var ptr = 0;
    J.weeks.forEach(function (w) {
      var items = weekItems(w).map(function (it) {
        var found = null;
        for (var i = ptr; i < D.UNITS.length && !found; i++) {
          for (var k = 0; k < D.UNITS[i].lessons.length; k++) {
            var t = D.UNITS[i].lessons[k].title || '';
            if (t.indexOf(it.name) === 0 || it.name.indexOf(t) === 0) {
              found = { unit: D.UNITS[i].id, no: D.UNITS[i].lessons[k].no, idx: i };
              break;
            }
          }
        }
        if (found) ptr = found.idx;
        return { name: it.name, periods: it.periods,
                 unit: found ? found.unit : '', no: found ? found.no : 0 };
      });
      weekPlanCache.push({ w: w.w, date: w.date, note: w.note, items: items });
    });
    return weekPlanCache;
  }

  function progressCard() {
    var plan = weekPlan();
    var cw = currentWeek();
    if (!plan || !cw) return '';
    var row = null;
    plan.forEach(function (p) { if (p.w === cw.w.w) row = p; });
    if (!row || !row.items.length) return '';

    var btns = row.items.map(function (it) {
      if (!it.unit) {
        return '<span class="lesson-off">' + esc(it.name) + '（' + it.periods + ' 节）</span>';
      }
      return '<button class="unit-btn" data-act="goto-lesson" data-u="' + esc(it.unit) +
        '" data-l="' + esc(it.no) + '">' + esc(it.name) +
        '（' + it.periods + ' 节）</button>';
    }).join('');

    return '<div class="card card-cta">' +
      '<h2 class="card-title">' + (cw.now ? '本周课堂' : '下一周课堂') +
      '　第 ' + row.w + ' 周 ' + esc(row.date) + '</h2>' +
      '<p class="card-note">' + (cw.now
        ? '学校这周讲到这儿。点一下就跳到那一课，练的字和课堂对得上。'
        : '现在是假期，先看看开学第一周要上什么。') + '</p>' +
      '<div class="unit-row">' + btns + '</div>' +
      '</div>';
  }

  // 某一课在教案里的全部课时（一课往往占 2～3 节，要点分散在各节里）
  function jiaoanLessons(unitId, no) {
    if (!J) return [];
    var u = J.byId(unitId);
    if (!u) return [];
    return u.lessons.filter(function (l) { return String(l.no) === String(no); });
  }

  function jiaoanTipsOf(unitId, no) {
    var out = [];
    jiaoanLessons(unitId, no).forEach(function (l) {
      (l.writing || []).forEach(function (t) { out.push(t); });
    });
    return out;
  }

  // 这道题（一个词或一个字）里，教案点了哪几个字的写法
  function tipsForItem(it) {
    if (!J || !it || !it.unit) return [];
    var all = jiaoanTipsOf(it.unit, it.no);
    if (!all.length) return [];
    var chars = String(it.text || '').split('');
    return all.filter(function (t) { return chars.indexOf(t.c) >= 0; });
  }

  function listBlock(title, arr, cls) {
    if (!arr || !arr.length) return '';
    return '<div class="ja-block"><div class="ja-label">' + title + '</div>' +
      arr.map(function (s) {
        return '<div class="' + (cls || 'ja-line') + '">· ' + esc(s) + '</div>';
      }).join('') + '</div>';
  }

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

      progressCard() +

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
      // 家庭码以前只藏在报告页最底下，家长翻半天也找不着。
      // 单独给一个入口，和报告一样要口令（家庭码等于全家的钥匙）。
      '<button class="btn btn-ghost btn-block" data-act="sync">跨设备同步（家庭码 · 需口令）</button>' +
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
        '<p class="card-note">口令只存在这台设备上，所以换一台设备就要再设一次（可以和别的设备不一样）。</p>' +
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

    // 已解锁：逐条批改。队列里可能混着别的设备传上来的作业
    var queue = gradingQueue();
    var p = queue.length ? queue[0] : null;
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

    // 教案里对这个字的结构 / 笔顺 / 易错笔画说明。
    // 只摆在家长这一侧：孩子写之前看到提示，练的就不是"能不能想起来"了。
    var tips = tipsForItem(it);
    var tipHtml = tips.length
      ? '<div class="ja-block"><div class="ja-label">教案里对这个字的提示（批注可以直接照这个说）</div>' +
        tips.map(function (t) {
          return '<div class="ja-line"><b>' + esc(t.c) + '</b>　' + esc(t.tip) + '</div>';
        }).join('') + '</div>'
      : '';
    return '' +
      '<div class="topbar"><button class="btn-icon" data-act="home">←</button>' +
      '<span class="topbar-title">家长批改</span>' +
      '<span class="topbar-right">待批 ' + queue.length + ' 条</span></div>' +
      (p.dev && F && p.dev !== (F.sync() && F.sync().dev)
        ? '<div class="card card-quiet"><p class="card-note">这一条是「' +
          esc(p.devName || '另一台设备') + '」上写的。</p></div>'
        : '') +

      '<div class="card card-q">' +
      '<div class="stem"><span class="stem-label">题目</span>' + stemTxt + '</div>' +
      '<div class="write-wrap"><canvas id="reviewCanvas"></canvas></div>' +
      '<div class="answer-line">' + (isZ ? '参考答案（家长据此判断）：' : '正确答案：') + '<b>' + ansTxt + '</b></div>' +
      tipHtml +
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

    // 教案里的写字指导比"易错字：鼎（12 画）"具体得多：
    // 会写明结构、笔顺、哪一笔容易写错，家长辅导时照着说就行。
    function writingTipsSection() {
      var scope = app.state.lesson;
      var ids = (scope === 'all' ? u.lessons.map(function (l) { return l.no; }) : [scope]);
      var tips = [];
      ids.forEach(function (n) { tips = tips.concat(jiaoanTipsOf(u.id, n)); });
      if (!tips.length) {
        return '<p class="card-note">' +
          (scope === 'all' ? '本单元教案里没有逐字的书写指导。' : '这一课的教案里没有逐字的书写指导。') +
          '</p>';
      }
      return tips.map(function (t) {
        return '<div class="ref-tricky"><b>' + esc(t.c) + '</b>　' + esc(t.tip) + '</div>';
      }).join('');
    }

    // 教案给的东西：这一课到底要掌握什么、重点难点、老师布置的分层作业、板书。
    // 全是"知道这一课在学什么"用的，不进练习、不进统计。
    function jiaoanSection() {
      if (!J) return '';
      var ju = J.byId(u.id);
      if (!ju) return '';
      var scope = app.state.lesson;

      if (scope === 'all') {
        return '<div class="card"><h2 class="card-title">单元要点（教案）</h2>' +
          '<p class="card-note">本单元的教学目标与重难点，知道这一单元要抓什么。</p>' +
          listBlock('教学目标', ju.goals) +
          listBlock('重点', ju.key) +
          listBlock('难点', ju.hard) +
          '</div>';
      }

      var ls = jiaoanLessons(u.id, scope);
      if (!ls.length) return '';
      var keys = [], hards = [], hw = [], board = [];
      ls.forEach(function (l) {
        if (l.key) keys.push(l.key);
        if (l.hard) hards.push(l.hard);
        hw = hw.concat(l.homework || []);
        board = board.concat(l.board || []);
      });
      // 教学目标按课时分段列：一课两三节，四句"文化自信 / 语言运用……"
      // 摞在一起会变成一堵墙，看不出哪节讲什么。
      var goalBlocks = ls.map(function (l) {
        return listBlock(ls.length > 1 ? (l.period || '教学目标') : '教学目标', l.goals || []);
      }).join('');
      var ln = null;
      u.lessons.forEach(function (x) { if (String(x.no) === String(scope)) ln = x; });

      return '<div class="card"><h2 class="card-title">本课重点（教案）' +
        (ln ? '　' + esc(lessonLabel(ln) + '《' + ln.title + '》') : '') + '</h2>' +
        '<p class="card-note">这一课课堂上的目标和重难点，以及老师布置的作业。' +
        '共 ' + ls.length + ' 节课时。</p>' +
        goalBlocks +
        listBlock('重点', keys) +
        listBlock('难点', hards) +
        listBlock('作业', hw) +
        listBlock('板书', board) +
        '</div>';
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
      '<div class="card"><h2 class="card-title">易错字提醒</h2>' + trickySection() + '</div>' +
      '<div class="card"><h2 class="card-title">写字要点（教案）</h2>' +
      '<p class="card-note">教案里逐字写的结构、笔顺、易错笔画。练之前看一眼，' +
      '批改的时候也照这个说。</p>' + writingTipsSection() + '</div>' +
      jiaoanSection();
  }

  // 报告/统计要用的历史：本机 + 云端各设备（按"时间+词"去重）。
  //
  // 不合并的话，家长在自己手机上打开报告页会是空的 —— 那台设备一条练习记录都没有，
  // 记录全在孩子那台设备上。跨设备看报告要成立，这一步是必须的。
  function mergedHistory() {
    var list = (app.state.history || []).slice();
    if (!F || !F.on() || !app.cloudReports || !app.cloudReports.length) return list;
    var myDev = F.sync().dev;
    var seen = {};
    list.forEach(function (h) { seen[h.ts + '|' + h.key] = 1; });
    app.cloudReports.forEach(function (r) {
      if (r.dev === myDev) return;   // 本机那份已经在上面算过了
      ((r.snapshot && r.snapshot.history) || []).forEach(function (h) {
        var k = h.ts + '|' + h.key;
        if (seen[k]) return;
        seen[k] = 1;
        list.push(h);
      });
    });
    return list.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
  }

  function reviewStatsHtml() {
    var st = app.state;
    var hist = mergedHistory();
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

  // 跨设备同步的开关（只在家长报告页里，孩子碰不到）
  function syncCardHtml() {
    if (!F) return '';
    var s = F.sync();
    if (!s.on) {
      return '<div class="card">' +
        '<h2 class="card-title">跨设备同步</h2>' +
        '<p class="card-note">开了之后：孩子在平板上写的字，你在自己手机上就能批；' +
        '批完的结果自动回到孩子那台设备。不用点同步，也不用在同一台设备上。</p>' +
        // 顺序是刻意的：先问"另一台设备是不是已经有码了"。
        // 各生成各的 = 两个互不相通的家庭，界面都显示"已开启"，但永远看不到对方的作业。
        '<p class="card-note"><b>已经有一台设备生成过家庭码了吗？把那个码填进来：</b></p>' +
        '<input id="famInput" class="pass-input" type="text" placeholder="xxxx-xxxx-xxxx" ' +
        'autocomplete="off" value="' + esc(app.famInput || '') + '">' +
        '<button class="btn btn-primary btn-block" data-act="sync-join">用这个码</button>' +
        '<p class="card-note">没有的话，在这台设备上生成一个 —— ' +
        '<b>另一台已经生成过就别点这个</b>，那就是两个家庭了。</p>' +
        '<button class="btn btn-ghost btn-block" data-act="sync-on">这台是第一个，生成新码</button>' +
        (app.cloudMsg ? '<div class="feedback warn">' + esc(app.cloudMsg) + '</div>' : '') +
        '</div>';
    }
    return '<div class="card">' +
      '<h2 class="card-title">跨设备同步</h2>' +
      '<div class="cta-line">家庭码　<b>' + esc(s.fam) + '</b></div>' +
      '<p class="card-note">另一台设备在同一个地方填上这个码就对上了。' +
      '知道这个码的人能看报告、也能批改 —— 别发给外人。</p>' +
      '<p class="card-note">' + esc(F.statusText()) + '</p>' +
      '<div class="action-row">' +
      '<button class="btn btn-ghost" data-act="sync-new">换一个码</button>' +
      '<button class="btn btn-soft" data-act="sync-off">关掉同步</button>' +
      '</div>' +
      '</div>';
  }

  // 别的设备上练得怎么样（统计快照，覆盖写，云端只留最新一份）
  function cloudReportsHtml() {
    if (!F || !F.on() || !app.cloudReports || !app.cloudReports.length) return '';
    var myDev = F.sync().dev;
    var rows = app.cloudReports.filter(function (r) { return r.dev !== myDev; });
    if (!rows.length) return '';

    var list = rows.map(function (r) {
      var h = (r.snapshot && r.snapshot.history) || [];
      var ok = h.filter(function (x) { return x.isCorrect; }).length;
      var pct = h.length ? Math.round(ok / h.length * 100) : 0;
      var when = r.ts ? new Date(r.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      return '<li><b>' + esc((r.snapshot && r.snapshot.devName) || '另一台设备') + '</b>　' +
        h.length + ' 条，写对 ' + ok + ' 条（' + pct + '%）' +
        (when ? '　<span class="dim">' + esc(when) + '</span>' : '') + '</li>';
    }).join('');

    return '<div class="card card-quiet">' +
      '<h2 class="card-title">别的设备上</h2>' +
      '<p class="card-note">下面是另 ' + rows.length + ' 台设备最近一次上传的情况（本机在上面）。</p>' +
      '<ul class="tag-list">' + list + '</ul>' +
      '</div>';
  }

  function reportBodyHtml() {
    var hist = mergedHistory();
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
      reportBodyHtml() +
      cloudReportsHtml() +
      syncCardHtml();
  }

  // 跨设备同步单独一页。它以前只挂在报告页最底下，家长得先进报告、
  // 再一直滑到最底才看得见 —— 结果就是"哪儿都找不到填家庭码的地方"。
  function viewSync() {
    return '' +
      '<div class="topbar">' +
      '<button class="btn-icon" data-act="home">←</button>' +
      '<span class="topbar-title">跨设备同步</span><span class="topbar-right"></span></div>' +
      '<div class="card">' +
      '<h2 class="card-title">家庭码是干什么的</h2>' +
      '<p class="card-note">两台设备填同一个家庭码（比如孩子的平板 + 家长的手机），' +
      '孩子写的字就能在另一台上批，批完的结果自动回到孩子那台。' +
      '填一次就够，以后不用再点同步。</p>' +
      '<p class="card-note">语文和数学共用同一个码 —— 一个码，两门课都在里面。</p>' +
      '</div>' +
      cloudReportsHtml() +
      syncCardHtml();
  }

  // 统计快照：覆盖写，云端只留每台设备的最新一份。
  // 全量历史就在孩子设备上（history 上限 2000 条），没必要再往云端堆一份。
  function reportSnapshot() {
    return {
      devName: (F && F.sync() && F.sync().name) || '设备',
      ts: Date.now(),
      history: (app.state.history || []).slice(-200),
      stats: app.state.stats || {}
    };
  }

  // 打开页面 / 从后台切回时取一次"家长在别处批的结果"。
  // 刻意不做定时轮询 —— 平时完全不联网，不耗电也不跑流量。
  function refreshGrades() {
    if (!F || !F.on()) return;
    F.pullGrades(app.acked || []).then(function () {
      app.acked = [];   // 回执送到了，云端已经把这几条删掉
    }).catch(function () { /* 连不上就算了，下次再试 */ });
  }

  // 进家长批改页时拉一次别的设备传上来的作业（笔迹只放内存，不落本地存储）
  function refreshCloudWork() {
    if (!F || !F.on()) return;
    F.pullWork().then(function (items) {
      app.cloudWork = items || [];
      if (app.view === 'parent') render();
    }).catch(function () { /* 失败就只批本机的，不打断家长 */ });
  }

  function refreshReports() {
    if (!F || !F.on()) return;
    F.pullReports().then(function (list) {
      app.cloudReports = list || [];
      if (app.view === 'report') render();
    }).catch(function () {});
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

  // 只留 cell + 归一化坐标。downPos / moved / holdTimer 只在画的时候有用，
  // 存下来既没用又占地方，还要跟着上传。
  function cleanStrokes(list) {
    return (list || []).map(function (s) {
      return {
        cell: typeof s.cell === 'number' ? s.cell : -1,
        pts: (s.pts || []).slice()
      };
    });
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
      strokes: cleanStrokes(app.strokes)
    });
    saveState();

    app.strokes = [];
    app.cursor++;
    app.message = '';
    if (F && F.on()) F.markWorkDirty();

    if (app.cursor >= app.session.length) {
      app.view = 'home';
      app.session = null;
      // 整轮写完才传：中途传上去家长也来不及批，白白多几次请求
      if (F && F.on()) {
        F.flushWork();
        F.pushReport(reportSnapshot());
      }
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

  // 家长要批的：本机写完的 + 别的设备传上来的，合成一条队，先写的先批。
  // 云端那些只在内存里（app.cloudWork），不落本地存储 —— 别的设备写的字
  // 没必要长期占着这台设备的空间。
  function gradingQueue() {
    var dev = (F && F.sync() && F.sync().dev) || '';
    var mine = (app.state.pending || []).map(function (p) {
      return { id: p.id, ts: p.ts, item: p.item, strokes: p.strokes, dev: dev };
    });
    var cloud = (app.cloudWork || []).filter(function (c) {
      for (var i = 0; i < mine.length; i++) if (mine[i].id === c.id) return false;
      return true;
    });
    return mine.concat(cloud).sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
  }

  function queueHead() {
    var q = gradingQueue();
    return q.length ? q[0] : null;
  }

  // 一条作答落地：更新掌握度、排复习、记历史、把结果摆给孩子看。
  // 本地批和"家长在别的设备上批完传回来"走的是同一条路 —— 规则分叉就会出现
  // "错一次"在两种题型/两种来源里含义不同，复习排期立刻乱掉。
  function applyResult(p, isCorrect, note) {
    recordResult(p.item, isCorrect, note);

    // 批改完立刻把结果摆给孩子看。隔几天再看，他早忘了自己当时怎么写的，
    // 家长那句批注也就失去了上下文。
    app.state.feedback.push({
      ts: Date.now(), key: keyOf(p.item), text: p.item.text, py: p.item.py,
      isCorrect: !!isCorrect, note: note || ''
    });
    // 家长连着批几十条时，这一堆"还没给孩子看"的也会一直涨。
    // 孩子一次看得过来的就最近那些，留个上限就够了（history 那边同理）。
    if (app.state.feedback.length > 60) {
      app.state.feedback = app.state.feedback.slice(-60);
    }
    app.state.pending = app.state.pending.filter(function (x) { return x.id !== p.id; });
  }

  // 孩子端收到"家长在别处批的结果"。认不出来（已经批过 / 清掉了）就跳过 ——
  // 说明这条在别处已经生效，不能把掌握度再算一遍。
  function applyRemoteGrades(list) {
    var acked = [];
    (list || []).forEach(function (g) {
      var p = null;
      for (var i = 0; i < app.state.pending.length; i++) {
        if (app.state.pending[i].id === g.id) { p = app.state.pending[i]; break; }
      }
      if (!p) return;
      applyResult(p, g.ok, g.note);
      acked.push(g.id);
    });
    if (acked.length) { saveState(); render(); }
    return acked;
  }

  function gradeCurrent(isCorrect) {
    var p = queueHead();
    if (!p) return;
    var note = app.note || '';
    var mine = !p.dev || !F || p.dev === (F.sync() && F.sync().dev);

    // 不管在哪批的，都生成一条批改结果。攒到这一批改完再一起传
    // （幂等由服务端保证：先到为准），所以"本机批"和"跨设备批"只有一套代码。
    if (F && F.on()) {
      F.queueGrade({ dev: mine ? F.sync().dev : p.dev, id: p.id, ok: !!isCorrect, note: note });
    }

    if (mine) {
      applyResult(p, isCorrect, note);
    } else {
      // 别的设备上写的字：复习排期在那台设备上算，这台只把队列划掉
      app.cloudWork = (app.cloudWork || []).filter(function (x) { return x.id !== p.id; });
    }

    app.note = '';
    saveState();
    render();

    // 这一批批完了 → 一起传上去（批得很快，没必要一条一传）
    if (F && F.on() && !queueHead()) F.flushGrades();
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
    // 家长端只在家长端这几个页面里算"已解锁"，一离开就锁上。
    // 解锁一次就一直开着的话，家长批到一半把手机递给孩子，孩子接着点就能
    // 翻到全部答案、还能替自己点"写对了" —— 口令等于只挡第一次。
    if (app.view !== 'parent' && app.view !== 'report' && app.view !== 'sync') {
      app.parentUnlocked = false;
      app.passInput = '';
      app.afterUnlock = '';
    }
    var root = el('app');
    var html = app.view === 'practice' ? viewPractice()
      : app.view === 'done' ? viewDone()
        : app.view === 'report' ? viewReport()
          : app.view === 'sync' ? viewSync()
            : app.view === 'parent' ? viewParent()
              : app.view === 'ref' ? viewRef()
                : viewHome();
    root.innerHTML = '<div class="view view-' + app.view + '">' +
      (app.storageWarn ? '<div class="card card-warn">' + esc(app.storageWarn) + '</div>' : '') +
      // 同步相关的提示（比如"这条别人已经批过了"）放在最上面 ——
      // 批完最后一条之后队列就空了，挂在批改卡片上反而看不见。
      (app.cloudMsg ? '<div class="card card-warn"><p class="card-note">' + esc(app.cloudMsg) + '</p></div>' : '') +
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
      // 竖排 + 靠右：格子排在右边一列，左边留白给手掌（见 styles.css 的 .write-wrap）
      setupCanvas(el('writeCanvas'), nCells, app.strokes, true, grid, zCols, true);
    }
    if (app.view === 'parent' && app.parentUnlocked) {
      var p0 = queueHead();
      if (p0) {
        var pIsZ = p0.item.kind === 'z';
        var pGrid = pIsZ ? 'tian' : (((p0.item.mode || 'py2word') === 'word2py') ? 'pinyin' : 'tian');
        var pN = pIsZ ? (p0.item.cells || 8) : p0.item.text.length;
        var pCols = pIsZ ? (p0.item.perRow || 4) : 0;
        // 笔迹是按格子存的，所以在这台设备（屏宽可能不一样）上回放仍然对得上格子
        setupCanvas(el('reviewCanvas'), pN, p0.strokes, false, pGrid, pCols);
      }
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
    // 「本周课堂」里点某一课：直接把单元和课时切过去，省得先找单元再找课
    if (act === 'goto-lesson') {
      app.state.unit = t.getAttribute('data-u') || app.state.unit;
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
    if (act === 'home') {
      // 离开批改页时把攒下的批改结果一起传走（不管批没批完）
      if (F && F.on()) F.flushGrades();
      app.view = 'home';
      app.session = null;
      return render();
    }
    if (act === 'quit') {
      app.view = 'home';
      app.session = null;
      // 中途退出也把已经写的传上去 —— 不然孩子写到一半走了，家长那边一条都看不到
      if (F && F.on()) F.flushWork();
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
      refreshReports();     // 别的设备练得怎么样
      refreshGrades();      // 顺带看看有没有家长在别处批的结果
      return render();
    }
    if (act === 'sync') {
      // 家庭码 = 全家的钥匙（拿到码的人能看报告、也能批改），所以和报告同一道门。
      if (!app.parentUnlocked) {
        app.view = 'parent';
        app.passInput = '';
        app.afterUnlock = 'sync';   // 口令一过就直接进同步页，不用家长再找一遍
        app.message = '跨设备同步也要口令 —— 家庭码就是这家的钥匙，别让孩子拿着。';
        return render();
      }
      app.view = 'sync';
      app.afterUnlock = '';
      app.famInput = '';
      app.cloudMsg = '';
      refreshReports();
      return render();
    }
    if (act === 'parent') {
      app.view = 'parent';
      app.passInput = '';
      app.message = '';
      app.cloudMsg = '';   // 上次那句"别人批过了"不用再挂着
      refreshCloudWork();   // 别的设备写完的字，也会出现在这条队列里
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
      refreshCloudWork();
      if (app.afterUnlock === 'sync') {   // 从首页「跨设备同步」进来的，直奔同步页
        app.afterUnlock = '';
        app.view = 'sync';
        app.famInput = '';
        app.message = '';
        refreshReports();
      }
      return render();
    }
    if (act === 'unlock') {
      if (app.passInput !== app.state.passcode) {
        app.message = '口令不对。';
        return render();
      }
      app.parentUnlocked = true;
      refreshCloudWork();
      if (app.afterUnlock === 'sync') {
        app.afterUnlock = '';
        app.view = 'sync';
        app.famInput = '';
        app.message = '';
        refreshReports();
      }
      return render();
    }
    if (act === 'grade-ok') return gradeCurrent(true);
    if (act === 'grade-bad') return gradeCurrent(false);

    /* ---- 跨设备同步（只在家长报告页里能点到） ---- */
    if (act === 'sync-on') {
      if (!F) return;
      // enable 自己会校验，返回"到底开没开"
      app.cloudMsg = F.enable(F.newCode()) ? '' : '没能开启同步，再点一次试试。';
      saveState();
      return render();
    }
    if (act === 'sync-new') {
      if (!F) return;
      // 换码 = 换家庭：已经填了旧码的设备会全部失联，得挨个重填
      if (!window.confirm('换码之后，已经填了旧码的设备会失联，得重新填新码。确定换吗？')) return;
      app.cloudMsg = F.enable(F.newCode()) ? '' : '没能换码，再点一次试试。';
      saveState();
      return render();
    }
    if (act === 'sync-join') {
      if (!F) return;
      var code = String(app.famInput || '').trim().toLowerCase();
      var why = F.codeError(code);
      if (why) {
        app.cloudMsg = why === 'checksum'
          ? '这个码抄错了一位（最后那位对不上），照着另一台设备再核一遍。'
          : '家庭码是 12 位，形如 xxxx-xxxx-xxxx（字母和数字，中间两道横杠）。';
        return render();
      }
      F.enable(code);
      app.famInput = '';
      app.cloudMsg = '';
      saveState();
      refreshCloudWork();
      return render();
    }
    if (act === 'sync-off') {
      if (!F) return;
      F.disable();
      app.cloudWork = [];
      app.cloudReports = [];
      saveState();
      return render();
    }
  }

  function onInput(e) {
    var t = e.target;
    if (!t) return;
    if (t.id === 'passInput') app.passInput = t.value;
    if (t.id === 'noteInput') app.note = t.value;
    if (t.id === 'famInput') app.famInput = t.value;
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

    if (F) {
      F.init(app.state, {
        applyGrades: function (list) {
          // 家长在别处批的结果：应用到本地，并记下回执（下次联网时让云端删掉）
          var acked = applyRemoteGrades(list);
          if (acked.length) app.acked = (app.acked || []).concat(acked);
        },
        onStatus: function () { if (app.view === 'report') render(); },
        // 两个家长同时批的时候会撞车：服务端保证"先到为准"，
        // 这里把撞上的条数说一句，顺便把队列刷新成最新的。
        onGraded: function (data) {
          if (data && data.dup > 0) {
            app.cloudMsg = '有 ' + data.dup + ' 条已经被另一台设备批过了（先批的为准），队列已刷新。';
            refreshCloudWork();
          }
        }
        // 家庭码在语文 / 数学之间共用，第三参数把两边的数据隔开
      }, 'chinese');
    }

    // 从后台切回前台时取一次结果；切走时把攒下的批改结果发出去。
    // 平时不联网，也不做定时轮询。
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
          refreshGrades();
          // 上次没传成功的作业，回到前台补一次（刻意不做定时器，也不轮询）
          if (F && F.on() && F.isDirty()) F.flushWork();
        } else if (F && F.on()) {
          F.flushGrades();
        }
      });
    }

    render();
    refreshGrades();
    // 上次没传成功的（断网、关得太快、批完直接关页面），这次开机补上
    if (F && F.on() && F.isDirty()) F.flushWork();
    if (F && F.on() && F.pendingGrades()) F.flushGrades();
  }

  // 给测试挂的钩子：浏览器里它就是个没人理的对象，不影响任何行为。
  // 挂出来的都是"跨设备同步"这条链上必须钉住的函数 —— 尤其是笔迹的归一化：
  // 平板写的字要在手机上回放，还原错了家长看到的就不是孩子写的那个字。
  if (typeof window !== 'undefined') {
    window.__cc = {
      app: app,
      cellLayout: cellLayout,
      pointXY: pointXY,
      gradingQueue: gradingQueue,
      applyRemoteGrades: applyRemoteGrades,
      reportSnapshot: reportSnapshot
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
