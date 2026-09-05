import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { IstariApi } from '../extension';

suite('Istari in the WPX workspace', () => {
	test('loads the image and renders a function listing', async () => {
		const folder = vscode.workspace.workspaceFolders?.[0];
		assert.ok(folder, 'a workspace folder is open');

		const extension = vscode.extensions.getExtension<IstariApi>('nohous.istari');
		assert.ok(extension, 'extension is installed in the test host');
		const api = await extension.activate();

		const image = await api.loadImage(path.join(folder.uri.fsPath, 'build', 'wpxTpx2_app1_0x08040000.elf'));
		assert.ok(image.fns.length > 1000);

		await vscode.commands.executeCommand('istari.openFunction', { name: 'Tpx2Row::powerUp(Tpx2Row::RowSet&)' });
		const editor = vscode.window.activeTextEditor;
		assert.ok(editor, 'a listing editor is active');
		assert.strictEqual(editor.document.uri.scheme, 'istari');
		assert.ok(editor.document.uri.path.endsWith('.dis'));
		assert.strictEqual(editor.document.languageId, 'istari-asm');
		assert.ok(editor.document.getText().startsWith(';; Tpx2Row::powerUp(Tpx2Row::RowSet&)\n'));
		assert.ok(editor.document.getText().includes('span:333'));
	});
});
