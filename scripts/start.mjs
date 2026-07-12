#!/usr/bin/env node
// Exits non-zero the moment either child process dies, so Railway's restart policy kicks in.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiPort = process.env.API_PORT ?? '4000';
const webPort = process.env.PORT ?? '3000';

function runChild(label, command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const forward = (stream) => (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.length > 0) stream.write(`[${label}] ${line}\n`);
    }
  };
  child.stdout.on('data', forward(process.stdout));
  child.stderr.on('data', forward(process.stderr));
  return child;
}

const api = runChild('api', process.execPath, [path.join(rootDir, 'apps/api/dist/server.js')], {
  cwd: rootDir,
  env: { ...process.env, API_PORT: apiPort },
});

const web = runChild('web', 'npx', ['--no-install', 'next', 'start', '-p', webPort], {
  cwd: path.join(rootDir, 'apps/web'),
  env: process.env,
});

// A child exiting because we asked it to is a shutdown, not a crash. Without this flag the exit
// below maps a graceful child (code 0, or null when it dies of the signal) onto exit(1), so every
// deploy teardown and every idle-sleep reaches Railway as "Deployment crashed" and emails about it.
let shuttingDown = false;
let running = 2;

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    shuttingDown = true;
    api.kill(signal);
    web.kill(signal);
    // Don't hang the container if a child ignores the signal.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

function onExit(label, other) {
  return (code, signal) => {
    running -= 1;
    if (shuttingDown) {
      if (running === 0) {
        process.exit(0);
      }
      return;
    }
    console.error(
      `[supervisor] ${label} exited (code=${code} signal=${signal}); stopping the other process`,
    );
    other.kill('SIGTERM');
    process.exit(code === 0 ? 1 : (code ?? 1));
  };
}

api.on('exit', onExit('api', web));
web.on('exit', onExit('web', api));
