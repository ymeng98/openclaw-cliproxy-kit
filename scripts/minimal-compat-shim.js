const http = require('http');

const LISTEN_PORT = Number(process.env.COMPAT_PORT || 8318);
const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';
const TARGET_PORT = Number(process.env.TARGET_PORT || 8317);

function collect(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function normalizeEffort(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === 'minimal') return 'low';
  if (['low', 'medium', 'high', 'xhigh'].includes(text)) return text;
  return 'low';
}

function maybeRewriteJsonBody(req, bodyBuffer) {
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.includes('application/json') || !bodyBuffer.length) {
    return { body: bodyBuffer, rewritten: false, reason: 'non-json-or-empty' };
  }

  try {
    const parsed = JSON.parse(bodyBuffer.toString('utf8'));
    let rewritten = false;
    let reason = 'no-change';

    if (parsed && typeof parsed === 'object') {
      if (parsed.reasoning && typeof parsed.reasoning === 'object' && parsed.reasoning.effort === 'minimal') {
        parsed.reasoning.effort = 'low';
        rewritten = true;
        reason = 'reasoning minimal->low';
      }

      if (parsed.thinking && typeof parsed.thinking === 'object') {
        const sourceLevel = parsed.thinking.level || parsed.thinking.effort;
        const effort = normalizeEffort(sourceLevel);
        parsed.reasoning = {
          ...(parsed.reasoning && typeof parsed.reasoning === 'object' ? parsed.reasoning : {}),
          effort: effort || 'low'
        };
        delete parsed.thinking;
        rewritten = true;
        reason = `thinking->reasoning(${effort || 'low'})`;
      }
    }

    const nextBody = rewritten ? Buffer.from(JSON.stringify(parsed)) : bodyBuffer;
    return { body: nextBody, rewritten, reason };
  } catch {
    return { body: bodyBuffer, rewritten: false, reason: 'json-parse-failed' };
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const originalBody = await collect(req);
    const rewritten = maybeRewriteJsonBody(req, originalBody);

    const headers = { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` };
    if (rewritten.body) {
      headers['content-length'] = String(rewritten.body.length);
    }

    const proxyReq = http.request({
      host: TARGET_HOST,
      port: TARGET_PORT,
      method: req.method,
      path: req.url,
      headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (error) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `compat proxy error: ${error.message}` } }));
    });

    if (rewritten.rewritten) {
      console.log(`[compat] ${req.method} ${req.url} rewritten ${rewritten.reason}`);
    }

    if (rewritten.body.length) {
      proxyReq.write(rewritten.body);
    }
    proxyReq.end();
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `compat proxy failure: ${error.message}` } }));
  }
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`compat shim listening on http://127.0.0.1:${LISTEN_PORT} -> http://${TARGET_HOST}:${TARGET_PORT}`);
});
