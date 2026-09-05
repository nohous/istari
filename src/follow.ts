/**
 * @brief Cursor following between source editors and listings.
 *
 * The editor holding the cursor is the master: a source cursor marks the
 * instructions it produced in every visible listing, a listing cursor marks
 * the innermost source line that is visible.
 */

import * as vscode from 'vscode';
import { Image } from './image';
import { Highlighter } from './decorations';
import { Listing, ListingLine } from './listing';
import { ListingProvider, SCHEME } from './provider';

export class Follow implements vscode.Disposable {
    private readonly subscription: vscode.Disposable;

    constructor(
        private readonly image: () => Image | undefined,
        private readonly provider: ListingProvider,
        private readonly highlighter: Highlighter,
    ) {
        this.subscription = vscode.window.onDidChangeTextEditorSelection(e => this.onSelection(e.textEditor));
    }

    private onSelection(editor: vscode.TextEditor): void {
        const image = this.image();
        if (!image) {
            return;
        }

        if (editor.document.uri.scheme === SCHEME) {
            this.fromListing(editor, image);
        } else if (editor.document.uri.scheme === 'file') {
            this.fromSource(editor, image);
        }
    }

    private fromListing(editor: vscode.TextEditor, image: Image): void {
        const listing = this.provider.listingFor(editor.document.uri);
        const line = listing?.lines[editor.selection.active.line];
        if (!line) {
            return;
        }

        this.highlighter.clear(editor);
        for (const loc of locsOfLine(image, line)) {
            const target = visibleSourceEditor(image, image.locs[loc].file);
            if (target) {
                this.highlighter.set(target, [image.locs[loc].line - 1], true);
                return;
            }
        }
    }

    private fromSource(editor: vscode.TextEditor, image: Image): void {
        const file = image.findFile(editor.document.uri.fsPath);
        if (file < 0) {
            return;
        }

        this.highlighter.clear(editor);
        const loc = image.locAt(file, editor.selection.active.line + 1);
        if (loc < 0) {
            return;
        }

        for (const target of vscode.window.visibleTextEditors) {
            if (target.document.uri.scheme !== SCHEME) {
                continue;
            }
            const listing = this.provider.listingFor(target.document.uri);
            if (listing) {
                this.highlighter.set(target, listingLinesFor(listing, image, loc), true);
            }
        }
    }

    dispose(): void {
        this.subscription.dispose();
    }
}

/**
 * @brief Listing lines whose own location or inline chain touches loc.
 */
export function listingLinesFor(listing: Listing, image: Image, loc: number): number[] {
    const out: number[] = [];

    listing.lines.forEach((line, i) => {
        if (line.loc === loc || (line.chain >= 0 && image.chains[line.chain].some(f => f.loc === loc))) {
            out.push(i);
        }
    });

    return out;
}

/**
 * @brief Source locations of a listing line, innermost first.
 */
export function locsOfLine(image: Image, line: ListingLine): number[] {
    const out: number[] = [];

    if (line.loc >= 0) {
        out.push(line.loc);
    }
    if (line.chain >= 0) {
        for (const frame of image.chains[line.chain]) {
            out.push(frame.loc);
        }
    }

    return out;
}

export function visibleSourceEditor(image: Image, file: number): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find(e =>
        e.document.uri.scheme === 'file' && image.findFile(e.document.uri.fsPath) === file);
}
