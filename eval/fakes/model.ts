import type { MastraModelConfig } from '@mastra/core/llm';
import type { ModelPlan, ModelResponse } from './schemas/fixture.ts';

/**
 * Scripted MastraLanguageModel for contract runs (raw V3 shape; Mastra wraps it).
 *
 * - Responses come from the fixture model plan, consumed in order.
 * - Purpose detection: explicit `match` substring first, then prompt heuristics
 *   (onboarding / analysis / memory prompts), then chat.
 * - Every call is recorded in the ledger; any call that cannot be served by the
 *   plan throws (fixture under-specification → incomplete run, never a guess).
 * - `throws` mode rejects; `malformed` mode emits text that fails JSON parsing;
 *   `toolCalls` emits tool-call content so the agent loop executes the tool.
 * - Usage metadata is reported when the fixture supplies it, otherwise null
 *   (never zero) — the ticket's unmetered contract.
 */

export type ScriptedModelCall = {
  purpose: string;
  provider: string;
  model: string;
  promptText: string;
  outputText: string;
  promptChars: number;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  responseId: string | null;
  toolResultSeen: boolean;
  /** response emitted tool-call parts (the agent loop may cut off before the result is observed) */
  issuedToolCalls: boolean;
};

export type ScriptedModelLedger = { calls: ScriptedModelCall[] };

function promptHasToolResult(prompt: unknown): boolean {
  if (!Array.isArray(prompt)) return false;
  return prompt.some((message) => {
    if (typeof message === 'string') return false;
    const role = (message as { role?: unknown }).role;
    if (role === 'tool') return true;
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content)) return content.some((part) => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'tool-result');
    return false;
  });
}

export function detectPurpose(prompt: string): ModelResponse['purpose'] {
  if (/career onboarding profile|structured draft JSON|Missing required fields JSON/i.test(prompt)) return 'onboarding';
  if (/^Job text:/m.test(prompt) || /Owner profile:/m.test(prompt)) return 'analysis';
  if (/update working memory|observations you made|observational memory|memory extraction/i.test(prompt)) return 'memory';
  return 'chat';
}

function messageText(message: unknown): string {
  if (typeof message === 'string') return message;
  const content = (message as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'object' && part !== null && 'text' in part ? String((part as { text: unknown }).text) : '')).join('\n');
  }
  return typeof content === 'string' ? content : '';
}

function promptText(options: Record<string, unknown>): string {
  const prompt = options.prompt;
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) return prompt.map(messageText).join('\n');
  return '';
}

/** Purpose is read from the system instruction and the current request (first
 * and last message) only — mid-prompt history can carry earlier
 * "Job text:"/"Owner profile:" content via memory context and would misread a
 * plain chat turn as an analysis call. */
function purposeFromMessages(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;
  if (!Array.isArray(prompt) || prompt.length === 0) return '';
  return `${messageText(prompt.at(0))}\n${messageText(prompt.at(-1))}`;
}

/** Structural raw-V3 model; cast to MastraModelConfig by the runner. */
export type ScriptedModel = {
  specificationVersion: 'v3';
  provider: string;
  modelId: string;
  doGenerate(options: Record<string, unknown>): Promise<Record<string, unknown>>;
};

export function createScriptedModel(plan: ModelPlan, clock: () => number, ledger: ScriptedModelLedger, provider = 'scripted', modelId = 'career-copilot-contract-model'): ScriptedModel {
  const queue = [...plan.responses];
  let served = 0;

  const serve = (prompt: string, purpose: ModelResponse['purpose']): ModelResponse => {
    // memory extraction may only consume explicitly scripted memory responses —
    // it must never steal a generic chat response (Mastra's memory-call ordering
    // would otherwise decide which fixtures pass)
    const index = queue.findIndex(
      (response) => (response.purpose === purpose || (purpose !== 'memory' && response.purpose === 'chat')) && (!response.match || prompt.toLowerCase().includes(response.match.toLowerCase())),
    );
    if (index < 0) {
      // memory extraction noise is unlimited by default: fixtures that care can
      // still script explicit memory responses, which are consumed first.
      if (purpose === 'memory') return { purpose: 'memory', text: '{}' };
      throw new Error(`scripted model queue exhausted (purpose=${purpose}, ${served}/${plan.responses.length} served)`);
    }
    const [response] = queue.splice(index, 1);
    served++;
    return response;
  };

  const generate = async (options: Record<string, unknown>) => {
    const started = clock();
    const prompt = promptText(options);
    const purpose = detectPurpose(purposeFromMessages(options.prompt));
    const response = serve(prompt, purpose);
    if (response.throws) throw new Error(response.throws);
    const id = `scripted-${served}`;
    let content: Array<Record<string, unknown>>;
    let finishReason: { unified: string; raw: string };
    if (response.malformed) {
      content = [{ type: 'text', text: 'this is not valid json {' }];
      finishReason = { unified: 'stop', raw: 'stop' };
    } else if (response.toolCalls?.length) {
      content = response.toolCalls.map((call, index) => ({ type: 'tool-call', toolCallId: `call-${served}-${index}`, toolName: call.toolName, input: JSON.stringify(call.args) }));
      finishReason = { unified: 'tool-calls', raw: 'tool-calls' };
    } else {
      const text = response.object !== undefined ? JSON.stringify(response.object) : (response.text ?? '');
      content = [{ type: 'text', text }];
      finishReason = { unified: 'stop', raw: 'stop' };
    }
    ledger.calls.push({
      purpose,
      provider,
      model: modelId,
      promptText: prompt,
      outputText: JSON.stringify(content),
      promptChars: prompt.length,
      inputTokens: response.usage?.inputTokens ?? null,
      outputTokens: response.usage?.outputTokens ?? null,
      latencyMs: Math.max(0, clock() - started),
      responseId: id,
      toolResultSeen: promptHasToolResult(options.prompt),
      issuedToolCalls: (response.toolCalls?.length ?? 0) > 0,
    });
    return {
      content,
      finishReason,
      usage: {
        inputTokens: { total: response.usage?.inputTokens ?? undefined },
        outputTokens: { total: response.usage?.outputTokens ?? undefined },
      },
      warnings: [],
      response: { id, modelId },
    };
  };

  return {
    specificationVersion: 'v3',
    provider,
    modelId,
    async doGenerate(options: Record<string, unknown>) {
      return generate(options);
    },
  };
}

export function asModelConfig(model: ScriptedModel): MastraModelConfig {
  return model as unknown as MastraModelConfig;
}
