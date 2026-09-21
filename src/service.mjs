import { Ledger } from './ledger.mjs';
import { runScenario } from './scenario.mjs';
import { renderStatement } from './report.mjs';

/** 解析查看者：admin / group:G1 / household:H01；缺省拒绝 */
export function parseViewer(text) {
  if (!text) throw new Error('缺少查看者（viewer）');
  if (text === 'admin') return { scope: 'admin' };
  const [scope, id] = text.split(':');
  if (scope === 'group' && id) return { scope: 'group', groupId: id };
  if (scope === 'household' && id) return { scope: 'household', householdId: id };
  throw new Error(`无法识别的查看者 ${text}`);
}

/** 演示用账套：服务启动时载入完整回放场景（内存账） */
export function createDemoContext() {
  const { ledger } = runScenario();
  return { ledger };
}

export function listHouseholds(ledger, viewer) {
  return ledger.visibleHouseholdIds(viewer).map((id) => ledger.store.households.get(id));
}

export function getStatement(ledger, householdId, viewer, { format = 'json' } = {}) {
  const statement = ledger.householdStatement(householdId, viewer);
  return format === 'text' ? renderStatement(statement) : statement;
}
