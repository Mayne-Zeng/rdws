import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [react()],
  define: {
    'process.versions.node': JSON.stringify('0.0.0'),
    'process.execArgv': '[]',
    'process.env.CORDIS_SHARED': 'undefined',
  },
  resolve: {
    alias: [
      {
        find: /^node:(?:module|fs(?:\/promises)?|path|url)$/,
        replacement: fileURLToPath(
          new URL('../../dsh/client/node-boundary.ts', import.meta.url),
        ),
      },
    ],
  },
  optimizeDeps: { exclude: ['@deepseek-ai/cordis-plugin-loader'] },
  server: {
    strictPort: true,
    port: Number(process.env.RDWS_WEB_PORT || 5173),
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.RDWS_API_PORT || 3001}`,
        ws: true,
      },
    },
  },
});
