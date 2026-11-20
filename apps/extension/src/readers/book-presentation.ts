/** Display-only fallback for books imported by older versions under their raw filename. */
export function displayBookTitle(title: string): string {
  const leaf = title.trim().split(/[\\/]/).pop() || '';
  const words = leaf.replace(/\.(?:pdf|epub|fb2|x?html?)$/i, '')
    .replace(/^how_(?![Tt][Oo](?:[\s_]|$))(?=how(?:[\s_]|$)|[A-ZА-ЯЁ])/u, '')
    .replace(/^(?:file|download|upload|calpico(?:file)?)_[0-9a-f]{16,}[_ -]+/i, '')
    .replace(/^[0-9a-f]{24,}[_ -]+/i, '').replace(/[_\s]+/g, ' ').trim();
  if (!words || /^(?:sha256[: -]?)?[\da-f]{32,}$/i.test(words)) return 'Книга без названия';
  return /^\p{Ll}/u.test(words) && (leaf.includes('_') || /\.(pdf|epub|fb2)$/i.test(leaf)) ?
    words.charAt(0).toLocaleUpperCase() + words.slice(1) : words;
}

export function chapterTitle(value: string): string {
  const name = value.split('#')[0] || '';
  if (!name || name.startsWith('epubcfi(')) return '';
  const plain = displayBookTitle(name);
  const numbered = /^(?:section|chapter|chap|ch|part|text|split)[\s-]*0*(\d+)$/i.exec(plain);
  if (numbered) return 'Раздел ' + Number(numbered[1]);
  if (/^(?:index|content|toc|body|cover|titlepage|untitled|\d+)$/i.test(plain) ||
      /^(?:[a-f0-9]{8}[-_ ]?){3,}/i.test(plain)) return '';
  return plain;
}

/** Keep the last fractional percent distinct from a completed book. */
export function displayBookPercent(percent:number):number {
  return percent<100?Math.min(99,Math.round(percent)):100;
}
