import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tools/formal/audits/2026-11-09/*.probe.ts'], testTimeout: 10000, fileParallelism: false } });
