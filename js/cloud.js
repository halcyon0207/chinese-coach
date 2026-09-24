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

  var TIMEOUT = 8000;     // 单次请求超时

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

  // 所有请求都从这里走：超时就放弃（不阻塞），失败只记一句状态
  function post(body) {
    body.v = API_VERSION;
    var ctl = setTimeoutFetch();
    var opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    };
    if (ctl) {
      opts.signal = ctl.signal;
      setTimeout(function () { try { ctl.abort(); } catch (e) {} }, TIMEOUT);
    }
    return fetch(API_BASE, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || j.code !== 0) throw new Error((j && j.message) || '同步失败');
      return j.data || {};
    });
  }

  // 失败统一记一句就完事：同步出问题不能打断孩子写字，也不能弹错误框吓家长
  function note(e) {
    lastError = (e && e.message) || '连不上';
    if (hooks.onStatus) hooks.onStatus();
  }

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

  // 写完一条：只在本机记一笔"有待传的"，不发请求。
  //
  // 为什么不做"写一个传一个"、也不做 30 秒节流窗口：
  // 孩子写一整轮也就几分钟，中途传上去家长也来不及批，白白多几次请求。
  // 一整轮写完一起传，一天就是一两次 —— 这才是"用的时候才联网"。
  function markWorkDirty() {
    var s = sync();
    if (!s) return;
    s.dirty = true;
  }

  function workPayload() {
    var s = sync();
    var items = (state.pending || []).map(function (p) {
      return {
        id: p.id,
        ts: p.ts,
        unit: p.unit || '',
        devName: s.name || '',
        item: p.item,
        strokes: (p.strokes || []).map(function (st) {
          return { cell: st.cell, pts: st.pts };
        })
      };
    });
    return { action: 'work.push', fam: s.fam, dev: s.dev, items: items };
  }

  // 一整轮写完（或者中途退出）时才真的发这一次
  function flushWork() {
    if (!on()) return Promise.resolve();
    var s = sync();
    if (!s.dirty) return Promise.resolve();   // 没有新写的，就别白跑一趟
    s.dirty = false;
    return post(workPayload()).then(function (data) {
      lastError = '';
      // 搭车带回来的批改结果：孩子端不用再单独发一次请求
      if (data.grades && data.grades.length && hooks.applyGrades) hooks.applyGrades(data.grades);
      if (hooks.onStatus) hooks.onStatus();
      return data;
    }).catch(function (e) {
      s.dirty = true;   // 没传上去，下次联网再补
      note(e);
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
    if (!on()) return Promise.resolve();
    var s = sync();
    if (!Array.isArray(s.outbox) || !s.outbox.length) return Promise.resolve();

    var list = s.outbox.slice();
    s.outbox = [];
    // dev 是"谁在批"（这台设备），grades 里的 dev 是"作业来自哪台设备"——两个不是一回事。
    // 少了外层这个 dev，服务端会以"设备标识不合法"直接拒掉。
    return post({ action: 'grade.push', fam: s.fam, dev: s.dev, grades: list })
      .then(function (data) {
        lastError = '';
        // 回调单独包一层：它要是炸了，不该让"已经交上去的批改"被回滚重发。
        // 网络失败和回调出错是两回事，别混在一起。
        try {
          if (hooks.onGraded) hooks.onGraded(data || {});
        } catch (cbErr) {
          if (typeof console !== 'undefined' && console.warn) console.warn('[cloud] onGraded 出错：', cbErr);
        }
        if (hooks.onStatus) hooks.onStatus();
        return data;
      })
      .catch(function (e) {
        s.outbox = list.concat(s.outbox || []);   // 没传上去，下次再补
        note(e);
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
    return post({ action: 'clear', fam: s.fam, dev: s.dev });
  }

  /* ------------------------------ 对外 ------------------------------ */

  function init(appState, h) {
    state = appState;
    hooks = h || {};
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
    // 切到后台再回来就会重试一次。这句得说出来，否则家长只能干等。
    if (isDirty() && lastError) {
      return '有作业没传上去（' + lastError + '），切到后台再回来就会重试';
    }
    if (isDirty()) return '有作业还没传上去';
    if (lastError) return '同步暂不可用（' + lastError + '），数据还在本机';
    if (!s.lastAt) return '已开启，还没同步过';
    var min = Math.floor((nowTs() - s.lastAt) / 60000);
    if (min < 1) return '已同步 · 刚刚';
    if (min < 60) return '已同步 · ' + min + ' 分钟前';
    var hr = Math.floor(min / 60);
    if (hr < 24) return '已同步 · ' + hr + ' 小时前';
    return '已同步 · ' + Math.floor(hr / 24) + ' 天前';
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
    markWorkDirty: markWorkDirty,
    flushWork: flushWork,
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
