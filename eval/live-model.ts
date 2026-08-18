import { detectPurpose, promptHasToolResult, type ScriptedModelCall, type ScriptedModelLedger } from './fakes/model.ts';
import { callCostUsd } from './pricing.ts';

/**
 * Harness-owned live model client for the quality lane (#13d): an
 * OpenAI-compatible chat-completions client shaped like the scripted fake
 * (raw Mastra v3 `doGenerate`), so the real agent loop runs the same path
 * contract runs prove. Provider/model/API base/key come from env; every call
 * records usage, identity, retries, and cost into the shared ledger.
 *
 * Provider → default API base (OpenAI-compatible), overridable per provider
 * with EVAL_API_BASE_<PROVIDER>:
 *   opencode-go  https://opencode.ai/zen/go/v1        (key: OPENCODE_API_KEY)
 *   opencode     https://opencode.ai/zen/v1           (key: OPENCODE_API_KEY)
 *   google       https://generativelanguage.googleapis.com/v1beta/openai
 *                                                      (key: GOOGLE_GENERATIVE_AI_API_KEY)
 *   groq         https://api.groq.com/openai/v1       (key: GROQ_API_KEY)
 *   openai       https://api.openai.com/v1            (key: OPENAI_API_KEY)
 */

const PROVIDER_BASES: Record<string, { base: string; keyEnv: string }> = {
  'opencode-go': { base: 'https://opencode.ai/zen/go/v1', keyEnv: 'OPENCODE_API_KEY' },
  opencode: { base: 'https://opencode.ai/zen/v1', keyEnv: 'OPENCODE_API_KEY' },
  google: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY' },
  groq: { base: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
  openai: { base: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY' },
};

export type LiveModelConfig = {
  provider: string;
  modelId: string;
  apiBase: string;
  apiKey: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
};

export function resolveProviderDefaults(provider: string): { base: string; keyEnv: string } | null {
  return PROVIDER_BASES[provider] ?? null;
}

/** `provider/modelId` string → config from env (mirrors production model strings). */
export function resolveLiveModelConfig(modelString: string | undefined, roleEnvPrefix: string): LiveModelConfig {
  const raw = modelString?.trim();
  if (!raw) throw new Error(`${roleEnvPrefix}_MODEL is required for live quality runs (e.g. opencode-go/deepseek-v4-flash)`);
  const slash = raw.indexOf('/');
  const provider = slash > 0 ? raw.slice(0, slash) : raw;
  const modelId = slash > 0 ? raw.slice(slash + 1) : raw;
  const defaults = resolveProviderDefaults(provider);
  const apiBase = process.env[`EVAL_API_BASE_${provider.toUpperCase().replace(/-/g, '_')}`] ?? process.env[`${roleEnvPrefix}_API_BASE`] ?? defaults?.base;
  if (!apiBase) throw new Error(`no default API base for provider "${provider}"; set EVAL_API_BASE_${provider.toUpperCase().replace(/-/g, '_')}`);
  const apiKey = process.env[`${roleEnvPrefix}_API_KEY`] ?? (defaults ? process.env[defaults.keyEnv] : undefined);
  if (!apiKey) throw new Error(`no API key for ${roleEnvPrefix} model ${raw}; set ${roleEnvPrefix}_API_KEY or ${defaults?.keyEnv ?? 'the provider key env'}`);
  return { provider, modelId, apiBase, apiKey };
}

type Message = { role: string; content: unknown };
type ToolCallPart = { type: 'tool-call'; toolCallId?: unknown; toolName?: unknown; input?: unknown };
type ToolResultPart = { type: 'tool-result'; toolCallId?: unknown; toolName?: unknown; result?: unknown; isError?: unknown };

function partText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string' ? String((part as { text: string }).text) : ''))
      .join('\n');
  }
  return '';
}

function partToolCalls(content: unknown): ToolCallPart[] {
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is ToolCallPart => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'tool-call');
}

function partToolResults(content: unknown): ToolResultPart[] {
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is ToolResultPart => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'tool-result');
}

function stringifyArguments(input: unknown): string {
  if (typeof input === 'string') return input;
  try { return JSON.stringify(input ?? {}); } catch { return '{}'; }
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try { return JSON.stringify(result); } catch { return String(result); }
}

type OpenAIMessage = Record<string, unknown>;

/** AI SDK prompt → OpenAI chat-completions messages (adjacent same-role merged). */
export function serializeMessages(prompt: unknown): OpenAIMessage[] {
  const messages = (Array.isArray(prompt) ? prompt : typeof prompt === 'string' ? [{ role: 'user', content: prompt }] : []).map((raw: Message): OpenAIMessage[] => {
    const role = raw.role;
    const toolCalls = partToolCalls(raw.content).map((part) => ({ id: String(part.toolCallId ?? `call-${Math.random().toString(36).slice(2, 8)}`), type: 'function', function: { name: String(part.toolName ?? ''), arguments: stringifyArguments(part.input) } }));
    if (role === 'assistant') {
      const text = partText(raw.content);
      const message: OpenAIMessage = { role: 'assistant' };
      if (text) message.content = text;
      if (toolCalls.length > 0) message.tool_calls = toolCalls;
      return [message];
    }
    if (role === 'tool') {
      const results = partToolResults(raw.content);
      if (results.length > 0) {
        return results.map((part) => ({ role: 'tool', tool_call_id: String(part.toolCallId ?? ''), content: stringifyResult(part.result) }));
      }
      return [{ role: 'tool', tool_call_id: String((raw as { toolCallId?: unknown }).toolCallId ?? ''), content: partText(raw.content) }];
    }
    return [{ role, content: partText(raw.content) }];
  }).flat();

  const merged: OpenAIMessage[] = [];
  for (const message of messages) {
    const last = merged.at(-1);
    if (last && last.role === message.role && message.role !== 'tool') {
      // merge adjacent same-role messages (OpenAI rejects them)
      if (typeof message.content === 'string' && message.content) last.content = `${typeof last.content === 'string' ? last.content : ''}${last.content ? '\n' : ''}${message.content}`;
      if (Array.isArray(message.tool_calls)) last.tool_calls = [...(Array.isArray(last.tool_calls) ? last.tool_calls : []), ...message.tool_calls];
      continue;
    }
    merged.push({ ...message });
  }
  return merged;
}

function serializeTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => {
    const definition = tool as { name?: unknown; description?: unknown; parameters?: unknown; inputSchema?: unknown };
    const name = String(definition.name ?? '');
    const parameters = definition.parameters ?? definition.inputSchema ?? { type: 'object' };
    return { type: 'function', function: { name, description: typeof definition.description === 'string' ? definition.description : undefined, parameters } };
  });
}

function serializeToolChoice(toolChoice: unknown): unknown {
  if (typeof toolChoice === 'string') return toolChoice;
  if (toolChoice && typeof toolChoice === 'object') {
    const choice = toolChoice as { type?: unknown; function?: unknown };
    if (choice.type === 'function') return { type: 'function', function: choice.function ?? {} };
    if (choice.type === 'tool') {
      // AI SDK tool-choice {type:'tool', toolName} → OpenAI function form
      const toolName = (choice as { toolName?: unknown }).toolName;
      if (toolName) return { type: 'function', function: { name: String(toolName) } };
    }
    return 'auto';
  }
  return 'auto';
}

export type ChatCompletionRequest = {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: { type: 'json_object' } | { type: 'json_schema'; json_schema: unknown };
  stop?: unknown;
};

export type ChatCompletionResponse = {
  id: string | null;
  model: string | null;
  systemFingerprint: string | null;
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }> | null;
  finishReason: string;
  inputTokens: number | null;
  outputTokens: number | null;
};

export type LiveModelCallOptions = {
  prompt?: unknown;
  tools?: unknown;
  toolChoice?: unknown;
  mode?: { type?: unknown; schema?: unknown; name?: unknown };
  temperature?: unknown;
  maxTokens?: unknown;
  stopSequences?: unknown;
  abortSignal?: AbortSignal | null;
};

export function parseChatCompletion(body: unknown): ChatCompletionResponse {
  const response = body as { id?: unknown; model?: unknown; system_fingerprint?: unknown; usage?: unknown; choices?: unknown };
  const choice = Array.isArray(response.choices) ? (response.choices[0] as { message?: unknown; finish_reason?: unknown }) : undefined;
  const message = choice?.message as { content?: unknown; tool_calls?: unknown } | undefined;
  const usage = response.usage as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
  const toolCalls = Array.isArray(message?.tool_calls)
    ? (message.tool_calls as Array<{ id?: unknown; function?: unknown }>).map((call) => {
        const fn = call.function as { name?: unknown; arguments?: unknown } | undefined;
        return { id: String(call.id ?? ''), name: String(fn?.name ?? ''), arguments: String(fn?.arguments ?? '{}') };
      })
    : null;
  const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'stop';
  return {
    id: typeof response.id === 'string' ? response.id : null,
    model: typeof response.model === 'string' ? response.model : null,
    systemFingerprint: typeof response.system_fingerprint === 'string' ? response.system_fingerprint : null,
    content: typeof message?.content === 'string' ? message.content : null,
    toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : null,
    finishReason: finish,
    inputTokens: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : null,
    outputTokens: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : null,
  };
}

export type LiveModel = {
  specificationVersion: 'v3';
  provider: string;
  modelId: string;
  doGenerate(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Raw chat-completions call used by the judge (response_format json_object). */
  chatCompletion(messages: OpenAIMessage[], options?: { responseFormat?: { type: 'json_object' } | { type: 'json_schema'; json_schema: unknown }; temperature?: number }): Promise<ChatCompletionResponse>;
  config: LiveModelConfig;
  /** the call ledger this model records into (shared with the runner) */
  ledger: ScriptedModelLedger;
};

const unifiedFinish: Record<string, string> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool-calls',
  content_filter: 'content-filter',
};

export function createLiveModel(config: LiveModelConfig, ledger: ScriptedModelLedger): LiveModel {
  const timeoutMs = config.requestTimeoutMs ?? 30_000;
  const maxRetries = config.maxRetries ?? 1;
  const retryBackoffMs = config.retryBackoffMs ?? 500;

  const request = async (body: Record<string, unknown>, signal?: AbortSignal | null): Promise<{ parsed: ChatCompletionResponse; retries: number }> => {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`live model request timed out after ${timeoutMs}ms`)), timeoutMs);
      const abort = (): void => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else signal.addEventListener('abort', abort, { once: true });
      }
      const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` };
      try {
        const response = await fetch(`${config.apiBase.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`live model HTTP ${response.status}`);
          if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, retryBackoffMs * (attempt + 1)));
            continue;
          }
          throw lastError;
        }
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(`live model HTTP ${response.status}: ${detail.slice(0, 300)}`);
        }
        return { parsed: parseChatCompletion(await response.json()), retries: attempt };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError' && !signal?.aborted) throw new Error(`live model request timed out after ${timeoutMs}ms`);
        throw error;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abort);
      }
    }
    throw lastError ?? new Error('live model request failed');
  };

  return {
    specificationVersion: 'v3',
    provider: config.provider,
    modelId: config.modelId,
    ledger,
    async doGenerate(options: LiveModelCallOptions & Record<string, unknown>) {
      const started = Date.now();
      const promptText = Array.isArray(options.prompt) ? options.prompt.map((message) => (typeof message === 'string' ? message : partText((message as { content?: unknown }).content))).join('\n') : String(options.prompt ?? '');
      const purpose = detectPurpose(promptText);
      const body: Record<string, unknown> = {
        model: config.modelId,
        messages: serializeMessages(options.prompt),
        ...(options.temperature !== undefined ? { temperature: Number(options.temperature) } : {}),
        ...(options.maxTokens !== undefined ? { max_tokens: Number(options.maxTokens) } : {}),
        ...(options.stopSequences !== undefined ? { stop: options.stopSequences } : {}),
      };
      const tools = serializeTools(options.tools);
      if (tools) body.tools = tools;
      if (options.toolChoice !== undefined) body.tool_choice = serializeToolChoice(options.toolChoice);
      const mode = options.mode as { type?: unknown; schema?: unknown; name?: unknown } | undefined;
      if (mode?.type === 'object-json') {
        // JSON mode is the safest OpenAI-compatible structured-output knob; the
        // schema guidance is already prompt-injected by Mastra (jsonPromptInjection)
        body.response_format = { type: 'json_object' };
      } else if (mode?.type === 'object-tool' && typeof mode.name === 'string') {
        body.tool_choice = { type: 'function', function: { name: mode.name } };
      }
      try {
        const { parsed, retries } = await request(body, (options.abortSignal as AbortSignal | null | undefined) ?? null);
        const toolCalls = parsed.toolCalls;
        const content: Array<Record<string, unknown>> = [];
        if (parsed.content) content.push({ type: 'text', text: parsed.content });
        if (toolCalls) {
          for (const call of toolCalls) content.push({ type: 'tool-call', toolCallId: call.id, toolName: call.name, input: call.arguments });
        }
        const unified = unifiedFinish[parsed.finishReason] ?? 'unknown';
        const entry: ScriptedModelCall = {
          purpose,
          provider: config.provider,
          model: config.modelId,
          promptText,
          outputText: JSON.stringify(content),
          promptChars: promptText.length,
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          latencyMs: Date.now() - started,
          responseId: parsed.id,
          toolResultSeen: promptHasToolResult(options.prompt),
          issuedToolCalls: (toolCalls?.length ?? 0) > 0,
          revision: parsed.systemFingerprint,
          retries,
          costUsd: callCostUsd(config.provider, config.modelId, parsed.inputTokens, parsed.outputTokens),
        };
        ledger.calls.push(entry);
        return {
          content,
          finishReason: { unified, raw: parsed.finishReason },
          usage: { inputTokens: { total: parsed.inputTokens ?? undefined }, outputTokens: { total: parsed.outputTokens ?? undefined } },
          warnings: [],
          response: { id: parsed.id ?? `live-${Date.now().toString(36)}`, modelId: config.modelId },
        };
      } catch (error) {
        // failed logical calls are ledgered too (budgets must count attempts);
        // usage/cost stay null → unmetered unless --allow-unmetered
        ledger.calls.push({
          purpose,
          provider: config.provider,
          model: config.modelId,
          promptText,
          outputText: '',
          promptChars: promptText.length,
          inputTokens: null,
          outputTokens: null,
          latencyMs: Date.now() - started,
          responseId: null,
          toolResultSeen: false,
          issuedToolCalls: false,
          revision: null,
          retries: 0,
          costUsd: null,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        });
        throw error;
      }
    },
    async chatCompletion(messages: OpenAIMessage[], options?: { responseFormat?: { type: 'json_object' } | { type: 'json_schema'; json_schema: unknown }; temperature?: number }) {
      const started = Date.now();
      const body: Record<string, unknown> = { model: config.modelId, messages };
      if (options?.responseFormat) body.response_format = options.responseFormat;
      if (options?.temperature !== undefined) body.temperature = options.temperature;
      const promptText = JSON.stringify(messages);
      try {
        const { parsed, retries } = await request(body, null);
        ledger.calls.push({
          purpose: 'judge',
          provider: config.provider,
          model: config.modelId,
          promptText,
          outputText: parsed.content ?? '',
          promptChars: promptText.length,
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          latencyMs: Date.now() - started,
          responseId: parsed.id,
          toolResultSeen: false,
          issuedToolCalls: false,
          revision: parsed.systemFingerprint,
          retries,
          costUsd: callCostUsd(config.provider, config.modelId, parsed.inputTokens, parsed.outputTokens),
        });
        return parsed;
      } catch (error) {
        ledger.calls.push({
          purpose: 'judge',
          provider: config.provider,
          model: config.modelId,
          promptText,
          outputText: '',
          promptChars: promptText.length,
          inputTokens: null,
          outputTokens: null,
          latencyMs: Date.now() - started,
          responseId: null,
          toolResultSeen: false,
          issuedToolCalls: false,
          revision: null,
          retries: 0,
          costUsd: null,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        });
        throw error;
      }
    },
    config,
  };
}
