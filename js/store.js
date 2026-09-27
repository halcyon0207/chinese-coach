/*
 * 本地存储 —— 数据只存在这台设备上，不上传任何地方。
 *
 * 这里有两个刻意的设计：
 *  1. pending（待批改）和 history（已批改）分开存。
 *     孩子写完只是"交了作业"，在家长批改之前它不算数 ——
 *     没批改的东西不能进掌握度，否则"做了但没批"会把数据搅浑。
 *  2. 家长口令存在本机。它挡的是"孩子自己进去点全对"，
 *     不是防外人，所以不加密、不做找回 —— 忘了就重置数据重设。
 */
(function (root, factory) {
  var mod = factory(typeof self !== 'undefined' ? self : root);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.Store = mod;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var KEY = 'chinese-coach-v1';
  var loadFailed = false;   // 上一次 load 有没有读坏

  function defaultState() {
    return {
      version: 1,
      unit: 'U1',        // 当前练的单元（= 选中的第一个，报告页/识字表页仍按它看）
      // 选中的单元可以不止一个：点亮第一、二单元就出这两个单元的题。
      // 用一个数组而不是"全部/单个"两档开关 —— 范围是该自己挑的。
      units: ['U1'],
      lesson: 'all',     // 当前练的课时，'all' = 整个单元
      mode: 'py2word',   // 看拼音写词语 / 看词语写拼音。以前没存，重开页面就跳回默认
      passcode: '',      // 家长口令，空 = 还没设置
      stats: {},         // 'w:奇观' -> { attempts, corrects, wrongs, level, dueAt, lastAt, note }
      pending: [],       // 待家长批改
      feedback: [],      // 家长刚批改完、还没给孩子看的结果
      history: [],       // 已批改
      // 没写完的那一轮：整份题目 + 做到第几题 + 当前题的笔迹。
      // 练习被打断是常态，下次进同一台设备要能接着写（见 app.js 的 saveDraft）。
      draft: null,
      // 错题本里"在本子上写完、已经消掉"的那些：{ 'w:观潮': 消掉的时间 }。
      //
      // 为什么要记时间而不是只记"消掉了"：消掉之后**要是又写错了，这条得重新冒出来**。
      // 只记一个布尔值的话，孩子这次写错了、家长还得手动去恢复它，谁都记不住。
      // 判定见 app.js 的 mistakeItems：标记时间晚于最近一次写错 → 才算真消掉。
      mistakeDone: {},
      // 正在进行的"这一批复习"：题目（ids）和顺序固定，已做的记在 done 里，
      // 2 小时内有效（见 app.js 的 DUE_WINDOW_MS）。
      // 存本机而不是放内存：点进去做一半退出、来回切几次，顺序和进度都得还在 ——
      // 原来每次点进去都重新打乱，孩子刚记住的"做到哪儿了"就没了。
      dueRun: null,
      sync: null         // 跨设备同步（家庭码 / 设备标识），见 js/cloud.js；没开就是 null
    };
  }

  // 类型也要校。只写 `s.history || []` 的话，一个"能 parse 但形状不对"的值
  // （比如 history 是 {}）会一路混进界面，在 render 里才炸 ——
  // 表现出来是"打开就白屏"，比回到空白状态难查得多。
  function obj(v, dflt) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : dflt; }
  function arr(v, dflt) { return Array.isArray(v) ? v : dflt; }
  function str(v, dflt) { return typeof v === 'string' && v ? v : dflt; }

  // 选中的单元：字符串数组。**空数组是合法状态** —— 那是「综合」：
  // 家长点了「综合」，接下来自己一个个点单元（点一个亮一个）。
  // 所以不能再把空数组当成"形状不对"退回 [unit]，否则他一刷新，
  // 刚点开的综合就自己跳回第一单元了。只有不是数组时才退回 [unit]。
  function unitList(v, dflt) {
    if (!Array.isArray(v)) return dflt;
    return v.filter(function (k) { return typeof k === 'string' && k; });
  }

  // 复习批次的形状要能放心用：ids 必须是非空的字符串数组，done / startedAt 也要对。
  // 形状不对就当没有这一批（宁可从新开始），否则孩子会被丢进一场空题目 ——
  // ids 里全是别的东西时，app.js 按 key 找不到任何条目。
  function normalizeDueRun(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    var ids = arr(v.ids, []).filter(function (k) { return typeof k === 'string' && k; });
    if (!ids.length) return null;
    return {
      unit: typeof v.unit === 'string' ? v.unit : 'U1',
      lesson: typeof v.lesson === 'string' && v.lesson ? v.lesson : 'all',
      ids: ids,
      done: arr(v.done, []).filter(function (k) { return typeof k === 'string' && k; }),
      startedAt: (typeof v.startedAt === 'number' && isFinite(v.startedAt)) ? v.startedAt : 0
    };
  }

  function load() {
    loadFailed = false;
    try {
      var raw = root.localStorage && root.localStorage.getItem(KEY);
      if (!raw) return defaultState();
      var s = JSON.parse(raw);
      if (!s || typeof s !== 'object') throw new Error('形状不对');
      var d = defaultState();
      return {
        version: s.version || d.version,
        unit: str(s.unit, d.unit),
        units: unitList(s.units, [str(s.unit, d.unit)]),
        lesson: str(s.lesson, '') || 'all',
        mode: (s.mode === 'word2py') ? 'word2py' : 'py2word',
        passcode: str(s.passcode, ''),
        stats: obj(s.stats, {}),
        pending: arr(s.pending, []),
        feedback: arr(s.feedback, []),
        history: arr(s.history, []),
        draft: obj(s.draft, null),
        mistakeDone: obj(s.mistakeDone, {}),
        dueRun: normalizeDueRun(s.dueRun),
        sync: obj(s.sync, { on: false, fam: '', dev: '', name: '', lastAt: 0 })
      };
    } catch (e) {
      loadFailed = true;
      return defaultState();
    }
  }

  function save(state) {
    try {
      root.localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      if (root.console && root.console.warn) {
        root.console.warn('[chinese-coach] 本地保存失败：', e);
      }
      return false;
    }
  }

  function reset() {
    try { root.localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    return defaultState();
  }

  return {
    KEY: KEY,
    defaultState: defaultState,
    load: load,
    save: save,
    reset: reset,
    loadFailed: function () { return loadFailed; }
  };
});
