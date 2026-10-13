# Minimal Tool View

`@caeloren/pi-minimal-tool-view` provides unified minimal rendering for Pi Agent tool calls. In the interactive terminal, collapsed rows show a compact call preview and, when Pi supplies a result, a status summary. Expanded rows delegate to the downstream renderer selected by Pi, normally the native renderer.

Version: **0.1.3**. Compatibility baseline: **Pi Agent 1.2.0**.

This package replaces the need to load the official `minimal-mode.ts` example and a separate codemode-only renderer. It does not bundle or modify the official example and never replaces tool execution.

## Installation

Install from the public GitHub repository:

```bash
pi install git:github.com/caeloren/pi-minimal-tool-view
pi list
```

If Pi is already running, use `/reload` or restart it after installation, updating, or removal.

After a `v0.1.3` tag is published, that exact release can be installed with:

```bash
pi install git:github.com/caeloren/pi-minimal-tool-view@v0.1.3
```

The unpinned command above installs the repository's current default branch. `private: true` prevents accidental npm publication; it does not make the public GitHub repository private or prevent Pi Git installation.

For local testing from a downloaded or cloned copy, use the absolute package directory:

```bash
pi install /absolute/path/to/pi-minimal-tool-view
```

Local sources load from that directory without copying it. Keep it in place until the source is removed from Pi.

## Migration from Earlier Names

Minimal Tool View is the current package name. Earlier development builds were called Better Minimal Mode and, before that, Minimal Mode Plus.

The current public Git source is `git:github.com/caeloren/pi-minimal-tool-view`. Renaming a local archive does not rewrite an existing Pi package declaration.

Use `pi list` to identify any old installation and its exact source, including a tag or local path. Remove only the source actually installed. For an unpinned Git installation, use the corresponding command:

```bash
# Previous name: Better Minimal Mode
pi uninstall git:github.com/caeloren/pi-better-minimal-mode

# Earlier name: Minimal Mode Plus
pi uninstall git:github.com/caeloren/pi-minimal-mode-plus
```

Then install the new source:

```bash
pi install git:github.com/caeloren/pi-minimal-tool-view
```

Run `/reload` or restart Pi afterward. Do not keep old and new packages active together. Manually copied `~/.pi/agent/extensions/better-minimal-mode.ts` and `~/.pi/agent/extensions/minimal-mode-plus.ts` are separate installations; remove or disable those copies separately. Do not delete Pi settings or saved sessions as part of this migration.

## Enable Optional Tools

The package changes rendering only; it does not enable `codemode` or `powershell`. Add desired entries to the existing Pi `defaultTools` setting without overwriting unrelated entries. For example, add `"+codemode"` to enable codemode; a user intentionally selecting PowerShell can use `"-bash"` and `"+powershell"`. Tool configuration and platform requirements remain Pi's responsibility.

## Remove Overlapping Extensions

Do not load this package alongside the standalone official `minimal-mode.ts`, another copy of Minimal Tool View, or a renderer handling the same tool names. Remove the older codemode-only Git package when present:

```bash
pi uninstall git:github.com/caeloren/pi-minimal-codemode
```

Previously copied files such as `~/.pi/agent/extensions/minimal-mode.ts` and `~/.pi/agent/extensions/minimal-codemode.ts` are separate, manually managed installations. Remove or disable those copies separately. This package never deletes another extension for you. Run `/reload` after changes.

## Update and Remove

Update this package, or use the equivalent positional form:

```bash
pi update --extension git:github.com/caeloren/pi-minimal-tool-view
pi update git:github.com/caeloren/pi-minimal-tool-view
```

Reconcile all configured package sources:

```bash
pi update --extensions
```

Updates require access to the configured source; Pi offline mode skips package updates. An unpinned Git source follows its configured branch. Tags and commits stay pinned; updating does not select a different tag. To change refs, explicitly install the desired source. Use `pi list` to inspect the configured source. `pi update --extension` requires a source; bare `pi update` updates Pi itself rather than this package.

Remove using the configured source shown by `pi list`:

```bash
pi uninstall git:github.com/caeloren/pi-minimal-tool-view
```

`pi remove <source>` is equivalent. Include the ref or local path when applicable. After removal, reload or restart a running Pi process. Pi removes its managed Git checkout and package declaration, not your local development folder, manual copies, saved sessions, or remote GitHub repository. Other installations/scopes must be removed separately.

## Supported Scope

The package handles exactly these tool names:

```text
read
bash
powershell
write
edit
find
grep
ls
codemode
```

Other names, including `tool_search`, MCP tools, and typical third-party tools, pass through unchanged. Matching is by tool name, not by the tool author's identity: a third-party extension that redefines one of these nine names overlaps with this package.

**Not every dollar-prefixed block is a Bash tool call.** User-entered `!command` and `!!command` use Pi's separate user-shell component and are not minimized. Dollar-prefixed text in ordinary messages, code blocks, and thinking is also unchanged. This package does not intercept user input or add commands.

## Collapsed Display

Examples below illustrate formatting; counts and durations are not fixed values.

### Bash and PowerShell

While arguments are incomplete and no final result is available, the preview is `$ ...` or `PS> ...`. After arguments complete, a short single-line command is shown in full, without an ellipsis:

```text
$ git diff
→ completed · 97ms

PS> Get-ChildItem
→ completed · 97ms
```

A multiline command shows the first meaningful line with `...` when more nonblank content follows. Leading whitespace and leading blank lines are omitted. Trailing blank lines alone do not add an ellipsis.

```text
$ node <<'NODE' ...
→ completed · 384ms

PS> $items = Get-ChildItem ...
→ completed · 1.4s
```

An overlong single-line preview is truncated to the current available terminal cell width, reserving space for `...`. Resizing recomputes the truncation. Extremely narrow widths may clip even the prefix or ellipsis. Tabs are displayed as three spaces; this is a display normalization, not shell parsing or execution.

Once a final result exists, its saved command is previewed whether it succeeded or failed and whether or not Pi recorded a duration. This also applies to rows reconstructed after `/reload` or session resume. Final rows with a missing or non-string `command` show `[invalid command]`; empty or whitespace-only commands use `...`. The preview does not assert that the command has valid shell syntax.

Bash and PowerShell do not show a command count. The package does not parse pipelines, heredocs, script blocks, loops, or shell operators to infer execution counts.

### File and Search Tools

```text
read src/index.ts:10-14
→ completed · 12ms

write src/index.ts (24 lines)
→ completed · 8ms

edit src/index.ts
→ completed · 21ms

find *.ts in src (limit 100)
→ completed · 31ms

grep /TODO/ in src (*.ts) limit 10
→ completed · 24ms

ls src
→ completed · 9ms
```

Paths, patterns, optional ranges, globs, and limits summarize the supplied arguments. A requested range or limit is not a guarantee about the returned data. Long previews are constrained to one display line.

The `write` line count is calculated from the structured `content` argument, not by reading the destination file. LF, CRLF, and CR line endings are recognized. A final line terminator closes the last line rather than adding another empty line. Empty content omits the count.

Pi 1.2.0 does not supply authoritative complete result counts for `find`, `grep`, or `ls` to this renderer. The package therefore does not parse human-readable output to guess files, matches, or entries.

Collapsed `edit` rows retain Pi's self-rendered framing mode and use its public theme colors and `outputPad` setting. Expanded diffs remain native.

### Codemode

```text
codemode
→ completed · 4 calls · 1 failed · 1 cancelled · 1.8s
```

The overall status describes the outer codemode result. A script can handle a nested failure and still finish successfully, so `completed` and a nested failure count can legitimately appear together.

Counts are shown only when `details.calls` is an array whose entries all have recognized statuses. A valid empty array means `0 calls`. Missing, malformed, unknown-status data, or a final result containing a still-`running` entry suppresses the entire call summary rather than presenting a guessed total. Partial results may include running calls.

Nested `tools.bash()` and other tool calls remain inside the codemode block; they do not become separate minimal rows.

### Result Status and Duration

- Before Pi supplies any result, there is no second row.
- Partial results show `running`. Tools that emit no partial result keep only their call row until completion.
- Successful final results show `completed`; error results show `failed`.
- A valid, finite, nonnegative final `durationMs` is formatted as milliseconds, seconds, minutes, or hours. Missing or invalid durations are omitted, not replaced with zero.

Pi 1.2.0 does not expose live elapsed time through `durationMs`; collapsed running rows have no live timer. It also does not expose a distinct top-level cancellation flag to tool renderers. Top-level cancellation reported as an error therefore shows `failed`. Structured nested codemode cancellations remain countable. The package does not guess cancellation from error text.

## Expanded Display and Export Boundaries

Use Pi's normal expand action, **Control + O** by default. The package delegates the expanded view to the downstream renderer. Without another overlapping extension, this is Pi's native renderer. Commands, file content, diffs, codemode source, nested calls, errors, and output notices remain subject to Pi's normal rendering and truncation limits.

**HTML export is not equivalent to the interactive terminal.** Pi 1.2.0 uses its own HTML templates for some built-in tools, including `bash`, `read`, `write`, `edit`, and `ls`, bypassing this extension's rendering for those rows. For tools routed through the extension renderer, the exporter renders the call heading once in collapsed mode and generates collapsed/expanded variants only for the result. An expanded HTML result therefore does not guarantee that a truncated PowerShell command or the full codemode JavaScript will become visible. Session arguments are not changed or deleted. The package does not patch the exporter.

**Images are handled separately by Pi.** With inline images enabled, image content may remain visible while a tool is collapsed. The package does not remove images or change global image settings.

## Compatibility and Verification

The public API baseline is Pi Agent 1.2.0. Only the root exports of `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are used. A supported tool without both call and result renderers is passed through unchanged.

PowerShell display support applies when Pi's `powershell` tool is enabled. Git Bash uses the `bash` renderer. Pi remains responsible for shell availability and command execution. Validation for this release runs on the official Linux x64 Pi executable; it is not native macOS or Windows execution certification.

After a Pi update, check the public renderer contracts, all nine tools, shell truncation, error results without duration, restored sessions, native expansion, reload, and package install/update/remove before claiming compatibility. Change only code affected by a demonstrated issue. This four-file package intentionally ships no separate test framework, CI workflow, or background compatibility checker.

## Design and Data Protection

Only one public tool-renderer resolver is registered. The package does not execute or replace tools, change arguments/results/prompts/model context/loadouts/sessions, parse shell syntax, read or write files/settings/credentials, use the network, or read environment variables. It creates no subprocesses, workers, timers, or persistent user data.

Small per-row in-memory components and a transient renderer-state marker are used. If a native renderer was expanded during execution and then collapsed, its final result is forwarded off-screen to let that renderer clean up its own transient resources. The package does not manipulate private timer fields or create a timer itself.

Collapsed previews strip terminal escape sequences, replace control and bidirectional formatting characters, and normalize tabs. This is display-only sanitization, **not secret redaction**. Paths, patterns, and the visible command prefix may contain sensitive data, and the full underlying content remains in Pi's normal runtime/session data. Expanded content follows the downstream renderer's own safeguards.

## Changes in 0.1.3

- Keep width-truncation ellipses in the same text style as the truncated preview without clearing Pi's outer tool-row background.
- Update installation and migration wording for the repository's current public state.

## Changes in 0.1.2

- Rename the distribution to Minimal Tool View, including its package name, entry file, factory names, and intended GitHub source. The rendering implementation is unchanged by the rename.
- Process newline-containing whitespace runs in linear time, avoiding repeated scans of long space-only input.
- Preview multiline shell commands without splitting the entire script into a line array.
- Derive tool-name and codemode-status types from their existing sets.
- Share single-line component code while preserving distinct call/result component identities.

Display rules, supported tools, downstream rendering, transient-resource cleanup, and data boundaries are unchanged. Test helpers and reports are kept outside this four-file package.

## License

Copyright (c) 2026 caeloren. Sustainable Use License 1.0 (`SUL-1.0`). The unmodified full terms are in [LICENSE](LICENSE).
