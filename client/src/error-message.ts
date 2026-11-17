// Keep error details visible for debugging even when the UI hides them.
export function logError(message: string): void {
  console.log(message);
}

// Error details stay unprefixed in application state and exceptions.
export function formatError(message: string): string {
  const text = message.trim();
  return text ? `Error: ${text}` : '';
}
