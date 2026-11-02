/**
 * Swap pi's Markdown component for RichMarkdown inside assistant messages.
 *
 * `AssistantMessageComponent.updateContent` rebuilds its children from the
 * message on every streaming delta. We let it run unchanged, then replace each
 * direct Markdown child (assistant text blocks; thinking blocks are wrapped in
 * a MouseRegion and stay native) with a RichMarkdown built from the same text.
 * The message object is never touched, so sessions and LLM context keep the
 * original Markdown/LaTeX.
 *
 * Same lifecycle as pi-tool-display's UserMessageComponent patch: idempotent,
 * versioned, fully restorable.
 */
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown } from "@earendil-works/pi-tui";
import type { MarkdownTransform } from "./render/rich-markdown.ts";
import { state } from "./state.ts";

export type RichFactory = (text: string, paddingX: number, streaming: boolean, transform: MarkdownTransform | undefined) => Component;

export interface PatchTarget {
	contentContainer?: { children: Component[] };
	isStreaming?: boolean;
	updateContent?: (this: any, message: unknown, isStreaming?: boolean) => void;
}

export interface PatchHandle {
	installed: boolean;
	reason?: string;
	release(): void;
}

const PATCH = Symbol.for("pi-better-render.assistant-patch");
const PATCH_VERSION = 1;

interface PatchRecord {
	version: number;
	original: (this: any, message: unknown, isStreaming?: boolean) => void;
	factory: RichFactory;
}

type PatchedPrototype = PatchTarget & { [PATCH]?: PatchRecord };

let cachedMarkdownCapabilityError: string | null | undefined;

function probeMarkdownTextField(): string | undefined {
	if (cachedMarkdownCapabilityError !== undefined) return cachedMarkdownCapabilityError ?? undefined;
	try {
		const noop = (s: string) => s;
		const sample = new Markdown("probe", 0, 0, {
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
		}) as unknown as { text?: unknown };
		cachedMarkdownCapabilityError = typeof sample.text === "string" ? null : "Markdown.text field is unavailable";
	} catch (error) {
		cachedMarkdownCapabilityError = `Markdown probe failed: ${error instanceof Error ? error.message : String(error)}`;
	}
	return cachedMarkdownCapabilityError ?? undefined;
}

/** Verify the host TUI exposes the prototype method and Markdown field the patch relies on. */
export function probePatchCapability(
	proto: PatchTarget | undefined = AssistantMessageComponent?.prototype,
): string | undefined {
	if (!proto || typeof proto.updateContent !== "function") {
		return "AssistantMessageComponent.prototype.updateContent is missing";
	}
	return probeMarkdownTextField();
}

function swapChildren(component: PatchTarget, factory: RichFactory): void {
	const children = component.contentContainer?.children;
	if (!Array.isArray(children)) return;
	for (let i = 0; i < children.length; i++) {
		if (!(children[i] instanceof Markdown)) continue;
		// Markdown keeps these private; they are plain fields at runtime.
		const child = children[i] as unknown as { text?: unknown; paddingX?: number; options?: { transform?: MarkdownTransform } };
		const text = child.text;
		if (typeof text !== "string") continue;
		children[i] = factory(text, child.paddingX ?? 1, Boolean(component.isStreaming), child.options?.transform);
	}
}

export function applyPatch(
	factory: RichFactory,
	target: PatchTarget | undefined = AssistantMessageComponent?.prototype,
): PatchHandle {
	const reason = probePatchCapability(target);
	if (reason || !target || typeof target.updateContent !== "function") {
		return { installed: false, reason: reason ?? "target unavailable", release() {} };
	}
	const proto = target as PatchedPrototype;
	const release = () => {
		if (proto[PATCH]?.factory === factory) removePatch(proto);
	};
	const existing = proto[PATCH];
	if (existing && existing.version === PATCH_VERSION) {
		existing.factory = factory;
		return { installed: true, release };
	}
	if (existing) removePatch(proto);
	const record: PatchRecord = { version: PATCH_VERSION, original: proto.updateContent!, factory };
	proto.updateContent = function patchedUpdateContent(this: PatchTarget, message: unknown, isStreaming?: boolean) {
		record.original.call(this, message, isStreaming);
		if (!state.enabled) return;
		try {
			swapChildren(this, record.factory);
		} catch {
			// Never break pi's own rendering: keep the native children.
		}
	};
	proto[PATCH] = record;
	return { installed: true, release };
}

export function removePatch(target: PatchTarget | undefined = AssistantMessageComponent?.prototype): void {
	if (!target) return;
	const proto = target as PatchedPrototype;
	const record = proto[PATCH];
	if (!record) return;
	proto.updateContent = record.original;
	delete proto[PATCH];
}

export function isPatched(target: PatchTarget | undefined = AssistantMessageComponent?.prototype): boolean {
	return Boolean(target && (target as PatchedPrototype)[PATCH]);
}
