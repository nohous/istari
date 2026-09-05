// Produces the README frames: runs only with ISTARI_SHOTS_DIR set, under an
// X display, in the WPX workspace. Each step settles, then the root window is
// captured with ImageMagick import.

import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { IstariApi } from '../extension';

const OUT = process.env.ISTARI_SHOTS_DIR;
const WIDTH = Number(process.env.ISTARI_SHOTS_WIDTH ?? 1440);
const HEIGHT = Number(process.env.ISTARI_SHOTS_HEIGHT ?? 900);

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function shot(name: string): void {
	cp.execFileSync('import', ['-window', 'root', path.join(OUT!, `${name}.png`)]);
}

// Without a window manager only the client can size itself; xdotool moves the
// largest visible window to the screen size. Best effort: a failure here only
// costs frame layout.
async function sizeWindow(): Promise<void> {
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			const ids = cp.execFileSync('xdotool', ['search', '--onlyvisible', '--name', '.']).toString().trim().split('\n').filter(Boolean);
			let best: { id: string; area: number } | undefined;
			for (const id of ids) {
				const geometry = cp.execFileSync('xdotool', ['getwindowgeometry', '--shell', id]).toString();
				const w = Number(/WIDTH=(\d+)/.exec(geometry)?.[1] ?? 0);
				const h = Number(/HEIGHT=(\d+)/.exec(geometry)?.[1] ?? 0);
				if (!best || w * h > best.area) {
					best = { id, area: w * h };
				}
			}
			if (best && best.area > 100 * 100) {
				cp.execFileSync('xdotool', ['windowmove', best.id, '0', '0']);
				cp.execFileSync('xdotool', ['windowsize', best.id, String(WIDTH), String(HEIGHT)]);
				console.log(`sized window ${best.id} to ${WIDTH}x${HEIGHT}`);
				return;
			}
		} catch (err) {
			console.log(`xdotool attempt ${attempt}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
		}
		await wait(500);
	}
}

// A hover opened from the keyboard stays until Escape reaches the editor.
function dismissHover(): void {
	try {
		cp.execFileSync('xdotool', ['key', '--clearmodifiers', 'Escape']);
	} catch (err) {
		console.log(`xdotool Escape: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
	}
}

async function tidyWorkbench(): Promise<void> {
	const cfg = vscode.workspace.getConfiguration();
	const global = vscode.ConfigurationTarget.Global;
	await cfg.update('editor.minimap.enabled', false, global);
	await cfg.update('editor.fontSize', 15, global);
	await cfg.update('editor.lineHeight', 22, global);
	await cfg.update('workbench.activityBar.location', 'hidden', global);
	await cfg.update('window.commandCenter', false, global);
	await cfg.update('window.menuBarVisibility', 'hidden', global);
	await cfg.update('workbench.layoutControl.enabled', false, global);
	await cfg.update('editor.renderLineHighlight', 'none', global);
	await cfg.update('breadcrumbs.enabled', false, global);
	await cfg.update('editor.glyphMargin', false, global);
	await cfg.update('workbench.editor.showTabs', 'single', global);
	await vscode.commands.executeCommand('workbench.action.closeSidebar');
	await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
	await vscode.commands.executeCommand('workbench.action.closePanel');
	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

async function showAt(file: string, line: number, column: vscode.ViewColumn, character = 0): Promise<vscode.TextEditor> {
	const doc = await vscode.workspace.openTextDocument(file);
	const editor = await vscode.window.showTextDocument(doc, { viewColumn: column, preserveFocus: false });
	const position = new vscode.Position(line - 1, character);
	editor.selection = new vscode.Selection(position, position);
	editor.revealRange(new vscode.Range(Math.max(line - 12, 0), 0, line + 10, 0), vscode.TextEditorRevealType.InCenter);
	return editor;
}

suite('README screenshots', function () {
	this.timeout(600000);

	suiteSetup(function () {
		if (!OUT) {
			this.skip();
		}
		fs.mkdirSync(OUT!, { recursive: true });
	});

	test('capture the feature frames', async () => {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		assert.ok(folder);
		const extension = vscode.extensions.getExtension<IstariApi>('nohous.istari');
		assert.ok(extension);
		const api = await extension.activate();

		console.log(`display ${process.env.DISPLAY}, windows: ${cp.execFileSync('xwininfo', ['-root', '-tree']).toString().split('\n').length} lines`);
		await sizeWindow();
		await tidyWorkbench();
		await api.loadImage(path.join(folder, 'build', 'wpxTpx2_app1_0x08040000.elf'));
		await wait(1500);

		// 1: a source file with byte costs after the lines
		await showAt(path.join(folder, 'src', 'AppDrivers', 'Tpx2Row.cpp'), 244, vscode.ViewColumn.One);
		await wait(2500);
		shot('1-costs');

		// 2: the listing beside it, with the line's instructions marked
		await vscode.commands.executeCommand('istari.showAssembly');
		await wait(1000);
		if (!vscode.window.visibleTextEditors.some(e => e.document.uri.scheme === 'istari')) {
			await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
			await wait(1000);
		}
		await wait(2000);
		shot('2-listing');

		// 3: the cheat sheet on a mnemonic inside the listing
		const listing = vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'istari');
		assert.ok(listing, 'a listing is visible');
		const lines = listing.document.getText().split('\n');
		const target = lines.findIndex((text, i) => i > 0 && lines[i - 1].includes('span:333') && /^\s+[0-9a-f]+:  /.test(text));
		assert.ok(target > 0, 'an instruction under the span:333 marker');
		const mnemonic = lines[target].indexOf(':  ') + 3;
		const focused = await vscode.window.showTextDocument(listing.document, { viewColumn: listing.viewColumn, preserveFocus: false });
		focused.selection = new vscode.Selection(target, mnemonic + 1, target, mnemonic + 1);
		focused.revealRange(new vscode.Range(Math.max(target - 8, 0), 0, target + 12, 0), vscode.TextEditorRevealType.InCenter);
		await wait(1000);
		await vscode.commands.executeCommand('editor.action.showHover');
		await wait(2000);
		shot('3-cheatsheet');
		dismissHover();

		// 4: the cost hover on the one-line destructor
		await wait(500);
		await showAt(path.join(folder, 'src', 'aftl', 'include', 'aftl', 'outcome.hpp'), 208, vscode.ViewColumn.One, 6);
		await wait(1500);
		await vscode.commands.executeCommand('editor.action.showHover');
		await wait(2000);
		shot('4-cost-hover');
		dismissHover();

		// 5: the function picker, largest first
		await wait(500);
		void vscode.commands.executeCommand('istari.openFunction');
		await wait(2500);
		shot('5-picker');
		await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
		await wait(500);
	});
});
