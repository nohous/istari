/**
 * @brief What an instruction-set cheat sheet provides to hovers and to the
 * cheat-sheet document.
 */

export interface InstructionHelp {
    mnemonic: string;
    syntax: string;
    text: string;
    notes: string[];
}

export interface Isa {
    readonly id: string;
    readonly name: string;
    instruction(mnemonic: string): InstructionHelp | undefined;
    register(name: string): string | undefined;
    cheatSheet(): string;
}
