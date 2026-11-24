import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * .env ファイルを読み込み、process.env に未設定のキーだけ設定する。
 * コメント行（# 始まり）、空行、値の前後にある引用符（"..." / '...'）を処理する。
 */
function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const line = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// カレントディレクトリと server.mjs と同じディレクトリの .env を順に確認する
const envCandidates = [...new Set([path.join(process.cwd(), '.env'), path.join(__dirname, '.env')])];
for (const envPath of envCandidates) {
  loadEnvFile(envPath);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getConfig() {
  return {
    dsn: process.env.SENTRY_DSN ?? '',
    environment: process.env.SENTRY_ENVIRONMENT ?? 'development',
    release: process.env.SENTRY_RELEASE ?? 'moca-web@1.0.0',
  };
}

/**
 * sentry-trace ヘッダ（<traceId>-<parentSpanId>[-<sampled>]）を解析する。
 * ヘッダが無い、または形式が不正な場合は新しい traceId を生成する。
 */
function parseSentryTrace(headerValue) {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const match =
    typeof raw === 'string'
      ? raw.trim().match(/^([0-9a-f]{32})-([0-9a-f]{16})(?:-(0|1))?$/i)
      : null;

  if (match) {
    return {
      traceId: match[1].toLowerCase(),
      parentSpanId: match[2].toLowerCase(),
      sampled: match[3] ?? null,
    };
  }

  return {
    traceId: randomBytes(16).toString('hex'),
    parentSpanId: null,
    sampled: null,
  };
}

/**
 * Sentry DSN（https://<publicKey>@<host>/<projectId>）を解析する。
 * ログ出力に secret を含めないため、呼び出し側でも key や dsn は表示しない。
 */
function parseDsn(dsn) {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const host = url.host;
    const projectId = url.pathname.replace(/^\/+|\/+$/g, '');
    if (!publicKey || !host || !projectId) return null;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return {
      protocol: url.protocol,
      publicKey,
      host,
      projectId,
    };
  } catch {
    return null;
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;
  const maxBytes = 64 * 1024;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      const err = new Error('Payload too large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('Invalid JSON');
    err.statusCode = 400;
    throw err;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, { 'Content-Type': contentType });
  res.end(text);
}

/**
 * サーバー側の処理スパンを Sentry Transaction Envelope として送信する。
 * 標準出力には status と trace_id のみ出し、DSN や publicKey は絶対に出力しない。
 */
async function sendServerTransaction({
  dsn,
  environment,
  release,
  traceId,
  parentSpanId,
  startTimeMs,
  paymentStartMs,
  endTimeMs,
  failed,
  statusCode,
}) {
  const parsed = parseDsn(dsn);
  if (!parsed) {
    console.warn(`[server-trace] status=skipped_invalid_dsn trace_id=${traceId}`);
    return;
  }

  const eventId = randomBytes(16).toString('hex');
  const serverSpanId = randomBytes(8).toString('hex');
  const paymentSpanId = randomBytes(8).toString('hex');
  const startTimestamp = startTimeMs / 1000;
  const paymentStartTimestamp = paymentStartMs / 1000;
  const timestamp = endTimeMs / 1000;

  const envelopeHeader = {
    event_id: eventId,
    sent_at: new Date().toISOString(),
    dsn,
    sdk: {
      name: 'moca.node.custom',
      version: '1.0.0',
    },
  };

  const itemHeader = { type: 'transaction' };

  const traceContext = {
    trace_id: traceId,
    span_id: serverSpanId,
    op: 'http.server',
    status: failed ? 'internal_error' : 'ok',
    data: {
      'http.method': 'POST',
      url: '/api/orders',
      'http.response.status_code': statusCode,
    },
  };
  if (parentSpanId) {
    traceContext.parent_span_id = parentSpanId;
  }

  const transactionItem = {
    event_id: eventId,
    type: 'transaction',
    transaction: 'POST /api/orders',
    transaction_info: { source: 'route' },
    platform: 'node',
    environment,
    release,
    start_timestamp: startTimestamp,
    timestamp,
    contexts: {
      trace: traceContext,
    },
    spans: [
      {
        trace_id: traceId,
        span_id: paymentSpanId,
        parent_span_id: serverSpanId,
        op: 'payment.authorize',
        description: failed ? 'card_declined' : 'authorize card',
        start_timestamp: paymentStartTimestamp,
        timestamp,
        status: failed ? 'internal_error' : 'ok',
      },
    ],
  };

  const envelopeBody = [
    JSON.stringify(envelopeHeader),
    JSON.stringify(itemHeader),
    JSON.stringify(transactionItem),
  ].join('\n');

  const endpoint = `${parsed.protocol}//${parsed.host}/api/${parsed.projectId}/envelope/`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${parsed.publicKey}, sentry_client=moca-sample/1.0.0`,
      },
      body: envelopeBody,
    });
    console.log(`[server-trace] status=${response.status} trace_id=${traceId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error';
    console.error(`[server-trace] status=error trace_id=${traceId} message=${message}`);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = reqUrl.pathname;
    const method = req.method ?? 'GET';

    // 本番運用の基本として、ソースマップ (.map) は HTTP で公開しない
    if (pathname.endsWith('.map')) {
      sendText(res, 404, 'Not Found');
      return;
    }

    if (method === 'GET' && pathname === '/config.json') {
      sendJson(res, 200, getConfig());
      return;
    }

    if (method === 'GET' && pathname === '/') {
      const html = await readFile(path.join(__dirname, 'index.html'), 'utf8');
      sendText(res, 200, html, 'text/html; charset=utf-8');
      return;
    }

    if (method === 'GET' && pathname === '/minified') {
      const html = await readFile(path.join(__dirname, 'index.html'), 'utf8');
      const minifiedHtml = html
        .replace('src="/app.js"', 'src="/dist/app.min.js"')
        .replace('data-mode="normal"', 'data-mode="minified"')
        .replace('通常版（/app.js）', '縮小版（/dist/app.min.js）')
        .replace(
          '<a href="/minified" id="mode-switch">縮小版 (/minified) に切り替え</a>',
          '<a href="/" id="mode-switch">通常版 (/) に切り替え</a>'
        );
      sendText(res, 200, minifiedHtml, 'text/html; charset=utf-8');
      return;
    }

    if (method === 'GET' && pathname === '/app.js') {
      const js = await readFile(path.join(__dirname, 'app.js'), 'utf8');
      sendText(res, 200, js, 'text/javascript; charset=utf-8');
      return;
    }

    if (method === 'GET' && pathname === '/dist/app.min.js') {
      try {
        const minJs = await readFile(path.join(__dirname, 'dist', 'app.min.js'), 'utf8');
        sendText(res, 200, minJs, 'text/javascript; charset=utf-8');
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          sendText(res, 404, 'dist/app.min.js not found. Run `npm run build` first.');
          return;
        }
        throw err;
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/orders') {
      const startTimeMs = Date.now();
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, err.statusCode ?? 400, { error: err.message ?? 'bad_request' });
        return;
      }

      const { traceId, parentSpanId } = parseSentryTrace(req.headers['sentry-trace']);
      const isSlow = Array.isArray(body?.items) && body.items.includes('slow');
      const delayMs = isSlow ? 400 : 40;

      const paymentStartMs = Date.now();
      await sleep(delayMs);
      const endTimeMs = Date.now();

      const failed = body?.cardToken === 'tok_fail';
      const statusCode = failed ? 402 : 201;
      const orderId = body?.orderId ?? `ord_${randomBytes(4).toString('hex')}`;

      const config = getConfig();
      if (config.dsn) {
        await sendServerTransaction({
          dsn: config.dsn,
          environment: config.environment,
          release: config.release,
          traceId,
          parentSpanId,
          startTimeMs,
          paymentStartMs,
          endTimeMs,
          failed,
          statusCode,
        });
      }

      if (failed) {
        sendJson(res, statusCode, { error: 'card_declined', traceId });
      } else {
        sendJson(res, statusCode, { orderId, traceId });
      }
      return;
    }

    sendText(res, 404, 'Not Found');
  } catch (err) {
    console.error('[server-error]', err);
    sendText(res, 500, 'Internal Server Error');
  }
});

const port = Number(process.env.PORT || 8787);
server.listen(port, () => {
  console.log(`Moca o11y sample server listening on http://localhost:${port}`);
});

export { server };
