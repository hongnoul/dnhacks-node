// log.ts — the replicated record store.
//
// A grow-only set (ARCHITECTURE.md §7.1): records are immutable, append-only and
// order-independent, so merge is set union — idempotent, commutative,
// associative. There is no conflict to resolve and therefore no consensus to
// reach. Two nodes that disagree have not finished gossiping.
//
// Deliberately free of browser APIs so it can be unit-tested under plain Node.

import {
  keyOf,
  streamOf,
  type MeshRecord,
  type RecordKey,
  type StreamId,
  type VersionVector,
} from "./protocol.ts";

export class Log {
  private records = new Map<RecordKey, MeshRecord>();

  /** stream → highest *contiguous* seq. Gaps hold it back until they fill. */
  private high = new Map<StreamId, number>();

  /** Seqs held above the contiguous mark, waiting for the gap to close. */
  private ahead = new Map<StreamId, Set<number>>();

  get size(): number {
    return this.records.size;
  }

  has(r: MeshRecord): boolean {
    return this.records.has(keyOf(r));
  }

  /** Returns false if already held — this is the dedupe that makes flooding safe. */
  add(r: MeshRecord): boolean {
    const key = keyOf(r);
    if (this.records.has(key)) return false;
    this.records.set(key, r);

    const stream = streamOf(r);
    const ahead = this.ahead.get(stream) ?? new Set<number>();
    ahead.add(r.seq);
    this.ahead.set(stream, ahead);

    // Advance the contiguous mark as far as the gaps allow.
    let mark = this.high.get(stream) ?? 0;
    while (ahead.has(mark + 1)) {
      mark++;
      ahead.delete(mark);
    }
    this.high.set(stream, mark);
    return true;
  }

  vv(): VersionVector {
    return Object.fromEntries(this.high);
  }

  /**
   * Records the holder of `theirVV` is missing.
   *
   * Over-selects slightly: a peer holding out-of-order records above its
   * contiguous mark will be re-sent some it already has, and will drop them by
   * key. Harmless at ~80 B a record, and it keeps the version vector to one
   * integer per stream instead of an interval set (§7.5).
   */
  since(theirVV: VersionVector): MeshRecord[] {
    const out: MeshRecord[] = [];
    for (const r of this.records.values()) {
      if (r.seq > (theirVV[streamOf(r)] ?? 0)) out.push(r);
    }
    return out;
  }

  all(): MeshRecord[] {
    return [...this.records.values()];
  }

  /**
   * Sorted by key, which is what makes fusion deterministic across replicas:
   * same records in, same estimate out, regardless of arrival order (§10).
   */
  sorted(): MeshRecord[] {
    return this.all().sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));
  }

  ofType<T extends MeshRecord>(type: T["type"]): T[] {
    return this.sorted().filter((r) => r.type === type) as T[];
  }
}
