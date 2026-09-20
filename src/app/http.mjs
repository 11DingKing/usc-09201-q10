// HTTP 适配层：写操作统一走 POST /api/commands { action, params }，
// 查询走 GET。鉴权用 x-user-id 头，村组范围由应用服务强制。
// 错误约定：400 业务校验失败；401 未登录；403 越权；404 资源不存在。

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) reject(new Error('请求体过大'));
    });
    request.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    request.on('error', reject);
  });
}

export function createHttpHandler(service, { afterCommand = null } = {}) {
  // action -> 应用服务写方法
  const COMMANDS = {
    receivePayment: service.receivePayment,
    accrueAnnual: service.accrueAnnual,
    accrueWage: service.accrueWage,
    distributeDividend: service.distributeDividend,
    closePeriod: service.closePeriod,
    operate: service.operate,
    payLot: service.payLot,
    payHousehold: service.payHousehold,
    suspendForReceiptDelay: service.suspendForReceiptDelay,
    freezeForInheritance: service.freezeForInheritance,
    correctShares: service.correctShares,
    transferShares: service.transferShares,
    correctAnnual: service.correctAnnualAfterSettlement,
    recomputeDividend: service.recomputeDividendBatch,
    addHousehold: service.addHousehold,
    markDeath: service.markDeath,
    addGroup: service.addGroup,
    addProject: service.addProject,
    addParcel: service.addParcel,
    grantShare: service.grantShare,
  };

  return async function handler(request, response) {
    const url = new URL(request.url, 'http://local');
    if (request.method === 'GET' && url.pathname === '/health') {
      return send(response, 200, { status: 'ok' });
    }
    if (!url.pathname.startsWith('/api/')) {
      return send(response, 404, { error: 'not_found' });
    }

    const userId = request.headers['x-user-id'];

    try {
      // ---------- 写命令 ----------
      if (request.method === 'POST' && url.pathname === '/api/commands') {
        if (!userId) return send(response, 401, { error: 'unauthorized', message: '缺少 x-user-id' });
        const body = await readJson(request);
        const { action, params = {} } = body;
        const fn = COMMANDS[action];
        if (!fn) return send(response, 400, { error: 'unknown_action', action });
        const result = await fn(userId, params);
        if (afterCommand) await afterCommand({ action, params, result });
        return send(response, 200, { ok: true, action, result });
      }

      // ---------- 查询 ----------
      if (request.method === 'GET') {
        if (!userId) return send(response, 401, { error: 'unauthorized', message: '缺少 x-user-id' });
        const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
        if (parts[1] === 'balance') {
          return send(response, 200, service.balance(userId));
        }
        if (parts[1] === 'verify') {
          return send(response, 200, service.verify(userId));
        }
        if (parts[1] === 'households' && parts.length === 2) {
          return send(response, 200, { households: service.listHouseholds(userId) });
        }
        if (parts[1] === 'households' && parts[3] === 'statement') {
          const statement = service.householdStatement(userId, {
            householdId: decodeURIComponent(parts[2]),
            period: url.searchParams.get('period'),
          });
          return send(response, 200, statement);
        }
        if (parts[1] === 'lots' && parts.length === 3) {
          const lot = service.lot(userId, decodeURIComponent(parts[2]));
          if (!lot) return send(response, 404, { error: 'lot_not_found' });
          return send(response, 200, lot);
        }
        if (parts[1] === 'entries') {
          return send(response, 200, {
            entries: service.entries(userId, {
              householdId: url.searchParams.get('householdId'),
              period: url.searchParams.get('period'),
            }),
          });
        }
      }
      return send(response, 404, { error: 'not_found' });
    } catch (error) {
      const status = error.code === 'FORBIDDEN' ? 403 : error.code === 'UNAUTHENTICATED' ? 401 : 400;
      const code = status === 403 ? 'forbidden' : status === 401 ? 'unauthenticated' : 'bad_request';
      return send(response, status, { error: code, message: error.message });
    }
  };
}
