// 日期统一用 UTC “日序号”（自纪元起的天数）表示，规避时区与夏令时问题。

/** 'YYYY-MM-DD' -> 日序号 */
export function dayOf(text) {
  const [year, month, date] = text.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, date) / 86_400_000);
}

/** 日序号 -> 'YYYY-MM-DD' */
export function dayText(day) {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** 结算期（自然年）-> 半开区间 [起, 止) */
export function periodRange(period) {
  const year = Number(period);
  return [dayOf(`${year}-01-01`), dayOf(`${year + 1}-01-01`)];
}

/** 由记账日推断其所属结算期 */
export function periodOfDay(day) {
  return String(new Date(day * 86_400_000).getUTCFullYear());
}

/** 两个半开区间的交集，无交集返回 null */
export function overlap([fromA, toA], [fromB, toB]) {
  const from = Math.max(fromA, fromB);
  const to = Math.min(toA, toB);
  return to > from ? [from, to] : null;
}

export function days(from, to) {
  return to - from;
}
