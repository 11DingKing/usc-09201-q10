// 金额、面积一律用整数定点数，杜绝浮点误差。
// 金额单位：分（1 元 = 100 分）；面积单位：毫亩（1 亩 = 1000 毫亩，保留三位小数）。

export function yuanToCents(value, field = '金额') {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${field}不是合法数字`);
    value = String(value);
  }
  if (typeof value !== 'string') {
    throw new Error(`${field}必须是数字或字符串`);
  }
  const text = value.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) {
    throw new Error(`${field}最多保留两位小数：${value}`);
  }
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const cents = Number(BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2)));
  return negative ? -cents : cents;
}

export function centsToYuan(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}

// 面积字符串（亩，最多三位小数）转整数毫亩
export function muToHao(value, field = '面积') {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${field}不是合法数字`);
    value = String(value);
  }
  if (typeof value !== 'string' || !/^\d+(\.\d{1,3})?$/.test(value.trim())) {
    throw new Error(`${field}必须是非负数字，最多三位小数：${value}`);
  }
  const [whole, fraction = ''] = value.trim().split('.');
  return Number(BigInt(whole) * 1000n + BigInt((fraction + '000').slice(0, 3)));
}

export function haoToMu(hao) {
  const whole = Math.floor(hao / 1000);
  const frac = String(hao % 1000).padStart(3, '0');
  return `${whole}.${frac}`;
}

// 四舍五入（半数入）
export function roundHalfUp(value) {
  return Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
}

// 最大余数法：把整数总额 total 按整数权重 weights 精确分摊，
// 分摊结果之和恒等于 total（零权重不分摊）。
// 权重可以是 number 或 bigint（面积·份额·天权重可能超出安全整数范围）。
export function largestRemainder(weights, total) {
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new Error('权重不能为空');
  }
  const isInt = (v) => (typeof v === 'bigint' || typeof v === 'number') && (typeof v === 'bigint' || Number.isInteger(v));
  for (const w of weights) {
    if (!isInt(w) || w < 0) throw new Error('权重必须是非负整数');
  }
  if (!Number.isInteger(total) || total < 0) {
    throw new Error('分摊总额必须是非负整数（分）');
  }
  const W = weights.map((w) => BigInt(w));
  const T = BigInt(total);
  const weightSum = W.reduce((sum, w) => sum + w, 0n);
  if (weightSum === 0n) {
    return weights.map(() => 0);
  }
  const quotas = W.map((w) => ({ base: Number((T * w) / weightSum), frac: (T * w) % weightSum }));
  let remainder = total - quotas.reduce((sum, q) => sum + q.base, 0);
  // 按小数部分从大到小补发 1 分；并列时按权重下标稳定排序
  const order = quotas
    .map((q, i) => ({ ...q, index: i }))
    .sort((a, b) => (a.frac < b.frac ? 1 : a.frac > b.frac ? -1 : a.index - b.index));
  for (const item of order) {
    if (remainder <= 0) break;
    if (weights[item.index] > 0) {
      quotas[item.index].base += 1;
      remainder -= 1;
    }
  }
  return quotas.map((q) => q.base);
}

// BigInt 版四舍五入（半数入）：value / denom
export function divideHalfUp(value, denom) {
  const V = BigInt(value);
  const D = BigInt(denom);
  const q = V / D;
  const r = V % D;
  const up = r * 2n >= D;
  return Number(q) + (up ? 1 : 0);
}
