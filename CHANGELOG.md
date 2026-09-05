# Change Log

## 0.2.0 - 2026-09-05

- ARM Thumb-2 cheat sheet: mnemonic and register hovers in listings, and a
  rendered reference document.
- Byte costs gain a toggle (Ctrl+Alt+B), a metric setting, and a style
  setting: inline text, a native inlay hint, or a gutter bar.
- istari.toolchains names an objdump per architecture; the error for a
  missing tool names the architecture and the setting.
- Listing language comes from the .dis path; no more document swapping.
- Listing headers show workspace-relative paths; the follow highlight uses
  theme colours with a left border.
- Package renamed to istari-elf for the Marketplace.

## 0.1.0 - 2026-09-05

- Rewrite over GNU objdump: per-function listings with inline chains,
  per-line byte costs in source editors, cursor following both ways,
  go-to-definition on branch targets.
