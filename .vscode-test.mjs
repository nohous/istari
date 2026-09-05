import { defineConfig } from '@vscode/test-cli';
import * as path from 'node:path';

// Both configurations run against a real firmware workspace; point
// ISTARI_TEST_WORKSPACE elsewhere to use another one. The screenshots
// configuration needs an X display and ISTARI_SHOTS_DIR for its frames.
const workspaceFolder = process.env.ISTARI_TEST_WORKSPACE ?? '/home/nohous/projects/advacam/src/WPX_CPU_APP-mc-devel';

export default defineConfig([
	{
		label: 'integration',
		files: 'out/test/extension.test.js',
		workspaceFolder,
		launchArgs: ['--ozone-platform=x11'],
		mocha: { timeout: 120000 },
	},
	{
		label: 'screenshots',
		files: 'out/test/screenshots.test.js',
		workspaceFolder,
		launchArgs: [`--user-data-dir=${path.resolve('.vscode-test/shots-user-data')}`, '--ozone-platform=x11'],
		env: {
			ISTARI_SHOTS_DIR: process.env.ISTARI_SHOTS_DIR,
			ISTARI_SHOTS_WIDTH: process.env.ISTARI_SHOTS_WIDTH,
			ISTARI_SHOTS_HEIGHT: process.env.ISTARI_SHOTS_HEIGHT,
			ISTARI_SHOTS_STYLES: process.env.ISTARI_SHOTS_STYLES,
		},
		mocha: { timeout: 600000 },
	},
]);
