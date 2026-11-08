// SPDX-License-Identifier: SUL-1.0
// Copyright (c) 2026 caeloren

import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ExtensionAPI, formatReadLineRange, ToolExecutionComponent, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, getCapabilities, hyperlink, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Conditional MCP resource tools: the only names that get display-only renderers when not registered.
const MCP_RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"] as const;
const SUPPORTED_TOOL_NAMES = new Set([
	"read",
	"bash",
	"powershell",
	"write",
	"edit",
	"find",
	"grep",
	"ls",
	"codemode",
	"tool_search",
	...MCP_RESOURCE_TOOLS,
] as const);
const MCP_RESOURCE_TOOL_NAMES: ReadonlySet<string> = new Set(MCP_RESOURCE_TOOLS);
const GENERIC_TOOL_NAMES: ReadonlySet<string> = new Set(["tool_search", ...MCP_RESOURCE_TOOLS]);

const CODEMODE_STATUSES = new Set(["running", "ok", "error", "cancelled"] as const);
const NATIVE_RENDERER_TOUCHED = Symbol("minimal-tool-view.native-renderer-touched");
const NATIVE_TIMING_PRIMED = Symbol("minimal-tool-view.native-timing-primed");
const EDIT_CALL_COMPONENT = Symbol("minimal-tool-view.edit-call-component");

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
type CompleteToolRenderers = ToolRenderers & { renderCall: RenderCall; renderResult: RenderResult };
type Theme = Parameters<RenderCall>[1];
type RenderContext = Parameters<RenderCall>[2];
type ToolResult = Parameters<RenderResult>[0];
type ToolResultOptions = Parameters<RenderResult>[1];
type SupportedToolName = Parameters<typeof SUPPORTED_TOOL_NAMES.has>[0];
type CodemodeStatus = Parameters<typeof CODEMODE_STATUSES.has>[0];

class MinimalLineComponent implements Component {
	private text = "";
	// Retain only the latest rendered width; setters and explicit invalidation release it.
	private cache: { width: number; lines: string[] } | undefined;

	setText(text: string): void {
		if (this.text !== text) this.invalidate();
		this.text = text;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (this.cache && this.cache.width === width) return this.cache.lines;
		const lines = renderSingleLine(this.text, width);
		this.cache = { width, lines };
		return lines;
	}
}

// Keep distinct identities for Pi's call and result component slots.
class MinimalCallComponent extends MinimalLineComponent {
	// Slot-local cache of the write line count, kept on the reused call component as Pi recommends for data
	// that only one slot uses. A new call component (for example after an expanded view) counts afresh.
	writeLineCount: WriteLineCount | undefined;
}
class MinimalResultComponent extends MinimalLineComponent {}

type BackgroundFn = (text: string) => string;

class MinimalSelfShellLineComponent implements Component {
	private text = "";
	private paddingX = 0;
	private bgFn: BackgroundFn = (text) => text;
	private cache: { width: number; bgSample: string; lines: string[] } | undefined;

	constructor(
		private readonly paddingTop: number,
		private paddingBottom: number,
	) {}

	setBottomPadding(padding: 0 | 1): void {
		if (this.paddingBottom !== padding) this.invalidate();
		this.paddingBottom = padding;
	}

	setContent(text: string, outputPad: number, bgFn: BackgroundFn): void {
		const paddingX = Number.isFinite(outputPad) ? Math.max(0, Math.floor(outputPad)) : 0;
		if (this.text !== text || this.paddingX !== paddingX) this.invalidate();
		this.text = text;
		this.paddingX = paddingX;
		this.bgFn = bgFn;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (!this.text || !Number.isFinite(width) || width <= 0) return [];
		// Like Pi's Box, observe theme output rather than the background callback's identity.
		const bgSample = this.bgFn("test");
		if (this.cache && this.cache.width === width && this.cache.bgSample === bgSample) return this.cache.lines;
		const safeWidth = Math.floor(width);
		const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((safeWidth - 1) / 2)));
		const contentWidth = Math.max(1, safeWidth - paddingX * 2);
		const content = renderSingleLine(this.text, contentWidth)[0] ?? " ".repeat(contentWidth);
		const fullLine = `${" ".repeat(paddingX)}${content}${" ".repeat(paddingX)}`;
		const blankLine = " ".repeat(safeWidth);
		const lines = [
			...Array.from({ length: this.paddingTop }, () => this.bgFn(blankLine)),
			this.bgFn(fullLine),
			...Array.from({ length: this.paddingBottom }, () => this.bgFn(blankLine)),
		];
		this.cache = { width, bgSample, lines };
		return lines;
	}
}

class MinimalEditCallComponent extends MinimalSelfShellLineComponent {
	constructor() {
		super(1, 1);
	}
}

class MinimalEditResultComponent extends MinimalSelfShellLineComponent {
	constructor() {
		super(0, 1);
	}
}

function renderSingleLine(text: string, width: number): string[] {
	if (!text || !Number.isFinite(width) || width <= 0) return [];
	const safeWidth = Math.floor(width);
	const normalized = text.replace(/\t/g, "   ");
	let displayed = truncateToWidth(normalized, safeWidth, "...");

	if (displayed !== normalized) {
		// Pi wraps its generated ellipsis in full SGR resets. Rewrite only that final wrapper so the
		// ellipsis inherits the style active at the truncation point while the outer tool-row background
		// remains intact. Preserve any earlier resets that belong to independently styled call segments.
		displayed = displayed.replace(/\x1b\[0m(\.{1,3})\x1b\[0m$/, "$1\x1b[22;39m");
	}

	const padding = Math.max(0, safeWidth - visibleWidth(displayed));
	return [`${displayed}${" ".repeat(padding)}`];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function argValue(args: unknown, name: string): unknown {
	return isRecord(args) ? args[name] : undefined;
}

// Read a text argument as Pi runs it: a string as supplied, and a number or boolean as the text that Pi's argument
// validation converts it to before the tool runs. Missing or null is "" (not supplied). A value of any other type, such
// as an object or array, is null: Pi rejects it, and its own renderers mark it as invalid.
function textValue(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return value == null ? "" : null;
}

// read, write and edit show file_path unless it is missing or null, and then path, as Pi's own renderers do. Pi's tools
// run only path, so a file_path that is not a string is never converted and stays invalid, as in Pi's own views.
function filePathArg(args: unknown): string | null {
	const filePath = argValue(args, "file_path");
	if (filePath == null) return textValue(argValue(args, "path"));
	return typeof filePath === "string" ? filePath : null;
}

// Pi's own marker for a text argument that Pi rejects.
function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}

function numberArg(args: unknown, name: string): number | undefined {
	if (!isRecord(args)) return undefined;
	let value = args[name];
	if (typeof value === "string" && value.trim() !== "") value = Number(value);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Control and bidirectional-control characters and unpaired surrogates become U+FFFD. Pi measures an unpaired
// surrogate as zero columns, but the terminal receives U+FFFD for it, so a fitted line would overflow.
function sanitizeDisplayText(value: string): string {
	return stripTerminalSequences(value)
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uD800-\uDFFF]/gu, "\uFFFD");
}

function toSingleLine(value: string): string {
	// Visit each whitespace run once; only runs containing CR/LF are collapsed.
	return sanitizeDisplayText(value)
		.replace(/\s+/g, (whitespace) => (/[\r\n]/.test(whitespace) ? " " : whitespace));
}

function compactOneLine(value: string): string {
	return toSingleLine(value).trim();
}

// Edge whitespace is kept where Pi's own views show it: search patterns and limits. Test for blankness only after
// safe-text cleanup.
function compactKeepingEdges(value: string): string {
	const text = toSingleLine(value);
	return text.trim() ? text : "";
}

interface WriteLineCount {
	content: string;
	breaks: number;
}

function countTextLines(value: string, cache: MinimalCallComponent | undefined): number {
	if (!value) {
		if (cache) cache.writeLineCount = undefined;
		return 0;
	}

	const previous = cache?.writeLineCount;
	const last = value.charCodeAt(value.length - 1);
	const finalLine = last === 10 || last === 13 ? 0 : 1;
	if (previous?.content === value) return previous.breaks + finalLine;
	let breaks = 0;
	let start = 0;
	// Compare the entire prefix, not just lengths. Replacements and shrinking inputs must recount.
	// Retain only the current immutable string reference and its break count for this call component.
	if (previous && value.length > previous.content.length && value.slice(0, previous.content.length) === previous.content) {
		breaks = previous.breaks;
		start = previous.content.length;
	}
	for (let i = start; i < value.length; i++) {
		const code = value.charCodeAt(i);
		// Looking one code unit back also handles CRLF split across two argument updates.
		if (code === 13 || (code === 10 && (i === 0 || value.charCodeAt(i - 1) !== 13))) breaks++;
	}
	if (cache) cache.writeLineCount = { content: value, breaks };
	return breaks + finalLine;
}

// Match Pi's native link-path normalization without probing the filesystem or importing private helpers.
function normalizeLinkPath(value: string): string {
	if (sep === "\\" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) {
		const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(value);
		if (drive?.[1]) value = `${drive[1].toUpperCase()}:\\${(drive[2] ?? "").replaceAll("/", "\\")}`;
	}
	if (value === "~") return homedir();
	if (value.startsWith("~/") || (sep === "\\" && value.startsWith("~\\"))) return join(homedir(), value.slice(2));
	return value.startsWith("file://") ? fileURLToPath(value) : value;
}

// Show an absolute path inside the home directory with `~` in its place, as Pi's own views do: the same resolved
// comparison (case-insensitive on Windows) without probing the filesystem. Other paths are shown as supplied.
function shortenHomePath(path: string): string {
	try {
		const home = homedir();
		if (!home || !isAbsolute(path)) return path;
		const key = (value: string) => (sep === "\\" ? resolve(value).toLowerCase() : resolve(value));
		const homeKey = key(home);
		const pathKey = key(path);
		if (pathKey !== homeKey && !pathKey.startsWith(homeKey.endsWith(sep) ? homeKey : `${homeKey}${sep}`)) return path;
		const rest = relative(home, path);
		return rest ? `~${sep}${rest}` : "~";
	} catch {
		// An unavailable home directory must not prevent the call from being displayed.
		return path;
	}
}

// Callers pass the path argument Pi's own renderers read: filePathArg for read, write and edit, and only path for
// ls, which ignores file_path. A path that Pi rejects shows Pi's invalid marker. The label may be shortened with
// `~`; the link always targets the supplied path.
function formatLinkedPath(raw: string | null, theme: Theme, context: RenderContext): string {
	if (raw === null) return invalidArgText(theme);
	const label = compactOneLine(shortenHomePath(raw));
	if (!label) return "";
	const text = theme.fg("accent", label);
	if (!getCapabilities().hyperlinks || raw.trim() === "") return text;
	try {
		const path = normalizeLinkPath(raw);
		const absolute = isAbsolute(path) ? resolve(path) : resolve(normalizeLinkPath(context.cwd), path);
		return hyperlink(text, pathToFileURL(absolute).href);
	} catch {
		// Invalid path/URL input must not prevent the call or its error result from being displayed.
		return text;
	}
}

function plural(count: number, singular: string): string {
	return count === 1 ? singular : `${singular}s`;
}

function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
	if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
	if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
	const totalSeconds = Math.floor(durationMs / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${seconds}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds}s`;
}

function shellCommandPreview(command: string): string {
	// Clean the whole command before taking its first meaningful line: terminal sequences may remove
	// text, and VT/FF become visible replacements rather than whitespace.
	const normalized = sanitizeDisplayText(command).replace(/\r\n?/g, "\n").trimStart();
	const newline = normalized.indexOf("\n");
	const firstLine = (newline === -1 ? normalized : normalized.slice(0, newline)).trimEnd();
	const hasAdditionalContent = newline !== -1 && /\S/.test(normalized.slice(newline + 1));
	return firstLine ? ` ${firstLine}${hasAdditionalContent ? " ..." : ""}` : "";
}

function formatShellCall(args: unknown, prompt: "$" | "PS>", theme: Theme): string {
	const command = textValue(argValue(args, "command"));
	// Pi's own call line shows its invalid marker after the prompt for a command that Pi rejects.
	const preview = command === null ? ` ${invalidArgText(theme)}` : shellCommandPreview(command);
	// Append a supplied timeout as Pi's own call line does; the whole line is then fitted to the width.
	const timeout = numberArg(args, "timeout");
	const timeoutText = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	return `${theme.fg("toolTitle", theme.bold(`${prompt}${preview}`))}${timeoutText}`;
}

// Pi has no renderer of its own for tool_search or the MCP resource tools; its generic view shows supplied
// arguments as JSON. Strings are cleaned into one line (quoted when requested); other supplied values keep
// that JSON form.
function genericArgText(value: unknown, quoteString: boolean): string {
	if (typeof value === "string") {
		const text = compactOneLine(value);
		return text && quoteString ? JSON.stringify(text) : text;
	}
	return value == null ? "" : compactOneLine(JSON.stringify(value) ?? String(value));
}

// A text argument of tool_search or an MCP resource tool is shown as Pi runs it (see textValue); a value that Pi
// rejects keeps the generic view's JSON form.
function genericTextArg(args: unknown, name: string, quoteString: boolean): string {
	const value = argValue(args, name);
	return genericArgText(textValue(value) ?? value, quoteString);
}

// tool_search shows a supplied limit as Pi's generic view does: as the JSON of the value, whatever its type. Missing,
// null and blank limits stay empty.
function genericLimitText(args: unknown): string {
	const limit = argValue(args, "limit");
	if (limit == null || (typeof limit === "string" && !compactOneLine(limit))) return "";
	return compactOneLine(JSON.stringify(limit) ?? String(limit));
}

// find and grep: Pi's invalid marker for a pattern or path that Pi rejects; otherwise the cleaned pattern, styled by
// the caller, and the search path with the home directory shown as `~`.
function searchPattern(args: unknown, theme: Theme, style: (pattern: string) => string): string {
	const raw = textValue(argValue(args, "pattern"));
	if (raw === null) return invalidArgText(theme);
	const pattern = compactKeepingEdges(raw);
	return pattern ? style(pattern) : "";
}

function searchPath(args: unknown, theme: Theme): string {
	const raw = textValue(argValue(args, "path"));
	return raw === null ? invalidArgText(theme) : compactOneLine(shortenHomePath(raw));
}

// find, grep and ls show a supplied limit as Pi's own views do: as text, whatever its type, edge spaces included.
// Converting it as Pi does also keeps Pi's handling of a value that cannot become text: the renderer throws, and Pi
// shows its fallback view. Missing, null and blank limits stay empty.
function limitText(args: unknown): string {
	const limit = argValue(args, "limit");
	return limit == null ? "" : compactKeepingEdges(String(limit));
}

// Show only supplied preview fields. Missing fields have no placeholder or inferred path; text arguments are read by
// textValue, and values that Pi rejects follow Pi's own call lines.
function formatCall(
	toolName: SupportedToolName,
	args: unknown,
	theme: Theme,
	context: RenderContext,
	callComponent?: MinimalCallComponent,
): string {
	if (toolName === "bash") return formatShellCall(args, "$", theme);
	if (toolName === "powershell") return formatShellCall(args, "PS>", theme);
	const title = theme.fg("toolTitle", theme.bold(toolName));
	switch (toolName) {
		case "codemode":
			// The source stays hidden; only a value that Pi rejects shows Pi's invalid marker.
			return textValue(argValue(args, "code")) === null ? `${title} ${invalidArgText(theme)}` : title;
		case "list_mcp_resources":
		case "list_mcp_resource_templates":
		case "read_mcp_resource": {
			const keys = toolName === "read_mcp_resource" ? ["server", "uri"] : ["server", "cursor"];
			const fields = keys.flatMap((key) => {
				const value = genericTextArg(args, key, true);
				return value ? [`${key}=${value}`] : [];
			});
			return `${title}${fields.length ? ` ${theme.fg("muted", fields.join(" "))}` : ""}`;
		}
		case "tool_search": {
			// Muted, like the arguments in Pi's generic view; the limit is shown as that view shows it.
			const query = genericTextArg(args, "query", false);
			const limit = genericLimitText(args);
			const suffix = limit ? theme.fg("muted", ` (limit ${limit})`) : "";
			return `${title}${query ? ` ${theme.fg("muted", query)}` : ""}${suffix}`;
		}
		case "read": {
			const path = formatLinkedPath(filePathArg(args), theme, context);
			// Preserve omitted versus malformed values for Pi's public range formatter.
			const lineRange = isRecord(args) ? formatReadLineRange(args.offset, args.limit) : "";
			const range = lineRange ? theme.fg("warning", lineRange) : "";
			return `${title}${path || range ? ` ${path}${range}` : ""}`;
		}
		case "write": {
			const path = formatLinkedPath(filePathArg(args), theme, context);
			const content = textValue(argValue(args, "content"));
			const lineCount = countTextLines(content ?? "", callComponent);
			let lineInfo = lineCount > 0 ? theme.fg("muted", ` (${lineCount} ${plural(lineCount, "line")})`) : "";
			// Content that Pi rejects shows Pi's own marker in place of the line count.
			if (content === null) lineInfo = ` ${theme.fg("error", "[invalid content arg - expected string]")}`;
			return `${title}${path ? ` ${path}` : ""}${lineInfo}`;
		}
		case "edit": {
			const path = formatLinkedPath(filePathArg(args), theme, context);
			return `${title}${path ? ` ${path}` : ""}`;
		}
		case "find": {
			const pattern = searchPattern(args, theme, (value) => theme.fg("accent", value));
			const path = searchPath(args, theme);
			const limit = limitText(args);
			const suffix = limit ? theme.fg("toolOutput", ` (limit ${limit})`) : "";
			return `${title}${pattern ? ` ${pattern}` : ""}${path ? theme.fg("toolOutput", ` in ${path}`) : ""}${suffix}`;
		}
		case "grep": {
			const pattern = searchPattern(args, theme, (value) => theme.fg("accent", `/${value}/`));
			const path = searchPath(args, theme);
			// A glob that Pi rejects is omitted, as in Pi's own view.
			const glob = compactOneLine(textValue(argValue(args, "glob")) ?? "");
			const limit = limitText(args);
			let suffix = glob ? theme.fg("toolOutput", ` (${glob})`) : "";
			if (limit) suffix += theme.fg("toolOutput", ` limit ${limit}`);
			return `${title}${pattern ? ` ${pattern}` : ""}${path ? theme.fg("toolOutput", ` in ${path}`) : ""}${suffix}`;
		}
		case "ls": {
			const path = formatLinkedPath(textValue(argValue(args, "path")), theme, context);
			const limit = limitText(args);
			const suffix = limit ? theme.fg("toolOutput", ` (limit ${limit})`) : "";
			return `${title}${path ? ` ${path}` : ""}${suffix}`;
		}
	}
}

interface CodemodeSummary {
	total: number;
	failed: number;
	cancelled: number;
}

function codemodeSummary(details: unknown, allowRunning: boolean): CodemodeSummary | undefined {
	if (!isRecord(details) || !Array.isArray(details.calls)) return undefined;

	let failed = 0;
	let cancelled = 0;
	for (const call of details.calls) {
		if (!isRecord(call)) return undefined;
		const status = call.status;
		if (typeof status !== "string" || !CODEMODE_STATUSES.has(status as CodemodeStatus)) return undefined;
		if (status === "running" && !allowRunning) return undefined;
		if (status === "error") failed += 1;
		else if (status === "cancelled") cancelled += 1;
	}

	return { total: details.calls.length, failed, cancelled };
}

function loadedToolCount(details: unknown): number | undefined {
	if (!isRecord(details) || !Array.isArray(details.loaded)) return undefined;
	const names = new Set<string>();
	for (const name of details.loaded) {
		if (typeof name !== "string" || !name.trim() || names.has(name)) return undefined;
		names.add(name);
	}
	return names.size;
}

function styleStatus(options: ToolResultOptions, context: RenderContext, theme: Theme): string {
	if (options.isPartial) return theme.fg("warning", "running");
	if (context.isError) return theme.fg("error", "failed");
	return theme.fg("success", "completed");
}

function formatResult(
	toolName: SupportedToolName,
	result: ToolResult,
	options: ToolResultOptions,
	theme: Theme,
	context: RenderContext,
): string {
	const status = styleStatus(options, context, theme);
	let text = `${theme.fg("muted", "→ ")}${status}`;

	if (toolName === "codemode") {
		const summary = codemodeSummary(result.details, options.isPartial);
		if (summary) {
			text += theme.fg("muted", ` · ${summary.total} ${plural(summary.total, "call")}`);
			if (summary.failed > 0) text += theme.fg("error", ` · ${summary.failed} failed`);
			if (summary.cancelled > 0) text += theme.fg("muted", ` · ${summary.cancelled} cancelled`);
		}
	}

	if (toolName === "tool_search" && !options.isPartial && !context.isError) {
		const count = loadedToolCount(result.details);
		if (count !== undefined) text += theme.fg("muted", ` · ${count} ${plural(count, "tool")} loaded`);
	}

	const duration = options.isPartial ? undefined : formatDuration(context.durationMs);
	// Muted, as Pi's own views show a duration.
	if (duration) text += theme.fg("muted", ` · ${duration}`);
	return text;
}

function statusBackground(theme: Theme, isPartial: boolean, isError: boolean): BackgroundFn {
	const token = isPartial ? "toolPendingBg" : isError ? "toolErrorBg" : "toolSuccessBg";
	return (text: string) => theme.bg(token, text);
}

// Keep plugin-owned fields isolated in Pi's per-row state; never replace downstream state.
interface MinimalRendererState {
	[NATIVE_RENDERER_TOUCHED]?: boolean;
	[NATIVE_TIMING_PRIMED]?: boolean;
	[EDIT_CALL_COMPONENT]?: MinimalEditCallComponent;
}

function rendererState(context: RenderContext): MinimalRendererState | undefined {
	return isRecord(context.state) ? (context.state as MinimalRendererState) : undefined;
}

function nativeRendererWasTouched(context: RenderContext): boolean {
	return rendererState(context)?.[NATIVE_RENDERER_TOUCHED] === true;
}

function setNativeRendererTouched(context: RenderContext, touched: boolean): void {
	const state = rendererState(context);
	if (state) state[NATIVE_RENDERER_TOUCHED] = touched;
}

function contextForNative<T extends { lastComponent: Component | undefined }>(context: T): T {
	if (
		!(context.lastComponent instanceof MinimalLineComponent) &&
		!(context.lastComponent instanceof MinimalSelfShellLineComponent)
	) {
		return context;
	}
	return { ...context, lastComponent: undefined };
}

const EMPTY_COMPONENT: Component = { render: () => [], invalidate() {} };

// The allowlisted generic tools have no specialized renderers. Compose Pi's public component to reuse
// Pi's generic expanded argument/result formatting instead of copying private fallback helpers.
class GenericFallbackComponent implements Component {
	private readonly view: ToolExecutionComponent;

	constructor(
		readonly toolName: SupportedToolName,
		readonly slot: "call" | "result",
		args: unknown,
		context: RenderContext,
	) {
		const renderers: ToolRenderers = { renderShell: "self" };
		if (slot === "result") renderers.renderCall = () => EMPTY_COMPONENT;
		// The public tool component uses this UI argument only to request renders; never start another TUI
		// or access its internals. This display-only copy has no images or timers of its own and changes only
		// while its owning row updates or draws it, so the row's own redraw always shows it. Its requests are
		// therefore ignored: forwarding them (Pi 1.5.0 makes one from updateArgs) would make the row redraw
		// itself from inside its own update.
		const ui = { requestRender() {} } as ConstructorParameters<typeof ToolExecutionComponent>[5];
		this.view = new ToolExecutionComponent(toolName, context.toolCallId, args, {
			showImages: false,
			outputPad: 0,
		}, renderers, ui, context.cwd);
		this.view.setExpanded(true);
	}

	updateArgs(args: unknown): void {
		this.view.updateArgs(args);
	}

	updateResult(result: ToolResult, options: ToolResultOptions, context: RenderContext): void {
		// The outer Pi row already owns inline images. Exclude them only from this display-only copy
		// when they are shown inline; otherwise let Pi's generic fallback show its image indicators.
		const content = context.showImages && getCapabilities().images
			? result.content.filter((block) => block.type !== "image")
			: result.content;
		this.view.updateResult({ content, details: result.details, isError: context.isError }, options.isPartial);
	}

	invalidate(): void {
		this.view.invalidate();
	}

	render(width: number): string[] {
		const lines = this.view.render(width);
		// The outer row supplies the tool-to-tool separator. Remove only an empty first line from
		// the public component output; never trim the argument or result content itself.
		return lines[0] === "" ? lines.slice(1) : lines;
	}
}

function genericFallback(
	toolName: SupportedToolName,
	slot: "call" | "result",
	args: unknown,
	context: RenderContext,
): GenericFallbackComponent {
	const previous = context.lastComponent;
	if (previous instanceof GenericFallbackComponent && previous.toolName === toolName && previous.slot === slot) {
		// Only the call slot displays arguments. Updating a result slot's arguments would redraw its
		// old result immediately before updateResult draws the new one.
		if (slot === "call") previous.updateArgs(args);
		return previous;
	}
	// The native constructor already initializes the arguments; do not update them a second time.
	return new GenericFallbackComponent(toolName, slot, args, context);
}

function hasCompleteRenderers(renderers: ToolRenderers): renderers is CompleteToolRenderers {
	return typeof renderers.renderCall === "function" && typeof renderers.renderResult === "function";
}

function prepareDownstreamRenderers(
	toolName: SupportedToolName,
	native: ToolRenderers,
): CompleteToolRenderers | undefined {
	if (GENERIC_TOOL_NAMES.has(toolName)) {
		// Do not guess how an unrelated self-framed replacement should be composed.
		if (native.renderShell === "self") return undefined;
		if (!native.renderCall && !native.renderResult) {
			return {
				...native,
				renderCall(args, _theme, context) {
					return genericFallback(toolName, "call", args, context);
				},
				renderResult(result, options, _theme, context) {
					const component = genericFallback(toolName, "result", context.args, context);
					component.updateResult(result, options, context);
					return component;
				},
			};
		}
	}
	return hasCompleteRenderers(native) ? native : undefined;
}

export function createMinimalToolViewRenderers(toolName: SupportedToolName, native: ToolRenderers): ToolRenderers {
	const downstream = prepareDownstreamRenderers(toolName, native);
	if (!downstream) return native;
	const selfFramedEdit = toolName === "edit" && downstream.renderShell === "self";
	const preserveNativeTiming = toolName === "bash" || toolName === "powershell" || toolName === "codemode";

	return {
		...downstream,
		renderCall(args, theme, context) {
			const state = rendererState(context);
			if (preserveNativeTiming && state && context.executionStarted && context.isPartial && !state[NATIVE_TIMING_PRIMED]) {
				// Initialize the native clock once, not at first expansion. The call callback records
				// timing without starting a periodic redraw; never send hidden partial-result updates.
				// The flag is row state, not part of the call component, because it must survive the
				// switch to the native component while the row is expanded and back.
				state[NATIVE_TIMING_PRIMED] = true;
				setNativeRendererTouched(context, true);
				if (!context.expanded) {
					try {
						downstream.renderCall(args, theme, contextForNative(context));
					} catch {
						// An off-screen renderer failure must not hide the call. Retain the cleanup flag
						// in case the native callback created state before throwing.
					}
				}
			}
			if (context.expanded) {
				if (selfFramedEdit) {
					if (state) delete state[EDIT_CALL_COMPONENT];
				}
				const component = downstream.renderCall(args, theme, contextForNative(context));
				setNativeRendererTouched(context, true);
				return component;
			}
			if (selfFramedEdit) {
				const component =
					context.lastComponent instanceof MinimalEditCallComponent
						? context.lastComponent
						: new MinimalEditCallComponent();
				// Keep both margins until Pi supplies a result. Its call/result callbacks share row state;
				// renderResult transfers the bottom margin before the components are drawn.
				component.setBottomPadding(1);
				if (state) state[EDIT_CALL_COMPONENT] = component;
				component.setContent(
					formatCall(toolName, args, theme, context),
					context.outputPad,
					statusBackground(theme, context.isPartial, context.isError),
				);
				return component;
			}

			const component =
				context.lastComponent instanceof MinimalCallComponent ? context.lastComponent : new MinimalCallComponent();
			component.setText(formatCall(toolName, args, theme, context, component));
			return component;
		},
		renderResult(result, options, theme, context) {
			if (options.expanded) {
				const component = downstream.renderResult(result, options, theme, contextForNative(context));
				setNativeRendererTouched(context, options.isPartial && !context.isError);
				return component;
			}

			// Some native renderers keep transient state while expanded (for example, a live shell timer).
			// If the row is collapsed before the final result arrives, forward that final result off-screen so
			// the native renderer can release its own transient resources.
			if (!options.isPartial && nativeRendererWasTouched(context)) {
				try {
					downstream.renderResult(result, options, theme, contextForNative(context));
				} catch {
					// Cleanup delegation must never replace the minimal result with a renderer failure.
				} finally {
					setNativeRendererTouched(context, false);
				}
			}

			const resultText = formatResult(toolName, result, options, theme, context);
			if (selfFramedEdit) {
				const state = rendererState(context);
				if (state) {
					const call = state[EDIT_CALL_COMPONENT];
					if (call instanceof MinimalEditCallComponent) call.setBottomPadding(0);
					delete state[EDIT_CALL_COMPONENT];
				}
				const component =
					context.lastComponent instanceof MinimalEditResultComponent
						? context.lastComponent
						: new MinimalEditResultComponent();
				component.setContent(
					resultText,
					context.outputPad,
					statusBackground(theme, options.isPartial, context.isError),
				);
				return component;
			}

			const component =
				context.lastComponent instanceof MinimalResultComponent ? context.lastComponent : new MinimalResultComponent();
			component.setText(resultText);
			return component;
		},
	};
}

export default function minimalToolView(pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, next) => {
		const native = next();
		if (!SUPPORTED_TOOL_NAMES.has(toolName as SupportedToolName)) return native;
		// Saved MCP resource calls remain displayable without reconnecting or enabling their tools.
		if (!native && !MCP_RESOURCE_TOOL_NAMES.has(toolName)) return native;
		return createMinimalToolViewRenderers(toolName as SupportedToolName, native ?? {});
	});
}
