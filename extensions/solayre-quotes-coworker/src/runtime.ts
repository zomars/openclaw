export interface Runtime {
  sendMessage(
    to: string,
    content: { text: string; metadata?: Record<string, unknown> },
  ): Promise<void>;
}
