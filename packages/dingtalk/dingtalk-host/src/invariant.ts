/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-dingtalk-host`.
 * @module @deepseek-ai/dsh-dingtalk-host/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-dingtalk-host'

/** Cordis companion plugin name. */
export const name = 'dingtalk-host-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: Remote method wiring and storage persistence are
 * exercised through the public wire protocol and the domain layer; there is
 * no observable state to assert here.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
