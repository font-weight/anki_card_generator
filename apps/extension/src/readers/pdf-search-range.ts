/**
 * Search joins PDF.js items with spaces and collapses whitespace. Project that
 * normalized UTF-16 index onto the original positioned text nodes for this page.
 * A trimmed query begins and ends inside a word, including punctuation.
 */
export function pdfSearchRange(textDivs: readonly HTMLElement[], index: number, length: number): Range | null {
  const end = index + length;
  let previousEnd: number | undefined, range: Range | null = null;
  for (const [item, div] of textDivs.entries()) {
    const node = div.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;
    for (const word of (node.textContent ?? '').matchAll(/\S+/g)) {
      const from: number = previousEnd === undefined ? Number(item > 0 || word.index > 0) : previousEnd + 1;
      const to = from + word[0].length;
      previousEnd = to;
      if (index >= from && index < to) {
        range = div.ownerDocument.createRange();
        range.setStart(node, word.index + index - from);
      }
      if (range && end > from && end <= to) {
        range.setEnd(node, word.index + end - from);
        return node.isConnected && range.startContainer.isConnected ? range : null;
      }
    }
  }
  return null;
}
