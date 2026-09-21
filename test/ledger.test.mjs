import assert from 'node:assert/strict';
import test from 'node:test';
import { Ledger, VOUCHER, ACCOUNT } from '../src/ledger.mjs';
import { allocate, yuanToFen } from '../src/money.mjs';
import { runScenario } from '../src/scenario.mjs';

// ── 分金工具 ────────────────────────────────────────────────────────────────
test('最大余数法把整数分一分不差地分尽', () => {
  const result = allocate(100, [1, 1, 1]);
  assert.deepEqual(result, [34, 33, 33]);
  assert.equal(result.reduce((a, b) => a + b, 0), 100);

  // 大额、不等权重也不丢分
  const weights = [333_333, 333_333, 333_334];
  const big = allocate(12_345_678, weights);
  assert.equal(big.reduce((a, b) => a + b, 0), 12_345_678);
  assert.ok(big.every((value) => Number.isInteger(value)));
});

test('金额一律以整数分入账，杜绝浮点误差', () => {
  assert.equal(yuanToFen(50), 5000);
  assert.equal(yuanToFen(25), 2500);
});

// ── 完整回放场景 ─────────────────────────────────────────────────────────────
test('年终回放：跨两项目场景总账平衡、哈希链完整、各户恒等式成立', () => {
  const { ledger, milestones } = runScenario();
  assert.ok(ledger.isBalanced(), '全部凭证借贷必须相等');
  assert.deepEqual(ledger.verifyChain(), { ok: true, count: ledger.store.vouchers.length });

  const finalBalances = milestones.final;
  assert.equal(finalBalances.cash, 0);
  assert.equal(finalBalances.clearing, 0);
  assert.equal(finalBalances.payable, 0);
  assert.equal(finalBalances.frozen, 0);
  assert.equal(finalBalances.recoverable, 0);
  for (const household of ['H01', 'H02', 'H03']) {
    assert.ok(finalBalances[household].identityHolds, `${household} 对账恒等式应成立`);
  }
});

test('保底租金首批按权属份额 60/40 计提，类型为普通计提', () => {
  const { ledger } = runScenario();
  const firstLease = ledger.store.vouchers.find(
    (voucher) => voucher.type === VOUCHER.ACCRUAL && voucher.refs?.eventId === 'E-LEASE24' && voucher.refs.batchNo === 'B1',
  );
  assert.ok(firstLease);
  const lines = firstLease.lines.filter((line) => line.account === ACCOUNT.PAYABLE);
  assert.equal(lines.find((line) => line.aux.personId === 'p1').credit, yuanToFen(1800));
  assert.equal(lines.find((line) => line.aux.personId === 'p2').credit, yuanToFen(1200));
});

test('迟回批次生成“追补”凭证，且去世成员份额同步暂缓冻结', () => {
  const { milestones } = runScenario();
  assert.equal(milestones.lateLeaseBatch.batch.late, true);
  const types = milestones.catchUp.map((voucher) => voucher.type);
  assert.ok(types.includes(VOUCHER.CATCH_UP));
  assert.ok(types.includes(VOUCHER.WITHHOLD));
  const withhold = milestones.catchUp.find((voucher) => voucher.type === VOUCHER.WITHHOLD);
  assert.equal(withhold.lines.find((line) => line.account === ACCOUNT.FROZEN).credit, yuanToFen(800));
});

test('同一务工记录重传被幂等拒绝，不产生第二次计提', () => {
  const { ledger, milestones } = runScenario();
  assert.equal(milestones.workRetry.duplicated, true);
  const workAccrual = ledger.store.vouchers.find(
    (voucher) => voucher.refs?.kind === 'accrual' && voucher.refs.eventId === 'E-WORK24',
  );
  // 仅 W001+W003=400 元（p1）、W002=200 元（p2），重传的 W001 未重复计入
  const byPerson = new Map();
  for (const line of workAccrual.lines.filter((line) => line.account === ACCOUNT.PAYABLE)) {
    byPerson.set(line.aux.personId, line.credit);
  }
  assert.equal(byPerson.get('p1'), yuanToFen(400));
  assert.equal(byPerson.get('p2'), yuanToFen(200));
});

test('继承确定：冻结款跨户解冻到继承人，双方恒等式在中间态即成立', () => {
  const { milestones } = runScenario();
  assert.equal(milestones.inheritance.length, 1);
  const release = milestones.inheritance[0];
  const to = release.lines.find((line) => line.account === ACCOUNT.PAYABLE);
  assert.equal(to.aux.householdId, 'H03');
  assert.equal(to.aux.personId, 'p4');
  assert.equal(to.credit, yuanToFen(800));

  const before = milestones.beforeCorrection;
  assert.ok(before.H01.identityHolds);
  assert.ok(before.H03.identityHolds);
  assert.equal(before.H01.transferredOut, yuanToFen(800));
  assert.equal(before.H03.transferredIn, yuanToFen(800));
});

test('争议期间份额暂缓，争议解决后解冻给原权利人', () => {
  const { milestones } = runScenario();
  // B1 计提于争议窗口内，存在按“地块份额争议”冻结的暂缓凭证
  const withhold = milestones.disputeAccrual.find(
    (voucher) => voucher.type === VOUCHER.WITHHOLD &&
      voucher.lines.some((line) => line.account === ACCOUNT.FROZEN && line.aux.reason === '地块份额争议'),
  );
  assert.ok(withhold, '争议窗口应产生暂缓凭证');
  assert.ok(milestones.disputeResolved.vouchers.length >= 1, '争议解决应产生解冻凭证');
});

test('结算后权属更正：红冲+蓝补+转追偿，旧凭证保留且链可核验', () => {
  const { ledger, milestones } = runScenario();
  const posted = milestones.correction;
  const types = posted.map((item) => item.type ?? item.id).filter((type) => typeof type === 'string');
  assert.ok(types.includes(VOUCHER.RED_REVERSAL));
  assert.ok(types.includes(VOUCHER.BLUE_SUPPLEMENT));

  // 旧凭证仍在账上且被标记红冲，未被改写
  const original = ledger.store.vouchers.find((voucher) => voucher.voucherNo === 'PZ-000002');
  assert.ok(original.reversedBy, '原计提凭证应保留并标记红冲凭证号');
  assert.equal(original.lines.find((line) => line.aux?.personId === 'p2').credit, yuanToFen(1200));

  // p2 在 D1 事件中超付 1200 元（原 40% → 更正后 30%，2024 租金 5000 元 × 10% × ... 实际为 1200）
  assert.deepEqual(milestones.recoveries, [{ personId: 'p2', fen: yuanToFen(1200) }]);

  // 更正后各方补付恰好等于追回金额，资金在户间再分配后归零
  assert.ok(ledger.isBalanced());
  assert.equal(ledger.accountBalance(ACCOUNT.RECOVERABLE), 0);
});

test('按户回放明细逐笔可还原依据，且自带账平与哈希链结论', () => {
  const { milestones } = runScenario();
  const statement = milestones.statementH01;
  assert.equal(statement.household.id, 'H01');
  assert.ok(statement.ledgerBalanced);
  assert.equal(statement.chain.ok, true);
  assert.ok(statement.reconciliation.identityHolds);
  // 跨项目：H01 明细中同时出现 P-A 与 P-B
  const projects = new Set(entries(statement).map((entry) => entry.projectId));
  assert.ok(projects.has('P-A'));
  assert.ok(projects.has('P-B'));
  // 计提行携带“份额ppm×天数”的分段依据，可供手工还原
  const accrual = entries(statement).find((entry) => entry.type === VOUCHER.ACCRUAL && entry.eventId === 'E-LEASE24');
  assert.ok(accrual);
  const basisLine = accrual.lines.find((line) => line.aux?.basis?.ppmDays?.length > 0);
  assert.ok(basisLine, '计提分录应携带份额×天数依据');
  assert.ok(basisLine.aux.basis.ppmDays[0].fromText, '依据日期应可读');
});

function entries(statement) {
  return statement.entries;
}

test('凭证被事后篡改时哈希链核验失败', () => {
  const { ledger } = runScenario();
  const target = ledger.store.vouchers.find((voucher) => voucher.refs?.eventId === 'E-LEASE24');
  target.lines[0].debit += 1;
  const result = ledger.verifyChain();
  assert.equal(result.ok, false);
  assert.ok(result.at);
});

// ── 村组查看权限 ─────────────────────────────────────────────────────────────
test('查看范围遵循村组权限', () => {
  const { ledger } = runScenario();
  // 经管可见全部
  assert.deepEqual(ledger.visibleHouseholdIds({ scope: 'admin' }).sort(), ['H01', 'H02', 'H03']);
  // 一组只能看到本组户
  assert.deepEqual(ledger.visibleHouseholdIds({ scope: 'group', groupId: 'G1' }).sort(), ['H01', 'H03']);
  // 农户只能看本户
  assert.deepEqual(ledger.visibleHouseholdIds({ scope: 'household', householdId: 'H01' }), ['H01']);

  ledger.assertCanView('H01', { scope: 'group', groupId: 'G1' });
  assert.throws(() => ledger.assertCanView('H02', { scope: 'group', groupId: 'G1' }), /无权查看/);
  assert.throws(() => ledger.householdStatement('H02', { scope: 'household', householdId: 'H01' }), /无权查看/);
  assert.doesNotThrow(() => ledger.householdStatement('H01', { scope: 'household', householdId: 'H01' }));
});

// ── 边界规则 ─────────────────────────────────────────────────────────────────
test('回款批次号幂等，且累计回款不得超过事件总额', () => {
  const ledger = new Ledger();
  ledger.registerHousehold({ id: 'H1', groupId: 'G1' });
  ledger.registerPerson({ id: 'a', householdId: 'H1' });
  ledger.registerPlot({ id: 'D1', groupId: 'G1', areaMu: 10 });
  ledger.addShareVersion('D1', [{ personId: 'a', ppm: 1_000_000 }], '2024-01-01');
  ledger.registerEvent({ id: 'E1', projectId: 'P1', plotId: 'D1', source: 'eco', period: '2024', totalFen: 1000, expectedDayText: '2025-01-01' });
  ledger.receiveBatch('E1', 'B1', 600, '2024-12-31');
  assert.throws(() => ledger.receiveBatch('E1', 'B1', 600, '2024-12-31'), /已登记/);
  assert.throws(() => ledger.receiveBatch('E1', 'B2', 500, '2024-12-31'), /超过总额/);
});

test('权属版本链：新版本切片旧有效期，份额和必须为百万', () => {
  const ledger = new Ledger();
  ledger.registerHousehold({ id: 'H1', groupId: 'G1' });
  ledger.registerPerson({ id: 'a', householdId: 'H1' });
  ledger.registerPerson({ id: 'b', householdId: 'H1' });
  ledger.registerPlot({ id: 'D1', groupId: 'G1', areaMu: 10 });
  assert.throws(() => ledger.addShareVersion('D1', [{ personId: 'a', ppm: 500_000 }], '2024-01-01'), /份额之和/);
  ledger.addShareVersion('D1', [{ personId: 'a', ppm: 1_000_000 }], '2024-01-01');
  ledger.addShareVersion('D1', [{ personId: 'a', ppm: 500_000 }, { personId: 'b', ppm: 500_000 }], '2024-07-01');
  const versions = ledger.store.shareVersions;
  assert.equal(versions[0].validTo, versions[1].validFrom);
  assert.equal(versions[1].validTo, null);
});

test('争议解决时继承仍待定：解冻后立即以继承待定再暂缓，事后更正不留双冻', () => {
  const ledger = new Ledger();
  ledger.registerHousehold({ id: 'H1', groupId: 'G1' });
  ledger.registerPerson({ id: 'a', householdId: 'H1' });
  ledger.registerPerson({ id: 'b', householdId: 'H1' });
  ledger.registerPlot({ id: 'D1', groupId: 'G1', areaMu: 10 });
  ledger.addShareVersion('D1', [{ personId: 'a', ppm: 1_000_000 }], '2024-01-01');
  ledger.registerEvent({ id: 'E1', projectId: 'P1', plotId: 'D1', source: 'lease', period: '2024', totalFen: 100_000, expectedDayText: '2025-03-31' });
  ledger.registerDispute('D1', '2024-06-01', null, '界址争议');
  ledger.receiveBatch('E1', 'B1', 100_000, '2025-01-10');
  ledger.accrue('2025-01-15');
  // 争议自 2024-06-01 起：争议前 152 天照付（41530），争议窗口 214 天冻结（58470）
  assert.equal(-ledger.accountBalance(ACCOUNT.FROZEN, { personId: 'a' }), 58_470, '争议窗口份额冻结');
  assert.equal(-ledger.accountBalance(ACCOUNT.PAYABLE, { personId: 'a' }), 41_530, '争议前份额正常待付');

  ledger.markDeath('a', '2024-12-01');
  const resolved = ledger.resolveDispute('D1', '2025-01-20');
  const types = resolved.vouchers.map((voucher) => voucher.type);
  assert.deepEqual(types, [VOUCHER.RELEASE, VOUCHER.WITHHOLD], '争议解冻后应立即按继承待定再暂缓');
  assert.equal(-ledger.accountBalance(ACCOUNT.FROZEN, { personId: 'a' }), 58_470, '仍冻结原争议金额，不产生重复冻结');

  // 事后更正权属为 a/b 各半
  ledger.correctShares({
    plotId: 'D1',
    shares: [
      { personId: 'a', ppm: 500_000 },
      { personId: 'b', ppm: 500_000 },
    ],
    effectiveDayText: '2024-01-01',
    registeredDayText: '2025-02-01',
  });
  assert.ok(ledger.isBalanced());
  assert.deepEqual(ledger.verifyChain().ok, true);
  assert.equal(-ledger.accountBalance(ACCOUNT.FROZEN, { personId: 'a' }), 50_000, 'a 的一半继承待定冻结');
  assert.equal(-ledger.accountBalance(ACCOUNT.PAYABLE, { personId: 'b' }), 50_000, 'b 的一半待付');
  assert.equal(ledger.accountBalance(ACCOUNT.RECOVERABLE), 0, '未曾发放，无追偿');
  assert.ok(ledger.reconcileHousehold('H1').identityHolds);
});

test('更正发生在发放之前：只红冲蓝补，不产生应追回款', () => {
  const ledger = new Ledger();
  ledger.registerHousehold({ id: 'H1', groupId: 'G1' });
  ledger.registerPerson({ id: 'a', householdId: 'H1' });
  ledger.registerPerson({ id: 'b', householdId: 'H1' });
  ledger.registerPlot({ id: 'D1', groupId: 'G1', areaMu: 10 });
  ledger.addShareVersion('D1', [{ personId: 'a', ppm: 1_000_000 }], '2024-01-01');
  ledger.registerEvent({ id: 'E1', projectId: 'P1', plotId: 'D1', source: 'lease', period: '2024', totalFen: 100_000, expectedDayText: '2025-01-01', basis: {} });
  ledger.receiveBatch('E1', 'B1', 100_000, '2024-12-31');
  ledger.accrue('2024-12-31');
  ledger.correctShares({
    plotId: 'D1',
    shares: [
      { personId: 'a', ppm: 600_000 },
      { personId: 'b', ppm: 400_000 },
    ],
    effectiveDayText: '2024-01-01',
    registeredDayText: '2025-01-10',
  });
  assert.equal(ledger.accountBalance(ACCOUNT.RECOVERABLE), 0, '尚未发放不应有追偿');
  const balances = ledger.reconcileHousehold('H1');
  assert.ok(balances.identityHolds);
  assert.equal(balances.payable, 100_000, '更正后款项仍全部待付');
});
