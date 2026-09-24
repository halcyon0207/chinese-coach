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
      unit: 'U1',        // 当前练的单元
      lesson: 'all',     // 当前练的课时，'all' = 整个单元
      mode: 'py2word',   // 看拼音写词语 / 看词语写拼音。以前没存，重开页面就跳回默认
      passcode: '',      // 家长口令，空 = 还没设置
      stats: {},         // 'w:奇观' -> { attempts, corrects, wrongs, level, dueAt, lastAt, note }
      pending: [],       // 待家长批改
      feedback: [],      // 家长刚批改完、还没给孩子看的结果
      history: [],       // 已批改
      sync: null         // 跨设备同步（家庭码 / 设备标识），见 js/cloud.js；没开就是 null
    };
  }

  // 类型也要校。只写 `s.history || []` 的话，一个"能 parse 但形状不对"的值
  // （比如 history 是 {}）会一路混进界面，在 render 里才炸 ——
  // 表现出来是"打开就白屏"，比回到空白状态难查得多。
  function obj(v, dflt) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : dflt; }
  function arr(v, dflt) { return Array.isArray(v) ? v : dflt; }
  function str(v, dflt) { return typeof v === 'string' && v ? v : dflt; }

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
        lesson: str(s.lesson, '') || 'all',
        mode: (s.mode === 'word2py') ? 'word2py' : 'py2word',
        passcode: str(s.passcode, ''),
        stats: obj(s.stats, {}),
        pending: arr(s.pending, []),
        feedback: arr(s.feedback, []),
        history: arr(s.history, []),
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
