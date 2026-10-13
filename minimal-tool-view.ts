// SPDX-License-Identifier: SUL-1.0
// Copyright (c) 2026 caeloren

import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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
] as const);

const CODEMODE_STATUSES = new Set(["running", "ok", "error", "cancelled"] as const);
const NATIVE_RENDERER_TOUCHED = Symbol("minimal-tool-view.native-renderer-touched");

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
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
		private readonly paddingBottom: number,
	) {}

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
		super(1, 0);
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
	const truncated = visibleWidth(normalized) > safeWidth;
	let displayed = truncateToWidth(normalized, safeWidth, "...");

	if (truncated) {
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

function countTextLines(value: string): number {
	if (value.length === 0) return 0;
	const normalized = value.replace(/\r\n?/g, "\n");
	let count = 0;
	for (const character of normalized) {
		if (character === "\n") count += 1;
	}
	return normalized.endsWith("\n") ? count : count + 1;
}

function displayPath(args: unknown, fallback = "..."): string {
	const path = stringArg(args, "file_path", "path");
	if (path === undefined) return fallback;
	return compactOneLine(path) || fallback;
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

function formatShellCall(args: unknown, prompt: "$" | "PS>", theme: Theme, context: RenderContext): string {
	// Before a final result, incomplete arguments must not be presented as a complete command.
	// Restored final rows may leave argsComplete false, including failures without durationMs.
	// Use the explicit partial-result state, never error status or duration, to select the placeholder.
	if (!context.argsComplete && context.isPartial) {
		return theme.fg("toolTitle", theme.bold(`${prompt} ...`));
	}

	const command = stringArg(args, "command");
	if (command === undefined) {
		return `${theme.fg("toolTitle", theme.bold(prompt))} ${theme.fg("error", "[invalid command]")}`;
	}

	const normalized = sanitizeDisplayText(command).replace(/\r\n?/g, "\n").trimStart();
	const newline = normalized.indexOf("\n");
	const firstLine = (newline === -1 ? normalized : normalized.slice(0, newline)).trimEnd();
	const hasAdditionalContent = newline !== -1 && /\S/.test(normalized.slice(newline + 1));
	const preview = firstLine || "...";
	const suffix = hasAdditionalContent ? " ..." : "";
	return theme.fg("toolTitle", theme.bold(`${prompt} ${preview}${suffix}`));
}

function formatCall(toolName: SupportedToolName, args: unknown, theme: Theme, context: RenderContext): string {
	switch (toolName) {
		case "bash":
			return formatShellCall(args, "$", theme, context);
		case "powershell":
			return formatShellCall(args, "PS>", theme, context);
		case "codemode":
			return theme.fg("toolTitle", theme.bold("codemode"));
		case "read": {
			const path = displayPath(args);
			let range = "";
			const offset = numberArg(args, "offset");
			const limit = numberArg(args, "limit");
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : undefined;
				range = theme.fg("warning", `:${start}${end !== undefined ? `-${end}` : ""}`);
			}
			return `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", path)}${range}`;
		}
		case "write": {
			const path = displayPath(args);
			const content = stringArg(args, "content");
			const lineCount = content === undefined ? 0 : countTextLines(content);
			const lineInfo = lineCount > 0 ? theme.fg("muted", ` (${lineCount} ${plural(lineCount, "line")})`) : "";
			return `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", path)}${lineInfo}`;
		}
		case "edit":
			return `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", displayPath(args))}`;
		case "find": {
			const pattern = compactOneLine(stringArg(args, "pattern") ?? "") || "...";
			const path = displayPath(args, ".");
			const limit = numberArg(args, "limit");
			const suffix = limit === undefined ? "" : theme.fg("muted", ` (limit ${limit})`);
			return `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", pattern)}${theme.fg("toolOutput", ` in ${path}`)}${suffix}`;
		}
		case "grep": {
			const pattern = compactOneLine(stringArg(args, "pattern") ?? "") || "...";
			const path = displayPath(args, ".");
			const glob = stringArg(args, "glob");
			const limit = numberArg(args, "limit");
			let suffix = glob ? theme.fg("muted", ` (${compactOneLine(glob)})`) : "";
			if (limit !== undefined) suffix += theme.fg("muted", ` limit ${limit}`);
			return `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", `/${pattern}/`)}${theme.fg("toolOutput", ` in ${path}`)}${suffix}`;
		}
		case "ls": {
			const path = displayPath(args, ".");
			const limit = numberArg(args, "limit");
			const suffix = limit === undefined ? "" : theme.fg("muted", ` (limit ${limit})`);
			return `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", path)}${suffix}`;
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

function nativeRendererWasTouched(context: RenderContext): boolean {
	return isRecord(context.state) && (context.state as { [NATIVE_RENDERER_TOUCHED]?: boolean })[NATIVE_RENDERER_TOUCHED] === true;
}

function setNativeRendererTouched(context: RenderContext, touched: boolean): void {
	if (!isRecord(context.state)) return;
	(context.state as { [NATIVE_RENDERER_TOUCHED]?: boolean })[NATIVE_RENDERER_TOUCHED] = touched;
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

export function createMinimalToolViewRenderers(toolName: SupportedToolName, native: ToolRenderers): ToolRenderers {
	if (!native.renderCall || !native.renderResult) return native;

	return {
		...native,
		renderCall(args, theme, context) {
			if (context.expanded) {
				const component = native.renderCall!(args, theme, contextForNative(context));
				setNativeRendererTouched(context, true);
				return component;
			}
			if (toolName === "edit") {
				const component =
					context.lastComponent instanceof MinimalEditCallComponent
						? context.lastComponent
						: new MinimalEditCallComponent();
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
				const component = native.renderResult!(result, options, theme, contextForNative(context));
				setNativeRendererTouched(context, options.isPartial && !context.isError);
				return component;
			}

			// Some native renderers keep transient state while expanded (for example, a live shell timer).
			// If the row is collapsed before the final result arrives, forward that final result off-screen so
			// the native renderer can release its own transient resources.
			if ((!options.isPartial || context.isError) && nativeRendererWasTouched(context)) {
				try {
					native.renderResult!(result, options, theme, contextForNative(context));
				} catch {
					// Cleanup delegation must never replace the minimal result with a renderer failure.
				} finally {
					setNativeRendererTouched(context, false);
				}
			}

			const resultText = formatResult(toolName, result, options, theme, context);
			if (toolName === "edit") {
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
