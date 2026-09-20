import http from 'node:http';

import { createHttpHandler } from './app/http.mjs';
import { initStore, loadStore, saveStore } from './app/store.mjs';

export function createServer() {
  const file = process.env.STORE_FILE || 'data/ledger.json';
  const adminId = process.env.ADMIN_ID || 'A1';
  const adminName = process.env.ADMIN_NAME || '系统管理员';

  let data = loadStore(file);
  if (!data) {
    initStore(file, { bootstrapUsers: [{ userId: adminId, name: adminName, role: 'admin', groupIds: [] }] });
    data = loadStore(file);
  }
  const { users, service } = data;

  const persist = () => saveStore(file, { users, service });
  const handler = createHttpHandler(service, { afterCommand: persist });

  return http.createServer(handler);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`服务已启动：http://0.0.0.0:${port}`);
  });
}
