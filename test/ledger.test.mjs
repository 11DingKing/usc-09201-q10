import assert from 'node:assert/strict';
import test from 'node:test';

import { REASON, SOURCE } from '../src/domain/catalog.mjs';
import { createLedger } from '../src/domain/ledger.mjs';
import { createRegistry } from '../src/domain/registry.mjs';
import { buildHouseholdStatement } from '../src/domain/statement.mjs';

// 构造一套跨两个年度的完整账：
// 项目 P1 杉木碳汇（四类来源齐全）、P2 林下药材；
// H1 张三户同时参与两个项目（年终回放对象），H2 王五户在 G1，H3 赵六户在 G2。
function buildScenario() {
  const registry = createRegistry();
  registry.addGroup({ groupId: 'G1', name: '青山村一组' });
  registry.addGroup({ groupId: 'G2', name: '青山村二组' });
  registry.addProject({ projectId: 'P1', name: '杉木碳汇项目', sources: [SOURCE.RENT, SOURCE.DIVIDEND, SOURCE.WAGE, SOURCE.ECO_REWARD] });
  registry.addProject({ projectId: 'P2', name: '林下药材项目', sources: [SOURCE.RENT, SOURCE.DIVIDEND, SOURCE.WAGE] });

  registry.addHousehold({ householdId: 'H1', groupId: 'G1', headName: '张三', members: [{ memberId: 'M1', name: '张三' }, { memberId: 'M2', name: '李四' }] });
  registry.addHousehold({ householdId: 'H2', groupId: 'G1', headName: '王五', members: [{ memberId: 'M3', name: '王五' }] });
  registry.addHousehold({ householdId: 'H3', groupId: 'G2', headName: '赵六', members: [{ memberId: 'M4', name: '赵六' }] });

  // L1：1 万亩，年租 100 元/亩，生态奖励 20 元/亩；起录份额 H1 60% / H2 40%
  registry.addParcel({ parcelId: 'L1', projectId: 'P1', areaMu: '10000', annualRentCentsPerMu: 10000, annualEcoCentsPerMu: 2000, name: '碳汇一号山场' });
  registry.grantShare({ parcelId: 'L1', householdId: 'H1', shareBasis: 6000, from: '2026-01-01' });
  registry.grantShare({ parcelId: 'L1', householdId: 'H2', shareBasis: 4000, from: '2026-01-01' });

  // L2：5000 亩，年租 80 元/亩；上半年 H1 全份额，7 月起流转一半给 H3（有效期按日分摊）
  registry.addParcel({ parcelId: 'L2', projectId: 'P2', areaMu: '5000', annualRentCentsPerMu: 8000, name: '药材基地东坡' });
  registry.grantShare({ parcelId: 'L2', householdId: 'H1', shareBasis: 10000, from: '2026-01-01', to: '2026-07-01' });
  registry.grantShare({ parcelId: 'L2', householdId: 'H1', shareBasis: 5000, from: '2026-07-01' });
  registry.grantShare({ parcelId: 'L2', householdId: 'H3', shareBasis: 5000, from: '2026-07-01' });

  return { ledger: createLedger(registry), registry };
}

test('年终回放：四类来源计提、分批回款、幂等重传', () => {
  const { ledger } = buildScenario();
  // 第一批回款 100 万元（留存 20 万元暂不分成）
  ledger.receivePayment({ projectId: 'P1', batchId: 'B1', amountCents: 100000000, date: '2026-01-15', operator: 'U1' });

  const accruals = ledger.accrueAnnual({ period: '2026', date: '2026-02-01', operator: 'U1' });
  // L1 租金 H1 60 万、H2 40 万；生态 H1 12 万、H2 8 万；L2 租金合计 40 万守恒
  const byLot = Object.fromEntries(accruals.map((e) => [e.lotId, e.amountCents]));
  assert.equal(byLot['LOT:RENT:2026:L1:H1'], 60000000);
  assert.equal(byLot['LOT:RENT:2026:L1:H2'], 40000000);
  assert.equal(byLot['LOT:ECO_REWARD:2026:L1:H1'], 12000000);
  assert.equal(byLot['LOT:ECO_REWARD:2026:L1:H2'], 8000000);
  assert.equal(byLot['LOT:RENT:2026:L2:H1'] + byLot['LOT:RENT:2026:L2:H3'], 40000000);

  // 务工记录：同一记录重传必须幂等
  const wage1 = ledger.accrueWage({ recordId: 'W001', projectId: 'P2', householdId: 'H1', memberId: 'M1', amountCents: 5000000, workDate: '2026-02-05', date: '2026-02-10', operator: 'U1' });
  const wage1Retry = ledger.accrueWage({ recordId: 'W001', projectId: 'P2', householdId: 'H1', memberId: 'M1', amountCents: 5000000, workDate: '2026-02-05', date: '2026-02-11', operator: 'U1' });
  assert.equal(wage1Retry.entryId, wage1.entryId);
  ledger.accrueWage({ recordId: 'W002', projectId: 'P1', householdId: 'H2', memberId: 'M3', amountCents: 3000000, workDate: '2026-02-06', date: '2026-02-10', operator: 'U1' });

  // 经营分成 80 万元按面积份额天权重分摊：H1 60% / H2 40%，总额守恒
  const dividend = ledger.distributeDividend({ receiptEntryId: ledger.journal.entries()[0].entryId, projectId: 'P1', period: '2026', amountCents: 80000000, date: '2026-03-01', operator: 'U1' });
  const divSum = dividend.reduce((s, e) => s + e.amountCents, 0);
  assert.equal(divSum, 80000000);
  const h1Div = dividend.find((e) => e.householdId === 'H1').amountCents;
  const h2Div = dividend.find((e) => e.householdId === 'H2').amountCents;
  assert.equal(h1Div, 48000000);
  assert.equal(h2Div, 32000000);

  const balance = ledger.journal.trialBalance();
  assert.equal(balance.cashCents, 100000000);
  assert.equal(balance.accruedCents, 248000000);
  assert.ok(ledger.journal.verify().ok);
});

test('回款延迟暂缓、分批追补到账后恢复并支付', () => {
  const { ledger } = buildScenario();
  ledger.receivePayment({ projectId: 'P1', batchId: 'B1', amountCents: 100000000, date: '2026-01-15', operator: 'U1' });
  ledger.accrueAnnual({ period: '2026', date: '2026-02-01', operator: 'U1' });
  ledger.distributeDividend({ receiptEntryId: ledger.journal.entries()[0].entryId, projectId: 'P1', period: '2026', amountCents: 80000000, date: '2026-03-01', operator: 'U1' });

  // 生态奖励对应的专项回款延迟：暂缓两户生态奖励应付
  const suspended = ledger.suspendForReceiptDelay({ projectId: 'P1', period: '2026', sources: [SOURCE.ECO_REWARD], date: '2026-04-01', operator: 'U1' });
  assert.equal(suspended.length, 2);
  const ecoLot = ledger.journal.lot('LOT:ECO_REWARD:2026:L1:H1');
  assert.equal(ecoLot.suspendedCents, 12000000);
  assert.equal(ecoLot.availableCents, 0);

  // 暂缓期间不能支付
  assert.throws(() => ledger.payLot({ lotId: ecoLot.lotId, amountCents: 100, date: '2026-04-02', operator: 'U1' }), /可付额度/);

  // 不能超额冻结/暂缓
  assert.throws(
    () => ledger.operate({ type: 'SUSPEND', lotId: ecoLot.lotId, amountCents: 1, date: '2026-04-03', operator: 'U1', reasonCode: REASON.RECEIPT_DELAY, basis: { reason: '重复暂缓' } }),
    /超过未挂账余额/,
  );

  // 第二批回款到账：恢复并支付，计算依据保留暂缓与恢复链路
  ledger.receivePayment({ projectId: 'P1', batchId: 'B2', amountCents: 50000000, date: '2026-06-01', operator: 'U1' });
  ledger.operate({ type: 'RESUME', lotId: ecoLot.lotId, amountCents: 12000000, date: '2026-06-02', operator: 'U1', basis: { reason: '回款已到，恢复支付' } });
  const paid = ledger.payLot({ lotId: ecoLot.lotId, amountCents: 12000000, date: '2026-06-03', operator: 'U1', reference: 'BK20260603' });
  assert.equal(paid.amountCents, 12000000);
  assert.equal(ledger.journal.lot(ecoLot.lotId).availableCents, 0);
  assert.ok(ledger.journal.verify().ok);
});

test('成员去世继承待定：冻结、解冻后才可支付', () => {
  const { ledger, registry } = buildScenario();
  ledger.receivePayment({ projectId: 'P1', batchId: 'B1', amountCents: 200000000, date: '2026-01-15', operator: 'U1' });
  ledger.accrueAnnual({ period: '2026', date: '2026-02-01', operator: 'U1' });

  registry.markDeath('M2', '2026-05-01');
  const frozen = ledger.freezeForInheritance({ householdId: 'H1', date: '2026-05-01', operator: 'U1', memberId: 'M2' });
  assert.ok(frozen.length >= 2);
  const rentLot = ledger.journal.lot('LOT:RENT:2026:L1:H1');
  assert.equal(rentLot.frozenCents, 60000000);

  // 冻结额不可支付
  assert.throws(() => ledger.payLot({ lotId: rentLot.lotId, amountCents: 100, date: '2026-05-02', operator: 'U1' }), /可付额度/);
  // 不能超额解冻
  assert.throws(
    () => ledger.operate({ type: 'RELEASE', lotId: rentLot.lotId, amountCents: 60000001, date: '2026-05-03', operator: 'U1', basis: { reason: '超理解冻' } }),
    /超过冻结余额/,
  );

  // 继承明确后解冻
  ledger.operate({ type: 'RELEASE', lotId: rentLot.lotId, amountCents: 60000000, date: '2026-05-20', operator: 'U1', basis: { reason: '继承公证完成，由张三继承' } });
  const paid = ledger.payLot({ lotId: rentLot.lotId, amountCents: 60000000, date: '2026-05-21', operator: 'U1' });
  assert.equal(paid.amountCents, 60000000);
  assert.ok(ledger.journal.verify().ok);
});

test('关账后权属更正：红字追回、追补到账，旧账保留且总账平衡', () => {
  const { ledger, registry } = buildScenario();

  // ---- 2026 年业务流水 ----
  ledger.receivePayment({ projectId: 'P1', batchId: 'B1', amountCents: 100000000, date: '2026-01-15', operator: 'U1' });
  ledger.accrueAnnual({ period: '2026', date: '2026-02-01', operator: 'U1' });
  ledger.accrueWage({ recordId: 'W001', projectId: 'P2', householdId: 'H1', amountCents: 5000000, workDate: '2026-02-05', date: '2026-02-10', operator: 'U1' });
  ledger.accrueWage({ recordId: 'W002', projectId: 'P1', householdId: 'H2', amountCents: 3000000, workDate: '2026-02-06', date: '2026-02-10', operator: 'U1' });
  const receiptId = ledger.journal.entries()[0].entryId;
  ledger.distributeDividend({ receiptEntryId: receiptId, projectId: 'P1', period: '2026', amountCents: 80000000, date: '2026-03-01', operator: 'U1' });
  const divLotH2 = `LOT:DIVIDEND:${receiptId}:1:H2`;

  // H2 对分成份额有争议：该批次暂缓
  const disputes = ledger.operate({ type: 'SUSPEND', lotId: divLotH2, amountCents: 32000000, date: '2026-03-05', operator: 'U1', reasonCode: REASON.SHARE_DISPUTE, basis: { reason: '地块份额争议，待调解' } });
  assert.ok(disputes);

  // H2 其余来源照常付清（租金 40 万 + 生态 8 万 + 务工 3 万 = 51 万）
  ledger.payHousehold({ householdId: 'H2', date: '2026-03-10', operator: 'U1' });
  // H1 在资金账额度内部分支付（分成 48 万 + 生态 1 万，共 49 万，恰好用尽首批回款余额）
  ledger.payHousehold({ householdId: 'H1', date: '2026-03-12', operator: 'U1', maxCents: 49000000 });

  // 生态奖励专项回款延迟：H1 生态奖励余 11 万暂缓（H2 已付清，自动无账可暂缓）
  const ecoSuspends = ledger.suspendForReceiptDelay({ projectId: 'P1', period: '2026', sources: [SOURCE.ECO_REWARD], date: '2026-04-01', operator: 'U1' });
  assert.equal(ecoSuspends.length, 1);
  assert.equal(ecoSuspends[0].householdId, 'H1');

  // 后续回款到账，恢复生态奖励并按该批次精确兑付
  ledger.receivePayment({ projectId: 'P1', batchId: 'B2', amountCents: 50000000, date: '2026-06-01', operator: 'U1' });
  ledger.operate({ type: 'RESUME', lotId: 'LOT:ECO_REWARD:2026:L1:H1', amountCents: 11000000, date: '2026-06-05', operator: 'U1', basis: { reason: '延迟回款到账' } });
  ledger.payLot({ lotId: 'LOT:ECO_REWARD:2026:L1:H1', amountCents: 11000000, date: '2026-06-06', operator: 'U1' });

  // P2 回款，付清 H3（跨组）
  ledger.receivePayment({ projectId: 'P2', batchId: 'B3', amountCents: 20000000, date: '2026-09-05', operator: 'U1' });
  ledger.payHousehold({ householdId: 'H3', date: '2026-09-06', operator: 'U1' });

  // 年末项目回款到账，付清 H1 尾欠；H2 争议分成仍挂账
  ledger.receivePayment({ projectId: 'P1', batchId: 'B4', amountCents: 100000000, date: '2026-12-20', operator: 'U1' });
  ledger.payHousehold({ householdId: 'H1', date: '2026-12-21', operator: 'U1' });

  const beforeClose = ledger.journal.trialBalance();
  assert.equal(beforeClose.cashCents, 54000000);
  assert.equal(beforeClose.payableCents, 32000000); // 仅剩争议分成挂账
  assert.equal(beforeClose.suspendedCents, 32000000);

  ledger.closePeriod('2026', 'U1');
  // 关账后拒绝日常分录
  assert.throws(
    () => ledger.accrueWage({ recordId: 'W999', projectId: 'P1', householdId: 'H1', amountCents: 1, workDate: '2026-12-30', date: '2026-12-31', operator: 'U1' }),
    /已关账/,
  );

  // ---- 2027 年 1 月：调解认定 L1 全年份额实为 H1 70% / H2 30% ----
  // 争议分成先恢复，才允许把批次重算到更低的应付
  ledger.operate({ type: 'RESUME', lotId: divLotH2, amountCents: 32000000, date: '2027-01-08', operator: 'U1', basis: { reason: '调解完成，按裁决重算' } });
  // 登记侧切版本：旧份额切止保留，新份额生效
  registry.correctShares({ parcelId: 'L1', allocations: [{ householdId: 'H1', shareBasis: 7000 }, { householdId: 'H2', shareBasis: 3000 }], effectiveFrom: '2026-01-01', reason: '调解裁决：林权证四至复核后 H1 占七成、H2 占三成' });

  // H2 租金、生态奖励已按 40% 多付：未先行红字追回时，更正必须被拒绝
  // （防止旧账出现负应付、失去解释）
  assert.throws(
    () => ledger.correctAnnualAfterSettlement({ parcelId: 'L1', periods: ['2026'], sources: [SOURCE.RENT], date: '2027-01-09', operator: 'U1', reason: '按调解裁决重算' }),
    /应付净额为负|挂账/,
  );
  // 红字追回多付款（现金从农户退回集体资金账，以负额支付表达）
  ledger.payLot({ lotId: 'LOT:RENT:2026:L1:H2', amountCents: -10000000, date: '2027-01-09', operator: 'U1', basis: { reason: '权属更正追回多付租金', channel: '银行代扣' } });
  ledger.payLot({ lotId: 'LOT:ECO_REWARD:2026:L1:H2', amountCents: -2000000, date: '2027-01-09', operator: 'U1', basis: { reason: '权属更正追回多付生态奖励', channel: '银行代扣' } });

  const corrections = ledger.correctAnnualAfterSettlement({ parcelId: 'L1', periods: ['2026'], date: '2027-01-10', operator: 'U1', reason: '按调解裁决重算保底租金与生态奖励' });
  const sumCorrection = corrections.reduce((s, e) => s + e.amountCents, 0);
  assert.equal(sumCorrection, 0); // 地块总额守恒：H1 追补 = H2 转出
  const corrByLot = Object.fromEntries(corrections.map((e) => [e.lotId, e.amountCents]));
  assert.equal(corrByLot['LOT:RENT:2026:L1:H1'], 10000000);
  assert.equal(corrByLot['LOT:RENT:2026:L1:H2'], -10000000);
  assert.equal(corrByLot['LOT:ECO_REWARD:2026:L1:H1'], 2000000);
  assert.equal(corrByLot['LOT:ECO_REWARD:2026:L1:H2'], -2000000);
  assert.ok(corrections.every((e) => e.tag === 'post_close' && e.period === '2026'));

  // 分成批次按新权属重算，批次总额 80 万守恒
  const divCorrections = ledger.recomputeDividendBatch({ receiptEntryId: receiptId, batchNo: 1, date: '2027-01-10', operator: 'U1', reason: '按调解裁决重算碳汇分成批次' });
  assert.equal(divCorrections.reduce((s, e) => s + e.amountCents, 0), 0);
  const divByLot = Object.fromEntries(divCorrections.map((e) => [e.lotId, e.amountCents]));
  assert.equal(divByLot[`LOT:DIVIDEND:${receiptId}:1:H1`], 8000000);
  assert.equal(divByLot[`LOT:DIVIDEND:${receiptId}:1:H2`], -8000000);

  // 追补兑付：H1 合计补 20 万，H2 分成按裁决付 24 万
  const catchUpH1 = ledger.payHousehold({ householdId: 'H1', date: '2027-01-12', operator: 'U1' });
  const catchUpH2 = ledger.payHousehold({ householdId: 'H2', date: '2027-01-12', operator: 'U1' });
  assert.equal(catchUpH1.reduce((s, e) => s + e.amountCents, 0), 20000000);
  assert.equal(catchUpH2.reduce((s, e) => s + e.amountCents, 0), 24000000);

  const finalBalance = ledger.journal.trialBalance();
  assert.equal(finalBalance.payableCents, 0);
  assert.equal(finalBalance.correctionCents, 0); // 更正借贷相抵
  assert.equal(finalBalance.paidCents, 248000000);
  assert.equal(finalBalance.cashCents, finalBalance.retainedCents);
  const verify = ledger.journal.verify();
  assert.deepEqual(verify.problems, []);
});

test('按户回放明细：跨两个项目、每笔可还原依据、指纹稳定', () => {
  const { ledger } = buildScenario();
  ledger.receivePayment({ projectId: 'P1', batchId: 'B1', amountCents: 300000000, date: '2026-01-15', operator: 'U1' });
  ledger.accrueAnnual({ period: '2026', date: '2026-02-01', operator: 'U1' });
  ledger.accrueWage({ recordId: 'W001', projectId: 'P2', householdId: 'H1', amountCents: 5000000, workDate: '2026-02-05', date: '2026-02-10', operator: 'U1' });
  const receiptId = ledger.journal.entries()[0].entryId;
  ledger.distributeDividend({ receiptEntryId: receiptId, projectId: 'P1', period: '2026', amountCents: 80000000, date: '2026-03-01', operator: 'U1' });
  // P2 回款覆盖务工与租金
  ledger.receivePayment({ projectId: 'P2', batchId: 'B2', amountCents: 50000000, date: '2026-03-02', operator: 'U1' });
  ledger.payHousehold({ householdId: 'H1', date: '2026-03-10', operator: 'U1' });

  const statement = buildHouseholdStatement(ledger, { householdId: 'H1' });

  // 跨两个项目
  const projects = new Set(statement.lots.map((l) => l.projectId));
  assert.ok(projects.has('P1') && projects.has('P2'));

  // 四类来源齐全
  const sources = new Set(statement.lots.map((l) => l.source));
  assert.deepEqual([...sources].sort(), ['DIVIDEND', 'ECO_REWARD', 'RENT', 'WAGE'].sort());

  // 每笔计提都带结构化计算依据
  const rentLot = statement.lots.find((l) => l.lotId === 'LOT:RENT:2026:L1:H1');
  const accrual = rentLot.timeline.find((t) => t.type === 'ACCRUAL');
  assert.equal(accrual.basis.kind, 'annual_proration');
  assert.ok(accrual.basis.segments.length > 0);
  assert.equal(typeof accrual.basis.formula, 'string');
  assert.ok(/^[0-9a-f]{64}$/.test(accrual.entryHash));

  // 汇总恒等：计提 - 支付 = 未付；本户已付清
  assert.equal(statement.total.paidCents, statement.total.accruedCents);
  assert.equal(statement.total.outstandingCents, 0);
  assert.equal(statement.verification.ledgerBalanced, true);

  // 指纹与链头可复核：重复出具结果一致
  const again = buildHouseholdStatement(ledger, { householdId: 'H1' });
  assert.equal(again.verification.statementFingerprint, statement.verification.statementFingerprint);
  assert.equal(again.verification.headEntryHash, statement.verification.headEntryHash);

  // 按期间过滤
  const only2026 = buildHouseholdStatement(ledger, { householdId: 'H1', period: '2026' });
  assert.ok(only2026.lots.every((l) => l.period === '2026'));
});

test('跨结算期回款迟到：旧期未关账时按迟到记账补录分成并兑付', () => {
  const { ledger } = buildScenario();
  // 2026 年内先把保底租金计提并付清（回款充足）
  ledger.receivePayment({ projectId: 'P1', batchId: 'B1', amountCents: 200000000, date: '2026-02-01', operator: 'U1' });
  ledger.accrueAnnual({ period: '2026', sources: [SOURCE.RENT], date: '2026-02-05', operator: 'U1' });
  ledger.payHousehold({ householdId: 'H1', date: '2026-03-01', operator: 'U1', sources: [SOURCE.RENT] });
  ledger.payHousehold({ householdId: 'H2', date: '2026-03-01', operator: 'U1', sources: [SOURCE.RENT] });

  // 经营分成回款延迟到 2027 年 1 月才到，但 2026 期尚未关账：
  // 回款按归属期间 2026 迟到入账，分成批次同样追入 2026 期
  const lateReceipt = ledger.receivePayment({
    projectId: 'P1', batchId: 'B2', amountCents: 100000000, date: '2027-01-10', operator: 'U1', period: '2026',
  });
  assert.equal(lateReceipt.period, '2026');
  assert.equal(lateReceipt.basis.lateBooking, true);

  // 未声明迟到记账时，跨年期间的分录在账内核验层必须被拒
  assert.throws(
    () =>
      ledger.journal.append({
        timestamp: '2027-01-10',
        period: '2026',
        type: 'RECEIPT',
        source: null,
        projectId: 'P1',
        groupId: null,
        householdId: null,
        lotId: null,
        amountCents: 1,
        basis: { kind: 'project_receipt', batchId: 'BX' },
        operator: 'U1',
        tag: null,
      }),
    /所属年份不一致/,
  );

  const dividend = ledger.distributeDividend({ receiptEntryId: lateReceipt.entryId, projectId: 'P1', period: '2026', amountCents: 80000000, date: '2027-01-12', operator: 'U1' });
  assert.equal(dividend.every((e) => e.period === '2026'), true);
  assert.equal(dividend[0].basis.lateBooking, true);
  // 操作时间在 2027，但兑付的是 2026 期批次
  const paid = ledger.payHousehold({ householdId: 'H1', date: '2027-01-15', operator: 'U1', sources: [SOURCE.DIVIDEND] });
  assert.equal(paid.reduce((s, e) => s + e.amountCents, 0), 48000000);
  assert.equal(paid.every((e) => e.period === '2027'), true); // 支付分录按操作期入账
  assert.ok(ledger.journal.verify().ok);

  // 此时关账 2026 仍合法；关账后同样的补录被拒，只能走 post_close 更正
  ledger.closePeriod('2026', 'U1');
  assert.throws(
    () => ledger.distributeDividend({ receiptEntryId: lateReceipt.entryId, projectId: 'P1', period: '2026', amountCents: 100, date: '2027-02-01', operator: 'U1' }),
    /已关账/,
  );
});

test('旧期未关账、次年裁决更正：走迟到更正（非 post_close），差额追补平衡', () => {
  const { ledger, registry } = buildScenario();
  ledger.receivePayment({ projectId: 'P1', batchId: 'B1', amountCents: 200000000, date: '2026-02-01', operator: 'U1' });
  ledger.accrueAnnual({ period: '2026', sources: [SOURCE.RENT], date: '2026-02-05', operator: 'U1' });
  ledger.payHousehold({ householdId: 'H2', date: '2026-03-01', operator: 'U1', sources: [SOURCE.RENT] });

  // 次年裁决：H1 70% / H2 30%，2026 期尚未关账
  registry.correctShares({
    parcelId: 'L1',
    allocations: [{ householdId: 'H1', shareBasis: 7000 }, { householdId: 'H2', shareBasis: 3000 }],
    effectiveFrom: '2026-01-01',
    reason: '次年裁决',
  });
  ledger.payLot({ lotId: 'LOT:RENT:2026:L1:H2', amountCents: -10000000, date: '2027-01-09', operator: 'U1', basis: { reason: '追回多付租金' } });
  const corrections = ledger.correctAnnualAfterSettlement({ parcelId: 'L1', periods: ['2026'], sources: [SOURCE.RENT], date: '2027-01-10', operator: 'U1', reason: '裁决重算' });
  assert.equal(corrections.reduce((s, e) => s + e.amountCents, 0), 0);
  // 旧期未关账：不是 post_close，而是迟到更正标记
  assert.deepEqual(corrections.map((e) => e.tag), [null, null]);
  assert.deepEqual(corrections.map((e) => e.basis.lateBooking), [true, true]);
  assert.deepEqual(corrections.map((e) => e.period), ['2026', '2026']);
  ledger.payHousehold({ householdId: 'H1', date: '2027-01-12', operator: 'U1' });
  const h1Statement = buildHouseholdStatement(ledger, { householdId: 'H1' });
  assert.equal(h1Statement.total.outstandingCents, 0); // H1 已全部结清
  assert.ok(ledger.journal.verify().ok);
});

test('九十万亩量级：BigInt 权重精确分摊，总账仍然平衡', () => {
  const registry = createRegistry();
  registry.addGroup({ groupId: 'G1', name: '测试村' });
  registry.addProject({ projectId: 'P1', name: '超大林场', sources: [SOURCE.RENT, SOURCE.ECO_REWARD, SOURCE.DIVIDEND] });
  registry.addHousehold({ householdId: 'H1', groupId: 'G1', headName: '甲' });
  registry.addParcel({ parcelId: 'BIG', projectId: 'P1', areaMu: '900000', annualRentCentsPerMu: 10000 });
  registry.grantShare({ parcelId: 'BIG', householdId: 'H1', shareBasis: 10000, from: '2026-01-01' });

  const ledger = createLedger(registry);
  const created = ledger.accrueAnnual({ period: '2026', sources: [SOURCE.RENT], date: '2026-12-31', operator: 'U1' });
  // 90 万亩 × 100 元/亩 = 9000 万元 = 90 亿分
  assert.equal(created[0].amountCents, 9000000000);
  assert.ok(ledger.journal.verify().ok);
});
