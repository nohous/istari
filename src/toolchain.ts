/**
 * @brief Locates binutils for an ELF and runs them into an Image.
 *
 * objdump comes from the per-architecture setting, then the global setting,
 * then built-in names for the ELF machine type; nm and c++filt are taken
 * from beside it and are optional.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Image } from './image';
import { parseDisassembly, parseSymbolSizes } from './objdump';

export interface Tools {
    objdump: string;
    nm?: string;
    cxxfilt?: string;
}

/**
 * @brief The objdump settings: one executable or prefix per architecture
 * name, and one for everything else.
 */
export interface ToolSettings {
    objdump?: string;
    toolchains?: Record<string, string>;
}

interface Machine {
    name: string;
    objdump: string[];
}

const MACHINES: Record<number, Machine> = {
    0x03: { name: 'i386', objdump: ['objdump'] },
    0x04: { name: 'm68k', objdump: ['m68k-elf-objdump', 'm68k-linux-gnu-objdump'] },
    0x08: { name: 'mips', objdump: ['mips-linux-gnu-objdump', 'mipsel-linux-gnu-objdump', 'mips-elf-objdump'] },
    0x14: { name: 'powerpc', objdump: ['powerpc-eabi-objdump', 'powerpc-linux-gnu-objdump'] },
    0x28: { name: 'arm', objdump: ['arm-none-eabi-objdump', 'arm-linux-gnueabihf-objdump', 'arm-linux-gnueabi-objdump'] },
    0x3e: { name: 'x86_64', objdump: ['objdump'] },
    0x53: { name: 'avr', objdump: ['avr-objdump'] },
    0x5e: { name: 'xtensa', objdump: ['xtensa-esp32-elf-objdump', 'xtensa-esp32s3-elf-objdump', 'xtensa-lx106-elf-objdump'] },
    0x69: { name: 'msp430', objdump: ['msp430-elf-objdump'] },
    0xb7: { name: 'aarch64', objdump: ['aarch64-none-elf-objdump', 'aarch64-linux-gnu-objdump'] },
    0xf3: { name: 'riscv', objdump: ['riscv-none-elf-objdump', 'riscv64-unknown-elf-objdump', 'riscv32-unknown-elf-objdump', 'riscv64-linux-gnu-objdump'] },
};

/**
 * @brief Architecture name of an ELF machine type, the key used in
 * istari.toolchains; unknown types read machine-0x<hex>.
 */
export function machineName(machine: number): string {
    return MACHINES[machine]?.name ?? `machine-0x${machine.toString(16)}`;
}

/**
 * @brief objdump candidates for a machine: configured ones first, then the
 * built-in names. A configured value ending in a dash is a toolchain prefix.
 */
export function objdumpCandidates(machine: number, settings: ToolSettings): { configured: string[]; builtin: string[] } {
    const configured = [settings.toolchains?.[machineName(machine)], settings.objdump]
        .filter((value): value is string => !!value)
        .map(value => value.endsWith('-') ? `${value}objdump` : value);

    return { configured, builtin: MACHINES[machine]?.objdump ?? ['objdump'] };
}

/**
 * @brief e_machine of an ELF header.
 */
export async function elfMachine(elfPath: string): Promise<number> {
    const fh = await fs.promises.open(elfPath, 'r');

    try {
        const buf = Buffer.alloc(20);
        const { bytesRead } = await fh.read(buf, 0, 20, 0);
        if (bytesRead < 20 || buf.readUInt32BE(0) !== 0x7f454c46) {
            throw new Error(`${elfPath} is not an ELF file`);
        }

        return buf[5] === 2 ? buf.readUInt16BE(18) : buf.readUInt16LE(18);
    } finally {
        await fh.close();
    }
}

export async function resolveTools(elfPath: string, settings: ToolSettings): Promise<Tools> {
    const machine = await elfMachine(elfPath);
    const name = machineName(machine);
    const { configured, builtin } = objdumpCandidates(machine, settings);
    let objdump: string | undefined;

    for (const candidate of configured) {
        objdump = await usable(candidate);
        if (objdump) {
            break;
        }
    }
    if (!objdump && configured.length) {
        throw new Error(`the configured objdump for ${name} is not executable (${configured.join(', ')}); `
            + `check istari.toolchains.${name} or istari.objdump`);
    }

    for (const candidate of objdump ? [] : builtin) {
        objdump = await usable(candidate);
        if (objdump) {
            break;
        }
    }
    if (!objdump) {
        throw new Error(`no objdump for ${name} on PATH (tried ${builtin.join(', ')}); `
            + `set istari.toolchains.${name} or istari.objdump`);
    }

    return {
        objdump,
        nm: await usable(sibling(objdump, 'nm')),
        cxxfilt: await usable(sibling(objdump, 'c++filt')),
    };
}

/**
 * @brief Disassembles and indexes an ELF; phase reports name each step with
 * its duration so a slow load can be attributed.
 */
export async function loadImage(elfPath: string, tools: Tools, phase: (report: string) => void = () => {}): Promise<Image> {
    let mark = Date.now();
    const lap = (what: string) => {
        const now = Date.now();
        phase(`${what} in ${now - mark} ms`);
        mark = now;
    };

    const stat = await fs.promises.stat(elfPath);
    const image = new Image(elfPath, stat.mtimeMs, await elfMachine(elfPath));

    const [disassembly, symbols] = await Promise.all([
        run(tools.objdump, ['-d', '-l', '--inlines', '-C', '--no-show-raw-insn', elfPath]),
        tools.nm ? run(tools.nm, ['-S', '--defined-only', elfPath]) : Promise.resolve(''),
    ]);
    lap(`objdump and nm produced ${Math.round(disassembly.length / 1048576)} MB`);

    parseDisassembly(disassembly, image, parseSymbolSizes(symbols));
    lap('parsed');

    if (tools.cxxfilt) {
        await demangleNames(image, tools.cxxfilt);
        lap('demangled');
    }

    image.finish();
    lap('indexed');

    return image;
}

// objdump leaves the function names inside inlined-by lines mangled.
async function demangleNames(image: Image, cxxfilt: string): Promise<void> {
    const mangled: number[] = [];
    for (let i = 0; i < image.names.length; i++) {
        if (image.names[i].startsWith('_Z')) {
            mangled.push(i);
        }
    }
    if (mangled.length === 0) {
        return;
    }

    const out = await run(cxxfilt, [], mangled.map(i => image.names[i]).join('\n') + '\n');
    const lines = out.split('\n');
    if (lines.length < mangled.length) {
        return;
    }

    mangled.forEach((idx, k) => {
        if (lines[k] && lines[k] !== image.names[idx]) {
            image.rename(idx, lines[k]);
        }
    });
}

function sibling(objdump: string, tool: string): string {
    return objdump.replace(/objdump(?=[^/\\]*$)/, tool);
}

async function usable(name: string): Promise<string | undefined> {
    const dirs = name.includes(path.sep) ? [''] : (process.env.PATH ?? '').split(path.delimiter);

    for (const dir of dirs) {
        const candidate = dir ? path.join(dir, name) : name;
        try {
            await fs.promises.access(candidate, fs.constants.X_OK);
            return candidate;
        } catch {
            continue;
        }
    }

    return undefined;
}

function run(cmd: string, args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        let stderr = '';

        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on('error', err => reject(new Error(`${cmd}: ${err.message}`)));
        child.on('close', code => {
            if (code === 0) {
                resolve(Buffer.concat(chunks).toString('utf8'));
            } else {
                reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}: ${stderr.slice(0, 400)}`));
            }
        });

        if (input !== undefined) {
            child.stdin.end(input);
        } else {
            child.stdin.end();
        }
    });
}
