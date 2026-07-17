import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { tmpdir } from 'node:os';

export default defineConfig({
	test: {
		projects: [
			{
				// $lib alias so form-action modules (ledger-actions, saved-report-actions)
				// are importable in node tests (#51); no $app aliases needed here
				resolve: {
					alias: { $lib: path.resolve(import.meta.dirname, 'src/lib') }
				},
				test: {
					name: 'server',
					include: ['src/**/*.test.ts'],
					exclude: ['src/**/*.svelte.test.ts'],
					environment: 'node',
					// a transitively imported db singleton must never open the live DB
					env: { MONEY_TRACKER_DATA_DIR: path.join(tmpdir(), 'money-tracker-vitest') }
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
					environment: 'jsdom',
					setupFiles: ['src/test/component-setup.ts']
				}
			}
		]
	}
});
