/**
 * Optional AI analysis for one alert: a one-shot LLM call through the
 * harness runtime (`ctx.llm.prepareCall` + the prepared stream), so no agent
 * session is involved. The alert's original text is always kept; the AI
 * output is appended below it.
 * @module @deepseek-ai/dsh-pve-host/src/ai
 */

import type { Context } from '@deepseek-ai/cordis'

/** What one analysis needs. */
export interface AnalyzeInput {
  /** The alert text as it would be sent without AI. */
  readonly alertText: string
  /** The user-authored analysis prompt. */
  readonly prompt: string
  /** Provider+model to use; null = deployment default selection. */
  readonly model: { provider: string; model: string } | null
}

/**
 * Run the analysis and return the AI text (may be multi-line).
 * @param ctx plugin context with an optional `llm` service
 * @param input the analysis request
 * @returns the analysis text, or a short error note when LLM is unavailable
 */
export async function analyzeAlert(ctx: Context, input: AnalyzeInput): Promise<string> {
  const llm = ctx.reflect.get('llm', false) as
    | {
      prepareCall(config: unknown): Promise<{
        stream(options: unknown): AsyncIterable<{ type: string; text?: string }>
      }>
    }
    | undefined
  if (llm === undefined) {
    return '(AI 分析不可用：运行时未挂载 LLM 服务)'
  }
  const defaults = ctx.reflect.get('agentDefaultModel', false) as
    | { currentSelection(): { provider: string; model: string } }
    | undefined
  const selection = input.model ?? defaults?.currentSelection() ?? undefined
  if (selection === undefined) {
    return '(AI 分析不可用：未配置默认模型)'
  }
  try {
    const config = {
      provider: selection.provider,
      model: selection.model,
      messages: [
        { role: 'user' as const, content: `${input.prompt}\n\n${input.alertText}` },
      ],
      system: '你是运维告警分析助手。基于用户提示词分析告警，输出简明的中文分析结论。',
    }
    const prepared = await llm.prepareCall(config)
    let text = ''
    for await (const chunk of prepared.stream({ ...config })) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    }
    return text.trim() || '(AI 分析返回空内容)'
  } catch (error) {
    return `(AI 分析失败: ${error instanceof Error ? error.message : String(error)})`
  }
}
