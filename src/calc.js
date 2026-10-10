/**
 * 利润核算与自动决策 —— 整个看板的业务内核。
 *
 * 这一层是纯函数：没有 DOM、没有网络、不读时钟。所有输入显式传入，
 * 因此「为什么系统建议下架」这类问题可以直接在测试里复现。
 *
 * 对应需求第 3 条的三段逻辑：
 *   利润达标       -> 自动上架
 *   利润不足/倒挂  -> 自动下架
 *   竞品砸价       -> 可跟随调价，但调价后达不到预设利润则不调
 */

/** 决策动作。文案在 UI 层本地化，这里只产出语义。 */
export const ACTION = Object.freeze({
  LIST: 'list',       // 上架
  HOLD: 'hold',       // 维持现状
  REPRICE: 'reprice', // 跟随调价
  DELIST: 'delist',   // 下架
});

export const ACTION_LABEL = Object.freeze({
  list: '建议上架',
  hold: '维持',
  reprice: '建议调价',
  delist: '建议下架',
});

/**
 * 单件毛利：售价扣除平台费用、瑕疵损耗后，再减去成本。
 * 费率按顺序作用在售价上（平台先从成交价抽成，退货/瑕疵再吃掉一部分）。
 */
export function netProfit({ sellPrice, cost, feeRate, defectRate = 0 }) {
  if (!Number.isFinite(sellPrice) || !Number.isFinite(cost)) return NaN;
  return sellPrice * (1 - feeRate) * (1 - defectRate) - cost;
}

/** 利润率 = 毛利 / 成本。成本为 0 时无意义，返回 null。 */
export function profitRate(input) {
  const { cost } = input;
  if (!Number.isFinite(cost) || cost <= 0) return null;
  const profit = netProfit(input);
  if (!Number.isFinite(profit)) return null;
  return profit / cost;
}

/**
 * 反推售价：要在给定费率下达到目标利润率，售价至少是多少。
 *
 *   sellPrice * (1 - fee) * (1 - defect) - cost = cost * target
 *   => sellPrice = cost * (1 + target) / ((1 - fee) * (1 - defect))
 *
 * 这是「调价到多少才划算」的答案，也是自动定价的起点。
 */
export function suggestedPrice({ cost, feeRate, defectRate = 0, targetRate }) {
  const factor = (1 - feeRate) * (1 - defectRate);
  if (factor <= 0) return null;
  return (cost * (1 + targetRate)) / factor;
}

/** 按目标利润率上浮，算出「最低可接受售价」（用于展示阈值线）。 */
export function breakEvenPrice({ cost, feeRate, defectRate = 0 }) {
  return suggestedPrice({ cost, feeRate, defectRate, targetRate: 0 });
}

/**
 * 自动决策。
 *
 * 判定顺序即优先级，先排除亏损，再确认是否达标，最后才考虑跟价 ——
 * 这个顺序很关键：如果先看跟价，就会出现「当前价已经不达标、竞品更低」时
 * 还去跟价的荒谬结果（跟完只会更差）。只有当前价健康、且跟价之后仍然健康时，
 * 跟价才有意义。
 */
export function decide({
  cost,
  feeRate,
  defectRate = 0,
  targetRate,
  myPrice,
  competitorPrice,
  listed = true,
}) {
  const at = (price) => profitRate({ sellPrice: price, cost, feeRate, defectRate });

  const currentRate = at(myPrice);
  if (currentRate === null) {
    return { action: ACTION.HOLD, reason: '缺少成本，无法决策', rate: null, price: null };
  }

  // 1) 倒挂：售价低于成本，卖一件亏一件，直接下架。
  if (currentRate < 0) {
    const loss = -netProfit({ sellPrice: myPrice, cost, feeRate, defectRate });
    return {
      action: ACTION.DELIST,
      reason: `价格倒挂，每单亏损 ${fmtMoney(loss)}`,
      rate: currentRate,
      price: null,
    };
  }

  // 2) 利润不足：达不到目标利润率，下架处理。
  if (currentRate < targetRate) {
    return {
      action: ACTION.DELIST,
      reason: `利润率 ${fmtPct(currentRate)} 低于目标 ${fmtPct(targetRate)}，不达标`,
      rate: currentRate,
      price: null,
    };
  }

  // 3) 达标。此时再看竞品是否砸价到值得跟进 —— 前提是跟完之后依然达标。
  const competitorLower = Number.isFinite(competitorPrice) && competitorPrice < myPrice;
  if (competitorLower) {
    const rateAtCompetitor = at(competitorPrice);
    if (rateAtCompetitor !== null && rateAtCompetitor >= targetRate) {
      return {
        action: ACTION.REPRICE,
        reason: `竞品降至 ${fmtMoney(competitorPrice)}，跟价后利润率仍有 ${fmtPct(rateAtCompetitor)}`,
        rate: currentRate,
        price: competitorPrice,
      };
    }
    return {
      action: ACTION.HOLD,
      reason: `竞品价 ${fmtMoney(competitorPrice)} 更低，但跟价后利润率仅 ${fmtPct(rateAtCompetitor)}，低于目标 ${fmtPct(targetRate)}，不跟价`,
      rate: currentRate,
      price: null,
    };
  }

  // 4) 达标且无需跟价：未上架的补上架。
  return {
    action: listed ? ACTION.HOLD : ACTION.LIST,
    reason: `利润率 ${fmtPct(currentRate)}，达到目标 ${fmtPct(targetRate)}`,
    rate: currentRate,
    price: null,
  };
}

/** 组合两个平台的报价，给出「在哪个平台卖更划算」。 */
export function bestPlatform(offers) {
  const scored = offers
    .map((offer) => ({ ...offer, rate: profitRate(offer) }))
    .filter((offer) => offer.rate !== null);
  if (!scored.length) return null;
  return scored.reduce((best, item) => (item.rate > best.rate ? item : best));
}

/** 价格倒挂检测：售价低于成本，卖一件亏一件。 */
export function isInverted({ sellPrice, cost }) {
  return Number.isFinite(sellPrice) && Number.isFinite(cost) && sellPrice < cost;
}

/** 相对上一期的涨跌幅，用于「价格异动」预警。 */
export function changeRate(previous, current) {
  if (!Number.isFinite(previous) || !Number.isFinite(current) || previous === 0) return null;
  return (current - previous) / previous;
}

/**
 * 价格异动预警：单日波动超过阈值即触发。
 * 返回按幅度排序的告警，幅度大的在前。
 */
export function detectAnomalies(seriesBySku, { threshold = 0.08, lookback = 1 } = {}) {
  const alerts = [];
  for (const sku of seriesBySku) {
    for (const platform of Object.keys(sku.history)) {
      const points = sku.history[platform];
      if (!points || points.length <= lookback) continue;
      const previous = points[points.length - 1 - lookback].price;
      const current = points[points.length - 1].price;
      const rate = changeRate(previous, current);
      if (rate === null) continue;
      if (Math.abs(rate) >= threshold) {
        alerts.push({
          skuId: sku.id,
          name: sku.name,
          platform,
          previous,
          current,
          rate,
          direction: rate < 0 ? 'down' : 'up',
        });
      }
    }
  }
  return alerts.sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate));
}

/** 按尺码汇总库存，用于「断码」提示。 */
export function stockSummary(sizes) {
  const total = sizes.reduce((sum, item) => sum + item.stock, 0);
  const soldOut = sizes.filter((item) => item.stock === 0).length;
  return { total, soldOut, sizeCount: sizes.length, full: soldOut === 0 };
}

// 决策理由里要给出人话数字，所以这里保留最小的格式化能力。
function fmtMoney(value) {
  if (!Number.isFinite(value)) return '—';
  return `¥${Math.round(value).toLocaleString('zh-CN')}`;
}

function fmtPct(value) {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}
