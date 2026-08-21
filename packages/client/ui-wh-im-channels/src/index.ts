/**
 * DingTalk webhook robot, Client half.
 *
 * Deliberately empty Host body: the Host-side DingtalkService lives in the
 * separate `@deepseek-ai/dsh-dingtalk-host` package (this package's
 * `dsh.client.inject` depends on api-remotes, which mounts that Remote). The
 * browser half renders the channel settings UI over `ctx.remote.dingtalk`.
 */
export function apply(): void {}
