// 日期与结算期工具。结算期采用自然年（YYYY），区间一律左闭右开 [from, to)。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertDate(value, field = '日期') {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new Error(`${field}必须是 YYYY-MM-DD：${value}`);
  }
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new Error(`${field}不是合法日期：${value}`);
  }
  return value;
}

function toUtc(value) {
  const [y, m, d] = value.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

// [a, b) 之间的天数
export function daysBetween(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

export function periodRange(period) {
  if (!/^\d{4}$/.test(String(period))) {
    throw new Error(`结算期必须是四位年份：${period}`);
  }
  return { start: `${period}-01-01`, end: `${Number(period) + 1}-01-01` };
}

export function yearDays(period) {
  return daysBetween(`${period}-01-01`, `${Number(period) + 1}-01-01`);
}

export function periodOf(date) {
  assertDate(date);
  return date.slice(0, 4);
}

// 两个左闭右开区间的重叠天数
export function overlapDays(from, to, rangeFrom, rangeTo) {
  const start = from > rangeFrom ? from : rangeFrom;
  const end = to < rangeTo ? to : rangeTo;
  return end > start ? daysBetween(start, end) : 0;
}
