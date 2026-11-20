import type { EnglishUsage } from '@english-reader/contracts';

const registerLabel: Record<NonNullable<EnglishUsage['register']>, string> = {
  current: 'Употребляется сейчас',
  formal: 'Современное, преимущественно формальное',
  literary: 'Современное, преимущественно книжное',
  dated: 'Устаревающее, ещё встречается',
  archaic: 'Преимущественно историческое',
  regional: 'Современное, региональное',
  specialized: 'Современное, специальное',
};
const frequencyLabel: Record<NonNullable<EnglishUsage['frequency']>, string> = {
  very_common: 'Очень часто', common: 'Часто', occasional: 'Иногда', rare: 'Редко',
};

export function EnglishUsageSummary({usage}: {usage?: EnglishUsage}) {
  return <details className="reading-english-usage" aria-label="Оценка употребления">
    <summary>Употребление слова</summary>
    <dl>
      <div><dt>Употребление</dt><dd>{usage?.register ? registerLabel[usage.register] : 'Нет оценки'}</dd></div>
      <div><dt>Частота в разговорной речи</dt><dd>{usage?.frequency ? frequencyLabel[usage.frequency] : 'Нет оценки'}</dd></div>
    </dl>
  </details>;
}
