// 简易确定性标识：基于序列与内容哈希，无需外部随机源，重放结果稳定。
import { sha256Hex } from './hash.mjs';

export function createIdGenerator(prefix = 'ID') {
  let seq = 0;
  return (salt = '') => {
    seq += 1;
    return `${prefix}-${String(seq).padStart(6, '0')}-${sha256Hex(`${seq}:${salt}`).slice(0, 8)}`;
  };
}
