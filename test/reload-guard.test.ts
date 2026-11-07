import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { type Component, Markdown, TuiAltScreen } from "@earendil-works/pi-tui";

const noop = (s: string) => s;
const plainMarkdownTheme = {
	heading: noop,
	link: noop,
	linkUrl: noop,
	code: noop,
	codeBlock: noop,
	codeBlockBorder: noop,
	quote: noop,
	quoteBorder: noop,
	hr: () => "",
	listBullet: noop,
	bold: noop,
	italic: noop,
	strikethrough: noop,
	underline: noop,
};

class FakeAssistantMessageComponent {
	contentContainer: { children: Component[] } = { children: [] };
	isStreaming = false;
	updateContent(message: unknown, isStreaming = false): void {
		this.isStreaming = isStreaming;
		const text = typeof message === "string" ? message : "**hello**";
		this.contentContainer.children = [new Markdown(text, 1, 0, plainMarkdownTheme)];
	}
	invalidate(): void {}
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-coding-agent") {
			return { url: "data:text/javascript,export {}", shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url === "data:text/javascript,export {}") {
			globalThis.__fakeAssistantMessageComponent = FakeAssistantMessageComponent;
			return {
				format: "module",
				shortCircuit: true,
				source: `
					export const AssistantMessageComponent = globalThis.__fakeAssistantMessageComponent;
					export function getMarkdownTheme() { return {}; }
					export async function copyToClipboard() {}
				`,
			};
		}
		return nextLoad(url, context);
	},
});

declare global {
	// eslint-disable-next-line no-var
	var __fakeAssistantMessageComponent: typeof FakeAssistantMessageComponent | undefined;
}

const { applyPatch, isPatched, probePatchCapability, removePatch } = await import("../src/patch.ts");
const { installFrameHook } = await import("../src/math/kitty.ts");
const { requestRender } = await import("../src/state.ts");
const { default: piBetterRender } = await import("../src/index.ts");

test("capability probe detects missing updateContent and accepts valid host prototype", () => {
	assert.equal(probePatchCapability(FakeAssistantMessageComponent.prototype), undefined);
	assert.match(probePatchCapability({}) ?? "", /updateContent is missing/);
	const badHandle = applyPatch(() => ({ render: () => [], invalidate() {} }), {});
	assert.equal(badHandle.installed, false);
	assert.match(badHandle.reason ?? "", /updateContent is missing/);
});

test("stale runtime shutdown during /reload preserves replacement patch, frame hook, and render requester", () => {
	removePatch();

	type Handlers = Record<string, (event: unknown, ctx: any) => unknown>;
	const makePi = () => {
		const handlers: Handlers = {};
		const pi = {
			on(event: string, fn: (event: unknown, ctx: any) => unknown) {
				handlers[event] = fn;
				return () => {};
			},
			registerCommand() {},
		};
		return { pi, handlers };
	};

	const terminalWrites: string[] = [];
	const baseWrite = (data: string) => {
		terminalWrites.push(data);
	};
	const terminal = { write: baseWrite };
	const originalAltScreenDoRender = (TuiAltScreen.prototype as unknown as { doRender: () => void }).doRender;

	let renderCount1 = 0;
	let renderCount2 = 0;
	const makeCtx = (which: 1 | 2) => ({
		hasUI: true,
		ui: {
			theme: null,
			notify() {},
			setStatus() {},
			setWidget(_key: string, content: ((tui: any) => Component) | undefined) {
				if (content) {
					content({
						mode: "fullscreen",
						terminal,
						invalidate() {},
						requestRender() {
							if (which === 1) renderCount1++;
							else renderCount2++;
						},
					});
				}
			},
		},
	});

	// 1. Old runtime starts.
	const runtime1 = makePi();
	piBetterRender(runtime1.pi as any);
	runtime1.handlers.session_start?.({}, makeCtx(1));
	assert.equal(isPatched(), true);
	assert.notEqual(terminal.write, baseWrite);

	// 2. Replacement runtime starts BEFORE old runtime's session_shutdown runs (/reload overlap).
	const runtime2 = makePi();
	piBetterRender(runtime2.pi as any);
	runtime2.handlers.session_start?.({}, makeCtx(2));
	const replacementTerminalWrite = terminal.write;
	assert.notEqual(replacementTerminalWrite, baseWrite);

	// 3. Stale runtime shuts down — must NOT strip replacement patch, frame hook, or renderRequester.
	runtime1.handlers.session_shutdown?.({}, makeCtx(1));
	assert.equal(isPatched(), true, "replacement patch must remain installed");
	assert.equal(terminal.write, replacementTerminalWrite, "replacement frame hook must remain installed");
	assert.notEqual(
		(TuiAltScreen.prototype as unknown as { doRender: () => void }).doRender,
		originalAltScreenDoRender,
		"replacement Orca TuiAltScreen patch must remain installed",
	);

	const before2 = renderCount2;
	requestRender();
	assert.equal(renderCount2, before2 + 1, "replacement renderRequester must remain active");

	const msg = new FakeAssistantMessageComponent();
	msg.updateContent("**still rich**", false);
	assert.equal(msg.contentContainer.children[0] instanceof Markdown, false, "replacement factory must still swap Markdown");

	// 4. Replacement runtime shuts down cleanly and restores originals without double-wrapped terminal.write.
	runtime2.handlers.session_shutdown?.({}, makeCtx(2));
	assert.equal(isPatched(), false);
	assert.equal(terminal.write, baseWrite);
	assert.equal((TuiAltScreen.prototype as unknown as { doRender: () => void }).doRender, originalAltScreenDoRender);
});

test("overlapping installFrameHook unwraps prior hook and ignores stale uninstaller", () => {
	const raw: string[] = [];
	const base = (data: string) => {
		raw.push(data);
	};
	const terminal = { write: base };

	const uninstall1 = installFrameHook(terminal, "placeholder");
	const uninstall2 = installFrameHook(terminal, "placeholder");
	const hook2 = terminal.write;

	uninstall1();
	assert.equal(terminal.write, hook2, "stale uninstaller must not remove active hook");

	uninstall2();
	assert.equal(terminal.write, base, "active uninstaller must restore original unwrapped write");
});

test("applyPatch unwraps thinking MouseRegion and clears thinkingVisibilityOverrides while keeping thinking Markdown native", () => {
	removePatch();

	class FakeThinkingAssistantMessage extends FakeAssistantMessageComponent {
		thinkingVisibilityOverrides = new Map<number, boolean>([[0, true]]);
		override updateContent(_message: unknown, isStreaming = false): void {
			this.isStreaming = isStreaming;
			const thinkingMd = new Markdown("Let's inspect the diff.", 1, 0, plainMarkdownTheme);
			const mouseWrappedThinking = {
				child: thinkingMd,
				onMouse: () => ({ handled: true }),
				handleMouse: () => ({ handled: true }),
				render: (w: number) => thinkingMd.render(w),
				invalidate: () => thinkingMd.invalidate(),
			} as unknown as Component;
			const bodyMd = new Markdown("**final answer**", 1, 0, plainMarkdownTheme);
			this.contentContainer.children = [mouseWrappedThinking, bodyMd];
		}
	}

	const handle = applyPatch(
		(text) => ({ render: () => [`RICH:${text}`], invalidate() {} }),
		FakeThinkingAssistantMessage.prototype,
	);
	assert.equal(handle.installed, true);

	const inst = new FakeThinkingAssistantMessage();
	inst.updateContent("ignored", false);

	assert.equal(inst.thinkingVisibilityOverrides.size, 0, "per-run click collapse overrides must be cleared");
	assert.equal(
		inst.contentContainer.children[0] instanceof Markdown,
		true,
		"thinking MouseRegion must be unwrapped to its inner native Markdown",
	);
	assert.equal(
		(inst.contentContainer.children[0] as unknown as { handleMouse?: unknown }).handleMouse,
		undefined,
		"unwrapped thinking block must no longer intercept mouse clicks",
	);
	assert.deepEqual(
		inst.contentContainer.children[1]?.render(80),
		["RICH:**final answer**"],
		"assistant body Markdown is still replaced with RichMarkdown",
	);

	handle.release();
});
