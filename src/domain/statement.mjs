// 按户可核验明细（回放单）。
// 每一笔到账、冻结/解冻、暂缓/恢复、追补更正都列出计算依据，
// 并给出分录哈希链头与明细指纹，农户可凭此在经管站逐笔复核、还原总账。

import { ENTRY, REASON_LABELS, SOURCE_LABELS } from './catalog.mjs';
import { canonicalJson, sha256Hex } from './hash.mjs';
import { centsToYuan } from './money.mjs';

const ENTRY_LABELS = {
  RECEIPT: '项目回款',
  ACCRUAL: '计提应付',
  CORRECTION: '追补/纠错',
  PAYMENT: '到户支付',
  FREEZE: '冻结',
  RELEASE: '解冻',
  SUSPEND: '暂缓',
  RESUME: '恢复',
};

// 对外展示时的带符号金额（分）：计提/解冻/恢复为 +，支付按资金方向，挂账与更正按实际方向
function signedAmount(entry) {
  switch (entry.type) {
    case ENTRY.ACCRUAL:
    case ENTRY.RELEASE:
    case ENTRY.RESUME:
      return entry.amountCents;
    case ENTRY.CORRECTION:
      return entry.amountCents; // 追补为正、转出为负
    case ENTRY.PAYMENT:
      return -entry.amountCents; // 资金离开集体账；红字追回为正（amount 为负时整体回正）
    case ENTRY.FREEZE:
    case ENTRY.SUSPEND:
      return -entry.amountCents;
    default:
      return entry.amountCents;
  }
}

export function buildHouseholdStatement(ledger, { householdId, period = null }) {
  const registry = ledger.registry;
  const journal = ledger.journal;
  const household = registry.getHousehold(householdId);
  if (!household) throw new Error(`农户不存在：${householdId}`);

  const entries = journal
    .entries()
    .filter((e) => e.householdId === householdId)
    .filter((e) => period === null || e.period === period)
    .sort((a, b) => a.seq - b.seq);

  // 按 lot 汇总时间线与当前状态
  const lotMap = new Map();
  for (const entry of entries) {
    if (!lotMap.has(entry.lotId)) {
      lotMap.set(entry.lotId, {
        lotId: entry.lotId,
        source: entry.source,
        sourceLabel: SOURCE_LABELS[entry.source] ?? entry.source,
        projectId: entry.projectId,
        period: entry.period,
        timeline: [],
      });
    }
    const lot = lotMap.get(entry.lotId);
    lot.timeline.push({
      seq: entry.seq,
      entryId: entry.entryId,
      type: entry.type,
      typeLabel: ENTRY_LABELS[entry.type] ?? entry.type,
      timestamp: entry.timestamp,
      amountCents: entry.amountCents,
      signedCents: signedAmount(entry),
      amountYuan: centsToYuan(entry.amountCents),
      reasonCode: entry.reasonCode,
      reasonLabel: entry.reasonCode ? REASON_LABELS[entry.reasonCode] ?? entry.reasonCode : null,
      linkEntryId: entry.linkEntryId,
      idempotencyKey: entry.idempotencyKey,
      tag: entry.tag,
      operator: entry.operator,
      basis: entry.basis,
      entryHash: entry.entryHash,
      prevHash: entry.prevHash,
    });
  }

  const lots = [];
  const totals = {};
  for (const lot of lotMap.values()) {
    const view = journal.lot(lot.lotId);
    const snapshot = {
      ...lot,
      accruedCents: view.accruedCents,
      correctionCents: view.correctionCents,
      paidCents: view.paidCents,
      frozenCents: view.frozenCents,
      suspendedCents: view.suspendedCents,
      outstandingCents: view.outstandingCents,
      availableCents: view.availableCents,
    };
    lots.push(snapshot);
    const t = (totals[lot.source] ??= { accruedCents: 0, correctionCents: 0, paidCents: 0, frozenCents: 0, suspendedCents: 0, outstandingCents: 0, availableCents: 0 });
    t.accruedCents += view.accruedCents;
    t.correctionCents += view.correctionCents;
    t.paidCents += view.paidCents;
    t.frozenCents += view.frozenCents;
    t.suspendedCents += view.suspendedCents;
    t.outstandingCents += view.outstandingCents;
    t.availableCents += view.availableCents;
  }
  lots.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : a.lotId < b.lotId ? -1 : 1));

  const totalRow = Object.values(totals).reduce(
    (acc, t) => {
      for (const key of Object.keys(acc)) acc[key] += t[key];
      return acc;
    },
    { accruedCents: 0, correctionCents: 0, paidCents: 0, frozenCents: 0, suspendedCents: 0, outstandingCents: 0, availableCents: 0 },
  );
  for (const t of Object.values(totals)) {
    for (const key of ['accruedCents', 'correctionCents', 'paidCents', 'frozenCents', 'suspendedCents', 'outstandingCents', 'availableCents']) {
      t[`${key.slice(0, -5)}Yuan`] = centsToYuan(t[key]);
    }
  }
  for (const key of Object.keys(totalRow)) totalRow[`${key.slice(0, -5)}Yuan`] = centsToYuan(totalRow[key]);

  const verify = journal.verify();
  // 指纹只覆盖本户相关分录的关键字段 + 链头；任一字段被改动指纹即变
  const fingerprintPayload = {
    householdId,
    period: period ?? 'ALL',
    head: verify.head,
    rows: entries.map((e) => ({
      seq: e.seq,
      entryId: e.entryId,
      lotId: e.lotId,
      type: e.type,
      amountCents: e.amountCents,
      timestamp: e.timestamp,
      period: e.period,
      basis: e.basis,
      entryHash: e.entryHash,
    })),
  };
  const fingerprint = sha256Hex(canonicalJson(fingerprintPayload));

  return {
    household,
    period: period ?? 'ALL',
    generatedAt: new Date().toISOString(),
    lots,
    totalsBySource: Object.fromEntries(
      Object.entries(totals).map(([source, t]) => [source, { ...t, sourceLabel: SOURCE_LABELS[source] ?? source }]),
    ),
    total: totalRow,
    verification: {
      ledgerBalanced: verify.ok,
      problems: verify.problems,
      headEntryHash: verify.head,
      statementFingerprint: fingerprint,
      algorithm: 'SHA-256 over canonical JSON of household rows + ledger head',
    },
  };
}
