/**
 * @brief The commands: open a function listing, and jump between a source
 * line and the assembly it produced.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { Highlighter } from './decorations';
import { listingLinesFor, locsOfLine, visibleSourceEditor } from './follow';
import { Image } from './image';
import { shortName } from './listing';
import { isaForMachine } from './isa';
import { ListingProvider, SCHEME, cheatSheetUri } from './provider';

/**
 * @brief What the commands need from the extension state.
 */
export interface Session {
    image(): Image | undefined;
    ensureImage(): Promise<Image | undefined>;
    readonly provider: ListingProvider;
    readonly highlighter: Highlighter;
}

export interface OpenFunctionArgs {
    name?: string;
    addr?: number;
}

interface FnItem extends vscode.QuickPickItem {
    fnIdx: number;
}

const NEAREST_LINES = 5;

export class Navigator {
    constructor(private readonly session: Session) {}

    /**
     * @brief Opens a listing: by name or address when given, else from a picker
     * of every function sorted by size.
     */
    async openFunction(args?: OpenFunctionArgs): Promise<void> {
        const image = await this.session.ensureImage();
        if (!image) {
            return;
        }

        let fnIdx = -1;
        if (args?.name !== undefined) {
            fnIdx = image.fnNamed(args.name);
        } else if (args?.addr !== undefined) {
            fnIdx = image.fnStartingAt(args.addr);
        } else {
            fnIdx = await this.pickFunction(image);
        }

        if (fnIdx < 0) {
            if (args) {
                void vscode.window.showWarningMessage(`Istari: no function ${args.name ?? args.addr?.toString(16)} in ${path.basename(image.path)}`);
            }
            return;
        }

        await this.openListing(image, fnIdx, -1, false);
    }

    /**
     * @brief From a source line to its assembly, or from a listing line back to
     * its innermost source line.
     */
    async showAssembly(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        const image = await this.session.ensureImage();
        if (!image) {
            return;
        }

        if (editor.document.uri.scheme === SCHEME) {
            await this.toSource(editor, image);
        } else {
            await this.toListing(editor, image);
        }
    }

    /**
     * @brief Opens the instruction-set cheat sheet of the current image as a
     * rendered markdown preview.
     */
    async cheatSheet(): Promise<void> {
        const image = await this.session.ensureImage();
        const isa = image ? isaForMachine(image.machine) : undefined;
        if (!image || !isa) {
            if (image) {
                void vscode.window.showInformationMessage(`Istari: no cheat sheet for ELF machine 0x${image.machine.toString(16)}`);
            }
            return;
        }

        const uri = cheatSheetUri(isa);
        try {
            await vscode.commands.executeCommand('markdown.showPreview', uri);
        } catch {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
        }
    }

    private async toSource(editor: vscode.TextEditor, image: Image): Promise<void> {
        const listing = this.session.provider.listingFor(editor.document.uri);
        const line = listing?.lines[editor.selection.active.line];
        const locs = line ? locsOfLine(image, line) : [];
        if (locs.length === 0) {
            vscode.window.setStatusBarMessage('Istari: no source location on this line', 3000);
            return;
        }

        const loc = image.locs[locs[0]];
        const existing = visibleSourceEditor(image, loc.file);
        const doc = await vscode.workspace.openTextDocument(image.files[loc.file]);
        const position = new vscode.Position(loc.line - 1, 0);
        const target = await vscode.window.showTextDocument(doc, {
            viewColumn: existing?.viewColumn ?? vscode.ViewColumn.One,
            selection: new vscode.Range(position, position),
        });

        target.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }

    private async toListing(editor: vscode.TextEditor, image: Image): Promise<void> {
        const file = image.findFile(editor.document.uri.fsPath);
        if (file < 0) {
            vscode.window.setStatusBarMessage(`Istari: ${path.basename(editor.document.uri.fsPath)} is not in ${path.basename(image.path)}`, 4000);
            return;
        }

        const line = editor.selection.active.line + 1;
        const loc = nearestLoc(image, file, line);
        if (loc < 0) {
            vscode.window.setStatusBarMessage(`Istari: no code within ${NEAREST_LINES} lines of line ${line}`, 4000);
            return;
        }

        const split = [...(image.costOf(loc)?.fns ?? [])].sort((a, b) => b[1] - a[1]);
        let fnIdx = split.length === 1 ? split[0][0] : -1;
        if (split.length > 1) {
            const pick = await vscode.window.showQuickPick<FnItem>(
                split.map(([fn, bytes]) => ({
                    label: shortName(image.fns[fn].name),
                    description: `${bytes} B from this line, ${image.fns[fn].size} B total`,
                    detail: image.fns[fn].name,
                    fnIdx: fn,
                })),
                {
                    placeHolder: `${path.basename(editor.document.uri.fsPath)}:${image.locs[loc].line} is compiled into ${split.length} functions`,
                    matchOnDetail: true,
                });
            if (!pick) {
                return;
            }
            fnIdx = pick.fnIdx;
        }

        if (fnIdx >= 0) {
            await this.openListing(image, fnIdx, loc, true);
        }
    }

    private async openListing(image: Image, fnIdx: number, loc: number, preserveFocus: boolean): Promise<void> {
        const uri = this.session.provider.uriFor(image, fnIdx);
        const doc = await vscode.workspace.openTextDocument(uri);

        const visible = vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === SCHEME);
        const editor = await vscode.window.showTextDocument(doc, {
            viewColumn: visible?.viewColumn ?? vscode.ViewColumn.Beside,
            preserveFocus,
        });

        const listing = this.session.provider.listingFor(uri);
        if (listing && loc >= 0) {
            this.session.highlighter.clear();
            this.session.highlighter.set(editor, listingLinesFor(listing, image, loc), true);
        }
    }

    private async pickFunction(image: Image): Promise<number> {
        const items: FnItem[] = image.fns
            .map((fn, fnIdx) => ({ fn, fnIdx }))
            .sort((a, b) => b.fn.size - a.fn.size)
            .map(({ fn, fnIdx }) => ({
                label: shortName(fn.name),
                description: `${fn.size} B  ${fn.loc >= 0 ? vscode.workspace.asRelativePath(image.files[image.locs[fn.loc].file]) + ':' + image.locs[fn.loc].line : ''}`,
                detail: fn.name,
                fnIdx,
            }));

        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: `${image.fns.length} functions in ${path.basename(image.path)}, largest first`,
            matchOnDescription: true,
            matchOnDetail: true,
        });

        return pick?.fnIdx ?? -1;
    }
}

// A cursor on a brace, a comment or a declaration has no code of its own; the
// closest line that does, preferring the following ones, stands in.
function nearestLoc(image: Image, file: number, line: number): number {
    for (let d = 0; d <= NEAREST_LINES; d++) {
        const after = image.locAt(file, line + d);
        if (after >= 0) {
            return after;
        }
        const before = image.locAt(file, line - d);
        if (before >= 0) {
            return before;
        }
    }

    return -1;
}
