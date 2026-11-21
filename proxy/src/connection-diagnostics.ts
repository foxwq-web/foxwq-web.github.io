// Lifecycle metadata only: never log WebSocket protocols, URLs, or game bytes.
export class ConnectionDiagnostics {
  private startedAt = Date.now();
  private sentBytes = 0;
  private receivedBytes = 0;
  private lastSentAt: number | null = null;
  private lastReceivedAt: number | null = null;
  constructor(private identity: { connectionId: string; target: string; rayId: string | null; colo: string | null },
    private emit: (record: Record<string, unknown>) => void = record => console.log(record)) {}
  sent(bytes: number) { this.sentBytes += bytes; this.lastSentAt = Date.now(); }
  received(bytes: number) { this.receivedBytes += bytes; this.lastReceivedAt = Date.now(); }
  event(event: string, details: Record<string, unknown> = {}) {
    const time = Date.now();
    this.emit({ ...this.identity, event, timestamp: new Date(time).toISOString(),
      elapsedMs: time - this.startedAt, sentBytes: this.sentBytes, receivedBytes: this.receivedBytes,
      lastSentAgoMs: this.lastSentAt === null ? null : time - this.lastSentAt,
      lastReceivedAgoMs: this.lastReceivedAt === null ? null : time - this.lastReceivedAt, ...details });
  }
}

export function errorDetails(error: unknown) {
  return error instanceof Error ? { errorName: error.name, errorMessage: error.message.slice(0, 500) }
    : { errorName: "UnknownError" };
}
