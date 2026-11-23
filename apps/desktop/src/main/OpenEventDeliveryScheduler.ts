/**
 * Serializes background journal drains. A request arriving while a drain is
 * in flight is remembered and gets one follow-up pass after that drain
 * finishes, so an accepted event cannot race the tail of a reconnect drain.
 */
export class OpenEventDeliveryScheduler {
  private requested = false
  private running = false

  constructor(private readonly deliver: () => Promise<void>) {}

  schedule(): void {
    this.requested = true
    if (this.running) return
    this.running = true
    void this.run()
  }

  private async run(): Promise<void> {
    try {
      while (this.requested) {
        this.requested = false
        try {
          await this.deliver()
        } catch {
          // The journal remains pending on delivery failure. Reconnect or a
          // later accepted event supplies the next deliberate delivery pass.
        }
      }
    } finally {
      this.running = false
      if (this.requested) this.schedule()
    }
  }
}
