import crypto from 'node:crypto';
import { allocate, sum } from './money.mjs';
import { dayOf, dayText, periodRange, overlap, days } from './time.mjs';

// ── 科目 ────────────────────────────────────────────────────────────────────
// 现金池        项目回款入账借记、发放/退回贷记
// 项目收益清算  项目级：回款贷记、计提借记
// 应付收益款    已计提待付：贷记计提，借记发放/暂缓
// 冻结待付      争议、继承待定期间的暂缓资金
// 应追回款      结算后更正产生的超付追偿
export const ACCOUNT = {
  CASH: '现金池',
  CLEARING: '项目收益清算',
  PAYABLE: '应付收益款',
  FROZEN: '冻结待付',
  RECOVERABLE: '应追回款',
};

// 凭证类型
export const VOUCHER = {
  ACCRUAL: '计提',
  CATCH_UP: '追补',
  WITHHOLD: '暂缓',
  RELEASE: '解冻',
  PAYMENT: '到账',
  RED_REVERSAL: '红冲',
  BLUE_SUPPLEMENT: '蓝补',
  RECOVER: '转追偿',
  COLLECTION: '回款',
  REPAYMENT: '追回入账',
};

export const SOURCE_NAME = {
  lease: '保底租金',
  share: '经营分成',
  work: '务工收入',
  eco: '生态奖励',
};

const PPM = 1_000_000;
const ACCRUAL_TYPES = new Set([VOUCHER.ACCRUAL, VOUCHER.CATCH_UP, VOUCHER.BLUE_SUPPLEMENT]);

// ── 数据与凭证存储（内存实现，接口与持久化方式无关） ───────────────────────────
export class Store {
  constructor() {
    this.vouchers = [];
    this.tailHash = '0'.repeat(64);
    this.households = new Map();
    this.persons = new Map();
    this.plots = new Map();
    // {id, plotId, shares:[{personId, ppm}], validFrom, validTo|null, note}
    this.shareVersions = [];
    // {plotId, fromDay, toDay|null, reason, resolvedDay|null}
    this.disputes = [];
    this.events = new Map();
    // 务工记录号 -> 记录；记录号全局幂等，重传被拒绝
    this.workRecords = new Map();
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export class Ledger {
  constructor(store = new Store()) {
    this.store = store;
  }

  // ── 基础登记 ──────────────────────────────────────────────────────────────
  registerHousehold({ id, groupId, name }) {
    assert(!this.store.households.has(id), `户 ${id} 已存在`);
    this.store.households.set(id, { id, groupId, name: name ?? id });
    return this.store.households.get(id);
  }

  registerPerson({ id, householdId, groupId, name }) {
    assert(this.store.households.has(householdId), `户 ${householdId} 不存在`);
    assert(!this.store.persons.has(id), `成员 ${id} 已存在`);
    const person = {
      id,
      householdId,
      groupId: groupId ?? this.store.households.get(householdId).groupId,
      name: name ?? id,
      status: 'active',
      deathDay: null,
      inheritanceResolvedDay: null,
      heirPersonId: null,
    };
    this.store.persons.set(id, person);
    return person;
  }

  registerPlot({ id, groupId, areaMu, name }) {
    assert(!this.store.plots.has(id), `地块 ${id} 已存在`);
    this.store.plots.set(id, { id, groupId, areaMu, name: name ?? id });
    return this.store.plots.get(id);
  }

  /**
   * 登记权属（份额）版本。新版本自 validFrom 起生效，此前开放中的版本
   * 在该日截止；旧版本原样保留，权属有效期由此形成版本链。
   * 份额用百万分率（ppm）表示，和必须为 1,000,000。
   */
  addShareVersion(plotId, shares, validFromText, { note = null } = {}) {
    const plot = this.store.plots.get(plotId);
    assert(plot, `地块 ${plotId} 不存在`);
    const validFrom = dayOf(validFromText);
    assert(sum(shares.map((item) => item.ppm)) === PPM, `份额之和必须为 ${PPM}`);
    for (const item of shares) {
      assert(this.store.persons.has(item.personId), `成员 ${item.personId} 不存在`);
    }
    const open = this.store.shareVersions
      .filter((version) => version.plotId === plotId && version.validTo === null)
      .sort((a, b) => b.validFrom - a.validFrom)[0];
    if (open) {
      assert(validFrom >= open.validFrom, '新版本生效日不得早于当前开放版本的生效日');
      assert(validFrom > open.validFrom, '该生效日已存在开放版本');
      open.validTo = validFrom;
    }
    const version = {
      id: `SV-${plotId}-${this.store.shareVersions.length + 1}`,
      plotId,
      shares: shares.map((item) => ({ ...item })),
      validFrom,
      validTo: null,
      note,
    };
    this.store.shareVersions.push(version);
    return version;
  }

  /**
   * 在版本链中间插入“追补版本”（结算后追溯更正专用）：
   * 覆盖 effectiveDay 的旧版本在该日被切片；若生效日相同，旧版本整体被替代
   * （零长度保留并标记 supersededBy，旧账仍可查）。
   */
  #insertShareVersion(plotId, shares, validFrom, note) {
    assert(sum(shares.map((item) => item.ppm)) === PPM, `份额之和必须为 ${PPM}`);
    for (const item of shares) assert(this.store.persons.has(item.personId), `成员 ${item.personId} 不存在`);
    const covering = this.store.shareVersions.find(
      (version) => version.plotId === plotId && version.validFrom <= validFrom && (version.validTo === null || version.validTo > validFrom),
    );
    assert(covering, `地块 ${plotId} 在 ${validFrom} 没有可被更正的权属版本`);
    const version = {
      id: `SV-${plotId}-${this.store.shareVersions.length + 1}`,
      plotId,
      shares: shares.map((item) => ({ ...item })),
      validFrom,
      validTo: covering.validTo,
      note,
      supersedes: covering.id,
    };
    covering.validTo = validFrom;
    covering.supersededBy = version.id;
    this.store.shareVersions.push(version);
    return version;
  }

  /** 登记地块份额争议（半开区间 [from, to)；to 空表示持续中） */
  registerDispute(plotId, fromText, toText = null, reason = '份额争议') {
    assert(this.store.plots.has(plotId), `地块 ${plotId} 不存在`);
    const dispute = {
      plotId,
      fromDay: dayOf(fromText),
      toDay: toText ? dayOf(toText) : null,
      reason,
      resolvedDay: null,
    };
    this.store.disputes.push(dispute);
    return dispute;
  }

  /** 争议解决：关闭争议窗口，解冻该地块因争议冻结的款项给原权利人 */
  resolveDispute(plotId, dayText, { note = null } = {}) {
    const day = dayOf(dayText);
    const open = this.store.disputes
      .filter((item) => item.plotId === plotId && item.toDay === null)
      .sort((a, b) => b.fromDay - a.fromDay)[0];
    assert(open, `地块 ${plotId} 没有待决争议`);
    open.toDay = day;
    open.resolvedDay = day;
    const vouchers = this.#releaseFrozen(
      day,
      (aux) => aux.plotId === plotId && aux.reason === '地块份额争议',
      (aux) => ({ householdId: aux.householdId, personId: aux.personId, source: aux.source, eventId: aux.eventId }),
      note ?? `地块 ${plotId} 份额争议解决，冻结解冻`,
      {
        // 若争议解决时权利人身故且继承仍待定，解冻后立即按继承待定重新暂缓
        refreeze: (aux) => {
          const person = this.store.persons.get(aux.personId);
          return person && person.status === 'deceased_pending' ? '继承待定' : null;
        },
      },
    );
    return { dispute: open, vouchers };
  }

  /** 成员去世：继承待定，此后该成员应得份额一律暂缓冻结 */
  markDeath(personId, dayText) {
    const person = this.#requirePerson(personId);
    assert(person.status === 'active', `成员 ${personId} 当前为 ${person.status}，不能登记去世`);
    person.status = 'deceased_pending';
    person.deathDay = dayOf(dayText);
    return person;
  }

  /** 继承确定：该成员名下冻结款解冻到继承人所在户；此后份额由新权属版本体现 */
  resolveInheritance(personId, heirPersonId, dayText, { note = null } = {}) {
    const decedent = this.#requirePerson(personId);
    const heir = this.#requirePerson(heirPersonId);
    assert(decedent.status === 'deceased_pending', `成员 ${personId} 并非继承待定状态`);
    const day = dayOf(dayText);
    decedent.status = 'inherited';
    decedent.inheritanceResolvedDay = day;
    decedent.heirPersonId = heirPersonId;
    const vouchers = this.#releaseFrozen(
      day,
      (aux) => aux.personId === personId,
      () => ({ householdId: heir.householdId, personId: heirPersonId }),
      note ?? `继承确定：${personId} → ${heirPersonId}`,
      {
        // 继承确定时若地块争议仍未决，款项以“地块份额争议”重新暂缓
        refreeze: (aux) => {
          if (aux.plotId === null || aux.plotId === undefined) return null;
          const stillDisputed = this.store.disputes.some(
            (item) => item.plotId === aux.plotId && item.fromDay <= day && (item.toDay === null || item.toDay > day),
          );
          return stillDisputed ? '地块份额争议' : null;
        },
      },
    );
    return vouchers;
  }

  /** 冻结款通用解冻：按 成员|来源|事件 聚合，贷记应付（收款人由 payeeFor 决定） */
  #releaseFrozen(day, match, payeeFor, note, options = {}) {
    const groups = new Map();
    for (const voucher of this.store.vouchers) {
      if (voucher.type !== VOUCHER.WITHHOLD && voucher.type !== VOUCHER.BLUE_SUPPLEMENT) continue;
      for (const line of voucher.lines) {
        if (line.account !== ACCOUNT.FROZEN) continue;
        const aux = line.aux;
        if (!aux || !match(aux)) continue;
        const key = `${aux.householdId}|${aux.personId}|${aux.source}|${aux.eventId}|${aux.plotId ?? ''}`;
        const group = groups.get(key) ?? {
          fen: 0,
          from: { householdId: aux.householdId, personId: aux.personId },
          source: aux.source,
          eventId: aux.eventId,
          projectId: aux.projectId,
          plotId: aux.plotId,
          reasons: new Set(),
        };
        group.fen += line.credit - line.debit;
        if (aux.reason) group.reasons.add(aux.reason);
        groups.set(key, group);
      }
    }
    const posted = [];
    for (const group of groups.values()) {
      if (group.fen <= 0) continue;
      const payee = payeeFor({ householdId: group.from.householdId, personId: group.from.personId, source: group.source, eventId: group.eventId, plotId: group.plotId });
      const release = this.#post(
        VOUCHER.RELEASE,
        day,
        [
          { account: ACCOUNT.FROZEN, debit: group.fen, credit: 0, aux: { ...group.from, source: group.source, eventId: group.eventId, reason: '解冻转出' } },
          { account: ACCOUNT.PAYABLE, debit: 0, credit: group.fen, aux: { ...payee, source: group.source, eventId: group.eventId, releasedFromPerson: group.from.personId } },
        ],
        { projectId: group.projectId, plotId: group.plotId, source: group.source, eventId: group.eventId, kind: 'release' },
        note,
      );
      posted.push(release);

      // 解冻后若仍有其他待定事由（如争议解决时继承仍未定），立即重新暂缓
      const refreezeReason = options.refreeze?.({ ...group.from, source: group.source, eventId: group.eventId, plotId: group.plotId });
      if (refreezeReason) {
        posted.push(
          this.#post(
            VOUCHER.WITHHOLD,
            day,
            [
              { account: ACCOUNT.PAYABLE, debit: group.fen, credit: 0, aux: { ...payee, source: group.source, eventId: group.eventId } },
              { account: ACCOUNT.FROZEN, debit: 0, credit: group.fen, aux: { ...payee, projectId: group.projectId, plotId: group.plotId, source: group.source, eventId: group.eventId, reason: refreezeReason } },
            ],
            { projectId: group.projectId, plotId: group.plotId, source: group.source, eventId: group.eventId, kind: 'withhold', reWithheldAfter: release.voucherNo },
            `解冻后重新暂缓：${refreezeReason}（${payee.personId}）`,
          ),
        );
      }
    }
    return posted;
  }

  // ── 收益事件与务工记录 ─────────────────────────────────────────────────────
  /**
   * 收益事件 = 项目 × 地块（务工可空）× 来源 × 结算期。
   * totalFen 为预计应回款总额（分）；lease/eco 的 basis 可携带按亩年单价等依据。
   */
  registerEvent({ id, projectId, plotId = null, source, period, totalFen, expectedDayText, basis = {} }) {
    assert(!this.store.events.has(id), `收益事件 ${id} 已存在`);
    assert(SOURCE_NAME[source], `未知收益来源 ${source}`);
    if (source !== 'work') assert(plotId && this.store.plots.has(plotId), `来源 ${source} 必须指定有效地块`);
    const event = {
      id,
      projectId,
      plotId,
      source,
      period: String(period),
      totalFen,
      expectedDay: dayOf(expectedDayText),
      batches: [],
      accruedBatches: new Set(),
      accruedFen: 0,
      basis,
      recordNos: [],
    };
    this.store.events.set(id, event);
    return event;
  }

  /**
   * 登记务工记录。记录号全局幂等：同一记录重传返回 duplicated，
   * 更正只能走追加分录，不得借重传覆盖。
   */
  addWorkRecord({ recordNo, eventId, personId, dayText, hours, hourlyRateFen, weight = 1, meta = {} }) {
    if (this.store.workRecords.has(recordNo)) {
      return { duplicated: true, record: this.store.workRecords.get(recordNo) };
    }
    const event = this.store.events.get(eventId);
    assert(event && event.source === 'work', `务工事件 ${eventId} 不存在`);
    const person = this.#requirePerson(personId);
    const fen = Math.round(hours * hourlyRateFen * weight);
    const record = { recordNo, eventId, personId, householdId: person.householdId, day: dayOf(dayText), hours, hourlyRateFen, weight, fen, meta };
    this.store.workRecords.set(recordNo, record);
    event.recordNos.push(recordNo);
    event.totalFen += fen;
    return { duplicated: false, record };
  }

  /**
   * 项目回款分批入账：借 现金池 / 贷 项目收益清算。
   * 同事件内批次号幂等；晚于约定到账日的批次标记延迟（计提时生成追补）。
   */
  receiveBatch(eventId, batchNo, fen, dayText) {
    const event = this.#requireEvent(eventId);
    assert(!event.batches.some((batch) => batch.batchNo === batchNo), `事件 ${eventId} 批次 ${batchNo} 已登记`);
    const received = sum(event.batches.map((batch) => batch.fen));
    assert(received + fen <= event.totalFen, `事件 ${eventId} 回款累计超过总额`);
    const day = dayOf(dayText);
    const batch = { batchNo, fen, day, late: day > event.expectedDay };
    event.batches.push(batch);
    const voucher = this.#post(
      VOUCHER.COLLECTION,
      day,
      [
        { account: ACCOUNT.CASH, debit: fen, credit: 0, aux: { projectId: event.projectId, eventId: event.id, source: event.source } },
        { account: ACCOUNT.CLEARING, debit: 0, credit: fen, aux: { projectId: event.projectId, eventId: event.id, plotId: event.plotId, source: event.source } },
      ],
      { projectId: event.projectId, plotId: event.plotId, period: event.period, source: event.source, eventId: event.id, batchNo },
      `${event.projectId} 回款 ${batchNo}`,
    );
    return { batch, voucher };
  }

  // ── 计提引擎：权属有效期 × 收益来源 × 已回款批次 ─────────────────────────────
  /** 将截至 asOfText 已到账且尚未计提的批次全部计提到户（迟回批次走追补） */
  accrue(asOfText) {
    const asOf = dayOf(asOfText);
    const posted = [];
    for (const event of [...this.store.events.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      for (const batch of [...event.batches].sort((a, b) => a.day - b.day || String(a.batchNo).localeCompare(String(b.batchNo)))) {
        if (batch.day > asOf || event.accruedBatches.has(batch.batchNo)) continue;
        posted.push(...this.#accrueBatch(event, batch, { asOfDay: batch.day }));
        event.accruedBatches.add(batch.batchNo);
        event.accruedFen += batch.fen;
      }
    }
    return posted;
  }

  #accrueBatch(event, batch, context = {}) {
    const asOfDay = context.asOfDay ?? batch.day;
    const isBlue = context.blue === true;
    const weights =
      event.source === 'work' ? this.#workWeights(event) : this.#plotWeights(event.plotId, event.period, asOfDay);
    const allocations = allocate(batch.fen, weights.map((item) => item.weight));

    let type;
    if (isBlue) type = VOUCHER.BLUE_SUPPLEMENT;
    else if (batch.late) type = VOUCHER.CATCH_UP;
    else type = VOUCHER.ACCRUAL;

    const plot = event.plotId ? this.store.plots.get(event.plotId) : null;
    const basisSnapshot = { ...event.basis, areaMu: plot?.areaMu ?? null };

    const lines = [
      { account: ACCOUNT.CLEARING, debit: batch.fen, credit: 0, aux: { projectId: event.projectId, eventId: event.id, plotId: event.plotId, source: event.source } },
    ];
    weights.forEach((item, index) => {
      const fen = allocations[index];
      if (fen === 0) return;
      const person = this.store.persons.get(item.personId);
      lines.push({
        account: ACCOUNT.PAYABLE,
        debit: 0,
        credit: fen,
        aux: {
          householdId: person.householdId,
          personId: item.personId,
          source: event.source,
          eventId: event.id,
          basis: item.basis, // 份额ppm×天数 或 务工记录明细
        },
      });
    });

    const refs = {
      projectId: event.projectId,
      plotId: event.plotId,
      period: event.period,
      source: event.source,
      eventId: event.id,
      batchNo: batch.batchNo,
      batchFen: batch.fen,
      basis: basisSnapshot,
    };
    if (isBlue) refs.blueFor = context.originalVoucherNo;
    refs.kind = 'accrual';

    const prefix = isBlue ? `蓝补 ${context.originalVoucherNo}：` : batch.late ? '迟回批次追补：' : '';
    const accrual = this.#post(type, asOfDay, lines, refs, `${prefix}${SOURCE_NAME[event.source]} ${event.id} 批次 ${batch.batchNo}`);

    // 待定份额：计提后立即暂缓
    const withholdGroups = new Map();
    weights.forEach((item, index) => {
      const fen = allocations[index];
      if (fen === 0 || !item.frozen) return;
      const person = this.store.persons.get(item.personId);
      const key = `${item.personId}|${item.frozenReason}`;
      const group = withholdGroups.get(key) ?? { fen: 0, personId: item.personId, householdId: person.householdId, reason: item.frozenReason };
      group.fen += fen;
      withholdGroups.set(key, group);
    });
    const withheldVoucherNos = [];
    for (const group of withholdGroups.values()) {
      const withholdType = isBlue ? VOUCHER.BLUE_SUPPLEMENT : VOUCHER.WITHHOLD;
      const voucher = this.#post(
        withholdType,
        asOfDay,
        [
          { account: ACCOUNT.PAYABLE, debit: group.fen, credit: 0, aux: { householdId: group.householdId, personId: group.personId, source: event.source, eventId: event.id } },
          { account: ACCOUNT.FROZEN, debit: 0, credit: group.fen, aux: { householdId: group.householdId, personId: group.personId, source: event.source, eventId: event.id, projectId: event.projectId, plotId: event.plotId, reason: group.reason } },
        ],
        { ...refs, kind: 'withhold', withholds: accrual.voucherNo },
        isBlue ? `蓝补暂缓：${group.reason}（${group.personId}）` : `暂缓：${group.reason}（${group.personId}）`,
      );
      withheldVoucherNos.push(voucher.voucherNo);
    }
    accrual.withheldVoucherNos = withheldVoucherNos;
    return [accrual, ...withheldVoucherNos.map((no) => this.store.vouchers.find((voucher) => voucher.voucherNo === no))];
  }

  /**
   * 地块类权重：把结算期按权属版本、争议窗口、成员生死/继承确定日切成段，
   * 每段按 份额ppm × 天数 累计。截至 asOfDay 尚未解决的争议或继承待定，
   * 对应权重标记冻结。每段明细随凭证留存，供回放还原单价×面积×份额×天数。
   */
  #plotWeights(plotId, period, asOfDay) {
    const [periodStart, periodEnd] = periodRange(period);
    const versions = this.store.shareVersions
      .filter((version) => version.plotId === plotId && overlap([version.validFrom, version.validTo ?? Infinity], [periodStart, periodEnd]))
      .sort((a, b) => a.validFrom - b.validFrom);
    assert(versions.length > 0, `地块 ${plotId} 在结算期 ${period} 没有权属版本`);

    const disputes = this.store.disputes.filter(
      (item) => item.plotId === plotId && overlap([item.fromDay, item.toDay ?? Infinity], [periodStart, periodEnd]),
    );

    const boundaries = new Set([periodStart, periodEnd]);
    for (const version of versions) {
      boundaries.add(Math.max(version.validFrom, periodStart));
      if (version.validTo !== null && version.validTo < periodEnd) boundaries.add(version.validTo);
    }
    for (const dispute of disputes) {
      boundaries.add(Math.max(dispute.fromDay, periodStart));
      if (dispute.toDay !== null && dispute.toDay < periodEnd) boundaries.add(dispute.toDay);
    }
    const ticks = [...boundaries].filter((day) => day >= periodStart && day <= periodEnd).sort((a, b) => a - b);

    const aggregated = new Map();
    for (let i = 0; i < ticks.length - 1; i += 1) {
      const segStart = ticks[i];
      const segEnd = ticks[i + 1];
      const version = versions.find((item) => item.validFrom <= segStart && (item.validTo === null || item.validTo > segStart));
      assert(version, `地块 ${plotId} 在 ${segStart} 缺少有效权属版本`);
      const liveDispute = disputes.find((item) => item.fromDay <= segStart && (item.toDay === null || item.toDay > segStart));
      const disputeFrozen = liveDispute && (liveDispute.resolvedDay === null || liveDispute.resolvedDay > asOfDay);
      const length = days(segStart, segEnd);

      for (const share of version.shares) {
        const owner = this.store.persons.get(share.personId);
        let personId = share.personId;
        let originalPersonId = null;
        let frozen = Boolean(disputeFrozen);
        let reason = disputeFrozen ? '地块份额争议' : null;
        // 份额归属以“计提时点”的身份状态为准：待定则冻结，已继承则计到继承人
        if (owner.status === 'inherited') {
          personId = owner.heirPersonId;
          originalPersonId = share.personId;
        } else if (owner.status === 'deceased_pending') {
          frozen = true;
          reason = disputeFrozen ? reason : '继承待定';
        }
        const key = `${personId}|${frozen ? reason : 'free'}`;
        const entry = aggregated.get(key) ?? { personId, weight: 0, frozen, frozenReason: reason, basis: { ppmDays: [] } };
        entry.weight += share.ppm * length;
        entry.basis.ppmDays.push({
          versionId: version.id,
          from: segStart,
          to: segEnd,
          days: length,
          ppm: share.ppm,
          personId,
          originalPersonId,
          frozen,
          reason,
        });
        aggregated.set(key, entry);
      }
    }
    return [...aggregated.values()];
  }

  /** 务工权重：去重后的有效务工记录，金额本身即权重；归属以计提时点身份状态为准 */
  #workWeights(event) {
    const entries = new Map();
    for (const recordNo of event.recordNos) {
      const record = this.store.workRecords.get(recordNo);
      const worker = this.store.persons.get(record.personId);
      let personId = record.personId;
      let originalPersonId = null;
      let pending = false;
      if (worker.status === 'inherited') {
        personId = worker.heirPersonId;
        originalPersonId = record.personId;
      } else if (worker.status === 'deceased_pending') {
        pending = true;
      }
      const key = `${personId}|${pending ? '继承待定' : 'free'}`;
      const entry = entries.get(key) ?? { personId, weight: 0, frozen: pending, frozenReason: pending ? '继承待定' : null, basis: { records: [] } };
      entry.weight += record.fen;
      entry.basis.records.push({
        recordNo: record.recordNo,
        day: record.day,
        hours: record.hours,
        hourlyRateFen: record.hourlyRateFen,
        weight: record.weight,
        fen: record.fen,
        personId,
        originalPersonId,
        frozen: pending,
      });
      entries.set(key, entry);
    }
    return [...entries.values()];
  }

  // ── 发放到户 ───────────────────────────────────────────────────────────────
  /** 把某户应付收益款余额发放（借应付 / 贷现金），按成员×来源×事件逐行留痕 */
  payoutHousehold(householdId, dayText, { source = null } = {}) {
    assert(this.store.households.has(householdId), `户 ${householdId} 不存在`);
    const day = dayOf(dayText);
    const balances = this.#payableByPerson(householdId, source);
    const lines = [];
    let total = 0;
    for (const [key, fen] of balances) {
      if (fen <= 0) continue;
      const [personId, itemSource, eventId] = key.split('|');
      lines.push({ account: ACCOUNT.PAYABLE, debit: fen, credit: 0, aux: { householdId, personId, source: itemSource, eventId: eventId || null } });
      total += fen;
    }
    if (total === 0) return null;
    lines.push({ account: ACCOUNT.CASH, debit: 0, credit: total, aux: { householdId, payout: true } });
    return this.#post(VOUCHER.PAYMENT, day, lines, { householdId, source }, `发放到户：${this.store.households.get(householdId).name}`);
  }

  #payableByPerson(householdId, sourceFilter = null) {
    // 被红冲的原凭证与其负数红冲凭证自然相抵，无需特判；
    // “超付转追偿”的贷方行是追偿挂账，不是可发放款项，必须排除。
    const balances = new Map();
    for (const voucher of this.store.vouchers) {
      for (const line of voucher.lines) {
        if (line.account !== ACCOUNT.PAYABLE || line.aux?.householdId !== householdId) continue;
        if (line.aux.recoverableTransfer) continue;
        if (sourceFilter && line.aux.source !== sourceFilter) continue;
        const key = `${line.aux.personId}|${line.aux.source}|${line.aux.eventId ?? ''}`;
        balances.set(key, (balances.get(key) ?? 0) + line.credit - line.debit);
      }
    }
    return balances;
  }

  // ── 结算后权属更正：只追加分录（红冲 + 蓝补），旧账原样保留 ─────────────────────
  /**
   * @param effectiveDayText 更正追溯的生效日（新权属有效期起点）
   * @param registeredDayText 经办登记日（决定蓝补时争议/继承是否仍冻结）
   */
  correctShares({ plotId, shares, effectiveDayText, registeredDayText, note = '结算后权属更正' }) {
    const plot = this.store.plots.get(plotId);
    assert(plot, `地块 ${plotId} 不存在`);
    const registeredDay = dayOf(registeredDayText);

    // 1. 追补版本插入版本链（追溯生效；旧版本切片保留，绝不改写）
    const newVersion = this.#insertShareVersion(plotId, shares, dayOf(effectiveDayText), `追补版本：${note}`);

    // 2. 该地块所有已计提批次的现行有效计提凭证（含历次蓝补，支持反复更正）
    const affected = [];
    for (const event of this.store.events.values()) {
      if (event.plotId !== plotId) continue;
      for (const batch of event.batches) {
        if (!event.accruedBatches.has(batch.batchNo)) continue;
        const accruals = this.store.vouchers.filter(
          (voucher) =>
            ACCRUAL_TYPES.has(voucher.type) &&
            !voucher.reversedBy &&
            voucher.refs?.eventId === event.id &&
            voucher.refs?.batchNo === batch.batchNo,
        );
        for (const accrual of accruals) affected.push({ event, batch, accrual });
      }
    }

    const posted = [newVersion];
    const affectedEventIds = new Set(affected.map((item) => item.event.id));

    // 2-pre. 红冲受影响事件上所有现行有效的“暂缓/解冻”类凭证，
    // 按凭证号倒序冲销，正好逆序解开 暂缓→解冻→（再暂缓） 的链条。
    // 覆盖：联动暂缓、争议/继承解冻、解冻后以另一事由重新暂缓的凭证。
    const movementVouchers = this.store.vouchers
      .filter(
        (voucher) =>
          !voucher.reversedBy &&
          voucher.type !== VOUCHER.RED_REVERSAL &&
          (voucher.refs?.kind === 'withhold' || voucher.refs?.kind === 'release') &&
          voucher.refs?.plotId === plotId &&
          affectedEventIds.has(voucher.refs?.eventId),
      )
      .sort((a, b) => b.seq - a.seq);
    for (const movement of movementVouchers) {
      posted.push(this.#reverse(movement, registeredDay, `${note}（冻结链冲回）`));
    }

    for (const { event, batch, accrual } of affected) {
      // 2a. 红冲原计提凭证（负数行原样留痕；其联动暂缓已在上方统一冲回）
      posted.push(this.#reverse(accrual, registeredDay, note));
      // 2b. 蓝补：按更正后的权属版本链重新计提同一批次款项
      posted.push(...this.#accrueBatch(event, batch, { asOfDay: registeredDay, blue: true, originalVoucherNo: accrual.voucherNo }));
    }

    // 3. 已付多于新应付的成员：超付差额转应追回款；少付的成员留待补发。
    //    追偿只按受更正事件的流水轧差，避免卷入该成员其他来源的合法收入。
    const touched = this.#personsTouchedBy(affected);
    for (const movement of movementVouchers) {
      for (const line of movement.lines) {
        if (line.account === ACCOUNT.PAYABLE && line.aux?.personId) touched.add(line.aux.personId);
      }
    }
    for (const personId of touched) {
      const balance = this.#payableBalanceForPerson(personId, affectedEventIds);
      if (balance < 0) {
        const amount = -balance;
        const householdId = this.#requirePerson(personId).householdId;
        posted.push(
          this.#post(
            VOUCHER.RECOVER,
            registeredDay,
            [
              { account: ACCOUNT.RECOVERABLE, debit: amount, credit: 0, aux: { householdId, personId } },
              { account: ACCOUNT.PAYABLE, debit: 0, credit: amount, aux: { householdId, personId, recoverableTransfer: true } },
            ],
            { plotId, correction: note },
            `超付转追偿：${personId}`,
          ),
        );
      }
    }
    return posted;
  }

  #personsTouchedBy(affected) {
    const ids = new Set();
    for (const { accrual } of affected) {
      for (const line of accrual.lines) {
        if (line.account === ACCOUNT.PAYABLE && line.aux?.personId) ids.add(line.aux.personId);
      }
    }
    return ids;
  }

  /** 只在指定事件集合内轧差某成员的应付流水（发放行按事件精确归属） */
  #payableBalanceForPerson(personId, eventIds = null) {
    let balance = 0;
    for (const voucher of this.store.vouchers) {
      for (const line of voucher.lines) {
        if (line.account !== ACCOUNT.PAYABLE || line.aux?.personId !== personId) continue;
        if (line.aux.recoverableTransfer) continue;
        if (eventIds && !eventIds.has(line.aux.eventId)) continue;
        // 发放的借记行同样挂在应付科目，自动相抵
        balance += line.credit - line.debit;
      }
    }
    return balance;
  }

  /** 多领款项退回：借现金 / 贷应追回款 */
  recordRepayment(personId, fen, dayText, { note = null } = {}) {
    const person = this.#requirePerson(personId);
    const outstanding = this.accountBalance(ACCOUNT.RECOVERABLE, { personId });
    assert(fen <= outstanding, '退回金额超过应追回款余额');
    return this.#post(
      VOUCHER.REPAYMENT,
      dayOf(dayText),
      [
        { account: ACCOUNT.CASH, debit: fen, credit: 0, aux: { householdId: person.householdId, personId, repayment: true } },
        { account: ACCOUNT.RECOVERABLE, debit: 0, credit: fen, aux: { householdId: person.householdId, personId } },
      ],
      { personId },
      note ?? `多领款项退回：${personId}`,
    );
  }

  // ── 对账与核验 ────────────────────────────────────────────────────────────
  /** 总账平衡：每张凭证借贷相等，故全账借方合计恒等于贷方合计（红冲为负） */
  isBalanced() {
    let debit = 0;
    let credit = 0;
    for (const voucher of this.store.vouchers) {
      debit += sum(voucher.lines.map((line) => line.debit));
      credit += sum(voucher.lines.map((line) => line.credit));
    }
    return debit === credit;
  }

  accountBalance(account, auxFilter = null) {
    let balance = 0;
    for (const voucher of this.store.vouchers) {
      for (const line of voucher.lines) {
        if (line.account !== account) continue;
        if (auxFilter && !Object.entries(auxFilter).every(([key, value]) => line.aux?.[key] === value)) continue;
        balance += line.debit - line.credit;
      }
    }
    return balance;
  }

  /**
   * 按户对账恒等式（所有金额均按凭证净额计算，红冲负数自然轧抵）：
   *   净计提 + 跨户解冻转入
   *     = 已到账净额（发放 − 多领退回） + 应付余额 + 冻结在账 + 跨户解冻转出
   * 其中跨户解冻与其事后红冲通过 refs.kind='release' 一并识别。
   * 应追回款余额作为披露项：未退回时它等于“已到账净额”中尚未冲减的部分。
   */
  reconcileHousehold(householdId) {
    let accrued = 0;
    let paid = 0;
    let repaid = 0;
    let payable = 0;
    let transferredIn = 0;
    let transferredOut = 0;
    for (const voucher of this.store.vouchers) {
      for (const line of voucher.lines) {
        if (line.aux?.householdId !== householdId) continue;
        if (line.account === ACCOUNT.PAYABLE) {
          payable += line.credit - line.debit;
          if (voucher.refs?.kind === 'accrual') accrued += line.credit - line.debit;
          if (voucher.type === VOUCHER.PAYMENT) paid += line.debit;
        }
        if (line.account === ACCOUNT.CASH && line.aux?.repayment) repaid += line.debit;
      }
      // 解冻（含其红冲）：按凭证两端户号判定是否跨户；红冲为负数自动轧抵
      if (voucher.refs?.kind === 'release') {
        const frozenLine = voucher.lines.find((item) => item.account === ACCOUNT.FROZEN);
        const payableLine = voucher.lines.find((item) => item.account === ACCOUNT.PAYABLE);
        if (frozenLine && payableLine) {
          const fromHousehold = frozenLine.aux?.householdId;
          const toHousehold = payableLine.aux?.householdId;
          if (toHousehold === householdId && fromHousehold !== householdId) {
            transferredIn += payableLine.credit - payableLine.debit;
          }
          if (fromHousehold === householdId && toHousehold !== householdId) {
            transferredOut += frozenLine.debit - frozenLine.credit;
          }
        }
      }
    }
    const netPaid = paid - repaid;
    const frozen = -this.accountBalance(ACCOUNT.FROZEN, { householdId });
    const recoverable = this.accountBalance(ACCOUNT.RECOVERABLE, { householdId });
    const identityHolds = accrued + transferredIn === netPaid + payable + frozen + transferredOut;
    return { householdId, accrued, transferredIn, transferredOut, paid, repaid, netPaid, frozen, recoverable, payable, identityHolds };
  }

  /** 重算哈希链：凭证被事后改写即返回失败位置 */
  verifyChain() {
    let prevHash = '0'.repeat(64);
    for (const voucher of this.store.vouchers) {
      if (voucher.prevHash !== prevHash) return { ok: false, at: voucher.voucherNo, reason: '链断裂' };
      if (this.#digest(this.#payload(voucher)) !== voucher.hash) return { ok: false, at: voucher.voucherNo, reason: '内容被篡改' };
      prevHash = voucher.hash;
    }
    return { ok: true, count: this.store.vouchers.length };
  }

  // ── 按户回放明细 ──────────────────────────────────────────────────────────
  /**
   * 出具按户可核验明细：逐笔列出与该户相关的凭证（可跨项目），
   * 含凭证类型、计算依据快照、各行借贷与各科目滚动余额，末尾给对账结论。
   */
  householdStatement(householdId, viewer = { scope: 'admin' }) {
    this.assertCanView(householdId, viewer);
    const running = { [ACCOUNT.PAYABLE]: 0, [ACCOUNT.FROZEN]: 0, [ACCOUNT.RECOVERABLE]: 0, [ACCOUNT.CASH]: 0 };
    const entries = [];
    for (const voucher of this.store.vouchers) {
      const lines = voucher.lines.filter((line) => line.aux?.householdId === householdId);
      if (lines.length === 0) continue;
      let entryDebit = 0;
      let entryCredit = 0;
      for (const line of lines) {
        entryDebit += line.debit;
        entryCredit += line.credit;
        if (line.account in running) running[line.account] += line.credit - line.debit;
      }
      entries.push({
        seq: voucher.seq,
        voucherNo: voucher.voucherNo,
        dateText: voucher.dateText,
        type: voucher.type,
        projectId: voucher.refs?.projectId ?? null,
        source: voucher.refs?.source ?? lines[0].aux?.source ?? null,
        eventId: voucher.refs?.eventId ?? null,
        period: voucher.refs?.period ?? null,
        batchNo: voucher.refs?.batchNo ?? null,
        basis: voucher.refs?.basis ?? null,
        note: voucher.note,
        entryDebit,
        entryCredit,
        lines: lines.map((line) => ({
          account: line.account,
          debit: line.debit,
          credit: line.credit,
          aux: line.aux ? this.#readableAux(line.aux) : null,
        })),
        running: { ...running },
      });
    }
    return {
      household: this.store.households.get(householdId),
      entries,
      reconciliation: this.reconcileHousehold(householdId),
      chain: this.verifyChain(),
      ledgerBalanced: this.isBalanced(),
    };
  }

  /** 把分录依据中的日序号转为可读日期，便于回放核对 */
  #readableAux(aux) {
    if (!aux.basis) return aux;
    const basis = structuredClone(aux.basis);
    if (basis.ppmDays) {
      for (const segment of basis.ppmDays) {
        segment.fromText = dayText(segment.from);
        segment.toText = dayText(segment.to);
      }
    }
    if (basis.records) {
      for (const record of basis.records) record.dayText = dayText(record.day);
    }
    return { ...aux, basis };
  }

  // ── 村组查看权限 ──────────────────────────────────────────────────────────
  /**
   * viewer:
   *   { scope:'admin' }                     经管人员，全域
   *   { scope:'group', groupId }            村组，仅本组
   *   { scope:'household', householdId }    农户，仅本户
   */
  assertCanView(householdId, viewer) {
    if (viewer.scope === 'admin') return;
    const household = this.store.households.get(householdId);
    assert(household, `户 ${householdId} 不存在`);
    if (viewer.scope === 'group') {
      assert(viewer.groupId === household.groupId, '无权查看该户：不在本村组范围内');
      return;
    }
    if (viewer.scope === 'household') {
      assert(viewer.householdId === householdId, '无权查看该户：仅可查看本户');
      return;
    }
    throw new Error(`未知查看范围 ${viewer.scope}`);
  }

  visibleHouseholdIds(viewer) {
    if (viewer.scope === 'admin') return [...this.store.households.keys()];
    if (viewer.scope === 'group') {
      return [...this.store.households.values()].filter((item) => item.groupId === viewer.groupId).map((item) => item.id);
    }
    if (viewer.scope === 'household') return [viewer.householdId];
    throw new Error(`未知查看范围 ${viewer.scope}`);
  }

  // ── 内部：凭证与哈希链 ─────────────────────────────────────────────────────
  #post(type, day, lines, refs = {}, note = '') {
    const debitTotal = sum(lines.map((line) => line.debit));
    const creditTotal = sum(lines.map((line) => line.credit));
    assert(debitTotal === creditTotal, `凭证借贷不平：借 ${debitTotal} / 贷 ${creditTotal}（${type} ${note}）`);
    const seq = this.store.vouchers.length + 1;
    const voucher = {
      seq,
      voucherNo: `PZ-${String(seq).padStart(6, '0')}`,
      day,
      dateText: new Date(day * 86_400_000).toISOString().slice(0, 10),
      type,
      lines: lines.map((line) => ({ ...line, aux: line.aux ? { ...line.aux } : null })),
      refs: JSON.parse(JSON.stringify(refs)),
      note,
      prevHash: this.store.tailHash,
      reversedBy: null,
    };
    voucher.hash = this.#digest(this.#payload(voucher));
    this.store.vouchers.push(voucher);
    this.store.tailHash = voucher.hash;
    return voucher;
  }

  #reverse(original, day, note) {
    assert(!original.reversedBy, `凭证 ${original.voucherNo} 已被红冲`);
    const lines = original.lines.map((line) => ({
      account: line.account,
      debit: -line.debit,
      credit: -line.credit,
      aux: line.aux ? { ...line.aux } : null,
    }));
    const red = this.#post(
      VOUCHER.RED_REVERSAL,
      day,
      lines,
      { ...original.refs, reverses: original.voucherNo },
      `${note}｜红冲 ${original.voucherNo}`,
    );
    original.reversedBy = red.voucherNo;
    return red;
  }

  #payload(voucher) {
    return JSON.stringify({
      seq: voucher.seq,
      day: voucher.day,
      type: voucher.type,
      lines: voucher.lines,
      refs: voucher.refs,
      note: voucher.note,
      prevHash: voucher.prevHash,
    });
  }

  #digest(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  #requirePerson(id) {
    const person = this.store.persons.get(id);
    assert(person, `成员 ${id} 不存在`);
    return person;
  }

  #requireEvent(id) {
    const event = this.store.events.get(id);
    assert(event, `收益事件 ${id} 不存在`);
    return event;
  }
}
