import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';

export const KIRO_THINKING = {
    MIN_BUDGET_TOKENS: 1024,
    MAX_BUDGET_TOKENS: 24576,
    DEFAULT_BUDGET_TOKENS: 20000,
    START_TAG: '<thinking>',
    END_TAG: '</thinking>',
    MODE_TAG: '<thinking_mode>',
    MAX_LEN_TAG: '<max_thinking_length>',
    EFFORT_TAG: '<thinking_effort>',
};

export const KIRO_CONSTANTS = {
    REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
    REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
    BASE_URL: 'https://runtime.{{region}}.kiro.dev/v1/responses',
    BASE_RUNTIME_URL: 'https://runtime.{{region}}.kiro.dev/v1/responses',
    USAGE_LIMITS_URL: 'https://q.{{region}}.amazonaws.com/getUsageLimits',
    DEFAULT_MODEL_NAME: 'claude-sonnet-4-5',
    AXIOS_TIMEOUT: 120000,
    TOKEN_REFRESH_TIMEOUT: 15000,
    USER_AGENT: 'KiroIDE',
    KIRO_VERSION: '1.4.62',
    CONTENT_TYPE_JSON: 'application/json',
    ACCEPT_JSON: 'application/json',
    AUTH_METHOD_SOCIAL: 'social',
    CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
    ORIGIN_AI_EDITOR: 'AI_EDITOR',
    TOTAL_CONTEXT_TOKENS: 200000,
};

export const KIRO_MAX_TOOL_NAME_LENGTH = 64;
export const KIRO_PLACEHOLDER_TOOL_NAME = 'no_tool_available';

let kiroThrottleQueue = Promise.resolve();
let kiroLastRequestStartedAt = 0;

export function shortenKiroToolName(name) {
    const rawName = String(name || '');
    if (rawName.length <= KIRO_MAX_TOOL_NAME_LENGTH) {
        return rawName;
    }

    const hash = crypto.createHash('sha256').update(rawName).digest('hex').slice(0, 12);
    const prefixLength = KIRO_MAX_TOOL_NAME_LENGTH - hash.length - 1;
    return `${rawName.slice(0, prefixLength)}_${hash}`;
}

export function isMeaningfulContentPart(part) {
    if (!part || typeof part !== 'object') return false;
    if (part.type === 'text') {
        return typeof part.text === 'string' && part.text.trim() !== '';
    }
    return true;
}

export function isEmptyAnthropicMessage(message) {
    if (!message) return true;
    const content = message.content;
    if (content == null) return true;
    if (typeof content === 'string') return content.trim() === '';
    if (Array.isArray(content)) {
        return content.length === 0 || !content.some(isMeaningfulContentPart);
    }
    return false;
}

export function buildKiroPlaceholderTool() {
    return {
        toolSpecification: {
            name: KIRO_PLACEHOLDER_TOOL_NAME,
            description: 'Internal no-op placeholder. Never call this tool (or any tool) in this turn. Do not announce or promise actions such as reading files or running commands. Instead, write your full and complete answer directly as natural-language text in this single reply, based on the information already available to you.',
            inputSchema: {
                json: {
                    type: "object",
                    properties: {}
                }
            }
        }
    };
}

export function buildKiroToolNameMaps(tools) {
    const aliasToOriginal = new Map();
    const originalToAlias = new Map();

    if (Array.isArray(tools)) {
        for (const tool of tools) {
            const originalName = tool?.name;
            if (!originalName) continue;
            const aliasName = shortenKiroToolName(originalName);
            originalToAlias.set(originalName, aliasName);
            if (aliasName !== originalName) {
                aliasToOriginal.set(aliasName, originalName);
            }
        }
    }

    return {
        aliasToOriginal,
        toKiroName: (name) => originalToAlias.get(name) || shortenKiroToolName(name),
        fromKiroName: (name) => aliasToOriginal.get(name) || name
    };
}

export function restoreKiroToolCallNames(toolCalls, toolNameMaps) {
    if (!toolCalls || !toolNameMaps?.fromKiroName) {
        return toolCalls;
    }

    return toolCalls.map(toolCall => ({
        ...toolCall,
        function: {
            ...toolCall.function,
            name: toolNameMaps.fromKiroName(toolCall.function?.name)
        }
    }));
}

/**
 * 确保所有包含 tool_result 的 user 消息前都有对应的 assistant (tool_use) 轮次
 * 避免 AWS CodeWhisperer/Kiro 报 400 轮次不合法错误
 */
export function ensureAssistantBeforeToolResults(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    const result = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg && msg.role === 'user' && Array.isArray(msg.content)) {
            const toolResults = msg.content.filter(p => p && p.type === 'tool_result');
            if (toolResults.length > 0) {
                const prev = result[result.length - 1];
                const prevHasToolUse = prev && prev.role === 'assistant' && (
                    (Array.isArray(prev.content) && prev.content.some(p => p && p.type === 'tool_use')) ||
                    (Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0)
                );
                if (!prevHasToolUse) {
                    logger.info(`[Kiro] Synthesizing missing assistant tool_use before ${toolResults.length} tool_result(s)`);
                    const syntheticToolUses = toolResults.map(tr => ({
                        type: 'tool_use',
                        id: tr.tool_use_id || uuidv4(),
                        name: 'synthetic_tool',
                        input: {}
                    }));
                    result.push({
                        role: 'assistant',
                        content: syntheticToolUses
                    });
                }
            }
        }
        result.push(msg);
    }
    return result;
}

function getKiroRequestMinIntervalMs(config) {
    const value = Number(config?.KIRO_REQUEST_MIN_INTERVAL_MS);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export async function acquireKiroRequestSlot(config) {
    const minIntervalMs = getKiroRequestMinIntervalMs(config);
    if (minIntervalMs <= 0) {
        return () => {};
    }

    let releaseCurrent;
    const previous = kiroThrottleQueue.catch(() => {});
    kiroThrottleQueue = previous.then(() => new Promise(resolve => {
        releaseCurrent = resolve;
    }));

    await previous;

    const elapsedMs = Date.now() - kiroLastRequestStartedAt;
    const waitMs = Math.max(0, minIntervalMs - elapsedMs);
    if (waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    kiroLastRequestStartedAt = Date.now();

    let released = false;
    return () => {
        if (released) return;
        released = true;
        releaseCurrent();
    };
}

export function normalizeKiroToolInput(input) {
    if (input === undefined || input === null) {
        return '';
    }
    if (typeof input === 'string') {
        return input;
    }
    if (typeof input === 'object') {
        try {
            return JSON.stringify(input);
        } catch (e) {
            return String(input);
        }
    }
    return String(input);
}

export const MODEL_CONTEXT_TOKENS = {
    "gpt-5.6-sol": 1000000,
    "gpt-5.6-terra": 1000000,
    "gpt-5.6-luna": 1000000,
    "claude-sonnet-5": 1000000,
    "claude-opus-5": 1000000,
    "claude-opus-4-8": 1000000,
    "claude-opus-4-7": 1000000,
    "claude-opus-4-6": 1000000,
    "claude-opus-4-5": 1000000,
    "claude-opus-4-5-20251101": 1000000,
    "claude-sonnet-4-6": 200000,
    "claude-sonnet-4-5": 200000,
    "claude-sonnet-4-5-20250929": 200000,
    "claude-haiku-4-5": 200000,
    "claude-haiku-4-5-20251001": 200000,
};

function normalizeContextLength(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const numericValue = Number(value);
    return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null;
}

function findCustomModelConfigForModel(model, config = {}) {
    const targetModel = typeof model === 'string'
        ? model.replace(/^[^:]+:/, '')
        : '';
    if (!targetModel) {
        return null;
    }

    const customModels = Array.isArray(config?.customModels) ? config.customModels : [];
    return customModels.find(({ id, alias, actualModel } = {}) =>
        id === targetModel || alias === targetModel || actualModel === targetModel
    ) || null;
}

export function getContextTokensForModel(model, config = {}, fallbackModel = null) {
    const customModelConfig = findCustomModelConfigForModel(model, config) ||
        findCustomModelConfigForModel(fallbackModel, config);
    const configuredModelContextLength = normalizeContextLength(customModelConfig?.contextLength);
    if (configuredModelContextLength !== null) {
        return configuredModelContextLength;
    }

    return MODEL_CONTEXT_TOKENS[model] || MODEL_CONTEXT_TOKENS[fallbackModel] || KIRO_CONSTANTS.TOTAL_CONTEXT_TOKENS;
}

export const FULL_MODEL_MAPPING = {
    "gpt-5.6-sol": "gpt-5.6-sol",
    "gpt-5.6-terra": "gpt-5.6-terra",
    "gpt-5.6-luna": "gpt-5.6-luna",
    "claude-haiku-4-5": "claude-haiku-4.5",
    "claude-haiku-4-5-20251001": "claude-haiku-4.5",
    "claude-sonnet-5": "claude-sonnet-5",
    "claude-opus-5": "claude-opus-5",
    "claude-opus-4-8": "claude-opus-4.8",
    "claude-opus-4-7": "claude-opus-4.7",
    "claude-opus-4-6": "claude-opus-4.6",
    "claude-sonnet-4-6": "claude-sonnet-4.6",
    "claude-opus-4-5": "claude-opus-4.5",
    "claude-opus-4-5-20251101": "claude-opus-4.5",
    "claude-sonnet-4-5": "claude-sonnet-4.5",
    "claude-sonnet-4-5-20250929": "claude-sonnet-4.5"
};
