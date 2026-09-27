/*
 * 跨设备同步 —— 静默上传 / 拉取，没有任何按钮
 *
 * 三条流各有各的唯一写入者，所以写入永远不会互相覆盖：
 *   work   作业（含笔迹）  孩子设备写，家长端读     批完就删
 *   grade  批改结果        家长端写，孩子设备读     取走（ack）就删
 *   report 统计快照        孩子设备写，家长端读     覆盖写，只留最新一份
 *
 * 几条刻意的克制：
 *  1. 没有定时轮询。只在"本来就在发生的动作"里顺带联网：写完、批改、打开页面。
 *     关掉页面就完全不联网 —— 不耗电、不跑流量。
 *  2. 上传节流：30 秒内的多条合成一次请求（一轮写完立刻 flush，不等窗口）。
 *  3. 一切失败都静默。同步失败不能打断孩子写字，也不能弹错误框吓家长；
 *     只记一句状态，联网后自动补。
 *  4. 同步是可选的。没开家庭码时这里全是空转，项目还是原来那个纯本地的项目。
 */
(function (root) {
  'use strict';

  // 云函数地址（部署 10_家庭数据同步 之后填进来；两个项目用同一个）
  var API_BASE = 'https://trae-projects-4g5aob6ufac38569-1421597865.ap-shanghai.app.tcloudbase.com/report';

  // 单次请求超时。云函数每次都要"读 GitHub → 改 → 写回"，云端那份文件大了以后
  // 一个来回要好几秒；8 秒（原来）会经常提前放弃 —— 而放弃不等于服务端没做事：
  // 它可能已经写进去了，只是回信没赶上。于是前端判失败、排队重发，服务端再看到
  // 就是"这条已经批过了"。家长会莫名其妙看到"被另一台设备批过"，其实根本没有第二台。
  var TIMEOUT = 25000;

  // 家庭码长什么样。前端也按这个校验 —— 不然输个 "abc" 也当成"已开启"，
  // 结果是每次请求都被服务端打回来，而界面只说一句"同步暂不可用"，
  // 家长分不清到底是网不好还是码填错了，而且这个错状态还会一直存在本机。
  var FAM_RE = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
  // 去掉了 0/o、1/l 这些念错抄错的字符，剩下 31 个（质数，校验位靠它）。
  // 必须和云函数 lib/sync.js 的 CODE_ABC 完全一致。
  var CODE_ABC = 'abcdefghijkmnpqrstuvwxyz2345678';
  // 接口版本。云函数会对着它校验：以后改了 action 名或响应结构，
  // 还留在用户浏览器里的老页面会拿到"请刷新页面"，而不是一堆看不懂的报错。
  var API_VERSION = 1;

  var state = null;       // 指向 app.state（里面有 sync 那一段）
  var hooks = {};         // { applyGrades, onStatus }
  // 哪个项目在用它。由 init() 传进来（'chinese' / 'math'）——
  // 两个项目共用同一份 cloud.js，差异只在这里，免得复制的时候忘了改。
  var APP = 'chinese';
  var busy = false;
  var lastAt = 0;
  var lastError = '';
  var workCount = 0;

  function nowTs() { return Date.now(); }

  // 家庭码：3 段 4 位，去掉了 0/o/1/l 这些容易念错抄错的字符 ——
  // 它是靠"家长念给另一台设备听"或者扫一下传过去的，念错一个字就得重来。
  // 校验位算法必须和云函数 lib/sync.js 的 codeCheckChar 一致（改要两边一起改）。
  //
  // 为什么最后一位要做校验：服务端不记录"现在有哪些家庭码"，所以抄错一位的码
  // 格式照样合法 —— 家长会静默连进一个空家庭，界面显示"已开启"，
  // 但永远看不到孩子的作业，而且查不出原因。加一位校验，抄错当场拦下。
  function checkChar(body) {
    var sum = 0;
    for (var i = 0; i < body.length; i++) {
      var idx = CODE_ABC.indexOf(body.charAt(i));
      sum += (idx < 0 ? 0 : idx + 1) * (i + 1);
    }
    return CODE_ABC.charAt(sum % CODE_ABC.length);
  }

  function newCode() {
    function seg(n) {
      var s = '';
      for (var i = 0; i < n; i++) s += CODE_ABC.charAt(Math.floor(Math.random() * CODE_ABC.length));
      return s;
    }
    var all = seg(4) + seg(4) + seg(3);   // 前 11 位随机
    all += checkChar(all);                // 第 12 位 = 校验位
    return all.slice(0, 4) + '-' + all.slice(4, 8) + '-' + all.slice(8, 12);
  }

  // '' = 没问题；'format' = 根本不是这个格式；'checksum' = 格式对，但抄错了一位
  function codeError(code) {
    var cleaned = String(code || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!FAM_RE.test(cleaned)) return 'format';
    var body = cleaned.replace(/-/g, '');
    return checkChar(body.slice(0, 11)) === body.charAt(11) ? '' : 'checksum';
  }

  function newDev() {
    return 'd' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }

  function sync() {
    if (!state) return null;
    if (!state.sync || typeof state.sync !== 'object') state.sync = {};
    var s = state.sync;
    if (!s.dev) s.dev = newDev();
    if (typeof s.on !== 'boolean') s.on = false;
    if (typeof s.fam !== 'string') s.fam = '';
    if (typeof s.name !== 'string') s.name = '';
    if (typeof s.lastAt !== 'number') s.lastAt = 0;
    if (typeof s.dirty !== 'boolean') s.dirty = false;
    return s;
  }

  function on() {
    var s = sync();
    return !!(s && s.on && s.fam);
  }

  function setTimeoutFetch() {
    return (typeof AbortController === 'function') ? new AbortController() : null;
  }

  // 明确离线就别发。注意反过来不成立：onLine 为 true 也可能连不上
  // （连上了 WiFi 但没有互联网），那种还是照发，超时归超时。
  // 这一层只为省掉"明知道没网还干等 25 秒" —— 那段时间界面上什么都没有，
  // 家长只能干等，还以为提交已经在跑了。
  function offline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  // 所有请求都从这里走：超时就放弃（不阻塞），失败只记一句状态
  function post(body) {
    body.v = API_VERSION;
    body.app = APP;   // 语文 / 数学共用同一个家庭码，靠这个隔开两边的数据
    if (offline()) return Promise.reject(new Error('现在没网'));

    var ctl = setTimeoutFetch();
    var opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    };
    if (ctl) opts.signal = ctl.signal;

    // 超时必须**自己兜住**，不能指望 AbortController：
    // 1) 不支持它的浏览器（老平板上的旧 Safari）压根没有超时 —— fetch 一直挂着，
    //    这个 Promise 永远不返回，界面就永远停在"正在提交…"，而家长那头永远收不到；
    // 2) 就算支持，abort 之后 fetch 什么时候 reject 由浏览器决定，不是我们说了算。
    // 所以再用 Promise.race 加一道：到点一定给调用方一个结果（失败也是一种结果）。
    // abort 保留着 —— 能把那个请求真的掐掉，省下这一路的流量和时间。
    var req = fetch(API_BASE, opts);
    var timer = null;
    var guard = new Promise(function (_, rej) {
      timer = setTimeout(function () {
        try { if (ctl) ctl.abort(); } catch (e) {}
        rej(new Error('超时'));
      }, TIMEOUT);
    });

    function done(r) { clearTimeout(timer); return r; }
    function fail(e) { clearTimeout(timer); throw e; }

    return Promise.race([req, guard]).then(done, fail).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || j.code !== 0) throw new Error((j && j.message) || '同步失败');
      return j.data || {};
    });
  }

  // 浏览器的 fetch 失败给的是各家自己的原文 —— Chrome 说 Failed to fetch、
  // Safari 说 Load failed、Firefox 说 Network request failed。家长看不懂，
  // 更麻烦的是**会被误导**：屏幕上写着这句，家长只会想"我明明连着网啊"。
  //
  // 所以翻成人话，并把两件事分开，因为处理办法完全不同：
  //   · 连不上 —— 请求压根没落地（DNS 解析不出 / 连接建不起来 / 被网络层拦掉）→ 换网络
  //   · 超时   —— 发出去过，服务器没回话 → 再点一次就只补没传完的
  function friendly(e) {
    var m = String((e && e.message) || '');
    if (!m) return '连不上';
    if (/超时/.test(m)) return '服务器没回话（超时）';
    if (/Failed to fetch|Load failed|Network request failed|NetworkError/i.test(m)) {
      return '这台设备连不上同步服务器';
    }
    return m;
  }

  // 失败统一记一句就完事：同步出问题不能打断孩子写字，也不能弹错误框吓家长
  function note(e) {
    lastError = friendly(e);
    if (hooks.onStatus) hooks.onStatus();
  }

  // 这一把锁**现在没有调用点**：flushWork / flushGrades 都是直接跑的。
  // 并发安全靠的是另外两层，别误以为靠它：
  //   · 作业流 —— flushWork 一进来就把 dirty 清掉，第二次调用会被 skipped 挡住；
  //   · 批改流 —— flushGrades 先把 outbox 截走，第二次进来拿到的是剩下的那批。
  // 留着它是为了以后要加"自动重试"时有个现成的串行口子；
  // 真到那时候再按流分开（作业 / 批改 / 报告各一把），一把全局锁会互相拖累。
  function ok(fn) {
    if (!on() || busy) return;
    busy = true;
    fn().then(function () {
      busy = false;
      lastAt = nowTs();
      lastError = '';
      if (state.sync) state.sync.lastAt = lastAt;
      if (hooks.onStatus) hooks.onStatus();
    }).catch(function (e) {
      busy = false;
      note(e);
    });
  }

  /* ------------------------------ 作业流（孩子端写） ------------------------------ */

  // 上传前先把笔迹抽稀。
  //
  // 为什么非抽不可：getCoalescedEvents 会把浏览器攒下的每个硬件采样点都交出来，
  // 相邻两点常常只差零点几个像素 —— 回放时根本看不出来，却让请求体和云端
  // 那一份 JSON 白白胖一圈。队列攒到一百多条时，这一圈就是"几百 KB"和"200KB"的差别：
  // 云函数请求体上限 256KB；云端单文件超过 1MB 还会让 GitHub 干脆不返回内容
  // （那时候全家所有设备都同步不了，比"传不上去"严重得多）。
  //
  // 只作用于"要传上去的那份副本"：本机存的笔迹原样不动，回放质量不受影响。
  // 参数是算出来的，不是拍的：一个家庭一个云端文件，而 GitHub 对超过 1MB 的文件
  // 干脆不返回内容，所以那个文件必须稳在 700KB 以内。按"一条两字词、每字 10 笔"估，
  // 每笔留 12 个点时一条约 5KB，一百多条排队的队列正好装得下，回放也还认得出字形。
  var MIN_PT_DIST = 0.02;       // 格宽的 2%（约 2px），比这更密的点回放时看不出来
  var MAX_PTS_PER_STROKE = 12;  // 单笔最多留这么多点，一笔的形状还在

  function thinPts(pts) {
    var list = Array.isArray(pts) ? pts : [];
    if (list.length <= 2) return list.slice();

    var out = [list[0]];
    for (var i = 1; i < list.length - 1; i++) {
      var b = list[i];
      if (!b || typeof b.u !== 'number' || typeof b.v !== 'number') continue;
      var a = out[out.length - 1];
      if (Math.abs(b.u - a.u) + Math.abs(b.v - a.v) >= MIN_PT_DIST) out.push(b);
    }
    out.push(list[list.length - 1]);

    // 抽过一轮还是太多（一笔写得很慢、采样特别密），就等距再抽一次
    if (out.length > MAX_PTS_PER_STROKE) {
      var step = out.length / MAX_PTS_PER_STROKE, thin = [];
      for (var j = 0; j < MAX_PTS_PER_STROKE - 1; j++) thin.push(out[Math.floor(j * step)]);
      thin.push(out[out.length - 1]);
      out = thin;
    }
    return out;
  }

  // 给报告快照也留个入口：家长在自己手机上看报告时，那份笔迹同样要瘦过身
  function thinStrokes(strokes) {
    return (strokes || []).map(function (st) {
      return { cell: st.cell, pts: thinPts(st.pts) };
    });
  }

  // 切批几乎只看体积，条数只是兜底。
  //
  // 为什么不再按"每批 10 条"切：云端每收一个请求都要"读整个家庭那份 JSON → 改 → 写回"，
  // 文件越大一个来回越慢。62 条作业按 10 条一批就是 7 个来回（实测半分钟往上），
  // 而这 7 个来回期间界面上只有一句"正在提交…" —— 看着像卡死了，其实一直在传，
  // 家长在那头刷新看到的自然也只有"先到的那一部分"（提交根本还没结束）。
  // 所以一个请求能装多少就装多少：云函数请求体上限 256KB，这里留足余量。
  var BATCH_MAX_ITEMS = 60;          // 只是兜底：真正在切的是字节数
  var BATCH_MAX_BYTES = 150 * 1024;

  // 请求体的大小要按 UTF-8 **字节**算，不是字符数：JSON 里的中文一个字占 3 字节，
  // 按字符数估会低估（一条作业里题目、单元名都是中文），真超了 256KB
  // 会被云函数整个打回 —— 那一批白传，还得从头再来。
  function byteLen(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      n += (c < 0x80) ? 1 : ((c < 0x800) ? 2 : 3);
    }
    return n;
  }

  function sizeOf(o) {
    try { return byteLen(JSON.stringify(o)); } catch (e) { return 4096; }
  }

  // 写完一条：只在本机记一笔"有待传的"，不发请求。
  //
  // 为什么不做"写一个传一个"、也不做 30 秒节流窗口：
  // 孩子写一整轮也就几分钟，中途传上去家长也来不及批，白白多几次请求。
  // 一整轮写完一起传，一天就是一两次 —— 这才是"用的时候才联网"。
  function markWorkDirty() {
    var s = sync();
    if (!s) return;
    s.dirty = true;
    // 这个标记**必须落盘**。它是"还有东西没传上去"的唯一凭据 ——
    // 只改内存的话，提交传到一半被关掉（或页面被刷新），下次进来 dirty 又变回 false，
    // 那批作业就再也不会自动补传了，除非有人想起来再点一次「提交给家长批改」。
    save();
  }

  // 存盘交给界面层（localStorage 在 app.js 那边），这里只有一个钩子。
  // 没有钩子时（比如测试里）就只改内存，行为照旧。
  function save() {
    if (hooks.onSave) { try { hooks.onSave(); } catch (e) {} }
  }

  function workPayload() {
    var s = sync();
    var items = (state.pending || []).map(function (p) {
      return {
        id: p.id,
        ts: p.ts,
        unit: p.unit || '',
        // 没起过名字的设备别硬塞一个"设备"上去：家长那台手机上是这么显示的 ——
        // 「这一条是「设备」上写的」，读起来像话没说完。空着，界面自己会说"另一台设备"。
        devName: (s.name && s.name !== '设备') ? s.name : '',
        item: p.item,
        strokes: thinStrokes(p.strokes)
      };
    });
    return { action: 'work.push', fam: s.fam, dev: s.dev, items: items };
  }

  // 一整轮写完（或者点了「提交给家长批改」）时才真的发这一次。
  //
  // 队列可能攒了一百多条、每条又带着笔迹，一个请求装不下（云函数请求体 256KB）。
  // 所以这里按体积切成几批顺序发：第一批照旧"整份覆盖"（本地队列是权威），
  // 后面的批带 append 往上垒 —— 几批的并集正好是完整的队列，结果和一次发完一样，
  // 只是分成了几个请求。
  //
  // 一次失败就放弃太贵：整批重来意味着云端又要"读一遍、写一遍"那个大文件，
  // 而网络抖一下恰恰是这里最常见的失败。所以只重试一次，而且退避一下再试 ——
  // 但服务端说"太频繁"（429）时**不**重试：那时候重试只会把队列堵得更死。
  function postOnce(body) {
    return post(body).catch(function (e) {
      var m = (e && e.message) || '';
      // 超时也**不**重试：它通常意味着这一路就是慢/卡住了，再等一轮（25 秒 + 25 秒）
      // 只会让界面在"正在提交…"上挂上一分钟，家长什么反馈都拿不到。
      // 立刻失败反而好 —— 界面马上说"没提交上去（超时）"，
      // 而断点续传记账已经落在本机，再点一次只补没传完的那部分。
      if (/429|频繁|超时/.test(m)) throw e;
      return new Promise(function (res) { setTimeout(res, 1200); }).then(function () {
        return post(body);
      });
    });
  }

  // 自检第三步的体量：和一批作业相当（BATCH_MAX_BYTES 150KB，这里取 120KB）。
  // 用名字常量而不是就地写个数字，是因为这个数必须和"提交时一批能装多少"对得上 ——
  // 对不上就会测出一个"通"，而真实提交照样失败，等于白测。
  var BIG_KB = 120;
  function BIG_PAD() {
    return new Array(BIG_KB * 1024 + 1).join('x');
  }

  // 「测一下网络」：分三步问，因为这几步的结果**可以不一样** —— 而不一样的时候，
  // 恰好就是最难解释的那种现象。
  //
  //   ① 直接连服务器（GET）：你在浏览器地址栏里打开那个网址，走的就是这一类。
  //      它通，说明域名解析、连接、证书、来回全都没问题。
  //   ② 网页里脚本发出去的请求（POST，就是提交作业那一趟）：有些浏览器的"安全防护 /
  //      广告过滤"只拦第 ② 种 —— 它们把"网页自己发起的请求"当广告或追踪打掉。
  //      于是就成了"网址打得开，但作业提交不上去"。
  //
  // 两步一起报，"连不上"才不再是一句没用的废话：第一步通、第二步不通，答案就写在脸上。
  function checkNetwork() {
    if (!on()) return Promise.resolve({ ok: false, error: '没开同步' });
    var s = sync();
    var t1 = nowTs();
    // ① 只要求"有响应"，哪怕它是 400 —— 服务器收到了、也回话了，这就叫通
    return fetch(API_BASE, { method: 'GET', cache: 'no-store' })
      .then(function (r) { return { ok: true, status: r.status, ms: nowTs() - t1 }; },
            function (e) { return { ok: false, ms: nowTs() - t1, error: friendly(e) }; })
      .then(function (direct) {
        var t2 = nowTs();
        return post({ action: 'hello', fam: s.fam, dev: s.dev }).then(function () {
          return { direct: direct, post: { ok: true, ms: nowTs() - t2 } };
        }, function (e) {
          // 顺手把状态记上：测出来不通，报告页那句状态也就跟着说实话了
          lastError = friendly(e);
          if (hooks.onStatus) hooks.onStatus();
          return { direct: direct, post: { ok: false, ms: nowTs() - t2, error: friendly(e) } };
        });
      })
      .then(function (r) {
        // ③ 再按**真实提交的体量**发一趟（约 120 KB，和一批作业相当）。
        // 前两步都很小，它们通只说明"这条路上能走人"；而真正要背的是几十上百 KB 的笔迹。
        // 大请求卡在中间某一层（路由器、浏览器、运营商）时，表现和小请求被拦一模一样 ——
        // 都是"拿不到响应"。只有按真实体量量一次，才能把这两件事分开。
        // 载荷塞在 hello 里：云函数读得动、但它不认识这个字段，也不写任何数据。
        var t3 = nowTs();
        var payload = { action: 'hello', fam: s.fam, dev: s.dev, pad: BIG_PAD() };
        return post(payload).then(function () {
          return { direct: r.direct, post: r.post, big: { ok: true, ms: nowTs() - t3, kb: BIG_KB } };
        }, function (e) {
          return {
            direct: r.direct, post: r.post,
            big: { ok: false, ms: nowTs() - t3, kb: BIG_KB, error: friendly(e) }
          };
        });
      });
  }

  // 返回 { ok }: 界面上那个提交按钮要照着说一句实话 ——
  // "已提交"和"没传上去"对家长是两件完全不同的事。老调用方不看返回值，照旧。
  //
  // onProgress（可选）每批落地后调一次，带上 { batch, batches, sent, total }：
  // 六十多条要传半分钟，界面上只写一句"正在提交…"和卡死没区别 ——
  // 家长在那头看见"只到了 26 条"就是这么来的：提交还在半路上，他先刷新了。
  function flushWork(onProgress) {
    if (!on()) return Promise.resolve({ ok: false, error: '没开同步' });
    var s = sync();
    if (!s.dirty) return Promise.resolve({ ok: true, skipped: true });   // 没有新写的，就别白跑一趟
    s.dirty = false;

    var all = workPayload().items;
    if (!all.length) return Promise.resolve({ ok: true, skipped: true });

    // 断点续传：上一次没传完的（断网、超时、关页面）已经躺在云端了，这次只补剩下的。
    // 不记这笔账的话，一次失败就得把整个队列从第一批重新覆盖一遍 ——
    // 六十多条从头再来就是好几分钟，而"其实只差最后一批没上去"是最常见的情况。
    var doneIds = [];
    var pushed = {};
    (Array.isArray(s.workPushed) ? s.workPushed : []).forEach(function (id) {
      if (!pushed[id]) { pushed[id] = 1; doneIds.push(id); }
    });
    var resume = doneIds.length > 0;
    var todo = all.filter(function (it) { return !pushed[it.id]; });
    if (!todo.length) {   // 上次其实全传上去了，只是回信没等到
      s.workPushed = [];
      lastError = '';
      if (hooks.onStatus) hooks.onStatus();
      return Promise.resolve({ ok: true, count: all.length, batches: 0 });
    }

    var batches = [];
    var cur = [], curBytes = 0;
    todo.forEach(function (it) {
      var n = sizeOf(it);
      if (cur.length && (cur.length >= BATCH_MAX_ITEMS || curBytes + n > BATCH_MAX_BYTES)) {
        batches.push(cur);
        cur = [];
        curBytes = 0;
      }
      cur.push(it);
      curBytes += n;
    });
    if (cur.length) batches.push(cur);

    var grades = [];
    var full = 0;   // 云端装不下、还留在本机的条数
    var sent = 0;
    var chain = Promise.resolve();
    batches.forEach(function (batch, i) {
      chain = chain.then(function () {
        var body = { action: 'work.push', fam: s.fam, dev: s.dev, items: batch };
        // 第一批不带 append（整份覆盖），后面几批往上垒；
        // 接着上次没传完的那批也必须带 append —— 否则会把已经上去的那部分冲掉。
        if (i > 0 || resume) body.append = true;
        return postOnce(body).then(function (data) {
          // 搭车带回来的批改结果：孩子端不用再单独发一次请求
          if (data && data.grades && data.grades.length) grades = grades.concat(data.grades);
          // 云端说"装不下了"的条数。每批各报各的，要累加 ——
          // 空间是逐批消耗掉的，后面的批可能整批都塞不进去。
          if (data && typeof data.full === 'number') full += data.full;
          batch.forEach(function (it) { doneIds.push(it.id); });
          sent += batch.length;
          if (typeof onProgress === 'function') {
            onProgress({ batch: i + 1, batches: batches.length, sent: sent, total: todo.length });
          }
        });
      });
    });

    return chain.then(function () {
      lastError = '';
      s.workPushed = [];
      save();                  // 传完了：把"还有没传的"这份账销掉
      if (grades.length && hooks.applyGrades) hooks.applyGrades(grades);
      if (hooks.onStatus) hooks.onStatus();
      return { ok: true, count: all.length, batches: batches.length, full: full };
    }).catch(function (e) {
      s.dirty = true;          // 下次联网再补
      s.workPushed = doneIds;  // 已经上去的那些记下来，下次只补剩下的
      save();                  // 同上：不落盘的话，这次失败就再也没人记得要补
      note(e);
      return { ok: false, error: lastError, sent: doneIds.length, total: all.length };
    });
  }

  /* ------------------------------ 批改流（家长端写） ------------------------------ */

  // 批改也是攒一批再传：字词拼音批得很快，一条一传纯属浪费请求。
  // 先记在本机（连带落盘，批完直接关页面也不会丢），
  // 批完这一批（或离开批改页、切到后台）时一起发出去。
  function queueGrade(g) {
    var s = sync();
    if (!s) return;
    if (!Array.isArray(s.outbox)) s.outbox = [];
    s.outbox.push(g);
  }

  function flushGrades() {
    if (!on()) return Promise.resolve({ ok: false, error: '没开同步' });
    var s = sync();
    if (!Array.isArray(s.outbox) || !s.outbox.length) return Promise.resolve({ ok: true, skipped: true });

    var list = s.outbox.slice();
    s.outbox = [];
    // 立刻落盘：这一刻起"待发的批改"已经是空的了。
    // 不存的话，post() 那 25 秒里要是页面被关掉，下次打开 outbox 里还有这同一批 ——
    // 会再发一次（服务端幂等，不会批错，但白白多一趟请求）。
    save();
    // dev 是"谁在批"（这台设备），grades 里的 dev 是"作业来自哪台设备"——两个不是一回事。
    // 少了外层这个 dev，服务端会以"设备标识不合法"直接拒掉。
    return post({ action: 'grade.push', fam: s.fam, dev: s.dev, grades: list })
      .then(function (data) {
        lastError = '';
        save();   // 传完再存一次：万一上面那次没写成，这里兜住
        // 回调单独包一层：它要是炸了，不该让"已经交上去的批改"被回滚重发。
        // 网络失败和回调出错是两回事，别混在一起。
        try {
          if (hooks.onGraded) hooks.onGraded(data || {});
        } catch (cbErr) {
          if (typeof console !== 'undefined' && console.warn) console.warn('[cloud] onGraded 出错：', cbErr);
        }
        if (hooks.onStatus) hooks.onStatus();
        return { ok: true, count: list.length };
      })
      .catch(function (e) {
        s.outbox = list.concat(s.outbox || []);   // 没传上去，下次再补
        save();                                   // 同上：这笔账要在本机
        note(e);
        return { ok: false, error: lastError };
      });
  }

  function pendingGrades() {
    var s = sync();
    return (s && Array.isArray(s.outbox)) ? s.outbox.length : 0;
  }

  function isDirty() {
    var s = sync();
    return !!(s && s.dirty);
  }

  // 孩子端取结果：带 acks（上次取走的），服务端删掉它们，避免重装后重放
  function pullGrades(acks) {
    if (!on()) return Promise.resolve();
    var s = sync();
    return post({ action: 'grade.pull', fam: s.fam, dev: s.dev, acks: acks || [] })
      .then(function (data) {
        if (data.grades && data.grades.length && hooks.applyGrades) hooks.applyGrades(data.grades);
        return data;
      });
  }

  /* ------------------------------ 作业流（家长端读） ------------------------------ */

  // 家长端拉所有设备的待批改。笔迹只在内存里，不落本地存储 ——
  // 别的设备写的字没必要长期占着这台设备的空间。
  function pullWork() {
    if (!on()) return Promise.resolve([]);
    var s = sync();
    return post({ action: 'work.pull', fam: s.fam }).then(function (d) { return d.items || []; });
  }

  /* ------------------------------ 统计流（孩子端写，家长端读） ------------------------------ */

  function pushReport(snapshot) {
    if (!on()) return Promise.resolve();
    var s = sync();
    return post({ action: 'report.push', fam: s.fam, dev: s.dev, snapshot: snapshot });
  }

  function pullReports() {
    if (!on()) return Promise.resolve([]);
    var s = sync();
    return post({ action: 'report.pull', fam: s.fam }).then(function (d) { return d.reports || []; });
  }

  /* ------------------------------ 清空 ------------------------------ */

  function clearDevice() {
    if (!on()) return Promise.resolve();
    var s = sync();
    s.workPushed = [];   // 云端那份已经清了，"上次传到哪"这笔账也跟着作废旧
    return post({ action: 'clear', fam: s.fam, dev: s.dev });
  }

  /* ------------------------------ 对外 ------------------------------ */

  // h 里可以传 { applyGrades, onGraded, onStatus }；appName 是 'chinese' / 'math'
  function init(appState, h, appName) {
    state = appState;
    hooks = h || {};
    if (typeof appName === 'string' && appName) APP = appName;
    sync();
  }

  // 返回"到底开没开"：码不对就当没开（而不是开着但永远失败）
  function enable(code) {
    var s = sync();
    if (!s) return false;
    var err = codeError(code);
    var cleaned = String(code || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    s.fam = err ? '' : cleaned;
    s.on = !err;
    if (!err && !s.name) s.name = '设备';
    return !err;
  }

  function disable() {
    var s = sync();
    if (!s) return;
    s.on = false;
  }

  function statusText() {
    var s = sync();
    if (!s || !s.on) return '未开启跨设备同步';
    // 没有定时器、也不轮询（这是刻意的选择），所以失败之后要给人一条能自己动手的路：
    // 回到前台、或者再点一次提交就会重试。这句得说出来，否则家长只能干等。
    if (isDirty() && lastError) {
      return '有作业没传上去（' + lastError + '），再点一次「提交给家长批改」就会重试';
    }
    if (isDirty()) return '有作业还没传上去';
    if (lastError) return '同步暂不可用（' + lastError + '），数据还在本机';
    if (!s.lastAt) return '已开启，还没同步过';
    var min = Math.floor((nowTs() - s.lastAt) / 60000);
    // 说"已发出"而不是"已同步"：这里记录的只是**这台设备最后一次把请求发出去**的时间，
    // 不代表对方已经收到了。写"已同步"的话，家长会以为孩子那边已经看到批改结果，
    // 实际上可能还在路上（或者根本没送到）。
    if (min < 1) return '已发出 · 刚刚';
    if (min < 60) return '已发出 · ' + min + ' 分钟前';
    var hr = Math.floor(min / 60);
    if (hr < 24) return '已发出 · ' + hr + ' 小时前';
    return '已发出 · ' + Math.floor(hr / 24) + ' 天前';
  }

  root.FamilySync = {
    API_BASE: API_BASE,
    init: init,
    sync: sync,
    on: on,
    enable: enable,
    disable: disable,
    newCode: newCode,
    codeError: codeError,
    statusText: statusText,
    checkNetwork: checkNetwork,
    markWorkDirty: markWorkDirty,
    flushWork: flushWork,
    thinStrokes: thinStrokes,
    queueGrade: queueGrade,
    flushGrades: flushGrades,
    pendingGrades: pendingGrades,
    pullGrades: pullGrades,
    pullWork: pullWork,
    pushReport: pushReport,
    pullReports: pullReports,
    clearDevice: clearDevice,
    isDirty: isDirty
  };
})(typeof window !== 'undefined' ? window : this);
