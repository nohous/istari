import { defineConfig } from '@vscode/test-cli';

// The integration test runs against a real firmware workspace; point
// ISTARI_TEST_WORKSPACE elsewhere to use another one.
export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder: process.env.ISTARI_TEST_WORKSPACE ?? '/home/nohous/projects/advacam/src/WPX_CPU_APP-mc-devel',
	mocha: {
		timeout: 120000,
	},
});
