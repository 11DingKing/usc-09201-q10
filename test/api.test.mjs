import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.mjs';
import { createDemoContext } from '../src/service.mjs';

async function start(context) {
  const server = createServer(context);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

test('健康检查', async (context) => {
  const demo = createDemoContext();
  const { server, port } = await start(demo);
  context.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('经管可列出全部户，村组只见本组', async (context) => {
  const demo = createDemoContext();
  const { server, port } = await start(demo);
  context.after(() => server.close());

  const admin = await fetch(`http://127.0.0.1:${port}/households?viewer=admin`).then((response) => response.json());
  assert.deepEqual(admin.households.map((item) => item.id).sort(), ['H01', 'H02', 'H03']);

  const group = await fetch(`http://127.0.0.1:${port}/households?viewer=group:G1`).then((response) => response.json());
  assert.deepEqual(group.households.map((item) => item.id).sort(), ['H01', 'H03']);
});

test('按户回放 JSON 含逐笔分录、对账结论与哈希链', async (context) => {
  const demo = createDemoContext();
  const { server, port } = await start(demo);
  context.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/households/H01/statement?viewer=admin`);
  assert.equal(response.status, 200);
  const statement = await response.json();
  assert.equal(statement.household.id, 'H01');
  assert.ok(statement.entries.length > 0);
  assert.equal(statement.reconciliation.identityHolds, true);
  assert.equal(statement.chain.ok, true);
});

test('越权访问被拒：外组不能看 H02；缺少 viewer 也拒绝', async (context) => {
  const demo = createDemoContext();
  const { server, port } = await start(demo);
  context.after(() => server.close());

  const forbidden = await fetch(`http://127.0.0.1:${port}/households/H02/statement?viewer=group:G1`);
  assert.equal(forbidden.status, 403);

  const noViewer = await fetch(`http://127.0.0.1:${port}/households/H01/statement`);
  assert.equal(noViewer.status, 403);
});

test('文本格式回放明细可读且含平衡结论', async (context) => {
  const demo = createDemoContext();
  const { server, port } = await start(demo);
  context.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/households/H01/statement?viewer=admin&format=text`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /林农收益分配明细/);
  assert.match(text, /✓ 平衡/);
  assert.match(text, /哈希链：✓/);
});
