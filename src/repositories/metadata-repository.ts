import type { Knex } from 'knex'
import { MetadataInput, StoredMetadata } from '../models/metadata.js'
import { ThrowDecoder } from '../ancillary/throw-decoder.js'
import type { StreamID } from '@ceramicnetwork/streamid'
import * as te from '../ancillary/io-ts-extra.js'

/**
 * Public interface for MetadataRepository.
 */
export interface IMetadataRepository {
  /**
   * Store metadata entry to the database.
   */
  save(entry: MetadataInput): Promise<void>
  /**
   * Try to find an entry for `streamId`. Return `undefined` if not found.
   */
  retrieve(streamId: StreamID): Promise<StoredMetadata | undefined>
  /**
   * Return true if there is a row for `streamId`.
   */
  isPresent(streamId: StreamID): Promise<boolean>
  /**
   * Mark an entry as used `now`. Return true if touched, i.e. if the entry was in the database.
   */
  touch(streamId: StreamID, now?: Date): Promise<boolean>
}

/**
 * Parse result of Knex `count` query.
 */
function parseCountResult(count: string | number): number {
  return parseInt(String(count), 10) // `count` could be string or number, let's be pessimistic
}

/**
 * Manage `metadata` database entries.
 */
export class MetadataRepository implements IMetadataRepository {
  static inject = ['dbConnection'] as const

  constructor(private readonly connection: Knex) {}

  /**
   * `... FROM metadata` SQL clause.
   */
  table() {
    return this.connection('metadata')
  }

  /**
   * Store metadata entry to the database.
   */
  async save(entry: MetadataInput): Promise<void> {
    await this.table().insert(MetadataInput.encode(entry)).onConflict().ignore()
  }

  /**
   * Return true if there is a row for `streamId`.
   */
  async isPresent(streamId: StreamID): Promise<boolean> {
    const result = await this.table()
      .select<{ count: number | string }>(this.connection.raw(`COUNT(*)`))
      .where({ streamId: te.streamIdAsString.encode(streamId) })
      .limit(1)
    return parseCountResult(result[0].count) > 0
  }

  /**
   * Try to find an entry for `streamId`. Return `undefined` if not found.
   */
  async retrieve(streamId: StreamID): Promise<StoredMetadata | undefined> {
    const rows = await this.table()
      .where({ streamId: te.streamIdAsString.encode(streamId) })
      .limit(1)
    if (rows[0]) {
      return ThrowDecoder.decode(StoredMetadata, rows[0])
    } else {
      return undefined
    }
  }

  /**
   * Count all metadata entries in the database.
   */
  async countAll(): Promise<number> {
    const result = await this.table().count('streamId')
    return parseCountResult(result[0].count)
  }

  /**
   * Mark an entry as used `now`. Return true if touched, i.e. if the entry was in the database.
   */
  async touch(streamId: StreamID, now: Date = new Date()): Promise<boolean> {
    const rowsTouched = await this.table()
      .where({ streamId: te.streamIdAsString.encode(streamId) })
      .update({ usedAt: te.date.encode(now) })
    return rowsTouched > 0
  }
}