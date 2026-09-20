// 主数据登记：村组、项目、农户、家庭成员、地块与按有效期管理的权属份额。
// 登记信息是台账“当前认定”的来源，全部历史版本保留，事后更正只切版本、不删旧版。
// 账本侧的追溯由只追加分录保证，这里不做余额计算。

import { SOURCE } from './catalog.mjs';
import { muToHao } from './money.mjs';
import { assertDate, daysBetween, overlapDays, periodRange } from './time.mjs';

const SHARE_DENOM = 10000; // 份额以万分比表示

export function createRegistry() {
  const groups = new Map();
  const projects = new Map();
  const households = new Map();
  const parcels = new Map();

  function addGroup({ groupId, name }) {
    if (!groupId || !name) throw new Error('村组编号与名称必填');
    if (groups.has(groupId)) throw new Error(`村组已存在：${groupId}`);
    const group = { groupId, name };
    groups.set(groupId, group);
    return group;
  }

  function addProject({ projectId, name, sources }) {
    if (!projectId || !name) throw new Error('项目编号与名称必填');
    if (projects.has(projectId)) throw new Error(`项目已存在：${projectId}`);
    const list = sources ?? [SOURCE.RENT, SOURCE.DIVIDEND, SOURCE.WAGE, SOURCE.ECO_REWARD];
    for (const s of list) {
      if (!Object.values(SOURCE).includes(s)) throw new Error(`未知收益来源：${s}`);
    }
    const project = { projectId, name, sources: [...new Set(list)] };
    projects.set(projectId, project);
    return project;
  }

  function addHousehold({ householdId, groupId, headName, members = [] }) {
    if (households.has(householdId)) throw new Error(`农户已存在：${householdId}`);
    if (!groups.has(groupId)) throw new Error(`村组不存在：${groupId}`);
    const memberMap = new Map();
    const household = { householdId, groupId, headName, members: memberMap, createdAt: new Date().toISOString() };
    for (const m of members) addMember(household, m);
    households.set(householdId, household);
    return householdView(household);
  }

  function addMember(household, { memberId, name }) {
    if (!memberId || !name) throw new Error('成员编号与姓名必填');
    if (household.members.has(memberId)) throw new Error(`成员已存在：${memberId}`);
    household.members.set(memberId, { memberId, name, status: 'alive', deathDate: null });
  }

  function addMemberToHousehold(householdId, member) {
    const household = mustHousehold(householdId);
    addMember(household, member);
    return householdView(household);
  }

  function markDeath(memberId, date) {
    assertDate(date, '去世日期');
    for (const household of households.values()) {
      const member = household.members.get(memberId);
      if (member) {
        if (member.status === 'dead') throw new Error(`成员 ${memberId} 已登记去世`);
        member.status = 'dead';
        member.deathDate = date;
        return householdView(household);
      }
    }
    throw new Error(`成员不存在：${memberId}`);
  }

  function addParcel({ parcelId, projectId, areaMu, annualRentCentsPerMu = 0, annualEcoCentsPerMu = 0, name = '' }) {
    if (parcels.has(parcelId)) throw new Error(`地块已存在：${parcelId}`);
    if (!projects.has(projectId)) throw new Error(`项目不存在：${projectId}`);
    if (!Number.isInteger(annualRentCentsPerMu) || annualRentCentsPerMu < 0) {
      throw new Error('保底租金年标准必须是非负整数分/亩');
    }
    if (!Number.isInteger(annualEcoCentsPerMu) || annualEcoCentsPerMu < 0) {
      throw new Error('生态奖励年标准必须是非负整数分/亩');
    }
    const parcel = {
      parcelId,
      projectId,
      name,
      areaHao: muToHao(areaMu, '地块面积'),
      annualRentCentsPerMu,
      annualEcoCentsPerMu,
      shares: [],
    };
    parcels.set(parcelId, parcel);
    return parcelView(parcel);
  }

  // 授予权属份额：shareBasis 为万分比，[from, to) 有效；to=null 表示长期有效。
  function grantShare({ parcelId, householdId, shareBasis, from, to = null }) {
    const parcel = mustParcel(parcelId);
    mustHousehold(householdId);
    assertDate(from, '权属起始日');
    if (to !== null) assertDate(to, '权属终止日');
    if (to !== null && to <= from) throw new Error('权属终止日必须晚于起始日');
    if (!Number.isInteger(shareBasis) || shareBasis <= 0 || shareBasis > SHARE_DENOM) {
      throw new Error('份额必须是 1..10000 的万分比整数');
    }
    assertNoOverOverflow(parcel, from, to, shareBasis, null);
    const grant = { grantId: `G-${parcelId}-${parcel.shares.length + 1}`, householdId, shareBasis, from, to, supersededBy: null };
    parcel.shares.push(grant);
    return grant;
  }

  // 切版本内核：把与 [effectiveFrom, ∞) 重叠的旧版本切止保留，按 allocations 生成新版本。
  // kind 区分正常流转（transfer）与追溯更正（correction）。
  function reallocate(parcelId, allocations, effectiveFrom, reason, kind) {
    const parcel = mustParcel(parcelId);
    assertDate(effectiveFrom, '生效日');
    if (!reason || !String(reason).trim()) throw new Error('份额调整必须注明事由');
    if (!Array.isArray(allocations) || allocations.length === 0) throw new Error('新分配不能为空');
    let total = 0;
    for (const item of allocations) {
      mustHousehold(item.householdId);
      if (!Number.isInteger(item.shareBasis) || item.shareBasis < 0 || item.shareBasis > SHARE_DENOM) {
        throw new Error('份额必须是 0..10000 的万分比整数');
      }
      total += item.shareBasis;
    }
    if (total !== SHARE_DENOM) throw new Error(`新份额合计须为 ${SHARE_DENOM}，实际 ${total}`);

    const newGrants = [];
    // 凡与新生效区间 [effectiveFrom, ∞) 重叠的旧版本一律切止保留：
    // - 生效日之前开始、跨越生效日的：截至生效日（生效日之前的历史保持不变）；
    // - 生效日当日或之后开始的：整段作废（切为零长度），由新方案取代；
    // - 完全早于生效日结束的：原样保留。
    for (const old of parcel.shares) {
      // 已被更早调整切止的版本同样要处理：若其区间在更正生效日之后仍有残留，
      // 会与新版本叠加，必须一并切止；原取代标记保留，区间之外的历史原样保留。
      const oldTo = old.to ?? '9999-12-31';
      if (oldTo > effectiveFrom) {
        old.to = old.from >= effectiveFrom ? old.from : effectiveFrom;
        old.supersededBy ??= `${kind}@${effectiveFrom}`;
      }
    }
    for (const item of allocations) {
      if (item.shareBasis === 0) continue;
      const grant = {
        grantId: `G-${parcelId}-${parcel.shares.length + newGrants.length + 1}`,
        householdId: item.householdId,
        shareBasis: item.shareBasis,
        from: effectiveFrom,
        to: null,
        supersededBy: null,
        changeKind: kind,
        [kind === 'correction' ? 'correctionReason' : 'transferReason']: reason,
      };
      newGrants.push(grant);
    }
    parcel.shares.push(...newGrants);
    return newGrants;
  }

  // 年中流转（正向业务）：自生效日起按新方案分配，旧版本正常切止
  function transferShares(params) {
    return reallocate(params.parcelId, params.allocations, params.effectiveFrom, params.reason, 'transfer');
  }

  // 结算后权属更正：自 effectiveFrom 起把地块份额整体改为新分配，
  // 旧版本在该日切止并保留（supersededBy 指向新版本），账上差额由账本层出 CORRECTION。
  function correctShares(params) {
    return reallocate(params.parcelId, params.allocations, params.effectiveFrom, params.reason, 'correction');
  }

  function assertNoOverOverflow(parcel, from, to, shareBasis, ignoreGrantId) {
    // 切分为时间区间，检查份额合计不超过万分比分母
    const points = new Set([from, to ?? '9999-12-31']);
    for (const s of parcel.shares) {
      if (s.grantId === ignoreGrantId) continue;
      if (s.from >= from && (to === null || s.from < to)) points.add(s.from);
      if (s.to !== null && s.to > from && (to === null || s.to < to)) points.add(s.to);
    }
    const sorted = [...points].sort();
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const segFrom = sorted[i];
      const segTo = sorted[i + 1];
      let sum = shareBasis;
      if (segFrom >= from && (to === null || segFrom < to)) {
        for (const s of parcel.shares) {
          if (s.grantId === ignoreGrantId) continue;
          if (overlapDays(segFrom, segTo, s.from, s.to ?? '9999-12-31') > 0) sum += s.shareBasis;
        }
        if (sum > SHARE_DENOM) throw new Error(`地块 ${parcel.parcelId} 在 ${segFrom}~${segTo} 份额合计超过 100%`);
      }
    }
  }

  function mustHousehold(householdId) {
    const household = households.get(householdId);
    if (!household) throw new Error(`农户不存在：${householdId}`);
    return household;
  }

  function mustParcel(parcelId) {
    const parcel = parcels.get(parcelId);
    if (!parcel) throw new Error(`地块不存在：${parcelId}`);
    return parcel;
  }

  // 指定时点有效的地块份额
  function sharesAt(parcelId, date) {
    const parcel = mustParcel(parcelId);
    return parcel.shares.filter((s) => s.from <= date && (s.to === null || date < s.to)).map((s) => ({ ...s }));
  }

  // 某项目下、某期间内按“面积·份额·天”累计的户权重（用于经营分成按批次分摊）。
  // 权重使用 BigInt：九十万亩量级下面积(毫亩)×份额×天数会超出安全整数范围。
  function areaDayWeights(projectId, period, filterHouseholdIds = null) {
    const range = periodRange(period);
    const weights = new Map();
    const details = [];
    for (const parcel of parcels.values()) {
      if (parcel.projectId !== projectId) continue;
      // 切分点：期间边界 + 各版本起止
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
        for (const s of parcel.shares) {
          if (overlapDays(segFrom, segTo, s.from, s.to ?? '9999-12-31') > 0) {
            if (filterHouseholdIds && !filterHouseholdIds.has(s.householdId)) continue;
            const value = BigInt(parcel.areaHao) * BigInt(s.shareBasis) * BigInt(days); // 毫亩·万分比·天
            weights.set(s.householdId, (weights.get(s.householdId) ?? 0n) + value);
            details.push({ parcelId: parcel.parcelId, householdId: s.householdId, days, areaHao: parcel.areaHao, shareBasis: s.shareBasis, weight: value.toString() });
          }
        }
      }
    }
    return { weights, details, denom: SHARE_DENOM };
  }

  function householdView(household) {
    return {
      householdId: household.householdId,
      groupId: household.groupId,
      headName: household.headName,
      members: [...household.members.values()],
    };
  }

  function parcelView(parcel) {
    return {
      parcelId: parcel.parcelId,
      projectId: parcel.projectId,
      name: parcel.name,
      areaHao: parcel.areaHao,
      annualRentCentsPerMu: parcel.annualRentCentsPerMu,
      annualEcoCentsPerMu: parcel.annualEcoCentsPerMu,
      shares: parcel.shares.map((s) => ({ ...s })),
    };
  }

  return {
    addGroup,
    addProject,
    addHousehold,
    addMemberToHousehold,
    markDeath,
    addParcel,
    grantShare,
    transferShares,
    correctShares,
    sharesAt,
    areaDayWeights,
    shareDenominator: SHARE_DENOM,
    getGroup: (id) => (groups.has(id) ? { ...groups.get(id) } : null),
    getProject: (id) => (projects.has(id) ? { ...projects.get(id) } : null),
    getHousehold: (id) => (households.has(id) ? householdView(mustHousehold(id)) : null),
    getParcel: (id) => (parcels.has(id) ? parcelView(mustParcel(id)) : null),
    listParcels: () => [...parcels.values()].map(parcelView),
    listHouseholds: () => [...households.values()].map(householdView),
    listGroups: () => [...groups.values()].map((g) => ({ ...g })),
    listProjects: () => [...projects.values()].map((p) => ({ ...p })),
    daysBetween,
    snapshot() {
      return {
        version: 1,
        groups: [...groups.values()].map((g) => ({ ...g })),
        projects: [...projects.values()].map((p) => ({ ...p })),
        households: [...households.values()].map((h) => ({
          householdId: h.householdId,
          groupId: h.groupId,
          headName: h.headName,
          createdAt: h.createdAt,
          members: [...h.members.values()],
        })),
        parcels: [...parcels.values()].map(parcelView),
      };
    },
    // 仅供同模块 loadRegistry 使用的原始装载接口
    __restoreParcel(raw) {
      parcels.set(raw.parcelId, { ...raw, shares: raw.shares.map((s) => ({ ...s })) });
    },
  };
}

// 从快照重建登记台账（权属历史版本随 shares 一并保留）
export function loadRegistry(snapshot) {
  if (!snapshot || snapshot.version !== 1) throw new Error('登记台账快照版本不支持');
  const registry = createRegistry();
  for (const g of snapshot.groups) registry.addGroup(g);
  for (const p of snapshot.projects) registry.addProject(p);
  for (const h of snapshot.households) {
    registry.addHousehold({ householdId: h.householdId, groupId: h.groupId, headName: h.headName, members: [] });
    for (const m of h.members) {
      registry.addMemberToHousehold(h.householdId, { memberId: m.memberId, name: m.name });
      if (m.status === 'dead') registry.markDeath(m.memberId, m.deathDate);
    }
  }
  for (const p of snapshot.parcels) {
    registry.__restoreParcel({
      parcelId: p.parcelId,
      projectId: p.projectId,
      name: p.name,
      areaHao: p.areaHao,
      annualRentCentsPerMu: p.annualRentCentsPerMu,
      annualEcoCentsPerMu: p.annualEcoCentsPerMu,
      shares: p.shares,
    });
  }
  return registry;
}
