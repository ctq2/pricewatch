/**
 * 无头渲染测试：node --test tests/render.test.js
 *
 * 零依赖、零构建的前端没有任何编译期保护，import 写错或模板里漏了变量，
 * 在浏览器里表现就是白屏。这里给 Node 一个最小 DOM + Canvas 桩，真实执行
 * boot() 并逐个视图断言，把这类问题挡在提交之前。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------- Canvas 桩 */

function makeContext() {
  const noop = () => {};
  return {
    canvas: null,
    save: noop, restore: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, bezierCurveTo: noop, arc: noop, arcTo: noop,
    fill: noop, stroke: noop, clearRect: noop, setTransform: noop,
    fillText: noop, setLineDash: noop, measureText: () => ({ width: 40 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    // 可写属性
    lineWidth: 1, lineJoin: '', lineCap: '', strokeStyle: '', fillStyle: '',
    font: '', textAlign: '', textBaseline: '', shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
  };
}

/* ---------------------------------------------------------------- DOM 桩 */

class ClassList {
  constructor() { this.set = new Set(); }
  add(...n) { n.forEach((x) => this.set.add(x)); }
  remove(...n) { n.forEach((x) => this.set.delete(x)); }
  contains(n) { return this.set.has(n); }
  toggle(n, force) {
    const on = force === undefined ? !this.set.has(n) : Boolean(force);
    on ? this.set.add(n) : this.set.delete(n);
    return on;
  }
}

class Element {
  constructor(tag = 'div', id = '') {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.offsetWidth = 120;
    this.offsetLeft = 0;
    this.width = 800;
    this.height = 260;
    this.classList = new ClassList();
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this._html = '';
    this.parentElement = null;
  }
  set innerHTML(v) { this._html = String(v ?? ''); }
  get innerHTML() { return this._html; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener() {}
  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, target: this, ...event });
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  getContext() { return makeContext(); }
  getBoundingClientRect() { return { width: 800, height: 260, top: 0, left: 0 }; }
  querySelector(sel) {
    if (sel === '.pill') return this.children.find((c) => c.classList.contains('pill')) ?? null;
    if (sel === 'button[aria-selected="true"]') {
      return this.children.find((c) => c.getAttribute('aria-selected') === 'true') ?? null;
    }
    return null;
  }
  querySelectorAll(sel) {
    if (sel === 'button' || sel === '#tabs button') return this.children.filter((c) => c.tagName === 'BUTTON');
    return [];
  }
  closest(sel) { return this.matches(sel) ? this : null; }

  /** 只支持应用真正用到的几种选择器：tag[data-x]、[data-x]、#id。 */
  matches(sel) {
    const attr = sel.match(/^([a-z]*)\[data-([a-z-]+)\]$/i);
    if (attr) {
      const [, tag, name] = attr;
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return Boolean(this.dataset[key]);
    }
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    if (sel.startsWith('[data-')) {
      const name = sel.slice(6, -1).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return Boolean(this.dataset[name]);
    }
    return false;
  }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  focus() {}
  blur() {}
}

const registry = new Map();
const view = new Element('section', 'view');
registry.set('view', view);

const tabs = new Element('div', 'tabs');
for (const name of ['board', 'alerts']) {
  const button = new Element('button');
  button.dataset.view = name;
  button.setAttribute('aria-selected', name === 'board' ? 'true' : 'false');
  tabs.appendChild(button);
}
const pill = new Element('span');
pill.classList.add('pill');
tabs.appendChild(pill);

const document = {
  body: new Element('body'),
  activeElement: null,
  createElement: (tag) => new Element(tag),
  getElementById: (id) => registry.get(id) ?? null,
  querySelector: (sel) => (sel === '.detail-stack' ? document._detailStack : null),
  querySelectorAll: (sel) => (sel === '#tabs button' ? tabs.querySelectorAll('button') : []),
  addEventListener: (type, fn) => { (document._listeners ??= new Map()).set(type, fn); },
  removeEventListener: () => {},
  _detailStack: null,
  _dispatch(type, event) { document._listeners?.get(type)?.({ type, ...event }); },
};
for (const [id, text] of [['tag-status', ''], ['tag-scope', ''], ['tag-updated', '']]) {
  const el = new Element('span', id);
  el.textContent = text;
  registry.set(id, el);
}
registry.set('tabs', tabs);

globalThis.document = document;
globalThis.window = globalThis;
globalThis.devicePixelRatio = 2;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now() + 700), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
// 浏览器里的 window 就是全局对象，Node 的 globalThis 没有事件接口，补一层空实现。
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

/* ------------------------------------------------------------------- 测试 */

const { boot } = await import('../src/app.js');

test('应用可以启动并渲染行情看板', async () => {
  boot();
  const html = view.innerHTML;

  assert.ok(html.length > 2000, `看板只渲染了 ${html.length} 字符`);
  assert.match(html, /监控货号/, '缺少 KPI 卡片');
  assert.match(html, /自动决策/, '缺少决策面板');
  assert.match(html, /利润拆解/, '缺少利润拆解面板');
  assert.match(html, /price-slider/, '缺少售价滑块');
  // 模板拼接最常见的失误：变量未定义会渲染成 undefined / [object Object]
  assert.ok(!/undefined|\[object Object\]|NaN/.test(html), `模板泄漏了原始值：${html.slice(0, 300)}`);
});

test('比价列表包含全部货号，并各带一个决策徽标', async () => {
  const html = view.innerHTML;
  const rows = html.match(/data-sku="/g) ?? [];
  assert.ok(rows.length >= 8, `预期至少 8 行货号，实际 ${rows.length}`);

  const badges = html.match(/badge badge-(list|hold|reprice|delist)/g) ?? [];
  assert.ok(badges.length >= rows.length, '每个货号都应有决策徽标');

  // KREAM 与得物两个平台的价格都要出现在比价行里
  assert.match(html, /KREAM/);
  assert.match(html, /得物/);
});

test('利润拆解的数字自洽：毛利 = 售价扣费后 - 成本', async () => {
  const html = view.innerHTML;
  const num = (pattern) => {
    const match = html.match(pattern);
    return match ? Number(match[1].replace(/,/g, '')) : null;
  };
  const cost = num(/成本价<\/dt><dd>¥([\d,]+)/);
  const price = num(/当前售价<\/dt><dd>¥([\d,]+)/);
  const fee = num(/费率 ([\d.]+)%/);
  const defect = num(/瑕疵损耗 ([\d.]+)%/);
  const profit = num(/单件毛利<\/dt><dd class="[^"]*">¥(-?[\d,]+)/);

  assert.ok([cost, price, fee, defect, profit].every((v) => v !== null), `解析失败: ${[cost, price, fee, defect, profit]}`);
  const expected = price * (1 - fee / 100) * (1 - defect / 100) - cost;
  assert.ok(
    Math.abs(expected - profit) < 1.5,
    `毛利不一致：页面显示 ${profit}，按公式应为 ${expected.toFixed(2)}`,
  );
});

test('切换到价格预警视图能正常渲染', async () => {
  const alertsTab = tabs.querySelectorAll('button').find((b) => b.dataset.view === 'alerts');
  tabs.dispatch('click', { target: alertsTab });

  const html = view.innerHTML;
  assert.match(html, /价格异动预警/, '未渲染预警标题');
  assert.ok(html.length > 500, `预警视图只渲染了 ${html.length} 字符`);
  assert.ok(!/undefined|\[object Object\]|NaN/.test(html), '预警视图泄漏了原始值');
});
