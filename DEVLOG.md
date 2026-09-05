# Istari devlog

## 2026-09-05 - bringing it back

### Where things stood

Three attempts at the same idea existed, none usable:

- istari (Oct 2025, this repo, never committed). A yo-code scaffold with a
  webview: objdump -d -S -l piped through a regex parser, first 500
  instructions rendered as HTML, no linking between the panes. The CSS lived
  outside localResourceRoots so it never loaded; the per-line map was lost in
  postMessage serialisation; objdump was hardcoded; emoji everywhere.
  Verdict: keep the build scaffold (esbuild, tsconfig, eslint), rewrite src.
- elf-source-view (Jan 2026, ~/projects/elf-source-view, no git). Native
  editor approach: a virtual asm document, C++ reference provider, cost
  decorations after the source lines, a highlight in the asm pane. Backed by
  asm-source-map, a Rust gimli tool emitting an 11 MB JSON. The direction was
  right and the owner liked it ("demangling the c++ names in disasm - inline
  costs YESSSSS"). It broke on: one 140k-line document for the whole image
  with O(n) address lookups per highlight, file matching by basename only,
  no inlining awareness so a header line inlined into forty functions was one
  flat list, and a Rust binary that had to be built and found on PATH.
  Verdict: keep the UX ideas, drop the JSON round trip and the Rust build.
- asm-source-map (Rust). Line table from gimli, disassembly from objdump
  anyway, no inline chains. Superseded by reading objdump's own --inlines
  output.

### The target

WPX_CPU_APP-mc-devel: STM32F777 firmware, C++23, GCC 15.2, -Os -g3
-gdwarf-5, heavy templates and coroutines. app1 image: 222 KB of .text,
1518 function symbols, 184 source files in the line table, 14 MB ELF of
which 7 MB is .debug_info. objdump -d -l --inlines -C over the whole image is
0.44 s and 36 MB of text; nm -S another 0.05 s. The build already emits a
174k-line objdump -S listing per image, which is what the owner has been
grepping through by hand (i2c.dis in the project root is one such extract).

The question that started all this, verbatim from January: "you think you
could dig in the assembly of the trampolines? i dont get what is eating
flash there". So the primary job is flash-cost attribution to source lines
in a template-heavy -Os build, and the secondary job is reading one
function's codegen with the source alongside.

### Design

Native editors, no webview. The listing is a real text document (search,
selection, split, minimap for free); the source is the user's own editor
with clangd intact. Linking happens through decorations and commands, the
same shape as Compiler Explorer and as the January attempt, and what the
owner asked for then: "the source view be the master for navigating assembly
when in focus and vice versa".

One document per function, not one per image. Reading codegen is a
per-function activity; a 4 KB document is instant to render, search and
decorate. Cross-function movement goes through branch targets (Ctrl+click)
and the function picker.

objdump is the only backend. -d -l --inlines -C gives instructions, the
innermost file:line, the inline chain with call sites, and demangled labels
in one pass; nm -S gives sizes; c++filt demangles the chain names objdump
leaves mangled. No DWARF parsing of our own, nothing to build, and the tools
are already installed wherever the firmware builds. The parse runs once per
image and again when the ELF changes on disk.

Inclusive cost is the default. A call-site line owns every byte inlined
through it, which is the number that answers "what is eating flash". The
exclusive count and the per-function split are one hover away.

Marker format: outermost call site first, function names shortened to their
qualified name, the file elided when it repeats, source text after a bar.
This reads along the call structure and stays on one line; objdump's own
--inlines layout spends four lines per instruction on the same information.

Multiple targets use a QuickPick, sorted by bytes contributed, rather than
the references view: the usual case is "which copy do I want to look at",
and a pick is one keystroke.

### Open for feedback

- Marker density and format. Too much per line? Should the chain hide behind
  the hover once the source text is present?
- Follow behaviour: passive following on every cursor move, or only on the
  explicit command? Should the mark persist when the cursor lands on a line
  without code?
- Keybinding: Ctrl+Alt+A, since Ctrl+Shift+A is VS Code's block comment.
- Cost levels: the colour thresholds are 8/32/128 bytes, chosen blind.
- A size-sorted function tree in the sidebar, grouped by file, for browsing
  what is large. The picker covers the search case for now.
- Raw instruction bytes in the listing, off for now.

### Known gaps

- findFile accepts a basename-only match, so a same-named file from another
  tree can pair with the wrong image file. The image's absolute paths make
  this rare; see the TODO in image.ts.
- Source edits since the build shift line numbers; nothing warns yet.
- Only GNU objdump output is parsed. llvm-objdump has no --inlines.
- Packaging: out/ holds both the esbuild bundle and tsc's per-module output
  from compile-tests; .vscodeignore only trims the test folders.

## 2026-09-05 - first feedback round

Cost hover was unreadable without explanation ("how do i read this?"). It now
says what the number is in words and, per host function, at how many call
sites the line's code arrived. The example that prompted it: the one-line
outcome<T> destructor costs 3.7 KB in 143 functions because GCC keeps
reset() out of line per instantiation and inlines only the call shell, once
per scope exit. Together with the outcome<void> twin that is about 5% of
.text. The out-of-line callees a line invokes are still invisible in the
hover; that is the next cost feature.

Endless "document NOT found" errors in the dev host. Cause: the language of
a listing was forced with setTextDocumentLanguage from an onDidOpen hook;
the definition preview on Ctrl+hover opens the target document in the
background, the hook swapped it, the preview reopened it, and so on. Fixed
by declaring the language on a file extension: listing URIs end in .dis,
cheat sheets in .md, and no code touches the language anymore. The user's
own i2c.dis extract now opens with the listing grammar as a side effect.

Cheat sheet, requested as "super great to have built in". Hovering a
mnemonic shows its entry; the lookup normalises objdump's spelling (width
suffix, data types, IT pattern, condition, flag-setting s) and lists what
each suffix means. Hovering a register shows its AAPCS role. A command
renders the whole table as a markdown preview. The unit test checks that
every mnemonic in the WPX image has an entry, so the table cannot silently
fall behind the code it is meant to explain.

Keybinding is Ctrl+Alt+A; Ctrl+Shift+A collided with the user's vim plugin.
The old ELF Source View extension was uninstalled.

### Marketplace identity

The Marketplace keeps bare extension names unique across publishers and
pi314mm.istari already exists, so the package name is istari-elf; the id is
nohous.istari-elf. Display name, commands, settings and the repository keep
the plain name.

### README media

The frames are captured, not staged: a mocha suite under the screenshots
label drives the extension in a headless VS Code on the WPX workspace and
grabs the Xvfb framebuffer after each step, and ffmpeg assembles the GIF with
a per-file palette. Three traps on the way: Electron follows WAYLAND_DISPLAY
and opened on the desktop until the capture forced X11; the per-user inotify
instance limit of 128 was exhausted by the desktop session and had to be
raised before a second VS Code could start; hovers opened from the keyboard
outlive focus changes and need an Escape keypress.

### Ideas, ranked

1. Build diff. Two images (build vs build-base, which already exists in the
   proving ground): per-function size deltas, new and removed functions,
   per-line cost deltas in the gutter. A second Image plus a join by name.
2. Callees in the cost hover. The out-of-line bl targets reached from a line,
   with sizes and instantiation count, so a destructor shell and the reset()
   bodies it calls read as one cost.
3. Instantiation grouping. A size-sorted tree that folds outcome<X>::reset()
   across X into one row with count and total.
4. Parse in a worker thread so the extension host never stalls on a load.
5. Raw instruction bytes as a listing toggle.
