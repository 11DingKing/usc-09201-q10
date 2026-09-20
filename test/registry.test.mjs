import assert from 'node:assert/strict';
import test from 'node:test';

import { SOURCE } from '../src/domain/catalog.mjs';
import { createRegistry } from '../src/domain/registry.mjs';
import { createLedger } from '../src/domain/ledger.mjs';

function base() {
  const registry = createRegistry();
  registry.addGroup({ groupId: 'G1', name: '村' });
  registry.addProject({ projectId: 'P1', name: '项目', sources: [SOURCE.RENT] });
  registry.addHousehold({ householdId: 'H1', groupId: 'G1', headName: '甲' });
  registry.addHousehold({ householdId: 'H2', groupId: 'G1', headName: '乙' });
  registry.addParcel({ parcelId: 'L1', projectId: 'P1', areaMu: '10000', annualRentCentsPerMu: 10000 });
  return registry;
}

test('年中流转：切止旧份额、新份额生效，全年按日分摊且总额守恒', () => {
  const registry = base();
  registry.grantShare({ parcelId: 'L1', householdId: 'H1', shareBasis: 10000, from: '2026-01-01' });
  // 7 月起一半流转给 H2
  registry.transferShares({
    parcelId: 'L1',
    allocations: [
      { householdId: 'H1', shareBasis: 5000 },
      { householdId: 'H2', shareBasis: 5000 },
    ],
    effectiveFrom: '2026-07-01',
    reason: '年中流转',
  });
  // 7-12 月任一时点份额合计恰好 100%
  const at = registry.sharesAt('L1', '2026-08-01');
  assert.equal(at.reduce((s, x) => s + x.shareBasis, 0), 10000);
  const before = registry.sharesAt('L1', '2026-03-01');
  assert.deepEqual(before.map((x) => x.householdId), ['H1']);

  // 全年租金计提：总额仍为 100 万，户间按天数切分
  const ledger = createLedger(registry);
  const created = ledger.accrueAnnual({ period: '2026', sources: [SOURCE.RENT], date: '2027-01-05', operator: 'U1' });
  assert.equal(created.reduce((s, e) => s + e.amountCents, 0), 100000000);
  assert.equal(created.every((e) => e.basis.lateBooking === true), true);
});

test('年中已流转后又追溯更正到年初：旧版本正确切止，不双算、不超额', () => {
  const registry = base();
  registry.grantShare({ parcelId: 'L1', householdId: 'H1', shareBasis: 10000, from: '2026-01-01' });
  registry.transferShares({
    parcelId: 'L1',
    allocations: [
      { householdId: 'H1', shareBasis: 6000 },
      { householdId: 'H2', shareBasis: 4000 },
    ],
    effectiveFrom: '2026-07-01',
    reason: '年中流转',
  });
  // 年底裁决：全年都应是 H1 70% / H2 30%（追溯到年初）
  registry.correctShares({
    parcelId: 'L1',
    allocations: [
      { householdId: 'H1', shareBasis: 7000 },
      { householdId: 'H2', shareBasis: 3000 },
    ],
    effectiveFrom: '2026-01-01',
    reason: '裁决更正',
  });

  // 任意时点份额合计恰好 100%，且只有 H1/H2 两条有效版本
  for (const date of ['2026-01-01', '2026-03-01', '2026-07-01', '2026-08-01', '2026-12-31']) {
    const at = registry.sharesAt('L1', date);
    assert.equal(at.reduce((s, x) => s + x.shareBasis, 0), 10000, `${date} 份额合计应为 100%`);
    assert.equal(at.length, 2, `${date} 应有两条有效权属`);
    assert.equal(at.find((x) => x.householdId === 'H1').shareBasis, 7000);
    assert.equal(at.find((x) => x.householdId === 'H2').shareBasis, 3000);
  }

  // 重算全年租金：H1 70 万、H2 30 万，合计 100 万
  const ledger = createLedger(registry);
  const created = ledger.accrueAnnual({ period: '2026', sources: [SOURCE.RENT], date: '2027-01-05', operator: 'U1' });
  const byHousehold = Object.fromEntries(created.map((e) => [e.householdId, e.amountCents]));
  assert.equal(byHousehold.H1, 70000000);
  assert.equal(byHousehold.H2, 30000000);
  assert.equal(created.reduce((s, e) => s + e.amountCents, 0), 100000000);
});
