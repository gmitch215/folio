import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'unit',
					include: ['tests/unit/**/*.test.ts'],
					globalSetup: ['tests/setup.ts'],
					testTimeout: 30000
				}
			},
			{
				test: {
					name: 'integration',
					include: ['tests/integration/**/*.test.ts'],
					globalSetup: ['tests/setup.ts'],
					fileParallelism: false,
					testTimeout: 120000,
					hookTimeout: 120000
				}
			},
			{
				test: {
					name: 'e2e',
					include: ['tests/e2e/**/*.test.ts'],
					globalSetup: ['tests/setup.ts'],
					fileParallelism: false,
					testTimeout: 600000,
					hookTimeout: 600000
				}
			}
		],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'lcov', 'clover'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			exclude: ['src/index.ts', '**/*.d.ts']
		}
	}
});
