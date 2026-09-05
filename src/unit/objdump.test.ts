import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { test } from 'node:test';
import { Image } from '../image';
import { ARM } from '../isa/arm';
import { renderListing, shortName, targetAt } from '../listing';
import { parseDisassembly, parseSymbolSizes } from '../objdump';
import { loadImage, resolveTools } from '../toolchain';

const SAMPLE = [
    '',
    'build/x.elf:     file format elf32-littlearm',
    '',
    '',
    'Disassembly of section .text:',
    '',
    '08070ff4 <Tpx2Row::powerUp(Tpx2Row::RowSet&)>:',
    'Tpx2Row::powerUp(Tpx2Row::RowSet&):',
    '/ws/src/AppDrivers/Tpx2Row.cpp:243',
    ' 8070ff4:\tstmdb\tsp!, {r4, r5, r6, r7, r8, r9, sl, fp, lr}',
    'std::span<Tpx2Row::Step const, 4294967295u>::end() const:',
    '/tc/include/c++/15.2.1/span:333 (discriminator 1)',
    'inlined by /ws/src/AppDrivers/Tpx2Row.cpp:226 (bringUp)',
    'inlined by /ws/src/AppDrivers/Tpx2Row.cpp:244 (_ZN7Tpx2Row7powerUpERNS_6RowSetE)',
    ' 8070ff8:\tldrd\tr3, r2, [r1, #232]\t@ 0xe8',
    'Tpx2Row::powerUp(Tpx2Row::RowSet&):',
    '/ws/src/AppDrivers/Tpx2Row.cpp:243',
    ' 8070ffc:\tmov\tr8, r1',
    'inlined by /ws/src/AppDrivers/Tpx2Row.cpp:226 (bringUp)',
    'inlined by /ws/src/AppDrivers/Tpx2Row.cpp:244 (_ZN7Tpx2Row7powerUpERNS_6RowSetE)',
    ' 8070ffe:\tmovs\tr1, #24',
    ' 8071000:\tbl\t8075518 <vTaskDelay>',
    '\t...',
    '',
    '08075518 <vTaskDelay>:',
    'vTaskDelay():',
    '/ws/FreeRTOS/tasks.c:1500',
    ' 8075518:\tbx\tlr',
    '',
].join('\n');

function sampleImage(): Image {
    const image = new Image('/ws/build/x.elf', 0, 0x28);
    parseDisassembly(SAMPLE, image, parseSymbolSizes('08070ff4 00000010 T Tpx2Row::powerUp(Tpx2Row::RowSet&)\n08075518 00000002 T vTaskDelay\n'));
    image.finish();
    return image;
}

test('functions, instructions and chains from the sample', () => {
    const image = sampleImage();

    assert.equal(image.fns.length, 2);
    const fn = image.fns[image.fnNamed('Tpx2Row::powerUp(Tpx2Row::RowSet&)')];
    assert.equal(fn.addr, 0x8070ff4);
    assert.equal(fn.size, 0x10);
    assert.equal(fn.end - fn.first, 5);
    assert.equal(image.files[image.locs[fn.loc].file], '/ws/src/AppDrivers/Tpx2Row.cpp');
    assert.equal(image.locs[fn.loc].line, 243);

    const [first, second, third, fourth, fifth] = image.instrs.slice(fn.first, fn.end);
    assert.equal(first.size, 4);
    assert.equal(first.chain, -1);
    assert.equal(first.text, 'stmdb    sp!, {r4, r5, r6, r7, r8, r9, sl, fp, lr}');
    assert.equal(second.text, 'ldrd     r3, r2, [r1, #232]  @ 0xe8');
    assert.equal(image.chains[second.chain].length, 2);
    assert.equal(image.names[image.chains[second.chain][0].fn], 'bringUp');
    assert.equal(image.names[second.scope], 'std::span<Tpx2Row::Step const, 4294967295u>::end() const');
    assert.equal(third.chain, -1);
    assert.equal(image.locs[fourth.loc].line, 243);
    assert.equal(fourth.chain, second.chain);
    assert.equal(fifth.size, 4);
    assert.equal(image.fnContaining(0x8071002), image.fnNamed('Tpx2Row::powerUp(Tpx2Row::RowSet&)'));
    assert.equal(image.fnContaining(0x8075518), image.fnNamed('vTaskDelay'));
});

test('costs attribute inlined bytes to the call site', () => {
    const image = sampleImage();
    const file = image.findFile('/ws/src/AppDrivers/Tpx2Row.cpp');
    const line244 = image.costOf(image.locAt(file, 244))!;
    const line243 = image.costOf(image.locAt(file, 243))!;
    const span = image.costOf(image.locAt(image.findFile('/tc/include/c++/15.2.1/span'), 333))!;

    assert.equal(line244.exclusive, 0);
    assert.equal(line244.inclusive, 4 + 2);
    assert.equal(line243.exclusive, 4 + 2 + 2 + 4);
    assert.equal(line243.inclusive, line243.exclusive);
    assert.equal(span.exclusive, 4);
    assert.equal(span.inclusive, 4);
    assert.equal([...line244.fns.keys()].length, 1);
});

test('findFile matches by path suffix', () => {
    const image = sampleImage();
    assert.equal(image.findFile('/elsewhere/src/AppDrivers/Tpx2Row.cpp'), image.findFile('/ws/src/AppDrivers/Tpx2Row.cpp'));
    assert.equal(image.findFile('/elsewhere/other.cpp'), -1);
});

test('listing text carries markers with outermost-first chains', () => {
    const image = sampleImage();
    const listing = renderListing(image, image.fnNamed('Tpx2Row::powerUp(Tpx2Row::RowSet&)'), {
        sourceText: true,
        sourceLine: (file, line) => (file.endsWith('span') && line === 333) ? '    return _M_ptr + size();' : undefined,
    });
    const lines = listing.text.split('\n');

    assert.equal(lines[0], ';; Tpx2Row::powerUp(Tpx2Row::RowSet&)');
    assert.equal(lines[1], ';; x.elf  0x08070ff4  16 bytes  /ws/src/AppDrivers/Tpx2Row.cpp:243');
    assert.equal(lines[3], '; Tpx2Row.cpp:243');
    assert.equal(lines[4], '  8070ff4:  stmdb    sp!, {r4, r5, r6, r7, r8, r9, sl, fp, lr}');
    assert.equal(lines[5], '; Tpx2Row.cpp:244 > bringUp :226 > std::span::end span:333  |  return _M_ptr + size();');
    assert.equal(listing.addrLine.get(0x8070ff8), 6);
    assert.equal(listing.lines[6].instr, image.fns[listing.fn].first + 1);
    assert.equal(listing.lines[5].instr, -1);
    assert.equal(listing.lines[5].chain, listing.lines[6].chain);
});

test('shortName strips templates, parameters, return types and lambdas', () => {
    assert.equal(shortName('Tpx2Row::powerUp(Tpx2Row::RowSet&)'), 'Tpx2Row::powerUp');
    assert.equal(shortName('std::span<Tpx2Row::Step const, 4294967295u>::end() const'), 'std::span::end');
    assert.equal(shortName('aftl::time::duration<unsigned long, aftl::time::rational_period<1ll, 1000ll> > aftl::time::duration_cast<aftl::time::duration<unsigned long, aftl::time::rational_period<1ll, 1000ll> >, long, aftl::time::rational_period<1ll, 1000ll> >(aftl::time::duration<long, aftl::time::rational_period<1ll, 1000ll> > const&)'), 'aftl::time::duration_cast');
    assert.equal(shortName('Application::consoleTask()::{lambda()#1}::operator()() const'), 'Application::consoleTask::lambda#1::operator()');
    assert.equal(shortName('aftl::buffer_ref::operator=(aftl::buffer_ref&&) [clone .isra.0]'), 'aftl::buffer_ref::operator= [clone .isra.0]');
    assert.equal(shortName('(anonymous namespace)::helper(int)'), '(anonymous namespace)::helper');
    assert.equal(shortName('bool aftl::operator<(aftl::a const&, aftl::a const&)'), 'aftl::operator<');
    assert.equal(shortName('vTaskDelay'), 'vTaskDelay');
    assert.equal(shortName('_ZN4aftl2osE'), '_ZN4aftl2osE');
});

test('targetAt finds the branch target under the cursor', () => {
    const line = '  8071030:  bl       8070a2c <Tpx2Row::setChipIo(Tpx2Row::ChipIo&, bool)>';
    assert.equal(targetAt(line, line.indexOf('setChipIo')), 0x8070a2c);
    assert.equal(targetAt(line, 3), undefined);
    const nested = '  8071014:  bne.n    807103a <aftl::foo<int>::bar()+0x46>';
    assert.equal(targetAt(nested, nested.length - 2), 0x807103a);
});

const WPX_ELF = process.env.ISTARI_TEST_ELF
    ?? '/home/nohous/projects/advacam/src/WPX_CPU_APP-mc-devel/build/wpxTpx2_app1_0x08040000.elf';

test('ARM mnemonics normalise to a table entry with suffix notes', () => {
    const b = ARM.instruction('bls.n')!;
    assert.equal(b.mnemonic, 'b');
    assert.ok(b.notes.some(n => n.startsWith('.n:')));
    assert.ok(b.notes.some(n => n.startsWith('ls:')));
    assert.equal(ARM.instruction('movs')!.mnemonic, 'mov');
    assert.ok(ARM.instruction('movs')!.notes[0].startsWith('s:'));
    assert.equal(ARM.instruction('bl')!.mnemonic, 'bl');
    assert.equal(ARM.instruction('bics.w')!.mnemonic, 'bic');
    assert.equal(ARM.instruction('lsls')!.mnemonic, 'lsl');
    assert.equal(ARM.instruction('teq')!.mnemonic, 'teq');
    assert.equal(ARM.instruction('mls')!.mnemonic, 'mls');
    assert.equal(ARM.instruction('strhne')!.mnemonic, 'strh');
    assert.equal(ARM.instruction('ldmia.w')!.mnemonic, 'ldmia');
    assert.equal(ARM.instruction('stmdb')!.mnemonic, 'stmdb');
    assert.equal(ARM.instruction('vstmdbeq')!.mnemonic, 'vstmdb');
    assert.equal(ARM.instruction('vselgt.f32')!.mnemonic, 'vsel');
    const cvt = ARM.instruction('vcvt.f32.s32')!;
    assert.equal(cvt.mnemonic, 'vcvt');
    assert.ok(cvt.notes[0].includes('destination is a single-precision float'));
    assert.ok(cvt.notes[1].includes('source is a signed 32-bit integer'));
    assert.equal(ARM.instruction('itete')!.mnemonic, 'it');
    assert.ok(ARM.instruction('itete')!.notes[0].startsWith('4 conditional'));
    assert.equal(ARM.instruction('.word')!.mnemonic, '.word');
    assert.equal(ARM.instruction('nonsense'), undefined);
    assert.equal(ARM.instruction('<UNDEFINED>'), undefined);
});

test('ARM registers resolve by alias', () => {
    assert.ok(ARM.register('sl')!.startsWith('**sl** (r10)'));
    assert.ok(ARM.register('r0')!.includes('return value'));
    assert.ok(ARM.register('s16')!.includes('callee-saved'));
    assert.ok(ARM.register('APSR_nzcv')!.includes('vmrs'));
    assert.equal(ARM.register('bringUp'), undefined);
    assert.ok(ARM.cheatSheet().includes('| udiv |'));
});

test('every mnemonic of the WPX image has a cheat sheet entry', { skip: !fs.existsSync(WPX_ELF) && 'no WPX ELF on this machine' }, async () => {
    const image = await loadImage(WPX_ELF, await resolveTools(WPX_ELF, ''));
    const missing = new Set<string>();
    for (const ins of image.instrs) {
        const mnemonic = ins.text.split(' ')[0];
        if (!ARM.instruction(mnemonic)) {
            missing.add(mnemonic);
        }
    }
    assert.deepEqual([...missing], [], `no entry for: ${[...missing].join(' ')}`);
});


test('loads the WPX firmware image end to end', { skip: !fs.existsSync(WPX_ELF) && 'no WPX ELF on this machine' }, async () => {
    const started = Date.now();
    const tools = await resolveTools(WPX_ELF, '');
    const image = await loadImage(WPX_ELF, tools);
    const elapsed = Date.now() - started;

    assert.ok(image.fns.length > 1000, `functions: ${image.fns.length}`);
    assert.ok(image.instrs.length > 50000, `instructions: ${image.instrs.length}`);
    assert.ok(image.files.length > 100, `files: ${image.files.length}`);

    const fnIdx = image.fnNamed('Tpx2Row::powerUp(Tpx2Row::RowSet&)');
    assert.ok(fnIdx >= 0);
    assert.equal(image.fnStartingAt(image.fns[fnIdx].addr), fnIdx);
    assert.equal(image.fns[fnIdx].size, 0x480);

    const listing = renderListing(image, fnIdx, { sourceText: false, sourceLine: () => undefined });
    assert.ok(listing.text.includes('; Tpx2Row.cpp:244 > bringUp :226 > std::span::end span:333'), listing.text.split('\n').slice(0, 12).join('\n'));

    const file = image.findFile('/home/nohous/projects/advacam/src/WPX_CPU_APP-mc-devel/src/AppDrivers/Tpx2Row.cpp');
    assert.ok(file >= 0);
    const cost = image.costOf(image.locAt(file, 244))!;
    assert.ok(cost.inclusive > cost.exclusive, `244: ${cost.inclusive} vs ${cost.exclusive}`);

    const mangledLeft = image.names.filter(n => n.startsWith('_Z')).length;
    console.log(`WPX: ${image.fns.length} fns, ${image.instrs.length} instrs, ${image.files.length} files, `
        + `${image.locs.length} locs, ${image.chains.length} chains, ${mangledLeft} undemangled names, ${elapsed} ms`);
});
