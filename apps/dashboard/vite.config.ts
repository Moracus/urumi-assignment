import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, workspaceRoot, ''), ...process.env };
  return {
    plugins: [react()],
    envDir: workspaceRoot,
    server: {
      port: Number(env.DASHBOARD_PORT ?? 5173),
      strictPort: true,
      proxy: { '/api': env.DASHBOARD_PROXY_TARGET ?? 'http://localhost:3000' },
    },
  };
});
