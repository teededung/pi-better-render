/**
 * Single-tool-call style rendering for Pi's `codemode` cards.
 *
 * Hides raw JavaScript glue source and raw script return values (`tuiText` /
 * JSON return blobs), while keeping a `codemode` container frame and rendering
 * each nested `tools.*` call inside it like an individual Pi tool call (with
 * full per-call `toolSummary` support, syntax-highlighted `$ <command>`,
 * clickable shortened file paths with `:line-end` ranges, and status/timing).
 */
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, Spacer, Text } from "@earendil-works/pi-tui";
import { state } from "../state.ts";
import type { Highlighter, ThemeLike } from "../style.ts";
import {
	extractToolSummaryArg,
	fg,
	formatInlineToolSummary,
	formatShellCommandCall,
	hasOuterToolSummary,
	isSettableText,
	sanitizeLineSgrForBox,
	sanitizeShellTextKeepSgr,
} from "./shell.ts";

export interface CodemodeCallRecord {
	name: string;
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	cost?: number;
	error?: string;
}

export interface ExtractedCodeCall {
	tool: string;
	args: Record<string, unknown>;
}

interface CodemodeRenderState {
	code?: string;
	extractedCalls?: ExtractedCodeCall[];
	runtimeCallCount?: number;
}

const CODEMODE_STATE = Symbol("piBetterRenderCodemode");
const SCRIPT_HEADER_RE = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;
const OPTIONS_LINE_RE = /^\s*\/\/\s*@options:\s*(\{.*\})\s*$/;
const SGR_STRIP_RE = /\x1b\[[0-9;]*m/g;
const TAG_STRIP_RE = /<\/?[A-Za-z][^>]*>/g;
const TIMER_TEXT_RE = /^(?:Took|Elapsed)\s+\d/;
const SUMMARY_META_KEYS = new Set([
	"toolSummary",
	"toolAction",
	"tool_summary",
	"tool_action",
	"waitForPreviousTools",
]);
const CALL_PREVIEW_COUNT = 6;
const COLLAPSED_BASH_MAX_LINES = 3;
const COLLAPSED_BASH_LINE_CHARS = 140;

function getTargetContainer(
	comp: unknown,
): { children: unknown[]; clear?: () => void; addChild?: (child: unknown) => void } | undefined {
	if (!comp || typeof comp !== "object") return undefined;
	const inner = (comp as { inner?: unknown }).inner;
	if (inner && typeof inner === "object" && Array.isArray((inner as { children?: unknown[] }).children)) {
		return inner as { children: unknown[]; clear?: () => void; addChild?: (child: unknown) => void };
	}
	if (Array.isArray((comp as { children?: unknown[] }).children)) {
		return comp as { children: unknown[]; clear?: () => void; addChild?: (child: unknown) => void };
	}
	return undefined;
}

function getCodemodeState(context: unknown): CodemodeRenderState | undefined {
	if (!context || typeof context !== "object") return undefined;
	const rawState = (context as { state?: unknown }).state;
	if (!rawState || typeof rawState !== "object") return undefined;
	const bag = rawState as Record<symbol, CodemodeRenderState | undefined>;
	bag[CODEMODE_STATE] ??= {};
	return bag[CODEMODE_STATE];
}

function formatDurationMs(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatTokenBudget(tokens: number): string {
	if (tokens >= 1000 && tokens % 1000 === 0) return `${tokens / 1000}k tok`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k tok`;
	return `${tokens} tok`;
}

function formatCost(cost: number): string {
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

function shortenHome(rawPath: string): string {
	const home = homedir();
	if (!home) return rawPath;
	if (rawPath === home) return "~";
	if (rawPath.startsWith(`${home}/`)) return `~${rawPath.slice(home.length)}`;
	return rawPath;
}

function formatStyledPath(rawPath: string, theme: ThemeLike, cwd?: string): string {
	const styled = fg(theme, "accent", "text", shortenHome(rawPath));
	try {
		if (!getCapabilities().hyperlinks) return styled;
		const abs = cwd ? resolvePath(cwd, rawPath) : resolvePath(rawPath);
		return hyperlink(styled, pathToFileURL(abs).href);
	} catch {
		return styled;
	}
}

function toCodemodeId(name: string): string {
	const id = name.replace(/[^A-Za-z0-9_$]/g, "_");
	return /^[0-9]/.test(id) ? `_${id}` : id;
}

/** Extract concise option badges from an optional `// @options: {...}` first line. */
export function parseCodemodeHeaderOptions(code: string): string[] {
	const firstLine = code.replace(/\r\n?/g, "\n").split("\n", 1)[0] ?? "";
	const match = OPTIONS_LINE_RE.exec(firstLine);
	if (!match) return [];
	try {
		const parsed = JSON.parse(match[1]!) as Record<string, unknown>;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
		const badges: string[] = [];
		if (typeof parsed.timeout_ms === "number" && Number.isFinite(parsed.timeout_ms)) {
			badges.push(`timeout ${formatDurationMs(parsed.timeout_ms)}`);
		}
		if (typeof parsed.max_output_tokens === "number" && Number.isFinite(parsed.max_output_tokens)) {
			badges.push(`max ${formatTokenBudget(parsed.max_output_tokens)}`);
		}
		return badges;
	} catch {
		return [];
	}
}

/** Build the header line for a `codemode` container card (`⚡ codemode · 3 calls`). */
export function formatCodemodeHeader(
	code: string | null,
	theme: ThemeLike,
	callCount?: number,
): string {
	const badge = theme.bold(fg(theme, "accent", "toolTitle", "⚡"));
	const title = theme.bold(fg(theme, "toolTitle", "text", "codemode"));
	if (code === null) {
		return `${badge} ${title} ${fg(theme, "error", "toolDiffRemoved", "[invalid arg]")}`;
	}
	const dot = fg(theme, "muted", "dim", " · ");
	const parts = [`${badge} ${title}`];
	if (typeof callCount === "number" && callCount > 0) {
		parts.push(
			fg(theme, "syntaxNumber", "muted", String(callCount)) +
				fg(theme, "muted", "dim", ` call${callCount === 1 ? "" : "s"}`),
		);
	}
	for (const opt of parseCodemodeHeaderOptions(code)) {
		parts.push(fg(theme, "muted", "dim", opt));
	}
	return parts.join(dot);
}

function unescapeJsString(raw: string): string {
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i]!;
		if (ch !== "\\" || i + 1 >= raw.length) {
			out += ch;
			continue;
		}
		const next = raw[++i]!;
		switch (next) {
			case "n":
				out += "\n";
				break;
			case "r":
				out += "\r";
				break;
			case "t":
				out += "\t";
				break;
			case "\\":
			case "'":
			case '"':
			case "`":
			case "/":
				out += next;
				break;
			case "x": {
				const hex = raw.slice(i + 1, i + 3);
				if (/^[0-9a-fA-F]{2}$/.test(hex)) {
					out += String.fromCharCode(Number.parseInt(hex, 16));
					i += 2;
				} else {
					out += next;
				}
				break;
			}
			case "u": {
				if (raw[i + 1] === "{") {
					const end = raw.indexOf("}", i + 2);
					const hex = end > i + 2 ? raw.slice(i + 2, end) : "";
					if (/^[0-9a-fA-F]{1,6}$/.test(hex)) {
						out += String.fromCodePoint(Number.parseInt(hex, 16));
						i = end;
						break;
					}
				}
				const hex = raw.slice(i + 1, i + 5);
				if (/^[0-9a-fA-F]{4}$/.test(hex)) {
					out += String.fromCharCode(Number.parseInt(hex, 16));
					i += 4;
				} else {
					out += next;
				}
				break;
			}
			default:
				out += next;
				break;
		}
	}
	return out;
}

function skipWsAndComments(src: string, pos: number): number {
	let i = pos;
	while (i < src.length) {
		const c = src[i]!;
		if (c === " " || c === "\t" || c === "\n" || c === "\r") {
			i++;
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			i += 2;
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			i = end === -1 ? src.length : end + 2;
			continue;
		}
		break;
	}
	return i;
}

function readJsQuoted(src: string, start: number, rawTemplate = false): { value: string; end: number } | undefined {
	const quote = src[start];
	if (quote !== "'" && quote !== '"' && quote !== "`") return undefined;
	let i = start + 1;
	let raw = "";
	while (i < src.length) {
		const c = src[i]!;
		if (!rawTemplate && c === "\\") {
			raw += src.slice(i, Math.min(src.length, i + 2));
			i += 2;
			continue;
		}
		if (rawTemplate && c === "\\" && src[i + 1] === "`") {
			raw += "\\`";
			i += 2;
			continue;
		}
		if (quote === "`" && c === "$" && src[i + 1] === "{") {
			// Skip balanced template expression `${...}` and insert placeholder.
			let depth = 1;
			i += 2;
			while (i < src.length && depth > 0) {
				const ch = src[i]!;
				if (ch === "'" || ch === '"' || ch === "`") {
					const inner = readJsQuoted(src, i, false);
					i = inner ? inner.end : i + 1;
					continue;
				}
				if (ch === "{") depth++;
				else if (ch === "}") depth--;
				i++;
			}
			raw += "${…}";
			continue;
		}
		if (c === quote) {
			return { value: rawTemplate ? raw : unescapeJsString(raw), end: i + 1 };
		}
		raw += c;
		i++;
	}
	return undefined;
}

function skipBalancedValue(src: string, start: number): number {
	let i = start;
	let depth = 0;
	while (i < src.length) {
		i = skipWsAndComments(src, i);
		if (i >= src.length) break;
		const c = src[i]!;
		if (depth === 0 && (c === "," || c === "}" || c === ")" || c === "]")) break;
		if (src.startsWith("String.raw`", i)) {
			const q = readJsQuoted(src, i + "String.raw".length, true);
			i = q ? q.end : i + 11;
			continue;
		}
		if (c === "'" || c === '"' || c === "`") {
			const q = readJsQuoted(src, i, false);
			i = q ? q.end : i + 1;
			continue;
		}
		if (c === "{" || c === "[" || c === "(") depth++;
		else if (c === "}" || c === "]" || c === ")") {
			if (depth === 0) break;
			depth--;
		}
		i++;
	}
	return i;
}

function parseObjectLiteralArgs(src: string, openBrace: number): { args: Record<string, unknown>; end: number } {
	const args: Record<string, unknown> = {};
	let i = openBrace + 1;
	while (i < src.length) {
		i = skipWsAndComments(src, i);
		if (i >= src.length) break;
		if (src[i] === "}") return { args, end: i + 1 };
		if (src[i] === ",") {
			i++;
			continue;
		}
		// Spread `...foo`
		if (src.startsWith("...", i)) {
			i = skipBalancedValue(src, i + 3);
			continue;
		}

		let key: string | undefined;
		if (src[i] === "'" || src[i] === '"') {
			const k = readJsQuoted(src, i, false);
			if (!k) break;
			key = k.value;
			i = k.end;
		} else {
			const idMatch = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
			if (!idMatch) {
				const next = skipBalancedValue(src, i);
				if (next <= i) break;
				i = next;
				continue;
			}
			key = idMatch[0];
			i += key.length;
		}

		i = skipWsAndComments(src, i);
		// Shorthand `{ path }` — value is a runtime variable, skip until comma/brace.
		if (src[i] !== ":") {
			const next = skipBalancedValue(src, i);
			if (next <= i) break;
			i = next;
			continue;
		}
		i = skipWsAndComments(src, i + 1);

		if (src.startsWith("String.raw`", i)) {
			const q = readJsQuoted(src, i + "String.raw".length, true);
			if (q) {
				args[key] = q.value;
				i = skipBalancedValue(src, q.end);
				continue;
			}
		}
		if (src[i] === "'" || src[i] === '"' || src[i] === "`") {
			const q = readJsQuoted(src, i, false);
			if (q) {
				const after = skipWsAndComments(src, q.end);
				if (after >= src.length || src[after] === "," || src[after] === "}") {
					args[key] = q.value;
					i = after;
					continue;
				}
			}
		}
		if (src[i] === "[") {
			// Array of string literals (e.g. `patterns: ["a", "b"]`)
			let j = i + 1;
			const items: string[] = [];
			let allStrings = true;
			while (j < src.length) {
				j = skipWsAndComments(src, j);
				if (src[j] === "]") {
					j++;
					break;
				}
				if (src[j] === ",") {
					j++;
					continue;
				}
				if (src[j] === "'" || src[j] === '"' || src[j] === "`") {
					const q = readJsQuoted(src, j, false);
					if (q) {
						items.push(q.value);
						j = q.end;
						continue;
					}
				}
				allStrings = false;
				break;
			}
			if (allStrings) {
				args[key] = items;
				i = skipBalancedValue(src, j);
				continue;
			}
		}
		const litMatch = /^(?:true|false|-?\d+(?:\.\d+)?)\b/.exec(src.slice(i));
		if (litMatch) {
			const rawLit = litMatch[0];
			const after = skipWsAndComments(src, i + rawLit.length);
			if (after >= src.length || src[after] === "," || src[after] === "}") {
				args[key] = rawLit === "true" ? true : rawLit === "false" ? false : Number(rawLit);
				i = after;
				continue;
			}
		}
		const next = skipBalancedValue(src, i);
		if (next <= i) break;
		i = next;
	}
	return { args, end: i };
}

/**
 * Extract `tools.<name>({ ... })` calls and their literal arguments directly from
 * `args.code` so nested `toolSummary`, `command`, and `path` values stay intact
 * even when Pi's `execute.js` truncates `details.calls[].args` at 200 chars.
 */
export function extractCallsFromCode(code: string): ExtractedCodeCall[] {
	const calls: ExtractedCodeCall[] = [];
	let i = 0;
	while (i < code.length) {
		i = skipWsAndComments(code, i);
		if (i >= code.length) break;
		if (code.startsWith("String.raw`", i)) {
			const q = readJsQuoted(code, i + "String.raw".length, true);
			i = q ? q.end : i + 11;
			continue;
		}
		const c = code[i]!;
		if (c === "'" || c === '"' || c === "`") {
			const q = readJsQuoted(code, i, false);
			i = q ? q.end : i + 1;
			continue;
		}
		if (
			code.startsWith("tools.", i) &&
			(i === 0 || !/[A-Za-z0-9_$]/.test(code[i - 1]!))
		) {
			const afterDot = i + "tools.".length;
			const idMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(code.slice(afterDot));
			if (idMatch) {
				const tool = idMatch[1]!;
				const openParen = skipWsAndComments(code, afterDot + tool.length);
				if (code[openParen] === "(") {
					const argStart = skipWsAndComments(code, openParen + 1);
					if (code[argStart] === "{") {
						const parsed = parseObjectLiteralArgs(code, argStart);
						calls.push({ tool, args: parsed.args });
					} else {
						calls.push({ tool, args: {} });
					}
					i = openParen + 1;
					continue;
				}
			}
		}
		i++;
	}
	return calls;
}

/** Parse `details.calls[].args` JSON, tolerating Pi's 200-char truncation (`...` / `…`). */
export function parseCallArgsLenient(rawArgs: string): {
	parsed: Record<string, unknown>;
	truncatedKeys: Set<string>;
} {
	const truncatedKeys = new Set<string>();
	const trimmed = rawArgs.trim();
	if (!trimmed) return { parsed: {}, truncatedKeys };
	try {
		const val = JSON.parse(trimmed);
		if (val && typeof val === "object" && !Array.isArray(val)) {
			return { parsed: val as Record<string, unknown>, truncatedKeys };
		}
		return { parsed: {}, truncatedKeys };
	} catch {
		// Fall through to lenient extraction on truncated JSON previews.
	}

	const wasClipped = trimmed.endsWith("...") || trimmed.endsWith("…");
	const body = trimmed.replace(/(?:\.\.\.|…)$/, "");
	if (!body.startsWith("{")) return { parsed: {}, truncatedKeys };

	const parsed: Record<string, unknown> = {};
	let i = 1;
	while (i < body.length) {
		while (i < body.length && (body[i] === " " || body[i] === "," || body[i] === "\n")) i++;
		if (body[i] !== '"') break;
		const keyQ = readJsQuoted(body, i, false);
		if (!keyQ) break;
		const key = keyQ.value;
		i = keyQ.end;
		while (i < body.length && body[i] === " ") i++;
		if (body[i] !== ":") break;
		i++;
		while (i < body.length && body[i] === " ") i++;
		if (i >= body.length) break;

		if (body[i] === '"') {
			const valQ = readJsQuoted(body, i, false);
			if (valQ) {
				parsed[key] = valQ.value;
				i = valQ.end;
				continue;
			}
			// Truncated mid-string at the end of the 200-char preview
			const partial = unescapeJsString(body.slice(i + 1).replace(/\\$/, ""));
			parsed[key] = partial;
			if (wasClipped) truncatedKeys.add(key);
			break;
		}
		const primMatch = /^(?:true|false|null|-?\d+(?:\.\d+)?)/.exec(body.slice(i));
		if (primMatch) {
			const tok = primMatch[0];
			parsed[key] = tok === "true" ? true : tok === "false" ? false : tok === "null" ? null : Number(tok);
			i += tok.length;
			continue;
		}
		// Nested object/array inside truncated JSON: skip balanced region if complete.
		const next = skipBalancedValue(body, i);
		if (next <= i) break;
		const slice = body.slice(i, next);
		try {
			parsed[key] = JSON.parse(slice);
		} catch {
			// ignore truncated nested structure
		}
		i = next;
	}
	return { parsed, truncatedKeys };
}

function resolveMergedCallArgs(
	call: CodemodeCallRecord,
	extracted: readonly ExtractedCodeCall[],
	usedIndices: Set<number>,
): Record<string, unknown> {
	const { parsed: runtimeArgs, truncatedKeys } = parseCallArgsLenient(call.args ?? "");
	const callId = toCodemodeId(call.name);
	const candidates: number[] = [];
	for (let idx = 0; idx < extracted.length; idx++) {
		if (usedIndices.has(idx)) continue;
		const item = extracted[idx]!;
		if (item.tool === call.name || item.tool === callId) {
			candidates.push(idx);
		}
	}

	let bestIdx: number | undefined;
	for (const idx of candidates) {
		const codeArgs = extracted[idx]!.args;
		let compatible = true;
		for (const [k, rv] of Object.entries(runtimeArgs)) {
			if (SUMMARY_META_KEYS.has(k) || !(k in codeArgs)) continue;
			const cv = codeArgs[k];
			if (typeof rv === "string" && typeof cv === "string") {
				if (truncatedKeys.has(k) ? !cv.startsWith(rv) : cv !== rv) {
					compatible = false;
					break;
				}
			} else if (typeof rv === "number" && typeof cv === "number" && rv !== cv) {
				compatible = false;
				break;
			}
		}
		if (compatible) {
			bestIdx = idx;
			break;
		}
	}
	if (bestIdx === undefined && candidates.length === 1) {
		bestIdx = candidates[0];
	}
	if (bestIdx === undefined) return runtimeArgs;

	usedIndices.add(bestIdx);
	const merged: Record<string, unknown> = { ...extracted[bestIdx]!.args };
	for (const [k, rv] of Object.entries(runtimeArgs)) {
		if (
			truncatedKeys.has(k) &&
			typeof rv === "string" &&
			typeof merged[k] === "string" &&
			(merged[k] as string).startsWith(rv)
		) {
			continue;
		}
		merged[k] = rv;
	}
	return merged;
}

function formatStatusIcon(status: CodemodeCallRecord["status"], theme: ThemeLike): string {
	switch (status) {
		case "running":
			return theme.bold(fg(theme, "warning", "accent", "…"));
		case "ok":
			return theme.bold(fg(theme, "success", "toolDiffAdded", "✓"));
		case "error":
			return theme.bold(fg(theme, "error", "toolDiffRemoved", "✗"));
		case "cancelled":
			return fg(theme, "muted", "dim", "⊘");
	}
}

function pickStr(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const k of keys) {
		const v = args[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

function pickNum(args: Record<string, unknown>, keys: readonly string[]): number | undefined {
	for (const k of keys) {
		const v = args[k];
		if (typeof v === "number" && Number.isFinite(v)) return v;
	}
	return undefined;
}

function formatReadRange(offset: number | undefined, limit: number | undefined): string {
	if (offset === undefined && limit === undefined) return "";
	const start = offset ?? 1;
	if (limit === undefined) return `:${start}`;
	const end = start + limit - 1;
	return `:${start}${end >= start ? `-${end}` : ""}`;
}

function formatToolDisplayName(rawName: string): string {
	const mcpMatch = /^mcp__(.+?)__(.+)$/.exec(rawName);
	if (mcpMatch) return `${mcpMatch[1]}/${mcpMatch[2]}`;
	if (rawName.startsWith("tools.")) return rawName.slice("tools.".length);
	return rawName;
}

function formatGenericCallBody(
	label: string,
	args: Record<string, unknown>,
	rawFallback: string,
	expanded: boolean,
	theme: ThemeLike,
): string {
	const title = theme.bold(fg(theme, "toolTitle", "text", label));
	const entries = Object.entries(args).filter(
		([k, v]) => !SUMMARY_META_KEYS.has(k) && v !== undefined && v !== null && v !== "",
	);
	if (entries.length === 0) {
		if (rawFallback && !rawFallback.trim().startsWith("{")) {
			return `${title} ${fg(theme, "accent", "muted", rawFallback.trim())}`;
		}
		return title;
	}
	const maxEntries = expanded ? entries.length : 3;
	const parts = entries.slice(0, maxEntries).map(([k, v]) => {
		let valStr: string;
		if (typeof v === "string") {
			const clean = v.replace(/\s+/g, " ").trim();
			valStr =
				!expanded && clean.length > 48 ? `"${clean.slice(0, 45)}…"` : `"${clean}"`;
		} else if (Array.isArray(v)) {
			const joined = v.map(String).join(", ");
			valStr = `[${!expanded && joined.length > 40 ? `${joined.slice(0, 37)}…` : joined}]`;
		} else {
			const s = JSON.stringify(v) ?? String(v);
			valStr = !expanded && s.length > 32 ? `${s.slice(0, 29)}…` : s;
		}
		return `${fg(theme, "toolOutput", "muted", k)} ${fg(theme, "accent", "text", valStr)}`;
	});
	let tail = parts.join(fg(theme, "muted", "dim", ", "));
	if (entries.length > maxEntries) tail += fg(theme, "muted", "dim", " …");
	return `${title} ${tail}`;
}

/** Format one nested call to look like Pi's native single tool call (`$ cmd`, `read path:1-50`, etc.). */
export function formatSingleNestedCallBody(
	rawName: string,
	args: Record<string, unknown>,
	rawArgsFallback: string,
	expanded: boolean,
	theme: ThemeLike,
	highlight?: Highlighter,
	cwd?: string,
): string {
	const cleanName = rawName.startsWith("tools.") ? rawName.slice("tools.".length) : rawName;

	if (cleanName === "bash" || cleanName === "powershell") {
		const rawCmd = pickStr(args, ["command", "cmd"]);
		if (rawCmd) {
			const lines = rawCmd.replace(/\r\n?/g, "\n").split("\n");
			let displayCmd = lines.join("\n");
			let hiddenLines = 0;
			if (!expanded) {
				const clipped = lines.slice(0, COLLAPSED_BASH_MAX_LINES).map((line) =>
					line.length > COLLAPSED_BASH_LINE_CHARS
						? `${line.slice(0, COLLAPSED_BASH_LINE_CHARS - 1)}…`
						: line,
				);
				hiddenLines = Math.max(0, lines.length - COLLAPSED_BASH_MAX_LINES);
				displayCmd = clipped.join("\n");
			}
			const prompt = cleanName === "powershell" ? "PS>" : "$";
			const lang = cleanName === "powershell" ? "powershell" : "bash";
			const formatted =
				formatShellCommandCall(
					{ command: displayCmd, timeout: pickNum(args, ["timeout"]) },
					prompt,
					lang,
					theme,
					highlight,
				) ?? `${theme.bold(fg(theme, "accent", "toolTitle", prompt))} ${displayCmd}`;
			const indented = formatted
				.split("\n")
				.map((l, idx) => (idx === 0 ? l : `  ${l}`))
				.join("\n");
			return hiddenLines > 0
				? `${indented}\n  ${fg(theme, "muted", "dim", `… (+${hiddenLines} lines)`)}`
				: indented;
		}
	}

	if (cleanName === "read") {
		const p = pickStr(args, ["path", "file_path"]);
		if (p) {
			const range = formatReadRange(pickNum(args, ["offset"]), pickNum(args, ["limit"]));
			const rangeStyled = range ? fg(theme, "warning", "syntaxNumber", range) : "";
			return `${theme.bold(fg(theme, "toolTitle", "text", "read"))} ${formatStyledPath(p, theme, cwd)}${rangeStyled}`;
		}
	}

	if (cleanName === "write" || cleanName === "edit") {
		const p = pickStr(args, ["path", "file_path"]);
		if (p) {
			const editsCount = Array.isArray(args.edits) ? args.edits.length : 0;
			const suffix =
				cleanName === "edit" && editsCount > 1
					? fg(theme, "muted", "dim", ` (${editsCount} edits)`)
					: "";
			return `${theme.bold(fg(theme, "toolTitle", "text", cleanName))} ${formatStyledPath(p, theme, cwd)}${suffix}`;
		}
	}

	const displayName = formatToolDisplayName(cleanName);

	if (
		cleanName === "grep" ||
		cleanName === "find" ||
		/^mcp__[^_]+__(?:grep|find_files|multi_grep)$/.test(cleanName)
	) {
		const label = theme.bold(fg(theme, "toolTitle", "text", displayName));
		const patterns = Array.isArray(args.patterns) ? args.patterns.map(String) : undefined;
		const query =
			pickStr(args, ["query", "pattern"]) ?? (patterns && patterns.length > 0 ? patterns.join(" | ") : undefined);
		const constraints = pickStr(args, ["constraints"]);
		const searchPath = pickStr(args, ["path", "directory"]);
		if (query || searchPath) {
			const qPart = query ? ` ${fg(theme, "accent", "text", `"${query}"`)}` : "";
			const cPart = constraints ? ` ${fg(theme, "warning", "muted", constraints)}` : "";
			const pPart = searchPath
				? `${fg(theme, "muted", "toolOutput", " in ")}${formatStyledPath(searchPath, theme, cwd)}`
				: "";
			return `${label}${qPart}${cPart}${pPart}`;
		}
	}

	if (
		cleanName === "web_search" ||
		cleanName === "x_search" ||
		cleanName === "source_check" ||
		cleanName === "fetch_content" ||
		cleanName === "get_search_content"
	) {
		const label = theme.bold(fg(theme, "toolTitle", "text", displayName));
		const queries = Array.isArray(args.queries) ? args.queries.map(String) : undefined;
		const urls = Array.isArray(args.urls) ? args.urls.map(String) : undefined;
		const primary =
			pickStr(args, ["query", "claim", "url", "findText", "responseId"]) ??
			(queries && queries.length > 0 ? queries.join(" | ") : undefined) ??
			(urls && urls.length > 0 ? urls.join(", ") : undefined);
		if (primary) {
			const shown = !expanded && primary.length > 80 ? `${primary.slice(0, 77)}…` : primary;
			return `${label} ${fg(theme, "accent", "text", `"${shown}"`)}`;
		}
	}

	return formatGenericCallBody(displayName, args, rawArgsFallback, expanded, theme);
}

/**
 * Format all nested `details.calls` inside the `codemode` card so each call
 * renders like an individual Pi tool call with optional Codex-style `toolSummary`.
 */
export function formatCodemodeCalls(
	calls: readonly CodemodeCallRecord[],
	expanded: boolean,
	theme: ThemeLike,
	highlight?: Highlighter,
	options?: {
		extractedCalls?: readonly ExtractedCodeCall[];
		hintLine?: string;
		cwd?: string;
	},
): string {
	const extracted = options?.extractedCalls ?? [];
	const usedIndices = new Set<number>();
	// Resolve in full chronological order first so collapsed slices still match accurate indices!
	const resolvedList = calls.map((call) => ({
		call,
		mergedArgs: resolveMergedCallArgs(call, extracted, usedIndices),
	}));

	const shown = expanded ? resolvedList : resolvedList.slice(-CALL_PREVIEW_COUNT);
	let hasMultiLineItem = false;

	const renderedItems = shown.map(({ call, mergedArgs }) => {
		const summary = extractToolSummaryArg(mergedArgs);
		const body = formatSingleNestedCallBody(
			call.name,
			mergedArgs,
			call.args ?? "",
			expanded,
			theme,
			highlight,
			options?.cwd,
		);
		const duration = formatDurationMs(call.durationMs);
		const metaParts: string[] = [];
		if (duration) metaParts.push(fg(theme, "dim", "muted", duration));
		if (call.cost) metaParts.push(fg(theme, "syntaxNumber", "muted", formatCost(call.cost)));
		const metaSuffix = metaParts.length > 0 ? `  ${metaParts.join(" ")}` : "";

		const bodyLines = body.split("\n");
		bodyLines[bodyLines.length - 1] = `${bodyLines[bodyLines.length - 1]}${metaSuffix}`;
		const callLine = `${formatStatusIcon(call.status, theme)} ${bodyLines.join("\n")}`;

		const itemLines: string[] = [];
		if (summary) {
			hasMultiLineItem = true;
			itemLines.push(`  ${formatInlineToolSummary(summary, theme)}`);
		}
		if (bodyLines.length > 1) hasMultiLineItem = true;
		itemLines.push(callLine);

		if (call.error && (expanded || call.status === "error")) {
			hasMultiLineItem = true;
			const rawErrLines = call.error.replace(/\r\n?/g, "\n").trim().split("\n");
			const errSlice = expanded ? rawErrLines : rawErrLines.slice(0, 2);
			for (let idx = 0; idx < errSlice.length; idx++) {
				const prefix = idx === 0 ? "  ↳ " : "    ";
				itemLines.push(fg(theme, "error", "toolDiffRemoved", `${prefix}${errSlice[idx]}`));
			}
			if (!expanded && rawErrLines.length > 2) {
				itemLines.push(fg(theme, "muted", "dim", `    … (+${rawErrLines.length - 2} lines)`));
			}
		}

		return itemLines.join("\n");
	});

	const blocks: string[] = [];
	if (shown.length < resolvedList.length && options?.hintLine) {
		blocks.push(options.hintLine);
	}
	blocks.push(renderedItems.join(hasMultiLineItem ? "\n\n" : "\n"));

	const priced = calls.filter((call) => typeof call.cost === "number" && call.cost > 0);
	if (priced.length > 1) {
		const total = priced.reduce((sum, call) => sum + (call.cost ?? 0), 0);
		blocks.push(
			`${fg(theme, "muted", "dim", "Model calls: ")}${fg(theme, "syntaxNumber", "muted", formatCost(total))}`,
		);
	}
	return blocks.join("\n\n");
}

/** Colorize script-level errors when `codemode` itself fails (`isError: true`). */
export function colorizeCodemodeError(rawOutput: string, theme: ThemeLike): string {
	if (!rawOutput) return "";
	const idx = rawOutput.indexOf("Script error:");
	const relevant = idx >= 0 ? rawOutput.slice(idx) : rawOutput;
	return relevant
		.split("\n")
		.map((line) => {
			if (!line) return "";
			if (/\x1b\[[0-9;]*m/.test(line)) return sanitizeLineSgrForBox(line);
			if (line.startsWith("Script error:")) {
				const msg = line.slice("Script error:".length);
				return (
					theme.bold(fg(theme, "error", "toolDiffRemoved", "Script error:")) +
					fg(theme, "error", "text", msg)
				);
			}
			const stackAt = /^(\s+at\s+)(.+?)(:\d+(?::\d+)?)(\)?)$/.exec(line);
			if (stackAt) {
				return (
					fg(theme, "muted", "dim", stackAt[1]!) +
					fg(theme, "error", "text", stackAt[2]!) +
					fg(theme, "syntaxNumber", "muted", stackAt[3]!) +
					fg(theme, "muted", "dim", stackAt[4]!)
				);
			}
			return fg(theme, "error", "toolOutput", line);
		})
		.join("\n");
}

function extractCodemodeOutputText(
	result: { content?: Array<{ type?: string; text?: string }> } | undefined,
): string {
	if (!result || !Array.isArray(result.content)) return "";
	const [first, ...rest] = result.content;
	const hasHeader =
		first?.type === "text" && typeof first.text === "string" && SCRIPT_HEADER_RE.test(first.text);
	const items = hasHeader ? rest : result.content;
	return items
		.filter((c) => c?.type === "text")
		.map((c) => sanitizeShellTextKeepSgr(c.text || ""))
		.join("\n")
		.trim()
		.replace(/\t/g, "   ");
}

function getComponentText(comp: unknown): string | undefined {
	if (!comp || typeof comp !== "object") return undefined;
	const text = (comp as { text?: unknown }).text;
	return typeof text === "string" ? text : undefined;
}

function isTimerTextComponent(comp: unknown): boolean {
	const raw = getComponentText(comp);
	if (!raw) return false;
	const plain = raw.replace(SGR_STRIP_RE, "").replace(TAG_STRIP_RE, "").trim();
	return TIMER_TEXT_RE.test(plain);
}

/**
 * Create a Pi `ToolRendererResolver` that renders `codemode` as a clean container
 * frame holding individual single-tool-call items (with per-call `toolSummary`s),
 * hiding both raw JavaScript glue code and raw return values (`tuiText`).
 */
export function createCodemodeToolRendererResolver(
	getHighlighter: () => Highlighter,
): ToolRendererResolver {
	return (toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined => {
		const base = next();
		if (toolName !== "codemode" || !base) {
			return base;
		}

		return {
			renderShell: base.renderShell,
			renderCall: base.renderCall
				? (args, theme, context) => {
						const comp = base.renderCall!(args, theme, context);
						if (!state.enabled || !state.shell) return comp;
						try {
							const container = getTargetContainer(comp);
							if (!container || container.children.length === 0) return comp;

							const rec = args && typeof args === "object" ? (args as { code?: unknown }) : undefined;
							const code = typeof rec?.code === "string" ? rec.code : null;
							const renderState = getCodemodeState(context);
							let extractedCalls: ExtractedCodeCall[] = [];
							if (code !== null) {
								if (renderState && renderState.code === code && renderState.extractedCalls) {
									extractedCalls = renderState.extractedCalls;
								} else {
									extractedCalls = extractCallsFromCode(code);
									if (renderState) {
										renderState.code = code;
										renderState.extractedCalls = extractedCalls;
									}
								}
							}

							const count =
								renderState?.runtimeCallCount !== undefined
									? context?.isPartial
										? Math.max(renderState.runtimeCallCount, extractedCalls.length)
										: renderState.runtimeCallCount
									: extractedCalls.length;
							const header = formatCodemodeHeader(code, theme as ThemeLike, count);
							const inlineSummary = !hasOuterToolSummary(comp)
								? extractToolSummaryArg(args)
								: undefined;
							const titleText = inlineSummary
								? `${formatInlineToolSummary(inlineSummary, theme as ThemeLike)}\n\n${header}`
								: header;

							if (isSettableText(container.children[0])) {
								container.children[0].setText(titleText);
							}
							// Hide raw JavaScript source inside the codemode card.
							if (container.children.length > 1) {
								container.children.splice(1);
							}
							(comp as { invalidate?: () => void }).invalidate?.();
						} catch {
							// Never break Pi's built-in call rendering.
						}
						return comp;
					}
				: undefined,
			renderResult: base.renderResult
				? (result, options, theme, context) => {
						const comp = base.renderResult!(result, options, theme, context);
						if (!comp || !state.enabled || !state.shell) return comp;
						try {
							const container = getTargetContainer(comp);
							if (!container) return comp;

							const details = result.details as { calls?: CodemodeCallRecord[] } | undefined;
							const calls = Array.isArray(details?.calls) ? details!.calls! : [];
							const renderState = getCodemodeState(context);
							if (renderState && calls.length > 0) {
								renderState.runtimeCallCount = calls.length;
							}

							// Preserve Pi's localized `... (N earlier calls, <keyHint>)` line & bottom timer if present.
							const firstTextComp = container.children.find((c) => isSettableText(c));
							const firstLine = (getComponentText(firstTextComp) ?? "").split("\n", 1)[0];
							const hintLine =
								firstLine && firstLine.includes("earlier calls") ? firstLine : undefined;
							const lastChild = container.children[container.children.length - 1];
							const timerComp = isTimerTextComponent(lastChild) ? lastChild : undefined;

							const cwd =
								context && typeof (context as { cwd?: unknown }).cwd === "string"
									? (context as { cwd: string }).cwd
									: undefined;

							const nextChildren: unknown[] = [];
							if (calls.length > 0) {
								const callsText = formatCodemodeCalls(
									calls,
									Boolean(options?.expanded),
									theme as ThemeLike,
									getHighlighter(),
									{
										extractedCalls: renderState?.extractedCalls,
										hintLine,
										cwd,
									},
								);
								nextChildren.push(new Spacer(1));
								nextChildren.push(new Text(callsText, 0, 0));
							}

							// Suppress normal script return output (`tuiText` / JSON blobs); only surface script crashes.
							if (Boolean(context?.isError) && !options?.isPartial) {
								const errRaw = extractCodemodeOutputText(result);
								if (errRaw) {
									nextChildren.push(new Spacer(1));
									nextChildren.push(
										new Text(colorizeCodemodeError(errRaw, theme as ThemeLike), 0, 0),
									);
								}
							}

							if (timerComp) {
								nextChildren.push(new Spacer(1));
								nextChildren.push(timerComp);
							}

							container.children.splice(0, container.children.length, ...nextChildren);
							(comp as { invalidate?: () => void }).invalidate?.();
						} catch {
							// Never break Pi's built-in result rendering.
						}
						return comp;
					}
				: undefined,
		};
	};
}
