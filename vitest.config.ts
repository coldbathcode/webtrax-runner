import { defineConfig } from 'vitest/config'

// Workspace-level tests only (the packages run their own).
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } })
