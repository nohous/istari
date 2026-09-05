/**
 * @brief ARM Thumb-2 cheat sheet: ARMv7E-M as a Cortex-M7 with FPv5-D16
 * executes it, in the spelling GNU objdump prints.
 *
 * Lookups normalise objdump's mnemonic: width suffix (.n/.w), data-type
 * suffixes (.f32, .s32), an IT pattern, a condition code, a flag-setting s.
 */

import { InstructionHelp, Isa } from './isa';

interface Entry {
    syntax: string;
    text: string;
}

type Group = [string, Record<string, Entry>];

// ------------------------------------------------------------------------------
// Instructions
// ------------------------------------------------------------------------------

const MOVE_ARITH: Record<string, Entry> = {
    mov:   { syntax: 'MOV{S} Rd, Rm | #imm', text: 'Rd = operand. S updates N and Z. mov Rd, sp is how a frame base is taken.' },
    movw:  { syntax: 'MOVW Rd, #imm16', text: 'Rd = imm16, upper half cleared. Pairs with MOVT to build a 32-bit constant without a literal pool.' },
    movt:  { syntax: 'MOVT Rd, #imm16', text: 'Writes imm16 into bits 31:16 of Rd, low half unchanged.' },
    mvn:   { syntax: 'MVN{S} Rd, <op>', text: 'Rd = NOT operand.' },
    adr:   { syntax: 'ADR Rd, label', text: 'Rd = pc-relative address of label. An address computation, no memory access.' },
    add:   { syntax: 'ADD{S} Rd, Rn, Rm | #imm', text: 'Rd = Rn + operand. S sets N Z C V. add Rd, sp, #imm forms the address of a stack slot.' },
    addw:  { syntax: 'ADDW Rd, Rn, #imm12', text: '32-bit add with a plain 12-bit immediate (0..4095); never sets flags.' },
    sub:   { syntax: 'SUB{S} Rd, Rn, <op>', text: 'Rd = Rn - operand. sub sp, #imm reserves stack in the prologue.' },
    subw:  { syntax: 'SUBW Rd, Rn, #imm12', text: '32-bit subtract with a plain 12-bit immediate; never sets flags.' },
    rsb:   { syntax: 'RSB{S} Rd, Rn, <op>', text: 'Reverse subtract: Rd = operand - Rn.' },
    neg:   { syntax: 'NEGS Rd, Rm', text: 'Rd = -Rm. Alias of RSBS Rd, Rm, #0.' },
    adc:   { syntax: 'ADC{S} Rd, Rn, <op>', text: 'Rd = Rn + operand + C. The high word of a 64-bit add.' },
    sbc:   { syntax: 'SBC{S} Rd, Rn, <op>', text: 'Rd = Rn - operand - NOT(C). The high word of a 64-bit subtract.' },
    mul:   { syntax: 'MUL{S} Rd, Rn, Rm', text: 'Rd = low 32 bits of Rn * Rm.' },
    mla:   { syntax: 'MLA Rd, Rn, Rm, Ra', text: 'Multiply-accumulate: Rd = Ra + Rn * Rm, low 32 bits. Array indexing with a stride shows up as mla.' },
    mls:   { syntax: 'MLS Rd, Rn, Rm, Ra', text: 'Multiply-subtract: Rd = Ra - Rn * Rm. Remainder after a division: n - (n / d) * d.' },
    umull: { syntax: 'UMULL RdLo, RdHi, Rn, Rm', text: 'RdHi:RdLo = Rn * Rm, unsigned 64-bit result.' },
    smull: { syntax: 'SMULL RdLo, RdHi, Rn, Rm', text: 'RdHi:RdLo = Rn * Rm, signed 64-bit result.' },
    umlal: { syntax: 'UMLAL RdLo, RdHi, Rn, Rm', text: 'RdHi:RdLo += Rn * Rm, unsigned.' },
    smlal: { syntax: 'SMLAL RdLo, RdHi, Rn, Rm', text: 'RdHi:RdLo += Rn * Rm, signed.' },
    sdiv:  { syntax: 'SDIV Rd, Rn, Rm', text: 'Rd = Rn / Rm, signed, rounding toward zero. Divide by zero gives 0, or UsageFault when CCR.DIV_0_TRP is set.' },
    udiv:  { syntax: 'UDIV Rd, Rn, Rm', text: 'Rd = Rn / Rm, unsigned. 2..12 cycles on Cortex-M7.' },
    uadd8: { syntax: 'UADD8 Rd, Rn, Rm', text: 'Four parallel unsigned byte adds; each byte sets its GE flag on carry. SIMD, usually followed by SEL.' },
    sel:   { syntax: 'SEL Rd, Rn, Rm', text: 'Per byte: Rd = GE flag set ? Rn : Rm. Byte-wise select after UADD8 and friends.' },
    cmp:   { syntax: 'CMP Rn, <op>', text: 'Flags N Z C V from Rn - operand, result discarded. Feeds the next conditional branch or IT block.' },
    cmn:   { syntax: 'CMN Rn, <op>', text: 'Flags from Rn + operand. cmn Rn, #1 tests Rn == -1.' },
};

const LOGIC_BITS: Record<string, Entry> = {
    and:  { syntax: 'AND{S} Rd, Rn, <op>', text: 'Rd = Rn AND operand.' },
    orr:  { syntax: 'ORR{S} Rd, Rn, <op>', text: 'Rd = Rn OR operand.' },
    orn:  { syntax: 'ORN{S} Rd, Rn, <op>', text: 'Rd = Rn OR NOT operand.' },
    eor:  { syntax: 'EOR{S} Rd, Rn, <op>', text: 'Rd = Rn XOR operand.' },
    bic:  { syntax: 'BIC{S} Rd, Rn, <op>', text: 'Bit clear: Rd = Rn AND NOT operand.' },
    tst:  { syntax: 'TST Rn, <op>', text: 'Flags from Rn AND operand: Z set when no tested bit is set.' },
    teq:  { syntax: 'TEQ Rn, <op>', text: 'Flags from Rn XOR operand: Z set when equal.' },
    lsl:  { syntax: 'LSL{S} Rd, Rm, #n | Rs', text: 'Logical shift left. S puts the last bit shifted out into C.' },
    lsr:  { syntax: 'LSR{S} Rd, Rm, #n | Rs', text: 'Logical shift right, zero fill.' },
    asr:  { syntax: 'ASR{S} Rd, Rm, #n | Rs', text: 'Arithmetic shift right, sign fill: signed division by a power of two.' },
    ror:  { syntax: 'ROR{S} Rd, Rm, #n | Rs', text: 'Rotate right.' },
    rrx:  { syntax: 'RRX{S} Rd, Rm', text: 'Rotate right by one through the carry: bit 0 goes to C, C enters bit 31.' },
    ubfx: { syntax: 'UBFX Rd, Rn, #lsb, #width', text: 'Rd = bits lsb .. lsb+width-1 of Rn, zero-extended. A bit-field read.' },
    sbfx: { syntax: 'SBFX Rd, Rn, #lsb, #width', text: 'Rd = bit field of Rn, sign-extended.' },
    bfi:  { syntax: 'BFI Rd, Rn, #lsb, #width', text: 'Inserts the low width bits of Rn into Rd at lsb; other bits of Rd stay. A bit-field write.' },
    bfc:  { syntax: 'BFC Rd, #lsb, #width', text: 'Clears a bit field in Rd.' },
    uxtb: { syntax: 'UXTB Rd, Rm', text: 'Rd = Rm[7:0] zero-extended. A cast to uint8_t.' },
    uxth: { syntax: 'UXTH Rd, Rm', text: 'Rd = Rm[15:0] zero-extended. A cast to uint16_t.' },
    sxtb: { syntax: 'SXTB Rd, Rm', text: 'Rd = Rm[7:0] sign-extended. A cast to int8_t.' },
    sxth: { syntax: 'SXTH Rd, Rm', text: 'Rd = Rm[15:0] sign-extended. A cast to int16_t.' },
    uxtab: { syntax: 'UXTAB Rd, Rn, Rm', text: 'Rd = Rn + zero-extended Rm[7:0].' },
    uxtah: { syntax: 'UXTAH Rd, Rn, Rm', text: 'Rd = Rn + zero-extended Rm[15:0].' },
    sxtab: { syntax: 'SXTAB Rd, Rn, Rm', text: 'Rd = Rn + sign-extended Rm[7:0].' },
    sxtah: { syntax: 'SXTAH Rd, Rn, Rm', text: 'Rd = Rn + sign-extended Rm[15:0].' },
    rev:   { syntax: 'REV Rd, Rm', text: 'Byte-reverse a word: 32-bit endianness swap (htonl).' },
    rev16: { syntax: 'REV16 Rd, Rm', text: 'Byte-reverse each halfword independently (htons on both halves).' },
    revsh: { syntax: 'REVSH Rd, Rm', text: 'Byte-reverse the low halfword and sign-extend it.' },
    rbit:  { syntax: 'RBIT Rd, Rm', text: 'Reverse the bit order of a word.' },
    clz:   { syntax: 'CLZ Rd, Rm', text: 'Rd = number of leading zero bits in Rm (32 for zero). Basis of __builtin_clz and log2.' },
    ssat:  { syntax: 'SSAT Rd, #sat, Rn{, shift}', text: 'Saturate the shifted Rn into a signed sat-bit range; Q set on saturation.' },
    usat:  { syntax: 'USAT Rd, #sat, Rn{, shift}', text: 'Saturate into an unsigned sat-bit range.' },
    pkhbt: { syntax: 'PKHBT Rd, Rn, Rm{, LSL #n}', text: 'Pack: low halfword from Rn, high halfword from shifted Rm.' },
    pkhtb: { syntax: 'PKHTB Rd, Rn, Rm{, ASR #n}', text: 'Pack: high halfword from Rn, low halfword from shifted Rm.' },
};

const LOAD_STORE: Record<string, Entry> = {
    ldr:    { syntax: 'LDR Rt, [Rn, #off] | [Rn, Rm{, LSL #n}] | [pc, #off]', text: 'Loads a 32-bit word. ldr Rt, [pc, #off] fetches a literal-pool constant; objdump appends its address as "@ (addr <sym>)".' },
    str:    { syntax: 'STR Rt, [Rn, #off] | [Rn, Rm{, LSL #n}]', text: 'Stores a 32-bit word.' },
    ldrb:   { syntax: 'LDRB Rt, [...]', text: 'Loads a byte, zero-extended.' },
    strb:   { syntax: 'STRB Rt, [...]', text: 'Stores the low byte of Rt.' },
    ldrh:   { syntax: 'LDRH Rt, [...]', text: 'Loads a halfword, zero-extended.' },
    strh:   { syntax: 'STRH Rt, [...]', text: 'Stores the low halfword of Rt.' },
    ldrsb:  { syntax: 'LDRSB Rt, [...]', text: 'Loads a byte, sign-extended.' },
    ldrsh:  { syntax: 'LDRSH Rt, [...]', text: 'Loads a halfword, sign-extended.' },
    ldrd:   { syntax: 'LDRD Rt, Rt2, [Rn, #off]', text: 'Loads two words from consecutive addresses: a 64-bit value or two adjacent fields.' },
    strd:   { syntax: 'STRD Rt, Rt2, [Rn, #off]', text: 'Stores two words to consecutive addresses.' },
    ldmia:  { syntax: 'LDMIA Rn{!}, {reglist}', text: 'Load multiple, increment after: fills the listed registers from ascending addresses starting at Rn; ! writes the end address back. Structure copies and pops.' },
    ldmdb:  { syntax: 'LDMDB Rn{!}, {reglist}', text: 'Load multiple, decrement before: addresses descend from Rn.' },
    stmia:  { syntax: 'STMIA Rn{!}, {reglist}', text: 'Store multiple, increment after. memcpy of a few words compiles to ldmia/stmia pairs.' },
    stmdb:  { syntax: 'STMDB Rn{!}, {reglist}', text: 'Store multiple, decrement before. stmdb sp!, {...} is PUSH with a 32-bit encoding, needed once the list holds r8..r12.' },
    push:   { syntax: 'PUSH {reglist}', text: 'Stores the registers below sp and lowers sp. The prologue saves callee-saved registers and lr here.' },
    pop:    { syntax: 'POP {reglist}', text: 'Restores registers from the stack and raises sp. A list containing pc returns.' },
    ldrex:  { syntax: 'LDREX Rt, [Rn]', text: 'Exclusive load: reads a word and arms the exclusive monitor for the following STREX.' },
    strex:  { syntax: 'STREX Rd, Rt, [Rn]', text: 'Exclusive store: writes only if the monitor is still armed. Rd = 0 on success, 1 on failure; the retry loop is an atomic read-modify-write.' },
    ldrexb: { syntax: 'LDREXB Rt, [Rn]', text: 'Exclusive byte load.' },
    strexb: { syntax: 'STREXB Rd, Rt, [Rn]', text: 'Exclusive byte store, Rd = 0 on success.' },
    ldrexh: { syntax: 'LDREXH Rt, [Rn]', text: 'Exclusive halfword load.' },
    strexh: { syntax: 'STREXH Rd, Rt, [Rn]', text: 'Exclusive halfword store.' },
    clrex:  { syntax: 'CLREX', text: 'Disarms the exclusive monitor.' },
    pld:    { syntax: 'PLD [Rn, #off]', text: 'Preload hint: warms the data cache, no architectural effect.' },
};

const BRANCH: Record<string, Entry> = {
    b:    { syntax: 'B{cond} label', text: 'Branch. With a condition suffix it runs only when the flags match. Range: .n +-2 KB (+-256 B when conditional), .w +-16 MB (+-1 MB conditional).' },
    bl:   { syntax: 'BL label', text: 'Call: lr = address of the next instruction, pc = label. Range +-16 MB.' },
    blx:  { syntax: 'BLX Rm', text: 'Call through a register: an indirect call via function pointer or vtable. Bit 0 of Rm must be 1 (Thumb).' },
    bx:   { syntax: 'BX Rm', text: 'Branch to the address in Rm. bx lr returns from a function.' },
    cbz:  { syntax: 'CBZ Rn, label', text: 'Compare and branch if Rn == 0, flags untouched. Forward range 0..126 bytes.' },
    cbnz: { syntax: 'CBNZ Rn, label', text: 'Compare and branch if Rn != 0, flags untouched.' },
    tbb:  { syntax: 'TBB [Rn, Rm]', text: 'Table branch: pc += 2 * byte at Rn + Rm. A dense switch compiles to tbb with the table right after it.' },
    tbh:  { syntax: 'TBH [Rn, Rm, LSL #1]', text: 'Table branch with halfword entries: pc += 2 * halfword at Rn + 2 * Rm.' },
    it:   { syntax: 'IT{x{y{z}}} cond', text: 'If-Then block: the next 1..4 instructions become conditional. The first runs on cond; each further letter says T (same condition) or E (its inverse) for the next one. objdump prints the resulting suffix on each of those instructions.' },
};

const SYSTEM: Record<string, Entry> = {
    nop:   { syntax: 'NOP', text: 'No operation. Alignment padding after a function, or objdump reading padding as code.' },
    yield: { syntax: 'YIELD', text: 'Hint that the thread is spinning; a NOP on Cortex-M.' },
    wfi:   { syntax: 'WFI', text: 'Wait for interrupt: sleeps until an interrupt or debug event. The idle loop.' },
    wfe:   { syntax: 'WFE', text: 'Wait for event: sleeps until an event or interrupt.' },
    sev:   { syntax: 'SEV', text: 'Send event to other processors.' },
    bkpt:  { syntax: 'BKPT #imm', text: 'Breakpoint: halts into the debugger. Fault without one.' },
    svc:   { syntax: 'SVC #imm', text: 'Supervisor call exception. FreeRTOS starts the first task from SVC_Handler.' },
    udf:   { syntax: 'UDF #imm', text: 'Permanently undefined: raises UsageFault. GCC emits it for __builtin_trap and for paths it proved unreachable.' },
    cpsid: { syntax: 'CPSID i | f', text: 'Disables interrupts: i sets PRIMASK (all configurable-priority exceptions), f sets FAULTMASK (everything except NMI). Critical section entry.' },
    cpsie: { syntax: 'CPSIE i | f', text: 'Enables interrupts by clearing PRIMASK (i) or FAULTMASK (f).' },
    dsb:   { syntax: 'DSB sy', text: 'Data synchronization barrier: waits until every earlier memory access has completed. After a register write that must land before continuing.' },
    dmb:   { syntax: 'DMB ish | sy', text: 'Data memory barrier: earlier memory accesses are observed before later ones. Every std::atomic acquire/release pays one.' },
    isb:   { syntax: 'ISB sy', text: 'Instruction synchronization barrier: flushes the pipeline so later instructions see earlier context changes (MSR, VTOR, cache enables).' },
    mrs:   { syntax: 'MRS Rd, sysreg', text: 'Reads a special register: apsr, ipsr, xpsr, primask, basepri, faultmask, control, msp, psp.' },
    msr:   { syntax: 'MSR sysreg, Rn', text: 'Writes a special register. msr basepri, Rn is the FreeRTOS critical section; msr psp/msp switches stacks.' },
};

const FLOAT: Record<string, Entry> = {
    vldr:   { syntax: 'VLDR Sd | Dd, [Rn, #off]', text: 'Loads one single (S) or double (D) FP register from memory.' },
    vstr:   { syntax: 'VSTR Sd | Dd, [Rn, #off]', text: 'Stores one FP register.' },
    vldmia: { syntax: 'VLDMIA Rn{!}, {reglist}', text: 'Loads a list of FP registers from ascending addresses.' },
    vstmdb: { syntax: 'VSTMDB Rn{!}, {reglist}', text: 'Stores a list of FP registers, decrement before.' },
    vpush:  { syntax: 'VPUSH {reglist}', text: 'Pushes FP registers; a prologue saving s16..s31 or d8..d15.' },
    vpop:   { syntax: 'VPOP {reglist}', text: 'Pops FP registers.' },
    vmov:   { syntax: 'VMOV Sd, Rt | Rt, Sn | Dd, Rt, Rt2 | Sd, #imm', text: 'Moves between core and FP registers, or loads an FP immediate. The bit pattern is copied unchanged: a reinterpret, never a conversion.' },
    vmrs:   { syntax: 'VMRS Rt | APSR_nzcv, fpscr', text: 'Reads FPSCR. vmrs APSR_nzcv, fpscr copies the FP compare result into the APSR flags so an ordinary conditional branch can use it.' },
    vmsr:   { syntax: 'VMSR fpscr, Rt', text: 'Writes FPSCR: rounding mode, exception enables, flush-to-zero.' },
    vadd:   { syntax: 'VADD.F32 Sd, Sn, Sm', text: 'FP add.' },
    vsub:   { syntax: 'VSUB.F32 Sd, Sn, Sm', text: 'FP subtract.' },
    vmul:   { syntax: 'VMUL.F32 Sd, Sn, Sm', text: 'FP multiply.' },
    vdiv:   { syntax: 'VDIV.F32 Sd, Sn, Sm', text: 'FP divide: 14 cycles single, 28 double on Cortex-M7.' },
    vfma:   { syntax: 'VFMA.F32 Sd, Sn, Sm', text: 'Fused multiply-add: Sd = Sd + Sn * Sm with one rounding.' },
    vfms:   { syntax: 'VFMS.F32 Sd, Sn, Sm', text: 'Fused multiply-subtract: Sd = Sd - Sn * Sm.' },
    vfnma:  { syntax: 'VFNMA.F32 Sd, Sn, Sm', text: 'Fused negated multiply-add: Sd = -Sd + (-Sn) * Sm.' },
    vfnms:  { syntax: 'VFNMS.F32 Sd, Sn, Sm', text: 'Fused negated multiply-subtract: Sd = -Sd + Sn * Sm.' },
    vmla:   { syntax: 'VMLA.F32 Sd, Sn, Sm', text: 'Multiply-accumulate with intermediate rounding.' },
    vmls:   { syntax: 'VMLS.F32 Sd, Sn, Sm', text: 'Multiply-subtract with intermediate rounding.' },
    vneg:   { syntax: 'VNEG.F32 Sd, Sm', text: 'FP negate (sign bit flip).' },
    vabs:   { syntax: 'VABS.F32 Sd, Sm', text: 'FP absolute value.' },
    vsqrt:  { syntax: 'VSQRT.F32 Sd, Sm', text: 'FP square root, correctly rounded.' },
    vcmp:   { syntax: 'VCMP.F32 Sd, Sm | #0.0', text: 'FP compare into the FPSCR flags; quiet NaNs compare as unordered without a trap. Followed by vmrs APSR_nzcv, fpscr.' },
    vcmpe:  { syntax: 'VCMPE.F32 Sd, Sm | #0.0', text: 'FP compare that raises Invalid Operation on any NaN, quiet ones included.' },
    vcvt:   { syntax: 'VCVT.<dst>.<src> Sd, Sm', text: 'Converts between integer and float or between single and double; the first type is the destination, the second the source. Float to int truncates toward zero.' },
    vcvtr:  { syntax: 'VCVTR.<dst>.<src> Sd, Sm', text: 'Float to int using the FPSCR rounding mode instead of truncation.' },
    vsel:   { syntax: 'VSEL<cond>.F32 Sd, Sn, Sm', text: 'Sd = cond ? Sn : Sm from the APSR flags (eq, vs, ge, gt). A branch-free FP select.' },
    vmaxnm: { syntax: 'VMAXNM.F32 Sd, Sn, Sm', text: 'Maximum; a quiet NaN input yields the other operand.' },
    vminnm: { syntax: 'VMINNM.F32 Sd, Sn, Sm', text: 'Minimum; a quiet NaN input yields the other operand.' },
    vrinta: { syntax: 'VRINTA.F32 Sd, Sm', text: 'Round to integral in FP format, ties away from zero.' },
    vrintz: { syntax: 'VRINTZ.F32 Sd, Sm', text: 'Round to integral toward zero (trunc).' },
    vrintm: { syntax: 'VRINTM.F32 Sd, Sm', text: 'Round to integral toward minus infinity (floor).' },
    vrintp: { syntax: 'VRINTP.F32 Sd, Sm', text: 'Round to integral toward plus infinity (ceil).' },
    vrintn: { syntax: 'VRINTN.F32 Sd, Sm', text: 'Round to integral to nearest, ties to even.' },
};

const DATA: Record<string, Entry> = {
    '.word':  { syntax: '.word imm32', text: 'Data, not code: a literal-pool constant or a vector-table entry that sits in the text section. ldr Rt, [pc, #off] reads it.' },
    '.short': { syntax: '.short imm16', text: 'Data, not code: a 16-bit constant, usually a tbh jump-table entry.' },
    '.byte':  { syntax: '.byte imm8', text: 'Data, not code: a byte, usually a tbb jump-table entry.' },
};

const GROUPS: Group[] = [
    ['Move and arithmetic', MOVE_ARITH],
    ['Logic, shifts and bit fields', LOGIC_BITS],
    ['Load and store', LOAD_STORE],
    ['Branch and control', BRANCH],
    ['System', SYSTEM],
    ['Floating point (FPv5-D16)', FLOAT],
    ['Data in the text section', DATA],
];

const TABLE: Record<string, Entry> = Object.assign({}, ...GROUPS.map(g => g[1]));

// Aliases objdump prints for the same encodings.
TABLE['ldm'] = TABLE['ldmia'];
TABLE['stm'] = TABLE['stmia'];
TABLE['vldm'] = TABLE['vldmia'];
TABLE['vstm'] = TABLE['vstmdb'];

// ------------------------------------------------------------------------------
// Suffixes
// ------------------------------------------------------------------------------

const CONDITIONS: Record<string, string> = {
    eq: 'Z set (equal)',
    ne: 'Z clear (not equal)',
    cs: 'C set (unsigned higher or same)',
    hs: 'C set (unsigned higher or same)',
    cc: 'C clear (unsigned lower)',
    lo: 'C clear (unsigned lower)',
    mi: 'N set (negative)',
    pl: 'N clear (positive or zero)',
    vs: 'V set (overflow)',
    vc: 'V clear (no overflow)',
    hi: 'C set and Z clear (unsigned higher)',
    ls: 'C clear or Z set (unsigned lower or same)',
    ge: 'N == V (signed greater or equal)',
    lt: 'N != V (signed less than)',
    gt: 'Z clear and N == V (signed greater than)',
    le: 'Z set or N != V (signed less or equal)',
    al: 'always',
};

const TYPES: Record<string, string> = {
    f16: 'half-precision float',
    f32: 'single-precision float',
    f64: 'double-precision float',
    s16: 'signed 16-bit integer',
    s32: 'signed 32-bit integer',
    u16: 'unsigned 16-bit integer',
    u32: 'unsigned 32-bit integer',
};

function suffixNote(suffix: string, position: string): string | undefined {
    if (suffix === 'n') {
        return '.n: 16-bit encoding';
    }
    if (suffix === 'w') {
        return '.w: 32-bit encoding, chosen for range, a high register or a wider immediate';
    }
    const type = TYPES[suffix];
    return type ? `.${suffix}: ${position} is a ${type}` : undefined;
}

function itNote(mnemonic: string): string {
    const letters = mnemonic.slice(1).split('');
    const parts = letters.map((l, i) => `${i + 1}: ${l === 't' ? 'on cond' : 'on the inverse'}`);
    return `${letters.length} conditional instructions follow, ${parts.join(', ')}`;
}

function lookupInstruction(mnemonic: string): InstructionHelp | undefined {
    const lower = mnemonic.toLowerCase();
    const notes: string[] = [];

    if (lower.startsWith('.')) {
        const data = TABLE[lower];
        return data ? { mnemonic: lower, syntax: data.syntax, text: data.text, notes } : undefined;
    }

    const parts = lower.split('.');
    let base = parts[0];
    const types = parts.slice(1).filter(p => TYPES[p]);
    parts.slice(1).forEach((suffix, i) => {
        const position = types.length === 2 ? (i === 0 ? 'the destination' : 'the source') : 'the operand';
        const note = suffixNote(suffix, position);
        if (note) {
            notes.push(note);
        }
    });

    let entry = TABLE[base];
    if (!entry && /^it[te]{1,3}$/.test(base)) {
        entry = TABLE['it'];
        notes.push(itNote(base));
        base = 'it';
    }
    if (!entry) {
        const cond = base.slice(-2);
        const stem = base.slice(0, -2);
        if (CONDITIONS[cond] && TABLE[stem]) {
            entry = TABLE[stem];
            notes.push(`${cond}: executes only when ${CONDITIONS[cond]}`);
            base = stem;
        }
    }
    if (!entry && base.endsWith('s') && TABLE[base.slice(0, -1)]) {
        entry = TABLE[base.slice(0, -1)];
        notes.push('s: updates the APSR flags N Z C V from the result');
        base = base.slice(0, -1);
    }

    return entry ? { mnemonic: base, syntax: entry.syntax, text: entry.text, notes } : undefined;
}

// ------------------------------------------------------------------------------
// Registers
// ------------------------------------------------------------------------------

interface RegisterEntry {
    names: string[];
    text: string;
}

const REGISTERS: RegisterEntry[] = [
    { names: ['r0'], text: 'First argument and the return value. Caller-saved scratch: nothing survives a bl in it.' },
    { names: ['r1'], text: 'Second argument; the high word of a 64-bit return value. Caller-saved.' },
    { names: ['r2'], text: 'Third argument. Caller-saved.' },
    { names: ['r3'], text: 'Fourth argument; further arguments go on the stack. Caller-saved, and GCC\'s favourite temporary.' },
    { names: ['r4'], text: 'Callee-saved (v1): a function that uses it pushes it in the prologue and pops it on return, so a value here outlives calls.' },
    { names: ['r5'], text: 'Callee-saved (v2).' },
    { names: ['r6'], text: 'Callee-saved (v3).' },
    { names: ['r7'], text: 'Callee-saved (v4); the frame pointer in Thumb-1 code.' },
    { names: ['r8'], text: 'Callee-saved (v5). Using r8..r12 forces 32-bit encodings, which is why -Os prefers r4..r7.' },
    { names: ['r9', 'sb'], text: 'Callee-saved (v6) in bare-metal AAPCS; the platform or static-base register on systems that reserve it.' },
    { names: ['r10', 'sl'], text: 'Callee-saved (v7); the stack-limit register in older ABIs, an ordinary variable register here.' },
    { names: ['r11', 'fp'], text: 'Callee-saved (v8); the frame pointer with -fno-omit-frame-pointer, otherwise an ordinary variable register.' },
    { names: ['r12', 'ip'], text: 'Intra-procedure-call scratch: caller-saved, and linker veneers may clobber it between a bl and its target.' },
    { names: ['r13', 'sp'], text: 'Stack pointer, 8-byte aligned at every call boundary. Cortex-M banks two: MSP for handlers and boot, PSP for threads (FreeRTOS tasks).' },
    { names: ['r14', 'lr'], text: 'Link register: bl and blx write the return address here. In an exception handler it holds EXC_RETURN instead.' },
    { names: ['r15', 'pc'], text: 'Program counter. Reads as the current instruction address + 4; ldr Rt, [pc, #off] addresses the literal pool.' },
    { names: ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 's12', 's13', 's14', 's15'],
      text: 'Single-precision FP register. s0..s15 carry FP arguments and results under the hard-float ABI and are caller-saved; s0 is the FP return value.' },
    { names: ['s16', 's17', 's18', 's19', 's20', 's21', 's22', 's23', 's24', 's25', 's26', 's27', 's28', 's29', 's30', 's31'],
      text: 'Single-precision FP register, callee-saved: a function using it saves it with vpush.' },
    { names: ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'],
      text: 'Double-precision FP register, the pair s(2n):s(2n+1). d0..d7 carry double arguments and results and are caller-saved.' },
    { names: ['d8', 'd9', 'd10', 'd11', 'd12', 'd13', 'd14', 'd15'],
      text: 'Double-precision FP register, callee-saved. FPv5-D16 stops at d15.' },
    { names: ['fpscr'], text: 'FP status and control: the N Z C V result of vcmp, the rounding mode, flush-to-zero, and the sticky exception flags.' },
    { names: ['apsr', 'apsr_nzcv'], text: 'Application status: N Z C V, Q (saturation) and the GE[3:0] SIMD flags. APSR_nzcv as a vmrs target copies the FP compare flags in.' },
    { names: ['ipsr'], text: 'Interrupt status: the active exception number, 0 in thread mode.' },
    { names: ['epsr'], text: 'Execution status: the Thumb bit and the IT/ICI continuation state.' },
    { names: ['xpsr', 'psr'], text: 'APSR, IPSR and EPSR combined; the word stacked on exception entry.' },
    { names: ['primask'], text: 'Bit 0 set masks every configurable-priority exception. cpsid i sets it, cpsie i clears it.' },
    { names: ['faultmask'], text: 'Bit 0 set masks everything except NMI; cleared automatically on exception return.' },
    { names: ['basepri'], text: 'Masks exceptions whose priority value is greater than or equal to it (0 disables the mask). FreeRTOS critical sections write it.' },
    { names: ['control'], text: 'Bit 0 nPRIV (unprivileged thread mode), bit 1 SPSEL (thread mode uses PSP), bit 2 FPCA (FP context active, lazy stacking).' },
    { names: ['msp'], text: 'Main stack pointer: the handler and boot stack.' },
    { names: ['psp'], text: 'Process stack pointer: the thread stack, one per task.' },
];

const REGISTER_INDEX = new Map<string, RegisterEntry>();
for (const entry of REGISTERS) {
    for (const name of entry.names) {
        REGISTER_INDEX.set(name, entry);
    }
}

function lookupRegister(name: string): string | undefined {
    const entry = REGISTER_INDEX.get(name.toLowerCase());
    if (!entry) {
        return undefined;
    }

    const aliases = entry.names.length <= 2 ? entry.names.filter(n => n !== name.toLowerCase()) : [];
    return `**${name}**${aliases.length ? ` (${aliases.join(', ')})` : ''}: ${entry.text}`;
}

// ------------------------------------------------------------------------------
// Cheat sheet document
// ------------------------------------------------------------------------------

function cheatSheet(): string {
    const out: string[] = [];
    out.push('# ARM Thumb-2 cheat sheet');
    out.push('');
    out.push('ARMv7E-M as Cortex-M7 executes it, with the FPv5-D16 floating-point unit, in the spelling GNU objdump prints.');
    out.push('');
    out.push('## Reading a listing');
    out.push('');
    out.push('| Notation | Meaning |');
    out.push('| --- | --- |');
    out.push('| `add.w`, `b.n` | Encoding width: .n 16-bit, .w 32-bit. The assembler picks .w for range, high registers or wide immediates. |');
    out.push('| `adds`, `lsls` | Trailing s: the instruction updates the APSR flags N Z C V. |');
    out.push('| `bne`, `moveq` | Condition suffix, see the table below. On a non-branch it comes from an IT block. |');
    out.push('| `it`, `ite`, `itete` | If-Then: makes the next 1..4 instructions conditional; T = on the condition, E = on its inverse. |');
    out.push('| `vadd.f32`, `vcvt.f32.s32` | Data types; for vcvt the destination type comes first. |');
    out.push('| `[Rn, #imm]` | Address Rn + imm, Rn unchanged. |');
    out.push('| `[Rn, #imm]!` | Pre-indexed: address Rn + imm, then Rn = Rn + imm. |');
    out.push('| `[Rn], #imm` | Post-indexed: address Rn, then Rn = Rn + imm. |');
    out.push('| `[Rn, Rm, lsl #2]` | Scaled register offset: Rn + (Rm << 2), array indexing. |');
    out.push('| `{r4, r5, lr}`, `sp!` | Register list; ! writes the final address back to the base. |');
    out.push('| `@ 0xec` | objdump\'s hexadecimal of a decimal immediate. |');
    out.push('| `<sym+0x46>` | The symbol a branch or literal address resolves to. |');
    out.push('| `.word 0x...` | Data inside the text section: literal pool or jump table. |');
    out.push('');
    out.push('## Condition codes');
    out.push('');
    out.push('| Suffix | Runs when |');
    out.push('| --- | --- |');
    for (const [cond, text] of Object.entries(CONDITIONS)) {
        out.push(`| ${cond} | ${text} |`);
    }
    out.push('');
    out.push('## Registers (AAPCS, hard float)');
    out.push('');
    out.push('| Register | Role |');
    out.push('| --- | --- |');
    for (const entry of REGISTERS) {
        const label = entry.names.length <= 2 ? entry.names.join(', ') : `${entry.names[0]}..${entry.names[entry.names.length - 1]}`;
        out.push(`| ${label} | ${entry.text} |`);
    }
    for (const [title, table] of GROUPS) {
        out.push('');
        out.push(`## ${title}`);
        out.push('');
        out.push('| Mnemonic | Syntax | Effect |');
        out.push('| --- | --- | --- |');
        for (const [mnemonic, entry] of Object.entries(table)) {
            out.push(`| ${mnemonic} | \`${entry.syntax}\` | ${entry.text} |`);
        }
    }
    out.push('');

    return out.join('\n');
}

export const ARM: Isa = {
    id: 'arm-thumb2',
    name: 'ARM Thumb-2',
    instruction: lookupInstruction,
    register: lookupRegister,
    cheatSheet,
};
