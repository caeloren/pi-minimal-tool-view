# Minimal Tool View

## Introduction

`@caeloren/pi-minimal-tool-view` provides compact collapsed views for Pi Agent tool calls while preserving Pi's downstream, normally native, expanded views.

### Demo

https://github.com/user-attachments/assets/b7fbd71c-fc77-45b7-8d63-8b074c5828e8

Version: **0.4.1**  
Requires **Pi Agent 1.3.0 or later**.

Supported tool names:

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
tool_search
list_mcp_resources
list_mcp_resource_templates
read_mcp_resource
```

The extension changes rendering only. It does not execute or replace tools, modify tool arguments or results, alter prompts or sessions, access files or the network, or persist package-owned user data.

## Usage

### Install

```bash
pi install git:github.com/caeloren/pi-minimal-tool-view
pi list
```

If Pi is already running, use `/reload` or restart Pi after installation.

> **Important:** Do not load this package together with the official `minimal-mode.ts`, another copy of Minimal Tool View, or any extension that renders the same tool names. Remove overlapping extensions and run `/reload`.

### Enable optional tools

Pi enables `read`, `bash`, `edit`, and `write` by default. Select `grep`, `find`, `ls`, `codemode`, `tool_search`, or `powershell` when needed; this extension does not enable tools. Pi's MCP extension may enable `codemode` or `tool_search` when a connected server needs them. Merge additions into your existing `defaultTools` without removing unrelated entries.

Pi makes the three MCP resource tools available according to connected, enabled resource servers and their exposure settings. This extension does not connect servers or register, activate, or execute those tools.

For example, add search tools, Codemode, and tool discovery:

```json
{
  "defaultTools": ["+grep", "+find", "+ls", "+codemode", "+tool_search"]
}
```

Use PowerShell instead of Bash:

```json
{
  "defaultTools": ["-bash", "+powershell"]
}
```

### Display

Examples below show the collapsed format. Counts and durations are illustrative.

```text
$ git diff
→ completed · 97ms

$ node <<'NODE' ...
→ completed · 384ms

PS> Get-ChildItem
→ completed · 97ms

read src/index.ts:10-14
→ completed · 12ms

write src/index.ts (24 lines)
→ completed · 8ms

edit src/index.ts
→ completed · 21ms

codemode
→ completed · 4 calls · 1 failed · 1 cancelled · 1.8s

tool_search github issues
→ completed · 3 tools loaded · 97ms

list_mcp_resources server="docs"
→ completed · 97ms

list_mcp_resource_templates server="docs" cursor="page-2"
→ completed · 97ms

read_mcp_resource server="docs" uri="docs://guide"
→ completed · 97ms
```

Collapsed previews show each tool's selected fields as Pi supplies them: commands, paths, patterns, queries, read ranges, write line counts, and supported glob/limit options. They do not display every tool argument; shell timeouts are visible only in the downstream expanded view. Missing or blank fields stay empty; only the tool name or shell prompt remains when no preview fields are available. No placeholders or inferred paths are added, including `.` for an omitted directory. A literal `.` supplied as a path is still shown. Saved calls without a result retain their saved preview without indicating completion or restarting execution.

Bash and PowerShell previews show the first meaningful line. Generated `...` only indicates omitted content: insufficient display width, or additional nonblank command lines. It never indicates missing input or streaming progress. Other text fields are compacted to one line and truncated only when needed. Nonblank `grep`/`find` patterns retain their leading and trailing whitespace after control-sequence cleanup. Codemode source and edit bodies remain hidden until expanded.

Before Pi supplies a result, only the call preview is shown. Partial results show `running`; successful final results show `completed`; error results show `failed`. Final durations are included when Pi supplies valid values. In live sessions, Bash, PowerShell, and Codemode initialize their downstream timing at execution start, so delayed expansion does not restart the native clock.

`read`, `write`, `edit`, and `ls` path previews are clickable when Pi detects terminal hyperlink support. Links target the full path even when the visible label is truncated; opening behavior and click gestures depend on the terminal. Other environments keep plain text. `write` line counts are derived from the supplied content. Read ranges use Pi's native formatter; search-tool limits accept finite numbers and nonblank numeric strings, while invalid values are omitted.

`find`, `grep`, and `ls` show compact argument previews but do not guess result totals. Codemode call counts are shown only when Pi supplies complete, valid structured call data. `tool_search` shows a single-line query preview and counts tools from valid `details.loaded` data in successful final results. Zero matches is a successful `0 tools loaded`; missing, malformed, or duplicate data omits the count. Searching and loading tools remain entirely Pi's responsibility.

MCP resource previews show supplied, nonblank arguments as `key="value"` pairs using the `muted` theme token: `server` and `cursor` for the list tools, and `server` and `uri` for the read tool. Values are cleaned into one line and JSON-escaped for display; missing fields are omitted. Cursors are not decoded, and URIs are not treated as local paths or made clickable. Results show only the outer call status and valid final duration, not resource counts; aggregate listing errors remain in the detailed output. Saved resource calls remain displayable when their tools are not registered, without connecting or re-executing.

Use Pi's normal expand action, **Control + O** by default, to view details through the downstream renderer, subject to Pi's normal display and truncation limits. In the interactive terminal, `tool_search` and the three MCP resource tools use Pi's generic expanded view when no specialized downstream renderer is present, showing the supplied arguments and available result content.

### Update and remove

Update this package:

```bash
pi update --extension git:github.com/caeloren/pi-minimal-tool-view
```

Update all configured Pi packages:

```bash
pi update --extensions
```

Remove this package:

```bash
pi uninstall git:github.com/caeloren/pi-minimal-tool-view
```

`pi remove <source>` is equivalent to `pi uninstall <source>`. Bare `pi update` updates Pi itself, not this package. If Pi is running, use `/reload` or restart it after updating or removal.

## Notes and limitations

- Only the thirteen exact tool names listed above are minimized, regardless of how they are discovered. Other tool names pass through unchanged. A third-party extension using one of these names overlaps with this package.
- User-entered `!command` and `!!command`, ordinary dollar-prefixed text, code blocks, and thinking content are not Bash tool calls and are not modified.
- Collapsed rows deliberately omit live elapsed displays and do not start periodic timers. Expanded timing and any associated redraw timer belong to the downstream renderer; final minimal summaries use Pi's recorded duration. Pi also does not expose a distinct top-level cancellation flag, so a cancellation reported as an error appears as `failed`.
- Inline images and HTML exports are handled partly by Pi. HTML expansion does not regenerate pre-rendered call headings, so multiline PowerShell commands and Codemode source may stay hidden in the displayed heading. The original commands and code remain in the HTML's embedded session data. Native export timing may measure rendering rather than the original execution; a near-zero `Took` is not a reliable historical duration.
- Minimal previews are not secret redaction. Visible command prefixes, paths, and patterns may contain sensitive information, and the full underlying content remains in Pi's normal runtime and session data.
- PowerShell rendering applies when Pi's `powershell` tool is enabled; Pi remains responsible for shell availability and command execution.
- Licensed under the Sustainable Use License 1.0 (`SUL-1.0`). See [LICENSE](LICENSE).
