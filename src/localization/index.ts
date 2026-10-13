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

export type AiLimitReason =
  | 'request_rate_limit'
  | 'user_daily_budget'
  | 'global_daily_budget'
  | 'global_monthly_budget'
  | 'pricing_unavailable';

interface LocaleCopy extends LocalizedWelcome {
  aiTemporaryError: string;
  aiUserLimitReached: string;
  aiGlobalDailyLimitReached: string;
  aiGlobalMonthlyLimitReached: string;
  contextResetConfirmation: string;
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

export function getAiLimitReachedResponse(
  language: string | undefined,
  reason: AiLimitReason,
): LocalizedTextResponse {
  const locale = locales[resolveLocale(language)];
  const text =
    reason === 'global_daily_budget'
      ? locale.aiGlobalDailyLimitReached
      : reason === 'global_monthly_budget'
        ? locale.aiGlobalMonthlyLimitReached
        : reason === 'pricing_unavailable'
          ? locale.aiTemporaryError
          : locale.aiUserLimitReached;
  return { senderName: locale.senderName, text };
}

export function getContextResetConfirmation(
  language: string | undefined,
): LocalizedTextResponse {
  const locale = locales[resolveLocale(language)];
  return {
    senderName: locale.senderName,
    text: locale.contextResetConfirmation,
  };
}
