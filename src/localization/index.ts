import { belarusian } from './locales/belarusian.js';
import { english } from './locales/english-locale.js';
import { ru } from './locales/ru.js';

export const supportedLocales = ['ru', 'be', 'en'] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

export interface LocalizedWelcome {
  senderName: string;
  welcome: string;
}

export interface LocalizedTextResponse {
  senderName: string;
  text: string;
}

interface LocaleCopy extends LocalizedWelcome {
  aiTemporaryError: string;
}

const locales: Record<SupportedLocale, LocaleCopy> = {
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

export function getWelcome(language: string | undefined): LocalizedWelcome {
  return locales[resolveLocale(language)];
}

export function getWelcomeText(language: string | undefined): string {
  return getWelcome(language).welcome;
}

export function getAiTemporaryErrorResponse(
  language: string | undefined,
): LocalizedTextResponse {
  const locale = locales[resolveLocale(language)];
  return { senderName: locale.senderName, text: locale.aiTemporaryError };
}
