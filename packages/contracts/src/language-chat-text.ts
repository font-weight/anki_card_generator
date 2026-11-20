// Questions and provider answers are stored as source text. The chat UI may
// format Markdown with React elements; this check never authorizes HTML or an Anki field.
export function isLanguageChatText(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value);
}
