/**
 * Internationalisation.
 *
 * Bengali and Hindi are first-class here, not an afterthought: this app's users are
 * village health workers, and English-only UI text would make it unusable for most of
 * them. Every string the user can see comes from `locales/<lang>.json`.
 *
 * Design decisions worth knowing:
 *
 * - **Translation keys are type-checked.** `TranslationKey` is derived from the English
 *   file, so a typo in `t('form.patinetName')` is a build error rather than a label that
 *   silently renders as raw key text in front of a judge.
 *
 * - **English is the fallback, and missing keys are reported.** In development the
 *   provider audits every locale against English on load and logs anything absent, so a
 *   half-translated screen gets noticed during development rather than during a demo.
 *
 * - **Numbers stay in Latin digits.** Bengali and Hindi both have their own digit forms,
 *   but a health worker is copying a reading off a glucometer that displays "165". Showing
 *   "১৬৫" next to a device reading "165" invites transcription errors, so measured values
 *   are left in the digits the hardware uses. Prose in the locale files uses native
 *   digits where it reads more naturally.
 *
 * - **`lang` on <html> is updated.** Screen readers pick the wrong voice otherwise, which
 *   makes Bengali and Hindi text unintelligible when read aloud.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import bn from './locales/bn.json';
import en from './locales/en.json';
import hi from './locales/hi.json';

export const LANGUAGES = ['bn', 'hi', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Bengali first: it is the primary language of the target deployment district. */
export const LANGUAGE_ORDER: Language[] = ['bn', 'hi', 'en'];

type TranslationTree = typeof en;

const RESOURCES: Record<Language, TranslationTree> = {
  bn: bn as unknown as TranslationTree,
  hi: hi as unknown as TranslationTree,
  en,
};

/** Dot-separated leaf paths of the English translation tree. */
type DotNestedKeys<T> = T extends object
  ? {
      [K in Exclude<keyof T, symbol>]: T[K] extends string ? `${K}` : `${K}.${DotNestedKeys<T[K]>}`;
    }[Exclude<keyof T, symbol>]
  : never;

export type TranslationKey = DotNestedKeys<TranslationTree>;

export type TranslateParams = Record<string, string | number>;

const STORAGE_KEY = 'swasthbharat.language';

function readStoredLanguage(): Language | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return LANGUAGES.includes(stored as Language) ? (stored as Language) : null;
  } catch {
    // Private browsing or blocked storage. Not fatal.
    return null;
  }
}

/** Falls back to Bengali rather than English: this is a Bengali-majority deployment. */
function detectLanguage(): Language {
  const stored = readStoredLanguage();
  if (stored) return stored;

  const candidates = [navigator.language, ...(navigator.languages ?? [])];
  for (const candidate of candidates) {
    const base = candidate?.toLowerCase().split('-')[0];
    if (base === 'bn') return 'bn';
    if (base === 'hi') return 'hi';
    if (base === 'en') return 'en';
  }
  return 'bn';
}

function lookup(tree: unknown, path: string): string | undefined {
  const segments = path.split('.');
  let current: unknown = tree;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'string' ? current : undefined;
}

/** Replaces `{name}` placeholders. Unknown placeholders are left visible on purpose. */
function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, token: string) =>
    token in params ? String(params[token]) : match,
  );
}

/**
 * Walks the English tree collecting every leaf path, then reports which are missing from
 * the other locales. Development only.
 */
function auditTranslations(): void {
  const collect = (tree: unknown, prefix = ''): string[] => {
    if (typeof tree !== 'object' || tree === null) return [];
    return Object.entries(tree as Record<string, unknown>).flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof value === 'string' ? [path] : collect(value, path);
    });
  };

  const englishKeys = collect(en);

  for (const language of LANGUAGES) {
    if (language === 'en') continue;
    const missing = englishKeys.filter((key) => lookup(RESOURCES[language], key) === undefined);
    if (missing.length > 0) {
      console.warn(
        `[i18n] ${language}.json is missing ${missing.length} key(s); English will be used for these:`,
        missing,
      );
    }

    const extra = collect(RESOURCES[language]).filter((key) => lookup(en, key) === undefined);
    if (extra.length > 0) {
      console.warn(`[i18n] ${language}.json has ${extra.length} key(s) not in en.json:`, extra);
    }
  }
}

export interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  /** Translate a key, interpolating `{placeholders}`. */
  t: (key: TranslationKey, params?: TranslateParams) => string;
  /**
   * Translate a key that is only known at runtime, such as the `i18nKey` returned by the
   * shared risk engine. Falls back to the supplied text, then to the key itself.
   */
  tDynamic: (key: string, params?: TranslateParams, fallback?: string) => string;
  /** BCP-47 locale for the Web Speech API, e.g. `bn-IN`. */
  speechLocale: string;
  /** Native names for the language switcher, in display order. */
  languageOptions: { value: Language; label: string }[];
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => detectLanguage());

  useEffect(() => {
    if (import.meta.env.DEV) auditTranslations();
  }, []);

  useEffect(() => {
    document.documentElement.lang = lookup(RESOURCES[language], 'meta.htmlLang') ?? language;
  }, [language]);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore: the choice just will not persist across reloads.
    }
  }, []);

  const t = useCallback(
    (key: TranslationKey, params?: TranslateParams) => {
      const translated = lookup(RESOURCES[language], key) ?? lookup(en, key);
      if (translated === undefined) {
        if (import.meta.env.DEV) console.warn(`[i18n] missing key: ${key}`);
        return key;
      }
      return interpolate(translated, params);
    },
    [language],
  );

  const tDynamic = useCallback(
    (key: string, params?: TranslateParams, fallback?: string) => {
      const translated = lookup(RESOURCES[language], key) ?? lookup(en, key);
      if (translated === undefined) {
        if (import.meta.env.DEV) console.warn(`[i18n] missing dynamic key: ${key}`);
        return fallback ?? key;
      }
      return interpolate(translated, params);
    },
    [language],
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      setLanguage,
      t,
      tDynamic,
      speechLocale: lookup(RESOURCES[language], 'meta.speechLocale') ?? 'en-IN',
      languageOptions: LANGUAGE_ORDER.map((option) => ({
        value: option,
        label: lookup(RESOURCES[option], 'meta.languageNameNative') ?? option,
      })),
    }),
    [language, setLanguage, t, tDynamic],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside <I18nProvider>');
  return context;
}

/** Convenience hook when only the translate function is needed. */
export function useT() {
  return useI18n().t;
}
