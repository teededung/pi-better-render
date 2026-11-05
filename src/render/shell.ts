/**
 * Rich terminal coloring for Pi's `bash` and `powershell` tool cards.
 *
 * When commands run inside non-TTY pipes (`git status -s && git diff --stat`,
 * `git diff`, `git log --oneline`, test runners, JSON APIs, compilers), CLI
 * tools disable ANSI colors and Pi's default bash renderer paints every line
 * in flat `toolOutput` gray (also stripping any genuine SGR colors emitted by
 * `--color=always` tools).
 *
 * This module wraps Pi's shell `ToolRenderers` via `pi.registerToolRenderer`:
 *   - Syntax-highlights `$ <command>` / `PS> <command>` while preserving both
 *     Pi's execution timer and outer call wrappers (such as `pi-agy`'s
 *     `toolSummary` header).
 *   - Preserves genuine foreground SGR escapes (without letting `\x1b[0m` or
 *     background codes punch holes in the tool card's `toolSuccessBg`), and
 *     semantically colors plain `git diff --stat`, `git status -s`, unified
 *     diffs, `git log`/`commit`/`push`, test results, JSON, and diagnostics.
 */
import type { ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { state } from "../state.ts";
import type { Highlighter, ThemeLike } from "../style.ts";

interface SettableText {
	setText(text: string): void;
}

function isSettableText(value: unknown): value is SettableText {
	return Boolean(value && typeof value === "object" && typeof (value as SettableText).setText === "function");
}

// Strip OSC, DCS/APC, and non-SGR CSI sequences while keeping `\x1b[...m` SGR codes.
const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const DCS_RE = /\x1b[P^_][\s\S]*?\x1b\\/g;
const NON_SGR_CSI_RE = /\x1b\[[0-9;?]*[A-LN-Za-ln-z]/g;
const SINGLE_ESC_RE = /\x1b[@-Z\\-_]/g;
const SGR_RE = /\x1b\[([0-9;]*)m/g;
const ANY_SGR_RE = /\x1b\[[0-9;]*m/;

/** Reset bold/italic/underline/strike/fg without resetting the tool card's background (`49`). */
const SAFE_ATTR_FG_RESET = "\x1b[22;23;24;29;39m";

function fg(theme: ThemeLike, color: string, fallback: string, text: string): string {
	if (!text) return "";
	try {
		return theme.fg(color, text);
	} catch {
		try {
			return theme.fg(fallback, text);
		} catch {
			return text;
		}
	}
}

function stripSgr(text: string): string {
	return text.replace(SGR_RE, "");
}

/**
 * Remove terminal control sequences except SGR (`\x1b[...m`), normalize CR/LF,
 * and drop binary control bytes so raw tool text is safe to render in TUI boxes.
 */
export function sanitizeShellTextKeepSgr(text: string): string {
	const cleaned = text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "")
		.replace(OSC_RE, "")
		.replace(DCS_RE, "")
		.replace(NON_SGR_CSI_RE, "")
		.replace(SINGLE_ESC_RE, "");
	let out = "";
	for (let i = 0; i < cleaned.length; i++) {
		const code = cleaned.charCodeAt(i);
		if (code === 0x09 || code === 0x0a || code === 0x1b || (code >= 0x20 && code !== 0x7f)) {
			out += cleaned[i];
		}
	}
	return out;
}

/**
 * Keep foreground/style SGR codes intact while stripping background SGR codes
 * (`40..47`, `48;...`, `49`, `100..107`) and rewriting `\x1b[0m` so the outer
 * tool `Box` background (`toolPendingBg` / `toolSuccessBg` / `toolErrorBg`)
 * stays seamless across the entire card width.
 */
export function sanitizeLineSgrForBox(line: string): string {
	const rewritten = line.replace(SGR_RE, (_full, rawParams: string) => {
		if (!rawParams) return SAFE_ATTR_FG_RESET;
		const parts = rawParams.split(";").map((p) => Number.parseInt(p, 10));
		const kept: number[] = [];
		for (let i = 0; i < parts.length; i++) {
			const code = parts[i];
			if (!Number.isFinite(code) || code === 0) {
				kept.push(22, 23, 24, 29, 39);
				continue;
			}
			// Extended foreground `38;5;N` or `38;2;R;G;B` — keep whole tuple.
			if (code === 38) {
				const mode = parts[i + 1];
				if (mode === 5 && i + 2 < parts.length) {
					kept.push(38, 5, parts[i + 2]!);
					i += 2;
					continue;
				}
				if (mode === 2 && i + 4 < parts.length) {
					kept.push(38, 2, parts[i + 2]!, parts[i + 3]!, parts[i + 4]!);
					i += 4;
					continue;
				}
			}
			// Extended background `48;5;N` or `48;2;R;G;B` — skip whole tuple.
			if (code === 48) {
				const mode = parts[i + 1];
				if (mode === 5) i += 2;
				else if (mode === 2) i += 4;
				continue;
			}
			// Standard/bright background or bg-reset (`40..47`, `49`, `100..107`) or inverse (`7`) — drop.
			if ((code >= 40 && code <= 49) || (code >= 100 && code <= 107) || code === 7) {
				continue;
			}
			kept.push(code);
		}
		return kept.length > 0 ? `\x1b[${kept.join(";")}m` : "";
	});
	return rewritten ? `${rewritten}${SAFE_ATTR_FG_RESET}` : rewritten;
}

function colorizeStatPath(pathPart: string, theme: ThemeLike): string {
	// Highlight `{old => new}` or `old => new` rename segments in `git diff --stat`.
	const braceRename = /^(.*?)(\{[^{}]*=>[^{}]*\})(.*)$/.exec(pathPart);
	if (braceRename) {
		return (
			fg(theme, "text", "toolOutput", braceRename[1]!) +
			fg(theme, "accent", "warning", braceRename[2]!) +
			fg(theme, "text", "toolOutput", braceRename[3]!)
		);
	}
	const arrowIdx = pathPart.indexOf(" => ");
	if (arrowIdx !== -1) {
		return (
			fg(theme, "muted", "toolOutput", pathPart.slice(0, arrowIdx)) +
			fg(theme, "muted", "toolOutput", " => ") +
			fg(theme, "accent", "text", pathPart.slice(arrowIdx + 4))
		);
	}
	return fg(theme, "text", "toolOutput", pathPart);
}

function colorizeGitStatusCode(ch: string, isIndex: boolean, theme: ThemeLike): string {
	if (ch === " ") return " ";
	if (ch === "?") return fg(theme, "warning", "accent", ch);
	if (ch === "!") return fg(theme, "muted", "dim", ch);
	if (ch === "U") return theme.bold(fg(theme, "error", "toolDiffRemoved", ch));
	if (ch === "D") return theme.bold(fg(theme, "toolDiffRemoved", "error", ch));
	if (ch === "A") return theme.bold(fg(theme, "toolDiffAdded", "success", ch));
	if (ch === "R" || ch === "C") return theme.bold(fg(theme, "accent", "warning", ch));
	if (ch === "M" || ch === "T") {
		return theme.bold(
			isIndex ? fg(theme, "toolDiffAdded", "success", ch) : fg(theme, "warning", "accent", ch),
		);
	}
	return fg(theme, "accent", "toolOutput", ch);
}

/**
 * Format `$ <command>` / `PS> <command>` with syntax highlighting while keeping
 * unhighlighted words bold in `toolTitle`.
 */
export function formatShellCommandCall(
	args: { command?: unknown; timeout?: unknown } | undefined,
	prompt: string,
	lang: "bash" | "powershell",
	theme: ThemeLike,
	highlight?: Highlighter,
): string | undefined {
	if (!args || typeof args.command !== "string" || !args.command.trim()) {
		return undefined;
	}
	const command = args.command;
	const timeoutSuffix =
		typeof args.timeout === "number" && Number.isFinite(args.timeout)
			? fg(theme, "muted", "dim", ` (timeout ${args.timeout}s)`)
			: "";
	const promptDisplay = theme.bold(fg(theme, "accent", "toolTitle", prompt));

	let titleOpen = "";
	try {
		titleOpen = theme.getFgAnsi("toolTitle");
	} catch {
		titleOpen = "";
	}

	const highlighted = highlight?.(command, lang);
	let commandDisplay: string;
	if (highlighted && highlighted.length > 0) {
		commandDisplay = highlighted
			.map((line) => {
				const safeLine = sanitizeLineSgrForBox(line);
				const withTitleFallback = titleOpen
					? `${titleOpen}${safeLine.replace(/\x1b\[39m/g, `\x1b[39m${titleOpen}`)}\x1b[39m`
					: safeLine;
				return theme.bold(withTitleFallback);
			})
			.join("\n");
	} else {
		commandDisplay = fg(theme, "toolTitle", "text", theme.bold(command));
	}

	return `${promptDisplay} ${commandDisplay}${timeoutSuffix}`;
}

/**
 * Colorize shell stdout/stderr text for display inside a TUI tool box.
 * Never mutates the underlying tool result sent to the LLM.
 */
export function colorizeShellOutput(
	rawOutput: string,
	theme: ThemeLike,
	highlight?: Highlighter,
): string {
	if (!rawOutput) return "";

	// Whole-output pretty/minified JSON response (e.g. `curl`, `jq`, `gh api`)
	if (!ANY_SGR_RE.test(rawOutput) && rawOutput.length >= 2 && rawOutput.length <= 32_768 && highlight) {
		const trimmed = rawOutput.trim();
		if (
			(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
			(trimmed.startsWith("[") && trimmed.endsWith("]"))
		) {
			try {
				JSON.parse(trimmed);
				const jsonLines = highlight(rawOutput, "json");
				if (jsonLines && jsonLines.length > 0) {
					return jsonLines.map(sanitizeLineSgrForBox).join("\n");
				}
			} catch {
				// Not valid JSON — fall through to line-level rules.
			}
		}
	}

	const lines = rawOutput.split("\n");
	const out: string[] = [];
	let inUnifiedDiff = false;

	for (const line of lines) {
		if (!line) {
			out.push("");
			continue;
		}

		// 0. Genuine CLI SGR output (`--color=always`, Force-colored tools): keep colors box-safe.
		if (ANY_SGR_RE.test(line)) {
			out.push(sanitizeLineSgrForBox(line));
			continue;
		}

		// 1. Unified diff headers (`git diff`, `git show`, `diff -u`)
		if (line.startsWith("diff --git ")) {
			inUnifiedDiff = true;
			out.push(theme.bold(fg(theme, "accent", "text", line)));
			continue;
		}
		if (
			/^(?:index [0-9a-f]{7,}\.\.[0-9a-f]{7,}|(?:new|deleted|old) (?:file )?mode \d+|(?:dis)?similarity index \d+%|rename (?:from|to) |copy (?:from|to) |Binary files .+ differ)/.test(
				line,
			)
		) {
			inUnifiedDiff = true;
			out.push(fg(theme, "muted", "toolOutput", line));
			continue;
		}
		if (/^---\s+(?:a\/|\S)/.test(line)) {
			inUnifiedDiff = true;
			out.push(theme.bold(fg(theme, "toolDiffRemoved", "error", line)));
			continue;
		}
		if (/^\+\+\+\s+(?:b\/|\S)/.test(line)) {
			inUnifiedDiff = true;
			out.push(theme.bold(fg(theme, "toolDiffAdded", "success", line)));
			continue;
		}
		const hunkMatch = /^(@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@)(.*)$/.exec(line);
		if (hunkMatch) {
			inUnifiedDiff = true;
			out.push(
				fg(theme, "accent", "warning", hunkMatch[1]!) +
					(hunkMatch[2] ? fg(theme, "muted", "toolOutput", hunkMatch[2]) : ""),
			);
			continue;
		}
		if (inUnifiedDiff) {
			if (line.startsWith("+")) {
				out.push(fg(theme, "toolDiffAdded", "success", line));
				continue;
			}
			if (line.startsWith("-")) {
				out.push(fg(theme, "toolDiffRemoved", "error", line));
				continue;
			}
			if (line.startsWith("\\ ")) {
				out.push(fg(theme, "muted", "toolOutput", line));
				continue;
			}
			if (line.startsWith(" ")) {
				out.push(fg(theme, "toolDiffContext", "toolOutput", line));
				continue;
			}
			inUnifiedDiff = false;
		}

		// 2. `git diff --stat` histogram row: ` src/provider.ts | 145 +++++++---`
		const statMatch = /^(\s*)(.+?)(\s+\|\s+)(\d+)(\s*)(\+*)(-*)\s*$/.exec(line);
		if (
			statMatch &&
			(statMatch[6]!.length > 0 || statMatch[7]!.length > 0 || statMatch[4] === "0")
		) {
			const [, indent, filePart, pipe, count, gap, plus, minus] = statMatch;
			out.push(
				indent! +
					colorizeStatPath(filePart!, theme) +
					fg(theme, "muted", "dim", pipe!) +
					fg(theme, "syntaxNumber", "accent", count!) +
					gap! +
					(plus ? fg(theme, "toolDiffAdded", "success", plus) : "") +
					(minus ? fg(theme, "toolDiffRemoved", "error", minus) : ""),
			);
			continue;
		}

		// 3. `git diff --stat` binary row: ` assets/icon.png | Bin 0 -> 1420 bytes`
		const binStatMatch = /^(\s*)(.+?)(\s+\|\s+)(Bin\s+\d+\s*->\s*\d+\s*bytes.*)$/.exec(line);
		if (binStatMatch) {
			const [, indent, filePart, pipe, binInfo] = binStatMatch;
			out.push(
				indent! +
					colorizeStatPath(filePart!, theme) +
					fg(theme, "muted", "dim", pipe!) +
					fg(theme, "warning", "accent", binInfo!),
			);
			continue;
		}

		// 4. `git diff --stat` / `--shortstat` summary: ` 4 files changed, 383 insertions(+), 46 deletions(-)`
		const summaryMatch = /^(\s*)(\d+)(\s+files?\s+changed)(.*)$/.exec(line);
		if (summaryMatch) {
			const [, indent, fileCount, filesLabel, tail] = summaryMatch;
			let coloredTail = tail!;
			coloredTail = coloredTail.replace(
				/(\s*,\s*)(\d+\s+insertions?\(\+\))/g,
				(_m, sep: string, ins: string) =>
					fg(theme, "muted", "dim", sep) +
					theme.bold(fg(theme, "toolDiffAdded", "success", ins)),
			);
			coloredTail = coloredTail.replace(
				/(\s*,\s*)(\d+\s+deletions?\(-\))/g,
				(_m, sep: string, del: string) =>
					fg(theme, "muted", "dim", sep) +
					theme.bold(fg(theme, "toolDiffRemoved", "error", del)),
			);
			out.push(
				indent! +
					theme.bold(fg(theme, "syntaxNumber", "text", fileCount!)) +
					fg(theme, "text", "toolOutput", filesLabel!) +
					coloredTail,
			);
			continue;
		}

		// 5. `git status -sb` branch line: `## main...origin/main [ahead 1]`
		const branchMatch = /^(##\s+)([^\s.]+)(\.\.\.[^\s[]+)?(\s+\[[^\]]+\])?(.*)$/.exec(line);
		if (branchMatch) {
			const [, hashes, local, remote, aheadBehind, rest] = branchMatch;
			out.push(
				fg(theme, "muted", "dim", hashes!) +
					theme.bold(fg(theme, "success", "toolDiffAdded", local!)) +
					(remote ? fg(theme, "accent", "muted", remote) : "") +
					(aheadBehind ? fg(theme, "warning", "accent", aheadBehind) : "") +
					(rest ? fg(theme, "muted", "toolOutput", rest) : ""),
			);
			continue;
		}

		// 6. `git status -s` / `--porcelain` row: ` M extensions/btw.ts`, `?? file.ts`, `R  a -> b`
		const statusMatch = /^([ MADRCU?!]{2}) (\S.*)$/.exec(line);
		if (statusMatch) {
			const [, xy, rawPath] = statusMatch;
			const validStatus =
				xy !== "  " && /^(?:\?\?|!!|[ MADRCU][MADRCU])$/.test(xy!);
			const looksLikePath =
				!/\s/.test(rawPath!) || rawPath!.startsWith('"') || rawPath!.includes(" -> ");
			if (validStatus && looksLikePath) {
				const codeStr =
					colorizeGitStatusCode(xy![0]!, true, theme) +
					colorizeGitStatusCode(xy![1]!, false, theme);
				const arrowIdx = rawPath!.indexOf(" -> ");
				const pathStr =
					arrowIdx !== -1
						? fg(theme, "muted", "toolOutput", rawPath!.slice(0, arrowIdx)) +
							fg(theme, "muted", "dim", " -> ") +
							fg(theme, "accent", "text", rawPath!.slice(arrowIdx + 4))
						: fg(theme, "text", "toolOutput", rawPath!);
				out.push(`${codeStr} ${pathStr}`);
				continue;
			}
		}

		// 7. `git commit` / `git push` / `git log --oneline`
		const commitHeader = /^(\[[\w./-]+\s+(?:\(root-commit\)\s+)?[0-9a-f]{7,40}\])(\s+.+)$/.exec(line);
		if (commitHeader) {
			out.push(
				theme.bold(fg(theme, "accent", "warning", commitHeader[1]!)) +
					fg(theme, "text", "toolOutput", commitHeader[2]!),
			);
			continue;
		}
		const pushRef = /^(\s*[0-9a-f]{7,40}\.\.\.?[0-9a-f]{7,40}\s+)(\S+\s*->\s*\S+)(.*)$/.exec(line);
		if (pushRef) {
			out.push(
				fg(theme, "muted", "dim", pushRef[1]!) +
					fg(theme, "toolDiffAdded", "success", pushRef[2]!) +
					fg(theme, "muted", "toolOutput", pushRef[3]!),
			);
			continue;
		}
		const onelineLog = /^([0-9a-f]{7,12})(\s+\([^)]+\))?(\s+\S.*)$/.exec(line);
		if (onelineLog && /\d/.test(onelineLog[1]!)) {
			out.push(
				fg(theme, "warning", "syntaxNumber", onelineLog[1]!) +
					(onelineLog[2] ? fg(theme, "accent", "success", onelineLog[2]) : "") +
					fg(theme, "text", "toolOutput", onelineLog[3]!),
			);
			continue;
		}

		// 8. Test runners (`node --test`, `vitest`, `jest`, `bun test`, TAP)
		const passMatch = /^(\s*)(✔|✓|PASS\b|ok\s+\d+\b)(.*?)(\s*\(\d+(?:\.\d+)?(?:ms|s)\))?\s*$/.exec(
			line,
		);
		if (passMatch) {
			const [, indent, mark, body, duration] = passMatch;
			out.push(
				indent! +
					theme.bold(fg(theme, "success", "toolDiffAdded", mark!)) +
					fg(theme, "toolOutput", "text", body!) +
					(duration ? fg(theme, "muted", "dim", duration) : ""),
			);
			continue;
		}
		const failMatch = /^(\s*)(✖|✗|✘|FAIL\b|not ok\s+\d+\b)(.*)$/.exec(line);
		if (failMatch) {
			out.push(
				failMatch[1]! +
					theme.bold(fg(theme, "error", "toolDiffRemoved", failMatch[2]!)) +
					fg(theme, "error", "toolDiffRemoved", failMatch[3]!),
			);
			continue;
		}
		const tapSummary = /^(ℹ\s+)(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)(\s+)(\S.*)$/.exec(
			line,
		);
		if (tapSummary) {
			const [, icon, key, space, val] = tapSummary;
			if (key === "pass" && val !== "0") {
				out.push(fg(theme, "success", "toolDiffAdded", line));
			} else if (key === "fail" && val !== "0") {
				out.push(theme.bold(fg(theme, "error", "toolDiffRemoved", line)));
			} else {
				out.push(
					fg(theme, "muted", "dim", `${icon}${key}${space}`) +
						fg(theme, "syntaxNumber", "text", val!),
				);
			}
			continue;
		}

		// 9. Compiler / linter diagnostics: `src/foo.ts:12:4 - error TS2322: ...`
		const diagMatch =
			/^([^\s:()]+?\.[a-zA-Z0-9]{1,8})(:(\d+)(?::(\d+))?|\((\d+),(\d+)\))(\s*[:-]\s*)(error|warning|info|note)(\b.*)$/i.exec(
				line,
			);
		if (diagMatch) {
			const [, filePath, loc, , , , , sep, severity, msg] = diagMatch;
			const sevLower = severity!.toLowerCase();
			const sevColor =
				sevLower === "error" ? "error" : sevLower === "warning" ? "warning" : "accent";
			out.push(
				fg(theme, "accent", "text", filePath!) +
					fg(theme, "syntaxNumber", "muted", loc!) +
					fg(theme, "muted", "dim", sep!) +
					theme.bold(fg(theme, sevColor, "text", severity!)) +
					fg(theme, "text", "toolOutput", msg!),
			);
			continue;
		}

		out.push(fg(theme, "toolOutput", "text", line));
	}

	return out.join("\n");
}

function extractRawShellResultText(
	result: { content?: Array<{ type?: string; text?: string }>; details?: Record<string, any> } | undefined,
	isPartial: boolean,
): { text: string; hasImages: boolean } {
	if (!result || !Array.isArray(result.content)) {
		return { text: "", hasImages: false };
	}
	const hasImages = result.content.some((c) => c?.type === "image");
	let output = result.content
		.filter((c) => c?.type === "text")
		.map((c) => sanitizeShellTextKeepSgr(c.text || ""))
		.join("\n")
		.replace(/^\n+|\s+$/g, "");

	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	const plain = stripSgr(output);
	if (!isPartial && truncation?.truncated && typeof fullOutputPath === "string" && plain.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && stripSgr(output.slice(footerStart)).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}
	return { text: output, hasImages };
}

/**
 * Create a Pi `ToolRendererResolver` enhancing `bash` and `powershell` cards
 * while keeping Pi's built-in timers, truncation footers, expand hints, and
 * outer call wrappers (`pi-agy` `toolSummary`) intact.
 */
export function createShellToolRendererResolver(
	getHighlighter: () => Highlighter,
): ToolRendererResolver {
	return (toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined => {
		const base = next();
		if (toolName !== "bash" && toolName !== "powershell") {
			return base;
		}
		if (!base) return base;

		const prompt = toolName === "powershell" ? "PS>" : "$";
		const lang: "bash" | "powershell" = toolName === "powershell" ? "powershell" : "bash";

		return {
			renderShell: base.renderShell,
			renderCall: base.renderCall
				? (args, theme, context) => {
						const comp = base.renderCall!(args, theme, context);
						if (!state.enabled || !state.shell) return comp;
						try {
							const inner = (comp as { inner?: unknown } | undefined)?.inner;
							const targetText = isSettableText(comp)
								? comp
								: isSettableText(inner)
									? inner
									: undefined;
							if (targetText) {
								const formatted = formatShellCommandCall(
									args as { command?: unknown; timeout?: unknown } | undefined,
									prompt,
									lang,
									theme as ThemeLike,
									getHighlighter(),
								);
								if (formatted) targetText.setText(formatted);
							}
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
							const { text, hasImages } = extractRawShellResultText(
								result as { content?: Array<{ type?: string; text?: string }>; details?: Record<string, any> },
								Boolean(options?.isPartial),
							);
							if (!text || hasImages) return comp;
							const styledOutput = colorizeShellOutput(
								text.replace(/\t/g, "   "),
								theme as ThemeLike,
								getHighlighter(),
							);
							const children = (comp as unknown as { children?: any[] } | undefined)?.children;
							if (!Array.isArray(children)) return comp;
							if (options?.expanded) {
								if (isSettableText(children[0])) {
									children[0].setText(`\n${styledOutput}`);
									comp.invalidate?.();
								}
							} else {
								const preview = children.find(
									(c) => c && typeof c === "object" && c.options && typeof c.options.text === "string",
								);
								if (preview) {
									preview.options.text = styledOutput;
									preview.invalidate?.();
									comp.invalidate?.();
								}
							}
						} catch {
							// Never break Pi's built-in result rendering.
						}
						return comp;
					}
				: undefined,
		};
	};
}
