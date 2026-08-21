/**
 * PVE collector, Client half.
 *
 * Deliberately empty Host body: the Host-side PveService lives in the
 * separate `@deepseek-ai/dsh-pve-host` package (this package's
 * `dsh.client.inject` depends on api-remotes, which mounts that Remote). The
 * browser half renders the server settings UI over `ctx.remote.pve`.
 */
export function apply(): void {}
