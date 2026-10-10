/**
 * 应用外壳：状态、渲染、事件。
 *
 * 状态只有一个对象，所有交互都走 `update()` 触发重绘。这个规模下引入虚拟 DOM
 * 的复杂度高于收益，一条显式的渲染路径更容易推理，也更容易测试。
 */

import { PriceChart } from './chart.js';
import {
  ACTION,
  ACTION_LABEL,
  bestPlatform,
  breakEvenPrice,
  changeRate,
  decide,
  detectAnomalies,
  netProfit,
  profitRate,
  stockSummary,
  suggestedPrice,
} from './calc.js';
import { PLATFORMS, PLATFORM_FEES, buildMarket, latestPrice, offersFor, previousPrice } from './data.js';

const state = {
  view: 'board',
  skuId: null,
  platform: 'KREAM',
  simulatedPrice: null, // 用户在详情里拖动滑块时的临时售价
  market: [],
  alerts: [],
};

let chart = null;

/* ------------------------------------------------------------- 格式化工具 */

const yuan = (value) =>
  Number.isFinite(value) ? `¥${Math.round(value).toLocaleString('zh-CN')}` : '—';

const pct = (value, digits = 1) =>
  Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '—';

const TONE = { list: 'green', hold: 'blue', reprice: 'blue', delist: 'red' };

/* ------------------------------------------------------------------- 启动 */

export function boot() {
  state.market = buildMarket();
  state.alerts = detectAnomalies(
    state.market.map((sku) => ({ id: sku.id, name: sku.name, history: sku.history })),
    { threshold: 0.07 },
  );
  state.skuId = pickFocusSku();

  const now = new Date();
  document.getElementById('tag-scope').textContent = `监控 ${state.market.length} 个货号`;
  document.getElementById('tag-updated').textContent = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')} 更新`;
  document.getElementById('tag-status').textContent =
    state.alerts.length > 0 ? `${state.alerts.length} 条价格异动` : '行情平稳';
  document.getElementById('tag-status').className = `tag ${state.alerts.length ? 'is-warn' : 'is-live'}`;

  wireTabs();
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('input', onDocumentInput);

  render();
}

/** 默认选中「最值得关注」的货号：优先建议调价/下架的，其次利润率最低的。 */
function pickFocusSku() {
  const ranked = state.market
    .map((sku) => {
      const offers = offersFor(sku);
      const best = bestPlatform(offers);
      const decision = decideFor(sku, offers);
      const urgency = { delist: 0, reprice: 1, list: 2, hold: 3 }[decision.action] ?? 4;
      return { sku, urgency, rate: best?.rate ?? 0 };
    })
    .sort((a, b) => a.urgency - b.urgency || a.rate - b.rate);
  return ranked[0]?.sku.id ?? null;
}

/** 对某个货号跑一遍两个平台的决策，返回更紧急的那个。 */
function decideFor(sku, offers = offersFor(sku)) {
  const results = offers.map((offer) => {
    const competitor = competitorPriceFor(sku, offer.platform);
    return {
      platform: offer.platform,
      offer,
      competitor,
      decision: decide({
        cost: offer.cost,
        feeRate: offer.feeRate,
        defectRate: offer.defectRate,
        targetRate: offer.targetRate,
        myPrice: offer.sellPrice,
        competitorPrice: competitor,
        listed: offer.listed,
      }),
    };
  });
  const priority = { delist: 0, reprice: 1, list: 2, hold: 3 };
  return results.sort((a, b) => priority[a.decision.action] - priority[b.decision.action])[0];
}

/** 竞品价取另一个平台在同一天的报价 —— 这就是「跨平台比价」。 */
function competitorPriceFor(sku, platform) {
  const other = PLATFORMS.find((item) => item !== platform);
  return other ? latestPrice(sku, other) : null;
}

function currentSku() {
  return state.market.find((sku) => sku.id === state.skuId) ?? state.market[0];
}

/* ------------------------------------------------------------------ 渲染 */

function update(patch = {}) {
  Object.assign(state, patch);
  render();
}

function render() {
  const view = document.getElementById('view');
  view.innerHTML = state.view === 'alerts' ? renderAlerts() : renderBoard();
  syncTabs();
  if (state.view === 'board') mountChart();
}

function syncTabs() {
  document.querySelectorAll('#tabs button').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.view === state.view));
  });
  movePill();
}

function movePill() {
  const tabs = document.getElementById('tabs');
  const active = tabs.querySelector('button[aria-selected="true"]');
  const pill = tabs.querySelector('.pill');
  if (!active || !pill) return;
  pill.style.width = `${active.offsetWidth}px`;
  pill.style.transform = `translateX(${active.offsetLeft - 3}px)`;
}

/* ------------------------------------------------------------- 看板视图 */

function renderBoard() {
  const summary = summarise();
  const sku = currentSku();

  return `
    <div class="grid kpis">
      ${kpiCard('监控货号', String(summary.total), `覆盖 ${PLATFORMS.join(' / ')} 两个平台`, 'blue', 1)}
      ${kpiCard('平均利润率', pct(summary.avgRate), `按最优平台核算`, summary.avgRate >= 0.12 ? 'green' : 'orange', Math.min(1, summary.avgRate / 0.3))}
      ${kpiCard('建议调价', String(summary.reprice), '竞品降价且跟价后仍达标', 'blue', summary.reprice / Math.max(1, summary.total))}
      ${kpiCard('建议下架', String(summary.delist), '利润不足或价格倒挂', 'red', summary.delist / Math.max(1, summary.total))}
    </div>

    <div class="grid split">
      <div class="grid">
        <section class="card lift animate">
          <div class="card-head">
            <div>
              <h2 id="chart-title">${escapeHtml(sku.name)}</h2>
              <div class="sub">${escapeHtml(sku.id)} · 近 30 天成交价走势</div>
            </div>
            <div class="segmented" id="platform-tabs" role="group" aria-label="平台切换">
              ${PLATFORMS.map(
                (name) =>
                  `<button data-platform="${name}" aria-selected="${state.platform === name}">${name}</button>`,
              ).join('')}
            </div>
          </div>
          <div class="chart-wrap"><canvas id="chart" role="img" aria-label="价格走势图"></canvas></div>
          <div class="legend">${renderLegend(sku)}</div>
        </section>

        <section class="card animate">
          <div class="card-head">
            <div>
              <h2>货号比价与决策</h2>
              <div class="sub">点击任意行查看利润拆解</div>
            </div>
          </div>
          <div class="sku-list">${state.market.map(renderSkuRow).join('')}</div>
        </section>
      </div>

      <div class="detail-stack">${renderDetail(sku)}</div>
    </div>
  `;
}

function kpiCard(label, value, foot, tone, ratio) {
  const width = Math.max(4, Math.min(100, (Number.isFinite(ratio) ? ratio : 0) * 100));
  return `
    <div class="card kpi lift animate">
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-value tone-${tone}">${escapeHtml(value)}</div>
      <div class="kpi-foot">${escapeHtml(foot)}</div>
      <div class="kpi-spark"><i class="bar-${tone}" style="width:${width.toFixed(1)}%"></i></div>
    </div>`;
}

function renderLegend(sku) {
  return PLATFORMS.map((platform) => {
    const price = latestPrice(sku, platform);
    const previous = previousPrice(sku, platform);
    const rate = changeRate(previous, price);
    const arrow = rate === null ? '' : rate >= 0 ? '▲' : '▼';
    const cls = rate === null ? '' : rate >= 0 ? 'delta-up' : 'delta-down';
    const color = platform === 'KREAM' ? 'var(--blue)' : 'var(--pink)';
    return `<span>
      <i style="background:${color}"></i>${platform}
      <b>${yuan(price)}</b>
      <span class="${cls}">${arrow} ${rate === null ? '' : pct(Math.abs(rate))}</span>
    </span>`;
  }).join('');
}

function renderSkuRow(sku) {
  const offers = offersFor(sku);
  const best = bestPlatform(offers);
  const { decision, platform } = decideFor(sku, offers);
  const previous = previousPrice(sku, platform);
  const price = latestPrice(sku, platform);
  const rate = changeRate(previous, price);
  const other = PLATFORMS.find((item) => item !== platform);
  const otherPrice = latestPrice(sku, other);
  const stock = stockSummary(sku.sizes);

  return `
    <button class="sku-row" data-sku="${escapeHtml(sku.id)}" aria-selected="${sku.id === state.skuId}">
      <span>
        <span class="sku-name">${escapeHtml(sku.name)}</span>
        <span class="sku-id">${escapeHtml(sku.id)}${stock.full ? '' : ' · 断码 ' + stock.soldOut + ' 个尺码'}</span>
      </span>
      <span class="col-num col-platform">
        ${price === null ? '—' : yuan(price)}
        <small>${platform}</small>
      </span>
      <span class="col-num col-platform">
        ${otherPrice === null ? '—' : yuan(otherPrice)}
        <small>${escapeHtml(other)}</small>
      </span>
      <span class="col-num">
        ${pct(best?.rate)}
        <small>最优利润</small>
      </span>
      <span class="badge badge-${decision.action}">${ACTION_LABEL[decision.action]}</span>
    </button>`;
}

/* ------------------------------------------------------------- 详情面板 */

function renderDetail(sku) {
  const offers = offersFor(sku);
  const active = offers.find((offer) => offer.platform === state.platform) ?? offers[0];
  const price = state.simulatedPrice ?? active.sellPrice;
  const competitor = competitorPriceFor(sku, active.platform);

  const profit = netProfit({
    sellPrice: price,
    cost: sku.cost,
    feeRate: active.feeRate,
    defectRate: active.defectRate,
  });
  const rate = profitRate({
    sellPrice: price,
    cost: sku.cost,
    feeRate: active.feeRate,
    defectRate: active.defectRate,
  });
  const decision = decide({
    cost: sku.cost,
    feeRate: active.feeRate,
    defectRate: active.defectRate,
    targetRate: sku.targetRate,
    myPrice: price,
    competitorPrice: competitor,
    listed: sku.listed,
  });

  const suggested = suggestedPrice({
    cost: sku.cost,
    feeRate: active.feeRate,
    defectRate: active.defectRate,
    targetRate: sku.targetRate,
  });
  const floor = breakEvenPrice({ cost: sku.cost, feeRate: active.feeRate, defectRate: active.defectRate });

  const min = Math.round(Math.min(sku.cost * 0.85, floor * 0.9));
  const max = Math.round(Math.max(price * 1.25, suggested * 1.1));

  return `
    <section class="card lift animate">
      <div class="card-head">
        <div>
          <h2>利润拆解</h2>
          <div class="sub">${escapeHtml(active.platform)} · 费率 ${pct(active.feeRate)} · 瑕疵损耗 ${pct(active.defectRate)}</div>
        </div>
      </div>

      <dl style="margin:0">
        <div class="field"><dt>成本价</dt><dd>${yuan(sku.cost)}</dd></div>
        <div class="field"><dt>当前售价</dt><dd>${yuan(price)}</dd></div>
        <div class="field"><dt>竞品报价</dt><dd>${yuan(competitor)}</dd></div>
        <div class="field"><dt>平台抽成后</dt><dd>${yuan(price * (1 - active.feeRate))}</dd></div>
        <div class="field"><dt>瑕疵损耗后</dt><dd>${yuan(price * (1 - active.feeRate) * (1 - active.defectRate))}</dd></div>
        <div class="field"><dt>单件毛利</dt><dd class="${profit >= 0 ? 'tone-green' : 'tone-red'}">${yuan(profit)}</dd></div>
        <div class="field"><dt>利润率</dt><dd class="${rate !== null && rate >= sku.targetRate ? 'tone-green' : 'tone-orange'}">${pct(rate)}</dd></div>
        <div class="field"><dt>目标利润率</dt><dd>${pct(sku.targetRate)}</dd></div>
        <div class="field"><dt>保本价</dt><dd>${yuan(floor)}</dd></div>
      </dl>

      <div style="margin-top:var(--s4)">
        <div class="control-row">
          <span>模拟售价</span>
          <b id="sim-price">${yuan(price)}</b>
        </div>
        <input
          type="range"
          id="price-slider"
          min="${min}"
          max="${max}"
          step="10"
          value="${Math.round(price)}"
          aria-label="模拟售价"
        />
        <div class="control-row">
          <span>${yuan(min)}</span>
          <span>达标售价 ${yuan(suggested)}</span>
          <span>${yuan(max)}</span>
        </div>
      </div>
    </section>

    <section class="card lift animate">
      <div class="card-head">
        <div>
          <h2>自动决策</h2>
          <div class="sub">按目标利润率 ${pct(sku.targetRate)} 判定</div>
        </div>
        <span class="badge badge-${decision.action}">${ACTION_LABEL[decision.action]}</span>
      </div>

      <div class="decision ${decision.action}">
        ${
          decision.price !== null
            ? `<div class="decision-price">${yuan(decision.price)}</div>
               <div class="sub">建议调价至该售价</div>`
            : ''
        }
        <p class="decision-reason">${escapeHtml(decision.reason)}</p>
      </div>

      ${
        state.simulatedPrice !== null
          ? `<div style="margin-top:var(--s3)">
               <button class="badge badge-hold" id="reset-price" style="cursor:pointer">恢复实际报价</button>
             </div>`
          : ''
      }
    </section>

    <section class="card lift animate">
      <div class="card-head">
        <div>
          <h2>库存与尺码</h2>
          <div class="sub">共 ${stockSummary(sku.sizes).total} 件 · ${stockSummary(sku.sizes).sizeCount} 个尺码</div>
        </div>
      </div>
      <div class="sku-list">
        ${sku.sizes
          .map(
            (size) => `
          <div class="sku-row" style="cursor:default;grid-template-columns:1fr auto">
            <span class="sku-name">尺码 ${escapeHtml(size.size)}</span>
            <span class="col-num ${size.stock === 0 ? 'tone-red' : ''}">
              ${size.stock === 0 ? '断码' : `${size.stock} 件`}
              <small>${yuan(latestPrice(sku, active.platform) * size.premium)}</small>
            </span>
          </div>`,
          )
          .join('')}
      </div>
    </section>
  `;
}

/* ------------------------------------------------------------- 预警视图 */

function renderAlerts() {
  const alerts = state.alerts;
  return `
    <section class="card animate">
      <div class="card-head">
        <div>
          <h2>价格异动预警</h2>
          <div class="sub">单日波动超过 7% 即触发，按幅度排序</div>
        </div>
        <span class="tag ${alerts.length ? 'is-warn' : 'is-live'}">${alerts.length} 条</span>
      </div>

      ${
        alerts.length
          ? `<div class="sku-list">
              ${alerts
                .map((alert) => {
                  const sku = state.market.find((item) => item.id === alert.skuId);
                  const offers = sku ? offersFor(sku) : [];
                  const best = bestPlatform(offers);
                  const decision = sku ? decideFor(sku, offers).decision : null;
                  return `
                    <div class="alert-row ${alert.direction}">
                      <span>
                        <span class="sku-name">${escapeHtml(alert.name)}</span>
                        <span class="sku-id">${escapeHtml(alert.platform)} · ${escapeHtml(sku?.id ?? '')}</span>
                      </span>
                      <span class="col-num">
                        ${yuan(alert.previous)} → ${yuan(alert.current)}
                        <small class="${alert.direction === 'down' ? 'delta-down' : 'delta-up'}">
                          ${alert.direction === 'down' ? '▼' : '▲'} ${pct(Math.abs(alert.rate))}
                        </small>
                      </span>
                      <span class="col-num">
                        ${pct(best?.rate)}
                        <small>最优利润</small>
                      </span>
                      ${
                        decision
                          ? `<span class="badge badge-${decision.action}">${ACTION_LABEL[decision.action]}</span>`
                          : ''
                      }
                    </div>`;
                })
                .join('')}
            </div>`
          : `<div class="empty"><strong>暂无价格异动</strong><span>所有货号单日波动均在 7% 以内</span></div>`
      }
    </section>

    <section class="card animate" style="margin-top:var(--s4)">
      <div class="card-head">
        <div>
          <h2>监控口径</h2>
          <div class="sub">预警规则与数据来源</div>
        </div>
      </div>
      <dl style="margin:0">
        ${PLATFORMS.map((platform) => {
          const fees = PLATFORM_FEES[platform];
          return `<div class="field">
            <dt>${platform}</dt>
            <dd>费率 ${pct(fees.feeRate)} · 瑕疵损耗 ${pct(fees.defectRate)}</dd>
          </div>`;
        }).join('')}
        <div class="field"><dt>数据频率</dt><dd>每日一次</dd></div>
        <div class="field"><dt>异动阈值</dt><dd>单日 ±7%</dd></div>
        <div class="field"><dt>决策口径</dt><dd>扣费后毛利 / 成本</dd></div>
      </dl>
    </section>`;
}

/* ---------------------------------------------------------------- 汇总 */

function summarise() {
  let rateSum = 0;
  let counted = 0;
  let reprice = 0;
  let delist = 0;

  for (const sku of state.market) {
    const offers = offersFor(sku);
    const best = bestPlatform(offers);
    if (best?.rate !== null && best?.rate !== undefined) {
      rateSum += best.rate;
      counted += 1;
    }
    const action = decideFor(sku, offers).decision.action;
    if (action === ACTION.REPRICE) reprice += 1;
    if (action === ACTION.DELIST) delist += 1;
  }

  return {
    total: state.market.length,
    avgRate: counted ? rateSum / counted : 0,
    reprice,
    delist,
  };
}

/* ------------------------------------------------------------------ 图表 */

function mountChart() {
  const canvas = document.getElementById('chart');
  if (!canvas) return;
  const sku = currentSku();
  const series = PLATFORMS.map((platform) => ({
    name: platform,
    points: sku.history[platform].map((point) => ({ label: point.day, value: point.price })),
  }));

  if (!chart || chart.canvas !== canvas) {
    chart?.destroy();
    chart = new PriceChart(canvas);
  }
  chart.setData(series);
}

/* ------------------------------------------------------------------ 事件 */

function wireTabs() {
  document.getElementById('tabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (button) update({ view: button.dataset.view });
  });
}

function onDocumentClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const skuButton = target.closest('[data-sku]');
  if (skuButton) {
    update({ skuId: skuButton.dataset.sku, simulatedPrice: null });
    return;
  }

  const platformButton = target.closest('[data-platform]');
  if (platformButton) {
    update({ platform: platformButton.dataset.platform, simulatedPrice: null });
    return;
  }

  if (target.closest('#reset-price')) {
    update({ simulatedPrice: null });
  }
}

function onDocumentInput(event) {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.id === 'price-slider') {
    const value = Number(target.value);
    state.simulatedPrice = value;
    // 只更新受影响的数字，不重绘整页 —— 否则拖动时输入框会失焦。
    const readout = document.getElementById('sim-price');
    if (readout) readout.textContent = yuan(value);
    refreshDecisionPanel();
  }
}

/** 拖动滑块时热更新「利润拆解 + 决策」两块，保持输入焦点。 */
function refreshDecisionPanel() {
  const sku = currentSku();
  const stack = document.querySelector('.detail-stack');
  if (!stack) return;
  stack.innerHTML = renderDetail(sku);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 窗口尺寸变化时，分段控件的滑块位置需要重算。
window.addEventListener('resize', () => movePill());
