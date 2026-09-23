import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // three.js alone is ~600 kB; one chunk is fine for a local tool.
  build: { chunkSizeWarningLimit: 1500 },
  test: { environment: 'node' },
} as Parameters<typeof defineConfig>[0]);
