/**
 * @brief In-memory model of one disassembled ELF image.
 *
 * Every entity is addressed by a dense index into the public arrays; -1 means
 * none. Files, source locations, names and inline chains are interned, so a
 * source line is one integer and costs accumulate by index.
 */

import * as fs from 'fs';

export interface SourceLoc {
    file: number;
    line: number;
}

/**
 * @brief One inline frame: the call site and the function it sits in.
 */
export interface Frame {
    loc: number;
    fn: number;
}

/**
 * @brief One instruction or literal-pool word as objdump prints it.
 *
 * The chain lists inline frames from the innermost call site outward; its
 * last frame is a line of the function the instruction was emitted into.
 * scope names the innermost DWARF subprogram the instruction belongs to.
 */
export interface Instr {
    addr: number;
    size: number;
    text: string;
    loc: number;
    scope: number;
    chain: number;
}

/**
 * @brief One function symbol with its instruction range [first, end).
 */
export interface Fn {
    name: string;
    addr: number;
    size: number;
    first: number;
    end: number;
    loc: number;
}

/**
 * @brief Bytes a source line is responsible for, summed over every function it
 * was compiled into.
 *
 * exclusive counts instructions attributed to the line itself; inclusive adds
 * every instruction inlined through the line. fns keeps the inclusive split
 * per function.
 */
export interface LineCost {
    exclusive: number;
    inclusive: number;
    fns: Map<number, number>;
}

export class Image {
    readonly files: string[] = [];
    readonly locs: SourceLoc[] = [];
    readonly names: string[] = [];
    readonly chains: Frame[][] = [];
    readonly instrs: Instr[] = [];
    readonly fns: Fn[] = [];

    private readonly fileIndex = new Map<string, number>();
    private readonly fileLines = new Map<number, Map<number, number>>();
    private readonly nameIndex = new Map<string, number>();
    private readonly chainIndex = new Map<string, number>();
    private readonly fnIndex = new Map<string, number>();
    private readonly fileMatches = new Map<string, number>();
    private costs: (LineCost | undefined)[] = [];

    constructor(readonly path: string, readonly mtimeMs: number, readonly machine: number) {}

    // ------------------------------------------------------------------------------
    // Interning
    // ------------------------------------------------------------------------------

    internFile(file: string): number {
        let idx = this.fileIndex.get(file);

        if (idx === undefined) {
            idx = this.files.push(file) - 1;
            this.fileIndex.set(file, idx);
            this.fileLines.set(idx, new Map());
        }

        return idx;
    }

    internLoc(file: number, line: number): number {
        const lines = this.fileLines.get(file)!;
        let idx = lines.get(line);

        if (idx === undefined) {
            idx = this.locs.push({ file, line }) - 1;
            lines.set(line, idx);
        }

        return idx;
    }

    internName(name: string): number {
        let idx = this.nameIndex.get(name);

        if (idx === undefined) {
            idx = this.names.push(name) - 1;
            this.nameIndex.set(name, idx);
        }

        return idx;
    }

    internChain(frames: Frame[]): number {
        const key = frames.map(f => `${f.loc}:${f.fn}`).join(',');
        let idx = this.chainIndex.get(key);

        if (idx === undefined) {
            idx = this.chains.push(frames.slice()) - 1;
            this.chainIndex.set(key, idx);
        }

        return idx;
    }

    /**
     * @brief Replaces the spelling of an interned name; every reference follows.
     */
    rename(idx: number, name: string): void {
        this.names[idx] = name;
    }

    // ------------------------------------------------------------------------------
    // Lookup
    // ------------------------------------------------------------------------------

    /**
     * @brief Index of the function whose [addr, addr + size) covers addr.
     */
    fnContaining(addr: number): number {
        let lo = 0;
        let hi = this.fns.length - 1;

        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (this.fns[mid].addr <= addr) {
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        const fn = this.fns[hi];
        return fn && addr < fn.addr + fn.size ? hi : -1;
    }

    fnStartingAt(addr: number): number {
        const idx = this.fnContaining(addr);
        return idx >= 0 && this.fns[idx].addr === addr ? idx : -1;
    }

    fnNamed(name: string): number {
        return this.fnIndex.get(name) ?? -1;
    }

    locAt(file: number, line: number): number {
        return this.fileLines.get(file)?.get(line) ?? -1;
    }

    /**
     * @brief Line number to loc index for every line of the file that has code.
     */
    linesOf(file: number): ReadonlyMap<number, number> {
        return this.fileLines.get(file) ?? new Map();
    }

    costOf(loc: number): LineCost | undefined {
        return this.costs[loc];
    }

    /**
     * @brief File index for a path on disk: exact match, then realpath, then the
     * unique longest path-suffix match.
     */
    findFile(fsPath: string): number {
        const cached = this.fileMatches.get(fsPath);
        if (cached !== undefined) {
            return cached;
        }

        let idx = this.fileIndex.get(fsPath) ?? this.suffixMatch(fsPath);
        if (idx < 0) {
            try {
                const real = fs.realpathSync(fsPath);
                if (real !== fsPath) {
                    idx = this.fileIndex.get(real) ?? this.suffixMatch(real);
                }
            } catch {
                idx = -1;
            }
        }

        this.fileMatches.set(fsPath, idx);
        return idx;
    }

    // TODO: a basename-only match accepts any same-named file from another tree;
    // tighten once a real mismatch shows up in use.
    private suffixMatch(fsPath: string): number {
        const want = fsPath.split('/');
        let best = -1;
        let bestDepth = 0;
        let ambiguous = false;

        for (let i = 0; i < this.files.length; i++) {
            const have = this.files[i].split('/');
            let depth = 0;
            while (depth < want.length && depth < have.length
                && want[want.length - 1 - depth] === have[have.length - 1 - depth]) {
                depth++;
            }

            if (depth > bestDepth) {
                best = i;
                bestDepth = depth;
                ambiguous = false;
            } else if (depth === bestDepth && depth > 0) {
                ambiguous = true;
            }
        }

        return ambiguous ? -1 : best;
    }

    // ------------------------------------------------------------------------------
    // Finalization
    // ------------------------------------------------------------------------------

    /**
     * @brief Closes the image after parsing: function sizes, instruction sizes,
     * declaration lines, name index and line costs.
     */
    finish(): void {
        this.fns.sort((a, b) => a.addr - b.addr);

        for (let i = 0; i < this.fns.length; i++) {
            const fn = this.fns[i];

            if (fn.size <= 0) {
                const last = fn.end > fn.first ? this.instrs[fn.end - 1].addr + 4 : fn.addr + 4;
                const next = i + 1 < this.fns.length ? this.fns[i + 1].addr : last;
                fn.size = Math.max(next - fn.addr, 2);
            }

            for (let k = fn.first; k < fn.end; k++) {
                const ins = this.instrs[k];
                const nextAddr = k + 1 < fn.end ? this.instrs[k + 1].addr : fn.addr + fn.size;
                ins.size = plausibleSize(nextAddr - ins.addr);
            }

            fn.loc = declarationLoc(this.instrs, fn);
            this.fnIndex.set(fn.name, i);
        }

        this.accumulateCosts();
    }

    private accumulateCosts(): void {
        this.costs = new Array(this.locs.length);
        const cost = (loc: number): LineCost => (this.costs[loc] ??= { exclusive: 0, inclusive: 0, fns: new Map() });
        const add = (m: Map<number, number>, key: number, bytes: number) => m.set(key, (m.get(key) ?? 0) + bytes);

        for (let f = 0; f < this.fns.length; f++) {
            const fn = this.fns[f];

            for (let k = fn.first; k < fn.end; k++) {
                const ins = this.instrs[k];
                const touched = new Set<number>();

                if (ins.loc >= 0) {
                    const c = cost(ins.loc);
                    c.exclusive += ins.size;
                    c.inclusive += ins.size;
                    add(c.fns, f, ins.size);
                    touched.add(ins.loc);
                }

                if (ins.chain >= 0) {
                    for (const frame of this.chains[ins.chain]) {
                        if (touched.has(frame.loc)) {
                            continue;
                        }
                        touched.add(frame.loc);
                        const c = cost(frame.loc);
                        c.inclusive += ins.size;
                        add(c.fns, f, ins.size);
                    }
                }
            }
        }
    }
}

// The last instruction of a function has no successor; a delta beyond any
// real encoding means padding or a literal pool follows.
function plausibleSize(delta: number): number {
    return delta > 0 && delta <= 16 ? delta : 4;
}

function declarationLoc(instrs: Instr[], fn: Fn): number {
    let fallback = -1;

    for (let k = fn.first; k < fn.end; k++) {
        const ins = instrs[k];
        if (ins.loc < 0) {
            continue;
        }
        if (ins.chain < 0) {
            return ins.loc;
        }
        if (fallback < 0) {
            fallback = ins.loc;
        }
    }

    return fallback;
}
