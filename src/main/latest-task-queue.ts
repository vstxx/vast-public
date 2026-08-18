export class LatestTaskQueue<T> {
  private pending: T | undefined
  private draining: Promise<void> | undefined
  private readonly worker: (value: T) => Promise<void>

  constructor(worker: (value: T) => Promise<void>) {
    this.worker = worker
  }

  run(value: T): Promise<void> {
    this.pending = value
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = undefined
      })
    }
    return this.draining
  }

  private async drain(): Promise<void> {
    let firstError: unknown
    while (this.pending !== undefined) {
      const next = this.pending
      this.pending = undefined
      try {
        await this.worker(next)
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) throw firstError
  }
}
