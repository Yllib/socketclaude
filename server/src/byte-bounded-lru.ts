export class ByteBoundedLru<K, V> {
  private readonly values = new Map<K, { value: V; bytes: number }>();
  private retainedBytes = 0;

  constructor(
    readonly maxBytes: number,
    private readonly sizeOf: (value: V) => number,
  ) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0) {
      throw new Error("ByteBoundedLru maxBytes must be a non-negative number");
    }
  }

  get(key: K): V | undefined {
    const existing = this.values.get(key);
    if (!existing) return undefined;
    this.values.delete(key);
    this.values.set(key, existing);
    return existing.value;
  }

  set(key: K, value: V): this {
    this.delete(key);
    const bytes = Math.max(0, Math.ceil(this.sizeOf(value)));
    if (bytes > this.maxBytes) return this;
    this.values.set(key, { value, bytes });
    this.retainedBytes += bytes;
    this.evictToBudget();
    return this;
  }

  refresh(key: K): void {
    const existing = this.values.get(key);
    if (!existing) return;
    this.set(key, existing.value);
  }

  delete(key: K): boolean {
    const existing = this.values.get(key);
    if (!existing) return false;
    this.values.delete(key);
    this.retainedBytes -= existing.bytes;
    return true;
  }

  clear(): void {
    this.values.clear();
    this.retainedBytes = 0;
  }

  get size(): number {
    return this.values.size;
  }

  get bytes(): number {
    return this.retainedBytes;
  }

  private evictToBudget(): void {
    while (this.retainedBytes > this.maxBytes) {
      const oldest = this.values.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }
}
