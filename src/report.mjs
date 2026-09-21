import { formatYuan } from './money.mjs';
import { SOURCE_NAME } from './ledger.mjs';

/**
 * 把 householdStatement 的结果渲染为可打印的中文回放明细。
 * 每笔分录列示金额、依据与滚动余额，末尾给对账与验链结论。
 */
export function renderStatement(statement) {
  const lines = [];
  const { household } = statement;
  lines.push(`林农收益分配明细（回放）`);
  lines.push(`户：${household.name}（${household.id}）　村组：${household.groupId}`);
  lines.push('─'.repeat(88));
  lines.push(
    ['日期', '凭证号', '类型', '项目', '来源', '批次', '借(元)', '贷(元)', '摘要']
      .map((title, index) => pad(title, [10, 11, 5, 5, 8, 4, 11, 11, 24][index])).join(' '),
  );
  lines.push('─'.repeat(88));

  for (const entry of statement.entries) {
    lines.push(
      [
        entry.dateText,
        entry.voucherNo,
        entry.type,
        entry.projectId ?? '',
        entry.source ? SOURCE_NAME[entry.source] ?? entry.source : '',
        entry.batchNo ?? '',
        entry.entryDebit ? formatYuan(entry.entryDebit) : '',
        entry.entryCredit ? formatYuan(entry.entryCredit) : '',
        entry.note,
      ]
        .map((value, index) => pad(value, [10, 11, 5, 5, 8, 4, 11, 11, 24][index])).join(' '),
    );
    for (const line of entry.lines) {
      lines.push(`    └ ${line.account} 借 ${formatYuan(line.debit)} 贷 ${formatYuan(line.credit)}　${describeAux(line.aux)}`);
    }
    const running = entry.running;
    lines.push(
      `      滚动余额：应付 ${formatYuan(-running['应付收益款'])}　冻结 ${formatYuan(-running['冻结待付'])}　应追回 ${formatYuan(running['应追回款'])}`,
    );
  }

  lines.push('─'.repeat(88));
  const r = statement.reconciliation;
  lines.push('对账结论：');
  lines.push(`  净计提 ${formatYuan(r.accrued)}　跨户转入 ${formatYuan(r.transferredIn)}　跨户转出 ${formatYuan(r.transferredOut)}`);
  lines.push(`  已发放 ${formatYuan(r.paid)}　退回 ${formatYuan(r.repaid)}　净到账 ${formatYuan(r.netPaid)}`);
  lines.push(`  应付余额 ${formatYuan(r.payable)}　冻结在账 ${formatYuan(r.frozen)}　应追回款 ${formatYuan(r.recoverable)}`);
  lines.push(`  恒等式：净计提 + 跨户转入 = 净到账 + 应付 + 冻结 + 跨户转出　${r.identityHolds ? '✓ 平衡' : '✗ 不平'}`);
  lines.push(`总账平衡：${statement.ledgerBalanced ? '✓' : '✗'}　哈希链：${statement.chain.ok ? `✓（${statement.chain.count} 张凭证）` : `✗ ${statement.chain.at} ${statement.chain.reason}`}`);
  return lines.join('\n');
}

function describeAux(aux) {
  if (!aux) return '';
  const parts = [];
  if (aux.personId) parts.push(`成员 ${aux.personId}`);
  if (aux.reason) parts.push(aux.reason);
  if (aux.releasedFromPerson) parts.push(`自 ${aux.releasedFromPerson} 转入`);
  if (aux.basis?.ppmDays) {
    const total = aux.basis.ppmDays.reduce((acc, segment) => acc + segment.ppm * segment.days, 0);
    parts.push(`份额依据 ${aux.basis.ppmDays.length} 段（份额×天数加权 ${total}）`);
    for (const segment of aux.basis.ppmDays.slice(0, 3)) {
      parts.push(`　· [${segment.fromText},${segment.toText}) ${segment.days}天 × ${segment.ppm}ppm${segment.frozen ? `（${segment.reason}冻结）` : ''}`);
    }
    if (aux.basis.ppmDays.length > 3) parts.push(`　· …共 ${aux.basis.ppmDays.length} 段`);
  }
  if (aux.basis?.records) {
    for (const record of aux.basis.records) {
      parts.push(`　· 务工单 ${record.recordNo} ${record.dayText} ${record.hours}工时 × ${formatYuan(record.hourlyRateFen)}元 = ${formatYuan(record.fen)}`);
    }
  }
  return parts.join('；');
}

function pad(value, width) {
  const text = String(value);
  const visual = visualWidth(text);
  return visual >= width ? text : text + ' '.repeat(width - visual);
}

// 中日韩全角字符按两个英文宽度计，保证列对齐
function visualWidth(text) {
  let width = 0;
  for (const char of text) {
    width += /[⺀-鿿　-〿＀-￯✓✗]/.test(char) ? 2 : 1;
  }
  return width;
}
