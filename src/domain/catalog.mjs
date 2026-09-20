// 收益来源与分录类型等领域常量。

// 四类收益来源
export const SOURCE = {
  RENT: 'RENT', // 保底租金
  DIVIDEND: 'DIVIDEND', // 经营分成
  WAGE: 'WAGE', // 务工收入
  ECO_REWARD: 'ECO_REWARD', // 生态奖励
};

export const SOURCE_LABELS = {
  RENT: '保底租金',
  DIVIDEND: '经营分成',
  WAGE: '务工收入',
  ECO_REWARD: '生态奖励',
};

// 只追加分录类型
export const ENTRY = {
  RECEIPT: 'RECEIPT', // 项目回款入资金账
  ACCRUAL: 'ACCRUAL', // 计提应付（到户）
  CORRECTION: 'CORRECTION', // 权属/依据更正（带符号差额，追加）
  PAYMENT: 'PAYMENT', // 到账支付
  FREEZE: 'FREEZE', // 冻结（如继承待定）
  RELEASE: 'RELEASE', // 解冻
  SUSPEND: 'SUSPEND', // 暂缓支付（如争议、回款不足）
  RESUME: 'RESUME', // 恢复暂缓
  CLOSE_PERIOD: 'CLOSE_PERIOD', // 结算期关账（链上留痕，重放即恢复关账状态）
};

// 冻结/暂缓原因
export const REASON = {
  INHERITANCE_PENDING: 'INHERITANCE_PENDING', // 继承待定
  SHARE_DISPUTE: 'SHARE_DISPUTE', // 地块份额争议
  RECEIPT_DELAY: 'RECEIPT_DELAY', // 项目回款延迟
  CORRECTION_ADJUST: 'CORRECTION_ADJUST', // 更正分录联动调整挂账
};

export const REASON_LABELS = {
  INHERITANCE_PENDING: '人员去世、继承待定',
  SHARE_DISPUTE: '地块份额争议',
  RECEIPT_DELAY: '项目回款延迟',
  CORRECTION_ADJUST: '权属更正联动调整',
};

// 角色：admin 全县/镇范围；manager 经办，限本组；viewer 只读，限本组
export const ROLE = {
  ADMIN: 'admin',
  MANAGER: 'manager',
  VIEWER: 'viewer',
};

export const MEMBER_STATUS = {
  ALIVE: 'alive',
  DEAD: 'dead',
};
