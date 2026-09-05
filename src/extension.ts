/**
 * @brief Extension entry: owns the loaded image, its status bar item and file
 * watcher, and wires the providers, decorations and commands together.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CostDecorator, CostMode, Highlighter } from './decorations';
import { Follow } from './follow';
import { Image } from './image';
import { Navigator, OpenFunctionArgs, Session } from './navigate';
import { ListingDefinitions, ListingHovers, ListingProvider, SCHEME } from './provider';
import { loadImage, resolveTools } from './toolchain';

/**
 * @brief Surface returned from activate for tests and other extensions.
 */
export interface IstariApi {
    loadImage(elfPath: string): Promise<Image>;
    image(): Image | undefined;
}

const STATE_IMAGE = 'istari.image';
const RELOAD_DEBOUNCE_MS = 700;

function config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('istari', vscode.workspace.workspaceFolders?.[0]?.uri ?? null);
}

function clock(): string {
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

class Istari implements Session, vscode.Disposable {
    readonly provider: ListingProvider;
    readonly highlighter = new Highlighter();
    private current?: Image;
    private loading?: Promise<Image>;
    private watcher?: vscode.FileSystemWatcher;
    private reloadTimer?: NodeJS.Timeout;
    private readonly costs = new CostDecorator();
    private readonly follow: Follow;
    private readonly sources = new SourceCache();
    private readonly out = vscode.window.createOutputChannel('Istari');
    private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly context: vscode.ExtensionContext) {
        this.provider = new ListingProvider(() => this.current, () => ({
            sourceText: config().get<boolean>('listing.sourceText', true),
            sourceLine: (file, line) => this.sources.line(file, line),
        }));
        this.follow = new Follow(() => this.current, this.provider, this.highlighter);

        this.status.command = 'istari.selectImage';
        this.status.text = '$(circuit-board) Istari';
        this.status.tooltip = 'Istari: select an ELF image';
        this.status.show();

        this.disposables.push(
            this.out, this.status, this.highlighter, this.costs, this.follow,
            vscode.window.onDidChangeVisibleTextEditors(() => this.decorateAll()),
            vscode.workspace.onDidChangeConfiguration(e => this.onConfig(e)),
        );
    }

    image(): Image | undefined {
        return this.current;
    }

    async ensureImage(): Promise<Image | undefined> {
        if (this.current) {
            return this.current;
        }
        if (this.loading) {
            return this.loading.catch(() => undefined);
        }
        return this.selectImage();
    }

    /**
     * @brief Loads an ELF, replaces the current image and refreshes every
     * dependent surface; rejects with the tool or parse error.
     */
    async load(elfPath: string): Promise<Image> {
        if (this.loading) {
            await this.loading.catch(() => undefined);
        }

        const base = path.basename(elfPath);
        const started = Date.now();
        this.status.text = `$(sync~spin) ${base}`;
        this.status.tooltip = `Istari: loading ${elfPath}`;

        this.loading = (async () => {
            const tools = await resolveTools(elfPath, config().get<string>('objdump', ''));
            this.log(`loading ${elfPath} with ${tools.objdump} (tools resolved in ${Date.now() - started} ms)`);
            return loadImage(elfPath, tools, phase => this.log(`  ${base}: ${phase}`));
        })();

        try {
            const image = await this.loading;
            this.current = image;
            this.log(`${base}: ${image.fns.length} functions, ${image.instrs.length} instructions, `
                + `${image.files.length} source files, ${Date.now() - started} ms in total`);

            this.status.text = `$(circuit-board) ${base}`;
            this.status.tooltip = new vscode.MarkdownString(`**Istari** ${elfPath}\n\n`
                + `${image.fns.length} functions, ${image.instrs.length} instructions, ${image.files.length} source files\n\n`
                + 'Click to select another image');

            this.watch(elfPath);
            this.provider.invalidateAll();
            this.decorateAll();
            return image;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log(`load failed: ${message}`);
            this.status.text = '$(error) Istari';
            this.status.tooltip = message;
            void vscode.window.showErrorMessage(`Istari: ${message}`, 'Show log')
                .then(choice => { if (choice) { this.out.show(); } });
            throw err;
        } finally {
            this.loading = undefined;
        }
    }

    async reload(): Promise<void> {
        if (this.current) {
            await this.load(this.current.path).catch(() => undefined);
        }
    }

    /**
     * @brief Picks an ELF from the workspace, remembers it, loads it.
     */
    async selectImage(): Promise<Image | undefined> {
        const found = await vscode.workspace.findFiles('**/*.elf', '**/node_modules/**', 200);
        if (found.length === 0) {
            void vscode.window.showWarningMessage('Istari: no .elf file in the workspace; set istari.image to one');
            return undefined;
        }

        const items = await Promise.all(found.map(async uri => {
            const stat = await vscode.workspace.fs.stat(uri);
            return {
                label: path.basename(uri.fsPath),
                description: vscode.workspace.asRelativePath(path.dirname(uri.fsPath)),
                detail: `${new Date(stat.mtime).toLocaleString()}  ${Math.round(stat.size / 1024)} KiB`,
                uri,
                mtime: stat.mtime,
            };
        }));
        items.sort((a, b) => b.mtime - a.mtime);

        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: 'ELF image to disassemble',
            matchOnDescription: true,
        });
        if (!pick) {
            return undefined;
        }

        await this.context.workspaceState.update(STATE_IMAGE, pick.uri.fsPath);
        return this.load(pick.uri.fsPath).catch(() => undefined);
    }

    /**
     * @brief Startup choice: the remembered pick, then istari.image, then the
     * single ELF of the workspace; several ELFs wait for a pick.
     */
    async autoload(): Promise<void> {
        const remembered = this.context.workspaceState.get<string>(STATE_IMAGE);
        const configured = config().get<string>('image', '');
        let target: string | undefined;

        if (remembered && fs.existsSync(remembered)) {
            target = remembered;
        } else if (configured) {
            target = resolveWorkspacePath(configured);
        } else {
            const found = await vscode.workspace.findFiles('**/*.elf', '**/node_modules/**', 2);
            if (found.length === 1) {
                target = found[0].fsPath;
            } else if (found.length > 1) {
                this.status.text = '$(circuit-board) Istari: select image';
            }
        }

        if (target) {
            await this.load(target).catch(() => undefined);
        }
    }

    log(message: string): void {
        this.out.appendLine(`[${clock()}] ${message}`);
    }

    private watch(elfPath: string): void {
        this.watcher?.dispose();
        this.watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(path.dirname(elfPath)), path.basename(elfPath)));

        const schedule = () => {
            if (this.reloadTimer) {
                clearTimeout(this.reloadTimer);
            }
            this.reloadTimer = setTimeout(() => {
                this.log(`${path.basename(elfPath)} changed on disk`);
                void this.load(elfPath).catch(() => undefined);
            }, RELOAD_DEBOUNCE_MS);
        };
        this.watcher.onDidChange(schedule);
        this.watcher.onDidCreate(schedule);
    }

    private decorateAll(): void {
        const mode = config().get<CostMode>('costs', 'inclusive');
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.scheme === 'file') {
                this.costs.apply(editor, this.current, mode);
            }
        }
    }

    private onConfig(e: vscode.ConfigurationChangeEvent): void {
        if (e.affectsConfiguration('istari.image') || e.affectsConfiguration('istari.objdump')) {
            void this.context.workspaceState.update(STATE_IMAGE, undefined).then(() => this.autoload());
        }
        if (e.affectsConfiguration('istari.costs')) {
            this.decorateAll();
        }
        if (e.affectsConfiguration('istari.listing')) {
            this.provider.invalidateAll();
        }
    }

    dispose(): void {
        this.watcher?.dispose();
        if (this.reloadTimer) {
            clearTimeout(this.reloadTimer);
        }
        this.disposables.forEach(d => d.dispose());
    }
}

/**
 * @brief Source text for listing markers: open documents first, then disk,
 * re-read when the file's mtime moves.
 */
class SourceCache {
    private readonly files = new Map<string, { mtimeMs: number; lines: string[] }>();

    line(file: string, line: number): string | undefined {
        const open = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === file);
        if (open) {
            return line <= open.lineCount ? open.lineAt(line - 1).text : undefined;
        }

        try {
            const mtimeMs = fs.statSync(file).mtimeMs;
            let entry = this.files.get(file);
            if (!entry || entry.mtimeMs !== mtimeMs) {
                entry = { mtimeMs, lines: fs.readFileSync(file, 'utf8').split('\n') };
                this.files.set(file, entry);
            }
            return entry.lines[line - 1];
        } catch {
            return undefined;
        }
    }
}

function resolveWorkspacePath(p: string): string {
    if (path.isAbsolute(p)) {
        return p;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    return path.join(root, p);
}

export async function activate(context: vscode.ExtensionContext): Promise<IstariApi> {
    const istari = new Istari(context);
    const navigator = new Navigator(istari);

    context.subscriptions.push(
        istari,
        vscode.workspace.registerTextDocumentContentProvider(SCHEME, istari.provider),
        vscode.languages.registerDefinitionProvider({ scheme: SCHEME }, new ListingDefinitions(() => istari.image(), istari.provider)),
        vscode.languages.registerHoverProvider({ scheme: SCHEME }, new ListingHovers(() => istari.image(), istari.provider)),
        vscode.commands.registerCommand('istari.openFunction', (args?: OpenFunctionArgs) => navigator.openFunction(args)),
        vscode.commands.registerCommand('istari.showAssembly', () => navigator.showAssembly()),
        vscode.commands.registerCommand('istari.selectImage', () => istari.selectImage()),
        vscode.commands.registerCommand('istari.reload', () => istari.reload()),
        vscode.commands.registerCommand('istari.cheatSheet', () => navigator.cheatSheet()),
    );

    void istari.autoload();

    return {
        loadImage: elfPath => istari.load(elfPath),
        image: () => istari.image(),
    };
}

export function deactivate(): void {}
