import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer as httpCreate } from 'node:http';

import { createAccessPolicy } from '../src/domain/access.mjs';
import { ROLE, SOURCE } from '../src/domain/catalog.mjs';
import { createRegistry } from '../src/domain/registry.mjs';
import { createAppService } from '../src/app/service.mjs';
import { createHttpHandler } from '../src/app/http.mjs';

function boot() {
  const registry = createRegistry();
  const policy = createAccessPolicy([
    { userId: 'A1', name: '管理员', role: ROLE.ADMIN, groupIds: [] },
    { userId: 'M1', name: '一组经办', role: ROLE.MANAGER, groupIds: ['G1'] },
  ]);
  const service = createAppService({ registry, policy });
  const handler = createHttpHandler(service);
  return { handler, service };
}

async function withServer(handler, run) {
  const server = httpCreate(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// 用 node:http 起临时服务

test('HTTP API：建账、计提、支付、回放、越权拦截', async () => {
  const { handler } = boot();
  await withServer(handler, async (base) => {
    const command = (user, action, params) =>
      fetch(`${base}/api/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': user },
        body: JSON.stringify({ action, params }),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));

    // 未登录被拒
    const denied = await fetch(`${base}/api/balance`);
    assert.equal(denied.status, 401);

    // 主数据
    const groupR = await command('A1', 'addGroup', { groupId: 'G1', name: '青山村一组' });
    assert.equal(groupR.status, 200, JSON.stringify(groupR.body));
    await command('A1', 'addProject', { projectId: 'P1', name: '碳汇项目', sources: [SOURCE.RENT, SOURCE.ECO_REWARD] });
    await command('A1', 'addHousehold', { householdId: 'H1', groupId: 'G1', headName: '张三' });
    await command('A1', 'addParcel', { parcelId: 'L1', projectId: 'P1', areaMu: '1000', annualRentCentsPerMu: 10000 });
    await command('A1', 'grantShare', { parcelId: 'L1', householdId: 'H1', shareBasis: 10000, from: '2026-01-01' });

    // manager 不能做主数据维护
    const forbidden = await command('M1', 'addGroup', { groupId: 'GX', name: '越权组' });
    assert.equal(forbidden.status, 403);

    // 年度流水
    assert.equal((await command('A1', 'receivePayment', { projectId: 'P1', batchId: 'B1', amountCents: 200000000, date: '2026-01-15' })).status, 200);
    assert.equal((await command('A1', 'accrueAnnual', { period: '2026', date: '2026-02-01' })).status, 200);
    assert.equal((await command('M1', 'payHousehold', { householdId: 'H1', date: '2026-03-01' })).status, 200);

    // 总账
    const balance = await fetch(`${base}/api/balance`, { headers: { 'x-user-id': 'A1' } }).then((r) => r.json());
    assert.equal(balance.payableCents, 0);
    assert.equal(balance.verification.ok, true);

    // 回放单
    const statement = await fetch(`${base}/api/households/H1/statement`, { headers: { 'x-user-id': 'M1' } }).then((r) => r.json());
    assert.equal(statement.household.householdId, 'H1');
    assert.ok(/^[0-9a-f]{64}$/.test(statement.verification.statementFingerprint));

    // 链路核验
    const verify = await fetch(`${base}/api/verify`, { headers: { 'x-user-id': 'A1' } }).then((r) => r.json());
    assert.equal(verify.ok, true);
  });
});
