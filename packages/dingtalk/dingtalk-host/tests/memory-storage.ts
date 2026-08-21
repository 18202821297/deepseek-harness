/**
 * In-memory `storageDomain` for unit-testing a Host service without a real
 * storage backend. Matches the real `DomainFacility.open` / `Domain` /
 * `KvTable` contract (verified against packages/storage/storage-domain/src).
 * ✅ VERIFIED — used to pass the ui-wh-im-channels ChannelStore unit tests.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

/** A minimal in-memory table matching the real KvTable surface. */
class MemoryTable<K extends string, V> implements KvTable<K, V> {
  size = 0
  private readonly rows = new Map<K, V>()

  get(key: K): V | undefined {
    return this.rows.get(key)
  }

  entries(): IterableIterator<[K, V]> {
    return this.rows.entries()
  }

  keys(): IterableIterator<K> {
    return this.rows.keys()
  }

  async put(key: K, value: V): Promise<void> {
    this.rows.set(key, value)
    this.size = this.rows.size
  }

  async delete(key: K): Promise<boolean> {
    const existed = this.rows.delete(key)
    this.size = this.rows.size
    return existed
  }

  async update(key: K, fn: (current: V) => V): Promise<V> {
    const current = this.rows.get(key)
    if (current === undefined) throw new Error(`missing-key: ${String(key)}`)
    const next = fn(current)
    await this.put(key, next)
    return next
  }
}

/** Register an in-memory `storageDomain` on a bare Context so plugin injection resolves. */
export function provideMemoryStorage(ctx: Context): void {
  const tables = new Map<string, MemoryTable<string, unknown>>()

  const storageDomain = {
    async open(spec: { name: string; tables: Record<string, unknown> }): Promise<unknown> {
      const domain = {
        name: spec.name,
        global: {
          get: () => undefined,
          set: async () => {},
        },
        table: (name: string): MemoryTable<string, unknown> => {
          let table = tables.get(name)
          if (table === undefined) {
            table = new MemoryTable<string, unknown>()
            tables.set(name, table)
          }
          return table
        },
        close: async () => {},
      }
      return domain
    },
  }

  ;(ctx as unknown as { storageDomain: unknown }).storageDomain = storageDomain
}
