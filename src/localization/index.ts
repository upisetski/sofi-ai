import { belarusian } from './locales/belarusian.js';
import { english } from './locales/english-locale.js';
import { ru } from './locales/ru.js';

export const supportedLocales = ['ru', 'be', 'en'] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

export interface LocalizedWelcome {
  senderName: string;
  welcome: string;
}

export interface LocalizedThinking {
  senderName: string;
  thinking: string;
}

interface LocaleCopy extends LocalizedWelcome {
  thinkingIntro: string;
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

export function getThinking(
  language: string | undefined,
  message: string,
): LocalizedThinking {
  const locale = locales[resolveLocale(language)];
  const excerpt = Array.from(message).slice(0, 1000).join('');

  return {
    senderName: locale.senderName,
    thinking: `${locale.thinkingIntro}\n\n${excerpt}`,
  };
}

export function getThinkingText(
  language: string | undefined,
  message: string,
): string {
  return getThinking(language, message).thinking;
}
