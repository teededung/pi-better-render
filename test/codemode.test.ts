import { homedir } from "node:os";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import {
	colorizeCodemodeError,
	createCodemodeToolRendererResolver,
	extractCallsFromCode,
	formatCodemodeCalls,
	formatCodemodeHeader,
	middleTruncatePath,
	parseCallArgsLenient,
	parseCodemodeHeaderOptions,
	shortenDisplayPath,
} from "../src/render/codemode.ts";
import { createShellToolRendererResolver } from "../src/render/shell.ts";
import { state } from "../src/state.ts";
import type { ThemeLike } from "../src/style.ts";

function taggedTheme(): ThemeLike {
	return {
		name: "tagged",
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (t) => `<b>${t}</b>`,
		italic: (t) => `<i>${t}</i>`,
		underline: (t) => `<u>${t}</u>`,
		strikethrough: (t) => `<s>${t}</s>`,
		getFgAnsi: (color) => `<open:${color}>`,
		getBgAnsi: (color) => `<bg:${color}>`,
	};
}

class FakeVisualPreview {
	options: { text: string };
	constructor(text: string) {
		this.options = { text };
	}
	render(): string[] {
		return this.options.text.split("\n");
	}
	invalidate(): void {}
}

test("extractCallsFromCode and parseCallArgsLenient recover toolSummary and full command past 200-char truncation", () => {
	const theme = taggedTheme();
	const hl = (code: string, lang?: string) => [`<hl:${lang}>${code}</hl:${lang}>`];

	// Exact regression from screenshot: JSON.stringify(args) > 200 chars cuts off toolSummary in details.calls
	const code = [
		'// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}',
		"const [rgState, readmeTools] = await Promise.allSettled([",
		'  tools.bash({ command: \'rg -n "state\\\\.shell|createShellToolRendererResolver|registerToolRenderer" /Users/rongmauhong/.pi/agent/git/github.com/teededung/pi-better-render/\', toolSummary: "Search state.shell and resolver refs" }),',
		"  tools.mcp__fsearch__multi_grep({ path: '/repo/src', patterns: ['foo', 'bar'], constraints: '*.ts', toolSummary: 'Find foo or bar' }),",
		"  tools.read({ path: `${homedir()}/project/src/index.ts`, offset: 15, limit: 25 }),",
		"]);",
		"return { rgState, readmeTools };",
	].join("\n");

	assert.deepEqual(parseCodemodeHeaderOptions(code), ["timeout 60.0s", "max 10k tok"]);
	const extracted = extractCallsFromCode(code);

	// Regression guard: stray ')' or ']' inside a malformed object literal must never hang.
	const malformed = extractCallsFromCode(
		'tools.read({ path: "a.ts", toolSummary: "x" ) + tools.bash({ command: "ls", x: y ] })',
	);
	assert.equal(malformed.length, 2);
	assert.equal(malformed[0]?.args.path, "a.ts");
	assert.equal(malformed[1]?.args.command, "ls");
	assert.equal(extracted.length, 3);
	assert.equal(extracted[0]?.tool, "bash");
	assert.equal(extracted[0]?.args.toolSummary, "Search state.shell and resolver refs");
	assert.equal(extracted[1]?.tool, "mcp__fsearch__multi_grep");
	assert.deepEqual(extracted[1]?.args.patterns, ["foo", "bar"]);

	// Simulate Pi's execute.js truncating call.args at 200 chars right in the middle of toolSummary
	const fullJson = JSON.stringify(extracted[0]!.args);
	assert.ok(fullJson.length > 200);
	const clippedArgs = `${fullJson.slice(0, 197)}...`;
	const lenient = parseCallArgsLenient(clippedArgs);
	assert.ok(lenient.truncatedKeys.has("toolSummary"));

	const home = homedir();
	const rendered = formatCodemodeCalls(
		[
			{ name: "bash", args: clippedArgs, status: "ok", durationMs: 13 },
			{
				name: "mcp__fsearch__multi_grep",
				args: JSON.stringify({ path: "/repo/src", patterns: ["foo", "bar"], constraints: "*.ts" }),
				status: "ok",
				durationMs: 5,
			},
			{
				name: "read",
				args: JSON.stringify({ path: `${home}/project/src/index.ts`, offset: 15, limit: 25 }),
				status: "ok",
				durationMs: 2,
			},
		],
		false,
		theme,
		hl,
		{ extractedCalls: extracted },
	);

	assert.match(rendered, /<i><thinkingText>Search state\.shell and resolver refs<\/thinkingText><\/i>/);
	assert.match(rendered, /<b><success>✓<\/success><\/b> <b><accent>\$<\/accent><\/b> .*<hl:bash>rg -n "state\\\.shell/);
	assert.match(rendered, /<dim>13ms<\/dim>/);
	assert.match(rendered, /<i><thinkingText>Find foo or bar<\/thinkingText><\/i>/);
	assert.match(
		rendered,
		/<b><toolTitle>fsearch\/multi_grep<\/toolTitle><\/b> <accent>"foo \| bar"<\/accent> <warning>\*\.ts<\/warning><muted> in <\/muted>.*\/repo\/src/,
	);
	assert.match(
		rendered,
		/<b><toolTitle>read<\/toolTitle><\/b> .*~\/project\/src\/index\.ts.*<warning>:15-39<\/warning>  <dim>2ms<\/dim>/,
	);
	// Never leak raw JSON `{"command":` or `toolSummary` key into rendered lines
	assert.doesNotMatch(rendered, /\{"command":/);
	assert.doesNotMatch(rendered, /toolSummary/);
});

test("createCodemodeToolRendererResolver hides JS source and tuiText output while framing single-style nested calls", () => {
	const theme = taggedTheme();
	const resolver = createCodemodeToolRendererResolver(() => (code, lang) => [
		`<hl:${lang}>${code}</hl:${lang}>`,
	]);

	class FakeAgyShell extends Container {
		summaryText = new Text("<i><thinkingText>Check pi-tui Text class and src/index.ts lines</thinkingText></i>", 0, 0);
		inner = new Container();
		hasSummary = true;
		constructor() {
			super();
			this.addChild(this.summaryText);
			this.addChild(this.inner);
		}
	}
	class FakeSharedCarrier implements Component {
		inner = new Container();
		invalidateCalled = 0;
		get children() {
			return this.inner.children;
		}
		addChild(c: any) {
			this.inner.addChild(c);
		}
		render(w: number) {
			return this.inner.render(w);
		}
		invalidate() {
			this.invalidateCalled++;
			this.inner.invalidate();
		}
	}

	const renderer = resolver("codemode", () => ({
		renderShell: "self",
		renderCall(args, _t, context) {
			const shell = new FakeAgyShell();
			shell.inner.addChild(new Text("codemode", 0, 0));
			const code = (args as { code: string }).code;
			shell.inner.addChild(
				context.expanded ? new Text(code, 0, 0) : (new FakeVisualPreview(code) as any),
			);
			return shell;
		},
		renderResult(result, options) {
			const carrier = new FakeSharedCarrier();
			carrier.addChild(new Spacer(1));
			carrier.addChild(new Text('✓ bash {"command":"ls"} 4ms', 0, 0));
			carrier.addChild(new Spacer(1));
			const txt = result.content[1]?.type === "text" ? result.content[1].text : "";
			carrier.addChild(
				options.expanded ? new Text(txt, 0, 0) : (new FakeVisualPreview(txt) as any),
			);
			carrier.addChild(new Text("Full output: /tmp/pi-codemode.txt", 0, 0));
			carrier.addChild(new Spacer(1));
			carrier.addChild(new Text("<muted>Took 0.1s</muted>", 0, 0));
			return carrier;
		},
	}))!;

	const sharedState: Record<PropertyKey, unknown> = {};
	const scriptSource = [
		"const [tuiText, idx1] = await Promise.allSettled([",
		'  tools.bash({ command: "rg -n Text src/", toolSummary: "Inspect Text references" }),',
		'  tools.read({ path: "/repo/src/index.ts", offset: 15, limit: 25, toolSummary: "Read index.ts imports" }),',
		"]);",
		"return { tuiText, idx1 };",
	].join("\n");

	// 1. Call card keeps outer pi-agy toolSummary + codemode frame header, and HIDES raw JS code!
	const callComp = renderer.renderCall!(
		{ code: scriptSource, toolSummary: "Check pi-tui Text class and src/index.ts lines" },
		theme,
		{ expanded: false, state: sharedState },
	) as FakeAgyShell;
	const callLines = callComp.render(200).map((l) => l.trimEnd());
	assert.equal(callLines[0], "<i><thinkingText>Check pi-tui Text class and src/index.ts lines</thinkingText></i>");
	assert.match(callLines[1]!, /⚡.*<b><toolTitle>codemode<\/toolTitle><\/b>.*<syntaxNumber>2<\/syntaxNumber><muted> calls<\/muted>/);
	assert.equal(callLines.length, 2);
	assert.ok(!callLines.some((l) => l.includes("Promise.allSettled")));

	// 2. Result card renders nested calls like single tool calls and HIDES {"tuiText": ...} + Full output notice!
	for (const expanded of [false, true]) {
		const resComp = renderer.renderResult!(
			{
				content: [
					{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
					{ type: "text", text: '{"tuiText":"very noisy internal json blob","idx1":"more noise"}' },
				],
				details: {
					calls: [
						{ name: "bash", args: '{"command":"rg -n Text src/"}', status: "ok", durationMs: 11 },
						{ name: "read", args: '{"path":"/repo/src/index.ts","offset":15,"limit":25}', status: "ok", durationMs: 2 },
					],
					fullOutputPath: "/tmp/pi-codemode.txt",
				},
			},
			{ expanded, isPartial: false },
			theme,
			{ isError: false, state: sharedState },
		) as FakeSharedCarrier;

		const resText = resComp.render(200).map((l) => l.trimEnd()).join("\n");
		assert.match(resText, /<i><thinkingText>Inspect Text references<\/thinkingText><\/i>/);
		assert.match(resText, /<hl:bash>rg -n Text src\/<\/hl:bash>/);
		assert.match(resText, /<i><thinkingText>Read index\.ts imports<\/thinkingText><\/i>/);
		assert.match(resText, /<b><toolTitle>read<\/toolTitle><\/b> .*\/repo\/src\/index\.ts.*<warning>:15-39<\/warning>/);
		assert.match(resText, /Took 0\.1s/);
		assert.doesNotMatch(resText, /tuiText/);
		assert.doesNotMatch(resText, /Full output:/);
	}

	// 3. Script crash (isError: true) STILL surfaces Script error diagnostics cleanly
	const errComp = renderer.renderResult!(
		{
			content: [
				{ type: "text", text: "Script failed\nWall time 0.0 seconds\nOutput:\n" },
				{ type: "text", text: "Script error: ReferenceError: foo is not defined\n    at main.js:2:5" },
			],
			details: { calls: [] },
		},
		{ expanded: false, isPartial: false },
		theme,
		{ isError: true, state: sharedState },
	) as FakeSharedCarrier;
	const errText = errComp.render(200).map((l) => l.trimEnd()).join("\n");
	assert.match(errText, /<b><error>Script error:<\/error><\/b><error> ReferenceError: foo is not defined<\/error>/);
	assert.match(colorizeCodemodeError("Script error: Boom", theme), /Script error:/);
});

test("standalone codemode and bash fallback to inline args.toolSummary and respect state.shell toggle", () => {
	const theme = taggedTheme();
	const codemodeResolver = createCodemodeToolRendererResolver(() => () => undefined);
	const standalone = codemodeResolver("codemode", () => ({
		renderCall(args) {
			const c = new Container();
			c.addChild(new Text("codemode", 0, 0));
			c.addChild(new Text((args as { code: string }).code, 0, 0));
			return c;
		},
	}))!;

	const standaloneLines = (
		standalone.renderCall!(
			{ code: 'await tools.bash({ command: "pwd" });', toolSummary: "Check working directory" },
			theme,
			{ expanded: false, state: {} },
		) as Container
	)
		.render(200)
		.map((l) => l.trimEnd());
	assert.equal(standaloneLines[0], "<i><thinkingText>Check working directory</thinkingText></i>");
	assert.equal(standaloneLines[1], "");
	assert.match(standaloneLines[2]!, /⚡.*codemode.*1<\/syntaxNumber><muted> call<\/muted>/);
	assert.ok(!standaloneLines.some((l) => l.includes("tools.bash")));

	const invalidHeader = formatCodemodeHeader(null, theme);
	assert.match(invalidHeader, /<error>\[invalid arg\]<\/error>/);

	const shellResolver = createShellToolRendererResolver(() => (code, lang) => [
		`<hl:${lang}>${code}</hl:${lang}>`,
	]);
	const bashRenderer = shellResolver("bash", () => ({
		renderCall(args) {
			return new Text(`$ ${(args as { command: string }).command}`, 0, 0);
		},
	}))!;
	const bashLines = (
		bashRenderer.renderCall!(
			{ command: "git status -s", toolSummary: "Check git status" },
			theme,
			{},
		) as Text
	)
		.render(200)
		.map((l) => l.trimEnd());
	assert.equal(bashLines[0], "<i><thinkingText>Check git status</thinkingText></i>");
	assert.match(bashLines[2]!, /<hl:bash>git status -s<\/hl:bash>/);

	state.shell = false;
	try {
		const plain = (
			standalone.renderCall!(
				{ code: "return 1;", toolSummary: "Plain" },
				theme,
				{ expanded: true, state: {} },
			) as Container
		)
			.render(200)
			.map((l) => l.trimEnd());
		assert.equal(plain[0], "codemode");
		assert.equal(plain[1], "return 1;");
	} finally {
		state.shell = true;
	}
});

test("shortenDisplayPath prefers cwd-relative paths, falls back to ~, and keeps long edit paths inline on one row", () => {
	const home = homedir();
	const cwd = `${home}/Documents/Repo/ragnarok`;
	const insideAbs = `${cwd}/worktrees/lani-shield/next-ma/client-runtime/src/windows/runtime_login_send_hook.cpp`;
	const insideTilde = `~/Documents/Repo/ragnarok/worktrees/lani-shield/next-ma/client-runtime/src/windows/runtime_fps_overlay.hpp`;
	const outsideAbs = `${home}/OtherRepo/deep/folder/file.ts`;

	assert.equal(
		shortenDisplayPath(insideAbs, cwd),
		"worktrees/lani-shield/next-ma/client-runtime/src/windows/runtime_login_send_hook.cpp",
	);
	assert.equal(
		shortenDisplayPath(insideTilde, cwd),
		"worktrees/lani-shield/next-ma/client-runtime/src/windows/runtime_fps_overlay.hpp",
	);
	assert.equal(shortenDisplayPath(outsideAbs, cwd), "~/OtherRepo/deep/folder/file.ts");
	assert.equal(
		middleTruncatePath(
			"worktrees/lani-shield/next-ma/client-runtime/src/windows/runtime_login_send_hook.cpp",
			60,
		),
		"worktrees/…/src/windows/runtime_login_send_hook.cpp",
	);

	// Real ANSI-only theme so Text.render(width) measures exact terminal columns.
	const ansiTheme: ThemeLike = {
		name: "ansi",
		fg: (_c, t) => t,
		bold: (t) => t,
		italic: (t) => t,
		underline: (t) => t,
		strikethrough: (t) => t,
		getFgAnsi: () => "",
		getBgAnsi: () => "",
	};
	const resolver = createCodemodeToolRendererResolver(() => () => undefined);
	const renderer = resolver("codemode", () => ({
		renderResult() {
			const c = new Container();
			c.addChild(new Text("placeholder", 0, 0));
			return c;
		},
	}))!;

	const comp = renderer.renderResult!(
		{
			content: [{ type: "text", text: "ok" }],
			details: {
				calls: [
					{
						name: "edit",
						args: JSON.stringify({
							path: insideAbs,
							toolSummary: "Wire live !vsync command variants",
						}),
						status: "ok",
						durationMs: 13,
					},
					{
						name: "edit",
						args: JSON.stringify({
							path: `${cwd}/worktrees/lani-shield/next-ma/tests/fps_overlay_policy_test.cpp`,
							toolSummary: "Add unit tests",
						}),
						status: "ok",
						durationMs: 13,
					},
				],
			},
		},
		{ expanded: false, isPartial: false },
		ansiTheme,
		{ isError: false, state: {}, cwd },
	) as Container;

	// Even on an 80-column narrow terminal, every `✓ edit <path>  13ms` stays on ONE line!
	const lines = comp
		.render(80)
		.map((l) => l.replace(/\x1b\]8;;[^\x07]*\x07/g, "").trimEnd())
		.filter((l) => l.length > 0);
	const editLines = lines.filter((l) => l.startsWith("✓ edit "));
	assert.equal(editLines.length, 2);
	for (const line of editLines) {
		assert.ok(line.length <= 80, `expected single line <= 80 cols, got ${line.length}: ${line}`);
		assert.match(line, /^✓ edit \S+  13ms$/);
	}
	assert.match(editLines[0]!, /runtime_login_send_hook\.cpp/);
	assert.match(editLines[1]!, /fps_overlay_policy_test\.cpp/);
});
