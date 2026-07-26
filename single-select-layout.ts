export interface QuestionOption {
	title: string;
	description?: string;
}

export interface AnnotatedRow {
	line: string;
	selected: boolean;
}

export interface CenteredBlockWindow {
	startIndex: number;
	endIndex: number;
	contentRows: number;
	paddingBeforeRows: number;
	paddingAfterRows: number;
	/** True when the returned window is a viewport over overflowing content. */
	overflow: boolean;
}

/**
 * Pick a contiguous, block-aligned window around the focused item. Blocks are
 * kept whole whenever they fit; an oversized focused block is handled by the
 * caller by clipping its rows to `contentRows`.
 *
 * The final row of an overflowing viewport is reserved for the position
 * indicator, matching the select-list rendering in both modes.
 */
export function getCenteredBlockWindow(
	blocks: ReadonlyArray<{ lines: readonly unknown[] }>,
	selectedIndex: number,
	maxRows: number,
): CenteredBlockWindow {
	const safeMaxRows = Math.max(1, Math.floor(maxRows));
	const totalRows = blocks.reduce((sum, block) => sum + block.lines.length, 0);
	if (totalRows <= safeMaxRows) {
		return {
			startIndex: 0,
			endIndex: blocks.length,
			contentRows: totalRows,
			paddingBeforeRows: 0,
			paddingAfterRows: 0,
			overflow: false,
		};
	}

	const contentRows = safeMaxRows > 1 ? safeMaxRows - 1 : 1;
	if (blocks.length === 0) {
		return {
			startIndex: 0,
			endIndex: 0,
			contentRows,
			paddingBeforeRows: 0,
			paddingAfterRows: contentRows,
			overflow: true,
		};
	}

	const focusedIndex = Math.max(0, Math.min(selectedIndex, blocks.length - 1));
	const focusedRows = blocks[focusedIndex]?.lines.length ?? 0;
	if (focusedRows >= contentRows) {
		return {
			startIndex: focusedIndex,
			endIndex: focusedIndex + 1,
			contentRows,
			paddingBeforeRows: 0,
			paddingAfterRows: 0,
			overflow: true,
		};
	}

	const rowPrefix = [0];
	for (const block of blocks) rowPrefix.push(rowPrefix[rowPrefix.length - 1]! + block.lines.length);
	const viewportCenter = contentRows / 2;
	const focusedCenter = rowPrefix[focusedIndex]! + focusedRows / 2;

	// At the top and bottom boundaries, preserving the edge anchor takes
	// precedence over filling every content row. This prevents a tall adjacent
	// block from moving focus past the viewport midpoint prematurely.
	if (focusedCenter <= viewportCenter) {
		let endIndex = 0;
		while (endIndex < blocks.length && rowPrefix[endIndex + 1]! <= contentRows) endIndex++;
		const usedRows = rowPrefix[endIndex]!;
		return {
			startIndex: 0,
			endIndex,
			contentRows,
			paddingBeforeRows: 0,
			paddingAfterRows: contentRows - usedRows,
			overflow: true,
		};
	}

	if (focusedCenter >= totalRows - viewportCenter) {
		let startIndex = blocks.length;
		while (startIndex > 0 && totalRows - rowPrefix[startIndex - 1]! <= contentRows) startIndex--;
		const usedRows = totalRows - rowPrefix[startIndex]!;
		return {
			startIndex,
			endIndex: blocks.length,
			contentRows,
			paddingBeforeRows: contentRows - usedRows,
			paddingAfterRows: 0,
			overflow: true,
		};
	}

	type Candidate = {
		startIndex: number;
		endIndex: number;
		usedRows: number;
		paddingBeforeRows: number;
		distance: number;
	};
	let best: Candidate | undefined;

	// In the middle, choose a conventional centered, contiguous full-block
	// window. Unavoidable slack participates in centering before occupied-row
	// count, so variable-height neighbors cannot pull focus off its anchor.
	for (let startIndex = 0; startIndex <= focusedIndex; startIndex++) {
		for (let endIndex = focusedIndex + 1; endIndex <= blocks.length; endIndex++) {
			const usedRows = rowPrefix[endIndex]! - rowPrefix[startIndex]!;
			if (usedRows > contentRows) break;

			const slack = contentRows - usedRows;
			const focusedCenterInWindow = rowPrefix[focusedIndex]! - rowPrefix[startIndex]! + focusedRows / 2;
			const idealPadding = viewportCenter - focusedCenterInWindow;
			const paddingBeforeRows = Math.max(0, Math.min(slack, Math.round(idealPadding)));
			const distance = Math.abs(focusedCenterInWindow + paddingBeforeRows - viewportCenter);
			if (
				!best ||
				distance < best.distance - Number.EPSILON ||
				(Math.abs(distance - best.distance) <= Number.EPSILON && usedRows > best.usedRows) ||
				(Math.abs(distance - best.distance) <= Number.EPSILON &&
					usedRows === best.usedRows && startIndex < best.startIndex)
			) {
				best = { startIndex, endIndex, usedRows, paddingBeforeRows, distance };
			}
		}
	}

	const usedRows = best?.usedRows ?? focusedRows;
	const paddingBeforeRows = best?.paddingBeforeRows ?? 0;
	return {
		startIndex: best?.startIndex ?? focusedIndex,
		endIndex: best?.endIndex ?? focusedIndex + 1,
		contentRows,
		paddingBeforeRows,
		paddingAfterRows: contentRows - usedRows - paddingBeforeRows,
		overflow: true,
	};
}

export interface RenderSingleSelectRowsParams {
	options: QuestionOption[];
	selectedIndex: number;
	width: number;
	allowFreeform: boolean;
	allowComment?: boolean;
	commentEnabled?: boolean;
	maxRows?: number;
	hideDescriptions?: boolean;
}

function wrapText(text: string, width: number): string[] {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return [""];
	if (width <= 1) return normalized.split("");

	const words = normalized.split(" ");
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		if (!current) {
			if (word.length <= width) {
				current = word;
			} else {
				for (let i = 0; i < word.length; i += width) {
					lines.push(word.slice(i, i + width));
				}
			}
			continue;
		}

		const candidate = `${current} ${word}`;
		if (candidate.length <= width) {
			current = candidate;
			continue;
		}

		lines.push(current);
		if (word.length <= width) {
			current = word;
		} else {
			current = "";
			for (let i = 0; i < word.length; i += width) {
				const chunk = word.slice(i, i + width);
				if (chunk.length === width || i + width < word.length) lines.push(chunk);
				else current = chunk;
			}
		}
	}

	if (current) lines.push(current);
	return lines;
}

function padLine(prefix: string, content: string): string {
	return `${prefix}${content}`.trimEnd();
}

interface ItemBlock {
	itemIndex: number;
	lines: string[];
}

type ListItem =
	| { type: "option"; option: QuestionOption }
	| { type: "comment-toggle"; option: QuestionOption }
	| { type: "freeform"; option: QuestionOption };

function buildItemBlocks(
	options: QuestionOption[],
	width: number,
	allowFreeform: boolean,
	allowComment: boolean,
	commentEnabled: boolean,
	selectedIndex: number,
	hideDescriptions = false,
): ItemBlock[] {
	const normalizedWidth = Math.max(12, width);
	const freeformLabel = "Type something. — Enter a custom response";
	const commentToggleLabel = `${commentEnabled ? "[✓]" : "[ ]"} Add extra context after selection`;
	const allItems: ListItem[] = options.map((option) => ({ type: "option", option }));
	if (allowComment) {
		allItems.push({ type: "comment-toggle", option: { title: commentToggleLabel } });
	}
	if (allowFreeform) {
		allItems.push({ type: "freeform", option: { title: freeformLabel } });
	}

	return allItems.map((item, itemIndex) => {
		const pointer = itemIndex === selectedIndex ? "→" : " ";
		const lines: string[] = [];

		if (item.type === "comment-toggle" || item.type === "freeform") {
			const prefix = `${pointer}   `;
			const wrapped = wrapText(item.option.title, Math.max(8, normalizedWidth - prefix.length));
			wrapped.forEach((line, lineIndex) => {
				lines.push(padLine(lineIndex === 0 ? prefix : " ".repeat(prefix.length), line));
			});
			return { itemIndex, lines };
		}

		const numberPrefix = `${pointer} ${itemIndex + 1}. `;
		const continuationPrefix = " ".repeat(numberPrefix.length);
		const titleLines = wrapText(item.option.title, Math.max(8, normalizedWidth - numberPrefix.length));
		titleLines.forEach((line, lineIndex) => {
			lines.push(padLine(lineIndex === 0 ? numberPrefix : continuationPrefix, line));
		});

		if (item.option.description && !hideDescriptions) {
			const descriptionPrefix = "      ";
			const descriptionLines = wrapText(
				item.option.description,
				Math.max(8, normalizedWidth - descriptionPrefix.length),
			);
			descriptionLines.forEach((line) => {
				lines.push(padLine(descriptionPrefix, line));
			});
		}

		return { itemIndex, lines };
	});
}

function flatten(blocks: ItemBlock[], selectedIndex: number): AnnotatedRow[] {
	return blocks.flatMap((block) =>
		block.lines.map((line) => ({
			line,
			selected: block.itemIndex === selectedIndex,
		})),
	);
}

export function renderSingleSelectRows({
	options,
	selectedIndex,
	width,
	allowFreeform,
	allowComment = false,
	commentEnabled = false,
	maxRows,
	hideDescriptions,
}: RenderSingleSelectRowsParams): AnnotatedRow[] {
	const itemCount = options.length + (allowComment ? 1 : 0) + (allowFreeform ? 1 : 0);
	const blocks = buildItemBlocks(options, width, allowFreeform, allowComment, commentEnabled, selectedIndex, hideDescriptions);
	const allRows = flatten(blocks, selectedIndex);

	if (!Number.isFinite(maxRows) || !maxRows || maxRows <= 0 || allRows.length <= maxRows) {
		return allRows;
	}

	const window = getCenteredBlockWindow(blocks, selectedIndex, maxRows);
	const safeMaxRows = Math.max(1, Math.floor(maxRows));
	const availableRows = window.contentRows;
	const selectedBlock = blocks[selectedIndex] ?? blocks[0];
	if (!selectedBlock) return [];

	const visible = flatten(blocks.slice(window.startIndex, window.endIndex), selectedIndex);
	if (selectedBlock.lines.length >= availableRows) {
		// An individual wrapped block can be taller than the pane. Keep the
		// focused block identifiable while reserving the indicator row.
		visible.splice(availableRows);
	} else {
		visible.unshift(...Array.from({ length: window.paddingBeforeRows }, () => ({ line: "", selected: false })));
		visible.push(...Array.from({ length: window.paddingAfterRows }, () => ({ line: "", selected: false })));
	}
	while (visible.length < availableRows) visible.push({ line: "", selected: false });
	if (safeMaxRows > 1) visible.push({ line: `  (${selectedIndex + 1}/${itemCount})`, selected: false });
	return visible.slice(0, safeMaxRows);
}
