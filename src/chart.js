/**
 * 图表：纯 Canvas 手绘折线图，零依赖。
 *
 * 为什么不用图表库：一是这个看板要保持「零依赖、双击即开」，二是 Apple 风格的
 * 曲线需要非常具体的控制（平滑度、渐变、留白、动画节奏），库的默认样式反而要
 * 花更多代码去覆盖。
 *
 * 关键实现点：
 *   - 按 devicePixelRatio 放大画布，避免高分屏发虚
 *   - Catmull-Rom 转贝塞尔，得到不过冲的平滑曲线
 *   - 悬停显示十字准星与数值气泡
 *   - 进入时按进度重绘，形成曲线生长的动画
 */

const PALETTE = {
  KREAM: { line: '#0A84FF', fill: 'rgba(10,132,255,0.22)' },
  得物: { line: '#FF375F', fill: 'rgba(255,55,95,0.18)' },
};

export class PriceChart {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.series = [];
    this.hoverIndex = null;
    this.progress = 0;
    this.animation = null;
    this.options = {
      padding: { top: 18, right: 16, bottom: 26, left: 46 },
      gridLines: 4,
      ...options,
    };

    this._onMove = this._handleMove.bind(this);
    this._onLeave = this._handleLeave.bind(this);
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerleave', this._onLeave);

    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(canvas.parentElement ?? canvas);
  }

  destroy() {
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerleave', this._onLeave);
    this._resizeObserver?.disconnect();
    cancelAnimationFrame(this.animation);
  }

  /** series: [{ name, color?, points: [{label, value}] }] */
  setData(series) {
    this.series = series.map((item) => ({
      ...item,
      color: item.color ?? PALETTE[item.name] ?? { line: '#0A84FF', fill: 'rgba(10,132,255,0.2)' },
    }));
    this.hoverIndex = null;
    this.resize();
    this._animate();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * ratio);
    this.canvas.height = Math.round(rect.height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.draw();
  }

  _animate() {
    cancelAnimationFrame(this.animation);
    const start = performance.now();
    const duration = 620;
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      // 缓出曲线，收尾平稳，避免机械的线性位移。
      this.progress = 1 - (1 - t) ** 3;
      this.draw();
      if (t < 1) this.animation = requestAnimationFrame(step);
    };
    this.animation = requestAnimationFrame(step);
  }

  /* ------------------------------------------------------------ 坐标换算 */

  get _bounds() {
    const values = this.series.flatMap((item) => item.points.map((point) => point.value));
    if (!values.length) return null;
    let min = Math.min(...values);
    let max = Math.max(...values);
    const span = max - min || max * 0.1 || 1;
    // 上下各留 8% 呼吸空间，曲线不贴边。
    min -= span * 0.08;
    max += span * 0.08;
    const count = this.series[0]?.points.length ?? 0;
    return { min, max, span: max - min, count };
  }

  _x(index, count) {
    const { padding } = this.options;
    const usable = this.width - padding.left - padding.right;
    if (count <= 1) return padding.left + usable / 2;
    return padding.left + (usable * index) / (count - 1);
  }

  _y(value, bounds) {
    const { padding } = this.options;
    const usable = this.height - padding.top - padding.bottom;
    const ratio = (value - bounds.min) / bounds.span;
    return padding.top + usable * (1 - ratio);
  }

  /* ---------------------------------------------------------------- 绘制 */

  draw() {
    const ctx = this.ctx;
    if (!this.width || !this.height || !this.series.length) return;
    const bounds = this._bounds;
    if (!bounds) return;

    ctx.clearRect(0, 0, this.width, this.height);
    this._drawGrid(bounds);
    for (const item of this.series) this._drawSeries(item, bounds);
    this._drawHover(bounds);
  }

  _drawGrid(bounds) {
    const ctx = this.ctx;
    const { padding, gridLines } = this.options;
    ctx.save();
    ctx.strokeStyle = 'rgba(120,140,180,0.14)';
    ctx.lineWidth = 1;
    ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
    ctx.fillStyle = 'rgba(150,168,196,0.75)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= gridLines; i += 1) {
      const ratio = i / gridLines;
      const value = bounds.max - bounds.span * ratio;
      const y = Math.round(padding.top + (this.height - padding.top - padding.bottom) * ratio) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(this.width - padding.right, y);
      ctx.stroke();
      ctx.fillText(`¥${Math.round(value).toLocaleString('zh-CN')}`, padding.left - 8, y);
    }

    // 横轴只标首、中、尾，避免密集文字噪声。
    const points = this.series[0].points;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    [0, Math.floor(points.length / 2), points.length - 1].forEach((index) => {
      const x = this._x(index, points.length);
      ctx.fillText(points[index].label, x, this.height - padding.bottom + 8);
    });
    ctx.restore();
  }

  _drawSeries(item, bounds) {
    const ctx = this.ctx;
    const count = item.points.length;
    const visible = Math.max(1, Math.floor(count * this.progress));
    const palette = item.color;
    const coords = item.points.map((point, index) => ({
      x: this._x(index, count),
      y: this._y(point.value, bounds),
      point,
    }));

    const shown = coords.slice(0, visible);
    if (shown.length < 2) return;

    ctx.save();

    // 渐变填充：从曲线向下淡出，营造层次而不喧宾夺主。
    const gradient = ctx.createLinearGradient(0, this.options.padding.top, 0, this.height - this.options.padding.bottom);
    gradient.addColorStop(0, palette.fill);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.moveTo(shown[0].x, this.height - this.options.padding.bottom);
    this._tracePath(shown);
    ctx.lineTo(shown[shown.length - 1].x, this.height - this.options.padding.bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // 曲线本体。
    ctx.beginPath();
    this._tracePath(shown);
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = palette.line;
    ctx.shadowColor = palette.line;
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 动画走完后补上末端锚点，静止状态有个明确的“现在”。
    if (this.progress >= 1) {
      const last = shown[shown.length - 1];
      ctx.beginPath();
      ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = palette.line;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(last.x, last.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = palette.fill;
      ctx.fill();
    }
    ctx.restore();
  }

  /** Catmull-Rom 转三次贝塞尔，平滑但不过冲。 */
  _tracePath(coords) {
    const ctx = this.ctx;
    ctx.moveTo(coords[0].x, coords[0].y);
    for (let i = 0; i < coords.length - 1; i += 1) {
      const p0 = coords[i - 1] ?? coords[i];
      const p1 = coords[i];
      const p2 = coords[i + 1];
      const p3 = coords[i + 2] ?? p2;
      const tension = 0.18;
      ctx.bezierCurveTo(
        p1.x + (p2.x - p0.x) * tension,
        p1.y + (p2.y - p0.y) * tension,
        p2.x - (p3.x - p1.x) * tension,
        p2.y - (p3.y - p1.y) * tension,
        p2.x,
        p2.y,
      );
    }
  }

  _drawHover(bounds) {
    if (this.hoverIndex === null) return;
    const ctx = this.ctx;
    const { padding } = this.options;
    const count = this.series[0].points.length;
    const x = this._x(this.hoverIndex, count);

    ctx.save();
    ctx.strokeStyle = 'rgba(160,180,210,0.35)';
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, this.height - padding.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const item of this.series) {
      const point = item.points[this.hoverIndex];
      if (!point) continue;
      const y = this._y(point.value, bounds);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = item.color.line;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(10,14,22,0.9)';
      ctx.stroke();
    }
    ctx.restore();

    this._drawTooltip(x, this.hoverIndex);
  }

  _drawTooltip(x, index) {
    const ctx = this.ctx;
    const rows = this.series.map((item) => ({
      label: item.name,
      value: item.points[index]?.value ?? null,
      color: item.color.line,
    })).filter((row) => row.value !== null);
    if (!rows.length) return;

    const day = this.series[0].points[index]?.label ?? '';
    const width = 132;
    const height = 26 + rows.length * 18;
    const left = Math.min(Math.max(x - width / 2, 6), this.width - width - 6);
    const top = 10;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = 'rgba(22,28,40,0.92)';
    this._roundRect(left, top, width, height, 12);
    ctx.fill();
    ctx.shadowColor = 'transparent';

    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    this._roundRect(left + 0.5, top + 0.5, width - 1, height - 1, 12);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
    ctx.fillStyle = 'rgba(160,178,204,0.95)';
    ctx.fillText(day, left + 12, top + 14);

    rows.forEach((row, order) => {
      const y = top + 32 + order * 18;
      ctx.beginPath();
      ctx.arc(left + 15, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = row.color;
      ctx.fill();
      ctx.fillStyle = 'rgba(220,232,248,0.92)';
      ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
      ctx.fillText(row.label, left + 25, y);
      ctx.textAlign = 'right';
      ctx.font = '600 12px ui-monospace, "SF Mono", monospace';
      ctx.fillStyle = '#F2F6FF';
      ctx.fillText(`¥${row.value.toLocaleString('zh-CN')}`, left + width - 12, y);
      ctx.textAlign = 'left';
    });
    ctx.restore();
  }

  _roundRect(x, y, width, height, radius) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
  }

  /* -------------------------------------------------------------- 交互 */

  _handleMove(event) {
    const bounds = this._bounds;
    if (!bounds) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const { padding } = this.options;
    const usable = this.width - padding.left - padding.right;
    const ratio = (x - padding.left) / usable;
    const index = Math.round(ratio * (bounds.count - 1));
    const clamped = Math.max(0, Math.min(bounds.count - 1, index));
    if (clamped !== this.hoverIndex) {
      this.hoverIndex = clamped;
      this.draw();
    }
  }

  _handleLeave() {
    if (this.hoverIndex !== null) {
      this.hoverIndex = null;
      this.draw();
    }
  }
}
