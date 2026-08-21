/**
 * The channel domain declaration for the DingTalk plugin. One `channels`
 * table keyed by channel id; records persist to the storage JSON backend
 * automatically — every put/delete is durably committed before memory
 * updates, so "load on start, persist on every change" is framework-owned.
 * @module @deepseek-ai/dsh-dingtalk-host/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Durable shape of one DingTalk channel, discriminated by `type`. */
export const channelRecord = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.literal('webhook'),
    webhookUrl: z.string().url(),
    secret: z.string().default(''),
    enabled: z.boolean().default(true),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.literal('app'),
    clientId: z.string().min(1),
    clientSecret: z.string().default(''),
    agentPreset: z.string().default('standard'),
    enabled: z.boolean().default(true),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
])

/** One stored channel record. */
export type ChannelRecord = z.infer<typeof channelRecord>

/** The channel domain spec: a `channels` table keyed by channel id. */
export const channelDomainSpec = defineDomain({
  name: 'channels',
  version: 1,
  tables: { channels: domainTable<ChannelRecord['id'], ChannelRecord>(channelRecord) },
})
