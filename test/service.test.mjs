import assert from 'node:assert/strict';
import test from 'node:test';

import { createAccessPolicy } from '../src/domain/access.mjs';
import { ROLE, SOURCE } from '../src/domain/catalog.mjs';
import { createLedger } from '../src/domain/ledger.mjs';
import { createRegistry, loadRegistry } from '../src/domain/registry.mjs';
import { loadJournal } from '../src/domain/journal.mjs';
import { createAppService } from '../src/app/service.mjs';

function buildService() {
  const registry = createRegistry();
  registry.addGroup({ groupId: 'G1', name: '青山村一组' });
  registry.addGroup({ groupId: 'G2', name: '青山村二组' });
  registry.addProject({ projectId: 'P1', name: '杉木碳汇', sources: [SOURCE.RENT, SOURCE.ECO_REWARD] });
  registry.addHousehold({ householdId: 'H1', groupId: 'G1', headName: '张三' });
  registry.addHousehold({ householdId: 'H2', groupId: 'G2', headName: '赵六' });
  registry.addParcel({ parcelId: 'L1', projectId: 'P1', areaMu: '1000', annualRentCentsPerMu: 10000, annualEcoCentsPerMu: 2000 });
  registry.grantShare({ parcelId: 'L1', householdId: 'H1', shareBasis: 10000, from: '2026-01-01' });

  const policy = createAccessPolicy([
    { userId: 'A1', name: '镇管理员', role: ROLE.ADMIN, groupIds: [] },
    { userId: 'M1', name: '一组经办', role: ROLE.MANAGER, groupIds: ['G1'] },
    { userId: 'V1', name: '一组监督员', role: ROLE.VIEWER, groupIds: ['G1'] },
    { userId: 'M2', name: '二组经办', role: ROLE.MANAGER, groupIds: ['G2'] },
  ]);
  return createAppService({ registry, policy });
}

test('村组权限：查看范围与读写边界', () => {
  const service = buildService();

  // manager 只能看到本组户
  const g1Homes = service.listHouseholds('M1').map((h) => h.householdId);
  assert.deepEqual(g1Homes, ['H1']);
  const allHomes = service.listHouseholds('A1').map((h) => h.householdId).sort();
  assert.deepEqual(allHomes, ['H1', 'H2']);

  // 回款、年度计提为全局操作，manager 无权
  assert.throws(() => service.receivePayment('M1', { projectId: 'P1', batchId: 'B1', amountCents: 1000, date: '2026-01-15' }), /管理员权限/);
  service.receivePayment('A1', { projectId: 'P1', batchId: 'B1', amountCents: 200000000, date: '2026-01-15' });

  // 二组经办不能操作一组户
  assert.throws(
    () => service.payHousehold('M2', { householdId: 'H1', date: '2026-03-01' }),
    /无权操作村组 G1/,
  );
  // 一组 viewer 只读
  assert.throws(
    () => service.accrueWage('V1', { recordId: 'W1', projectId: 'P1', householdId: 'H1', amountCents: 100, workDate: '2026-02-01', date: '2026-02-01' }),
    /只读角色不能进行写操作/,
  );

  // 跨组查询回放单被拒绝
  assert.throws(() => service.householdStatement('M2', { householdId: 'H1' }), /无权查看村组 G1/);

  // 本组合法操作可以执行
  service.accrueAnnual('A1', { period: '2026', date: '2026-02-01' });
  const paid = service.payHousehold('M1', { householdId: 'H1', date: '2026-03-01' });
  assert.ok(paid.length >= 1);

  // 非 admin 总账只含本辖区
  const g1Balance = service.balance('M1');
  assert.equal(g1Balance.scope, 'GROUPS');
  assert.ok(g1Balance.accruedCents > 0);
  const adminBalance = service.balance('A1');
  assert.equal(adminBalance.scope, 'ALL');
  assert.equal(adminBalance.payableCents, 0);
});

test('持久化重放：快照重建后余额、关账状态与链头一致', () => {
  const service = buildService();
  service.receivePayment('A1', { projectId: 'P1', batchId: 'B1', amountCents: 200000000, date: '2026-01-15' });
  service.accrueAnnual('A1', { period: '2026', date: '2026-02-01' });
  service.payHousehold('M1', { householdId: 'H1', date: '2026-03-01' });
  service.closePeriod('A1', { period: '2026' });

  const journalSnapshot = service.ledger.journal.snapshot();
  const registrySnapshot = service.registry.snapshot();
  const beforeHead = service.verify('A1').head;

  const registry2 = loadRegistry(registrySnapshot);
  const journal2 = loadJournal(journalSnapshot);
  const policy2 = createAccessPolicy([
    { userId: 'A1', name: '镇管理员', role: ROLE.ADMIN, groupIds: [] },
    { userId: 'M1', name: '一组经办', role: ROLE.MANAGER, groupIds: ['G1'] },
  ]);
  const service2 = createAppService({ registry: registry2, journal: journal2, policy: policy2 });

  assert.equal(service2.verify('A1').head, beforeHead);
  assert.ok(service2.ledger.journal.isClosed('2026'));
  const a = service.balance('A1');
  const b = service2.balance('A1');
  for (const key of ['cashCents', 'accruedCents', 'paidCents', 'payableCents']) {
    assert.equal(a[key], b[key]);
  }
  // 重放后关账仍生效：2026 期日常分录被拒
  assert.throws(
    () => service2.receivePayment('A1', { projectId: 'P1', batchId: 'B9', amountCents: 1, date: '2026-12-31' }),
    /已关账/,
  );
});

test('防篡改：直接改动旧账金额会被哈希链核验拦截', () => {
  const service = buildService();
  service.receivePayment('A1', { projectId: 'P1', batchId: 'B1', amountCents: 200000000, date: '2026-01-15' });
  service.accrueAnnual('A1', { period: '2026', date: '2026-02-01' });

  const snapshot = service.ledger.journal.snapshot();
  snapshot.entries[1].amountCents += 1; // 偷偷改一笔计提金额
  assert.throws(() => loadJournal(snapshot), /内容哈希不符/);

  // 即便只改依据快照，核验同样失败
  const snapshot2 = service.ledger.journal.snapshot();
  snapshot2.entries[1].basis.formula = '被篡改的公式';
  assert.throws(() => loadJournal(snapshot2), /内容哈希不符/);
});
