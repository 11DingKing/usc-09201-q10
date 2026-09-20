# 林农收益分配账

九十万亩林地陆续流转后，村集体把**保底租金、经营分成、务工收入、生态奖励**四类
收益分别结算到户的分配台账。核心是一套**只追加分录账**：任何暂缓、冻结、追补、
纠错都是新分录，历史永不改写；全部余额由分录投影，可逐笔重放并核验总账平衡。

详见 [`docs/domain.md`](docs/domain.md)。

## 设计要点

- **以权属有效期 + 收益来源生成应付分录**：租金/生态奖励按面积、份额（万分比）、
  有效天数按日分摊；经营分成随项目回款批次按“面积×份额×天”权重分摊；务工按记录
  计提。跨户分摊用最大余数法，各户之和恒等于总额。
- **只追加 + 哈希链**：每条分录带前链哈希与内容哈希（SHA-256），覆盖全部字段与
  结构化计算依据快照；改动任何旧账，重放核验即失败。
- **跨期场景全部追加分录**：回款分批/迟到（部分支付、资金缺口、迟到记账）、成员
  去世继承待定（冻结/解冻）、务工重传（幂等键）、地块份额争议（暂缓/裁决重算）、
  关账后权属更正（`post_close` 更正 + 红字追回 + 追补兑付，两阶段提交）。
- **按户可核验明细**：回放单逐笔列示到账、冻结、追补的计算依据、关联分录与哈希，
  并出具链头与本户指纹。
- **村组权限**：admin 跨组；manager 限本组读写；viewer 限本组只读。查询与总账按
  村组范围过滤。
- 金额整数“分”、面积整数“毫亩”，权重 BigInt，九十万亩×全年也不丢精度。

## 运行

```bash
npm install   # 无第三方依赖，仅需 Node >= 20
npm test      # 15 个测试
npm start     # 默认 http://0.0.0.0:3000
```

环境变量：`STORE_FILE`（账册 JSON，默认 `data/ledger.json`）、`PORT`、
`ADMIN_ID` / `ADMIN_NAME`（首次启动的管理员）。账册落盘为原子写，启动时通过哈希链
重放校验，被篡改即拒绝启动。

## HTTP 接口

所有写操作统一为 `POST /api/commands`，请求头 `x-user-id` 标识经办人；查询用 GET。

```bash
H='-H content-type:application/json -H x-user-id:A1'
curl -s $H localhost:3000/api/commands -d '{"action":"addGroup","params":{"groupId":"G1","name":"青山村一组"}}'
# addProject / addHousehold / addParcel / grantShare / transferShares
# receivePayment / accrueAnnual / accrueWage / distributeDividend
# payLot / payHousehold / suspendForReceiptDelay / freezeForInheritance / operate
# correctShares / correctAnnual / recomputeDividend / closePeriod / markDeath

curl -s -H x-user-id:A1 localhost:3000/api/balance                 # 总账与平衡核验
curl -s -H x-user-id:A1 localhost:3000/api/verify                  # 哈希链核验
curl -s -H x-user-id:A1 localhost:3000/api/households/H1/statement # 按户可核验回放单
curl -s -H x-user-id:A1 'localhost:3000/api/entries?period=2026'   # 分录链
```

状态码：400 业务校验失败；401 未登录/用户无效；403 越权；404 资源不存在。

## 模块

```
src/domain/   常量、定点金额、日期、哈希、登记台账、只追加分录账、门面、回放单、权限
src/app/      应用服务（权限织入）、HTTP 适配、JSON 持久化
src/server.mjs 启动装配
test/         领域场景、权属版本、权限、持久化、防篡改、HTTP 共 15 个测试
```
