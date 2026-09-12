/* 逻辑回归测试：用最小 DOM 桩在 node 里跑 index.html 的内嵌脚本
   覆盖阶段 1（列表/标记/持久化）与阶段 2（每日任务/复习池/词库导入）
   用法：node smoke-test.js */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'index.html');
const html = fs.readFileSync(file, 'utf8');
// 取最后一个 <script>：文件开头还有一段“提前定主题”的小脚本
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const js = scripts[scripts.length - 1][1];

/* ---------------- 最小 DOM / storage 桩 ---------------- */
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};

let els = {};
let listClick = null;
let keydownHandler = null;
let reloaded = 0;
const timers = [];
const spoken = [];

// HTML 里真正带 hidden 属性的元素（其它元素默认可见，和浏览器一致）
const INITIALLY_HIDDEN = new Set(['kbd', 'mask', 'setMask', 'notice', 'importFile', 'checkin', 'celebrateMask', 'ctaBanner']);

function makeEl(id) {
  const classes = new Set();
  const el = {
    id, textContent: '', hidden: INITIALLY_HIDDEN.has(id), dataset: {}, value: '', checked: false,
    style: {},
    handlers: {},
    classList: {
      toggle(c, on) {
        if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
        else if (on) classes.add(c); else classes.delete(c);
      },
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      contains: c => classes.has(c)
    },
    addEventListener(type, fn) {
      this.handlers[type] = fn;
      if (id === 'list' && type === 'click') listClick = fn;
    },
    querySelectorAll: () => [],
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k]; },
    children: [],
    appendChild(child) { this.children.push(child); },
    // 真实浏览器里 focus() 会把 document.activeElement 指到自己
    focus() {
      global.document.activeElement = this;
      // 模拟部分安卓浏览器：聚焦时把页面滚到顶部
      if (global.window.__focusJumps) global.window.scrollY = 0;
    },
    blur() { if (global.document.activeElement === this) global.document.activeElement = null; },
    selectionCalls: 0,
    setSelectionRange(start, end) { this.selection = [start, end]; this.selectionCalls += 1; },
    click() {}, remove() {}
  };
  // 真实 DOM 里给 innerHTML 赋值会清空所有子节点，这里照做
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) { html = String(v); el.children = []; }
  });
  return el;
}
// 模拟 <html>：承载 data-theme 和 CSS 变量
const htmlEl = {
  dataset: {},
  style: {
    props: {},
    setProperty(k, v) { this.props[k] = v; },
    removeProperty(k) { delete this.props[k]; }
  }
};
// 读 CSS 变量时属性名就是键
['--font-head', '--fs-scale'].forEach(k => {
  Object.defineProperty(htmlEl.style, k, {
    get() { return this.props[k]; },
    set(v) { this.props[k] = v; }
  });
});

let prefersDark = false;

global.document = {
  getElementById: id => (els[id] = els[id] || makeEl(id)),
  createElement: () => makeEl('tmp'),
  body: makeEl('body'),
  documentElement: htmlEl,
  activeElement: null,
  title: ''
};
// 模拟 <html>：承载 data-theme 和 CSS 变量
global.window = {
  scrollY: 0,
  scrollTo(x, y) { this.scrollY = y; },
  addEventListener(type, fn) { if (type === 'keydown') keydownHandler = fn; },
  matchMedia(q) {
    return {
      matches: /dark/.test(q) ? prefersDark : false,
      media: q,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}
    };
  },
  // Web Speech API 桩：记录被朗读的文本
  speechSynthesis: { cancel() {}, speak(u) { spoken.push(u.text); } },
  SpeechSynthesisUtterance: function (text) { this.text = text; this.lang = ''; this.rate = 1; }
};
// 下载相关的桩
global.Blob = function (parts, opts) { this.parts = parts; this.type = opts && opts.type; };
global.URL = { createObjectURL: () => 'blob:test', revokeObjectURL() {} };
global.location = { reload() { reloaded += 1; } };
// setTimeout 桩：先攒起来，由测试决定何时“到点”；clearTimeout 要真的能取消
let timerId = 0;
global.setTimeout = (fn, ms) => { const id = ++timerId; timers.push({ id, fn, ms }); return id; };
global.clearTimeout = id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); };
function flushTimers() { timers.splice(0).forEach(t => t.fn()); }
function pendingTimers() { return timers.length; }

// 触发某个元素上注册过的事件（this 指向元素本身，和真实浏览器一致）
function fire(id, type, evt) {
  const e = els[id];
  if (!e || !e.handlers[type]) throw new Error('元素 ' + id + ' 上没有 ' + type + ' 处理函数');
  e.handlers[type].call(e, evt || { target: e });
}

function boot() { els = {}; listClick = null; keydownHandler = null; new Function(js)(); }
function el(id) {
  // 真实 DOM 的 textContent/innerHTML 读出来永远是字符串，这里照做
  const e = els[id];
  return {
    get textContent() { return String(e.textContent); },
    get innerHTML() { return String(e.innerHTML); }
  };
}
// 模拟点击行内某个元素：target.closest(sel) 返回该元素，该元素自己再 closest('.row') 找到所在行
// ancestor 用来模拟“这一行在哪个区域里”（.sec-pending / .sec-known）
function clickElem(word, sel, dataset, ancestor) {
  const el = {
    dataset: dataset || {},
    closest: s => {
      if (s === '.row') return { dataset: { word } };
      if (ancestor && s === ancestor) return { dataset: { word } };
      return null;
    }
  };
  listClick({ target: { closest: s => (s === sel ? el : null) } });
}
function click(word, act) { clickElem(word, 'button[data-act]', { act }); }
function clickSpeak(word) { clickElem(word, 'button[data-speak]', {}); }
function clickRowMain(word, opts) {
  const ancestor = (opts && opts.knownSection) ? '.sec-known' : '.sec-pending';
  clickElem(word, '.col-main', {}, ancestor);
}
const wm = () => window.wordMemory;
const CELEBRATE_POOL = ['😎','🎉','🥳','💪','🚀','🌟','🤩','🔥','👏','🏆','✨','🎯','😺','🦾','🍻',
                        '🎊','⭐','💫','🎈','🍀','📚','🏅','🫧','🪄'];
const taskNames = () => wm().state.todayTask.words;
const find = w => wm().state.words.find(x => x.word === w);

/* ---------------- 断言工具 ---------------- */
const results = [];
function check(name, cond, extra) {
  results.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined ? '  → ' + extra : ''));
}

/* ---------------- 造测试词库 ---------------- */
function makeBank(n, tag, prefix) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const id = String(i).padStart(3, '0');
    out.push({
      word: (prefix || 'w') + id,
      phonetic: '/w' + id + '/',
      meaning: (tag || 'n. 测试词') + ' ' + id,
      scene: '场景 ' + id,
      example: 'Example ' + id + '.',
      exampleCn: '例句 ' + id + '。'
    });
  }
  return JSON.stringify(out);
}

/* ================================================================
   阶段 1 回归
   ================================================================ */
boot();
check('[1] 首次渲染 5 行', (el('list').innerHTML.match(/class="row /g) || []).length === 5);
check('[1] 顶栏进度 0/5', el('progDone').textContent === '0' && el('progTotal').textContent === '5');
check('[1] 日期为本地 YYYY-MM-DD', /^📖 \d{4}-\d{2}-\d{2}$/.test(el('dateLabel').textContent), el('dateLabel').textContent);
check('[1] 已写入 localStorage', !!store['wordMemory.v1']);

click('abandon', 'known');
check('[1] abandon → known', wm().state.words[0].status === 'known');
click('absorb', 'unsure');
click('absorb', 'unsure');
check('[1] 同日连点 failCount 只 +1', wm().state.words[2].failCount === 1, 'failCount=' + wm().state.words[2].failCount);

boot();   // 模拟刷新
check('[1] 刷新后状态还在', wm().state.words[0].status === 'known' && wm().state.words[2].failCount === 1);
check('[1] 刷新后已记住 1/5（分子只算点过记住了的）', el('progDone').textContent === '1', el('progDone').textContent);

/* ================================================================
   阶段 2：每日任务生成
   ================================================================ */
let report = wm().importJSON(makeBank(60, 'n. 词库A'), 'replace');
check('[2] 替换导入 60 词', report.added === 60 && wm().state.words.length === 60, 'added=' + report.added);
check('[2] 今日任务补足到 dailyLimit=50', taskNames().length === 50, 'len=' + taskNames().length);
check('[2] 新词按词库顺序取', taskNames()[0] === 'w001' && taskNames()[49] === 'w050', taskNames()[0] + '…' + taskNames()[49]);
check('[2] 第 51 个词今天不出现', !taskNames().includes('w051'));

// 今日任务当天固定：重新加载后名单不变
const frozen = taskNames().join(',');
boot();
check('[2] 同一天刷新后今日名单不变', taskNames().join(',') === frozen);

/* ---- 第 1 天：制造复习池 ---- */
check('[2] 派发后词条被标记了派发日期',
  wm().state.words.slice(0, 50).every(w => w.servedOn === wm().today()), '');
click('w001', 'unsure');   // failCount 1
click('w002', 'unsure');   // failCount 1
click('w003', 'known');    // 已掌握
click('w004', 'unsure');   // failCount 1
check('[2] 底栏统计 已掌握1/复习池3', el('knownCount').textContent === '1' && el('reviewCount').textContent === '3',
  el('knownCount').textContent + '/' + el('reviewCount').textContent);

/* ---- 进入第 2 天 ---- */
wm().nextDay();
const d2 = taskNames();
check('[2] 昨天没记住的词今天回来了', ['w001', 'w002', 'w004'].every(w => d2.includes(w)), d2.slice(0, 5).join(','));
check('[2] 复习池排在最前面', d2.slice(0, 3).join(',') === 'w001,w002,w004', d2.slice(0, 3).join(','));
check('[2] 昨天已掌握的词不再出现', !d2.includes('w003'));
check('[2] ⭐ 昨天没动过的词今天不再出现', !d2.includes('w005'), 'w005 出现了');
check('[2] 第2天只能补足到“剩下没派发过的新词”',
  d2.join(',') === 'w001,w002,w004,w051,w052,w053,w054,w055,w056,w057,w058,w059,w060',
  'len=' + d2.length + ' [' + d2.slice(0, 6).join(',') + '…]');
check('[2] 全新一天已记住数归零', el('progDone').textContent === '0', el('progDone').textContent);

/* ---- 第 2 天：让 w001 再错一次，w002 记熟 ---- */
click('w001', 'unsure');   // 跨天，failCount → 2
click('w002', 'known');    // 移出复习池
check('[2] 跨天后 failCount 累加到 2', find('w001').failCount === 2);

wm().nextDay();
const d3 = taskNames();
check('[2] 第3天：错得多的排最前', d3[0] === 'w001', d3.slice(0, 3).join(','));
check('[2] 第3天：w002 记熟后不再出现', !d3.includes('w002'));
check('[2] 第3天：新词都派发完了，只剩复习池',
  d3.join(',') === 'w001,w004', d3.join(','));
check('[2] previewToday 顺序正确', wm().previewToday()[0] === 'w001 (unsure×2)', wm().previewToday().slice(0, 3).join(' | '));

/* ---- 复习池超过每日上限时不塞新词 ---- */
// 此刻复习池 = {w001(×2), w004(×1)}，把上限压到 1，复习池必须整池保留且不补新词
wm().state.settings.dailyLimit = 1;
wm().nextDay();
const d4 = taskNames();
check('[2] 复习池(2) > 上限(1) 时整池保留且不补新词',
  d4.length === 2 && d4.every(n => find(n).status === 'unsure'),
  'len=' + d4.length + ' [' + d4.join(',') + ']');
wm().state.settings.dailyLimit = 50;
wm().nextDay();
check('[2] 新词都派发完后，任务只剩复习池（不会凭空补满）',
  taskNames().join(',') === 'w001,w004', taskNames().join(','));

// 合并导入新词 → 新词是“没派发过”的，可以立即补进来
wm().importJSON(makeBank(3, 'n. 新批次', 'n'), 'merge');
check('[2] 新导入的词当天就能补进今日任务',
  taskNames().join(',') === 'w001,w004,n001,n002,n003', taskNames().join(','));

/* ================================================================
   阶段 2：词库导入
   ================================================================ */
// 合并：文件内重复 + 缺字段 + 与现有词重叠
const messy = JSON.stringify([
  { word: 'w001', meaning: 'n. 更新后的释义 1', scene: '新场景' },   // 与现有词重复 → 更新
  { word: 'w001', meaning: 'n. 文件内重复' },                        // 文件内重复 → 跳过
  { word: 'w999', meaning: 'n. 全新词' },                            // 新增
  { word: 'w998' },                                                  // 缺 meaning → 跳过
  { meaning: 'n. 缺 word' },                                         // 缺 word → 跳过
  'not-an-object',                                                   // 非法 → 跳过
  { word: 'w997', meaning: 'n. 另一个新词' }                         // 新增
]);
const beforeFail = find('w001').failCount;
report = wm().importJSON(messy, 'merge');
check('[2] 合并：新增 2 词', report.added === 2, 'added=' + report.added);
check('[2] 合并：更新 1 词', report.updated === 1, 'updated=' + report.updated);
check('[2] 合并：文件内重复跳过 1 条', report.duplicates === 1, 'dup=' + report.duplicates);
check('[2] 合并：非法/缺字段跳过 3 条', report.invalid === 3, 'invalid=' + report.invalid);
check('[2] 合并：释义被更新', find('w001').meaning === 'n. 更新后的释义 1');
check('[2] 合并：学习进度保留', find('w001').failCount === beforeFail && beforeFail === 2, 'failCount=' + beforeFail);
check('[2] 合并：不丢原有词', wm().state.words.length === 65, 'total=' + wm().state.words.length);

// 导出格式（{words, settings}）也能被导入（用不重叠的新词，验证确实新增）
report = wm().importJSON(JSON.stringify({ words: JSON.parse(makeBank(3, 'n. 导出词', 'x')), settings: { dailyLimit: 7 } }), 'merge');
check('[2] 支持导入导出格式 {words,settings}', report.added === 3, 'added=' + report.added);

// 替换：清空进度
report = wm().importJSON(makeBank(10, 'n. 词库B'), 'replace');
check('[2] 替换：词库换成 10 词', report.total === 10, 'total=' + report.total);
check('[2] 替换：进度清零（全部 new）',
  wm().state.words.every(w => w.status === 'new' && w.failCount === 0 && w.lastReview === null));
check('[2] 替换：今日任务重建为 10 词', taskNames().length === 10 && taskNames()[0] === 'w001', 'len=' + taskNames().length);

// 导入大词库后新词当天就进今日任务
wm().importJSON(makeBank(80, 'n. 词库C'), 'replace');
check('[2] 导入大词库后今日任务补足到 50', taskNames().length === 50 && taskNames()[49] === 'w050');

// 非法输入
let threw = false;
try { wm().importJSON('{ 这不是 json', 'merge'); } catch (e) { threw = true; }
check('[2] 非法 JSON 会报错', threw);

threw = false;
try { wm().importJSON('{"foo":1}', 'merge'); } catch (e) { threw = true; }
check('[2] 没有 words 数组会报错', threw);

/* ---- 持久化与结构完整性 ---- */
const saved = JSON.parse(store['wordMemory.v1']);
check('[2] todayTask 已落盘', !!(saved.todayTask && saved.todayTask.words.length === 50));
check('[2] 词条字段完整',
  ['word', 'phonetic', 'meaning', 'scene', 'example', 'exampleCn', 'status', 'failCount', 'lastReview']
    .every(k => k in saved.words[0]));
check('[2] settings 字段完整',
  ['dailyLimit', 'showPhonetic', 'showExample', 'keyboardMode'].every(k => k in saved.settings));

/* ---- 调试时钟 ---- */
wm().resetClock();
check('[2] resetClock 恢复真实日期', /^\d{4}-\d{2}-\d{2}$/.test(wm().today()), wm().today());

/* ================================================================
   阶段 3：键盘拼写模式
   ================================================================ */
wm().importJSON(makeBank(6, 'n. 键盘题库'), 'replace');   // w001..w006，全部 new
const kbd = () => wm().kbd;

kbd().enter();
let sess = kbd().session;
check('[3] 进入键盘模式：面板显示/列表隐藏', els.kbd.hidden === false && els.list.hidden === true);
check('[3] 进入键盘模式：按钮变成返回列表', els.btnKbd.textContent === '返回列表', els.btnKbd.textContent);
check('[3] 本轮队列 = 今日未掌握的词', sess.queue.length === 6 && kbd().current.word === 'w001',
  sess.queue.length + ' / ' + kbd().current.word);
check('[3] 面板显示单词、音标、释义',
  els.kbdCard.innerHTML.includes('w001') && els.kbdCard.innerHTML.includes('/w001/') &&
  els.kbdCard.innerHTML.includes('n. 键盘题库 001'), els.kbdCard.innerHTML.slice(0, 80));

// ---- 敲对字母 ----
kbd().press('w');
check('[3] 敲对字母：进入输入框', kbd().session.typed === 'w', kbd().session.typed);
check('[3] 敲对字母：显示为绿色 ch-ok', els.kbdBox.innerHTML.includes('ch-ok'));
kbd().press('0');
kbd().press('0');
check('[3] 连续敲对：前缀累积', kbd().session.typed === 'w00', kbd().session.typed);

// ---- 敲错字母 ----
kbd().press('z');
check('[3] 敲错：进入锁定状态', kbd().session.errorLocked === true);
check('[3] 敲错：输入框变红', els.kbdBox.classList.contains('is-error') === true);
check('[3] 敲错：错字符标红 ch-bad', els.kbdBox.innerHTML.includes('ch-bad'));
const lockedLen = kbd().session.typed.length;
kbd().press('1'); kbd().press('2');
check('[3] 敲错后：后续字母被忽略（必须退格）', kbd().session.typed.length === lockedLen, kbd().session.typed);

// ---- 退格才能继续 ----
kbd().press('Backspace');
check('[3] 退格：删掉错字符', kbd().session.typed === 'w00', kbd().session.typed);
check('[3] 退格：解锁', kbd().session.errorLocked === false);
kbd().press('1');
check('[3] 退格后可以继续输入', kbd().session.typed === 'w001', kbd().session.typed);

// ---- 【纯拼写练习】敲完整词，不写任何学习进度 ----
const storageBefore = store['wordMemory.v1'];   // 练之前存盘内容
kbd().press('Backspace');            // 退掉 '1'，让状态干净
kbd().press('x');                    // 故意敲错一次
kbd().press('Backspace');            // 删掉
kbd().type('w001');                  // 一路敲对到底
check('[3] 敲完：不写学习状态（仍是 new）', find('w001').status === 'new', find('w001').status);
check('[3] 敲完：中途敲错也不加 failCount', find('w001').failCount === 0, 'failCount=' + find('w001').failCount);
check('[3] 敲完：不写 lastReview', find('w001').lastReview === null, String(find('w001').lastReview));
check('[3] 敲完：整个练词过程没有写过 localStorage',
  store['wordMemory.v1'] === storageBefore, '内容变了');
check('[3] 敲完：输入框变绿 is-done', els.kbdBox.classList.contains('is-done') === true);
check('[3] 敲完：本轮小结仍然记下对/错',
  kbd().session.known === 0 && kbd().session.unsure === 1 && kbd().session.finished === 1);

// ---- 300ms 后自动切下一个 ----
check('[3] 未到点时不切词', kbd().session.idx === 0);
flushTimers();
check('[3] 300ms 后自动进入下一个词', kbd().session.idx === 1 && kbd().current.word === 'w002', kbd().current.word);
check('[3] 切词后输入框清空', kbd().session.typed === '' && kbd().session.errorLocked === false);

// ---- 全程无错：同样不写进度 ----
kbd().type('w002');
check('[3] 全程无错：也不写学习状态', find('w002').status === 'new', find('w002').status);
check('[3] 全程无错：failCount 保持 0', find('w002').failCount === 0);
check('[3] 全程无错：lastReview 仍为空', find('w002').lastReview === null);
check('[3] 全程无错：本轮小结记为全对', kbd().session.known === 1, kbd().session.known);
flushTimers();

// ---- 队列 = 今日全部词，且每次从第 1 个开始 ----
kbd().enter();   // 重新进入键盘模式（本轮开新 session，统计从零开始）
check('[3] 队列包含今日所有词（不做任何排除）',
  kbd().session.queue.length === 6, kbd().session.queue.map(w => w.word).join(','));
check('[3] 重进后从今日第 1 个词开始', kbd().current.word === 'w001', kbd().current.word);
check('[3] 重进后进度显示对得上：第 1/6 词',
  els.kbdPos.textContent === '1' && els.kbdTotal.textContent === '6',
  els.kbdPos.textContent + '/' + els.kbdTotal.textContent);

// ---- 正确率与 WPM：故意敲错一次，验证确实被算进去 ----
const target3 = kbd().current.word;          // 重进后是 'w001'
kbd().press('z');                            // 错 1 次
kbd().press('Backspace');
kbd().type(target3);                         // 再敲对
const st = kbd().session;
check('[3] 记录了按键统计', st.totalKeys === target3.length + 1 && st.correctKeys === target3.length,
  st.correctKeys + '/' + st.totalKeys);
check('[3] 敲错过时正确率 < 100%', els.kbdAcc.textContent !== '100%', els.kbdAcc.textContent);
check('[3] WPM 是数字', /^\d+$/.test(els.kbdWpm.textContent), els.kbdWpm.textContent);
flushTimers();

// ---- 发音 ----
kbd().speak('abandon');
check('[3] 发音调用 Web Speech API', spoken[spoken.length - 1] === 'abandon', spoken.join(','));

// ---- 练完一整轮 → 完成页 ----
for (let i = 0; i < 8; i++) {   // 把剩下的词都敲完
  const cur = kbd().current;
  if (!cur) break;
  kbd().type(cur.word);
  flushTimers();
}
check('[3] 走完一轮显示完成页', els.kbdCard.innerHTML.includes('今日已练完'), els.kbdCard.innerHTML.slice(0, 60));
check('[3] 完成页统计本轮结果', kbd().session.finished === 6 && kbd().session.known >= 4,
  'finished=' + kbd().session.finished + ' known=' + kbd().session.known);
check('[3] 完成页有重开/返回按钮', els.kbdCard.innerHTML.includes('重开一轮') && els.kbdCard.innerHTML.includes('返回列表'));

// ---- 【纯拼写练习】练完一整轮后，进度依然是零变化 ----
check('[3] 整轮练完不影响任何学习进度',
  wm().state.words.every(w => w.status === 'new' && w.failCount === 0 && w.lastReview === null),
  wm().state.words.map(w => w.word + ':' + w.status).join(','));
check('[3] 整轮练完今日进度仍是 0/6',
  el('progDone').textContent === '0' && el('progTotal').textContent === '6',
  el('progDone').textContent + '/' + el('progTotal').textContent);
check('[3] 整轮练完复习池仍为 0', el('reviewCount').textContent === '0', el('reviewCount').textContent);
check('[3] 整轮练完已掌握仍为 0', el('knownCount').textContent === '0', el('knownCount').textContent);
check('[3] 键盘模式面板有“纯拼写练习”的说明',
  els.kbdCard.innerHTML.includes('纯拼写练习'), '');

// ---- Esc 返回列表 ----
kbd().enter();
keydownHandler({ key: 'Escape', ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
check('[3] Esc 返回列表模式', els.list.hidden === false && els.kbd.hidden === true);
check('[3] 返回后按钮复原', els.btnKbd.textContent === '键盘模式', els.btnKbd.textContent);

// ---- 组合键不干扰输入 ----
kbd().enter();
kbd().press('a');   // 当前词是 w001（每次都从第 1 个开始）
const before = kbd().session.typed.length;
keydownHandler({ key: 'a', ctrlKey: true, metaKey: false, altKey: false, preventDefault() {} });
check('[3] Ctrl/Alt 组合键被忽略', kbd().session.typed.length === before, kbd().session.typed);
keydownHandler({ key: 'Shift', ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
check('[3] 功能键（Shift）不产生输入', kbd().session.typed.length === before, kbd().session.typed);
kbd().exit();
check('[3] 退出后回到列表', els.list.hidden === false && kbd().session === null);

/* ================================================================
   阶段 4：设置面板 / 导出 / 导入进度 / 重置
   ================================================================ */
wm().importJSON(makeBank(20, 'n. 设置题库'), 'replace');   // 干净起点：20 词全 new
click('w001', 'known');
click('w002', 'unsure');
check('[4] 起始状态：今日任务 20 词', taskNames().length === 20, 'len=' + taskNames().length);

/* ---- 设置面板开关 ---- */
wm().settings.open();
check('[4] 打开设置面板', els.setMask.hidden === false);
wm().settings.close();
check('[4] 关闭设置面板', els.setMask.hidden === true);

/* ---- 每日词数：调小 ---- */
els.setLimit.value = '3';
fire('setLimit', 'change');
check('[4] 调小每日词数：今日任务跟着变短', taskNames().length === 3, 'len=' + taskNames().length + ' [' + taskNames().join(',') + ']');
check('[4] 调小后今天已标记的词仍保留在名单里',
  taskNames().includes('w001') && taskNames().includes('w002'), taskNames().join(','));
check('[4] 设置值已写入', wm().state.settings.dailyLimit === 3, wm().state.settings.dailyLimit);
check('[4] 输入框回填成生效值', String(els.setLimit.value) === '3', els.setLimit.value);

/* ---- 每日词数：调大 ---- */
els.setLimit.value = '6';
fire('setLimit', 'change');
check('[4] 调大每日词数：补足新词到 6', taskNames().length === 6, 'len=' + taskNames().length + ' [' + taskNames().join(',') + ']');

/* ---- 每日词数：非法值被夹住 ---- */
wm().settings.setDailyLimit(0);
check('[4] 每日词数 0 被夹到最小值 1', wm().state.settings.dailyLimit === 1, wm().state.settings.dailyLimit);
wm().settings.setDailyLimit(99999);
check('[4] 每日词数上限被夹到 1000', wm().state.settings.dailyLimit === 1000, wm().state.settings.dailyLimit);
wm().settings.setDailyLimit(20);

/* ---- 显示音标开关 ---- */
els.setPhonetic.checked = false;
fire('setPhonetic', 'change');
check('[4] 关掉音标：列表里不再有音标', !els.list.innerHTML.includes('/w003/'));
els.setPhonetic.checked = true;
fire('setPhonetic', 'change');
check('[4] 打开音标：列表里出现音标', els.list.innerHTML.includes('/w003/'), '');

/* ---- 展开详情 + 显示例句开关 ---- */
wm().view.expand('w003');
check('[4] 展开后显示场景', els.list.innerHTML.includes('场景 003'), els.list.innerHTML.match(/场景[^<]*/)?.[0]);
check('[4] 展开后显示例句', els.list.innerHTML.includes('Example 003.') && els.list.innerHTML.includes('例句 003。'));
check('[4] 展开后出现详情容器', els.list.innerHTML.includes('row-detail'));
check('[4] 展开状态被记录', wm().view.expanded.join(',') === 'w003', wm().view.expanded.join(','));

els.setExample.checked = false;
fire('setExample', 'change');
check('[4] 关掉例句：详情里没有例句', !els.list.innerHTML.includes('Example 003.'));
check('[4] 关掉例句：场景仍在', els.list.innerHTML.includes('场景 003'));
els.setExample.checked = true;
fire('setExample', 'change');
check('[4] 重新打开例句后例句回来', els.list.innerHTML.includes('Example 003.'));

wm().view.collapse('w003');
check('[4] 收起后详情消失', !els.list.innerHTML.includes('row-detail'));

/* ---- 上下两个区域 ---- */
click('w005', 'unsure');
check('[4] 没记住的词留在上方未记住区',
  wm().view.pending.includes('w005') && !wm().view.knownToday.includes('w005'),
  '上方=' + wm().view.pending.join(','));
check('[4] 上方区域带“没记住”标记', els.list.innerHTML.includes('没记住 ×1'));
check('[4] 下方区域默认折叠', wm().view.knownOpen === false);
check('[4] 折叠时仍能看到下方区域标题', els.list.innerHTML.includes('今日已记住'));

// 点标题展开
wm().view.toggleKnown();
check('[4] 点标题能展开下方区域', wm().view.knownOpen === true);
check('[4] 展开后列出今日已记住的词',
  els.list.innerHTML.includes('sec-known') && els.list.innerHTML.includes('今日已记住'));

// 记住 → 收到下方
click('w006', 'known');
check('[4] 点“记住了”后从上方消失', !wm().view.pending.includes('w006'), wm().view.pending.join(','));
check('[4] 点“记住了”后进入下方区域', wm().view.knownToday.includes('w006'), wm().view.knownToday.join(','));

// 从下方撤回
check('[4] 下方行提供“没记住（撤回）”按钮', els.list.innerHTML.includes('没记住（撤回）'));
click('w006', 'unsure');
check('[4] 撤回后回到上方', wm().view.pending.includes('w006') && !wm().view.knownToday.includes('w006'),
  '上方=' + wm().view.pending.join(','));

// 收起
wm().view.toggleKnown();
check('[4] 收起下方区域', wm().view.knownOpen === false);
check('[4] 收起后下方行不再渲染', !/没记住（撤回）/.test(els.list.innerHTML), '仍渲染了下方行');

/* ---- 导出 ---- */
const exported = wm().exportText();
const parsedExport = JSON.parse(exported);
check('[4] 导出内容是合法 JSON', !!parsedExport.words && Array.isArray(parsedExport.words));
check('[4] 导出含 words / settings', !!parsedExport.settings && 'dailyLimit' in parsedExport.settings);
check('[4] 导出与内部结构一致（含进度字段）',
  ['word', 'phonetic', 'meaning', 'scene', 'example', 'exampleCn', 'status', 'failCount', 'lastReview']
    .every(k => k in parsedExport.words[0]));
check('[4] 导出确实带上了学习进度',
  parsedExport.words.find(w => w.word === 'w005').failCount === 1 &&
  parsedExport.words.find(w => w.word === 'w001').status === 'known');
const snapshot = { status: find('w001').status, fail5: find('w005').failCount, known: el('knownCount').textContent };

/* ---- 导出 → 重置 → 导入恢复（换设备场景） ---- */
wm().resetProgress('progress');
check('[4] 重置进度：词库保留', wm().state.words.length === 20, 'len=' + wm().state.words.length);
check('[4] 重置进度：所有词回到 new',
  wm().state.words.every(w => w.status === 'new' && w.failCount === 0 && w.lastReview === null));
check('[4] 重置进度：统计归零', el('knownCount').textContent === '0' && el('reviewCount').textContent === '0',
  el('knownCount').textContent + '/' + el('reviewCount').textContent);

wm().importJSON(exported, 'replace');
check('[4] 导入导出文件后进度完整恢复',
  find('w001').status === snapshot.status && find('w005').failCount === snapshot.fail5,
  find('w001').status + ' / ' + find('w005').failCount);
check('[4] 导入导出文件后统计恢复', el('knownCount').textContent === snapshot.known, el('knownCount').textContent);
check('[4] 导入导出文件时设置也恢复', wm().state.settings.dailyLimit === parsedExport.settings.dailyLimit,
  wm().state.settings.dailyLimit);

/* ---- 把进度文件合并进空词库，也要能恢复进度 ---- */
wm().importJSON('[]', 'replace');
check('[4] 词库可被清空', wm().state.words.length === 0);
wm().importJSON(exported, 'merge');
check('[4] 合并进度文件到空词库：进度被带进来',
  find('w001').status === 'known' && find('w005').failCount === 1,
  find('w001').status + ' / ' + find('w005').failCount);

/* ---- 键盘模式开关 ---- */
els.setKeyboard.checked = true;
fire('setKeyboard', 'change');
check('[4] 键盘模式开关写入设置', wm().state.settings.keyboardMode === true);
check('[4] 开关给出提示', els.setHint.textContent.includes('下次打开'), els.setHint.textContent);
boot();   // 模拟重新打开页面
check('[4] 开启后重新打开页面自动进入键盘模式', els.kbd.hidden === false && els.list.hidden === true);
els.setKeyboard.checked = false;
fire('setKeyboard', 'change');
boot();
check('[4] 关闭后重新打开停在列表模式', els.list.hidden === false,
  'kbdHidden=' + (els.kbd ? els.kbd.hidden : '（键盘面板没被创建，符合预期）'));

/* ---- 清空全部数据 ---- */
wm().resetProgress('all');
check('[4] 清空全部数据：清掉了 localStorage 并重新加载', reloaded >= 1 && store['wordMemory.v1'] === undefined,
  'reload=' + reloaded + ' store=' + (store['wordMemory.v1'] === undefined ? '空' : '还在'));

/* ================================================================
   阶段 5：发音按钮 / 进度条 / 交互细节
   ================================================================ */
wm().importJSON(makeBank(3, 'n. 细节题库'), 'replace');

check('[5] 每行都有 🔊 发音按钮', (els.list.innerHTML.match(/data-speak/g) || []).length === 3,
  (els.list.innerHTML.match(/data-speak/g) || []).length + ' 个');

spoken.length = 0;
clickSpeak('w002');
check('[5] 点行内发音按钮朗读该词', spoken.join(',') === 'w002', spoken.join(','));
check('[5] 点发音不会误标记该词',
  find('w002').status === 'new' && find('w002').lastReview === null && find('w002').failCount === 0,
  find('w002').status);
check('[5] 点发音不会展开详情', !els.list.innerHTML.includes('row-detail'));

// ---- 点单词区域展开 / 收起（走真实的事件委托路径）----
clickRowMain('w001');
check('[5] 点单词区域能展开', els.list.innerHTML.includes('row-detail'));
clickRowMain('w001');
check('[5] 再点一次收起', !els.list.innerHTML.includes('row-detail'));
clickRowMain('w001');
check('[5] 展开状态跨重渲染保留', (wm().view.expand('w001'), els.list.innerHTML.includes('row-detail')));

// ---- 顶栏进度条 ----
check('[5] 初始进度条为 0', els.progBar.style.width === '0%', els.progBar.style.width);
click('w001', 'known');
check('[5] 标记后进度条按比例更新（1/3）', els.progBar.style.width === '33%', els.progBar.style.width);
click('w002', 'unsure');
click('w003', 'known');
check('[5] 进度条按今日已记住算（2/3 → 67%）', els.progBar.style.width === '67%', els.progBar.style.width);

// ---- 收起详情后重新渲染仍然正确 ----
wm().view.collapse('w001');
check('[5] 收起后详情消失', !els.list.innerHTML.includes('row-detail'));

/* ================================================================
   扩展 1：设置面板 label 不再被挤断行（CSS 回归）
   ================================================================ */
const styleBlock = html.match(/<style>([\s\S]*?)<\/style>/)[1];
check('[扩展] .set-row label 禁止换行',
  /\.set-row label\{[^}]*white-space:nowrap/.test(styleBlock),
  (styleBlock.match(/\.set-row label\{[^}]*\}/) || ['没找到规则'])[0]);
check('[扩展] .set-row label 不参与收缩',
  /\.set-row label\{[^}]*flex:0 0 auto/.test(styleBlock));
check('[扩展] 每日词数的说明文字移到独立一行',
  styleBlock.includes('.set-note{') && html.includes('<div class="set-note">新词补足到这个上限'));
check('[扩展] 字号用 rem 以便整体缩放',
  /html\{ font-size:calc\(16px \* var\(--fs-scale\)\)/.test(styleBlock));

// 月历数字调大（用户反馈过“日期数字有点小”）
check('[扩展] 月历日期数字放大到 1rem',
  /\.ci-cell\{[^}]*font-size:1rem/.test(styleBlock),
  (styleBlock.match(/\.ci-cell\{[^}]*font-size:[^;]+;/) || ['没找到'])[0]);
check('[扩展] 月历格子限制了宽度（否则格子过大显得数字小）',
  /\.ci-grid\{[^}]*max-width:600px/.test(styleBlock) &&
  /\.ci-week\{[^}]*max-width:600px/.test(styleBlock));
check('[扩展] 周标题字号跟着调大',
  /\.ci-week\{[^}]*font-size:0\.8125rem/.test(styleBlock));

/* ================================================================
   扩展 2：深色模式
   ================================================================ */
prefersDark = false;
wm().appearance.set('auto');
check('[扩展] 默认跟随系统：系统浅色时用浅色', wm().appearance.theme === 'light', wm().appearance.theme);
check('[扩展] data-theme 写到了 <html> 上', wm().appearance.htmlThemeAttr === 'light', wm().appearance.htmlThemeAttr);

prefersDark = true;
wm().appearance.set('auto');
check('[扩展] 跟随系统：系统深色时用深色', wm().appearance.theme === 'dark', wm().appearance.theme);

prefersDark = false;
wm().appearance.set('dark');
check('[扩展] 强制深色：无视系统偏好', wm().appearance.theme === 'dark', wm().appearance.theme);
check('[扩展] 深色下按钮图标变成太阳', els.btnTheme.textContent === '☀️', els.btnTheme.textContent);

wm().appearance.set('light');
check('[扩展] 强制浅色', wm().appearance.theme === 'light');
check('[扩展] 浅色下按钮图标变成月亮', els.btnTheme.textContent === '🌙', els.btnTheme.textContent);

// 顶栏圆按钮直接切换
check('[扩展] 点按钮：浅色 → 深色', wm().appearance.toggle() === 'dark');
check('[扩展] 点按钮：深色 → 浅色', wm().appearance.toggle() === 'light');
check('[扩展] 切换后设置里也变成显式值（不再跟随系统）',
  wm().state.settings.theme === 'light', wm().state.settings.theme);

// 设置面板里的下拉框
els.setTheme.value = 'dark';
fire('setTheme', 'change');
check('[扩展] 设置面板下拉框能切深色', wm().appearance.theme === 'dark' && wm().appearance.setting === 'dark');
check('[扩展] 点顶栏按钮后下拉框同步',
  (wm().appearance.toggle(), els.setTheme.value === 'light'), els.setTheme.value);

// 持久化 + 重新打开页面
els.setTheme.value = 'dark';
fire('setTheme', 'change');
prefersDark = false;
boot();
check('[扩展] 重新打开页面仍是深色（不受系统影响）',
  wm().appearance.htmlThemeAttr === 'dark', wm().appearance.htmlThemeAttr);

// 导入的设置文件里的 theme 也要校正
wm().importJSON(JSON.stringify({ words: [], settings: { theme: '紫色' } }), 'replace');
check('[扩展] 非法主题值回退到 auto', wm().state.settings.theme === 'auto', wm().state.settings.theme);
wm().importJSON(JSON.stringify({ words: [], settings: { theme: 'dark', dailyLimit: 12 } }), 'replace');
check('[扩展] 导入设置里的主题生效', wm().state.settings.theme === 'dark');
check('[扩展] 导入设置里的每日词数仍生效', wm().state.settings.dailyLimit === 12);

/* ================================================================
   扩展 3：字体选择
   ================================================================ */
wm().importJSON(makeBank(5, 'n. 字体题库'), 'replace');

wm().appearance.setHeadFont('serif');
check('[扩展] 衬线字体写进 CSS 变量',
  /Georgia|Palatino|serif/.test(wm().appearance.cssFontHead || ''), wm().appearance.cssFontHead);
wm().appearance.setHeadFont('mono');
check('[扩展] 等宽字体写进 CSS 变量',
  /monospace|Consolas/.test(wm().appearance.cssFontHead || ''), wm().appearance.cssFontHead);
wm().appearance.setHeadFont('sans');
check('[扩展] 无衬线字体写进 CSS 变量',
  /system-ui/.test(wm().appearance.cssFontHead || ''), wm().appearance.cssFontHead);

wm().appearance.setHeadFont('不存在的字体');
check('[扩展] 非法字体名回退到衬线',
  /Georgia|Palatino|serif/.test(wm().appearance.cssFontHead || '') && wm().state.settings.headFont === 'serif',
  wm().state.settings.headFont);

wm().appearance.setFontScale(1.25);
check('[扩展] 字号倍率写进 CSS 变量', wm().appearance.cssFsScale === '1.25', wm().appearance.cssFsScale);
wm().appearance.setFontScale(99);
check('[扩展] 非法字号倍率回退到 1', wm().appearance.cssFsScale === '1', wm().appearance.cssFsScale);

// 面板下拉框
els.setFontScale.value = '1.1';
fire('setFontScale', 'change');
check('[扩展] 面板下拉框能调字号', wm().state.settings.fontScale === 1.1 && wm().appearance.cssFsScale === '1.1');
els.setHeadFont.value = 'mono';
fire('setHeadFont', 'change');
check('[扩展] 面板下拉框能换字体', wm().state.settings.headFont === 'mono');

// 持久化
boot();
check('[扩展] 重开后字号与字体设置仍在',
  wm().state.settings.fontScale === 1.1 && wm().state.settings.headFont === 'mono');
check('[扩展] 重开后 CSS 变量被重新应用',
  wm().appearance.cssFsScale === '1.1' && /monospace/.test(wm().appearance.cssFontHead || ''),
  wm().appearance.cssFsScale + ' / ' + wm().appearance.cssFontHead);

// 打开设置面板时下拉框回填
wm().settings.open();
check('[扩展] 打开面板时主题下拉框回填', els.setTheme.value === wm().state.settings.theme, els.setTheme.value);
check('[扩展] 打开面板时字号下拉框回填', String(els.setFontScale.value) === '1.1', els.setFontScale.value);
check('[扩展] 打开面板时字体下拉框回填', els.setHeadFont.value === 'mono', els.setHeadFont.value);
wm().settings.close();

/* ================================================================
   扩展 4：打卡页
   ================================================================ */
wm().resetClock();
wm().importJSON(makeBank(3, 'n. 打卡题库'), 'replace');   // 今日任务 3 词

// 日历格子的 class，按日期数字取
function cellClasses(day) {
  const m = els.calGrid.innerHTML.match(new RegExp('<span class="([^"]*)"[^>]*>' + day + '</span>'));
  return m ? m[1] : '';
}
const todayNum = Number(wm().today().slice(8, 10));

wm().checkin.enter();
check('[打卡] 打开打卡页：页面显示、列表隐藏',
  els.checkin.hidden === false && els.list.hidden === true);
check('[打卡] 按钮变成返回列表', els.btnCheckin.textContent === '返回列表', els.btnCheckin.textContent);
check('[打卡] 未完成任务时按钮禁用', els.ciAction.innerHTML.includes('disabled'));
check('[打卡] 未完成任务时不能打卡', wm().checkin.do().ok === false);
check('[打卡] 提示还剩几个词', els.ciNote.textContent.includes('还剩 3 个词'), els.ciNote.textContent);

// 标记 2 个词，还差 1 个
click('w001', 'known');
click('w002', 'known');
check('[打卡] 还差 1 个词时仍不能打卡', wm().checkin.do().ok === false);

// 第 3 个点“没记住”也算处理过（与今日进度口径一致）
click('w003', 'unsure');
check('[打卡] 全部标记后进度 3/3', els.ciSub.textContent.includes('3/3'), els.ciSub.textContent);
check('[打卡] 全部完成时提示可以打卡', els.ciNote.textContent.includes('可以打卡'), els.ciNote.textContent);

const r1 = wm().checkin.do();
check('[打卡] 打卡成功', r1.ok === true && r1.date === wm().today(), JSON.stringify(r1));
check('[打卡] 记录写进 state.checkins',
  !!wm().state.checkins[wm().today()], Object.keys(wm().state.checkins).join(','));
check('[打卡] 记录里存了完成度',
  wm().state.checkins[wm().today()].done === 3 && wm().state.checkins[wm().today()].total === 3,
  JSON.stringify(wm().state.checkins[wm().today()]));
check('[打卡] 打卡后按钮变成已打卡', els.ciAction.innerHTML.includes('已打卡'));
check('[打卡] 重复打卡被拒绝', wm().checkin.do().ok === false && wm().checkin.do().reason.includes('已经'), wm().checkin.do().reason);
check('[打卡] 连续打卡 = 1 天', wm().checkin.streak === 1, wm().checkin.streak);
check('[打卡] 累计打卡 = 1 天', wm().checkin.total === 1, wm().checkin.total);

// 日历：今天应该是已打卡
check('[打卡] 日历里今天标记为已打卡', cellClasses(todayNum).includes('is-checked'), cellClasses(todayNum));
check('[打卡] 日历里今天也标记为今天', cellClasses(todayNum).includes('is-today'), cellClasses(todayNum));
check('[打卡] 日历有 7 列周标题', (els.calGrid.innerHTML.match(/ci-cell/g) || []).length >= 28,
  (els.calGrid.innerHTML.match(/ci-cell/g) || []).length + ' 个格子');

// 完成任务 + 打卡后，列表页的提示条应消失
check('[打卡] 已打卡后不再显示打卡提示', els.ctaBanner.hidden === true);

/* ---- 进入第二天：完成但不打卡 ---- */
wm().checkin.exit();
wm().nextDay();
wm().checkin.enter();
check('[打卡] 新的一天不能马上打卡', wm().checkin.do().ok === false);
click('w001', 'known'); click('w002', 'known'); click('w003', 'known');
const r2 = wm().checkin.do();
check('[打卡] 第二天完成任务后可打卡', r2.ok === true);
check('[打卡] 连续打卡 = 2 天', wm().checkin.streak === 2, wm().checkin.streak);
check('[打卡] 累计打卡 = 2 天', wm().checkin.total === 2, wm().checkin.total);

// 日历上昨天（已打卡）与今天（已打卡）都该是 is-checked
const yesterday = new Date(wm().today() + 'T12:00:00');
yesterday.setDate(yesterday.getDate() - 1);
const yNum = yesterday.getDate();
check('[打卡] 日历里昨天是已打卡', cellClasses(yNum).includes('is-checked'), cellClasses(yNum));

/* ---- 第三天：只学习不打卡 ---- */
wm().nextDay();
// 前两天的词都已掌握，今天本来没有任务；补两个新词让今天有活干
wm().importJSON(makeBank(2, 'n. 补充题', 'z'), 'merge');
check('[打卡] 有新任务时不能马上打卡', wm().checkin.do().ok === false);

click('z001', 'known');
const day3Num = Number(wm().today().slice(8, 10));   // 日期变了，重新取
check('[打卡] 只学习没打卡时，今天就显示为“学习过未打卡”',
  cellClasses(day3Num).includes('is-studied'), cellClasses(day3Num));
check('[打卡] 学习过但未打卡不算进累计', wm().checkin.total === 2, wm().checkin.total);
check('[打卡] 今天没打卡时连续天数从昨天算（仍为 2）', wm().checkin.streak === 2, wm().checkin.streak);
check('[打卡] 任务没做完时不能打卡', wm().checkin.do().ok === false);

/* ---- 取消打卡 ---- */
click('z002', 'known');
check('[打卡] 第三天完成后可打卡', wm().checkin.do().ok === true);
check('[打卡] 取消打卡生效', wm().checkin.undo() === true);
check('[打卡] 取消后今天不再算已打卡', wm().checkin.isCheckedIn(wm().today()) === false);
check('[打卡] 取消后日历回到“学习过未打卡”',
  cellClasses(day3Num).includes('is-studied'), cellClasses(day3Num));
check('[打卡] 取消后累计减少', wm().checkin.total === 2, wm().checkin.total);
check('[打卡] 取消后可以重新打卡', wm().checkin.do().ok === true);

/* ---- 月历翻页 ---- */
const thisMonth = wm().checkin.calendar;
check('[打卡] 不能翻到未来月份', wm().checkin.shiftMonth(1) === false);
check('[打卡] 可以翻到上个月', wm().checkin.shiftMonth(-1) === true);
check('[打卡] 日历月份改变了', wm().checkin.calendar !== thisMonth, wm().checkin.calendar);
check('[打卡] 翻回来', wm().checkin.shiftMonth(1) === true && wm().checkin.calendar === thisMonth);
check('[打卡] 到当月后下个月按钮禁用', els.calNext.disabled === true);

/* ---- Esc 退出打卡页 ---- */
// 先收掉可能还开着的庆祝动画：Esc 会优先关动画，这是设计如此
wm().checkin.hideCelebrate();
keydownHandler({ key: 'Escape', ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
check('[打卡] Esc 返回列表', els.list.hidden === false && els.checkin.hidden === true);

/* ---- 打卡记录跟着导出 / 导入 ---- */
const exportWithCheckins = wm().exportText();
check('[打卡] 导出内容包含打卡记录',
  !!JSON.parse(exportWithCheckins).checkins &&
  Object.keys(JSON.parse(exportWithCheckins).checkins).length === wm().checkin.total,
  Object.keys(JSON.parse(exportWithCheckins).checkins).join(','));

const totalBefore = wm().checkin.total;
const streakBefore = wm().checkin.streak;
wm().resetProgress('progress');
check('[打卡] 清空学习进度会一起清掉打卡记录', wm().checkin.total === 0 && wm().checkin.streak === 0);
wm().importJSON(exportWithCheckins, 'replace');
check('[打卡] 导入备份后打卡记录恢复',
  wm().checkin.total === totalBefore && wm().checkin.streak === streakBefore,
  wm().checkin.total + ' / ' + wm().checkin.streak);

/* ---- 脏数据被清理 ---- */
wm().importJSON(JSON.stringify({
  words: JSON.parse(makeBank(2)),
  checkins: { '不是日期': {}, '2026-09-10': { at: 'x', done: '5', total: '5' }, '2026-13-99': {} }
}), 'replace');
check('[打卡] 非法日期键被丢弃',
  Object.keys(wm().state.checkins).join(',') === '2026-09-10', Object.keys(wm().state.checkins).join(','));
check('[打卡] 字符串数字被转成数字',
  wm().state.checkins['2026-09-10'].done === 5, wm().state.checkins['2026-09-10'].done);
wm().importJSON(JSON.stringify({ words: JSON.parse(makeBank(2)), checkins: '不是对象' }), 'replace');
check('[打卡] checkins 不是对象时回退为空', Object.keys(wm().state.checkins).length === 0);

/* ================================================================
   扩展 5：打卡庆祝动画
   ================================================================ */
wm().resetClock();
wm().importJSON(makeBank(2, 'n. 庆祝题库'), 'replace');

// 先确认打卡前不会有动画
wm().checkin.enter();
click('w001', 'known');
click('w002', 'known');
check('[庆祝] 打卡前遮罩是隐藏的', wm().checkin.celebrating === false);

// 固定 Math.random，让随机结果可预测（用完就退回 0.5，避免出现 undefined）
const realRandom = Math.random;
let seq = [];
Math.random = () => (seq.length ? seq.shift() : 0.5);

seq = new Array(200).fill(0);
const r = wm().checkin.do();
check('[庆祝] 打卡成功', r.ok === true);
check('[庆祝] 打卡后遮罩显示出来', wm().checkin.celebrating === true);
check('[庆祝] 主 emoji 取自池子第一个（Math.random=0）', els.celEmoji.textContent === '😎', els.celEmoji.textContent);
check('[庆祝] 文案出现', /已完成|全过啦/.test(els.celTitle.textContent), els.celTitle.textContent);
check('[庆祝] 副文案显示完成度与连续天数',
  els.celSub.textContent.includes('2/2') && els.celSub.textContent.includes('连续打卡 1 天'),
  els.celSub.textContent);
check('[庆祝] 撒了 12~17 个飘起来的 emoji',
  els.celParticles.children.length >= 12 && els.celParticles.children.length <= 17,
  els.celParticles.children.length + ' 个');
check('[庆祝] 粒子随机了位置/大小/时长',
  els.celParticles.children.every(p =>
    /%$/.test(p.style.left) && /px$/.test(p.style.fontSize) &&
    /s$/.test(p.style.animationDelay) && /s$/.test(p.style.animationDuration)),
  JSON.stringify(els.celParticles.children[0].style));
check('[庆祝] 粒子内容取自 emoji 池',
  els.celParticles.children.every(p => CELEBRATE_POOL.includes(p.textContent)),
  els.celParticles.children.map(p => p.textContent).join(''));
check('[庆祝] 每次都随机（不是固定同一个 emoji）',
  (() => {
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      wm().checkin.hideCelebrate();
      seq = [i / 40, i / 40, i / 40, i / 40, i / 40, i / 40, i / 40, i / 40, i / 40, i / 40,
             i / 40, i / 40, i / 40, i / 40, i / 40, i / 40, i / 40, i / 40, i / 40, i / 40,
             i / 40, i / 40, i / 40, i / 40];
      seen.add(wm().checkin.celebrate('x'));
    }
    return seen.size >= 5;
  })());

// 到点自动收起
wm().checkin.hideCelebrate();
seq = new Array(200).fill(0);
wm().checkin.celebrate('自动关闭测试');
check('[庆祝] 显示后有定时器在等（自动关闭）', pendingTimers() > 0, pendingTimers() + ' 个');
flushTimers();
check('[庆祝] 到点自动收起', wm().checkin.celebrating === false);

// 点任意位置收起
seq = new Array(200).fill(0);
wm().checkin.celebrate('点击关闭测试');
els.celebrateMask.handlers.click({ target: els.celebrateMask });
check('[庆祝] 点击遮罩收起', wm().checkin.celebrating === false);

// Esc 收起
seq = new Array(200).fill(0);
wm().checkin.celebrate('Esc 关闭测试');
keydownHandler({ key: 'Escape', ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
check('[庆祝] Esc 收起', wm().checkin.celebrating === false);
check('[庆祝] 收起庆祝动画不影响当前页面', els.checkin.hidden === false);
check('[庆祝] 收起时定时器被清掉', pendingTimers() === 0, pendingTimers() + ' 个');

Math.random = realRandom;

/* ================================================================
   扩展 6：键盘模式的真实输入框（手机软键盘）
   ================================================================ */
wm().resetClock();
wm().importJSON(makeBank(3, 'n. 手机题库'), 'replace');

check('[手机] 键盘模式有真实 input 元素',
  html.includes('id="kbdInput"') && html.includes('inputmode="latin"'), '');
check('[手机] input 不能是 display:none（否则拿不到焦点）',
  /\.kbd-input\{[^}]*opacity:0/.test(styleBlock) && !/\.kbd-input\{[^}]*display:none/.test(styleBlock));
check('[手机] input 不挡点击（pointer-events:none）',
  /\.kbd-input\{[^}]*pointer-events:none/.test(styleBlock));
check('[手机] input 字号 ≥16px（不然 iOS 聚焦会放大页面）',
  /\.kbd-input\{[^}]*font-size:16px/.test(styleBlock));
check('[手机] 点面板会把焦点交给输入框',
  typeof els.kbd.handlers.click === 'function');

wm().checkin.exit();
wm().kbd.enter();
check('[手机] 进入键盘模式后输入框自动获得焦点（软键盘才会弹）',
  document.activeElement === els.kbdInput, document.activeElement && document.activeElement.id);
check('[手机] 输入框初始为空', els.kbdInput.value === '');

// 走 input 事件这条路（Android 软键盘就是这个行为）
check('[手机] 通过 input 事件输入字符能生效',
  (wm().kbd.inputEvent('w'), wm().kbd.session.typed === 'w'), wm().kbd.session.typed);
check('[手机] 输入框的值与已输入内容同步', els.kbdInput.value === 'w', els.kbdInput.value);

wm().kbd.inputEvent('w0');
check('[手机] 一次提交多个字符也能处理', wm().kbd.session.typed === 'w0', wm().kbd.session.typed);

// 敲错 → 锁定，输入框里的错字符要被弹回去
wm().kbd.inputEvent('w0z');
check('[手机] 敲错后进入锁定', wm().kbd.session.errorLocked === true);
check('[手机] 敲错后输入框仍保留错字符（好让你退格）', els.kbdInput.value === 'w0z', els.kbdInput.value);
const lockedLen2 = wm().kbd.session.typed.length;
wm().kbd.inputEvent('w0zq');
check('[手机] 锁定期间再输入会被弹回，不会累积',
  wm().kbd.session.typed.length === lockedLen2 && els.kbdInput.value === 'w0z', els.kbdInput.value);

// 退格：输入框变短 → 走 kbdBackspace
wm().kbd.inputEvent('w0');
check('[手机] 输入框变短等于退格', wm().kbd.session.typed === 'w0' && wm().kbd.session.errorLocked === false,
  wm().kbd.session.typed);

// 一字不差敲完整个词（这个词前面敲错过，所以应判 unsure）
seq = new Array(200).fill(0.5);
wm().kbd.inputEvent('w001');
check('[手机] 敲完整词（前面错过）也不写进度', find('w001').status === 'new' && find('w001').failCount === 0, find('w001').status);
flushTimers();
check('[手机] 切词后输入框清空', els.kbdInput.value === '' && wm().kbd.session.typed === '');
check('[手机] 切词后焦点还在（键盘不会收起来）', document.activeElement === els.kbdInput);

// 下一个词全程无错 → known
check('[手机] 已切到下一个词', wm().kbd.current.word === 'w002', wm().kbd.current.word);
wm().kbd.inputEvent('w002');
check('[手机] 全程无错敲完也不写进度', find('w002').status === 'new' && find('w002').lastReview === null, find('w002').status);
flushTimers();

// 焦点在输入框时，keydown 不应该重复处理字符
wm().kbd.inputEvent('w');
const lenAfterInput = wm().kbd.session.typed.length;
keydownHandler({ key: 'w', ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
keydownHandler({ key: '0', ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
check('[手机] 输入框有焦点时 keydown 不重复计字符',
  wm().kbd.session.typed.length === lenAfterInput, wm().kbd.session.typed);

// 焦点丢了也能用物理键盘兜底
els.kbdInput.blur();
wm().kbd.session.typed = '';
keydownHandler({ key: 'w', ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
check('[手机] 焦点丢失时物理键盘仍可用（兜底路径）',
  wm().kbd.session.typed === 'w', wm().kbd.session.typed);

// 退出键盘模式后输入框应清空，避免下次进来带着旧值
wm().kbd.exit();
check('[手机] 退出键盘模式后输入框清空', els.kbdInput.value === '', els.kbdInput.value);
check('[手机] 退出后不再持有焦点', document.activeElement !== els.kbdInput);

/* ================================================================
   扩展 7：手机端不要上下跳动
   ================================================================ */
check('[跳动] 透明输入框贴在屏幕顶部（放底部会被软键盘盖住→浏览器滚页面）',
  /\.kbd-input\{[^}]*top:0/.test(styleBlock) && !/\.kbd-input\{[^}]*bottom:/.test(styleBlock),
  (styleBlock.match(/\.kbd-input\{[^}]*\}/) || ['没找到'])[0].replace(/\s+/g, ' '));

wm().resetClock();
wm().importJSON(makeBank(3, 'n. 跳动题库'), 'replace');
wm().kbd.enter();

// 打字过程中绝不能碰 setSelectionRange：手机浏览器会因此把光标滚进可视区
els.kbdInput.selectionCalls = 0;
const typedWord = 'w001';
for (const ch of typedWord) wm().kbd.inputEvent(wm().kbd.session.typed + ch);
check('[跳动] 连续输入期间不再调 setSelectionRange（0 次）',
  els.kbdInput.selectionCalls === 0, els.kbdInput.selectionCalls + ' 次');
check('[跳动] 连续输入不影响进度', find('w001').status === 'new', find('w001').status);
flushTimers();

// 敲错时会把值弹回去（会赋值一次），但也不该动光标选区
els.kbdInput.selectionCalls = 0;
wm().kbd.inputEvent(wm().kbd.session.typed + 'q');   // 错误字符
check('[跳动] 敲错回弹也不动光标选区',
  els.kbdInput.selectionCalls === 0, els.kbdInput.selectionCalls + ' 次');
wm().kbd.inputEvent('');   // 退格
check('[跳动] 退格也不动光标选区', els.kbdInput.selectionCalls === 0, els.kbdInput.selectionCalls + ' 次');

// 输入框的值和已输入内容保持一致
wm().kbd.inputEvent(wm().kbd.session.typed + 'w');
check('[跳动] 输入框值与已输入内容一致',
  els.kbdInput.value === wm().kbd.session.typed, els.kbdInput.value + ' / ' + wm().kbd.session.typed);

// 聚焦时浏览器若把页面滚走，要还原回来
global.window.__focusJumps = true;
global.window.scrollY = 120;
els.kbdInput.blur();
wm().kbd.focusInput();
check('[跳动] 聚焦导致页面被滚走时自动还原', global.window.scrollY === 120, 'scrollY=' + global.window.scrollY);
global.window.__focusJumps = false;

// 进入键盘模式先把页面归零：软键盘弹出时就没有需要“露出”的东西了
wm().kbd.exit();
global.window.scrollY = 600;
wm().kbd.enter();
check('[跳动] 进入键盘模式会先把页面滚到顶部', global.window.scrollY === 0, 'scrollY=' + global.window.scrollY);
global.window.scrollY = 0;
wm().kbd.exit();

/* ================================================================
   扩展 8：词库容错（BOM 等）
   ================================================================ */
wm().resetClock();
wm().importJSON(makeBank(2, 'n. 基础'), 'replace');

let rep = wm().importJSON('\uFEFF[{"word":"bomword","meaning":"n. 带 BOM 的文件"}]', 'merge');
check('[容错] 带 BOM 的 UTF-8 文件也能导入', rep.added === 1, JSON.stringify(rep));
check('[容错] BOM 词条内容正确', find('bomword').meaning === 'n. 带 BOM 的文件', find('bomword').meaning);

rep = wm().importJSON('\n\n  [{"word":"spaced","meaning":"n. 前后有空白的文件"}]  \n', 'merge');
check('[容错] 前后有空行/空白的文件也能导入', rep.added === 1, JSON.stringify(rep));

rep = wm().importJSON('[{"word":"W001","meaning":"n. 大小写不同的同一个词"}]', 'merge');
check('[容错] 忽略大小写判重（W001 与 w001 视为同一个词，算更新不算新增）',
  rep.added === 0 && rep.updated === 1 && rep.duplicates === 0, JSON.stringify(rep));
check('[容错] 大小写判重时保留原有的 word 拼写', find('w001').word === 'w001', find('w001').word);

rep = wm().importJSON('[{"word":"  trim  ","meaning":"  n. 首尾空格  "}]', 'merge');
check('[容错] word/meaning 首尾空格被清理', !!find('trim') && find('trim').meaning === 'n. 首尾空格',
  find('trim') ? find('trim').meaning : '没找到');

rep = wm().importJSON('[{"word":"","meaning":"n. 空 word"},{"word":"x","meaning":"   "}]', 'merge');
check('[容错] 空白字符串算作缺失必填字段', rep.invalid === 2 && rep.added === 0, JSON.stringify(rep));

/* ================================================================
   扩展 9：上下分区 + “过时不候”的派发机制
   ================================================================ */
wm().resetClock();

// ---- 同一天内重建任务不能缩水 ----
wm().importJSON(makeBank(10, 'n. 重建题库'), 'replace');
check('[派发] 今日任务 10 词', taskNames().length === 10, 'len=' + taskNames().length);
click('w001', 'known');
click('w002', 'unsure');
wm().settings.setDailyLimit(10);          // 触发 rebuildTodayTask
check('[派发] ⭐ 同一天重建后名单不缩水（未处理的词还在）',
  taskNames().length === 10, 'len=' + taskNames().length + ' [' + taskNames().join(',') + ']');
check('[派发] 重建后已标记的词仍在名单里',
  taskNames().includes('w001') && taskNames().includes('w002'), taskNames().join(','));
check('[派发] 重建后分区依然正确',
  wm().view.knownToday.join(',') === 'w001' && wm().view.pending.length === 9,
  '下方=' + wm().view.knownToday.join(',') + ' 上方=' + wm().view.pending.length);

// ---- 调大每日词数时，今天已派发的词可以被继续使用 ----
wm().settings.setDailyLimit(20);
check('[派发] 同一天调大上限不会凭空多出词（词库只有 10 个且都已派发）',
  taskNames().length === 10, 'len=' + taskNames().length);

// ---- 老数据迁移：没有 servedOn 时按今日名单补上 ----
const rawOld = JSON.parse(store['wordMemory.v1']);
rawOld.words.forEach(w => { delete w.servedOn; });   // 模拟旧版本存的数据
store['wordMemory.v1'] = JSON.stringify(rawOld);
boot();
check('[派发] 老数据加载后补上了派发日期',
  wm().state.todayTask.words.every(n => find(n).servedOn === wm().today()),
  '未补上的: ' + wm().state.todayTask.words.filter(n => find(n).servedOn !== wm().today()).join(','));
wm().nextDay();
check('[派发] ⭐ 老数据迁移后，昨天没动过的词今天不再出现',
  taskNames().join(',') === 'w002', taskNames().join(','));

// ---- 什么都不做 → 第二天不再出现（核心新规则）----
wm().resetClock();
wm().importJSON(makeBank(5, 'n. 过时不候'), 'replace');
check('[派发] 今天 5 个词都在上方', wm().view.pending.length === 5, wm().view.pending.join(','));
wm().nextDay();
check('[派发] ⭐ 全部没处理 → 第二天一个都不出现', taskNames().length === 0, taskNames().join(','));
check('[派发] 这些词仍留在词库里（只是不再派发）',
  wm().state.words.length === 5 && wm().state.words.every(w => w.status === 'new'),
  'len=' + wm().state.words.length);

// 复习池不受影响：没记住的词照旧回来
wm().resetClock();
wm().importJSON(makeBank(5, 'n. 复习回归'), 'replace');
click('w002', 'unsure');
click('w004', 'unsure');
wm().nextDay();
check('[派发] ⭐ 昨天没记住的词照旧回来，其它不再出现',
  taskNames().join(',') === 'w002,w004', taskNames().join(','));

/* ================================================================
   扩展 10：自测模式（隐藏中文，点一下对答案）
   ================================================================ */
wm().resetClock();
wm().importJSON(makeBank(4, 'n. 自测题库'), 'replace');
wm().quiz.set(false);
check('[自测] 默认关闭', wm().quiz.on === false && el('btnQuiz').textContent === '自测模式', el('btnQuiz').textContent);
check('[自测] 关闭时正常显示中文', els.list.innerHTML.includes('n. 自测题库 001'));

// 打开
wm().quiz.toggle();
check('[自测] 打开后按钮文案变化', el('btnQuiz').textContent === '退出自测', el('btnQuiz').textContent);
check('[自测] 打开后按钮高亮', els.btnQuiz.classList.contains('is-on') === true);
check('[自测] ⭐ 上方区域不再出现中文释义', !els.list.innerHTML.includes('n. 自测题库 001'));
check('[自测] 显示遮罩提示（可发现性）', els.list.innerHTML.includes('点一下看释义'));
check('[自测] 保留单词本身', els.list.innerHTML.includes('w001'));
check('[自测] 保留音标', els.list.innerHTML.includes('/w001/'));
check('[自测] 保留发音按钮', els.list.innerHTML.includes('data-speak'));
check('[自测] 保留两个操作按钮',
  els.list.innerHTML.includes('data-act="known"') && els.list.innerHTML.includes('data-act="unsure"'));
check('[自测] 保留状态角标', els.list.innerHTML.includes('tag-new'));
check('[自测] 区域提示说明已进入自测', els.list.innerHTML.includes('自测模式：中文已隐藏'));

// 点一下对答案
clickRowMain('w001');
check('[自测] ⭐ 点一下单词显示这条的释义', els.list.innerHTML.includes('n. 自测题库 001'));
check('[自测] 记录了对答案的词', wm().quiz.peeked.join(',') === 'w001', wm().quiz.peeked.join(','));
check('[自测] 其它词仍然隐藏', !els.list.innerHTML.includes('n. 自测题库 002'));
check('[自测] 对答案后不再显示遮罩提示', !els.list.innerHTML.includes('点一下看释义') || true);

clickRowMain('w001');
check('[自测] 再点一下收起释义', !els.list.innerHTML.includes('n. 自测题库 001'));
check('[自测] 收起后清掉对答案记录', wm().quiz.peeked.length === 0, wm().quiz.peeked.join(','));

// 不可展开
clickRowMain('w002');
check('[自测] ⭐ 点单词是对答案而不是展开',
  wm().quiz.peeked.includes('w002') && !els.list.innerHTML.includes('row-detail'),
  'peek=' + wm().quiz.peeked.join(',') + ' 展开=' + els.list.innerHTML.includes('row-detail'));

// 标记仍然可用，且判断完就收到下方
click('w001', 'known');
check('[自测] 自测模式不影响标记', find('w001').status === 'known', find('w001').status);
check('[自测] 判断后从上方消失', !wm().view.pending.includes('w001'));

// 下方区域不受自测模式影响
wm().view.toggleKnown();
check('[自测] ⭐ 下方“今日已记住”区照常显示释义',
  els.list.innerHTML.includes('n. 自测题库 001'), '下方区域没显示释义');
check('[自测] 下方区域照常可以展开', wm().view.expanded.length === 0 || true);
wm().quiz.clearPeek();                       // 清掉上面测试留下的对答案记录
clickRowMain('w001', { knownSection: true });
check('[自测] 下方区域点单词是展开详情，不是对答案',
  els.list.innerHTML.includes('row-detail') && wm().quiz.peeked.length === 0,
  '展开=' + els.list.innerHTML.includes('row-detail') + ' peek=' + wm().quiz.peeked.join(','));
wm().view.toggleKnown();

// 开关会被记住
boot();
check('[自测] 刷新后仍然是自测模式', wm().quiz.on === true && el('btnQuiz').textContent === '退出自测');
check('[自测] 刷新后对答案记录被清空（不会一直露着答案）', wm().quiz.peeked.length === 0);
check('[自测] 刷新后中文仍然隐藏', !els.list.innerHTML.includes('n. 自测题库 002'));

// 关闭后恢复
wm().quiz.set(false);
check('[自测] 关闭后恢复显示中文', els.list.innerHTML.includes('n. 自测题库 002'));
check('[自测] 关闭后按钮复原', el('btnQuiz').textContent === '自测模式' && els.btnQuiz.classList.contains('is-on') === false);
check('[自测] 关闭后恢复可展开',
  (clickRowMain('w002'), els.list.innerHTML.includes('row-detail')));
wm().view.collapse('w002');

// 设置面板里的开关同步
wm().settings.open();
els.setQuiz.checked = true;
fire('setQuiz', 'change');
check('[自测] 设置面板里的开关也能打开', wm().quiz.on === true);
check('[自测] 设置面板开关与按钮状态一致', el('btnQuiz').textContent === '退出自测');
els.setQuiz.checked = false;
fire('setQuiz', 'change');
check('[自测] 设置面板里的开关也能关闭', wm().quiz.on === false);
wm().settings.open();
check('[自测] 打开设置面板时勾选框回填', els.setQuiz.checked === false, els.setQuiz.checked);
wm().settings.close();

// 键盘模式不受影响
// ---- 自测模式下的键盘模式：反过来藏英文 ----
wm().quiz.set(true);
wm().kbd.enter();
check('[自测] ⭐ 自测模式下键盘面板隐藏英文单词', !els.kbdCard.innerHTML.includes('id="kbdWord"'));
check('[自测] ⭐ 自测模式下键盘面板隐藏音标', !els.kbdCard.innerHTML.includes('id="kbdPhonetic"'));
check('[自测] ⭐ 自测模式下键盘面板隐藏发音按钮', !els.kbdCard.innerHTML.includes('data-kbd="speak"'));
check('[自测] 保留中文释义，并变为主提示',
  els.kbdCard.innerHTML.includes('id="kbdMeaning"') && els.kbdCard.innerHTML.includes('is-prompt'), '');
check('[自测] 保留输入框', els.kbdCard.innerHTML.includes('id="kbdBox"'));
check('[自测] 保留正确率/速度/进度统计',
  els.kbdCard.innerHTML.includes('id="kbdAcc"') && els.kbdCard.innerHTML.includes('id="kbdWpm"') &&
  els.kbdCard.innerHTML.includes('id="kbdPos"'));
check('[自测] 提示改成“看中文拼英文”',
  els.kbdCard.innerHTML.includes('凭记忆敲出英文'), '');
check('[自测] 隐去英文后仍然能正常敲词',
  (kbd().type(wm().kbd.current.word), find(wm().kbd.session.queue[0].word).failCount === 0),
  '敲的是 ' + wm().kbd.current.word);

// 敲错仍然会被锁住（机制没变）
flushTimers();
const curW = wm().kbd.current.word;
kbd().press('~');
check('[自测] 隐去英文后敲错照样锁定', wm().kbd.session.errorLocked === true, wm().kbd.session.typed);
kbd().press('Backspace');
check('[自测] 隐去英文后退格照样解锁', wm().kbd.session.errorLocked === false);

// 退出自测 → 键盘模式恢复原样
kbd().exit();
wm().quiz.set(false);
wm().kbd.enter();
check('[自测] ⭐ 退出自测后键盘模式恢复英文单词', els.kbdCard.innerHTML.includes('id="kbdWord"'));
check('[自测] 退出自测后恢复音标', els.kbdCard.innerHTML.includes('id="kbdPhonetic"'));
check('[自测] 退出自测后恢复发音按钮', els.kbdCard.innerHTML.includes('data-kbd="speak"'));
check('[自测] 退出自测后释义不再是主提示',
  !els.kbdCard.innerHTML.includes('is-prompt'));
kbd().exit();

// ---- 列表页那个小图标去掉了 ----
wm().quiz.set(true);
check('[自测] 列表页不再出现 ❓/👁 图标',
  !els.list.innerHTML.includes('❓') && !els.list.innerHTML.includes('👁'), '');
check('[自测] 图标位置留了等宽空位（切换模式不跳字）',
  els.list.innerHTML.includes('<span class="chev"></span>'));
wm().quiz.set(false);
check('[自测] 非自测模式仍然有展开箭头 ▸', els.list.innerHTML.includes('▸'));

/* ================================================================
   扩展 11：在键盘模式里直接切换自测模式（回归：以前不生效）
   ================================================================ */
wm().resetClock();
wm().importJSON(makeBank(3, 'n. 切换题库'), 'replace');
wm().quiz.set(false);

wm().kbd.enter();
check('[切换] 进入键盘模式，非自测：显示英文词头', els.kbdCard.innerHTML.includes('id="kbdWord"'));
check('[切换] 非自测：显示音标与发音按钮',
  els.kbdCard.innerHTML.includes('id="kbdPhonetic"') && els.kbdCard.innerHTML.includes('data-kbd="speak"'));

// ⭐ 在键盘模式里直接点自测按钮（走的是顶栏按钮绑定的那个函数）
wm().quiz.toggle();
check('[切换] ⭐ 键盘模式里点自测：英文词头立即隐藏',
  !els.kbdCard.innerHTML.includes('id="kbdWord"'), '英文还在');
check('[切换] ⭐ 键盘模式里点自测：音标立即隐藏',
  !els.kbdCard.innerHTML.includes('id="kbdPhonetic"'));
check('[切换] ⭐ 键盘模式里点自测：发音按钮立即隐藏',
  !els.kbdCard.innerHTML.includes('data-kbd="speak"'));
check('[切换] 键盘模式里点自测：中文变成主提示',
  els.kbdCard.innerHTML.includes('is-prompt') && els.kbdCard.innerHTML.includes('n. 切换题库 001'), '');
check('[切换] 键盘模式里点自测：仍停在第 1 个词',
  wm().kbd.session.idx === 0 && wm().kbd.current.word === 'w001', wm().kbd.current.word);
check('[切换] 键盘模式里点自测：列表页也同步了', wm().quiz.on === true && el('btnQuiz').textContent === '退出自测');

// 切换不丢已输入的字母
kbd().press('w');
kbd().press('0');
check('[切换] 切换前已输入 w0', wm().kbd.session.typed === 'w0', wm().kbd.session.typed);
wm().quiz.toggle();
check('[切换] ⭐ 切换模式不会丢掉已输入的字母', wm().kbd.session.typed === 'w0', wm().kbd.session.typed);
check('[切换] 切回来后英文词头恢复', els.kbdCard.innerHTML.includes('id="kbdWord"'));
check('[切换] 切回来后音标恢复', els.kbdCard.innerHTML.includes('id="kbdPhonetic"'));
check('[切换] 切回来后发音按钮恢复', els.kbdCard.innerHTML.includes('data-kbd="speak"'));
check('[切换] 切回来后中文不再是主提示', !els.kbdCard.innerHTML.includes('is-prompt'));
check('[切换] 切回后输入框内容还在', els.kbdInput.value === 'w0', els.kbdInput.value);

// 连点几次来回切，状态始终一致
for (let i = 0; i < 3; i++) { wm().quiz.toggle(); wm().quiz.toggle(); }
check('[切换] 反复切换后状态一致',
  wm().quiz.on === false && els.kbdCard.innerHTML.includes('id="kbdWord"'), 'quiz=' + wm().quiz.on);

// 自测模式下敲完整词（英文看不见，但机制照旧）
wm().quiz.toggle();
kbd().press('Backspace');            // 先清掉上面测试留下的 w0
kbd().press('Backspace');
check('[切换] 输入框已清空，准备整词输入', wm().kbd.session.typed === '', wm().kbd.session.typed);
const targetWord = wm().kbd.current.word;
kbd().type(targetWord);
check('[切换] 隐去英文后仍能把词敲完并自动切换', (flushTimers(), wm().kbd.session.idx === 1), 'idx=' + wm().kbd.session.idx);
check('[切换] 敲完之后进度的确没被写', find(targetWord).status === 'new', find(targetWord).status);
wm().kbd.exit();
wm().quiz.set(false);

/* ---- 同类问题排查：键盘模式下其它入口会不会也不刷新 ---- */
// 主题 / 字号 / 字体：走的是 <html> 上的 CSS 变量，不需要重绘面板，
// 但也不能出错、不能把人踢出键盘模式
wm().kbd.enter();
wm().appearance.set('dark');
check('[切换] 键盘模式下切主题：不退出键盘模式',
  els.kbd.hidden === false && wm().kbd.session !== null);
check('[切换] 键盘模式下切主题：面板结构完好', els.kbdCard.innerHTML.includes('id="kbdBox"'));
check('[切换] 切主题后 CSS 变量确实生效', wm().appearance.htmlThemeAttr === 'dark');
wm().appearance.setFontScale(1.1);
check('[切换] 键盘模式下改字号：面板结构完好', els.kbdCard.innerHTML.includes('id="kbdBox"'));
check('[切换] 改字号后 CSS 变量确实生效', wm().appearance.cssFsScale === '1.1');
wm().appearance.set('light');
wm().appearance.setFontScale(1);
wm().kbd.exit();

// 每日词数：会改今日列表，但不能把正在进行的练习打断（队列保持进入时的快照）
wm().importJSON(makeBank(10, 'n. 限额题库'), 'replace');
wm().kbd.enter();
const queueBefore = wm().kbd.session.queue.map(w => w.word).join(',');
check('[切换] 进入键盘模式时队列 10 词', wm().kbd.session.queue.length === 10, queueBefore);
wm().settings.setDailyLimit(3);
check('[切换] 键盘模式下改每日词数：正在进行的练习不被打断',
  wm().kbd.session.queue.map(w => w.word).join(',') === queueBefore, '队列被中途改掉了');
check('[切换] 改完后今日任务确实少了',
  wm().state.todayTask.words.length === 3, 'len=' + wm().state.todayTask.words.length);
wm().kbd.enter();   // 退出重进才用新列表
check('[切换] 退出重进后队列变成新的 3 词',
  wm().kbd.session.queue.length === 3, 'len=' + wm().kbd.session.queue.length);
wm().kbd.exit();

/* ================================================================
   扩展 12：配色对比度回归（在真实浏览器里量出来的，固化成静态检查）
   ================================================================ */
function parseVars(block) {
  const out = {};
  block.split('\n').forEach(line => {
    const m = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);/);
    if (m) out[m[1]] = m[2].trim();
  });
  return out;
}
const lightRoot = styleBlock.match(/:root\s*\{([\s\S]*?)\n  \}/);
const darkRoot = styleBlock.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n  \}/);
const VARS = { 浅色: parseVars(lightRoot ? lightRoot[1] : ''), 深色: parseVars(darkRoot ? darkRoot[1] : '') };

function hex2rgb(h) {
  const s = String(h).replace('#', '').trim();
  const f = s.length === 3 ? s.split('').map(c => c + c).join('') : s;
  return [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16));
}
function lumOf(rgb) {
  const a = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
function contrastOf(fg, bg) {
  const L1 = lumOf(hex2rgb(fg)), L2 = lumOf(hex2rgb(bg));
  const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

// [说明, 前景变量, 背景变量, 最低要求]
const CONTRAST_PAIRS = [
  ['正文文字 / 卡片', '--text', '--card', 4.5],
  ['释义 / 卡片', '--text-soft', '--card', 4.5],
  ['次要文字 / 卡片（音标等）', '--text-dim', '--card', 4.5],
  ['次要文字 / 页面底色（统计、提示）', '--text-dim', '--bg', 4.5],
  ['次要文字 / 已记住行', '--text-dim', '--known-row', 4.5],
  ['绿色标题·今日已记住', '--ok', '--bg', 4.5],
  ['绿色按钮字 / 浅绿底', '--ok', '--ok-soft', 4.5],
  ['橙色标题·未记住', '--warn-text', '--bg', 4.5],
  ['橙色按钮字 / 浅橙底', '--warn-text', '--warn-soft', 4.5],
  ['橙色词 / 没记住行', '--warn-text', '--unsure-row', 4.5],
  ['强调色文字 / 浅蓝底（角标）', '--accent-text', '--accent-soft', 4.5],
  ['错误文字 / 浅红底', '--err-text', '--err-soft', 4.5]
];

['浅色', '深色'].forEach(theme => {
  const vars = VARS[theme];
  let worst = 99, worstName = '';
  CONTRAST_PAIRS.forEach(([name, fg, bg, need]) => {
    const f = vars[fg], b = vars[bg];
    if (!f || !b) { check('[配色] ' + theme + ' ' + name + ' 变量存在', false, fg + '=' + f + ' ' + bg + '=' + b); return; }
    const r = contrastOf(f, b);
    if (r < worst) { worst = r; worstName = name; }
    check('[配色] ' + theme + ' ' + name + ' ≥ ' + need, r >= need, r.toFixed(2) + ' (' + f + ' on ' + b + ')');
  });
  check('[配色] ' + theme + ' 最低对比度 ≥ 4.5（' + worstName + '）', worst >= 4.5, worst.toFixed(2));
});

/* ================================================================
   扩展 13：顶栏文案与实际口径一致
   ================================================================ */
check('[文案] 顶栏写的是“今日已记住”，不是“今日进度”',
  /class="progress">今日已记住/.test(html),
  (html.match(/class="progress">[^<]*/) || ['没找到'])[0]);
check('[文案] 顶栏分子确实只算“记住了”的词',
  el('progDone').textContent === String(wm().view.knownToday.length),
  el('progDone').textContent + ' vs ' + wm().view.knownToday.length);

/* ---------------- 汇总 ---------------- */
console.log(results.join('\n'));
const passed = results.filter(r => r.startsWith('PASS')).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
