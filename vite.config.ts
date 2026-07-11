import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// fixed localhost port per PRD — the app is always http://localhost:5273
	// (not 5173: that's vite's default and other local projects squat on it)
	server: { port: 5273, strictPort: true },
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			}
			// no adapter: dev-only app, never built for deployment
		})
	]
});
