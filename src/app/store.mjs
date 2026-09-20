// 本地 JSON 持久化：登记台账、分录账与用户清单整体落盘。
// 分录账只追加，启动时通过哈希链重放校验；任何文件被篡改都会拒绝启动。

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

import { createAccessPolicy } from '../domain/access.mjs';
import { loadJournal } from '../domain/journal.mjs';
import { loadRegistry } from '../domain/registry.mjs';
import { createAppService } from './service.mjs';

export function loadStore(file) {
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const registry = loadRegistry(raw.registry);
  const journal = loadJournal(raw.journal);
  const policy = createAccessPolicy(raw.users ?? []);
  return { users: raw.users ?? [], service: createAppService({ registry, journal, policy }) };
}

// 原子写：先写临时文件再改名，避免写一半损坏账册
export function saveStore(file, { users, service }) {
  mkdirSync(dirname(file), { recursive: true });
  const payload = {
    version: 1,
    users,
    registry: service.registry.snapshot(),
    journal: service.ledger.journal.snapshot(),
  };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  renameSync(tmp, file);
}

// 首次启动：空账册 + 初始管理员
export function initStore(file, { bootstrapUsers = [] }) {
  const data = {
    version: 1,
    users: bootstrapUsers,
    registry: { version: 1, groups: [], projects: [], households: [], parcels: [] },
    journal: { version: 1, entries: [] },
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return data;
}
