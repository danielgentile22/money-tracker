import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'server',
					include: ['src/**/*.test.ts'],
					exclude: ['src/**/*.svelte.test.ts'],
					environment: 'node'
				}
			},
			{
				plugins: [svelte()],
				resolve: {
					conditions: ['browser'],
					alias: {
						$lib: path.resolve(import.meta.dirname, 'src/lib'),
						'$app/state': path.resolve(import.meta.dirname, 'src/test/app-state-stub.ts'),
						'$app/navigation': path.resolve(import.meta.dirname, 'src/test/app-state-stub.ts')
					}
				},
				test: {
					name: 'component',
					include: ['src/**/*.svelte.test.ts'],
					environment: 'jsdom'
				}
			}
		]
	}
});
