const resetCommands = new Set(['/reset', '/forget']);

export function isContextResetCommand(text: string): boolean {
  return resetCommands.has(text.trim().toLocaleLowerCase('en-US'));
}
