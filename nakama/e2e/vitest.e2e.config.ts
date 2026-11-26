import { defineConfig } from 'vitest/config'

// The end-to-end tests run against a live Nakama (compose.e2e.yml), one file
// at a time: they share its matchmaker and its server config.
export default defineConfig({
	test: {
		include: ['e2e/**/*.e2e.ts'],
		fileParallelism: false,
		testTimeout: 180_000,
		hookTimeout: 60_000,
	},
})
