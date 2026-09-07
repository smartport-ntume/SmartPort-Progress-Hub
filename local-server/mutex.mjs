export class AsyncMutex {
  #tail = Promise.resolve();

  async run(task) {
    let release;
    const previous = this.#tail;
    this.#tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}
