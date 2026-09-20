import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 隔离持久化文件，避免健康检查在仓库内产生数据目录
process.env.STORE_FILE ??= join(tmpdir(), `linong-health-${process.pid}.json`);
const { createServer } = await import('../src/server.mjs');

test('健康检查返回可用状态', async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});
