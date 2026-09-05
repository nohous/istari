/**
 * @brief Editor decorations: per-line byte costs in source editors and the
 * shared highlight that marks the counterpart of the cursor line.
 */

import * as vscode from 'vscode';
import { Image, LineCost } from './image';
import { shortName } from './listing';

export type CostMetric = 'inclusive' | 'exclusive';
export type CostStyle = 'inline' | 'inlayHint' | 'gutter';

export interface CostOptions {
    show: boolean;
    metric: CostMetric;
    style: CostStyle;
}

const LEVEL_COLORS = [
    'editorCodeLens.foreground',
    'editorInfo.foreground',
    'editorWarning.foreground',
    'editorError.foreground',
];

const GUTTER_COLORS = ['#6b7585', '#3794ff', '#cca700', '#f14c4c'];

const LEVEL_LIMITS = [8, 32, 128];

interface CostEntry {
    line: number;
    bytes: number;
    level: number;
    loc: number;
    cost: LineCost;
}

/**
 * @brief Costs of the lines of a file that produced code, in document order.
 */
export function costEntries(image: Image, file: number, metric: CostMetric, lineCount: number): CostEntry[] {
    const out: CostEntry[] = [];

    for (const [line, loc] of image.linesOf(file)) {
        const cost = image.costOf(loc);
        const bytes = cost ? (metric === 'inclusive' ? cost.inclusive : cost.exclusive) : 0;
        if (bytes > 0 && line <= lineCount) {
            out.push({ line, bytes, level: levelOf(bytes), loc, cost: cost! });
        }
    }

    return out.sort((a, b) => a.line - b.line);
}

export class CostDecorator implements vscode.Disposable {
    private readonly inline = LEVEL_COLORS.map(color => vscode.window.createTextEditorDecorationType({
        after: {
            margin: '0 0 0 3em',
            color: new vscode.ThemeColor(color),
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    }));
    private readonly gutter = GUTTER_COLORS.map(color => vscode.window.createTextEditorDecorationType({
        gutterIconPath: gutterIcon(color),
        gutterIconSize: 'contain',
    }));

    apply(editor: vscode.TextEditor, image: Image | undefined, options: CostOptions): void {
        const inline: vscode.DecorationOptions[][] = this.inline.map(() => []);
        const gutter: vscode.DecorationOptions[][] = this.gutter.map(() => []);
        const file = image && options.show ? image.findFile(editor.document.uri.fsPath) : -1;

        if (image && file >= 0) {
            for (const entry of costEntries(image, file, options.metric, editor.document.lineCount)) {
                const range = editor.document.lineAt(entry.line - 1).range;
                const hoverMessage = costHover(image, entry.loc, entry.cost);
                if (options.style === 'inline') {
                    inline[entry.level].push({ range, hoverMessage, renderOptions: { after: { contentText: `${entry.bytes} B` } } });
                } else if (options.style === 'gutter') {
                    gutter[entry.level].push({ range, hoverMessage });
                }
            }
        }

        this.inline.forEach((type, i) => editor.setDecorations(type, inline[i]));
        this.gutter.forEach((type, i) => editor.setDecorations(type, gutter[i]));
    }

    dispose(): void {
        this.inline.forEach(type => type.dispose());
        this.gutter.forEach(type => type.dispose());
    }
}

/**
 * @brief Costs as editor inlay hints, so editor.inlayHints.enabled and its
 * hold-to-show modes govern them. Costs above the top level use the type
 * hint colour, the rest the parameter hint colour.
 */
export class CostInlayHints implements vscode.InlayHintsProvider {
    private readonly change = new vscode.EventEmitter<void>();
    readonly onDidChangeInlayHints = this.change.event;

    constructor(
        private readonly image: () => Image | undefined,
        private readonly options: () => CostOptions,
    ) {}

    refresh(): void {
        this.change.fire();
    }

    provideInlayHints(doc: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
        const image = this.image();
        const options = this.options();
        const file = image && options.show && options.style === 'inlayHint' ? image.findFile(doc.uri.fsPath) : -1;
        if (!image || file < 0) {
            return [];
        }

        const hints: vscode.InlayHint[] = [];
        for (const entry of costEntries(image, file, options.metric, doc.lineCount)) {
            const line = entry.line - 1;
            if (line < range.start.line || line > range.end.line) {
                continue;
            }
            const kind = entry.level === LEVEL_LIMITS.length ? vscode.InlayHintKind.Type : vscode.InlayHintKind.Parameter;
            const hint = new vscode.InlayHint(doc.lineAt(line).range.end, `${entry.bytes} B`, kind);
            hint.paddingLeft = true;
            hint.tooltip = costHover(image, entry.loc, entry.cost);
            hints.push(hint);
        }

        return hints;
    }
}

function gutterIcon(color: string): vscode.Uri {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="5" y="2" width="3" height="12" rx="1.5" fill="${color}"/></svg>`;
    return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
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
        backgroundColor: new vscode.ThemeColor('istari.markBackground'),
        borderColor: new vscode.ThemeColor('istari.markBorder'),
        borderStyle: 'solid',
        borderWidth: '0 0 0 2px',
        overviewRulerColor: new vscode.ThemeColor('istari.markBorder'),
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
