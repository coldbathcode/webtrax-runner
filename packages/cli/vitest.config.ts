import { defineConfig } from 'vitest/config'

// These tests crawl the fixture site several times and spawn the built CLI.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 60_000 } })
