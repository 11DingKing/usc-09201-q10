import { createHash } from 'node:crypto';

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// 规范序列化：对象键排序后输出，保证同内容哈希一致。
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
