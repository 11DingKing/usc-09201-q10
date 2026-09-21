import http from 'node:http';
import { createDemoContext, getStatement, listHouseholds, parseViewer } from './service.mjs';

export function createServer(context = createDemoContext()) {
  return http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/households') {
      try {
        const viewer = parseViewer(url.searchParams.get('viewer'));
        sendJson(response, 200, { households: listHouseholds(context.ledger, viewer) });
      } catch (error) {
        sendJson(response, 403, { error: error.message });
      }
      return;
    }

    const statementMatch = url.pathname.match(/^\/households\/([^/]+)\/statement$/);
    if (request.method === 'GET' && statementMatch) {
      const householdId = decodeURIComponent(statementMatch[1]);
      try {
        const viewer = parseViewer(url.searchParams.get('viewer'));
        const format = url.searchParams.get('format') ?? 'json';
        if (format === 'text') {
          const text = getStatement(context.ledger, householdId, viewer, { format: 'text' });
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          response.end(text);
          return;
        }
        sendJson(response, 200, getStatement(context.ledger, householdId, viewer));
      } catch (error) {
        const status = /无权查看|缺少查看者|无法识别/.test(error.message)
          ? 403
          : /不存在/.test(error.message)
            ? 404
            : 400;
        sendJson(response, status, { error: error.message });
      }
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`服务已启动：http://0.0.0.0:${port}`);
  });
}
