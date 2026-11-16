import { defineConfig } from 'vite';

export default defineConfig( {
	server: { port: 5199, open: false },
	build: { target: 'esnext' },
	optimizeDeps: { esbuildOptions: { target: 'esnext' } }
} );
