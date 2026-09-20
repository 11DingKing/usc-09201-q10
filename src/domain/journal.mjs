// 只追加分录账（append-only journal）。
// 任何调整都只能以新分录表达：暂缓、追补、纠错、冻结、解冻均不修改历史。
// 全部余额（资金账、到户应付、冻结/暂缓额度）都由分录序列投影得到，可随时重放核验。

import { ENTRY, REASON } from './catalog.mjs';
import { canonicalJson, sha256Hex } from './hash.mjs';
import { assertDate, periodOf } from './time.mjs';

const LOT_TYPES = new Set([
  ENTRY.ACCRUAL,
  ENTRY.CORRECTION,
  ENTRY.PAYMENT,
  ENTRY.FREEZE,
  ENTRY.RELEASE,
  ENTRY.SUSPEND,
  ENTRY.RESUME,
]);

const REQUIRE_REASON = new Set([ENTRY.FREEZE, ENTRY.SUSPEND]);
const BLOCK_TYPES = new Set([ENTRY.FREEZE, ENTRY.SUSPEND]);
const UNBLOCK_TYPES = new Set([ENTRY.RELEASE, ENTRY.RESUME]);

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field}不能为空`);
  }
  return value;
}

// 分录参与哈希的负载字段（不含 seq/prevHash/entryHash 自身）
function payloadOf(draft) {
  return {
    timestamp: draft.timestamp,
    period: draft.period,
    type: draft.type,
    source: draft.source ?? null,
    reasonCode: draft.reasonCode ?? null,
    projectId: draft.projectId ?? null,
    groupId: draft.groupId ?? null,
    householdId: draft.householdId ?? null,
    lotId: draft.lotId ?? null,
    linkEntryId: draft.linkEntryId ?? null,
    idempotencyKey: draft.idempotencyKey ?? null,
    tag: draft.tag ?? null,
    amountCents: draft.amountCents,
    basis: draft.basis ?? null,
    operator: draft.operator ?? null,
  };
}

export function createJournal() {
  const entries = [];
  const idempotency = new Map(); // idempotencyKey -> entryId
  const entryIds = new Set();
  const closes = new Map(); // period -> { at, by }
  const listeners = [];

  const state = {
    cashCents: 0, // 村集体资金账余额
    receipts: new Map(), // projectId -> cents
    lots: new Map(), // lotId -> 投影
    accruedByProject: new Map(), // projectId -> cents
  };

  function lot(lotId) {
    if (!state.lots.has(lotId)) {
      state.lots.set(lotId, {
        lotId,
        householdId: null,
        groupId: null,
        projectId: null,
        source: null,
        period: null,
        open: true,
        accruedCents: 0,
        correctionCents: 0,
        paidCents: 0,
        frozenCents: 0,
        suspendedCents: 0,
      });
    }
    return state.lots.get(lotId);
  }

  function validate(draft) {
    requireString(draft.type, '分录类型');
    if (!Object.values(ENTRY).includes(draft.type)) {
      throw new Error(`未知分录类型：${draft.type}`);
    }
    assertDate(draft.timestamp, '分录时间');
    requireString(draft.period, '结算期');
    // 计提与回款按业务发生期入账；到户操作（支付/冻结/解冻/暂缓/恢复）按实际操作期入账，
    // 允许在新的一年处理旧期挂账；更正分录以被更正期间入账，跨期须打 post_close 标记。
    const OPERATING_TYPES = new Set([
      ENTRY.PAYMENT,
      ENTRY.FREEZE,
      ENTRY.RELEASE,
      ENTRY.SUSPEND,
      ENTRY.RESUME,
    ]);
    const stampPeriod = periodOf(draft.timestamp);
    if (draft.type === ENTRY.CLOSE_PERIOD) {
      if (draft.period > stampPeriod) throw new Error('不能关账未来期间');
    } else if (OPERATING_TYPES.has(draft.type)) {
      if (draft.period !== stampPeriod) {
        throw new Error(`${draft.type} 分录期间必须是操作时间所属期间 ${stampPeriod}`);
      }
    } else if (draft.period !== stampPeriod && draft.tag !== 'post_close' && draft.basis?.lateBooking !== true) {
      throw new Error(
        `分录期间 ${draft.period} 与入账时间 ${draft.timestamp} 所属年份不一致（迟到记账须在 basis.lateBooking 声明，关账后须用 post_close 更正）`,
      );
    }
    if (!Number.isInteger(draft.amountCents)) {
      throw new Error('金额必须是整数分');
    }
    requireString(draft.operator, '经办人');
    if (draft.basis !== null && typeof draft.basis !== 'object') {
      throw new Error('计算依据必须是结构化快照');
    }
    if (draft.idempotencyKey != null) {
      requireString(draft.idempotencyKey, '幂等键');
    }
    if (draft.linkEntryId != null) {
      requireString(draft.linkEntryId, '关联分录');
      if (!entryIds.has(draft.linkEntryId)) {
        throw new Error(`关联分录不存在：${draft.linkEntryId}`);
      }
    }
    if (REQUIRE_REASON.has(draft.type)) {
      if (!Object.values(REASON).includes(draft.reasonCode)) {
        throw new Error(`${draft.type} 分录必须注明原因`);
      }
    }
    if (LOT_TYPES.has(draft.type)) {
      requireString(draft.householdId, '到户分录缺少户编号');
      requireString(draft.lotId, '到户分录缺少应付批次');
      requireString(draft.groupId, '到户分录缺少村组');
    }
    if (draft.type === ENTRY.RECEIPT) {
      requireString(draft.projectId, '回款分录缺少项目');
      if (draft.amountCents <= 0) throw new Error('回款金额必须为正');
    }
    if (draft.type === ENTRY.CLOSE_PERIOD) {
      if (draft.amountCents !== 0) throw new Error('关账分录金额必须为零');
      if (!/^\d{4}$/.test(draft.period)) throw new Error(`关账期间必须是四位年份：${draft.period}`);
    }
    if (draft.type === ENTRY.ACCRUAL) {
      if (draft.amountCents < 0) throw new Error('计提金额不能为负，冲减请使用 CORRECTION');
    }
    if (draft.type === ENTRY.CORRECTION) {
      if (draft.amountCents === 0) throw new Error('更正金额不能为零');
      if (!draft.linkEntryId && draft.basis?.standalone !== true) {
        throw new Error('更正分录必须关联原计提/更正分录（无原账时须在 basis.standalone 声明）');
      }
    }
    if ([ENTRY.CORRECTION, ENTRY.PAYMENT].includes(draft.type)) {
      if (!draft.basis || typeof draft.basis.reason !== 'string' || draft.basis.reason.trim() === '') {
        throw new Error(`${draft.type} 分录必须在 basis.reason 中说明事由`);
      }
    }
    if (UNBLOCK_TYPES.has(draft.type) && draft.amountCents <= 0) {
      throw new Error(`${draft.type} 金额必须为正`);
    }
  }

  function assertPeriodOpen(draft) {
    if (!closes.has(draft.period)) return;
    if (draft.type === ENTRY.CORRECTION && draft.tag === 'post_close') return; // 关账后只允许追加分录更正
    throw new Error(`结算期 ${draft.period} 已关账，只能通过 CORRECTION（tag=post_close）追加分录处理`);
  }

  function apply(entry) {
    const t = entry.type;
    if (t === ENTRY.CLOSE_PERIOD) {
      closes.set(entry.period, { at: entry.timestamp, by: entry.operator, entryId: entry.entryId });
      return;
    }
    if (t === ENTRY.RECEIPT) {
      state.cashCents += entry.amountCents;
      state.receipts.set(entry.projectId, (state.receipts.get(entry.projectId) ?? 0) + entry.amountCents);
      return;
    }
    const l = lot(entry.lotId);
    if (t === ENTRY.ACCRUAL) {
      if (l.householdId === null) {
        Object.assign(l, {
          householdId: entry.householdId,
          groupId: entry.groupId,
          projectId: entry.projectId,
          source: entry.source,
          period: entry.period,
        });
      }
      l.accruedCents += entry.amountCents;
      state.accruedByProject.set(
        entry.projectId,
        (state.accruedByProject.get(entry.projectId) ?? 0) + entry.amountCents,
      );
    } else if (t === ENTRY.CORRECTION) {
      if (l.householdId === null) {
        // 新户因权属更正首次获得该来源应付：以更正分录入账
        Object.assign(l, {
          householdId: entry.householdId,
          groupId: entry.groupId,
          projectId: entry.projectId,
          source: entry.source,
          period: entry.period,
        });
      }
      l.correctionCents += entry.amountCents;
      const afterCorrection = l.accruedCents + l.correctionCents - l.paidCents;
      if (afterCorrection < 0) {
        throw new Error(
          `更正后 ${entry.lotId} 应付净额为负（${afterCorrection} 分）：已付部分须先以红字支付追回，再做更正`,
        );
      }
      if (afterCorrection < l.frozenCents + l.suspendedCents) {
        throw new Error(
          `更正后 ${entry.lotId} 应付净额 ${afterCorrection} 分小于挂账 ${l.frozenCents + l.suspendedCents} 分：请先解冻/恢复挂账再更正`,
        );
      }
      state.accruedByProject.set(
        entry.projectId,
        (state.accruedByProject.get(entry.projectId) ?? 0) + entry.amountCents,
      );
    } else if (t === ENTRY.PAYMENT) {
      const outstanding = l.accruedCents + l.correctionCents - l.paidCents;
      const blocked = l.frozenCents + l.suspendedCents;
      if (entry.amountCents > 0) {
        if (entry.amountCents > outstanding - blocked) {
          throw new Error(
            `支付 ${entry.amountCents} 分超过可付额度 ${Math.max(0, outstanding - blocked)} 分（应付批次 ${entry.lotId}）`,
          );
        }
        if (entry.amountCents > state.cashCents) {
          throw new Error('资金账余额不足，不能支付');
        }
      } else if (-entry.amountCents > l.paidCents) {
        throw new Error(`追回金额不能超过已付 ${l.paidCents} 分（应付批次 ${entry.lotId}）`);
      }
      l.paidCents += entry.amountCents;
      state.cashCents -= entry.amountCents;
    } else if (BLOCK_TYPES.has(t)) {
      if (entry.amountCents <= 0) throw new Error('冻结/暂缓金额必须为正');
      const outstanding = l.accruedCents + l.correctionCents - l.paidCents;
      const blocked = l.frozenCents + l.suspendedCents;
      if (entry.amountCents > outstanding - blocked) {
        throw new Error(
          `${t} ${entry.amountCents} 分超过未挂账余额 ${Math.max(0, outstanding - blocked)} 分`,
        );
      }
      if (t === ENTRY.FREEZE) l.frozenCents += entry.amountCents;
      else l.suspendedCents += entry.amountCents;
    } else if (UNBLOCK_TYPES.has(t)) {
      if (t === ENTRY.RELEASE) {
        if (entry.amountCents > l.frozenCents) {
          throw new Error(`解冻 ${entry.amountCents} 分超过冻结余额 ${l.frozenCents} 分`);
        }
        l.frozenCents -= entry.amountCents;
      } else {
        if (entry.amountCents > l.suspendedCents) {
          throw new Error(`恢复 ${entry.amountCents} 分超过暂缓余额 ${l.suspendedCents} 分`);
        }
        l.suspendedCents -= entry.amountCents;
      }
    }
  }

  function append(draft) {
    validate(draft);
    if (draft.idempotencyKey != null && idempotency.has(draft.idempotencyKey)) {
      const existing = entries.find((e) => e.entryId === idempotency.get(draft.idempotencyKey));
      return { entry: existing, duplicate: true };
    }
    assertPeriodOpen(draft);

    const seq = entries.length + 1;
    const prevHash = entries.length ? entries[entries.length - 1].entryHash : '0'.repeat(64);
    const payload = payloadOf(draft);
    const entryHash = sha256Hex(`${prevHash}:${canonicalJson({ seq, ...payload })}`);
    const entry = {
      seq,
      entryId: draft.entryId ?? `JE-${String(seq).padStart(8, '0')}`,
      prevHash,
      entryHash,
      ...payload,
    };
    if (entryIds.has(entry.entryId)) {
      throw new Error(`分录编号重复：${entry.entryId}`);
    }
    apply(entry); // 余额校验失败则整条拒绝，账内不留痕
    entries.push(entry);
    entryIds.add(entry.entryId);
    if (entry.idempotencyKey) idempotency.set(entry.idempotencyKey, entry.entryId);
    for (const fn of listeners) fn(entry);
    return { entry, duplicate: false };
  }

  function closePeriod(period, operator, options = {}) {
    if (closes.has(period)) throw new Error(`结算期 ${period} 已关账`);
    const stamp = options.date ?? `${period}-12-31`;
    return append({
      timestamp: stamp,
      period,
      type: ENTRY.CLOSE_PERIOD,
      source: null,
      projectId: null,
      groupId: null,
      householdId: null,
      lotId: null,
      amountCents: 0,
      basis: { kind: 'period_close', note: options.note ?? '' },
      operator,
      tag: null,
    }).entry;
  }

  function isClosed(period) {
    return closes.has(period);
  }

  function lotView(lotId) {
    const l = state.lots.get(lotId);
    if (!l) return null;
    const outstanding = l.accruedCents + l.correctionCents - l.paidCents;
    const payable = Math.max(0, outstanding);
    const overpaid = Math.max(0, -outstanding);
    const available = Math.max(0, outstanding - l.frozenCents - l.suspendedCents);
    return { ...l, outstandingCents: outstanding, payableCents: payable, overpaidCents: overpaid, availableCents: available };
  }

  function trialBalance() {
    let accrued = 0;
    let correction = 0;
    let paid = 0;
    let frozen = 0;
    let suspended = 0;
    for (const l of state.lots.values()) {
      accrued += l.accruedCents;
      correction += l.correctionCents;
      paid += l.paidCents;
      frozen += l.frozenCents;
      suspended += l.suspendedCents;
    }
    let receipts = 0;
    for (const v of state.receipts.values()) receipts += v;
    const payable = accrued + correction - paid;
    const unblocked = payable - frozen - suspended; // 未挂账可付额（可能大于资金账余额）
    return {
      cashCents: state.cashCents,
      receiptsCents: receipts,
      accruedCents: accrued,
      correctionCents: correction,
      paidCents: paid,
      payableCents: payable, // 到户应付净额
      frozenCents: frozen,
      suspendedCents: suspended,
      availableCents: Math.max(0, unblocked),
      cashShortfallCents: Math.max(0, unblocked - state.cashCents), // 应付已挂账、等后续回款的资金缺口
      retainedCents: state.cashCents - payable, // 已回未分为正；为负表示回款不足
    };
  }

  // 恒等式校验 + 哈希链重放（重放簿不带关账状态，post_close 更正可直接追入）
  // 校验链并返回重放簿；不额外检查余额恒等式时供加载使用
  function replay(problems) {
    const fresh = createJournal();
    let prev = '0'.repeat(64);
    for (const [index, e] of [...entries].sort((a, b) => a.seq - b.seq).entries()) {
      if (e.seq !== index + 1) problems.push(`序号不连续：${e.seq}`);
      if (e.prevHash !== prev) problems.push(`分录 ${e.entryId} 前链断裂`);
      const expect = sha256Hex(`${e.prevHash}:${canonicalJson({ seq: e.seq, ...payloadOf(e) })}`);
      if (expect !== e.entryHash) problems.push(`分录 ${e.entryId} 内容哈希不符`);
      prev = e.entryHash;
      try {
        fresh.append({ ...payloadOf(e), entryId: e.entryId });
      } catch (error) {
        problems.push(`分录 ${e.entryId} 重放失败：${error.message}`);
      }
    }
    return fresh;
  }

  function verify() {
    const problems = [];
    const fresh = replay(problems);
    const a = trialBalance();
    const b = fresh.trialBalance();
    for (const key of Object.keys(a)) {
      if (a[key] !== b[key]) problems.push(`重放余额不一致：${key} ${a[key]} != ${b[key]}`);
    }
    // 会计恒等式：资金账 = 回款 - 支付；应付 = 计提 + 更正 - 支付
    if (a.cashCents !== a.receiptsCents - a.paidCents) {
      problems.push('资金账余额与 回款-支付 不符');
    }
    if (a.payableCents !== a.accruedCents + a.correctionCents - a.paidCents) {
      problems.push('应付净额与 计提+更正-支付 不符');
    }
    return { ok: problems.length === 0, problems, head: entries.at(-1)?.entryHash ?? '0'.repeat(64) };
  }

  function snapshot() {
    return { version: 1, entries: entries.map((e) => ({ ...e })) };
  }

  return {
    append,
    closePeriod,
    isClosed,
    lotView,
    trialBalance,
    verify,
    snapshot,
    entries: () => entries.map((e) => ({ ...e })),
    lots: () => [...state.lots.keys()].map(lotView),
    lot: lotView,
    cashBalance: () => state.cashCents,
    receipts: () => Object.fromEntries(state.receipts),
    closedPeriods: () => new Map(closes),
    onAppend: (fn) => listeners.push(fn),
  };
}

// 从快照（分录序列）重建账本：逐笔重放并校验哈希链；链或余额有误直接拒绝。
export function loadJournal(snapshot) {
  const journal = createJournal();
  const ordered = [...snapshot.entries].sort((a, b) => a.seq - b.seq);
  let prev = '0'.repeat(64);
  ordered.forEach((e, index) => {
    if (e.seq !== index + 1) throw new Error(`序号不连续：${e.seq}`);
    if (e.prevHash !== prev) throw new Error(`分录 ${e.entryId} 前链断裂`);
    const expect = sha256Hex(`${e.prevHash}:${canonicalJson({ seq: e.seq, ...payloadOf(e) })}`);
    if (expect !== e.entryHash) throw new Error(`分录 ${e.entryId} 内容哈希不符`);
    prev = e.entryHash;
    journal.append({ ...payloadOf(e), entryId: e.entryId });
  });
  const check = journal.verify();
  if (!check.ok) throw new Error(`账本快照重放不平衡：${check.problems.join('；')}`);
  return journal;
}
