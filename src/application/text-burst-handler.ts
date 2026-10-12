import { AiGenerationError, type AiRouter } from './ai-router.js';
import type { TextBurstCompleteInput } from './job-worker.js';

export async function handleTextBurstComplete(
  aiRouter: AiRouter | undefined,
  input: TextBurstCompleteInput,
): Promise<string> {
  if (!aiRouter) throw new AiGenerationError('configuration');

  const result = await aiRouter.generate({
    route: 'cheap_text',
    messages: input.messages,
    history: input.history,
    ...(input.language !== undefined ? { language: input.language } : {}),
  });

  return result.text;
}
