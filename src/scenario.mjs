import { Ledger, VOUCHER, ACCOUNT } from './ledger.mjs';
import { yuanToFen } from './money.mjs';

/**
 * 年终回放样板场景：
 * - 户 H01（张三户，一组）跨两个项目：P-A 林下种植（保底租金/经营分成）、P-B 生态管护（务工）
 * - 户 H02（王五户，二组）承包地块 D2 的生态奖励
 * - 户 H03（李四继承人户，一组）
 * 覆盖：回款分批与延迟追补、去世继承待定与跨户解冻、务工记录重传幂等、
 *       地块争议暂缓与解冻、结算后权属更正（红冲/蓝补/转追偿）、多领退回。
 */
export function runScenario() {
  const ledger = new Ledger();
  const L = ledger;
  const milestones = {};

  // ── 2024 年基础登记 ───────────────────────────────────────────────────────
  L.registerHousehold({ id: 'H01', groupId: 'G1', name: '张三户' });
  L.registerHousehold({ id: 'H02', groupId: 'G2', name: '王五户' });
  L.registerHousehold({ id: 'H03', groupId: 'G1', name: '李继承户' });
  L.registerPerson({ id: 'p1', householdId: 'H01', name: '张三' });
  L.registerPerson({ id: 'p2', householdId: 'H01', name: '李四' });
  L.registerPerson({ id: 'p3', householdId: 'H02', name: '王五' });
  L.registerPerson({ id: 'p4', householdId: 'H03', name: '李小四' });

  // D1：100 亩，初始张三 60%、李四 40%（2024-01-01 起）
  L.registerPlot({ id: 'D1', groupId: 'G1', areaMu: 100, name: '冬瓜岭林地' });
  L.addShareVersion('D1', [
    { personId: 'p1', ppm: 600_000 },
    { personId: 'p2', ppm: 400_000 },
  ], '2024-01-01', { note: '初始确权' });

  // D2：50 亩，王五 100%
  L.registerPlot({ id: 'D2', groupId: 'G2', areaMu: 50, name: '清溪沟林地' });
  L.addShareVersion('D2', [{ personId: 'p3', ppm: 1_000_000 }], '2024-01-01', { note: '初始确权' });

  // 项目 P-A：保底租金 100 亩 × 50 元/亩·年 = 5000 元；约定 2025-03-31 前回款
  L.registerEvent({
    id: 'E-LEASE24',
    projectId: 'P-A',
    plotId: 'D1',
    source: 'lease',
    period: '2024',
    totalFen: yuanToFen(5000),
    expectedDayText: '2025-03-31',
    basis: { rateFenPerMuYear: yuanToFen(50), description: '保底租金按亩年单价计提' },
  });

  // 项目 P-B：务工收入事件（不挂地块，按记录到人）
  L.registerEvent({
    id: 'E-WORK24',
    projectId: 'P-B',
    source: 'work',
    period: '2024',
    totalFen: 0,
    expectedDayText: '2025-02-28',
    basis: { description: '生态管护务工，计时工资 25 元/工时' },
  });
  const rate = yuanToFen(25);
  const w1 = L.addWorkRecord({ recordNo: 'W001', eventId: 'E-WORK24', personId: 'p1', dayText: '2024-11-05', hours: 10, hourlyRateFen: rate });
  L.addWorkRecord({ recordNo: 'W002', eventId: 'E-WORK24', personId: 'p2', dayText: '2024-11-06', hours: 8, hourlyRateFen: rate });
  L.addWorkRecord({ recordNo: 'W003', eventId: 'E-WORK24', personId: 'p1', dayText: '2024-12-12', hours: 6, hourlyRateFen: rate });
  // 同一务工记录重传：必须被幂等拒绝
  milestones.workRetry = L.addWorkRecord({ recordNo: 'W001', eventId: 'E-WORK24', personId: 'p1', dayText: '2024-11-05', hours: 10, hourlyRateFen: rate });

  // 项目 P-B：D2 生态奖励 50 亩 × 20 元 = 1000 元，约定 2025-03-31 前回款
  L.registerEvent({
    id: 'E-ECO24',
    projectId: 'P-B',
    plotId: 'D2',
    source: 'eco',
    period: '2024',
    totalFen: yuanToFen(1000),
    expectedDayText: '2025-03-31',
    basis: { rateFenPerMuYear: yuanToFen(20) },
  });

  // ── 2025 年结算 ───────────────────────────────────────────────────────────
  // 租金分批：第一批 3000 元按时到账
  L.receiveBatch('E-LEASE24', 'B1', yuanToFen(3000), '2025-02-05');
  L.accrue('2025-02-28');
  // 务工款一次到账
  L.receiveBatch('E-WORK24', 'B1', yuanToFen(600), '2025-02-26');
  L.accrue('2025-02-28');
  // 年前发放张三户：租金 1800+1200 + 务工 400+200 = 3600 元
  milestones.payoutH01First = L.payoutHousehold('H01', '2025-02-28');

  // 生态奖励到账、发放王五户
  L.receiveBatch('E-ECO24', 'B1', yuanToFen(1000), '2025-03-05');
  L.accrue('2025-03-10');
  L.payoutHousehold('H02', '2025-03-12');

  // 李四 2025-03-01 去世，继承待定
  L.markDeath('p2', '2025-03-01');

  // 租金第二批 2000 元迟至 2025-05-20 到账 → 追补；李四份额 800 元冻结
  milestones.lateLeaseBatch = L.receiveBatch('E-LEASE24', 'B2', yuanToFen(2000), '2025-05-20');
  milestones.catchUp = L.accrue('2025-05-31');
  L.payoutHousehold('H01', '2025-06-05');

  // 2025-06-15 继承确定：李四份额由李小四（H03）继承，冻结款跨户解冻；
  // 同时登记新权属版本（自去世次日切割有效期），李小四承接 40% 份额
  milestones.inheritance = L.resolveInheritance('p2', 'p4', '2025-06-15');
  L.addShareVersion(
    'D1',
    [
      { personId: 'p1', ppm: 600_000 },
      { personId: 'p4', ppm: 400_000 },
    ],
    '2025-03-01',
    { note: '李四 40% 份额由继承人李小四承接' },
  );
  L.payoutHousehold('H03', '2025-06-20');

  // 2025 期租金事件（100 亩 × 50 元）与争议窗口
  L.registerEvent({
    id: 'E-LEASE25',
    projectId: 'P-A',
    plotId: 'D1',
    source: 'lease',
    period: '2025',
    totalFen: yuanToFen(5000),
    expectedDayText: '2026-01-15',
    basis: { rateFenPerMuYear: yuanToFen(50) },
  });
  L.registerDispute('D1', '2025-06-25', null, '张三与邻户对冬瓜岭界址有争议');
  // 第一批 2000 元在争议期间到账：争议窗口对应份额暂缓，其余照付
  L.receiveBatch('E-LEASE25', 'B1', yuanToFen(2000), '2025-07-10');
  milestones.disputeAccrual = L.accrue('2025-07-31');
  L.payoutHousehold('H01', '2025-08-05');
  // 争议 2025-08-10 解决，冻结款解冻
  milestones.disputeResolved = L.resolveDispute('D1', '2025-08-10');
  L.payoutHousehold('H01', '2025-08-15');
  // 第二批 3000 元晚于约定日到账 → 追补
  L.receiveBatch('E-LEASE25', 'B2', yuanToFen(3000), '2026-01-20');
  L.accrue('2026-01-31');
  L.payoutHousehold('H01', '2026-02-05');

  // 经营分成事件（2025 期，2000 元）
  L.registerEvent({
    id: 'E-SHARE25',
    projectId: 'P-A',
    plotId: 'D1',
    source: 'share',
    period: '2025',
    totalFen: yuanToFen(2000),
    expectedDayText: '2026-01-31',
    basis: { description: '林下种植经营净收益按权属份额分配' },
  });
  L.receiveBatch('E-SHARE25', 'B1', yuanToFen(2000), '2026-02-10');
  L.accrue('2026-02-28');
  L.payoutHousehold('H01', '2026-03-05');

  milestones.beforeCorrection = snapshotBalances(ledger);

  // ── 结算后权属更正（2026-03-15 经办）───────────────────────────────────────
  // 复核发现 2024 年初始确权比例登记有误，应为张三 70%、李四 30%，追溯至 2024-01-01。
  // 只追加分录：红冲旧计提/暂缓/解冻 → 按新版本链蓝补 → 超付转追偿。
  milestones.correction = L.correctShares({
    plotId: 'D1',
    shares: [
      { personId: 'p1', ppm: 700_000 },
      { personId: 'p2', ppm: 300_000 },
    ],
    effectiveDayText: '2024-01-01',
    registeredDayText: '2026-03-15',
    note: '初始确权比例更正 60/40 → 70/30',
  });

  // 更正后：少付的补付
  L.payoutHousehold('H01', '2026-03-20');
  L.payoutHousehold('H03', '2026-03-20');

  // 超领方退回（凡有应追回余额的成员逐一退回）
  milestones.recoveries = [];
  for (const personId of ledger.store.persons.keys()) {
    const owed = L.accountBalance(ACCOUNT.RECOVERABLE, { personId });
    if (owed > 0) {
      L.recordRepayment(personId, owed, '2026-03-25', { note: '权属更正后退回多领款项' });
      milestones.recoveries.push({ personId, fen: owed });
    }
  }

  milestones.final = snapshotBalances(ledger);
  milestones.statementH01 = L.householdStatement('H01');
  milestones.statementH03 = L.householdStatement('H03');
  milestones.statementH02 = L.householdStatement('H02');
  return { ledger, milestones };
}

function snapshotBalances(ledger) {
  return {
    cash: ledger.accountBalance(ACCOUNT.CASH),
    clearing: ledger.accountBalance(ACCOUNT.CLEARING),
    payable: ledger.accountBalance(ACCOUNT.PAYABLE),
    frozen: ledger.accountBalance(ACCOUNT.FROZEN),
    recoverable: ledger.accountBalance(ACCOUNT.RECOVERABLE),
    H01: ledger.reconcileHousehold('H01'),
    H02: ledger.reconcileHousehold('H02'),
    H03: ledger.reconcileHousehold('H03'),
  };
}
