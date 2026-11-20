import React, { memo, type ReactNode } from 'react';

interface Props { text: string; language: string }

interface Emphasis {
  marker: string;
  start: number;
  children: ReactNode[];
}

// Only these explicitly constructed elements can reach the DOM. Raw HTML, URLs
// and image syntax are ordinary text. Keys and table dimensions originate here.
function inline(text: string): ReactNode[] {
  const output: ReactNode[] = [];
  const stack: Emphasis[] = [];
  const children = () => stack.at(-1)?.children ?? output;
  const syntax = /\\([\\`*_#>|[\]~-])|!?\[[^\[\]\n]*\]\([^\s()]*\)|https?:\/\/[^\s<>"']+|`+|(\*\p{L}[\p{L}\p{M}]*(?:\/\*\p{L}[\p{L}\p{M}]*)+)|\*+|_+/gu;
  const codeEnd = new Map<number, number>();
  const previousCode = new Map<number, number>();
  for (const run of text.matchAll(/`+/g)) {
    const prior = previousCode.get(run[0].length);
    if (prior !== undefined) codeEnd.set(prior, run.index);
    previousCode.set(run[0].length, run.index);
  }
  const word = /[\p{L}\p{N}\p{M}]/u;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = syntax.exec(text))) {
    const marker = match[0];
    const start = match.index;
    if (start > cursor) children().push(text.slice(cursor, start));
    cursor = syntax.lastIndex;
    // Escapes and linguistic alternatives such as *goed/*buyed are literal.
    if (match[1] || match[2]) {
      children().push(match[1] ?? match[2]);
      continue;
    }
    if (marker.startsWith('[') || marker.startsWith('![') || /^https?:/.test(marker)) {
      let literal = marker;
      const enclosing = stack.at(-1)?.marker;
      if (enclosing && /^https?:/.test(marker) && marker.endsWith(enclosing)) {
        literal = marker.slice(0, -enclosing.length);
        cursor = syntax.lastIndex = start + literal.length;
      }
      children().push(literal);
      continue;
    }
    if (marker.startsWith('`')) {
      const end = codeEnd.get(start);
      if (end === undefined) children().push(marker);
      else {
        children().push(<code key={start}>{text.slice(cursor, end)}</code>);
        cursor = syntax.lastIndex = end + marker.length;
      }
      continue;
    }
    const prior = text[start - 1] ?? '';
    const next = text[cursor] ?? '';
    const insideWord = marker[0] === '_' && word.test(prior) && word.test(next);
    if (insideWord || marker.length > 3) {
      children().push(marker);
      continue;
    }
    let remaining = marker;
    if (prior && !/\s/u.test(prior)) {
      while (stack.length && remaining.startsWith(stack.at(-1)!.marker)) {
        const group = stack.pop()!;
        const content = group.children;
        const styled = group.marker.length === 1 ? <em key={group.start}>{content}</em>
          : <strong key={group.start}>{group.marker.length === 3 ? <em>{content}</em> : content}</strong>;
        children().push(styled);
        remaining = remaining.slice(group.marker.length);
      }
    }
    if (remaining && next && !/\s/u.test(next) && stack.length < 12)
      stack.push({marker:remaining, start, children:[]});
    else if (remaining) children().push(remaining);
  }
  if (cursor < text.length) children().push(text.slice(cursor));
  while (stack.length) {
    const group = stack.pop()!;
    children().push(<React.Fragment key={group.start}>{group.marker}{group.children}</React.Fragment>);
  }
  return output;
}

const heading = /^ {0,3}(#{1,6})[ \t]+(\S.*)$/;
const fence = /^ {0,3}(`{3,}|~{3,})([^`~]*)$/;
const quote = /^ {0,3}> ?/;
const listItem = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+)(\S.*)$/;
const ordered = (marker: string) => /^\d/.test(marker);

function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let codeWidth = 0;
  let hasPipe = false;
  const trimmed = line.trim();
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (char === '\\' && trimmed[i + 1] === '|') { cell += '|'; i++; }
    else if (char === '`') {
      let end = i + 1;
      while (trimmed[end] === '`') end++;
      const width = end - i;
      if (!codeWidth || width === codeWidth) codeWidth = codeWidth ? 0 : width;
      cell += trimmed.slice(i, end); i = end - 1;
    } else if (char === '|' && !codeWidth) {
      if (i !== 0) cells.push(cell.trim());
      hasPipe = true; cell = '';
    } else cell += char;
  }
  if (!hasPipe) return [];
  if (cell || !trimmed.endsWith('|')) cells.push(cell.trim());
  return cells;
}

function tableHead(lines: string[], at: number): string[] | undefined {
  const delimiter = lines[at + 1];
  if (!delimiter || !lines[at].includes('|') || !/^[ :|\t-]+$/.test(delimiter)) return;
  const columns = tableCells(lines[at]);
  if (columns.length < 2) return;
  const separators = tableCells(delimiter);
  if (columns.length === separators.length && separators.every(cell => /^:?-{3,}:?$/.test(cell))) return columns;
}

function blocks(lines: string[], depth = 0): ReactNode[] {
  const result: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const start = i;
    const line = lines[i++];
    const opened = fence.exec(line);
    if (opened) {
      const fenceMark = opened[1];
      const content: string[] = [];
      while (i < lines.length) {
        const current = lines[i++];
        const end = current.trimEnd().replace(/^ {0,3}/, '');
        if (end.startsWith(fenceMark) && (fenceMark[0] === '`' ? /^`+$/.test(end) : /^~+$/.test(end))) break;
        content.push(current);
      }
      result.push(<pre key={start}><code>{content.join('\n')}</code></pre>);
      continue;
    }
    const title = heading.exec(line);
    if (title) {
      const tag = ['h3', 'h4', 'h5', 'h6', 'h6', 'h6'][title[1].length - 1];
      result.push(React.createElement(tag, {key:start}, inline(title[2].replace(/[ \t]+#+[ \t]*$/, ''))));
      continue;
    }
    if (depth < 8 && quote.test(line)) {
      const body = [line.replace(quote, '')];
      while (i < lines.length && quote.test(lines[i])) body.push(lines[i++].replace(quote, ''));
      result.push(<blockquote key={start}>{blocks(body, depth + 1)}</blockquote>);
      continue;
    }
    const first = listItem.exec(line);
    if (first && depth < 8) {
      const numbered = ordered(first[2]);
      const indent = first[1].length;
      const items: ReactNode[] = [];
      let item: RegExpExecArray | null = first;
      while (item && item[1].length === indent && ordered(item[2]) === numbered) {
        const itemLine = i - 1;
        const body = [item[4]];
        const padding = indent + item[2].length + item[3].length;
        const continuation = ' '.repeat(padding);
        while (i < lines.length && lines[i].startsWith(continuation))
          body.push(lines[i++].slice(padding));
        items.push(<li key={itemLine}>{body.length === 1 ? inline(body[0]) : blocks(body, depth + 1)}</li>);
        item = i < lines.length ? listItem.exec(lines[i]) : null;
        if (item && item[1].length === indent && ordered(item[2]) === numbered) i++;
      }
      result.push(numbered ? <ol key={start} start={Number.parseInt(first[2], 10)}>{items}</ol> : <ul key={start}>{items}</ul>);
      continue;
    }
    const columns = tableHead(lines, start);
    if (columns) {
      i++;
      const rows: ReactNode[] = [];
      while (i < lines.length && lines[i].includes('|')) {
        const values = tableCells(lines[i]);
        if (values.length !== columns.length) break;
        rows.push(<tr key={i++}>{values.map((value, n) => <td key={n}>{inline(value)}</td>)}</tr>);
      }
      result.push(<div className="language-chat-table" key={start}><table>
        <thead><tr>{columns.map((value, n) => <th key={n} scope="col">{inline(value)}</th>)}</tr></thead>
        <tbody>{rows}</tbody>
      </table></div>);
      continue;
    }
    const paragraph = [line];
    while (i < lines.length && lines[i].trim() && !heading.test(lines[i]) &&
        !fence.test(lines[i]) && !quote.test(lines[i]) && !listItem.test(lines[i]) && !tableHead(lines, i))
      paragraph.push(lines[i++]);
    result.push(<p key={start}>{inline(paragraph.join('\n'))}</p>);
  }
  return result;
}

export const LanguageChatMarkdown = memo(function LanguageChatMarkdown({text, language}: Props) {
  return <div className="language-chat-markdown" dir="auto" lang={language}>{blocks(text.split(/\r\n?|\n/))}</div>;
});
