# 林农收益分配账

九十万亩林地流转后，村集体按权属有效期把**保底租金、经营分成、务工收入、生态奖励**
四类收益结算到户的分配账系统。核心目标：每笔到账、冻结、追补都能逐笔还原计算依据，
年终回放时总账平衡、凭证不可篡改。

## 设计要点

- **分录只追加**：暂缓、追补、解冻、纠错、追偿、退回全部是新凭证；结算后权属更正
  走“红冲 + 蓝补”，旧凭证永久保留。
- **复式记账**：现金池 / 项目收益清算 / 应付收益款 / 冻结待付 / 应追回款五科目，
  每张凭证借贷相等，全账恒平。
- **权属有效期计提**：地块类收益按 份额ppm × 天数 分段加权；争议窗口、继承待定期间
  自动暂缓冻结；迟回批次自动生成追补。
- **务工记录号幂等**：同一务工单重传被拒绝，杜绝重复计酬。
- **继承跨户**：成员去世后份额冻结，继承确定后冻结款解冻到继承人所在户。
- **凭证哈希链（SHA-256）**：篡改任何一张旧凭证都会被 `verifyChain()` 定位。
- **村组权限**：经管 / 村组 / 农户三级查看范围。
- 金额一律整数“分”，按权重分金用最大余数法，分毫不差。

## 目录

```
src/
  money.mjs     整数分、最大余数法分金
  time.mjs      日序号、结算期区间
  ledger.mjs    账表引擎：登记/计提/暂缓/解冻/追补/红冲蓝补/追偿/对账/验链
  scenario.mjs  年终回放样板场景（跨 P-A、P-B 两项目，覆盖全部特殊情况）
  report.mjs    按户文本回放明细渲染
  service.mjs   查询服务与查看者鉴权
  server.mjs    HTTP 接口
test/           node:test 测试（21 项）
docs/domain.md  领域约定（科目、恒等式、更正流程）
```

## 运行

```bash
npm test        # 21 项测试
npm start       # http://localhost:3000
```

## HTTP 接口

所有查询都必须带 `viewer`：`admin` | `group:<村组号>` | `household:<户号>`。

```bash
curl 'http://localhost:3000/health'
curl 'http://localhost:3000/households?viewer=admin'
curl 'http://localhost:3000/households/H01/statement?viewer=admin'            # JSON 逐笔回放
curl 'http://localhost:3000/households/H01/statement?viewer=admin&format=text' # 文本对账单
```

越权（如外组查看）返回 403；缺 `viewer` 同样拒绝。

## 代码内使用

```js
import { Ledger } from './src/ledger.mjs';
import { runScenario } from './src/scenario.mjs';

const { ledger } = runScenario();           // 载入完整年终回放场景
ledger.isBalanced();                        // 总账平衡
ledger.verifyChain();                       // 哈希链核验
ledger.householdStatement('H01', { scope: 'admin' }); // 按户可核验明细
```

样板场景（`src/scenario.mjs`）覆盖：回款分批与延迟追补、成员去世继承待定与跨户解冻、
务工记录重传幂等、地块份额争议暂缓与解冻、结算后权属更正（红冲/蓝补/转追偿）与
多领退回，最终三户净额合计恰等于项目回款总额 13,600.00 元。
