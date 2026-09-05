/**
 * @brief Parser for GNU objdump and nm text into an Image.
 *
 * Reads the output of objdump -d -l --inlines -C --no-show-raw-insn. A scope
 * line and a file:line line stay in force until the next one; the inlined-by
 * lines printed directly before an instruction are that instruction's complete
 * chain. Symbol sizes come from nm -S --defined-only.
 */

import { Frame, Image } from './image';

const RE_INSTR = /^ +([0-9a-f]+):\s+(.*)$/;
const RE_LABEL = /^([0-9a-f]+) <(.+)>:$/;
const RE_INLINED = /^inlined by (.+):(\d+) \((.*)\)$/;
const RE_LOC = /^(.+):(\d+)(?: \(discriminator \d+\))?$/;
const RE_SCOPE = /^(.+):$/;
const RE_NM_SIZED = /^([0-9a-f]+) ([0-9a-f]+) [tTwW] /;

export function parseSymbolSizes(nm: string): Map<number, number> {
    const sizes = new Map<number, number>();

    for (const line of nm.split('\n')) {
        const m = RE_NM_SIZED.exec(line);
        if (m) {
            sizes.set(parseInt(m[1], 16), parseInt(m[2], 16));
        }
    }

    return sizes;
}

export function parseDisassembly(text: string, image: Image, sizes: Map<number, number>): void {
    let loc = -1;
    let scope = -1;
    let frames: Frame[] = [];
    let fn = -1;

    const closeFn = () => {
        if (fn >= 0) {
            image.fns[fn].end = image.instrs.length;
        }
    };

    for (const line of text.split('\n')) {
        if (line.length === 0) {
            continue;
        }

        if (line.charCodeAt(0) === 0x20) {
            const m = RE_INSTR.exec(line);
            if (m && fn >= 0) {
                const chain = frames.length ? image.internChain(frames) : -1;
                image.instrs.push({
                    addr: parseInt(m[1], 16),
                    size: 0,
                    text: formatInstr(m[2]),
                    loc,
                    scope,
                    chain,
                });
            }
            frames = [];
            continue;
        }

        if (line.startsWith('inlined by ')) {
            const m = RE_INLINED.exec(line);
            if (m) {
                frames.push({
                    loc: image.internLoc(image.internFile(m[1]), parseInt(m[2], 10)),
                    fn: image.internName(m[3]),
                });
            }
            continue;
        }

        let m = RE_LABEL.exec(line);
        if (m) {
            closeFn();
            const addr = parseInt(m[1], 16);
            fn = image.fns.push({
                name: m[2],
                addr,
                size: sizes.get(addr) ?? 0,
                first: image.instrs.length,
                end: image.instrs.length,
                loc: -1,
            }) - 1;
            loc = -1;
            scope = -1;
            frames = [];
            continue;
        }

        m = RE_LOC.exec(line);
        if (m) {
            loc = m[1] === '??' ? -1 : image.internLoc(image.internFile(m[1]), parseInt(m[2], 10));
            continue;
        }

        m = RE_SCOPE.exec(line);
        if (m && !line.startsWith('Disassembly of section')) {
            scope = image.internName(stripEmptyParens(m[1]));
        }
    }

    closeFn();
}

// objdump separates mnemonic, operands and its own annotation by tabs.
function formatInstr(rest: string): string {
    const parts = rest.split('\t');
    const operands = parts.slice(1).join('  ').trim();
    return operands ? `${parts[0].padEnd(8)} ${operands}` : parts[0];
}

// Undemangled scope lines print as name(); demangled ones already carry a
// parameter list.
function stripEmptyParens(name: string): string {
    return name.endsWith('()') && name.indexOf('(') === name.length - 2 ? name.slice(0, -2) : name;
}
