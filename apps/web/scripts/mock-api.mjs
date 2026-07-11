#!/usr/bin/env node
import { readFileSync } from 'node:fs';
// Dev-only stand-in for the Express API (apps/api), so apps/web can be developed and screenshotted
// before that server exists. Serves the real captured fixture at GET /api/dashboard, a stub
// GET /health, and a stub POST /api/refresh — enough surface for next.config.ts's rewrites and
// lib/api.ts's getDashboard()/triggerRefresh() to exercise against something real. No dependencies
// (plain node:http), matching the rest of this repo's zero-dep dev scripts.
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(
  rootDir,
  '..',
  '..',
  'api',
  'tests',
  'fixtures',
  'dashboard-payload.json',
);

let fixtureBody;
try {
  fixtureBody = readFileSync(fixturePath);
} catch (error) {
  console.error(`[mock-api] could not read fixture at ${fixturePath}`);
  console.error(error);
  process.exit(1);
}

const port = Number(process.env.MOCK_API_PORT ?? 4000);
const host = process.env.MOCK_API_HOST ?? '127.0.0.1';

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);

  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    // run_id is accepted but ignored — the fixture only has one run.
    sendJson(res, 200, fixtureBody);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, JSON.stringify({ status: 'ok', mock: true }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/refresh') {
    sendJson(res, 202, JSON.stringify({ status: 'accepted', mock: true }));
    return;
  }

  sendJson(res, 404, JSON.stringify({ status: 'not_found', path: url.pathname }));
});

server.listen(port, host, () => {
  console.log(`[mock-api] serving ${fixturePath}`);
  console.log(
    `[mock-api] listening on http://${host}:${port} (GET /api/dashboard, GET /health, POST /api/refresh)`,
  );
});
