/**
 * @brief Cheat sheet selection by ELF machine type or by name.
 */

import { ARM } from './arm';
import { Isa } from './isa';

const ALL: Isa[] = [ARM];

// TODO: a RISC-V table once an image other than the ARM proving ground shows
// up; the mnemonic normalisation there has no condition or width suffixes.
export function isaForMachine(machine: number): Isa | undefined {
    return machine === 0x28 ? ARM : undefined;
}

export function isaById(id: string): Isa | undefined {
    return ALL.find(isa => isa.id === id);
}
