// 金额一律使用整数“分”，杜绝浮点误差。

/** 元 -> 分 */
export function yuanToFen(yuan) {
  return Math.round(yuan * 100);
}

/** 分 -> 元（仅用于展示） */
export function fenToYuan(fen) {
  return fen / 100;
}

/** 格式化为两位小数字符串，如 1234.56 */
export function formatYuan(fen) {
  const sign = fen < 0 ? '-' : '';
  const abs = Math.abs(fen);
  return `${sign}${(abs / 100).toFixed(2)}`;
}

export function sum(values) {
  return values.reduce((acc, value) => acc + value, 0);
}

/**
 * 按整数权重把一笔总分（不可为负数）分尽，零头按“最大余数法”依次补给，
 * 保证 Σ分配额 === total，不丢一分钱。
 * @returns {number[]} 与 weights 等长的分配额（分）
 */
export function allocate(totalFen, weights) {
  if (!Number.isInteger(totalFen) || totalFen < 0) {
    throw new Error('待分配金额必须是非负整数（分）');
  }
  const totalWeight = weights.reduce((acc, weight) => acc + weight, 0);
  if (totalWeight <= 0) {
    throw new Error('分配权重之和必须大于 0');
  }
  if (weights.length === 0) return [];

  const raw = weights.map((weight) => (totalFen * weight) / totalWeight);
  const floors = raw.map((value) => Math.floor(value));
  let remainder = totalFen - sum(floors);

  const order = raw
    .map((value, index) => ({ index, fraction: value - floors[index] }))
    .sort((a, b) => b.fraction - a.fraction)
    .map((item) => item.index);

  let cursor = 0;
  while (remainder > 0) {
    floors[order[cursor % order.length]] += 1;
    remainder -= 1;
    cursor += 1;
  }
  return floors;
}
