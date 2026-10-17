import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Resolve from this file, so filtered pnpm commands use the same workspace file.
export function loadWorkspaceEnv(service, path = fileURLToPath(new URL('../.env', import.meta.url))) {
  try {
    loadEnvFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const portKey = `${service.toUpperCase().replaceAll('-', '_')}_PORT`;
  if (process.env.PORT === undefined && process.env[portKey]) {
    process.env.PORT = process.env[portKey];
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [service, command, ...args] = process.argv.slice(2);
  if (!service || !command) throw new Error('Usage: run-with-env.mjs <service> <command> [args...]');
  loadWorkspaceEnv(service);
  const child = spawn(command, args, { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', () => {
    console.error('Unable to start workspace command');
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
  });
}
