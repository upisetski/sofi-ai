import { belarusian } from './locales/belarusian.js';
import { english } from './locales/english-locale.js';
import { ru } from './locales/ru.js';

export const supportedLocales = ['ru', 'be', 'en'] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

const locales: Record<SupportedLocale, { welcome: string }> = {
  ru,
  be: belarusian,
  en: english,
};

export function resolveLocale(language: string | undefined): SupportedLocale {
  if (language && supportedLocales.includes(language as SupportedLocale)) {
    return language as SupportedLocale;
  }

  return 'ru';
}

export function getWelcomeText(language: string | undefined): string {
  return locales[resolveLocale(language)].welcome;
}
