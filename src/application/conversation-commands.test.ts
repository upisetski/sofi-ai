import { describe, expect, it } from 'vitest';

import { isContextResetCommand } from './conversation-commands.js';

describe('context reset command recognition', () => {
  it.each(['/reset', '/forget', ' /RESET ', '\t/Forget\n'])(
    'recognizes %s',
    (command) => {
      expect(isContextResetCommand(command)).toBe(true);
    },
  );

  it.each(['reset', '/reset please', '/forgot', 'hello'])(
    'does not treat %s as a reset command',
    (text) => {
      expect(isContextResetCommand(text)).toBe(false);
    },
  );
});
