// SPDX-License-Identifier: SUL-1.0
// Copyright (c) 2026 caeloren

import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ExtensionAPI, ToolExecutionComponent, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, getCapabilities, hyperlink, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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
] as const);

const CODEMODE_STATUSES = new Set(["running", "ok", "error", "cancelled"] as const);
const NATIVE_RENDERER_TOUCHED = Symbol("minimal-tool-view.native-renderer-touched");
const EDIT_CALL_COMPONENT = Symbol("minimal-tool-view.edit-call-component");
const WRITE_LINE_COUNT = Symbol("minimal-tool-view.write-line-count");

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

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {
		// No cached state.
	}

	render(width: number): string[] {
		return renderSingleLine(this.text, width);
	}
}

// Keep distinct identities for Pi's call and result component slots.
class MinimalCallComponent extends MinimalLineComponent {}
class MinimalResultComponent extends MinimalLineComponent {}

type MinimalVisualStatus = "pending" | "success" | "error";
type BackgroundFn = (text: string) => string;

class MinimalSelfShellLineComponent implements Component {
	private text = "";
	private paddingX = 0;
	private bgFn: BackgroundFn = (text) => text;

	constructor(
		private readonly paddingTop: number,
		private paddingBottom: number,
	) {}

	setBottomPadding(padding: 0 | 1): void {
		this.paddingBottom = padding;
	}

	setContent(text: string, outputPad: number, bgFn: BackgroundFn): void {
		this.text = text;
		this.paddingX = Number.isFinite(outputPad) ? Math.max(0, Math.floor(outputPad)) : 0;
		this.bgFn = bgFn;
	}

	invalidate(): void {
		// No cached state.
	}

	render(width: number): string[] {
		if (!this.text || !Number.isFinite(width) || width <= 0) return [];
		const safeWidth = Math.floor(width);
		const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((safeWidth - 1) / 2)));
		const contentWidth = Math.max(1, safeWidth - paddingX * 2);
		const content = renderSingleLine(this.text, contentWidth)[0] ?? " ".repeat(contentWidth);
		const fullLine = `${" ".repeat(paddingX)}${content}${" ".repeat(paddingX)}`;
		const blankLine = " ".repeat(safeWidth);
		return [
			...Array.from({ length: this.paddingTop }, () => this.bgFn(blankLine)),
			this.bgFn(fullLine),
			...Array.from({ length: this.paddingBottom }, () => this.bgFn(blankLine)),
		];
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

function stringArg(args: unknown, ...names: string[]): string | undefined {
	if (!isRecord(args)) return undefined;
	for (const name of names) {
		const value = args[name];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function numberArg(args: unknown, name: string): number | undefined {
	if (!isRecord(args)) return undefined;
	const value = args[name];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeDisplayText(value: string): string {
	return stripTerminalSequences(value)
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "\uFFFD")
		.replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "\uFFFD");
}

function compactOneLine(value: string): string {
	// Visit each whitespace run once; only runs containing CR/LF are collapsed.
	return sanitizeDisplayText(value)
		.replace(/\s+/g, (whitespace) => (/[\r\n]/.test(whitespace) ? " " : whitespace))
		.trim();
}

interface WriteLineCount {
	content: string;
	breaks: number;
}

function countTextLines(value: string | undefined, context: RenderContext): number {
	const state = rendererState(context);
	if (!value) {
		if (state) delete state[WRITE_LINE_COUNT];
		return 0;
	}

	const previous = state?.[WRITE_LINE_COUNT];
	const last = value.charCodeAt(value.length - 1);
	const finalLine = last === 10 || last === 13 ? 0 : 1;
	if (previous?.content === value) return previous.breaks + finalLine;
	let breaks = 0;
	let start = 0;
	// Compare the entire prefix, not just lengths. Replacements and shrinking inputs must recount.
	// Retain only the current immutable string reference and its break count for this tool row.
	if (previous && value.length > previous.content.length && value.slice(0, previous.content.length) === previous.content) {
		breaks = previous.breaks;
		start = previous.content.length;
	}
	for (let i = start; i < value.length; i++) {
		const code = value.charCodeAt(i);
		// Looking one code unit back also handles CRLF split across two argument updates.
		if (code === 13 || (code === 10 && (i === 0 || value.charCodeAt(i - 1) !== 13))) breaks++;
	}
	if (state) state[WRITE_LINE_COUNT] = { content: value, breaks };
	return breaks + finalLine;
}

function displayPath(args: unknown): string {
	return compactOneLine(stringArg(args, "file_path", "path") ?? "");
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

function formatLinkedPath(args: unknown, theme: Theme, context: RenderContext): string {
	const label = displayPath(args);
	if (!label) return "";
	const text = theme.fg("accent", label);
	const raw = stringArg(args, "file_path", "path");
	if (!getCapabilities().hyperlinks || raw === undefined || raw.trim() === "") return text;
	try {
		const path = normalizeLinkPath(raw);
		const absolute = isAbsolute(path) ? resolve(path) : resolve(normalizeLinkPath(context.cwd), path);
		return hyperlink(text, pathToFileURL(absolute).href);
	} catch {
		// Invalid path/URL input must not prevent the call or its error result from being displayed.
		return text;
	}
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return count === 1 ? singular : pluralForm;
}

function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
	if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
	const totalSeconds = Math.floor(durationMs / 1000);
	if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${seconds}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds}s`;
}

function formatShellCall(args: unknown, prompt: "$" | "PS>", theme: Theme): string {
	// Preview available text even while arguments stream or a saved call has no result.
	const normalized = sanitizeDisplayText(stringArg(args, "command") ?? "").replace(/\r\n?/g, "\n").trimStart();
	const newline = normalized.indexOf("\n");
	const firstLine = (newline === -1 ? normalized : normalized.slice(0, newline)).trimEnd();
	const hasAdditionalContent = newline !== -1 && /\S/.test(normalized.slice(newline + 1));
	const preview = firstLine ? ` ${firstLine}${hasAdditionalContent ? " ..." : ""}` : "";
	return theme.fg("toolTitle", theme.bold(`${prompt}${preview}`));
}

// Show only supplied preview fields. Missing fields have no placeholder or inferred path.
function formatCall(toolName: SupportedToolName, args: unknown, theme: Theme, context: RenderContext): string {
	switch (toolName) {
		case "bash":
			return formatShellCall(args, "$", theme);
		case "powershell":
			return formatShellCall(args, "PS>", theme);
		case "codemode":
			return theme.fg("toolTitle", theme.bold("codemode"));
		case "tool_search": {
			const query = compactOneLine(stringArg(args, "query") ?? "");
			const title = theme.fg("toolTitle", theme.bold("tool_search"));
			const limit = numberArg(args, "limit");
			const suffix = limit === undefined ? "" : theme.fg("muted", ` (limit ${limit})`);
			return `${title}${query ? ` ${theme.fg("accent", query)}` : ""}${suffix}`;
		}
		case "read": {
			const path = formatLinkedPath(args, theme, context);
			let range = "";
			const offset = numberArg(args, "offset");
			const limit = numberArg(args, "limit");
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : undefined;
				range = theme.fg("warning", `:${start}${end !== undefined ? `-${end}` : ""}`);
			}
			return `${theme.fg("toolTitle", theme.bold("read"))}${path || range ? ` ${path}${range}` : ""}`;
		}
		case "write": {
			const path = formatLinkedPath(args, theme, context);
			const content = stringArg(args, "content");
			const lineCount = countTextLines(content, context);
			const lineInfo = lineCount > 0 ? theme.fg("muted", ` (${lineCount} ${plural(lineCount, "line")})`) : "";
			return `${theme.fg("toolTitle", theme.bold("write"))}${path ? ` ${path}` : ""}${lineInfo}`;
		}
		case "edit": {
			const path = formatLinkedPath(args, theme, context);
			return `${theme.fg("toolTitle", theme.bold("edit"))}${path ? ` ${path}` : ""}`;
		}
		case "find": {
			const pattern = compactOneLine(stringArg(args, "pattern") ?? "");
			const path = displayPath(args);
			const limit = numberArg(args, "limit");
			const suffix = limit === undefined ? "" : theme.fg("muted", ` (limit ${limit})`);
			return `${theme.fg("toolTitle", theme.bold("find"))}${pattern ? ` ${theme.fg("accent", pattern)}` : ""}${path ? theme.fg("toolOutput", ` in ${path}`) : ""}${suffix}`;
		}
		case "grep": {
			const pattern = compactOneLine(stringArg(args, "pattern") ?? "");
			const path = displayPath(args);
			const glob = compactOneLine(stringArg(args, "glob") ?? "");
			const limit = numberArg(args, "limit");
			let suffix = glob ? theme.fg("muted", ` (${glob})`) : "";
			if (limit !== undefined) suffix += theme.fg("muted", ` limit ${limit}`);
			return `${theme.fg("toolTitle", theme.bold("grep"))}${pattern ? ` ${theme.fg("accent", `/${pattern}/`)}` : ""}${path ? theme.fg("toolOutput", ` in ${path}`) : ""}${suffix}`;
		}
		case "ls": {
			const path = formatLinkedPath(args, theme, context);
			const limit = numberArg(args, "limit");
			const suffix = limit === undefined ? "" : theme.fg("muted", ` (limit ${limit})`);
			return `${theme.fg("toolTitle", theme.bold("ls"))}${path ? ` ${path}` : ""}${suffix}`;
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
	if (duration) text += theme.fg("dim", ` · ${duration}`);
	return text;
}

function visualStatus(isPartial: boolean, isError: boolean): MinimalVisualStatus {
	if (isPartial) return "pending";
	return isError ? "error" : "success";
}

function statusBackground(theme: Theme, status: MinimalVisualStatus): BackgroundFn {
	const token = status === "pending" ? "toolPendingBg" : status === "error" ? "toolErrorBg" : "toolSuccessBg";
	return (text: string) => theme.bg(token, text);
}

// Keep plugin-owned fields isolated in Pi's per-row state; never replace downstream state.
interface MinimalRendererState {
	[NATIVE_RENDERER_TOUCHED]?: boolean;
	[EDIT_CALL_COMPONENT]?: MinimalEditCallComponent;
	[WRITE_LINE_COUNT]?: WriteLineCount;
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
		!(context.lastComponent instanceof MinimalCallComponent) &&
		!(context.lastComponent instanceof MinimalResultComponent) &&
		!(context.lastComponent instanceof MinimalEditCallComponent) &&
		!(context.lastComponent instanceof MinimalEditResultComponent)
	) {
		return context;
	}
	return { ...context, lastComponent: undefined };
}

const EMPTY_COMPONENT: Component = { render: () => [], invalidate() {} };

// Pi 1.2.0's tool_search has no specialized renderers. Compose its public tool component to reuse
// Pi's generic expanded argument/result formatting instead of copying private fallback helpers.
class ToolSearchFallbackComponent implements Component {
	private readonly view: ToolExecutionComponent;

	constructor(readonly slot: "call" | "result", args: unknown, context: RenderContext) {
		const renderers: ToolRenderers = { renderShell: "self" };
		if (slot === "result") renderers.renderCall = () => EMPTY_COMPONENT;
		// The public tool component only needs requestRender from this UI argument. Route it to the
		// owning row's public invalidation callback; never start another TUI or access its internals.
		const ui = { requestRender: context.invalidate } as ConstructorParameters<typeof ToolExecutionComponent>[5];
		this.view = new ToolExecutionComponent("tool_search", context.toolCallId, args, {
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

function toolSearchFallback(slot: "call" | "result", args: unknown, context: RenderContext): ToolSearchFallbackComponent {
	const previous = context.lastComponent;
	if (previous instanceof ToolSearchFallbackComponent && previous.slot === slot) {
		// Only the call slot displays arguments. Updating a result slot's arguments would redraw its
		// old result immediately before updateResult draws the new one.
		if (slot === "call") previous.updateArgs(args);
		return previous;
	}
	// The native constructor already initializes the arguments; do not update them a second time.
	return new ToolSearchFallbackComponent(slot, args, context);
}

function hasCompleteRenderers(renderers: ToolRenderers): renderers is CompleteToolRenderers {
	return typeof renderers.renderCall === "function" && typeof renderers.renderResult === "function";
}

function prepareDownstreamRenderers(
	toolName: SupportedToolName,
	native: ToolRenderers,
): CompleteToolRenderers | undefined {
	if (toolName === "tool_search") {
		// Do not guess how an unrelated self-framed replacement should be composed.
		if (native.renderShell === "self") return undefined;
		if (!native.renderCall && !native.renderResult) {
			return {
				...native,
				renderCall(args, _theme, context) {
					return toolSearchFallback("call", args, context);
				},
				renderResult(result, options, _theme, context) {
					const component = toolSearchFallback("result", context.args, context);
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

	return {
		...downstream,
		renderCall(args, theme, context) {
			if (context.expanded) {
				if (toolName === "write") {
					const state = rendererState(context);
					if (state) delete state[WRITE_LINE_COUNT];
				}
				if (selfFramedEdit) {
					const state = rendererState(context);
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
				const state = rendererState(context);
				if (state) state[EDIT_CALL_COMPONENT] = component;
				component.setContent(
					formatCall(toolName, args, theme, context),
					context.outputPad,
					statusBackground(theme, visualStatus(context.isPartial, context.isError)),
				);
				return component;
			}

			const component =
				context.lastComponent instanceof MinimalCallComponent ? context.lastComponent : new MinimalCallComponent();
			component.setText(formatCall(toolName, args, theme, context));
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
			if ((!options.isPartial || context.isError) && nativeRendererWasTouched(context)) {
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
					statusBackground(theme, visualStatus(options.isPartial, context.isError)),
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
		if (!SUPPORTED_TOOL_NAMES.has(toolName as SupportedToolName) || !native) return native;
		return createMinimalToolViewRenderers(toolName as SupportedToolName, native);
	});
}
