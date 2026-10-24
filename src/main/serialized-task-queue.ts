/** Every durable mutation is executed and awaited individually; none is dropped. */
export class SerializedTaskQueue {
  private tail: Promise<void> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
