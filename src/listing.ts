/**
 * @brief Renders one function of an Image as listing text and keeps the
 * per-line index the editor features navigate by.
 *
 * A marker line precedes every run of instructions that share a source line
 * and inline chain; header lines start with ";;", markers with "; ".
 */

import * as path from 'path';
import { Image, Instr } from './image';

/**
 * @brief What one listing line stands for; instr is -1 on marker and header
 * lines, loc and chain are -1 where nothing is known.
 */
export interface ListingLine {
    instr: number;
    loc: number;
    scope: number;
    chain: number;
}

export interface Listing {
    fn: number;
    text: string;
    lines: ListingLine[];
    addrLine: Map<number, number>;
}

export interface ListingOptions {
    sourceText: boolean;
    sourceLine: (file: string, line: number) => string | undefined;
    displayPath?: (file: string) => string;
}

const NONE: ListingLine = { instr: -1, loc: -1, scope: -1, chain: -1 };

export function renderListing(image: Image, fnIdx: number, opts: ListingOptions): Listing {
    const fn = image.fns[fnIdx];
    const out: string[] = [];
    const lines: ListingLine[] = [];
    const addrLine = new Map<number, number>();
    const push = (text: string, line: ListingLine) => {
        out.push(text);
        lines.push(line);
    };

    const where = fn.loc >= 0 ? `  ${locText(image, fn.loc, opts.displayPath)}` : '';
    push(`;; ${fn.name}`, NONE);
    push(`;; ${path.basename(image.path)}  ${hex(fn.addr)}  ${fn.size} bytes${where}`, NONE);
    push('', NONE);

    let prevLoc = -2;
    let prevChain = -2;
    for (let i = fn.first; i < fn.end; i++) {
        const ins = image.instrs[i];

        if (ins.loc !== prevLoc || ins.chain !== prevChain) {
            push(markerText(image, ins, opts), { instr: -1, loc: ins.loc, scope: ins.scope, chain: ins.chain });
            prevLoc = ins.loc;
            prevChain = ins.chain;
        }

        addrLine.set(ins.addr, out.length);
        push(`  ${ins.addr.toString(16)}:  ${ins.text}`, { instr: i, loc: ins.loc, scope: ins.scope, chain: ins.chain });
    }

    return { fn: fnIdx, text: out.join('\n'), lines, addrLine };
}

// Outermost frame first, so the marker reads along the call structure:
// "Row.cpp:244 > bringUp :226 > std::span::end span:333 | <source>".
function markerText(image: Image, ins: Instr, opts: ListingOptions): string {
    const hops: string[] = [];
    let prevFile = -1;

    if (ins.chain >= 0) {
        const frames = image.chains[ins.chain];
        for (let k = frames.length - 1; k >= 0; k--) {
            const callee = k > 0 ? frames[k - 1].fn : ins.scope;
            hops.push(`${locShort(image, frames[k].loc, prevFile)} > ${shortName(image.names[callee])}`);
            prevFile = image.locs[frames[k].loc].file;
        }
    }
    hops.push(ins.loc >= 0 ? locShort(image, ins.loc, prevFile) : '?');

    let text = `; ${hops.join(' ')}`;
    if (opts.sourceText && ins.loc >= 0) {
        const loc = image.locs[ins.loc];
        const source = opts.sourceLine(image.files[loc.file], loc.line)?.trim();
        if (source) {
            text += `  |  ${source}`;
        }
    }

    return text;
}

function locShort(image: Image, locIdx: number, prevFile: number): string {
    const loc = image.locs[locIdx];
    const file = loc.file === prevFile ? '' : path.basename(image.files[loc.file]);
    return `${file}:${loc.line}`;
}

export function locText(image: Image, locIdx: number, displayPath: (file: string) => string = f => f): string {
    const loc = image.locs[locIdx];
    return `${displayPath(image.files[loc.file])}:${loc.line}`;
}

export function hex(addr: number): string {
    return '0x' + addr.toString(16).padStart(8, '0');
}

// ------------------------------------------------------------------------------
// Short names
// ------------------------------------------------------------------------------

const PROTECTED = [
    '(anonymous namespace)',
    'operator<=>', 'operator<<=', 'operator>>=', 'operator<<', 'operator>>',
    'operator<=', 'operator>=', 'operator->*', 'operator->', 'operator<', 'operator>',
    'operator()',
];

/**
 * @brief Qualified name without template arguments, parameters, return type
 * and qualifiers; lambdas collapse to lambda#N and clone suffixes stay.
 */
export function shortName(name: string): string {
    if (name.startsWith('_Z')) {
        return name;
    }

    let s = name;
    for (let i = 0; i < PROTECTED.length; i++) {
        s = s.split(PROTECTED[i]).join(`@${i}@`);
    }

    s = stripGroups(s, '{', '}', inner => {
        const hash = inner.lastIndexOf('#');
        return inner.startsWith('lambda') && hash >= 0 ? `lambda${inner.slice(hash)}` : `{${inner}}`;
    });
    s = stripGroups(s, '<', '>', () => '');

    let suffix = '';
    const clone = s.indexOf(' [clone ');
    if (clone >= 0) {
        suffix = s.slice(clone);
        s = s.slice(0, clone);
    }

    s = stripGroups(cutParameters(s), '(', ')', () => '').trim();
    const space = s.lastIndexOf(' ');
    if (space >= 0) {
        s = s.slice(space + 1);
    }

    s = s + suffix;
    for (let i = PROTECTED.length - 1; i >= 0; i--) {
        s = s.split(`@${i}@`).join(PROTECTED[i]);
    }

    return s;
}

function stripGroups(s: string, open: string, close: string, replace: (inner: string) => string): string {
    let out = '';
    let depth = 0;
    let start = 0;

    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === open) {
            if (depth === 0) {
                start = i;
            }
            depth++;
        } else if (c === close && depth > 0) {
            depth--;
            if (depth === 0) {
                out += replace(s.slice(start + 1, i));
            }
        } else if (depth === 0) {
            out += c;
        }
    }

    return depth === 0 ? out : s;
}

// Drops the last top-level parenthesised group and the qualifiers after it.
function cutParameters(s: string): string {
    let depth = 0;
    let lastOpen = -1;

    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '(') {
            if (depth === 0) {
                lastOpen = i;
            }
            depth++;
        } else if (c === ')') {
            depth--;
        }
    }

    return lastOpen >= 0 ? s.slice(0, lastOpen) : s;
}

// ------------------------------------------------------------------------------
// Text-level lookups
// ------------------------------------------------------------------------------

/**
 * @brief Address of the "addr <symbol+off>" reference under a column, if any.
 */
export function targetAt(text: string, col: number): number | undefined {
    const re = /\b([0-9a-f]+) </g;
    let m: RegExpExecArray | null;

    while ((m = re.exec(text))) {
        const open = m.index + m[0].length - 1;
        let depth = 0;
        let close = open;
        for (; close < text.length; close++) {
            if (text[close] === '<') {
                depth++;
            } else if (text[close] === '>' && --depth === 0) {
                break;
            }
        }

        if (col >= m.index && col <= close) {
            return parseInt(m[1], 16);
        }
    }

    return undefined;
}

/**
 * @brief Listing line of an address, or of the closest lower one.
 */
export function lineOfAddr(listing: Listing, addr: number): number {
    const exact = listing.addrLine.get(addr);
    if (exact !== undefined) {
        return exact;
    }

    let bestAddr = -1;
    let bestLine = 0;
    for (const [a, l] of listing.addrLine) {
        if (a <= addr && a > bestAddr) {
            bestAddr = a;
            bestLine = l;
        }
    }

    return bestLine;
}
