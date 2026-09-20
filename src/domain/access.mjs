// 村组权限：查看与操作范围遵循村组归属。
// admin 跨村组；manager 限本组读写；viewer 限本组只读。

import { ROLE } from './catalog.mjs';

export function createAccessPolicy(users = []) {
  const byId = new Map();
  for (const user of users) addUser(user);

  function addUser({ userId, name, role, groupIds = [] }) {
    if (!userId || !name) throw new Error('用户编号与姓名必填');
    if (!Object.values(ROLE).includes(role)) throw new Error(`未知角色：${role}`);
    if (role !== ROLE.ADMIN && (!Array.isArray(groupIds) || groupIds.length === 0)) {
      throw new Error(`${role} 必须指定村组范围`);
    }
    byId.set(userId, { userId, name, role, groupIds: new Set(groupIds) });
  }

  function getUser(userId) {
    const user = byId.get(userId);
    if (!user) {
      const error = new Error(`用户不存在或未登录：${userId ?? '(空)'}`);
      error.code = 'UNAUTHENTICATED';
      throw error;
    }
    return user;
  }

  function scopeOf(user) {
    return user.role === ROLE.ADMIN ? null : new Set(user.groupIds);
  }

  function canRead(user, groupId) {
    return user.role === ROLE.ADMIN || user.groupIds.has(groupId);
  }

  function canWrite(user, groupId) {
    return user.role !== ROLE.VIEWER && canRead(user, groupId);
  }

  function assertRead(userId, groupId) {
    const user = getUser(userId);
    if (!canRead(user, groupId)) {
      const error = new Error(`无权查看村组 ${groupId} 的数据`);
      error.code = 'FORBIDDEN';
      throw error;
    }
    return user;
  }

  function assertWrite(userId, groupId) {
    const user = getUser(userId);
    if (user.role === ROLE.VIEWER) {
      const error = new Error('只读角色不能进行写操作');
      error.code = 'FORBIDDEN';
      throw error;
    }
    if (!canRead(user, groupId)) {
      const error = new Error(`无权操作村组 ${groupId} 的数据`);
      error.code = 'FORBIDDEN';
      throw error;
    }
    return user;
  }

  // 列表按村组范围过滤；admin 返回 null 表示不过滤
  function visibleGroupFilter(userId) {
    return scopeOf(getUser(userId));
  }

  function filterHouseholds(userId, households) {
    const scope = scopeOf(getUser(userId));
    if (scope === null) return households;
    return households.filter((h) => scope.has(h.groupId));
  }

  return { addUser, getUser, canRead, canWrite, assertRead, assertWrite, visibleGroupFilter, filterHouseholds };
}
