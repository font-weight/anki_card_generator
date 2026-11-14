import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readerActionPage, sameReaderActionPage, type ReaderActionPage } from '../runtime/action-state';

type Destination = 'library' | 'settings' | 'queue';
type PendingAction = 'activate' | Destination | null;
type Context = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'page'; page: ReaderActionPage };
type Feedback = { kind: 'error' | 'info'; message: string } | null;
type IconName = 'book' | 'arrow' | 'settings' | 'queue' | 'check' | 'page' | 'lock' | 'retry';

function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  const paths: Record<IconName, React.ReactNode> = {
    book: <><path d="M12 5.5C9 3.5 5.5 3.5 3 4.5v15c2.5-1 6-1 9 1 3-2 6.5-2 9-1v-15c-2.5-1-6-1-9 1Z" /><path d="M12 5.5v15" /></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
    queue: <><rect x="5" y="3" width="14" height="14" rx="3" /><path d="M3 9v10a2 2 0 0 0 2 2h10M9 8h6M9 12h4" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    page: <><rect x="4" y="3" width="16" height="18" rx="3" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
    retry: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9" /></>,
  };
  return <svg className={`action-icon ${className}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

/** Opening the menu only reads tab metadata. Activation and navigation always
 * require an explicit click; no content probe, service RPC or provider request. */
export function ActionMenu() {
  const libraryUrl = useMemo(() => chrome.runtime.getURL('library.html'), []);
  const [context, setContext] = useState<Context>({ kind: 'loading' });
  const [pending, setPending] = useState<PendingAction>(null);
  const [enabled, setEnabled] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const mounted = useRef(false), generation = useRef(0), locked = useRef(false);
  const currentPage = useRef<ReaderActionPage | null>(null);

  const readCurrentPage = useCallback(async () => {
    const request = ++generation.current;
    currentPage.current = null;
    setContext({ kind: 'loading' });
    setEnabled(false);
    setFeedback(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!mounted.current || request !== generation.current) return;
      const page = readerActionPage(tab, libraryUrl);
      currentPage.current = page;
      setContext({ kind: 'page', page });
    } catch (error) {
      if (mounted.current && request === generation.current) setContext({ kind: 'error', message: errorMessage(error, 'Не удалось получить текущую вкладку. Попробуйте ещё раз.') });
    }
  }, [libraryUrl]);

  useEffect(() => {
    mounted.current = true;
    const onActivated = () => { void readCurrentPage(); };
    const onUpdated = (tabId: number, change: chrome.tabs.OnUpdatedInfo) => {
      if ((!currentPage.current || currentPage.current.id === tabId) && (change.url !== undefined || change.status === 'loading')) void readCurrentPage();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    void readCurrentPage();
    return () => {
      mounted.current = false;
      ++generation.current;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [readCurrentPage]);

  const acceptChangedPage = (page: ReaderActionPage) => {
    ++generation.current;
    currentPage.current = page;
    setContext({ kind: 'page', page });
    setEnabled(false);
    setFeedback({ kind: 'info', message: 'Вкладка изменилась. Выберите действие для новой страницы.' });
  };

  const activate = async () => {
    if (locked.current || context.kind !== 'page' || context.page.target !== 'web') return;
    locked.current = true;
    setPending('activate');
    setFeedback(null);
    const page = context.page, request = generation.current;
    const isCurrent = () => mounted.current && request === generation.current;
    try {
      // Revalidate the visible target before granting access to a page.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!isCurrent()) return;
      const latest = readerActionPage(tab, libraryUrl);
      if (!sameReaderActionPage(page, latest)) { acceptChangedPage(latest); return; }
      const result = await chrome.runtime.sendMessage({ hostType: 'reader.activate', tabId: page.id });
      if (!isCurrent()) return;
      // A completed request for an older document must not look like success on
      // a newly navigated tab, even when the tab event was delayed or absent.
      const [after] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!isCurrent()) return;
      const afterPage = readerActionPage(after, libraryUrl);
      if (!sameReaderActionPage(page, afterPage)) { acceptChangedPage(afterPage); return; }
      if (!result?.ok) throw new Error(typeof result?.error === 'string' ? result.error : 'Не удалось включить чтение на этой странице.');
      setEnabled(true);
    } catch (error) {
      if (isCurrent()) setFeedback({ kind: 'error', message: errorMessage(error, 'Не удалось включить чтение. Попробуйте ещё раз или откройте библиотеку.') });
    } finally {
      locked.current = false;
      if (mounted.current) setPending(null);
    }
  };

  const openPage = async (destination: Destination) => {
    if (locked.current) return;
    locked.current = true;
    setPending(destination);
    setFeedback(null);
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL(`${destination}.html`) });
      if (mounted.current) window.close();
    } catch (error) {
      if (mounted.current) setFeedback({ kind: 'error', message: errorMessage(error, 'Не удалось открыть раздел. Попробуйте ещё раз.') });
    } finally {
      locked.current = false;
      if (mounted.current) setPending(null);
    }
  };

  const page = context.kind === 'page' ? context.page : null;
  const isLibrary = page?.target === 'library', restricted = page?.target === 'restricted';
  const loading = context.kind === 'loading', readError = context.kind === 'error';
  const title = loading ? 'Проверяем вкладку' : readError ? 'Не удалось проверить вкладку' : isLibrary ? 'Библиотека уже открыта' : restricted ? 'Здесь чтение недоступно' : enabled ? 'Чтение включено' : 'Читайте прямо на странице';
  const description = loading ? 'Определяем доступное действие для этой страницы.'
    : context.kind === 'error' ? context.message
    : isLibrary ? 'Откройте книгу или продолжайте чтение. Подключать библиотеку не нужно.'
    : restricted ? 'Откройте обычный сайт. Для PDF, EPUB и FB2 используйте библиотеку.'
    : enabled ? 'Вернитесь на страницу, наведите на слово или выделите выражение и нажмите Shift.'
    : 'Подключите чтение, чтобы переводить слова и сохранять их в Anki.';
  const primaryLabel = pending === 'activate' ? 'Подключение…' : pending === 'library' && restricted ? 'Открываем библиотеку…'
    : loading ? 'Проверяем вкладку…' : readError ? 'Повторить проверку' : restricted ? 'Открыть библиотеку' : isLibrary ? 'Вернуться в библиотеку' : enabled ? 'Вернуться к странице' : 'Включить чтение';
  const primaryAction = () => {
    if (locked.current) return;
    if (readError) {
      locked.current = true;
      void readCurrentPage().finally(() => { locked.current = false; });
    }
    else if (restricted) void openPage('library');
    else if (isLibrary || enabled) window.close();
    else void activate();
  };

  return <main className="action-menu" aria-label="Language Reader для Anki">
    <header className="action-header">
      <span className="action-brand-mark"><Icon name="book" /></span>
      <div className="action-brand"><h1>Language Reader</h1><p>для Anki</p></div>
    </header>

    <section className={`action-context${enabled || isLibrary ? ' is-ready' : ''}${restricted || readError ? ' is-unavailable' : ''}`} aria-labelledby="action-context-label">
      <h2 id="action-context-label" className="action-eyebrow">Текущая вкладка</h2>
      <div className="action-page-label"><Icon name={isLibrary ? 'book' : restricted ? 'lock' : 'page'} /><bdi title={page?.label}>{page?.label ?? (loading ? 'Проверяем страницу…' : 'Вкладка недоступна')}</bdi></div>
      <div className="action-readiness" role={readError ? 'alert' : 'status'} aria-live={readError ? 'assertive' : 'polite'} aria-atomic="true">
        <h3>{(enabled || isLibrary) && <Icon name="check" />}{title}</h3>
        <p tabIndex={readError ? 0 : undefined}>{description}</p>
      </div>
      <button type="button" className="action-primary" disabled={loading || pending !== null} aria-busy={loading || pending === 'activate' || (restricted && pending === 'library')} onClick={primaryAction}>
        <span>{primaryLabel}</span><Icon name={readError ? 'retry' : 'arrow'} />
      </button>
    </section>

    {feedback && <p className={`action-feedback is-${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'} tabIndex={0}>{feedback.message}</p>}

    <section className="action-shortcuts" aria-label="Горячие клавиши">
      <div><kbd>Shift</kbd><span>Перевод слова или выделения</span></div>
      <div><kbd>Alt</kbd><span>Грамматика<small>Левый Alt, если включена в настройках</small></span></div>
    </section>

    <nav className="action-navigation" aria-label="Разделы Language Reader">
      {!restricted && !isLibrary && <button type="button" className="action-library" disabled={pending !== null} aria-busy={pending === 'library'} onClick={() => void openPage('library')}>
        <span className="action-nav-icon"><Icon name="book" /></span><span className="action-nav-copy"><strong>{pending === 'library' ? 'Открываем библиотеку…' : 'Библиотека'}</strong><small>Книги и документы · PDF, EPUB, FB2</small></span><Icon name="arrow" className="action-nav-arrow" />
      </button>}
      <div className="action-nav-pair">
        <button type="button" disabled={pending !== null} aria-busy={pending === 'settings'} onClick={() => void openPage('settings')}><Icon name="settings" /><span>{pending === 'settings' ? 'Открываем…' : 'Настройки'}</span></button>
        <button type="button" disabled={pending !== null} aria-busy={pending === 'queue'} onClick={() => void openPage('queue')}><Icon name="queue" /><span>{pending === 'queue' ? 'Открываем…' : 'Очередь Anki'}</span></button>
      </div>
    </nav>
    <p className="action-footnote">Меню не отправляет запросы к ИИ.</p>
  </main>;
}
