// 分配账门面：在登记数据与只追加分录账之上，
// 以“权属有效期 × 收益来源”生成应付分录，并组织暂缓、追补、冻结、纠错。
// 所有写操作最终都调用 journal.append，历史不可变。

import { ENTRY, REASON, SOURCE } from './catalog.mjs';
import { canonicalJson, sha256Hex } from './hash.mjs';
import { createJournal } from './journal.mjs';
import { largestRemainder, divideHalfUp } from './money.mjs';
import { overlapDays, periodRange, yearDays } from './time.mjs';

const SHARE_DENOM = 10000;
const AREA_DENOM = 1000; // 毫亩 -> 亩

export function createLedger(registry, journal = createJournal()) {
  // ---- 回款：项目回款入资金账，支持分批，batchId 幂等 ----
  // 回款晚到（次年才到、但归属期间尚未关账）时传 period，按迟到记账追入旧期。
  function receivePayment({ projectId, batchId, amountCents, date, operator, period = null, note = '' }) {
    const project = registry.getProject(projectId);
    if (!project) throw new Error(`项目不存在：${projectId}`);
    const stampPeriod = date.slice(0, 4);
    const targetPeriod = period ?? stampPeriod;
    return journal.append({
      timestamp: date,
      period: targetPeriod,
      type: ENTRY.RECEIPT,
      source: null,
      projectId,
      groupId: null,
      householdId: null,
      lotId: null,
      amountCents,
      basis: { kind: 'project_receipt', batchId, note, lateBooking: targetPeriod !== stampPeriod || undefined },
      operator,
      idempotencyKey: `RECEIPT:${projectId}:${batchId}`,
      tag: null,
    }).entry;
  }

  // 计算某地块在某结算期内各户的保底租金/生态奖励整数微权重（未除以公共分母）。
  // micro = 年标准(分/亩) × 面积(毫亩) × 份额(万分比) × 天数，使用 BigInt 防溢出。
  // 实际金额 = round( micro / (1000 × 10000 × 全年天数) )
  function annualWeights(parcel, period, source) {
    const range = periodRange(period);
    const totalDays = yearDays(period);
    const rate = source === SOURCE.RENT ? parcel.annualRentCentsPerMu : parcel.annualEcoCentsPerMu;
    const perHousehold = new Map();
    const segments = [];
    const points = new Set([range.start, range.end]);
    for (const s of parcel.shares) {
      if (s.from < range.end) points.add(s.from > range.start ? s.from : range.start);
      if (s.to !== null && s.to > range.start && s.to < range.end) points.add(s.to);
    }
    const sorted = [...points].sort();
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const segFrom = sorted[i];
      const segTo = sorted[i + 1];
      const days = overlapDays(segFrom, segTo, range.start, range.end);
      if (days <= 0) continue;
      for (const share of parcel.shares) {
        if (overlapDays(segFrom, segTo, share.from, share.to ?? '9999-12-31') <= 0) continue;
        const micro = BigInt(rate) * BigInt(parcel.areaHao) * BigInt(share.shareBasis) * BigInt(days);
        perHousehold.set(share.householdId, (perHousehold.get(share.householdId) ?? 0n) + micro);
        segments.push({
          parcelId: parcel.parcelId,
          householdId: share.householdId,
          from: segFrom,
          to: segTo,
          days,
          areaHao: parcel.areaHao,
          shareBasis: share.shareBasis,
          rateCentsPerMu: rate,
          grantId: share.grantId,
          microWeight: micro.toString(),
        });
      }
    }
    return { perHousehold, segments, totalDays, denom: AREA_DENOM * SHARE_DENOM * totalDays };
  }

  // ---- 年度计提：保底租金、生态奖励，按地块有效期按日分摊到户 ----
  function accrueAnnual({ period, sources = [SOURCE.RENT, SOURCE.ECO_REWARD], date, operator }) {
    const created = [];
    for (const source of sources) {
      if (![SOURCE.RENT, SOURCE.ECO_REWARD].includes(source)) {
        throw new Error('年度计提只支持保底租金与生态奖励');
      }
      for (const parcel of registry.listParcels()) {
        if (!registry.getProject(parcel.projectId).sources.includes(source)) continue;
        if ((source === SOURCE.RENT ? parcel.annualRentCentsPerMu : parcel.annualEcoCentsPerMu) === 0) continue;
        const { perHousehold, segments, totalDays, denom } = annualWeights(parcel, period, source);
        if (perHousehold.size === 0) continue;
        const householdIds = [...perHousehold.keys()];
        const micros = householdIds.map((id) => perHousehold.get(id));
        const microSum = micros.reduce((sum, v) => sum + v, 0n);
        const parcelTotal = divideHalfUp(microSum, denom); // 地块该期应分总额（四舍五入到分）
        const amounts = largestRemainder(micros, parcelTotal); // 各户之和恒等于地块总额
        for (let i = 0; i < householdIds.length; i += 1) {
          const householdId = householdIds[i];
          if (amounts[i] === 0) continue;
          const household = registry.getHousehold(householdId);
          const lotId = `LOT:${source}:${period}:${parcel.parcelId}:${householdId}`;
          const result = journal.append({
            timestamp: date,
            period,
            type: ENTRY.ACCRUAL,
            source,
            projectId: parcel.projectId,
            groupId: household.groupId,
            householdId,
            lotId,
            amountCents: amounts[i],
            basis: {
              kind: 'annual_proration',
              lateBooking: date.slice(0, 4) !== period || undefined,
              period,
              parcelId: parcel.parcelId,
              areaHao: parcel.areaHao,
              yearDays: totalDays,
              shareDenominator: SHARE_DENOM,
              segments: segments.filter((s) => s.householdId === householdId),
              parcelTotalCents: parcelTotal,
              microWeight: micros[i].toString(),
              microDenominator: denom,
              formula: '金额 = 年标准(分/亩) × 面积(亩) × 份额 × 占用天数 ÷ 全年天数',
            },
            operator,
            idempotencyKey: `ACCRUAL:${source}:${period}:${parcel.parcelId}:${householdId}`,
            tag: null,
          });
          created.push(result.entry);
        }
      }
    }
    return created;
  }

  // ---- 务工收入：一条务工记录一笔计提，recordId 重传幂等 ----
  // 记账晚于务工归属期间（旧期未关账）时传 period 迟到追入。
  function accrueWage({ recordId, projectId, householdId, memberId = null, amountCents, workDate, date, operator, period = null, detail = {} }) {
    const project = registry.getProject(projectId);
    if (!project) throw new Error(`项目不存在：${projectId}`);
    if (!project.sources.includes(SOURCE.WAGE)) throw new Error(`项目 ${projectId} 不含务工收入来源`);
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('务工金额必须是正整数分');
    const household = registry.getHousehold(householdId);
    if (!household) throw new Error(`农户不存在：${householdId}`);
    const targetPeriod = period ?? date.slice(0, 4);
    return journal.append({
      timestamp: date,
      period: targetPeriod,
      type: ENTRY.ACCRUAL,
      source: SOURCE.WAGE,
      projectId,
      groupId: household.groupId,
      householdId,
      lotId: `LOT:WAGE:${recordId}`,
      amountCents,
      basis: {
        kind: 'wage_record',
        recordId,
        memberId,
        workDate,
        lateBooking: targetPeriod !== date.slice(0, 4) || undefined,
        ...detail,
      },
      operator,
      idempotencyKey: `ACCRUAL:WAGE:${recordId}`,
      tag: null,
    }).entry;
  }

  // ---- 经营分成：回款批次到账后，按期间“面积·份额·天”权重精确分摊到户 ----
  function distributeDividend({ receiptEntryId, projectId, period, amountCents, date, operator, policy = '面积份额天权重' }) {
    const receipt = journal.entries().find((e) => e.entryId === receiptEntryId && e.type === ENTRY.RECEIPT);
    if (!receipt) throw new Error(`回款分录不存在：${receiptEntryId}`);
    if (receipt.projectId !== projectId) throw new Error('回款分录与项目不一致');
    const project = registry.getProject(projectId);
    if (!project.sources.includes(SOURCE.DIVIDEND)) throw new Error(`项目 ${projectId} 不含经营分成来源`);
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('分成总额必须是正整数分');
    // 同一批次可分多次分发（如预留部分后追分），以序号形成不同幂等域
    const priorBatches = journal.entries().filter(
      (e) => e.type === ENTRY.ACCRUAL && e.source === SOURCE.DIVIDEND && e.basis?.receiptEntryId === receiptEntryId,
    );
    const batchNo = priorBatches.length === 0 ? 1 : Math.max(...priorBatches.map((e) => e.basis.batchNo ?? 1)) + 1;

    const { weights, details } = registry.areaDayWeights(projectId, period);
    if (weights.size === 0) throw new Error(`期间 ${period} 项目 ${projectId} 无有效权属，无法分摊分成`);
    const householdIds = [...weights.keys()];
    const amounts = largestRemainder(householdIds.map((id) => weights.get(id)), amountCents);
    const created = [];
    for (let i = 0; i < householdIds.length; i += 1) {
      if (amounts[i] === 0) continue;
      const householdId = householdIds[i];
      const household = registry.getHousehold(householdId);
      const result = journal.append({
        timestamp: date,
        period,
        type: ENTRY.ACCRUAL,
        source: SOURCE.DIVIDEND,
        projectId,
        groupId: household.groupId,
        householdId,
        lotId: `LOT:DIVIDEND:${receiptEntryId}:${batchNo}:${householdId}`,
        amountCents: amounts[i],
        basis: {
          kind: 'dividend_batch',
          receiptEntryId,
          batchNo,
          period,
          lateBooking: date.slice(0, 4) !== period || undefined,
          policy,
          weight: weights.get(householdId).toString(),
          weightDetails: details.filter((d) => d.householdId === householdId),
          distributedTotalCents: amountCents,
          formula: '户分成 = 批次分成总额 × 户(面积×份额×天数)权重 ÷ 全部户权重；尾差按最大余数法补 1 分',
        },
        operator,
        idempotencyKey: `ACCRUAL:DIVIDEND:${receiptEntryId}:${batchNo}:${householdId}`,
        tag: null,
      });
      created.push(result.entry);
    }
    return created;
  }

  // ---- 到户操作：支付、追回、冻结、解冻、暂缓、恢复 ----
  function operate({ type, lotId, amountCents, date, operator, reasonCode = null, basis = {} }) {
    const view = journal.lot(lotId);
    if (!view) throw new Error(`应付批次不存在：${lotId}`);
    const needsReason = [ENTRY.FREEZE, ENTRY.SUSPEND].includes(type);
    return journal.append({
      timestamp: date,
      period: date.slice(0, 4),
      type,
      source: view.source,
      projectId: view.projectId,
      groupId: view.groupId,
      householdId: view.householdId,
      lotId,
      amountCents,
      reasonCode: needsReason ? reasonCode : null,
      basis: { ...basis },
      operator,
      tag: null,
    }).entry;
  }

  function payLot({ lotId, amountCents, date, operator, channel = '银行代发', reference = null }) {
    return operate({
      type: ENTRY.PAYMENT,
      lotId,
      amountCents,
      date,
      operator,
      basis: { reason: '到户支付', channel, reference },
    });
  }

  // 按户支付当前可付额度：自动跨来源、项目、批次（早期间、早批次优先）。
  // 同时受资金账余额与 maxCents 约束；资金不足时按批次部分支付，余下挂账等后续回款。
  function payHousehold({ householdId, date, operator, maxCents = null, sources = null, channel = '银行代发', reference = null }) {
    const pay = [];
    let budget = maxCents;
    let cash = journal.cashBalance();
    const lots = journal
      .lots()
      .filter((l) => l.householdId === householdId && l.availableCents > 0)
      .sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0))
      .filter((l) => !sources || sources.includes(l.source));
    for (const lot of lots) {
      if (cash <= 0) break; // 资金账已尽，其余批次留待回款
      let amount = Math.min(lot.availableCents, cash);
      if (budget !== null) amount = Math.min(amount, budget);
      if (amount <= 0) {
        if (budget !== null && budget <= 0) break;
        continue;
      }
      const entry = payLot({ lotId: lot.lotId, amountCents: amount, date, operator, channel, reference });
      pay.push(entry);
      cash -= amount;
      if (budget !== null) budget -= amount;
    }
    return pay;
  }

  // 回款延迟：对项目期下未付应付批量暂缓（挂账金额由账内余额自动约束）。
  // 可限定来源（如仅生态奖励对应专项回款延迟）。
  function suspendForReceiptDelay({ projectId, period, lotIds = null, sources = null, date, operator, note = '' }) {
    const targets = journal
      .lots()
      .filter((l) => l.projectId === projectId && l.period === period)
      .filter((l) => (lotIds ? lotIds.includes(l.lotId) : true))
      .filter((l) => (sources ? sources.includes(l.source) : true))
      .filter((l) => l.availableCents > 0);
    return targets.map((l) =>
      operate({
        type: ENTRY.SUSPEND,
        lotId: l.lotId,
        amountCents: l.availableCents,
        date,
        operator,
        reasonCode: REASON.RECEIPT_DELAY,
        basis: { reason: '项目回款延迟，暂缓支付', note },
      }),
    );
  }

  // 人员去世、继承待定：冻结该户全部可付挂账
  function freezeForInheritance({ householdId, date, operator, memberId = null, note = '' }) {
    const targets = journal.lots().filter((l) => l.householdId === householdId && l.availableCents > 0);
    return targets.map((l) =>
      operate({
        type: ENTRY.FREEZE,
        lotId: l.lotId,
        amountCents: l.availableCents,
        date,
        operator,
        reasonCode: REASON.INHERITANCE_PENDING,
        basis: { reason: '家庭成员去世，继承待定', memberId, note },
      }),
    );
  }

  // 生成年度更正分录草案（不立即入账）。
  function draftAnnualCorrections({ parcelId, periods, sources = [SOURCE.RENT, SOURCE.ECO_REWARD], date, operator, reason }) {
    const parcel = registry.getParcel(parcelId);
    if (!parcel) throw new Error(`地块不存在：${parcelId}`);
    const drafts = [];
    for (const period of periods) {
      for (const source of sources) {
        const rate = source === SOURCE.RENT ? parcel.annualRentCentsPerMu : parcel.annualEcoCentsPerMu;
        if (rate === 0) continue;
        const { perHousehold, segments, totalDays, denom } = annualWeights(parcel, period, source);
        const householdIds = new Set(perHousehold.keys());
        // 账上该地块该来源已有计提的户也要纳入（可能全部转出）
        for (const lot of journal.lots()) {
          if (lot.projectId === parcel.projectId && lot.period === period && lot.source === source) {
            const seeded = lot.lotId.startsWith(`LOT:${source}:${period}:${parcelId}:`);
            if (seeded) householdIds.add(lot.householdId);
          }
        }
        const microSum = [...perHousehold.values()].reduce((s, v) => s + v, 0n);
        const expectedTotal = divideHalfUp(microSum, denom);
        // 期望额先按微权重分摊（尾差在户间最大余数法配平，保持地块总额守恒）
        const ids = [...householdIds];
        const expected = largestRemainder(ids.map((id) => perHousehold.get(id) ?? 0n), expectedTotal);
        for (let i = 0; i < ids.length; i += 1) {
          const householdId = ids[i];
          const lotId = `LOT:${source}:${period}:${parcelId}:${householdId}`;
          const view = journal.lot(lotId);
          const booked = view ? view.accruedCents + view.correctionCents : 0;
          const delta = expected[i] - booked;
          if (delta === 0) continue;
          const household = registry.getHousehold(householdId);
          // 更正锚点优先指向本户该地块该来源的原计提分录；新户无原账时声明 standalone
          const anchor = journal
            .entries()
            .find((e) => e.type === ENTRY.ACCRUAL && e.source === source && e.period === period && e.householdId === householdId && e.basis?.parcelId === parcelId);
          drafts.push({
            lotId,
            delta,
            view,
            draft: {
              timestamp: date,
              period,
              type: ENTRY.CORRECTION,
              source,
              projectId: parcel.projectId,
              groupId: household.groupId,
              householdId,
              lotId,
              linkEntryId: anchor?.entryId ?? null,
              amountCents: delta,
              basis: {
                kind: 'ownership_correction',
                reason,
                parcelId: parcelId,
                standalone: anchor ? undefined : true,
                lateBooking: !journal.isClosed(period) && date.slice(0, 4) !== period || undefined,
                touchPeriod: period,
                expectedCents: expected[i],
                bookedCents: booked,
                segments: segments.filter((s) => s.householdId === householdId),
                yearDays: totalDays,
                microDenominator: denom,
                rule: '按更正后权属有效期重算，差额带符号追加；负数表示转出/追回依据',
              },
              operator,
              tag: journal.isClosed(period) ? 'post_close' : null,
            },
          });
        }
      }
    }
    return drafts;
  }

  // 两阶段提交：先逐 lot 预演全部更正后的余额约束，全部通过才入账，
  // 避免“前户已入账、后户校验失败”留下半截更正。
  function commitCorrections(drafts) {
    for (const { lotId, view, delta } of drafts) {
      const accrued = view ? view.accruedCents : 0;
      const correction = (view ? view.correctionCents : 0) + delta;
      const paid = view ? view.paidCents : 0;
      const after = accrued + correction - paid;
      if (after < 0) {
        throw new Error(`更正后 ${lotId} 应付净额为负（${after} 分）：已付部分须先以红字支付追回，再做更正`);
      }
      const blocked = view ? view.frozenCents + view.suspendedCents : 0;
      if (after < blocked) {
        throw new Error(`更正后 ${lotId} 应付净额 ${after} 分小于挂账 ${blocked} 分：请先解冻/恢复挂账再更正`);
      }
    }
    return drafts.map(({ draft }) => journal.append(draft).entry);
  }

  // ---- 结算后权属更正：重算保底租金/生态奖励，差额以 CORRECTION 追加分录入账 ----
  function correctAnnualAfterSettlement(params) {
    return commitCorrections(draftAnnualCorrections(params));
  }

  // ---- 分成批次重算：争议裁决后按新权属重分既有批次（总额不变，差额追加） ----
  function recomputeDividendBatch({ receiptEntryId, batchNo = 1, date, operator, reason }) {
    const accruals = journal.entries().filter(
      (e) =>
        e.type === ENTRY.ACCRUAL &&
        e.source === SOURCE.DIVIDEND &&
        e.basis?.receiptEntryId === receiptEntryId &&
        (e.basis.batchNo ?? 1) === batchNo,
    );
    if (accruals.length === 0) throw new Error('找不到对应分成批次');
    const first = accruals[0];
    const period = first.basis.period ?? first.period;
    const total = accruals.reduce((sum, e) => sum + e.amountCents, 0);
    const { weights } = registry.areaDayWeights(first.projectId, period);
    const ids = [...new Set([...weights.keys(), ...accruals.map((e) => e.householdId)])];
    const amounts = largestRemainder(ids.map((id) => weights.get(id) ?? 0), total);
    const drafts = [];
    ids.forEach((householdId, i) => {
      const lotId = `LOT:DIVIDEND:${receiptEntryId}:${batchNo}:${householdId}`;
      const view = journal.lot(lotId);
      const booked = view ? view.accruedCents + view.correctionCents : 0;
      const delta = amounts[i] - booked;
      if (delta === 0) return;
      const household = registry.getHousehold(householdId);
      drafts.push({
        lotId,
        delta,
        view,
        draft: {
          timestamp: date,
          period,
          type: ENTRY.CORRECTION,
          source: SOURCE.DIVIDEND,
          projectId: first.projectId,
          groupId: household.groupId,
          householdId,
          lotId,
          linkEntryId: first.entryId,
          amountCents: delta,
          basis: {
            kind: 'dividend_recalculation',
            reason,
            receiptEntryId,
            batchNo,
            period,
            lateBooking: !journal.isClosed(period) && date.slice(0, 4) !== period || undefined,
            expectedCents: amounts[i],
            bookedCents: booked,
            rule: '按裁决后权属重算该回款批次分成，批次总额守恒',
          },
          operator,
          tag: journal.isClosed(period) ? 'post_close' : null,
        },
      });
    });
    return commitCorrections(drafts);
  }

  function closePeriod(period, operator) {
    journal.closePeriod(period, operator);
  }

  return {
    registry,
    journal,
    receivePayment,
    accrueAnnual,
    accrueWage,
    distributeDividend,
    payLot,
    payHousehold,
    operate,
    suspendForReceiptDelay,
    freezeForInheritance,
    correctAnnualAfterSettlement,
    recomputeDividendBatch,
    closePeriod,
  };
}

// 按户可核验明细（见 statement.mjs 中组织）
export function statementFingerprint(canonical) {
  return sha256Hex(canonicalJson(canonical));
}
