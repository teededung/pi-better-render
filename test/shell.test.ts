import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
	colorizeShellOutput,
	createShellToolRendererResolver,
	formatShellCommandCall,
	sanitizeLineSgrForBox,
	sanitizeShellTextKeepSgr,
} from "../src/render/shell.ts";
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

test("git status -s and git diff --stat (screenshot regression) render green/red diff bars and summary counts", () => {
	const theme = taggedTheme();
	const sample = [
		" M extensions/btw.ts",
		" M lib/agy-acp-client.ts",
		"?? src/new-helper.ts",
		" extensions/btw.ts           |  66 ++++++++++++++++++--",
		" test/agy-acp-driver.test.ts | 104 ++++++++++++++++++++++++++++++-",
		" 4 files changed, 383 insertions(+), 46 deletions(-)",
	].join("\n");

	const rendered = colorizeShellOutput(sample, theme).split("\n");

	// `git status -s`: unstaged M is warning, untracked ?? is warning, path is text
	assert.equal(rendered[0], " <b><warning>M</warning></b> <text>extensions/btw.ts</text>");
	assert.equal(
		rendered[2],
		"<warning>?</warning><warning>?</warning> <text>src/new-helper.ts</text>",
	);

	// `git diff --stat` histogram row: path + muted `|` + syntaxNumber + green `+` + red `-`
	assert.equal(
		rendered[3],
		" <text>extensions/btw.ts</text><muted>           |  </muted><syntaxNumber>66</syntaxNumber> <toolDiffAdded>++++++++++++++++++</toolDiffAdded><toolDiffRemoved>--</toolDiffRemoved>",
	);
	assert.equal(
		rendered[4],
		" <text>test/agy-acp-driver.test.ts</text><muted> | </muted><syntaxNumber>104</syntaxNumber> <toolDiffAdded>++++++++++++++++++++++++++++++</toolDiffAdded><toolDiffRemoved>-</toolDiffRemoved>",
	);

	// `git diff --stat` summary line: bold file count, green insertions(+), red deletions(-)
	assert.equal(
		rendered[5],
		" <b><syntaxNumber>4</syntaxNumber></b><text> files changed</text><muted>, </muted><b><toolDiffAdded>383 insertions(+)</toolDiffAdded></b><muted>, </muted><b><toolDiffRemoved>46 deletions(-)</toolDiffRemoved></b>",
	);

	// Guard against false-positive git status matching on ordinary indented English prose
	const prose = " A sentence with multiple words should stay plain toolOutput";
	assert.equal(colorizeShellOutput(prose, theme), `<toolOutput>${prose}</toolOutput>`);
});

test("unified git diff, commit/push/log, test runners, JSON, and compiler diagnostics colorize cleanly", () => {
	const theme = taggedTheme();
	const sample = [
		"diff --git a/src/a.ts b/src/a.ts",
		"index 0860dc2..0511884 100644",
		"--- a/src/a.ts",
		"+++ b/src/a.ts",
		"@@ -10,3 +10,3 @@ function demo()",
		"-const oldVal = 1;",
		"+const newVal = 2;",
		" return newVal;",
		"[main 0511884] feat(btw): show toolSummary",
		"   0860dc2..0511884  main -> main",
		"✔ test case passes (12.4ms)",
		"✖ test case fails",
		"ℹ pass 49",
		"ℹ fail 1",
		"src/index.ts:42:9 - error TS2322: Type 'number' is not assignable to 'string'.",
	].join("\n");

	const lines = colorizeShellOutput(sample, theme).split("\n");
	assert.equal(lines[0], "<b><accent>diff --git a/src/a.ts b/src/a.ts</accent></b>");
	assert.equal(lines[1], "<muted>index 0860dc2..0511884 100644</muted>");
	assert.equal(lines[2], "<b><toolDiffRemoved>--- a/src/a.ts</toolDiffRemoved></b>");
	assert.equal(lines[3], "<b><toolDiffAdded>+++ b/src/a.ts</toolDiffAdded></b>");
	assert.equal(
		lines[4],
		"<accent>@@ -10,3 +10,3 @@</accent><muted> function demo()</muted>",
	);
	assert.equal(lines[5], "<toolDiffRemoved>-const oldVal = 1;</toolDiffRemoved>");
	assert.equal(lines[6], "<toolDiffAdded>+const newVal = 2;</toolDiffAdded>");
	assert.equal(lines[7], "<toolDiffContext> return newVal;</toolDiffContext>");
	assert.equal(
		lines[8],
		"<b><accent>[main 0511884]</accent></b><text> feat(btw): show toolSummary</text>",
	);
	assert.equal(
		lines[9],
		"<muted>   0860dc2..0511884  </muted><toolDiffAdded>main -> main</toolDiffAdded>",
	);
	assert.equal(
		lines[10],
		"<b><success>✔</success></b><toolOutput> test case passes</toolOutput><muted> (12.4ms)</muted>",
	);
	assert.equal(lines[11], "<b><error>✖</error></b><error> test case fails</error>");
	assert.equal(lines[12], "<success>ℹ pass 49</success>");
	assert.equal(lines[13], "<b><error>ℹ fail 1</error></b>");
	assert.equal(
		lines[14],
		"<accent>src/index.ts</accent><syntaxNumber>:42:9</syntaxNumber><muted> - </muted><b><error>error</error></b><text> TS2322: Type 'number' is not assignable to 'string'.</text>",
	);

	// Whole-output JSON uses the host highlighter when valid
	const jsonOut = colorizeShellOutput(
		'{"ok":true}',
		theme,
		(code, lang) => [`[${lang}]${code}`],
	);
	assert.equal(jsonOut, '[json]{"ok":true}\x1b[22;23;24;29;39m');
});

test("sanitizeShellTextKeepSgr and sanitizeLineSgrForBox preserve fg SGR while stripping unsafe escapes and bg resets", () => {
	const dirty = "hello\x1b]0;window-title\x07\x1b[2K \x1b[32;41mworld\x1b[0m\r\n";
	const kept = sanitizeShellTextKeepSgr(dirty).trim();
	assert.equal(kept, "hello \x1b[32;41mworld\x1b[0m");
	// 41 (red bg) is dropped and 0 becomes fg/attr-only reset so Box's toolSuccessBg stays intact
	assert.equal(
		sanitizeLineSgrForBox(kept),
		"hello \x1b[32mworld\x1b[22;23;24;29;39m\x1b[22;23;24;29;39m",
	);
});

test("createShellToolRendererResolver composes with pi-agy SummaryCallContainer and collapsed/expanded result previews", () => {
	const theme = taggedTheme();
	const resolver = createShellToolRendererResolver(() => (code, lang) => [
		`<hl:${lang}>${code}</hl:${lang}>`,
	]);

	// Simulate pi-agy wrapping base.renderCall with `{ summaryText, inner: Text }`
	class FakeSummaryCallContainer extends Container {
		summary = new Text("<muted>Check git status and diff stat in pi-agy</muted>", 0, 0);
		inner = new Text("", 0, 0);
		constructor() {
			super();
			this.addChild(this.summary);
			this.addChild(this.inner);
		}
	}

	class FakeVisualPreview {
		options: { text: string };
		invalidated = 0;
		constructor(text: string) {
			this.options = { text };
		}
		render(): string[] {
			return this.options.text.split("\n");
		}
		invalidate(): void {
			this.invalidated++;
		}
	}

	const renderer = resolver("bash", () => ({
		renderCall(args) {
			const wrapper = new FakeSummaryCallContainer();
			wrapper.inner.setText(`$ ${(args as { command: string }).command}`);
			return wrapper;
		},
		renderResult(result, options) {
			const c = new Container();
			const raw = result.content[0].text;
			const plainStyled = `<toolOutput>${raw}</toolOutput>`;
			if (options.expanded) {
				c.addChild(new Text(`\n${plainStyled}`, 0, 0));
			} else {
				c.addChild(new Spacer(1));
				c.addChild(new FakeVisualPreview(plainStyled) as any);
			}
			c.addChild(new Text("\n<muted>Took 0.0s</muted>", 0, 0));
			return c;
		},
	}))!;

	// 1. Call rendering preserves pi-agy summary line AND highlights `$ <command>`
	const callComp = renderer.renderCall!(
		{ command: "git status -s && git diff --stat", timeout: 30 },
		theme,
		{},
	) as FakeSummaryCallContainer;
	const callLines = callComp.render(200).map((l) => l.trimEnd());
	assert.equal(callLines[0], "<muted>Check git status and diff stat in pi-agy</muted>");
	assert.match(callLines[1]!, /<b><accent>\$<\/accent><\/b>/);
	assert.match(callLines[1]!, /<hl:bash>git status -s && git diff --stat<\/hl:bash>/);
	assert.match(callLines[1]!, /\(timeout 30s\)/);

	// 2. Collapsed result replaces VisualLinePreview text with colored status + diff --stat while keeping leading space on line 0
	const collapsed = renderer.renderResult!(
		{
			content: [
				{
					type: "text",
					text: " M src/index.ts\n src/index.ts | 10 ++++++++--\n 1 file changed, 8 insertions(+), 2 deletions(-)",
				},
			],
		},
		{ expanded: false, isPartial: false },
		theme,
		{},
	) as Container;
	const collapsedLines = collapsed.render(200).map((l) => l.trimEnd());
	assert.ok(collapsedLines.some((l) => l.includes(" <b><warning>M</warning></b> <text>src/index.ts</text>")));
	assert.ok(collapsedLines.some((l) => l.includes("<toolDiffAdded>++++++++</toolDiffAdded><toolDiffRemoved>--</toolDiffRemoved>")));
	assert.ok(collapsedLines.some((l) => l.includes("Took 0.0s")));

	// 3. Disabling `state.shell` leaves stock output untouched
	state.shell = false;
	try {
		const plain = renderer.renderResult!(
			{ content: [{ type: "text", text: " src/index.ts | 10 ++++++++--" }] },
			{ expanded: true, isPartial: false },
			theme,
			{},
		) as Container;
		const plainLines = plain.render(200).map((l) => l.trimEnd());
		assert.ok(plainLines.some((l) => l.includes("<toolOutput> src/index.ts | 10 ++++++++--</toolOutput>")));
	} finally {
		state.shell = true;
	}
});
