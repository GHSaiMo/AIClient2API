/**
 * 通用动态自适应超时模块 (Universal Dynamic Adaptive Timeout Guard)
 *
 * 核心目标：
 * 针对不同模型输入规模（长上下文 Tokens、多模态部件）、以及是否开启深度思考（Reasoning / Thinking），
 * 实施自适应阶梯扩缩容：
 * - 短任务（<15k tokens）采用基线 60s 快速熔断，防止假死挂起耗尽并发插槽；
 * - 复杂重任务与大上下文根据阶梯平滑放宽（最高至 240s~300s）；
 * - 深度思考模型（o1/o3/Claude Thinking/DeepSeek R1/Gemini Thinking）实施 120s 兜底保底；
 * - 保护流式与非流式调用免受固定短超时误杀或无限挂死。
 */

import { DYNAMIC_TIMEOUT } from './constants.js';
import logger from './logger.js';

export const DYNAMIC_TIMEOUT_BASE_MS = DYNAMIC_TIMEOUT.BASE_MS;
export const DYNAMIC_TIMEOUT_MIN_MS = DYNAMIC_TIMEOUT.MIN_MS;
export const DYNAMIC_TIMEOUT_MAX_MS = DYNAMIC_TIMEOUT.MAX_MS;
export const DYNAMIC_STREAM_IDLE_TIMEOUT_MS = DYNAMIC_TIMEOUT.IDLE_MS;

// 深度思考模型名称特征
const THINKING_MODEL_REGEX = /(-thinking|-reasoning|-reasoner|reasoning|deepsearch|think|o1|o3|o4|qwq|deepseek-r1|\br1\b|claude.*thinking)/i;

/**
 * 通用估算 payload 中的 Token 数、多模态附件数与思考模式
 * 支持兼容 Gemini、Claude、OpenAI / Codex、Grok 等多种上游格式
 *
 * @param {Object} body - 请求 payload
 * @returns {{ estimatedTokens: number, mediaCount: number, hasThinking: boolean }}
 */
export function estimatePayloadTokensAndMedia(body) {
    let textLength = 0;
    let mediaCount = 0;
    let hasThinking = false;

    if (!body || typeof body !== 'object') {
        return { estimatedTokens: 0, mediaCount: 0, hasThinking: false };
    }

    // 1. 模型名称特征检测
    const rawModel = body.model || body.selectedModel || '';
    if (typeof rawModel === 'string' && rawModel) {
        if (THINKING_MODEL_REGEX.test(rawModel)) {
            hasThinking = true;
        }
    }

    // 2. 深度思考参数特征检测 (OpenAI / Claude / Gemini / Grok)
    // 2.1 OpenAI / Codex reasoning_effort
    if (body.reasoning_effort && body.reasoning_effort !== 'none') {
        hasThinking = true;
    }
    // 2.2 Claude thinking
    if (body.thinking) {
        if (body.thinking.type === 'enabled' || (body.thinking.budget_tokens && Number(body.thinking.budget_tokens) > 0)) {
            hasThinking = true;
        }
    }
    // 2.3 Gemini / Antigravity thinkingConfig
    const req = body.request || body;
    const thinkingConfig = req.generationConfig?.thinkingConfig || body.generationConfig?.thinkingConfig;
    if (thinkingConfig) {
        if (thinkingConfig.thinkingBudget != null && Number(thinkingConfig.thinkingBudget) > 0) {
            hasThinking = true;
        }
        if (thinkingConfig.thinkingLevel && thinkingConfig.thinkingLevel !== 'low' && thinkingConfig.thinkingLevel !== 'minimal') {
            hasThinking = true;
        }
    }

    // 3. 系统提示词处理 (systemInstruction / system / instructions)
    if (req.systemInstruction?.parts && Array.isArray(req.systemInstruction.parts)) {
        for (const part of req.systemInstruction.parts) {
            if (part?.text) textLength += part.text.length;
        }
    }
    if (typeof body.system === 'string') {
        textLength += body.system.length;
    } else if (Array.isArray(body.system)) {
        for (const part of body.system) {
            if (part?.text) textLength += part.text.length;
        }
    }
    if (typeof body.instructions === 'string') {
        textLength += body.instructions.length;
    }

    // 4. 内容与消息处理 (contents / messages / input)
    const containers = [
        req.contents,
        body.contents,
        body.messages,
        body.input,
        req.messages
    ];

    const visitedContainers = new Set();
    for (const container of containers) {
        if (!Array.isArray(container) || visitedContainers.has(container)) continue;
        visitedContainers.add(container);

        for (const item of container) {
            if (!item) continue;
            // 纯文本消息
            if (typeof item === 'string') {
                textLength += item.length;
                continue;
            }

            // OpenAI / Claude 结构
            if (typeof item.content === 'string') {
                textLength += item.content.length;
            } else if (Array.isArray(item.content)) {
                for (const part of item.content) {
                    if (!part) continue;
                    if (typeof part === 'string') {
                        textLength += part.length;
                    } else if (part.text) {
                        textLength += String(part.text).length;
                    }
                    if (part.type === 'image' || part.type === 'image_url' || part.image_url || part.type === 'document' || part.type === 'input_audio' || part.type === 'file') {
                        mediaCount++;
                    }
                }
            }

            // Gemini 结构
            if (Array.isArray(item.parts)) {
                for (const part of item.parts) {
                    if (!part) continue;
                    if (part.text) {
                        textLength += String(part.text).length;
                    }
                    if (part.inlineData || part.fileData || part.image || part.document) {
                        mediaCount++;
                    }
                    if (part.functionCall) {
                        try { textLength += JSON.stringify(part.functionCall).length; } catch (_) {}
                    }
                    if (part.functionResponse) {
                        try { textLength += JSON.stringify(part.functionResponse).length; } catch (_) {}
                    }
                }
            } else if (typeof item.text === 'string') {
                textLength += item.text.length;
            }

            // tool_calls / function_call
            if (item.tool_calls && Array.isArray(item.tool_calls)) {
                try { textLength += JSON.stringify(item.tool_calls).length; } catch (_) {}
            }
            if (item.function_call) {
                try { textLength += JSON.stringify(item.function_call).length; } catch (_) {}
            }
        }
    }

    // 单个 message 字段 (如 Grok 某些简单请求)
    if (typeof body.message === 'string') {
        textLength += body.message.length;
    }

    // 5. Tools / Functions 工具定义
    const tools = req.tools || body.tools || body.functions;
    if (Array.isArray(tools)) {
        try { textLength += JSON.stringify(tools).length; } catch (_) {}
    }

    // 文本按约 3.8 字符/token 估算（中英混排与代码安全近似）
    const estimatedTokens = Math.max(0, Math.ceil(textLength / 3.8));

    return { estimatedTokens, mediaCount, hasThinking };
}

/**
 * 通用动态自适应超时计算（对齐阶梯：<15k->60s, 15k-50k->90s, 50k-100k->150s, >=100k->240s）
 *
 * @param {Object} body - 请求 payload
 * @param {Object} [options] - 超时自定义配置
 * @param {number} [options.baseTimeoutMs] - 基础超时（默认 60s）
 * @param {number} [options.minTimeoutMs] - 下限熔断（默认 30s）
 * @param {number} [options.maxTimeoutMs] - 上限截断（默认 300s）
 * @returns {{ timeoutMs: number, details: Object }}
 */
export function computeDynamicTimeout(body, options = {}) {
    const baseTimeoutMs = options.baseTimeoutMs ?? DYNAMIC_TIMEOUT.BASE_MS;
    const minTimeoutMs = options.minTimeoutMs ?? DYNAMIC_TIMEOUT.MIN_MS;
    const maxTimeoutMs = options.maxTimeoutMs ?? DYNAMIC_TIMEOUT.MAX_MS;

    const { estimatedTokens, mediaCount, hasThinking } = estimatePayloadTokensAndMedia(body);

    let contextBonusMs = 0;
    if (estimatedTokens >= 100000) {
        contextBonusMs = 180000; // 60s + 180s = 240s
    } else if (estimatedTokens >= 50000) {
        contextBonusMs = 90000;  // 60s + 90s = 150s
    } else if (estimatedTokens >= 15000) {
        contextBonusMs = 30000;  // 60s + 30s = 90s
    }

    // 多模态每个部件补偿 10s，最多 60s
    const mediaBonusMs = Math.min(mediaCount * 10000, 60000);

    let calculatedMs = baseTimeoutMs + contextBonusMs + mediaBonusMs;

    // 思考模型保底不低于 120s
    if (hasThinking && calculatedMs < 120000) {
        calculatedMs = 120000;
    }

    // 边界截断 clamp(calculatedMs, minTimeoutMs, maxTimeoutMs)
    const finalMs = Math.min(Math.max(calculatedMs, minTimeoutMs), maxTimeoutMs);

    return {
        timeoutMs: finalMs,
        details: {
            estimatedTokens,
            mediaCount,
            hasThinking,
            baseTimeoutMs,
            contextBonusMs,
            mediaBonusMs,
            finalMs
        }
    };
}

/**
 * 统一快捷注入动态超时到请求参数对象中
 *
 * @param {Object} reqOptions - Undici/Fetch 请求配置选项
 * @param {Object} body - 请求载荷
 * @param {Object} [options] - 配置与日志前缀
 * @returns {{ timeoutMs: number, details: Object }}
 */
export function applyDynamicTimeout(reqOptions, body, options = {}) {
    if (!reqOptions || typeof reqOptions !== 'object') return null;
    const dynamic = computeDynamicTimeout(body, options);
    reqOptions.timeout = dynamic.timeoutMs;
    reqOptions._dynamicTimeoutDetails = dynamic.details;
    if (options.logPrefix) {
        const d = dynamic.details;
        logger.info(`${options.logPrefix} dynamic timeout: ${dynamic.timeoutMs}ms (Tokens: ~${d.estimatedTokens}, Media: ${d.mediaCount}, Thinking: ${d.hasThinking})`);
    }
    return dynamic;
}
