// 应用服务：门面 + 村组权限 + 只读查询。
// 所有到户操作按户所属村组鉴权；回款、年度计提、关账等全局操作限 admin。
// 非 admin 用户看到的总账与清单只包含其村组范围内的数据。

import { ROLE, SOURCE } from '../domain/catalog.mjs';
import { createLedger } from '../domain/ledger.mjs';
import { buildHouseholdStatement } from '../domain/statement.mjs';

export function createAppService({ registry, journal: providedJournal, policy }) {
  const ledger = createLedger(registry, providedJournal);
  const journal = ledger.journal;

  function requireAdmin(userId) {
    const user = policy.getUser(userId);
    if (user.role !== ROLE.ADMIN) {
      const error = new Error('该操作需要全县/镇管理员权限');
      error.code = 'FORBIDDEN';
      throw error;
    }
    return user;
  }

  function groupOfHousehold(householdId) {
    const household = registry.getHousehold(householdId);
    if (!household) throw new Error(`农户不存在：${householdId}`);
    return household.groupId;
  }

  function groupOfLot(lotId) {
    const lot = journal.lot(lotId);
    if (!lot) throw new Error(`应付批次不存在：${lotId}`);
    return lot.groupId;
  }

  // ---------- 全局操作：仅 admin ----------
  function receivePayment(userId, params) {
    requireAdmin(userId);
    return ledger.receivePayment({ ...params, operator: userId });
  }

  function accrueAnnual(userId, params) {
    requireAdmin(userId);
    return ledger.accrueAnnual({ ...params, operator: userId });
  }

  function distributeDividend(userId, params) {
    requireAdmin(userId);
    return ledger.distributeDividend({ ...params, operator: userId });
  }

  function closePeriod(userId, params) {
    requireAdmin(userId);
    return ledger.closePeriod(params.period, userId);
  }

  // ---------- 本组操作：manager/admin ----------
  function accrueWage(userId, params) {
    policy.assertWrite(userId, groupOfHousehold(params.householdId));
    return ledger.accrueWage({ ...params, operator: userId });
  }

  function operate(userId, params) {
    policy.assertWrite(userId, groupOfLot(params.lotId));
    return ledger.operate({ ...params, operator: userId });
  }

  function payLot(userId, params) {
    policy.assertWrite(userId, groupOfLot(params.lotId));
    return ledger.payLot({ ...params, operator: userId });
  }

  function payHousehold(userId, params) {
    policy.assertWrite(userId, groupOfHousehold(params.householdId));
    return ledger.payHousehold({ ...params, operator: userId });
  }

  function suspendForReceiptDelay(userId, params) {
    requireAdmin(userId); // 项目级批量暂缓跨组，限 admin
    return ledger.suspendForReceiptDelay({ ...params, operator: userId });
  }

  function freezeForInheritance(userId, params) {
    policy.assertWrite(userId, groupOfHousehold(params.householdId));
    return ledger.freezeForInheritance({ ...params, operator: userId });
  }

  function correctShares(userId, params) {
    // 涉及户可能跨组：admin 或全部相关户都在经办范围内
    const user = policy.getUser(userId);
    if (user.role !== ROLE.ADMIN) {
      for (const allocation of params.allocations) {
        policy.assertWrite(userId, groupOfHousehold(allocation.householdId));
      }
    }
    return registry.correctShares(params);
  }

  // 年中流转（正向业务），鉴权口径与追溯更正一致
  function transferShares(userId, params) {
    const user = policy.getUser(userId);
    if (user.role !== ROLE.ADMIN) {
      for (const allocation of params.allocations) {
        policy.assertWrite(userId, groupOfHousehold(allocation.householdId));
      }
    }
    return registry.transferShares(params);
  }

  function correctAnnualAfterSettlement(userId, params) {
    requireAdmin(userId);
    return ledger.correctAnnualAfterSettlement({ ...params, operator: userId });
  }

  function recomputeDividendBatch(userId, params) {
    requireAdmin(userId);
    return ledger.recomputeDividendBatch({ ...params, operator: userId });
  }

  // ---------- 主数据维护 ----------
  function addGroup(userId, params) {
    requireAdmin(userId);
    return registry.addGroup(params);
  }

  function addProject(userId, params) {
    requireAdmin(userId);
    return registry.addProject(params);
  }

  function addParcel(userId, params) {
    requireAdmin(userId);
    return registry.addParcel(params);
  }

  function grantShare(userId, params) {
    // 受让户在经办范围内即可；admin 不限
    requireAdmin(userId);
    return registry.grantShare(params);
  }

  function addHousehold(userId, params) {
    policy.assertWrite(userId, params.groupId);
    return registry.addHousehold(params);
  }

  function markDeath(userId, params) {
    // 成员所属户跨组检索由登记层完成，这里先找到户再鉴权
    const user = policy.getUser(userId);
    let targetGroup = null;
    for (const household of registry.listHouseholds()) {
      if (household.members.some((m) => m.memberId === params.memberId)) {
        targetGroup = household.groupId;
        break;
      }
    }
    if (!targetGroup) throw new Error(`成员不存在：${params.memberId}`);
    policy.assertWrite(user.userId, targetGroup);
    return registry.markDeath(params.memberId, params.date);
  }

  // ---------- 只读查询：遵循村组查看范围 ----------
  function listHouseholds(userId) {
    return policy.filterHouseholds(userId, registry.listHouseholds());
  }

  function householdStatement(userId, params) {
    policy.assertRead(userId, groupOfHousehold(params.householdId));
    return buildHouseholdStatement(ledger, params);
  }

  function lot(userId, lotId) {
    const lotView = journal.lot(lotId);
    if (lotView) policy.assertRead(userId, lotView.groupId);
    return lotView;
  }

  function entries(userId, options = {}) {
    const user = policy.getUser(userId);
    return journal
      .entries()
      .filter((e) => e.groupId === null || user.role === ROLE.ADMIN || user.groupIds.has(e.groupId))
      .filter((e) => !options.householdId || e.householdId === options.householdId)
      .filter((e) => !options.period || e.period === options.period);
  }

  // 总账：admin 看全量；非 admin 只汇总本辖区到户分录（不含全局资金账）
  function balance(userId) {
    const user = policy.getUser(userId);
    if (user.role === ROLE.ADMIN) {
      return { scope: 'ALL', ...journal.trialBalance(), verification: journal.verify() };
    }
    const inScope = journal.lots().filter((l) => l.groupId !== null && user.groupIds.has(l.groupId));
    const sum = (field) => inScope.reduce((s, l) => s + l[field], 0);
    return {
      scope: 'GROUPS',
      groupIds: [...user.groupIds],
      lots: inScope.length,
      accruedCents: sum('accruedCents'),
      correctionCents: sum('correctionCents'),
      paidCents: sum('paidCents'),
      frozenCents: sum('frozenCents'),
      suspendedCents: sum('suspendedCents'),
      outstandingCents: sum('outstandingCents'),
      availableCents: sum('availableCents'),
      verification: journal.verify(), // 链上平衡状态对只读角色同样可见
    };
  }

  function verify(userId) {
    policy.getUser(userId); // 登录即可核验账本完整性
    return journal.verify();
  }

  return {
    ledger,
    registry,
    policy,
    receivePayment,
    accrueAnnual,
    accrueWage,
    distributeDividend,
    closePeriod,
    operate,
    payLot,
    payHousehold,
    suspendForReceiptDelay,
    freezeForInheritance,
    correctShares,
    transferShares,
    correctAnnualAfterSettlement,
    recomputeDividendBatch,
    addGroup,
    addProject,
    addParcel,
    grantShare,
    addHousehold,
    markDeath,
    listHouseholds,
    householdStatement,
    lot,
    entries,
    balance,
    verify,
  };
}

export { SOURCE };
