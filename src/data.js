/**
 * 行情数据（确定性生成）。
 *
 * 用固定种子的伪随机数，保证每次刷新看到的曲线完全一致 —— 截图、演示、
 * 复查都用同一份数据。真实接入时把 `buildMarket()` 换成接口返回值即可，
 * 上层只依赖它的结构，不依赖它怎么来的。
 */

/** mulberry32：小而稳的确定性 PRNG。 */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATALOG = [
  { id: 'DD1391-100', name: 'Nike Dunk Low 熊猫', brand: 'Nike', cost: 620, base: 780, trend: 0.012, vol: 0.035 },
  { id: 'DZ5485-612', name: 'Air Jordan 1 芝加哥', brand: 'Jordan', cost: 1480, base: 1980, trend: -0.018, vol: 0.05 },
  { id: 'HQ2059-100', name: 'Adidas Samba OG', brand: 'Adidas', cost: 480, base: 690, trend: 0.02, vol: 0.028 },
  { id: 'FZ5046-133', name: 'New Balance 530 银白', brand: 'New Balance', cost: 380, base: 520, trend: 0.006, vol: 0.022 },
  { id: '1203A127-001', name: 'ASICS Gel-Kayano 14', brand: 'ASICS', cost: 720, base: 1150, trend: 0.031, vol: 0.045 },
  { id: 'DV0831-106', name: 'Nike Air Force 1 纯白', brand: 'Nike', cost: 560, base: 640, trend: -0.009, vol: 0.018 },
  { id: 'IF3219-060', name: 'Yeezy Slide 骨白', brand: 'Adidas', cost: 390, base: 610, trend: -0.026, vol: 0.06 },
  { id: 'CW2288-111', name: 'Air Jordan 4 军事黑', brand: 'Jordan', cost: 1750, base: 2260, trend: 0.015, vol: 0.04 },
];

const PLATFORMS = ['KREAM', '得物'];
const DAYS = 30;

/** 平台抽取与扣点（不同平台费率不同，这是比价的核心变量之一）。 */
export const PLATFORM_FEES = Object.freeze({
  KREAM: { feeRate: 0.05, defectRate: 0.02, label: 'KREAM' },
  得物: { feeRate: 0.075, defectRate: 0.025, label: '得物' },
});

export const SIZES = ['40', '41', '42', '43', '44'];

/**
 * 生成行情。返回的每个 SKU 结构：
 *   { id, name, brand, cost, sizes[], history: { KREAM: [{day, price}], 得物: [...] } }
 */
export function buildMarket({ seed = 20261010, days = DAYS } = {}) {
  const random = rng(seed);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return CATALOG.map((item, index) => {
    const platformOffset = 0.02 + random() * 0.05; // 得物通常略高或略低于 KREAM
    const history = {};

    for (const platform of PLATFORMS) {
      const points = [];
      let price = item.base * (platform === '得物' ? 1 - platformOffset : 1);
      for (let step = days - 1; step >= 0; step -= 1) {
        const drift = item.trend / days;
        const shock = (random() - 0.5) * item.vol;
        // 偶尔来一次真实市场里常见的跳价，让「价格异动」预警有东西可报。
        const jump = random() > 0.94 ? (random() - 0.55) * item.vol * 3 : 0;
        price = Math.max(item.cost * 0.82, price * (1 + drift + shock + jump));
        const date = new Date(today);
        date.setDate(date.getDate() - step);
        points.push({
          day: date.toISOString().slice(5, 10),
          date: date.toISOString().slice(0, 10),
          price: Math.round(price),
        });
      }
      history[platform] = points;
    }

    const sizes = SIZES.map((size, sizeIndex) => ({
      size,
      stock: [2, 0, 5, 3, 0, 4, 1][(index + sizeIndex * 3) % 7],
      // 大码通常更贵，这也是真实市场的常态。
      premium: 1 + (sizeIndex - 2) * 0.015,
    }));

    return {
      id: item.id,
      name: item.name,
      brand: item.brand,
      cost: item.cost,
      targetRate: [0.12, 0.18, 0.1, 0.15, 0.2, 0.08, 0.22, 0.16][index],
      listed: [true, true, false, true, true, false, true, true][index],
      sizes,
      history,
    };
  });
}

/** 取某平台的最新报价。 */
export function latestPrice(sku, platform) {
  const points = sku.history[platform];
  return points && points.length ? points[points.length - 1].price : null;
}

/** 取上一期报价，用于计算涨跌。 */
export function previousPrice(sku, platform, lookback = 1) {
  const points = sku.history[platform];
  if (!points || points.length <= lookback) return null;
  return points[points.length - 1 - lookback].price;
}

/** 把 SKU 展开成「某平台某尺码」的可比价单元。 */
export function offersFor(sku) {
  return PLATFORMS.map((platform) => {
    const fees = PLATFORM_FEES[platform];
    const price = latestPrice(sku, platform);
    return {
      platform,
      label: fees.label,
      sellPrice: price,
      cost: sku.cost,
      feeRate: fees.feeRate,
      defectRate: fees.defectRate,
      targetRate: sku.targetRate,
      listed: sku.listed,
    };
  });
}

export { PLATFORMS, CATALOG };
