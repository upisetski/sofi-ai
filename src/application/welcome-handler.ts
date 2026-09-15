import { getWelcomeText } from '../localization/index.js';

export function buildWelcomeText(language: string | undefined): string {
  return getWelcomeText(language);
}
