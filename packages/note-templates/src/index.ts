import type { NoteDraft } from '../../contracts/src/index.ts';

export const MODEL_NAMES = Object.freeze({
  recognition: 'EnglishReader.Recognition.v1',
  cloze: 'EnglishReader.Cloze.v1',
});
export const NOTE_FIELDS = Object.freeze([
  'OperationId', 'LexemeKey', 'ContentKey', 'Expression', 'Lemma',
  'PartOfSpeech', 'Meaning', 'DefinitionEN', 'Sentence', 'ClozeSentence',
  'IPA', 'IPASource', 'Audio', 'ExtraExample', 'ExtraExampleTranslation',
  'SourceTitle', 'SourceURL', 'SourceLocation',
] as const);
export type NoteField = typeof NOTE_FIELDS[number];
export type NoteFields = Record<NoteField, string>;
export type SemanticKeys = { lexemeKey: string; contentKey: string };

// Field content is plain data, never HTML, Anki cloze syntax, media syntax or LaTeX.
// Numeric entities preserve visible punctuation while preventing Anki's pre-HTML parsers.
export function escapeAnkiText(value: string): string {
  return value.replace(/[&<>"'{}\[\]:]/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    '{': '&#123;', '}': '&#125;', '[': '&#91;', ']': '&#93;', ':': '&#58;',
  }[character]!));
}

export function safeSourceUrl(value: string | null): string {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    parsed.search = ''; parsed.hash = '';
    return escapeAnkiText(parsed.href);
  } catch { return ''; }
}

function safeSourceLabel(value: string): string {
  // A reader must supply a display title, not its private filesystem path.
  if (/(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|^\/(?:Users|home|tmp|private|var)\/)/u.test(value)) return 'Локальный документ';
  return escapeAnkiText(value);
}

export function buildClozeSentence(draft: Pick<NoteDraft, 'context' | 'expression'>): string {
  const { sentence, targetStart, targetEnd } = draft.context;
  if (!Number.isInteger(targetStart) || !Number.isInteger(targetEnd) || targetStart < 0 ||
      targetEnd <= targetStart || targetEnd > sentence.length || sentence.slice(targetStart, targetEnd) !== draft.expression) {
    throw Object.assign(new Error('Выделение не совпадает с исходным предложением.'), { code: 'INVALID_INPUT', retryable: false });
  }
  return escapeAnkiText(sentence.slice(0, targetStart)) +
    '{{c1::' + escapeAnkiText(sentence.slice(targetStart, targetEnd)) + '}}' +
    escapeAnkiText(sentence.slice(targetEnd));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([key, val]) => JSON.stringify(key) + ':' + canonicalJson(val)).join(',') + '}';
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');

export async function semanticKeys(draft: NoteDraft): Promise<SemanticKeys> {
  const lexemeKey = await sha256(canonicalJson(['lexeme-v1', draft.sourceLanguage, draft.targetLanguage,
    normalize(draft.lemma), normalize(draft.partOfSpeech)]));
  const contentKey = await sha256(canonicalJson(['content-v1', lexemeKey, draft.mode,
    [...new Set(draft.selectedSense.translations.map(normalize))].sort(),
    normalize(draft.selectedSense.definitionEn), draft.context.sentence,
    draft.context.targetStart, draft.context.targetEnd]));
  return { lexemeKey, contentKey };
}

export function validMediaFilename(filename: unknown): filename is string {
  return typeof filename === 'string' && filename.length > 0 && filename.length <= 240 &&
    filename.toLowerCase().endsWith('.mp3') && !/[\x00-\x1f\x7f/\\:\[\]{}<>"'&]/u.test(filename) && filename !== '..';
}

export function buildNoteFields(operationId: string, draft: NoteDraft, keys: SemanticKeys, mediaFilename?: string | null): NoteFields {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operationId)) {
    throw Object.assign(new Error('Некорректный идентификатор операции.'), { code: 'INVALID_INPUT', retryable: false });
  }
  if (mediaFilename && !validMediaFilename(mediaFilename)) {
    throw Object.assign(new Error('Небезопасное имя аудиофайла.'), { code: 'AUDIO_UNAVAILABLE', retryable: false });
  }
  const cloze = buildClozeSentence(draft);
  const sourceLocation = draft.source.kind === 'pdf'
    ? (draft.source.page === null ? '' : `Страница ${draft.source.page}`)
    : draft.source.kind === 'epub'
      ? [draft.source.chapter ? safeSourceLabel(draft.source.chapter) : '', draft.source.cfi ? escapeAnkiText(draft.source.cfi) : ''].filter(Boolean).join(' · ')
      : '';
  return {
    OperationId: operationId,
    LexemeKey: keys.lexemeKey,
    ContentKey: keys.contentKey,
    Expression: escapeAnkiText(draft.expression),
    Lemma: escapeAnkiText(draft.lemma),
    PartOfSpeech: escapeAnkiText(draft.partOfSpeech),
    Meaning: draft.selectedSense.translations.map(escapeAnkiText).join('; '),
    DefinitionEN: escapeAnkiText(draft.selectedSense.definitionEn),
    Sentence: escapeAnkiText(draft.context.sentence),
    ClozeSentence: draft.mode === 'cloze' ? cloze : '',
    IPA: escapeAnkiText(draft.pronunciation.ipa ?? ''),
    IPASource: draft.pronunciation.source === 'generated' ? 'Приблизительно · сгенерировано ИИ'
      : draft.pronunciation.source === 'dictionary' ? 'Словарь' : 'Недоступно',
    Audio: mediaFilename ? `[sound:${mediaFilename}]` : '',
    ExtraExample: escapeAnkiText(draft.extraExample?.textEn ?? ''),
    ExtraExampleTranslation: escapeAnkiText(draft.extraExample?.textRu ?? ''),
    SourceTitle: safeSourceLabel(draft.source.title),
    SourceURL: safeSourceUrl(draft.source.url),
    SourceLocation: sourceLocation,
  };
}

const answer = `<div class="meaning">{{Meaning}}</div>
<div class="definition">{{DefinitionEN}}</div>
{{#IPA}}<div class="ipa">{{IPA}} <small>{{IPASource}}</small></div>{{/IPA}}
{{#Audio}}<div>{{Audio}}</div>{{/Audio}}
{{#ExtraExample}}<div class="example">{{ExtraExample}}<br>{{ExtraExampleTranslation}}<small>Пример: ИИ</small></div>{{/ExtraExample}}
<div class="source">{{SourceTitle}} {{SourceLocation}}
{{#SourceURL}}<br><a href="{{SourceURL}}" rel="noreferrer noopener">Источник</a>{{/SourceURL}}</div>`;
const css = `.card { font-family: Arial, sans-serif; font-size: 22px; text-align: left; line-height: 1.5; }
.expression, .meaning { font-weight: 700; font-size: 1.2em; }
.sentence, .example { white-space: pre-wrap; margin: 1em 0; }
.ipa, .source, small { font-size: .8em; opacity: .75; }
.cloze { font-weight: 700; color: #2b72b8; }
.nightMode .cloze { color: #77b7f7; }`;

export function modelDefinition(mode: NoteDraft['mode']) {
  const recognitionFront = '<div class="expression">{{Expression}}</div><div class="sentence">{{Sentence}}</div>';
  return {
    modelName: MODEL_NAMES[mode],
    inOrderFields: [...NOTE_FIELDS],
    css,
    isCloze: mode === 'cloze',
    cardTemplates: [{
      Name: mode === 'cloze' ? 'Cloze' : 'Recognition',
      Front: mode === 'cloze' ? '<div class="sentence">{{cloze:ClozeSentence}}</div>' : recognitionFront,
      Back: mode === 'cloze' ? '<div class="sentence">{{cloze:ClozeSentence}}</div><hr id="answer">' + answer
        : recognitionFront + '<hr id="answer">' + answer,
    }],
  };
}

/** Safe preview fragments from exactly the controlled template content (no script or network audio).
 * The host renders these only in its extension-owned preview. Never insert untrusted Anki HTML.
 */
export function renderPreview(draft: NoteDraft, options: { audioFilename?: string | null } = {}): { front: string; back: string } {
  const fields = buildNoteFields('00000000-0000-4000-8000-000000000000', draft,
    { lexemeKey: '', contentKey: '' }, options.audioFilename);
  const template = modelDefinition(draft.mode).cardTemplates[0]!;
  const interpolate = (source: string, reveal: boolean) => {
    let rendered = source.replace(/\{\{#([A-Za-z]+)\}\}([\s\S]*?)\{\{\/\1\}\}/gu,
      (_all, field: NoteField, content: string) => fields[field] ? content : '');
    rendered = rendered.replace(/\{\{cloze:ClozeSentence\}\}/gu, () => {
      const { sentence, targetStart, targetEnd } = draft.context;
      return escapeAnkiText(sentence.slice(0, targetStart)) + '<span class="cloze">' +
        (reveal ? escapeAnkiText(sentence.slice(targetStart, targetEnd)) : '[…]') +
        '</span>' + escapeAnkiText(sentence.slice(targetEnd));
    });
    return rendered.replace(/\{\{([A-Za-z]+)\}\}/gu, (_all, field: NoteField) => field === 'Audio'
      ? (fields.Audio ? '<span class="audio-label">Аудио будет добавлено</span>' : '') : fields[field] ?? '');
  };
  return { front: interpolate(template.Front, false), back: interpolate(template.Back, true) };
}
