/**
 * @brief Editor decorations: per-line byte costs in source editors and the
 * shared highlight that marks the counterpart of the cursor line.
 */

import * as vscode from 'vscode';
import { Image, LineCost } from './image';
import { shortName } from './listing';

export type CostMode = 'inclusive' | 'exclusive' | 'off';

const LEVEL_COLORS = [
    'editorCodeLens.foreground',
    'editorInfo.foreground',
    'editorWarning.foreground',
    'editorError.foreground',
];

const LEVEL_LIMITS = [8, 32, 128];

export class CostDecorator implements vscode.Disposable {
    private readonly levels = LEVEL_COLORS.map(color => vscode.window.createTextEditorDecorationType({
        after: {
            margin: '0 0 0 3em',
            color: new vscode.ThemeColor(color),
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    }));

    apply(editor: vscode.TextEditor, image: Image | undefined, mode: CostMode): void {
        const buckets: vscode.DecorationOptions[][] = this.levels.map(() => []);
        const file = image && mode !== 'off' ? image.findFile(editor.document.uri.fsPath) : -1;

        if (image && file >= 0) {
            for (const [line, loc] of image.linesOf(file)) {
                const cost = image.costOf(loc);
                const bytes = cost ? (mode === 'inclusive' ? cost.inclusive : cost.exclusive) : 0;
                if (bytes <= 0 || line > editor.document.lineCount) {
                    continue;
                }

                buckets[levelOf(bytes)].push({
                    range: editor.document.lineAt(line - 1).range,
                    renderOptions: { after: { contentText: `${bytes} B` } },
                    hoverMessage: costHover(image, loc, cost!),
                });
            }
        }

        this.levels.forEach((type, i) => editor.setDecorations(type, buckets[i]));
    }

    dispose(): void {
        this.levels.forEach(type => type.dispose());
    }
}

function levelOf(bytes: number): number {
    let level = 0;
    while (level < LEVEL_LIMITS.length && bytes > LEVEL_LIMITS[level]) {
        level++;
    }
    return level;
}

function costHover(image: Image, loc: number, cost: LineCost): vscode.MarkdownString {
    const through = cost.inclusive - cost.exclusive;
    const hosts = cost.fns.size;
    const md = new vscode.MarkdownString();

    md.appendMarkdown(`**${cost.inclusive} B** of code from this line, in ${hosts} function${hosts === 1 ? '' : 's'}\n\n`);
    md.appendMarkdown(`- ${cost.exclusive} B are the line's own instructions, summed over every copy\n`);
    if (through > 0) {
        md.appendMarkdown(`- ${through} B were inlined through it from deeper calls\n`);
    }

    const split = [...cost.fns].sort((a, b) => b[1] - a[1]);
    md.appendMarkdown(`\n${hosts === 1 ? 'Host' : 'Largest hosts'}:\n\n`);
    for (const [fn, bytes] of split.slice(0, 8)) {
        const sites = sitesIn(image, fn, loc);
        const where = sites > 1 ? ` at ${sites} sites` : '';
        md.appendMarkdown(`- ${bytes} B in ${escapeMd(shortName(image.fns[fn].name))}${where}\n`);
    }
    if (split.length > 8) {
        md.appendMarkdown(`- and ${split.length - 8} more\n`);
    }

    return md;
}

// Distinct outermost call-site lines inside a host function through which
// the line's code arrived; a line of the host itself counts as one site.
function sitesIn(image: Image, fnIdx: number, loc: number): number {
    const fn = image.fns[fnIdx];
    const sites = new Set<number>();

    for (let k = fn.first; k < fn.end; k++) {
        const ins = image.instrs[k];
        const frames = ins.chain >= 0 ? image.chains[ins.chain] : [];
        if (ins.loc === loc || frames.some(f => f.loc === loc)) {
            sites.add(frames.length ? frames[frames.length - 1].loc : loc);
        }
    }

    return sites.size;
}

function escapeMd(s: string): string {
    return s.replace(/[<>*_`]/g, m => '\\' + m);
}

export class Highlighter implements vscode.Disposable {
    private readonly type = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Full,
    });
    private readonly marked = new Set<vscode.TextEditor>();

    /**
     * @brief Marks the given zero-based lines in an editor, replacing its
     * previous marks; reveal scrolls the first one into view.
     */
    set(editor: vscode.TextEditor, lines: number[], reveal: boolean): void {
        const ranges = lines
            .filter(l => l < editor.document.lineCount)
            .map(l => editor.document.lineAt(l).range);

        editor.setDecorations(this.type, ranges);
        this.marked.add(editor);

        if (reveal && ranges.length) {
            editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
    }

    /**
     * @brief Removes marks from every editor except the one given.
     */
    clear(except?: vscode.TextEditor): void {
        for (const editor of this.marked) {
            if (editor !== except) {
                editor.setDecorations(this.type, []);
                this.marked.delete(editor);
            }
        }
    }

    dispose(): void {
        this.type.dispose();
    }
}
