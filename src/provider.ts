/**
 * @brief The istari: document scheme: one virtual document per function and
 * one per cheat sheet, plus go-to-definition on branch targets and hovers on
 * mnemonics, registers and source markers.
 *
 * Listing paths end in .dis and cheat sheets in .md, which is how the
 * language of each document is chosen.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { Image } from './image';
import { isaById, isaForMachine } from './isa';
import { Isa } from './isa/isa';
import { Listing, ListingLine, ListingOptions, hex, lineOfAddr, renderListing, shortName, targetAt } from './listing';

export const SCHEME = 'istari';
export const LANGUAGE = 'istari-asm';

const CHEATSHEET_DIR = '/cheatsheet/';

export function cheatSheetUri(isa: Isa): vscode.Uri {
    return vscode.Uri.from({ scheme: SCHEME, path: `${CHEATSHEET_DIR}${isa.id}.md` });
}

export class ListingProvider implements vscode.TextDocumentContentProvider {
    private readonly change = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.change.event;
    private readonly listings = new Map<string, Listing>();
    private readonly fnNames = new Map<string, string>();

    constructor(
        private readonly image: () => Image | undefined,
        private readonly options: () => ListingOptions,
    ) {}

    /**
     * @brief URI of a function's listing; the tab shows the short name, the
     * query carries the address, and the full name is remembered for reloads.
     */
    uriFor(image: Image, fnIdx: number): vscode.Uri {
        const fn = image.fns[fnIdx];
        const uri = vscode.Uri.from({
            scheme: SCHEME,
            path: `/${path.basename(image.path)}/${shortName(fn.name)}.dis`,
            query: fn.addr.toString(16),
        });

        this.fnNames.set(uri.toString(), fn.name);
        return uri;
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        if (uri.path.startsWith(CHEATSHEET_DIR)) {
            const isa = isaById(path.basename(uri.path, '.md'));
            return isa ? isa.cheatSheet() : `# Istari: no cheat sheet named ${uri.path}`;
        }

        const image = this.image();
        if (!image) {
            return ';; Istari: no image loaded';
        }

        const fnIdx = this.resolveFn(image, uri);
        if (fnIdx < 0) {
            return `;; Istari: function not found in ${image.path}`;
        }

        return this.render(image, uri, fnIdx).text;
    }

    listingFor(uri: vscode.Uri): Listing | undefined {
        return this.listings.get(uri.toString());
    }

    /**
     * @brief Listing for a URI, rendered now when no document has opened it yet.
     */
    ensureListing(uri: vscode.Uri): Listing | undefined {
        const cached = this.listingFor(uri);
        if (cached) {
            return cached;
        }

        const image = this.image();
        if (!image) {
            return undefined;
        }

        const fnIdx = this.resolveFn(image, uri);
        return fnIdx >= 0 ? this.render(image, uri, fnIdx) : undefined;
    }

    /**
     * @brief Re-renders every open listing against the current image.
     */
    invalidateAll(): void {
        this.listings.clear();
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.uri.scheme === SCHEME) {
                this.change.fire(doc.uri);
            }
        }
    }

    private render(image: Image, uri: vscode.Uri, fnIdx: number): Listing {
        const listing = renderListing(image, fnIdx, this.options());
        this.listings.set(uri.toString(), listing);
        return listing;
    }

    private resolveFn(image: Image, uri: vscode.Uri): number {
        const name = this.fnNames.get(uri.toString());
        const byName = name ? image.fnNamed(name) : -1;
        return byName >= 0 ? byName : image.fnStartingAt(parseInt(uri.query, 16));
    }
}

// ------------------------------------------------------------------------------
// Language features
// ------------------------------------------------------------------------------

export class ListingDefinitions implements vscode.DefinitionProvider {
    constructor(
        private readonly image: () => Image | undefined,
        private readonly provider: ListingProvider,
    ) {}

    provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): vscode.Location | undefined {
        const image = this.image();
        const listing = this.provider.listingFor(doc.uri);
        if (!image || !listing) {
            return undefined;
        }

        const target = targetAt(doc.lineAt(pos.line).text, pos.character);
        if (target === undefined) {
            return undefined;
        }

        const fnIdx = image.fnContaining(target);
        if (fnIdx < 0) {
            return undefined;
        }

        if (fnIdx === listing.fn) {
            return new vscode.Location(doc.uri, new vscode.Position(lineOfAddr(listing, target), 0));
        }

        const uri = this.provider.uriFor(image, fnIdx);
        const other = this.provider.ensureListing(uri);
        return new vscode.Location(uri, new vscode.Position(other ? lineOfAddr(other, target) : 0, 0));
    }
}

export class ListingHovers implements vscode.HoverProvider {
    constructor(
        private readonly image: () => Image | undefined,
        private readonly provider: ListingProvider,
    ) {}

    provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
        const image = this.image();
        const listing = this.provider.listingFor(doc.uri);
        const line = listing?.lines[pos.line];
        if (!image || !line) {
            return undefined;
        }

        const isa = isaForMachine(image.machine);
        if (isa && line.instr >= 0) {
            const help = instructionHover(doc, pos, image.instrs[line.instr].text, isa);
            if (help) {
                return help;
            }
        }

        if (line.loc < 0 && line.chain < 0) {
            return undefined;
        }

        const md = new vscode.MarkdownString();
        if (line.instr >= 0) {
            const ins = image.instrs[line.instr];
            md.appendMarkdown(`${hex(ins.addr)}: ${ins.size} bytes\n\n`);
        }

        for (const [loc, fnName] of framesOf(image, line)) {
            const cost = image.costOf(loc);
            const bytes = cost ? ` (${cost.inclusive} B inclusive, ${cost.exclusive} B exclusive)` : '';
            md.appendMarkdown(`- ${sourceLink(image, loc)} in ${escapeMd(fnName)}${bytes}\n`);
        }

        return new vscode.Hover(md);
    }
}

// The mnemonic sits right after the address column; any other word on the
// line is tried as a register.
function instructionHover(doc: vscode.TextDocument, pos: vscode.Position, instrText: string, isa: Isa): vscode.Hover | undefined {
    const text = doc.lineAt(pos.line).text;
    const mnemonic = instrText.split(' ')[0];
    const start = text.indexOf(':  ') + 3;

    if (pos.character >= start && pos.character <= start + mnemonic.length) {
        const help = isa.instruction(mnemonic);
        if (!help) {
            return undefined;
        }
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${help.mnemonic}** \`${help.syntax}\`\n\n${help.text}\n`);
        for (const note of help.notes) {
            md.appendMarkdown(`\n- ${note}`);
        }
        return new vscode.Hover(md, new vscode.Range(pos.line, start, pos.line, start + mnemonic.length));
    }

    const range = doc.getWordRangeAtPosition(pos, /[A-Za-z][A-Za-z0-9_]*/);
    if (!range || range.start.character <= start) {
        return undefined;
    }
    const register = isa.register(doc.getText(range));
    return register ? new vscode.Hover(new vscode.MarkdownString(register), range) : undefined;
}

/**
 * @brief Source locations of a listing line, innermost first, each with the
 * name of the function the location lies in.
 */
export function framesOf(image: Image, line: ListingLine): [number, string][] {
    const out: [number, string][] = [];

    if (line.loc >= 0) {
        out.push([line.loc, line.scope >= 0 ? image.names[line.scope] : '']);
    }
    if (line.chain >= 0) {
        for (const frame of image.chains[line.chain]) {
            out.push([frame.loc, image.names[frame.fn]]);
        }
    }

    return out;
}

function sourceLink(image: Image, loc: number): string {
    const { file, line } = image.locs[loc];
    const target = vscode.Uri.file(image.files[file]).with({ fragment: `L${line}` });
    return `[${escapeMd(vscode.workspace.asRelativePath(image.files[file]))}:${line}](${target.toString()})`;
}

function escapeMd(s: string): string {
    return s.replace(/[<>*_`[\]]/g, m => '\\' + m);
}
