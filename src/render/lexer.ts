/**
 * Markdown lexer: marked (the instance pi-tui ships) plus math tokens.
 *
 * Block math:  $$…$$, \[…\], \begin{equation|align|gather|…}…\end{…} at line start.
 * Inline math: $$…$$, \(…\), $…$ (pandoc rules: no space inside the delimiters,
 *              closing $ not followed by a digit, so "$5 and $10" stays text).
 *
 * While streaming, an unclosed block formula at the end of the text becomes a
 * `blockMath` token with `closed: false` so it can be shown as dimmed source
 * instead of flickering through paragraph/escape rendering.
 */
import { Marked, type Token } from "@earendil-works/pi-tui";

export interface BlockMathToken {
	type: "blockMath";
	raw: string;
	text: string;
	closed: boolean;
}

export interface InlineMathToken {
	type: "inlineMath";
	raw: string;
	text: string;
	display: boolean;
}

const ENVIRONMENTS = "equation|align|alignat|gather|multline|flalign|eqnarray|split|cases|matrix|pmatrix|bmatrix|vmatrix";

const BLOCK_START = new RegExp(String.raw`(?:^|\n) {0,3}(?:\$\$|\\\[|\\begin\{(?:${ENVIRONMENTS})\*?\})`);
const BLOCK_DOLLAR = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/;
const BLOCK_BRACKET = /^ {0,3}\\\[([\s\S]+?)\\\][ \t]*(?:\n|$)/;
const BLOCK_ENV = new RegExp(String.raw`^ {0,3}(\\begin\{((?:${ENVIRONMENTS})\*?)\}[\s\S]+?\\end\{\2\})[ \t]*(?:\n|$)`);
const BLOCK_OPEN = new RegExp(String.raw`^ {0,3}(?:\$\$|\\\[|\\begin\{(?:${ENVIRONMENTS})\*?\})`);

const INLINE_DISPLAY = /^\$\$(?!\$)((?:\\.|[^\\$])+?)\$\$/;
const INLINE_PAREN = /^\\\(((?:\\.|[^\\\n]|\n(?!\n))+?)\\\)/;
const INLINE_DOLLAR = /^\$(?![\s$])((?:\\.|[^\\$\n])*?[^\s\\$])\$(?!\d)|^\$([^\s$\\])\$(?!\d)/;

const STRICT_STRIKETHROUGH = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;
const CJK_CLASS = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\ufe10-\ufe19\ufe30-\ufe6b\uff01-\uffee`;
const CJK_CHAR = new RegExp(`[${CJK_CLASS}]`, "u");

function buildEmStrongRDelim(ch: "*" | "_"): RegExp {
	if (ch === "_") {
		const p = String.raw`[\p{P}\p{S}${CJK_CLASS}]`,
			ps = String.raw`[\s\p{P}\p{S}${CJK_CLASS}]`,
			nps = String.raw`[^\s\p{P}\p{S}${CJK_CLASS}]`;
		return new RegExp(
			String.raw`^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)${p}(_+)(?=[\s]|$)|${nps}(_+)(?!_)(?=${ps}|$)|(?!_)${ps}(_+)(?=${nps})|[\s](_+)(?!_)(?=${p})|(?!_)${p}(_+)(?!_)(?=${p})`,
			"gu",
		);
	}
	const p = String.raw`(?!~)[\p{P}\p{S}${CJK_CLASS}]`,
		ps = String.raw`(?!~)[\s\p{P}\p{S}${CJK_CLASS}]`,
		nps = String.raw`(?:[^\s\p{P}\p{S}${CJK_CLASS}]|~)`;
	return new RegExp(
		String.raw`^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)${p}(\*+)(?=[\s]|$)|${nps}(\*+)(?!\*)(?=${ps}|$)|(?!\*)${ps}(\*+)(?=${nps})|[\s](\*+)(?!\*)(?=${p})|(?!\*)${p}(\*+)(?!\*)(?=${p})|${nps}(\*+)(?=${nps})`,
		"gu",
	);
}

const EM_STRONG_R_AST = buildEmStrongRDelim("*");
const EM_STRONG_R_UND = buildEmStrongRDelim("_");

function lastCodePoint(str: string, end: number): string {
	return end > 0 ? ([...str.slice(Math.max(0, end - 2), end)].pop() ?? "") : "";
}

/**
 * CommonMark delimiter-stack emphasis tokenizer with CJK boundary support.
 *
 * Replaces marked's single-counter `emStrong` loop, which fails to close outer
 * `**…**` whenever a nested `*…*` closes before punctuation (e.g. `**text *(note)*:**`)
 * because `(2 + 1) % 3 === 0` skips decrementing the counter tracked against the
 * outer opener instead of matching the inner `*` opener on the stack.
 */
function tokenizeEmStrong(this: any, src: string, maskedSrc: string, prevChar = ""): any {
	const { rules } = this;
	let match = rules.inline.emStrongLDelim.exec(src);
	if (!match || (!match[1] && !match[2] && !match[3] && !match[4])) return undefined;
	if (match[4] && prevChar.match(rules.other.unicodeAlphaNumeric)) return undefined;

	const nextPunct = match[1] || match[3] || "";
	const startIdx = maskedSrc.length - src.length;
	const prevCp = lastCodePoint(maskedSrc, startIdx) || prevChar;
	const prevIsCjk = Boolean(prevCp && CJK_CHAR.test(prevCp));
	if (nextPunct && prevChar && !rules.inline.punctuation.exec(prevChar) && !prevIsCjk && !CJK_CHAR.test(nextPunct)) {
		return undefined;
	}

	const lLength = [...match[0]].length - 1;
	const ch = match[0][0] as "*" | "_";
	let leadSame = 0;
	if (prevChar === ch) {
		for (let k = startIdx - 1; k >= 0 && maskedSrc[k] === ch; k--) leadSame++;
	}
	const beforeRun = lastCodePoint(maskedSrc, startIdx - leadSame);
	const d0Both = Boolean(
		beforeRun &&
			!/^\s/u.test(beforeRun) &&
			(ch === "_"
				? Boolean(nextPunct)
				: (!rules.inline.punctuation.exec(beforeRun) && !CJK_CHAR.test(beforeRun)) ||
					Boolean(nextPunct) ||
					CJK_CHAR.test(match[2] || "")),
	);

	const openers = [{ len: lLength, orig: lLength + leadSame, both: d0Both }];
	const endReg = ch === "*" ? EM_STRONG_R_AST : EM_STRONG_R_UND;
	endReg.lastIndex = 0;
	const clipped = maskedSrc.slice(-1 * src.length + lLength);

	while ((match = endReg.exec(clipped)) !== null) {
		const rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
		if (!rDelim) continue;
		const rOrig = [...rDelim].length;
		const before = String.fromCodePoint(match[0].codePointAt(0)!);
		const afterPos = match.index + match[0].length;
		const after = afterPos < clipped.length ? String.fromCodePoint(clipped.codePointAt(afterPos)!) : "";
		const cjkBoth =
			Boolean(match[1] || match[2] || match[3] || match[4]) &&
			!/^\s/u.test(before) &&
			Boolean(after) &&
			!/^\s/u.test(after) &&
			(CJK_CHAR.test(before) || CJK_CHAR.test(after));
		const isLeftOnly = Boolean(match[3] || match[4]);
		const isBoth = Boolean(match[5] || match[6]);
		const canOpen =
			(isLeftOnly || isBoth || cjkBoth) &&
			!(ch === "_" && rules.other.unicodeAlphaNumeric.test(before) && !CJK_CHAR.test(before));
		const canClose = !isLeftOnly || cjkBoth;
		const rBoth = canOpen && canClose;

		let rem = rOrig;
		let d0Used = 0;
		if (canClose) {
			for (let j = openers.length - 1; j >= 0 && rem > 0; j--) {
				const open = openers[j]!;
				if ((open.both || rBoth) && (open.orig + rOrig) % 3 === 0 && (open.orig % 3 !== 0 || rOrig % 3 !== 0)) {
					continue;
				}
				openers.length = j + 1;
				const used = Math.min(open.len, rem);
				open.len -= used;
				rem -= used;
				if (j === 0) d0Used = used;
				else if (open.len === 0) openers.pop();
			}
		}

		if (openers[0]!.len === 0) {
			const usedR = rOrig - rem;
			const firstCharLen = [...match[0]][0]!.length;
			const raw = src.slice(0, lLength + match.index + firstCharLen + usedR);
			const step = d0Used % 2 ? 1 : 2;
			const text = raw.slice(step, -step);
			return {
				type: step === 1 ? "em" : "strong",
				raw,
				text,
				tokens: this.lexer.inlineTokens(text),
			};
		}

		if (canOpen && rem > 0) {
			openers.push({ len: rem, orig: rOrig, both: rBoth });
		}
	}
	return undefined;
}

function createMarked(streaming: boolean): Marked {
	const marked = new Marked({ gfm: true });
	marked.use({
		tokenizer: {
			emStrong: tokenizeEmStrong,
			del(this: any, src: string) {
				const m = STRICT_STRIKETHROUGH.exec(src);
				if (!m) return undefined;
				return { type: "del", raw: m[0], text: m[2]!, tokens: this.lexer.inlineTokens(m[2]!) };
			},
		},
		extensions: [
			{
				name: "blockMath",
				level: "block",
				start(src: string) {
					const m = BLOCK_START.exec(src);
					if (!m) return undefined;
					return m[0].startsWith("\n") ? m.index + 1 : m.index;
				},
				tokenizer(src: string) {
					let m = BLOCK_DOLLAR.exec(src);
					if (m) return { type: "blockMath", raw: m[0], text: m[1]!.trim(), closed: true };
					m = BLOCK_BRACKET.exec(src);
					if (m) return { type: "blockMath", raw: m[0], text: m[1]!.trim(), closed: true };
					m = BLOCK_ENV.exec(src);
					if (m) return { type: "blockMath", raw: m[0], text: m[1]!.trim(), closed: true };
					if (streaming && BLOCK_OPEN.test(src)) {
						// Unclosed formula at the tail of a streaming message.
						return { type: "blockMath", raw: src, text: src.trim(), closed: false };
					}
					return undefined;
				},
			},
			{
				name: "inlineMath",
				level: "inline",
				start(src: string) {
					const i = src.search(/\$|\\\(/);
					return i < 0 ? undefined : i;
				},
				tokenizer(src: string) {
					let m = INLINE_DISPLAY.exec(src);
					if (m) return { type: "inlineMath", raw: m[0], text: m[1]!.trim(), display: true };
					m = INLINE_PAREN.exec(src);
					if (m) return { type: "inlineMath", raw: m[0], text: m[1]!.trim(), display: false };
					m = INLINE_DOLLAR.exec(src);
					if (m) return { type: "inlineMath", raw: m[0], text: (m[1] ?? m[2])!, display: false };
					return undefined;
				},
			},
		],
	});
	return marked;
}

const lexers = { streaming: createMarked(true), final: createMarked(false) };

function fullLex(markdown: string, streaming: boolean): Token[] {
	return (streaming ? lexers.streaming : lexers.final).lexer(markdown);
}

/**
 * Incremental lexing for streaming.
 *
 * Each delta extends the previous text, and blocks that are followed by at
 * least two other blocks can no longer change: markdown only ever re-shapes
 * the last block(s) (a paragraph turning into a table header or setext
 * heading, a list absorbing a continuation, an unclosed fence). So the tokens
 * before the last two blocks are reused and only the tail is lexed again,
 * which keeps the per-delta cost flat instead of growing with the message.
 *
 * Falls back to a full lex when the text is not an extension of a recent one,
 * when token raws do not add up to the source, or when the text contains
 * link reference definitions (they resolve links anywhere in the document).
 */
interface LexEntry {
	src: string;
	tokens: Token[];
	/** Offsets where each top-level token starts (tokens.length + 1 entries). */
	offsets: number[];
}

const RECENT_LIMIT = 8;
const recent: LexEntry[] = [];
const REF_DEF = /^ {0,3}\[[^\]\n]+\]:/m;
const REUSE_BLOCKS_KEPT = 2;

export const lexStats = { full: 0, incremental: 0 };

function offsetsOf(tokens: Token[]): number[] {
	const offsets = [0];
	for (const t of tokens) offsets.push(offsets[offsets.length - 1]! + (t as any).raw.length);
	return offsets;
}

function remember(entry: LexEntry): void {
	const i = recent.findIndex((e) => entry.src.startsWith(e.src));
	if (i >= 0) recent.splice(i, 1);
	recent.push(entry);
	if (recent.length > RECENT_LIMIT) recent.shift();
}

function lexFrom(previous: LexEntry, src: string, streaming: boolean): Token[] | undefined {
	const { tokens, offsets } = previous;
	// Keep everything before the last REUSE_BLOCKS_KEPT non-space tokens.
	let cut = tokens.length;
	for (let seen = 0; cut > 0 && seen < REUSE_BLOCKS_KEPT; ) {
		cut--;
		if (tokens[cut]!.type !== "space") seen++;
	}
	if (cut === 0) return undefined;
	const offset = offsets[cut]!;
	// A definition anywhere can change how earlier links lex.
	if (REF_DEF.test(src)) return undefined;
	return tokens.slice(0, cut).concat(fullLex(src.slice(offset), streaming));
}

export function lex(markdown: string, streaming: boolean): Token[] {
	const src = markdown.includes("\r") ? markdown.replace(/\r\n?/g, "\n") : markdown;
	let previous: LexEntry | undefined;
	for (const entry of recent) {
		if (entry.src.length <= src.length && src.startsWith(entry.src) && (!previous || entry.src.length > previous.src.length)) previous = entry;
	}

	let tokens = previous ? lexFrom(previous, src, streaming) : undefined;
	if (tokens) lexStats.incremental++;
	else {
		tokens = fullLex(src, streaming);
		lexStats.full++;
	}
	const offsets = offsetsOf(tokens);
	// Only texts whose raws add up exactly can be extended later.
	if (offsets[offsets.length - 1] === src.length) remember({ src, tokens, offsets });

	if (streaming) {
		// trimPartialClosingFence mutates the last code token; never touch shared/cached tokens.
		const last = tokens[tokens.length - 1] as any;
		if (last && (last.type === "code" || last.type === "list" || last.type === "blockquote")) {
			tokens = tokens.slice(0, -1).concat(structuredClone(last));
			trimPartialClosingFence(tokens);
		}
	}
	return tokens;
}

export function clearLexCache(): void {
	recent.length = 0;
}

/** Lex inline markdown only (table cells are already lexed by marked, used for tests). */
export function lexInline(markdown: string): Token[] {
	return lexers.final.Lexer.lexInline(markdown, lexers.final.defaults);
}

/**
 * While a closing ``` is arriving character by character, marked treats the
 * partial fence as a code line. Drop it so the block does not flicker.
 * (Same idea as pi-tui's trimPartialClosingFences.)
 */
function trimPartialClosingFence(tokens: Token[]): void {
	const token = tokens[tokens.length - 1] as any;
	if (!token) return;
	if (token.type === "list") {
		trimPartialClosingFence(token.items[token.items.length - 1]?.tokens ?? []);
		return;
	}
	if (token.type === "blockquote") {
		trimPartialClosingFence(token.tokens ?? []);
		return;
	}
	if (token.type !== "code") return;
	const marker = /^ {0,3}(`{3,}|~{3,})/.exec(token.raw)?.[1];
	const lastLine = token.raw.replace(/\n$/, "").split("\n").pop()?.trim();
	if (!marker || !lastLine || lastLine.length >= marker.length) return;
	if (lastLine !== marker[0]!.repeat(lastLine.length)) return;
	token.text = token.text.slice(0, -lastLine.length).replace(/\n$/, "");
}
