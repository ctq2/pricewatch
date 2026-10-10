/**
 * 纯逻辑测试：node --test tests/calc.test.js
 *
 * 这些用例覆盖的都是「算错就要赔钱」的地方：费率顺序、跟价边界、倒挂判定。
 * 特别是 suggestedPrice 与 profitRate 的往返一致性 —— 若两者用的公式不一致，
 * 自动定价会稳定地报出一个永远达不到的利润率。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION,
  bestPlatform,
  breakEvenPrice,
  changeRate,
  decide,
  detectAnomalies,
  isInverted,
  netProfit,
  profitRate,
  stockSummary,
  suggestedPrice,
} from '../src/calc.js';

test('毛利按「平台抽成 -> 瑕疵损耗 -> 减成本」的顺序计算', () => {
  // 售价 1000，抽成 5%，损耗 2%，成本 800
  // 1000 * 0.95 * 0.98 = 931，减 800 = 131
  const profit = netProfit({ sellPrice: 1000, cost: 800, feeRate: 0.05, defectRate: 0.02 });
  assert.ok(Math.abs(profit - 131) < 0.01, `got ${profit}`);

  const rate = profitRate({ sellPrice: 1000, cost: 800, feeRate: 0.05, defectRate: 0.02 });
  assert.ok(Math.abs(rate - 131 / 800) < 1e-9);
});

test('费率为 0 时退化为「售价减成本」', () => {
  assert.equal(netProfit({ sellPrice: 500, cost: 300, feeRate: 0 }), 200);
});

test('成本缺失或非法时利润率返回 null 而不是 NaN', () => {
  assert.equal(profitRate({ sellPrice: 100, cost: 0, feeRate: 0.05 }), null);
  assert.equal(profitRate({ sellPrice: 100, cost: -1, feeRate: 0.05 }), null);
  assert.equal(profitRate({ sellPrice: 100, cost: NaN, feeRate: 0.05 }), null);
});

test('反推售价与利润率互为逆运算', () => {
  const base = { cost: 800, feeRate: 0.05, defectRate: 0.02, targetRate: 0.2 };
  const price = suggestedPrice(base);
  const rate = profitRate({ ...base, sellPrice: price });
  assert.ok(Math.abs(rate - 0.2) < 1e-9, `expected 20%, got ${(rate * 100).toFixed(4)}%`);
});

test('保本价对应 0% 利润率', () => {
  const base = { cost: 800, feeRate: 0.05, defectRate: 0.02 };
  const rate = profitRate({ ...base, sellPrice: breakEvenPrice(base) });
  assert.ok(Math.abs(rate) < 1e-9, `expected 0%, got ${rate}`);
});

test('费率吃掉全部售价时无法反推售价', () => {
  // 费率是相乘关系，所以只有乘积归零（任一项达到 100%）才无解。
  assert.equal(suggestedPrice({ cost: 100, feeRate: 1, defectRate: 0, targetRate: 0.1 }), null);
  assert.equal(suggestedPrice({ cost: 100, feeRate: 0, defectRate: 1, targetRate: 0.1 }), null);
  // 50% + 50% 仍留下 25% 的到手比例，是可以算的。
  assert.ok(suggestedPrice({ cost: 100, feeRate: 0.5, defectRate: 0.5, targetRate: 0.1 }) > 0);
});

test('达标且竞品价更高 -> 维持', () => {
  const result = decide({
    cost: 800, feeRate: 0.05, defectRate: 0.02, targetRate: 0.1,
    myPrice: 1100, competitorPrice: 1150, listed: true,
  });
  assert.equal(result.action, ACTION.HOLD);
});

test('达标但未上架 -> 建议上架', () => {
  const result = decide({
    cost: 800, feeRate: 0.05, defectRate: 0.02, targetRate: 0.1,
    myPrice: 1100, competitorPrice: 1150, listed: false,
  });
  assert.equal(result.action, ACTION.LIST);
});

test('价格倒挂（售价低于成本）-> 下架，且不参与跟价', () => {
  const result = decide({
    cost: 1000, feeRate: 0.05, defectRate: 0, targetRate: 0.1,
    myPrice: 900, competitorPrice: 850, listed: true,
  });
  assert.equal(result.action, ACTION.DELIST);
  assert.match(result.reason, /倒挂/);
  assert.equal(result.price, null, '倒挂时不应给出跟价建议');
});

test('利润不足 -> 下架（竞品更高也一样，跟价解决不了不达标）', () => {
  // 成本 500，保本价 = 500/0.95 ≈ 526.3，目标 30% 对应价格 ≈ 684.2。
  // 取 600：到手 570，利润率 14% —— 高于保本、低于目标，属于「不达标」而非「倒挂」。
  const result = decide({
    cost: 500, feeRate: 0.05, defectRate: 0, targetRate: 0.3,
    myPrice: 600, competitorPrice: 900, listed: true,
  });
  assert.equal(result.action, ACTION.DELIST);
  assert.match(result.reason, /不达标/);
  assert.equal(result.price, null);
});

test('竞品砸价但跟价后仍达标 -> 建议跟随调价', () => {
  // 成本 500，目标 10%。当前价 800（利润率 52%），竞品降到 620。
  // 620 * 0.95 = 589，相对 500 的利润率 17.8% > 10%，值得跟。
  const result = decide({
    cost: 500, feeRate: 0.05, defectRate: 0, targetRate: 0.1,
    myPrice: 800, competitorPrice: 620, listed: true,
  });
  assert.equal(result.action, ACTION.REPRICE);
  assert.equal(result.price, 620);
  assert.match(result.reason, /跟价/);
});

test('竞品砸价但跟价后不达标 -> 维持，明确说明不跟价', () => {
  // 成本 500，目标 30%。当前价 800 达标，竞品 600：600*0.95=570，利润率 14% < 30%。
  // 跟价会把自己跟到不达标，所以选择不跟、维持原价。
  const result = decide({
    cost: 500, feeRate: 0.05, defectRate: 0, targetRate: 0.3,
    myPrice: 800, competitorPrice: 600, listed: true,
  });
  assert.equal(result.action, ACTION.HOLD);
  assert.equal(result.price, null);
  assert.match(result.reason, /不跟价/);
});

test('跟价阈值是闭区间：跟价后恰好达标应当跟随', () => {
  const cost = 500, feeRate = 0.05, defectRate = 0, targetRate = 0.14;
  const competitor = 600; // 600*0.95 = 570 -> (570-500)/500 = 0.14 恰好等于目标
  const result = decide({
    cost, feeRate, defectRate, targetRate, myPrice: 800, competitorPrice: competitor, listed: true,
  });
  assert.equal(result.action, ACTION.REPRICE);
  assert.equal(result.price, competitor);
});

test('竞品砸价到倒挂区间时绝不跟价', () => {
  // 成本 500，竞品 480：480*0.95 = 456 < 500，跟了就是亏本。
  const result = decide({
    cost: 500, feeRate: 0.05, defectRate: 0, targetRate: 0.1,
    myPrice: 800, competitorPrice: 480, listed: true,
  });
  assert.equal(result.action, ACTION.HOLD);
  assert.match(result.reason, /不跟价/);
});

test('缺少成本时不决策，而不是给出错误的建议', () => {
  const result = decide({ cost: 0, feeRate: 0.05, targetRate: 0.1, myPrice: 800, competitorPrice: 700 });
  assert.equal(result.action, ACTION.HOLD);
  assert.match(result.reason, /无法决策/);
});

test('选出利润率最高的平台', () => {
  const best = bestPlatform([
    { platform: 'KREAM', sellPrice: 1200, cost: 800, feeRate: 0.05, defectRate: 0.02 },
    { platform: '得物', sellPrice: 1140, cost: 800, feeRate: 0.03, defectRate: 0.02 },
  ]);
  // KREAM: 1200*0.95*0.98 = 1117.2 - 800 = 317.2 -> 39.65%
  // 得物 : 1140*0.97*0.98 = 1083.68 - 800 = 283.68 -> 35.46%
  assert.equal(best.platform, 'KREAM');
});

test('全部平台数据缺失时返回 null', () => {
  assert.equal(bestPlatform([{ platform: 'KREAM', sellPrice: 100, cost: 0, feeRate: 0 }]), null);
  assert.equal(bestPlatform([]), null);
});

test('倒挂判定', () => {
  assert.equal(isInverted({ sellPrice: 900, cost: 1000 }), true);
  assert.equal(isInverted({ sellPrice: 1000, cost: 1000 }), false);
  assert.equal(isInverted({ sellPrice: NaN, cost: 1000 }), false);
});

test('涨跌幅计算与零值保护', () => {
  assert.equal(changeRate(100, 110), 0.1);
  assert.equal(changeRate(100, 90), -0.1);
  assert.equal(changeRate(0, 90), null);
  assert.equal(changeRate(NaN, 90), null);
});

test('价格异动预警只报超过阈值的项，并按幅度排序', () => {
  const series = [
    {
      id: 'A', name: 'A',
      history: { KREAM: [{ price: 1000 }, { price: 940 }] },   // -6% 未达 8% 阈值
    },
    {
      id: 'B', name: 'B',
      history: { KREAM: [{ price: 1000 }, { price: 850 }], 得物: [{ price: 1000 }, { price: 1002 }] },
    },
  ];
  const alerts = detectAnomalies(series, { threshold: 0.08 });
  assert.equal(alerts.length, 1, `expected 1 alert, got ${JSON.stringify(alerts)}`);
  assert.equal(alerts[0].skuId, 'B');
  assert.equal(alerts[0].direction, 'down');
  assert.ok(Math.abs(alerts[0].rate + 0.15) < 1e-9);
});

test('异动预警支持回溯多个周期', () => {
  // 序列 1000 -> 990 -> 900。
  // 回溯 1 期：(900-990)/990 = -9.09%
  // 回溯 2 期：(900-1000)/1000 = -10.00%
  // 阈值取 9.5% 正好把两者区分开，这样才真正验证了 lookback 生效。
  const series = [{ id: 'A', name: 'A', history: { KREAM: [{ price: 1000 }, { price: 990 }, { price: 900 }] } }];
  assert.equal(detectAnomalies(series, { threshold: 0.095, lookback: 1 }).length, 0);
  assert.equal(detectAnomalies(series, { threshold: 0.095, lookback: 2 }).length, 1);
});

test('库存汇总能识别断码', () => {
  const partial = stockSummary([{ size: '42', stock: 2 }, { size: '43', stock: 0 }]);
  assert.deepEqual(partial, { total: 2, soldOut: 1, sizeCount: 2, full: false });

  const full = stockSummary([{ size: '42', stock: 1 }, { size: '43', stock: 3 }]);
  assert.equal(full.full, true);
  assert.equal(full.total, 4);
});
