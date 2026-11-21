export { MODEL_PROTOCOL_PREFIX, MODEL_PROVIDER } from './constants.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import logger from './logger.js';
import requestContext from './context.js';
import { convertData, getOpenAIStreamChunkStop } from '../convert/convert.js';
import { ProviderStrategyFactory } from './provider-strategies.js';
import { getPluginManager } from '../core/plugin-manager.js';
import { MODEL_PROTOCOL_PREFIX, MODEL_PROVIDER } from './constants.js';
import { getCustomModelConfig } from '../providers/provider-models.js';
import { ENDPOINT_TYPE, getProtocolPrefix } from './protocol-utils.js';
import {
    RETRYABLE_NETWORK_ERRORS,
    RETRYABLE_NETWORK_ERRORS_SET,
    isRetryableNetworkError,
    ensureValidStatusCode,
    getErrorStatusCode,
    getNormalizedErrorResponseText,
    buildHttpErrorReason,
    normalizeProviderErrorMessage,
    getRetryAfterMs,
    isRateLimitError,
    getRateLimitCooldownRecoveryTime,
    isQuotaExhaustedError,
    getQuotaCooldownRecoveryTime,
    calculateRetryDelay,
    createEmptyUpstreamResponseError,
    createErrorResponse,
    createStreamErrorResponse,
    handleError
} from './retry-error-utils.js';
import {
    resolveCustomModelRouting,
    handleModelListRequest,
    handleModelDetailRequest
} from './model-registry-utils.js';

export {
    ENDPOINT_TYPE,
    getProtocolPrefix,
    RETRYABLE_NETWORK_ERRORS,
    RETRYABLE_NETWORK_ERRORS_SET,
    isRetryableNetworkError,
    ensureValidStatusCode,
    getNormalizedErrorResponseText,
    buildHttpErrorReason,
    normalizeProviderErrorMessage,
    getRetryAfterMs,
    isRateLimitError,
    getRateLimitCooldownRecoveryTime,
    isQuotaExhaustedError,
    getQuotaCooldownRecoveryTime,
    calculateRetryDelay,
    createEmptyUpstreamResponseError,
    handleError,
    resolveCustomModelRouting,
    handleModelListRequest,
    handleModelDetailRequest
};

// ==================== 时间与时区 ====================

/**
 * 获取北京时间 (UTC+8) 的日期字符串 (YYYY-MM-DD)
 * @returns {string} - YYYY-MM-DD 格式的日期字符串
 */
export function getBeijingDateString() {
    const now = new Date();
    const utc8Time = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    return utc8Time.toISOString().split('T')[0];
}

// ==================== API 常量 ====================

export const API_ACTIONS = {
    GENERATE_CONTENT: 'generateContent',
    STREAM_GENERATE_CONTENT: 'streamGenerateContent',
};
export const DEFAULT_REQUEST_BODY_MAX_BYTES = 10 * 1024 * 1024;

export const FETCH_SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'configs', 'fetch_system_prompt.txt');
export const INPUT_SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'configs', 'input_system_prompt.txt');

export function formatExpiryTime(expiryTimestamp) {
    if (!expiryTimestamp || typeof expiryTimestamp !== 'number') return "No expiry date available";
    const diffMs = expiryTimestamp - Date.now();
    if (diffMs <= 0) return "Token has expired";
    let totalSeconds = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const pad = (num) => String(num).padStart(2, '0');
    return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

/**
 * 格式化日志输出，统一日志格式
 * @param {string} tag - 日志标签，如 'Qwen', 'Kiro' 等
 * @param {string} message - 日志消息
 * @param {Object} [data] - 可选的数据对象，将被格式化输出
 * @returns {string} 格式化后的日志字符串
 */
export function formatLog(tag, message, data = null) {
    let logMessage = `[${tag}] ${message}`;
    
    if (data !== null && data !== undefined) {
        if (typeof data === 'object') {
            const dataStr = Object.entries(data)
                .map(([key, value]) => `${key}: ${value}`)
                .join(', ');
            logMessage += ` | ${dataStr}`;
        } else {
            logMessage += ` | ${data}`;
        }
    }
    
    return logMessage;
}

/**
 * 格式化凭证过期时间日志
 * @param {string} tag - 日志标签，如 'Qwen', 'Kiro' 等
 * @param {number} expiryDate - 过期时间戳
 * @param {number} nearMinutes - 临近过期的分钟数
 * @returns {{message: string, isNearExpiry: boolean}} 格式化后的日志字符串和是否临近过期
 */
export function formatExpiryLog(tag, expiryDate, nearMinutes) {
    const currentTime = Date.now();
    const nearMinutesInMillis = nearMinutes * 60 * 1000;
    const thresholdTime = currentTime + nearMinutesInMillis;
    const isNearExpiry = expiryDate <= thresholdTime;
    
    const message = formatLog(tag, 'Checking expiry date', {
        'Expiry date': expiryDate,
        'Current time': currentTime,
        [`${nearMinutes} minutes from now`]: thresholdTime,
        'Is near expiry': isNearExpiry
    });
    
    return { message, isNearExpiry };
}

function normalizeIpAddress(ip) {
    if (!ip) return null;

    let normalized = String(ip).trim();
    if (!normalized) return null;

    // Clean up IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1 -> 127.0.0.1)
    if (normalized.startsWith('::ffff:')) {
        normalized = normalized.substring('::ffff:'.length);
    }

    return normalized || null;
}

function parseTrustedProxyIps(value) {
    if (Array.isArray(value)) {
        return value
            .flatMap(item => parseTrustedProxyIps(item))
            .filter(Boolean);
    }

    if (typeof value !== 'string') {
        return [];
    }

    return value
        .split(',')
        .map(item => normalizeIpAddress(item))
        .filter(Boolean);
}

function isTrustedProxyIp(ip, trustedProxyIps) {
    const normalizedIp = normalizeIpAddress(ip);
    if (!normalizedIp) return false;

    return parseTrustedProxyIps(trustedProxyIps).some(trustedIp => trustedIp === normalizedIp);
}

/**
 * Get client IP address from request.
 *
 * x-forwarded-for is client-controlled unless the immediate peer is a trusted
 * reverse proxy. Keep TRUST_PROXY disabled by default for login rate limits.
 *
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @param {Object} [config] - Optional server configuration.
 * @returns {string} The client IP address.
 */
export function getClientIp(req, config = {}) {
    const socketIp = normalizeIpAddress(req.socket?.remoteAddress);

    if (config?.TRUST_PROXY === true && isTrustedProxyIp(socketIp, config.TRUSTED_PROXY_IPS)) {
        const forwarded = req.headers?.['x-forwarded-for'];
        const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
        const forwardedIp = normalizeIpAddress(forwardedValue?.split(',')[0]);
        if (forwardedIp) {
            return forwardedIp;
        }
    }

    return socketIp || 'unknown';
}

/**
 * Reads the entire request body from an HTTP request.
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @param {{ maxBytes?: number }} options - Optional body limits.
 * @returns {Promise<Object>} A promise that resolves with the parsed JSON request body.
 * @throws {Error} If the request body is not valid JSON.
 */
export function getRequestBody(req, options = {}) {
    return new Promise((resolve, reject) => {
        let body = '';
        let receivedBytes = 0;
        let settled = false;
        const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_REQUEST_BODY_MAX_BYTES;

        // 1. Quick check Content-Length header
        const headers = req.headers || {};
        const contentLength = parseInt(headers['content-length'] || '0', 10);
        if (!isNaN(contentLength) && contentLength > maxBytes) {
            req.resume(); // drain & discard
            const error = new Error(`Request body too large. Maximum size is ${maxBytes} bytes.`);
            error.statusCode = 413;
            error.code = 'BODY_TOO_LARGE';
            return reject(error);
        }

        const fail = (error) => {
            if (settled) return;
            settled = true;
            if (typeof req.destroy === 'function') {
                req.destroy();
            }
            reject(error);
        };

        const rejectTooLarge = (error) => {
            if (settled) return;
            settled = true;
            if (typeof req.resume === 'function') {
                req.resume();
            }
            reject(error);
        };

        req.on('data', chunk => {
            if (settled) return;
            receivedBytes += chunk.length;
            if (maxBytes && receivedBytes > maxBytes) {
                const error = new Error(`Request body too large. Maximum size is ${maxBytes} bytes.`);
                error.statusCode = 413;
                error.code = 'BODY_TOO_LARGE';
                rejectTooLarge(error);
                return;
            }
            body += chunk.toString();
        });
        req.on('end', () => {
            if (settled) return;
            settled = true;
            if (!body) {
                return resolve({});
            }
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(new Error("Invalid JSON in request body."));
            }
        });
        req.on('error', err => {
            fail(err);
        });
    });
}

export async function logConversation(type, content, logMode, logFilename) {
    if (logMode === 'none') return;
    if (!content) return;

    const timestamp = new Date().toLocaleString();
    const logEntry = `${timestamp} [${type.toUpperCase()}]:\n${content}\n--------------------------------------\n`;

    if (logMode === 'console') {
        logger.info(logEntry);
    } else if (logMode === 'file') {
        try {
            // Append to the file
            await fs.appendFile(logFilename, logEntry);
        } catch (err) {
            logger.error(`[Error] Failed to write conversation log to ${logFilename}:`, err);
        }
    }
}

/**
 * Checks if the request is authorized based on API key.
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @param {URL} requestUrl - The parsed URL object.
 * @param {string} REQUIRED_API_KEY - The API key required for authorization.
 * @returns {boolean} True if authorized, false otherwise.
 */
function timingSafeEqualString(candidate, expected) {
    if (typeof candidate !== 'string' || typeof expected !== 'string' || expected.length === 0) {
        return false;
    }
    const hashA = crypto.createHash('sha256').update(candidate, 'utf8').digest();
    const hashB = crypto.createHash('sha256').update(expected, 'utf8').digest();
    return crypto.timingSafeEqual(hashA, hashB) && candidate.length === expected.length;
}

export function isAuthorized(req, requestUrl, REQUIRED_API_KEY) {
    const authHeader = req.headers['authorization'];
    const queryKey = requestUrl.searchParams.get('key');
    const googApiKey = req.headers['x-goog-api-key'];
    const claudeApiKey = req.headers['x-api-key']; // Claude-specific header

    // Check for Bearer token in Authorization header (OpenAI style)
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (timingSafeEqualString(token, REQUIRED_API_KEY)) {
            return true;
        }
    }

    // Check for API key in URL query parameter (Gemini style)
    if (timingSafeEqualString(queryKey, REQUIRED_API_KEY)) {
        return true;
    }

    // Check for API key in x-goog-api-key header (Gemini style)
    if (timingSafeEqualString(googApiKey, REQUIRED_API_KEY)) {
        return true;
    }

    // Check for API key in x-api-key header (Claude style)
    if (timingSafeEqualString(claudeApiKey, REQUIRED_API_KEY)) {
        return true;
    }

    logger.info(`[Auth] Unauthorized request denied. Bearer: "${authHeader ? 'present' : 'N/A'}", Query Key: "${queryKey ? 'present' : 'N/A'}", x-goog-api-key: "${googApiKey ? 'present' : 'N/A'}", x-api-key: "${claudeApiKey ? 'present' : 'N/A'}"`);
    return false;
}

/**
 * Handles the common logic for sending API responses (unary and stream).
 * This includes writing response headers, logging conversation, and logging auth token expiry.
 * @param {http.ServerResponse} res - The HTTP response object.
 * @param {Object} responsePayload - The actual response payload (string for unary, object for stream chunks).
 * @param {boolean} isStream - Whether the response is a stream.
 */
export async function handleUnifiedResponse(res, responsePayload, isStream, statusCode = 200) {
    const validatedStatusCode = ensureValidStatusCode(statusCode);
    if (isStream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Transfer-Encoding": "chunked" });
    } else {
        res.writeHead(validatedStatusCode, { 'Content-Type': 'application/json' });
    }

    if (isStream) {
        // Stream chunks are handled by the calling function that iterates the stream
    } else {
        res.end(responsePayload);
    }
}

function getPluginHookRequestId(config) {
    return config?._monitorRequestId || null;
}

/**
 * 针对上游「空响应」（error.isEmptyUpstreamResponse）计算是否应该重试，并在应该重试时尝试获取一个
 * 备用的服务实例。重试预算由 CONFIG.EMPTY_RESPONSE_MAX_RETRIES 控制，与凭证切换预算
 * （CREDENTIAL_SWITCH_MAX_RETRIES）完全独立计数，避免一次空回把凭证切换预算耗光。
 * 该机制不绑定具体 provider：任何 provider 抛出带 isEmptyUpstreamResponse 标记的错误都会走到这里。
 *
 * @param {string} [providerLabel='Upstream'] - 用于日志的 provider 标签，如 'Kiro'、'Qwen' 等
 * @returns {Promise<{retry: boolean, result?: object, emptyResponseRetry?: number}>}
 */
async function resolveEmptyUpstreamResponseRetry(CONFIG, model, attemptsMade, logPrefix, providerLabel = 'Upstream') {
    const emptyRetryMax = CONFIG?.EMPTY_RESPONSE_MAX_RETRIES ?? 2;
    const emptyRetryDelayMs = CONFIG?.EMPTY_RESPONSE_RETRY_DELAY_MS ?? 500;

    if (attemptsMade >= emptyRetryMax) {
        logger.error(`${logPrefix} ${providerLabel} empty response persisted after ${emptyRetryMax} retr${emptyRetryMax === 1 ? 'y' : 'ies'} (same request body). Giving up.`);
        return { retry: false };
    }

    logger.warn(`${logPrefix} ${providerLabel} empty response detected (no text/tool/thinking content). Retrying with the same request body (${attemptsMade + 1}/${emptyRetryMax})...`);
    if (emptyRetryDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, emptyRetryDelayMs));
    }

    try {
        // 动态导入以避免循环依赖
        const { getApiServiceWithFallback } = await import('../services/service-manager.js');
        const result = await getApiServiceWithFallback(CONFIG, model, { acquireSlot: true });

        if (result && result.service) {
            logger.info(`${logPrefix} Retrying empty ${providerLabel} response with credential: ${result.uuid} (provider: ${result.actualProviderType})`);
            return { retry: true, result, emptyResponseRetry: attemptsMade + 1 };
        }

        logger.warn(`${logPrefix} No alternative credential available for empty-response retry.`);
        return { retry: false };
    } catch (retryError) {
        logger.error(`${logPrefix} Failed to get alternative service for empty-response retry:`, retryError.message);
        return { retry: false };
    }
}

/**
 * 安全写入流式分块并处理背压 (Backpressure)
 * 当内核缓冲区满 (res.write 返回 false) 时等待 drain 或客户端断开事件
 * @param {http.ServerResponse} res
 * @param {string|Buffer} payload
 * @param {{ value: boolean }} clientDisconnected
 * @returns {Promise<boolean>} 是否成功写入
 */
async function safeStreamWriteChunk(res, payload, clientDisconnected) {
    if (clientDisconnected.value || res.writableEnded || res.finished || res.destroyed) {
        return false;
    }

    try {
        const ok = res.write(payload);
        if (!ok && !res.writableEnded && !clientDisconnected.value) {
            await new Promise(resolve => {
                const onDrain = () => { cleanup(); resolve(); };
                const onClose = () => { cleanup(); resolve(); };
                const cleanup = () => {
                    res.off('drain', onDrain);
                    res.off('close', onClose);
                };
                res.once('drain', onDrain);
                res.once('close', onClose);
            });
        }
        return true;
    } catch (writeErr) {
        logger.error('[Stream] Failed to write stream chunk:', writeErr.message);
        clientDisconnected.value = true;
        return false;
    }
}

export async function handleStreamRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, customName, retryContext = null) {
    const fullResponseTextChunks = [];
    let fullResponseJson = '';
    let fullOldResponseJson = '';
    let responseClosed = false;
    let anyDataSent = retryContext?.anyDataSent || false; // 跟踪是否已向客户端发送过任何数据
    
    // 重试上下文：包含 CONFIG 和重试计数
    // maxRetries: 凭证切换最大次数（跨凭证），默认 5 次
    const maxRetries = retryContext?.maxRetries ?? 5;
    const currentRetry = retryContext?.currentRetry ?? 0;
    const CONFIG = retryContext?.CONFIG;
    // isRetry 用于判断当前调用是否是某次重试的递归帧：既包括凭证切换重试（currentRetry），
    // 也包括上游空响应重试（emptyResponseRetry，参见 resolveEmptyUpstreamResponseRetry）。只有最外层（非重试）的调用帧才负责
    // 绑定/解绑客户端事件监听器、发送响应头、以及在 finally 中写入流结束标记 / res.end()。
    // 如果这里遗漏了 emptyResponseRetry，递归进去的重试帧会误以为自己是最外层，
    // 导致外层和内层重复对同一个 res 做收尾（重复 res.end()），从而抛出 "write after end"。
    const isRetry = currentRetry > 0 || (retryContext?.emptyResponseRetry ?? 0) > 0;
    
    // 使用共享的 clientDisconnected 与 AbortController 状态（如果是重试，继承上层的状态）
    let clientDisconnected = retryContext?.clientDisconnected || { value: false };
    let streamAbortController = retryContext?.streamAbortController || null;
    if (!isRetry) {
        clientDisconnected = { value: false }; // 使用对象引用，便于在递归中共享状态
        streamAbortController = new AbortController();
        const outerAbortSignal = requestContext.get('upstreamAbortSignal');
        if (outerAbortSignal) {
            if (outerAbortSignal.aborted) {
                clientDisconnected.value = true;
                streamAbortController.abort(outerAbortSignal.reason);
            } else {
                outerAbortSignal.addEventListener('abort', () => {
                    clientDisconnected.value = true;
                    if (!streamAbortController.signal.aborted) {
                        streamAbortController.abort(outerAbortSignal.reason);
                    }
                }, { once: true });
            }
        }
    }

    // 监听客户端断开连接事件（命名函数，便于移除），立即触发底层 fetch/WS 中止
    const onClientClose = () => {
        if (!res.writableEnded) {
            clientDisconnected.value = true;
            if (streamAbortController && !streamAbortController.signal.aborted) {
                streamAbortController.abort(new Error('Client disconnected during stream'));
            }
            logger.info('[Stream] Client disconnected, aborting upstream stream processing');
        }
    };
    
    const onClientError = (err) => {
        clientDisconnected.value = true;
        if (streamAbortController && !streamAbortController.signal.aborted) {
            streamAbortController.abort(err);
        }
        logger.error('[Stream] Response stream error:', err.message);
    };
    
    // 只在首次请求时注册事件监听器（避免重试时重复注册）
    if (!isRetry) {
        res.on('close', onClientClose);
        res.on('error', onClientError);
    }

    // 只在首次请求时发送响应头，重试时跳过（响应头已发送）
    if (!isRetry) {
        await handleUnifiedResponse(res, '', true);
    }

    // 流式钩子按顺序串行执行，但不阻塞向客户端写数据；流结束时统一等待
    let streamHookChain = Promise.resolve();
    let hasToolCall = false;
    let hasMessageStop = false; // 跟踪是否已经发送过结束标志（message_stop / done）
    let streamFailed = false;
    let streamRequestId;

    try {
        const needsConversion = getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider);
        requestBody.model = model;
        const streamStore = {
            ...requestContext.getStore(),
            ...(streamAbortController ? { upstreamAbortSignal: streamAbortController.signal } : {})
        };
        const addEvent = getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.CLAUDE || getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;
        // 为每个请求生成唯一 ID，用于在单例 converter 中隔离并发流状态
        streamRequestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

        await requestContext.run(streamStore, async () => {
            const nativeStream = await service.generateContentStream(model, requestBody);

            // 如果提供者内部发生了模型回退（如 Antigravity 自动降级），同步更新本地 model 变量
            // 这确保了后续的监控钩子和统计插件记录的是实际使用的模型
            if (requestBody.model && requestBody.model !== model) {
                model = requestBody.model;
            }

            for await (const nativeChunk of nativeStream) {
            // 检查客户端是否已断开连接
            if (clientDisconnected.value) {
                logger.info('[Stream] Stopping iteration due to client disconnect');
                break;
            }

            // 检查上游是否因内容安全策略在首帧拦截了 Prompt
            if (nativeChunk?.promptFeedback?.blockReason && !anyDataSent) {
                const blockReason = nativeChunk.promptFeedback.blockReason;
                const blockMessage = nativeChunk.promptFeedback.blockReasonMessage || `The prompt was blocked by upstream safety policy: ${blockReason}`;
                logger.warn(`[Stream] [${toProvider}] Upstream stream blocked prompt by content policy: ${blockReason}. ${blockMessage}`);
                const policyError = new Error(`[${toProvider}] Request blocked by content policy: ${blockReason}. ${blockMessage}`);
                policyError.status = 400;
                policyError.code = 'content_filter';
                policyError.type = 'content_filter_error';
                policyError.isPromptBlocked = true;
                throw policyError;
            }
            
            // Extract text for logging purposes
            const chunkText = extractResponseText(nativeChunk, toProvider);
            if (chunkText && !Array.isArray(chunkText)) {
                fullResponseTextChunks.push(chunkText);
            }

            // Convert the complete chunk object to the client's format (fromProvider), if necessary.
            const chunkToSend = needsConversion
                ? convertData(nativeChunk, 'streamChunk', toProvider, fromProvider, model, streamRequestId)
                : nativeChunk;

            // 监控钩子：流式响应分块（走快速通道直接分发，杜绝每 chunk 创建定时器与 Promise 链）
            const hookRequestId = getPluginHookRequestId(CONFIG);
            if (hookRequestId) {
                try {
                    const pluginManager = getPluginManager();
                    if (pluginManager) {
                        pluginManager.executeFastStreamChunkHook({
                            nativeChunk,
                            chunkToSend,
                            fromProvider,
                            toProvider,
                            model,
                            requestId: hookRequestId
                        });
                    }
                } catch (e) {}
            }

            if (!chunkToSend) {
                continue;
            }

            // 处理 chunkToSend 可能是数组或对象的情况
            const chunksToSend = Array.isArray(chunkToSend) ? chunkToSend : [chunkToSend];

            for (const chunk of chunksToSend) {
                // 再次检查客户端连接状态
                if (clientDisconnected.value) {
                    break;
                }
                
                // [FIX] 跟踪工具调用并在结束时修正 finish_reason
                // OpenAI 格式
                if (chunk.choices?.[0]?.delta?.tool_calls || chunk.choices?.[0]?.finish_reason === 'tool_calls') {
                    hasToolCall = true;
                }
                // Claude 格式
                if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
                    hasToolCall = true;
                }
                if (chunk.type === 'message_delta' && (chunk.delta?.stop_reason === 'tool_use' || chunk.stop_reason === 'tool_use')) {
                    hasToolCall = true;
                }
                // Gemini 格式
                if (chunk.candidates?.[0]?.content?.parts?.some(p => p.functionCall)) {
                    hasToolCall = true;
                }

                // 如果之前有工具调用，且当前 chunk 是正常结束，修正为 tool_calls / tool_use / FINISH_REASON_TOOL_CALLS
                if (hasToolCall && needsConversion) {
                    if (chunk.choices?.[0]?.finish_reason === 'stop') {
                        chunk.choices[0].finish_reason = 'tool_calls';
                    } else if (chunk.type === 'message_delta' && chunk.delta?.stop_reason === 'end_turn') {
                        chunk.delta.stop_reason = 'tool_use';
                    } else if (chunk.candidates?.[0]?.finishReason === 'STOP' || chunk.candidates?.[0]?.finishReason === 'stop') {
                        // 修正 Gemini 原生格式的结束原因
                        chunk.candidates[0].finishReason = 'TOOL_CALLS';
                    }
                }

                // 防止重复发送结束标志
                // OpenAI: choices[].finish_reason
                // Claude: message_stop
                // OpenAI Responses: done
                // Gemini: candidates[].finishReason（如 STOP / MAX_TOKENS / SAFETY 等）
                if (
                    chunk?.choices?.some(choice => choice?.finish_reason) ||
                    chunk?.type === 'message_stop' ||
                    chunk?.type === 'done' ||
                    chunk?.candidates?.some(candidate => candidate?.finishReason)
                ) {
                    hasMessageStop = true;
                }

            // event 行与 data 行合并为一次写入，减少 write 调用与小包
                const ssePayload = addEvent
                    ? `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`
                    : `data: ${JSON.stringify(chunk)}\n\n`;
                const written = await safeStreamWriteChunk(res, ssePayload, clientDisconnected);
                if (written) {
                    anyDataSent = true;
                }
                if (clientDisconnected.value) {
                    break;
                }
                // logger.info(`data: ${JSON.stringify(chunk)}\n`);
            }
            }
        });

        // 上游流正常结束但一个字节都没发给客户端：这是「静默空响应」，不能算成功。
        // 直接抛出通用空响应错误，交给下面的 isEmptyUpstreamResponse 分支做小额重试；
        // 同时避免把实际没有产出的凭证标记为健康。
        // 客户端主动断开属于正常情况，不在此列。
        if (!anyDataSent && !clientDisconnected.value) {
            throw createEmptyUpstreamResponseError(customName ? `${toProvider}/${customName}` : toProvider);
        }

        // 流式请求成功完成，统计使用次数，错误次数重置为0
        if (providerPoolManager && pooluuid) {
            const customNameDisplay = customName ? `, ${customName}` : '';
            logger.info(`[Provider Pool] Increasing usage count for ${toProvider} (${pooluuid}${customNameDisplay}) after successful stream request`);
            providerPoolManager.markProviderHealthy(toProvider, {
                uuid: pooluuid
            });
        }

    }  catch (error) {
        streamFailed = true;
        // 如果客户端已主动断开（或触发了客户端中止信号），不惩罚账号、不重试、不写错误响应
        if (clientDisconnected.value || error?.isClientAbort || streamAbortController?.signal?.aborted) {
            clientDisconnected.value = true;
            logger.info('[Stream] Skipping provider penalty and error response due to client disconnect');
            responseClosed = true;
            return;
        }
        logger.error('\n[Server] Error during stream processing:', error.stack);
        
        // 如果已经发送了数据（包括 metadata），不进行重试（避免响应数据损坏或顺序错误）
        if (anyDataSent) {
            logger.info(`[Stream Retry] Cannot retry: data already sent to client`);
            // 直接发送错误并结束
            const errorPayload = createStreamErrorResponse(error, fromProvider);
            if (!res.writableEnded) {
                try {
                    res.write(errorPayload);
                    res.end();
                } catch (writeErr) {
                    logger.error('[Stream] Failed to write error response:', writeErr.message);
                }
            }
            responseClosed = true;
            return;
        }

        // 上游空响应（无文本/工具调用/思考内容）：使用独立的小额重试预算，
        // 不占用凭证切换预算（CREDENTIAL_SWITCH_MAX_RETRIES），重试沿用同一份 requestBody，
        // 不会让历史/token 变大。预算耗尽后直接返回明确错误，不再静默放行空的 end_turn。
        // 任何 provider 只要抛出带 isEmptyUpstreamResponse 标记的错误都会走到这个分支（目前 Kiro 在用）。
        if (error.isEmptyUpstreamResponse) {
            const attemptsMade = retryContext?.emptyResponseRetry ?? 0;
            const outcome = await resolveEmptyUpstreamResponseRetry(CONFIG, model, attemptsMade, '[Stream Retry]', toProvider);

            if (outcome.retry) {
                const { result, emptyResponseRetry } = outcome;
                const newRetryContext = {
                    ...retryContext,
                    CONFIG,
                    currentRetry,
                    maxRetries,
                    emptyResponseRetry,
                    clientDisconnected,
                    streamAbortController,
                    anyDataSent
                };

                return await handleStreamRequest(
                    res,
                    result.service,
                    result.actualModel || model,
                    requestBody,
                    fromProvider,
                    result.actualProviderType || toProvider,
                    PROMPT_LOG_MODE,
                    PROMPT_LOG_FILENAME,
                    providerPoolManager,
                    result.uuid,
                    result.serviceConfig?.customName || customName,
                    newRetryContext
                );
            }

            const giveUpError = new Error(`${toProvider} upstream returned an empty response after ${attemptsMade} retr${attemptsMade === 1 ? 'y' : 'ies'} with the same request. Please try again, or /clear your session if this keeps happening.`);
            giveUpError.status = 502;
            const errorPayload = createStreamErrorResponse(giveUpError, fromProvider);
            if (!clientDisconnected.value && !res.writableEnded) {
                try {
                    res.write(errorPayload);
                    res.end();
                } catch (writeErr) {
                    logger.error('[Stream] Failed to write error response:', writeErr.message);
                }
            }
            responseClosed = true;
            return;
        }
        
        // 获取状态码（用于日志记录，不再用于判断是否重试）
        const status = getErrorStatusCode(error);
        
        // 检查是否应该跳过错误计数（用于 429/5xx 等需要直接切换凭证的情况）
        const skipErrorCount = error.skipErrorCount === true;
        // 检查是否应该切换凭证（用于 429/5xx/402/403 等情况）
        const shouldSwitchCredential = error.shouldSwitchCredential === true;
        
        // 检查凭证是否已在底层被标记为不健康（避免重复标记）
        let credentialMarkedUnhealthy = error.credentialMarkedUnhealthy === true;

        const rateLimitRecoveryTime = getRateLimitCooldownRecoveryTime(error, CONFIG);
        const quotaRecoveryTime = getQuotaCooldownRecoveryTime(error, CONFIG);
        if (rateLimitRecoveryTime && providerPoolManager && pooluuid) {
            logger.info(`[Provider Pool] Applying 429 cooldown for ${toProvider} (${pooluuid}) until ${rateLimitRecoveryTime.toISOString()}`);
            providerPoolManager.markProviderUnhealthyWithRecoveryTime(toProvider, {
                uuid: pooluuid
            }, '429 Too Many Requests - short cooldown', rateLimitRecoveryTime);
            credentialMarkedUnhealthy = true;
        } else if (quotaRecoveryTime && providerPoolManager && pooluuid) {
            logger.info(`[Provider Pool] Applying 402 quota cooldown for ${toProvider} (${pooluuid}) until ${quotaRecoveryTime.toISOString()}`);
            providerPoolManager.markProviderUnhealthyWithRecoveryTime(toProvider, {
                uuid: pooluuid
            }, error.message || '402 Payment Required - quota cooldown', quotaRecoveryTime);
            credentialMarkedUnhealthy = true;
        }
        
        // 如果底层未标记，且不跳过错误计数，则在此处标记
        if (!credentialMarkedUnhealthy && !skipErrorCount && providerPoolManager && pooluuid) {
            const isGrokAuthFailure = toProvider === 'grok-web' && (
                status === 401 ||
                error.isDefinitiveAuthFailure === true ||
                (status === 403 && (
                    String(error.message || '').toLowerCase().includes('out of date') ||
                    String(error.message || '').toLowerCase().includes('reload to continue')
                ))
            );
            if (isGrokAuthFailure) {
                logger.warn(`[Provider Pool] Grok auth failure for ${toProvider} (${pooluuid}). Marking as needsRefresh: ${error.message}`);
                providerPoolManager.markProviderNeedRefresh(toProvider, { uuid: pooluuid });
                credentialMarkedUnhealthy = true;
            } else if (error.isDefinitiveAuthFailure === true || status === 401) {
                logger.warn(`[Provider Pool] Definitive auth failure for ${toProvider} (${pooluuid}). Marking as unhealthy immediately: ${error.message}`);
                providerPoolManager.markProviderUnhealthyImmediately(toProvider, { uuid: pooluuid }, error.message);
                credentialMarkedUnhealthy = true;
            } else if (status === 400 || error.response?.status === 400 || status === 404 || error.response?.status === 404) {
                // 400/404 报错码通常是请求参数或模型不存在等客户端问题，不记录为提供商错误，也不触发切号重试
                logger.info(`[Provider Pool] Skipping unhealthy marking for ${toProvider} (${pooluuid}) due to status ${status || error.response?.status} (client error)`);
            } else {
                logger.info(`[Provider Pool] Marking ${toProvider} as unhealthy due to stream error (status: ${status || 'unknown'})`);
                // 如果是号池模式，并且请求处理失败，则标记当前使用的提供者为不健康
                providerPoolManager.markProviderUnhealthy(toProvider, {
                    uuid: pooluuid
                }, error.message);
                credentialMarkedUnhealthy = true;
            }
        }
        
        // 如果需要切换凭证（无论是否标记不健康），都设置标记以触发重试
        if (shouldSwitchCredential && !credentialMarkedUnhealthy) {
            credentialMarkedUnhealthy = true; // 触发下面的重试逻辑
        }
        
        // 凭证已被标记为不健康后，尝试切换到新凭证重试
        // 不再依赖状态码判断，只要凭证被标记不健康且可以重试，就尝试切换
        if (credentialMarkedUnhealthy && currentRetry < maxRetries && providerPoolManager && CONFIG) {
            // 使用指数退避 + 抖动，避免过短或剧烈波动的等待时间
            const retryDelay = calculateRetryDelay(currentRetry, 1000, 8000);
            logger.info(`[Stream Retry] Credential marked unhealthy. Waiting ${retryDelay}ms before retry ${currentRetry + 1}/${maxRetries} with different credential...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            
            try {
                // 动态导入以避免循环依赖
                const { getApiServiceWithFallback } = await import('../services/service-manager.js');
                const prevExcludeUuids = Array.isArray(retryContext?.excludeUuids) ? retryContext.excludeUuids : [];
                const currentExcludeUuids = pooluuid ? [...new Set([...prevExcludeUuids, pooluuid])] : prevExcludeUuids;
                // 使用 acquireSlot: true 以占用新凭证的并发插槽，并排除已失败节点
                const result = await getApiServiceWithFallback(CONFIG, model, { acquireSlot: true, excludeUuids: currentExcludeUuids });
                
                if (result && result.service) {
                    logger.info(`[Stream Retry] Switched to new credential: ${result.uuid} (provider: ${result.actualProviderType})`);
                    
                    // 使用新服务重试
                    const newRetryContext = {
                        ...retryContext,
                        CONFIG,
                        currentRetry: currentRetry + 1,
                        maxRetries,
                        excludeUuids: currentExcludeUuids,
                        clientDisconnected,  // 传递断开状态
                        streamAbortController,
                        anyDataSent          // 传递数据发送状态
                    };
                    
                    // 递归调用，使用新的服务
                    return await handleStreamRequest(
                        res,
                        result.service,
                        result.actualModel || model,
                        requestBody,
                        fromProvider,
                        result.actualProviderType || toProvider,
                        PROMPT_LOG_MODE,
                        PROMPT_LOG_FILENAME,
                        providerPoolManager,
                        result.uuid,
                        result.serviceConfig?.customName || customName,
                        newRetryContext
                    );
                } else {
                    logger.info(`[Stream Retry] No healthy credential available for retry.`);
                }
            } catch (retryError) {
                logger.error(`[Stream Retry] Failed to get alternative service:`, retryError.message);
            }
        }

        // 使用新方法创建符合 fromProvider 格式的流式错误响应
        const errorPayload = createStreamErrorResponse(error, fromProvider);
        if (!clientDisconnected.value && !res.writableEnded && !res.finished && !res.destroyed) {
            try {
                res.write(errorPayload);
                res.end();
            } catch (writeErr) {
                logger.error('[Stream] Failed to write error response:', writeErr.message);
            }
        }
        responseClosed = true;
    } finally {
        // 释放并发插槽
        if (providerPoolManager && pooluuid) {
            providerPoolManager.releaseSlot(toProvider, pooluuid);
        }

        // 只在首次请求时移除事件监听器（避免重试时误删）
        if (!isRetry) {
            res.off('close', onClientClose);
            res.off('error', onClientError);
            // 确保移除特定监听器后保留静默错误处理器，防止流在关闭后产生异步 error 导致未捕获异常
            if (typeof res.listenerCount === 'function' && res.listenerCount('error') === 0) {
                res.on('error', (err) => {
                    logger.debug('[Stream] Post-closure response error absorbed:', err?.message || err);
                });
            }
        }
        
        // 只在非重试或重试失败时才发送结束标记
        // 如果是重试成功，递归调用会处理结束标记
        if (!responseClosed && !clientDisconnected.value && !isRetry) {
            // 根据客户端协议发送相应的流式结束标记
            const clientProtocol = getProtocolPrefix(fromProvider);
            if (!res.writableEnded && !res.finished && !res.destroyed) {
                try {
                    if (clientProtocol === MODEL_PROTOCOL_PREFIX.OPENAI) {
                        if (!hasMessageStop) {
                            res.write('data: [DONE]\n\n');
                            hasMessageStop = true;
                        }
                    } else if (clientProtocol === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES) {
                        // OpenAI Responses 以 response.completed/response.incomplete（或 error）作为结束事件。
                        // 连接关闭即表示流结束；不要再追加 `event: done` + `data: {}`，否则会触发下游类型校验失败（AI_TypeValidationError）。
                    } else if (clientProtocol === MODEL_PROTOCOL_PREFIX.CLAUDE) {
                        if (!hasMessageStop) {
                            res.write('event: message_stop\n');
                            res.write('data: {"type":"message_stop"}\n\n');
                            hasMessageStop = true;
                        }
                    } else if (clientProtocol === MODEL_PROTOCOL_PREFIX.GEMINI) {
                        if (!hasMessageStop) {
                            res.write('data: {"candidates":[{"finishReason":"STOP"}]}\n\n');
                            hasMessageStop = true;
                        }
                    }
                    if (!res.writableEnded && !res.finished && !res.destroyed) {
                        res.end();
                    }
                } catch (writeErr) {
                    logger.error('[Stream] Failed to write completion marker:', writeErr.message);
                }
            }
        }
        
        // 确保所有流式钩子已执行完毕，并在最外层通知插件流生命周期结束（消除盲猜定时器与残留缓存）
        await streamHookChain;
        if (!isRetry) {
            const hookRequestId = getPluginHookRequestId(CONFIG);
            if (hookRequestId) {
                try {
                    const pluginManager = getPluginManager();
                    if (pluginManager) {
                        await pluginManager.executeHook('onStreamEnd', {
                            requestId: hookRequestId,
                            fromProvider,
                            toProvider,
                            model,
                            completed: !streamFailed && !clientDisconnected.value,
                            aborted: clientDisconnected.value
                        });
                    }
                } catch (_) {}
            }
        }

        // 及时释放流式状态，防止异常断连导致内存残留
        try {
            const { streamStateManager } = await import('../providers/openai/responses-stream-state.js');
            if (typeof streamRequestId !== 'undefined') {
                streamStateManager.cleanup(streamRequestId);
            }
        } catch (_) {}

        // 只在首次请求时记录日志（避免重试时重复记录）
        if (!isRetry) {
            const fullResponseText = fullResponseTextChunks.join('');
            await logConversation('output', fullResponseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
        }
        // fs.writeFile('oldResponseChunk'+Date.now()+'.json', fullOldResponseJson);
        // fs.writeFile('responseChunk'+Date.now()+'.json', fullResponseJson);
    }
}


export async function handleUnaryRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, customName, retryContext = null) {
    // 重试上下文：包含 CONFIG 和重试计数
    // maxRetries: 凭证切换最大次数（跨凭证），默认 5 次
    const maxRetries = retryContext?.maxRetries ?? 5;
    const currentRetry = retryContext?.currentRetry ?? 0;
    const CONFIG = retryContext?.CONFIG;
    
    try{
        // The service returns the response in its native format (toProvider).
        const needsConversion = getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider);
        requestBody.model = model;
        // fs.writeFile('oldRequest'+Date.now()+'.json', JSON.stringify(requestBody));
        const nativeResponse = await service.generateContent(model, requestBody);
        
        // 如果提供者内部发生了模型回退（如 Antigravity 自动降级），同步更新本地 model 变量
        // 这确保了后续的监控钩子和统计插件记录的是实际使用的模型
        if (requestBody.model && requestBody.model !== model) {
            model = requestBody.model;
        }
        
        const responseText = extractResponseText(nativeResponse, toProvider);

        // 1. 检查上游是否因内容安全策略拦截了 Prompt (如 Google Gemini promptFeedback.blockReason)
        if (nativeResponse?.promptFeedback?.blockReason) {
            const blockReason = nativeResponse.promptFeedback.blockReason;
            const blockMessage = nativeResponse.promptFeedback.blockReasonMessage || `The prompt was blocked by upstream safety policy: ${blockReason}`;
            logger.warn(`[${toProvider}] Upstream blocked prompt by content policy: ${blockReason}. ${blockMessage}`);
            const policyError = new Error(`[${toProvider}] Request blocked by content policy: ${blockReason}. ${blockMessage}`);
            policyError.status = 400;
            policyError.code = 'content_filter';
            policyError.type = 'content_filter_error';
            policyError.isPromptBlocked = true;
            throw policyError;
        }

        // 2. 检查候选回复的结束原因是否为内容策略拦截
        const primaryCandidate = nativeResponse?.candidates?.[0];
        const candidateFinishReason = primaryCandidate?.finishReason;
        const isContentBlockedCandidate = candidateFinishReason && [
            'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MODEL_ARMOR'
        ].includes(String(candidateFinishReason).toUpperCase());

        // 3. 检查是否有实质内容（文本、工具调用、或思考过程）
        const codexOutput = nativeResponse?.response?.output || nativeResponse?.output || [];
        const hasContent = Boolean(responseText && responseText.trim().length > 0);
        const hasTools = Boolean(
            primaryCandidate?.content?.parts?.some(p => p.functionCall) ||
            nativeResponse?.functionCalls ||
            nativeResponse?.tool_calls ||
            nativeResponse?.choices?.[0]?.message?.tool_calls?.length > 0 ||
            (Array.isArray(nativeResponse?.content) && nativeResponse.content.some(c => c.type === 'tool_use')) ||
            (Array.isArray(codexOutput) && codexOutput.some(item => item.type === 'function_call'))
        );
        const hasReasoning = Boolean(
            primaryCandidate?.content?.parts?.some(p => p.thought || (p.text && p.thought === true)) ||
            nativeResponse?.choices?.[0]?.message?.reasoning_content ||
            (Array.isArray(nativeResponse?.content) && nativeResponse.content.some(c => c.type === 'thinking')) ||
            (Array.isArray(codexOutput) && codexOutput.some(item => item.type === 'reasoning'))
        );

        if (!hasContent && !hasTools && !hasReasoning) {
            if (isContentBlockedCandidate) {
                logger.warn(`[${toProvider}] Upstream candidate blocked by content policy: ${candidateFinishReason}.`);
                const policyError = new Error(`[${toProvider}] Response blocked by content policy: ${candidateFinishReason}`);
                policyError.status = 400;
                policyError.code = 'content_filter';
                policyError.type = 'content_filter_error';
                policyError.isPromptBlocked = true;
                throw policyError;
            }
            logger.warn(`[${toProvider}] Upstream returned empty response (no text, tools, or reasoning) in unary request.`);
            throw createEmptyUpstreamResponseError(customName ? `${toProvider}/${customName}` : toProvider);
        }

        // Convert the response back to the client's format (fromProvider), if necessary.
        let clientResponse = nativeResponse;
        if (needsConversion) {
            logger.info(`[Response Convert] Converting response from ${toProvider} to ${fromProvider}`);
            clientResponse = convertData(nativeResponse, 'response', toProvider, fromProvider, model);
        }

        // 监控钩子：非流式响应
        const hookRequestId = getPluginHookRequestId(CONFIG);
        if (hookRequestId) {
            try {
                const pluginManager = getPluginManager();
                await pluginManager.executeHook('onUnaryResponse', {
                    nativeResponse,
                    clientResponse,
                    fromProvider,
                    toProvider,
                    model,
                    requestId: hookRequestId
                });
            } catch (e) {}
        }

        //logger.info(`[Response] Sending response to client: ${JSON.stringify(clientResponse)}`);
        await handleUnifiedResponse(res, JSON.stringify(clientResponse), false);
        await logConversation('output', responseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
        // fs.writeFile('oldResponse'+Date.now()+'.json', JSON.stringify(clientResponse));
        
        // 一元请求成功完成，统计使用次数，错误次数重置为0
        if (providerPoolManager && pooluuid) {
            const customNameDisplay = customName ? `, ${customName}` : '';
            logger.info(`[Provider Pool] Increasing usage count for ${toProvider} (${pooluuid}${customNameDisplay}) after successful unary request`);
            providerPoolManager.markProviderHealthy(toProvider, {
                uuid: pooluuid
            });
        }
    } catch (error) {
        if (error?.isClientAbort || requestContext.get('upstreamAbortSignal')?.aborted) {
            logger.info('[Unary] Client disconnected prematurely, skipping provider penalty and retry');
            return;
        }
        logger.error('\n[Server] Error during unary processing:', error.stack);

        // 上游空响应（无文本/工具调用/思考内容）：使用独立的小额重试预算，
        // 不占用凭证切换预算（CREDENTIAL_SWITCH_MAX_RETRIES），重试沿用同一份 requestBody，
        // 不会让历史/token 变大。预算耗尽后直接返回明确错误，不再静默放行空响应。
        // 任何 provider 只要抛出带 isEmptyUpstreamResponse 标记的错误都会走到这个分支（目前 Kiro 在用）。
        if (error.isEmptyUpstreamResponse) {
            const attemptsMade = retryContext?.emptyResponseRetry ?? 0;
            const outcome = await resolveEmptyUpstreamResponseRetry(CONFIG, model, attemptsMade, '[Unary Retry]', toProvider);

            if (outcome.retry) {
                const { result, emptyResponseRetry } = outcome;
                const newRetryContext = {
                    ...retryContext,
                    CONFIG,
                    currentRetry,
                    maxRetries,
                    emptyResponseRetry
                };

                return await handleUnaryRequest(
                    res,
                    result.service,
                    result.actualModel || model,
                    requestBody,
                    fromProvider,
                    result.actualProviderType || toProvider,
                    PROMPT_LOG_MODE,
                    PROMPT_LOG_FILENAME,
                    providerPoolManager,
                    result.uuid,
                    result.serviceConfig?.customName || customName,
                    newRetryContext
                );
            }

            const giveUpError = new Error(`${toProvider} upstream returned an empty response after ${attemptsMade} retr${attemptsMade === 1 ? 'y' : 'ies'} with the same request. Please try again, or /clear your session if this keeps happening.`);
            giveUpError.status = 502;
            const errorResponse = createErrorResponse(giveUpError, fromProvider);
            await handleUnifiedResponse(res, JSON.stringify(errorResponse), false, 502);
            return;
        }
        
        // 获取状态码（用于日志记录，不再用于判断是否重试）
        const status = getErrorStatusCode(error);
        
        // 检查是否应该跳过错误计数（用于 429/5xx 等需要直接切换凭证的情况）
        const skipErrorCount = error.skipErrorCount === true;
        // 检查是否应该切换凭证（用于 429/5xx/402/403 等情况）
        const shouldSwitchCredential = error.shouldSwitchCredential === true;
        
        // 检查凭证是否已在底层被标记为不健康（避免重复标记）
        let credentialMarkedUnhealthy = error.credentialMarkedUnhealthy === true;

        const rateLimitRecoveryTime = getRateLimitCooldownRecoveryTime(error, CONFIG);
        const quotaRecoveryTime = getQuotaCooldownRecoveryTime(error, CONFIG);
        if (rateLimitRecoveryTime && providerPoolManager && pooluuid) {
            logger.info(`[Provider Pool] Applying 429 cooldown for ${toProvider} (${pooluuid}) until ${rateLimitRecoveryTime.toISOString()}`);
            providerPoolManager.markProviderUnhealthyWithRecoveryTime(toProvider, {
                uuid: pooluuid
            }, '429 Too Many Requests - short cooldown', rateLimitRecoveryTime);
            credentialMarkedUnhealthy = true;
        } else if (quotaRecoveryTime && providerPoolManager && pooluuid) {
            logger.info(`[Provider Pool] Applying 402 quota cooldown for ${toProvider} (${pooluuid}) until ${quotaRecoveryTime.toISOString()}`);
            providerPoolManager.markProviderUnhealthyWithRecoveryTime(toProvider, {
                uuid: pooluuid
            }, error.message || '402 Payment Required - quota cooldown', quotaRecoveryTime);
            credentialMarkedUnhealthy = true;
        }
        
        // 如果底层未标记，且不跳过错误计数，则在此处标记
        if (!credentialMarkedUnhealthy && !skipErrorCount && providerPoolManager && pooluuid) {
            const isGrokAuthFailure = toProvider === 'grok-web' && (
                status === 401 ||
                error.isDefinitiveAuthFailure === true ||
                (status === 403 && (
                    String(error.message || '').toLowerCase().includes('out of date') ||
                    String(error.message || '').toLowerCase().includes('reload to continue')
                ))
            );
            if (isGrokAuthFailure) {
                logger.warn(`[Provider Pool] Grok auth failure for ${toProvider} (${pooluuid}). Marking as needsRefresh: ${error.message}`);
                providerPoolManager.markProviderNeedRefresh(toProvider, { uuid: pooluuid });
                credentialMarkedUnhealthy = true;
            } else if (error.isDefinitiveAuthFailure === true || status === 401) {
                logger.warn(`[Provider Pool] Definitive auth failure for ${toProvider} (${pooluuid}). Marking as unhealthy immediately: ${error.message}`);
                providerPoolManager.markProviderUnhealthyImmediately(toProvider, { uuid: pooluuid }, error.message);
                credentialMarkedUnhealthy = true;
            } else if (status === 400 || error.response?.status === 400 || status === 404 || error.response?.status === 404) {
                // 400/404 报错码通常是请求参数或模型不存在等客户端问题，不记录为提供商错误，也不触发切号重试
                logger.info(`[Provider Pool] Skipping unhealthy marking for ${toProvider} (${pooluuid}) due to status ${status || error.response?.status} (client error)`);
            } else {
                logger.info(`[Provider Pool] Marking ${toProvider} as unhealthy due to unary error (status: ${status || 'unknown'})`);
                // 如果是号池模式，并且请求处理失败，则标记当前使用的提供者为不健康
                providerPoolManager.markProviderUnhealthy(toProvider, {
                    uuid: pooluuid
                }, error.message);
                credentialMarkedUnhealthy = true;
            }
        }
        
        // 如果需要切换凭证（无论是否标记不健康），都设置标记以触发重试
        if (shouldSwitchCredential && !credentialMarkedUnhealthy) {
            credentialMarkedUnhealthy = true; // 触发下面的重试逻辑
        }
        
        // 凭证已被标记为不健康后，尝试切换到新凭证重试
        // 不再依赖状态码判断，只要凭证被标记不健康且可以重试，就尝试切换
        if (credentialMarkedUnhealthy && currentRetry < maxRetries && providerPoolManager && CONFIG) {
            // 使用指数退避 + 抖动，避免过短或剧烈波动的等待时间
            const retryDelay = calculateRetryDelay(currentRetry, 1000, 8000);
            logger.info(`[Unary Retry] Credential marked unhealthy. Waiting ${retryDelay}ms before retry ${currentRetry + 1}/${maxRetries} with different credential...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            
            try {
                // 动态导入以避免循环依赖
                const { getApiServiceWithFallback } = await import('../services/service-manager.js');
                const prevExcludeUuids = Array.isArray(retryContext?.excludeUuids) ? retryContext.excludeUuids : [];
                const currentExcludeUuids = pooluuid ? [...new Set([...prevExcludeUuids, pooluuid])] : prevExcludeUuids;
                // 使用 acquireSlot: true 以占用新凭证的并发插槽，并排除已失败节点
                const result = await getApiServiceWithFallback(CONFIG, model, { acquireSlot: true, excludeUuids: currentExcludeUuids });
                
                if (result && result.service) {
                    logger.info(`[Unary Retry] Switched to new credential: ${result.uuid} (provider: ${result.actualProviderType})`);
                    
                    // 使用新服务重试
                    const newRetryContext = {
                        ...retryContext,
                        CONFIG,
                        currentRetry: currentRetry + 1,
                        maxRetries,
                        excludeUuids: currentExcludeUuids
                    };
                    
                    // 递归调用，使用新的服务
                    return await handleUnaryRequest(
                        res,
                        result.service,
                        result.actualModel || model,
                        requestBody,
                        fromProvider,
                        result.actualProviderType || toProvider,
                        PROMPT_LOG_MODE,
                        PROMPT_LOG_FILENAME,
                        providerPoolManager,
                        result.uuid,
                        result.serviceConfig?.customName || customName,
                        newRetryContext
                    );
                } else {
                    logger.info(`[Unary Retry] No healthy credential available for retry.`);
                }
            } catch (retryError) {
                logger.error(`[Unary Retry] Failed to get alternative service:`, retryError.message);
            }
        }

        // 使用新方法创建符合 fromProvider 格式的错误响应
        const errorResponse = createErrorResponse(error, fromProvider);
        const rawStatusCode = error.status || error.code || (error.response && error.response.status) || 500;
        const statusCode = ensureValidStatusCode(rawStatusCode);
        await handleUnifiedResponse(res, JSON.stringify(errorResponse), false, statusCode);
    } finally {
        // 确保在请求结束或出错时释放插槽
        if (providerPoolManager && pooluuid) {
            providerPoolManager.releaseSlot(toProvider, pooluuid);
        }
    }
}

/**
 * Handles requests for content generation (both unary and streaming). This function
 * orchestrates request body parsing, conversion to the internal Gemini format,
 * logging, and dispatching to the appropriate stream or unary handler.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {http.ServerResponse} res The HTTP response object.
 * @param {string} endpointType The type of endpoint being called (e.g., OPENAI_CHAT).
 * @param {Object} CONFIG - The server configuration object.
 * @param {string} PROMPT_LOG_FILENAME - The prompt log filename.
 */
export async function handleContentGenerationRequest(req, res, service, endpointType, CONFIG, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, requestPath = null) {
    const originalRequestBody = await getRequestBody(req, { maxBytes: CONFIG.REQUEST_BODY_MAX_BYTES });

    if (!originalRequestBody) {
        throw new Error("Request body is missing for content generation.");
    }

    const clientProviderMap = {
        [ENDPOINT_TYPE.OPENAI_CHAT]: MODEL_PROTOCOL_PREFIX.OPENAI,
        [ENDPOINT_TYPE.OPENAI_RESPONSES]: MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES,
        [ENDPOINT_TYPE.CLAUDE_MESSAGE]: MODEL_PROTOCOL_PREFIX.CLAUDE,
        [ENDPOINT_TYPE.GEMINI_CONTENT]: MODEL_PROTOCOL_PREFIX.GEMINI,
    };

    const fromProvider = clientProviderMap[endpointType];
    // 使用实际的提供商类型（可能是 fallback 后的类型）
    let toProvider = CONFIG.actualProviderType || CONFIG.MODEL_PROVIDER;
    let actualUuid = pooluuid;
    
    if (!fromProvider) {
        throw new Error(`Unsupported endpoint type for content generation: ${endpointType}`);
    }

    // 2. Extract model and determine if the request is for streaming.
    let { model, isStream } = _extractModelAndStreamInfo(req, originalRequestBody, fromProvider);

    if (!model) {
        throw new Error("Could not determine the model from the request.");
    }
    
    // 2.1. 处理自定义模型映射和别名
    const customModelConfig = getCustomModelConfig(model, CONFIG.MODEL_PROVIDER);
    CONFIG.customConfig = customModelConfig || null;
    if (customModelConfig) {
        const customRouting = resolveCustomModelRouting(model, CONFIG.MODEL_PROVIDER, customModelConfig);
        logger.info(`[Custom Model] Resolved '${model}' to actual model '${customRouting.actualModel}'`);
        
        if (customRouting.actualProvider && customRouting.actualProvider !== CONFIG.MODEL_PROVIDER) {
            CONFIG.MODEL_PROVIDER = customRouting.actualProvider;
            toProvider = customRouting.actualProvider;
            logger.info(`[Custom Model] Switched provider to '${CONFIG.MODEL_PROVIDER}' based on custom model config`);
        }

        // 映射到实际模型 ID
        if (customRouting.actualModel) {
            model = customRouting.actualModel;
        }
    }

    logger.info(`[Content Generation] Model: ${model}, Stream: ${isStream}`);

    let actualCustomName = CONFIG.customName;

    // 2.5. 根据模型选择服务适配器：
    // - service 缺失时（例如上游未预先注入）进行兜底选择
    // - 使用号池/AUTO 时按模型重选并支持 fallback
    // 注意：仅在号池场景开启 acquireSlot，占用并发名额或进入队列
    const shouldSelectByPool = providerPoolManager && (CONFIG.MODEL_PROVIDER === MODEL_PROVIDER.AUTO || (CONFIG.providerPools && CONFIG.providerPools[CONFIG.MODEL_PROVIDER]));
    if (!service || shouldSelectByPool) {
        const { getApiServiceWithFallback } = await import('../services/service-manager.js');
        const result = await getApiServiceWithFallback(CONFIG, model, { acquireSlot: shouldSelectByPool });

        service = result.service;
        toProvider = result.actualProviderType;
        actualUuid = result.uuid || pooluuid;
        actualCustomName = result.serviceConfig?.customName || CONFIG.customName;

        // 如果发生了模型级别的 fallback，需要更新请求使用的模型
        if (result.actualModel && result.actualModel !== model) {
            logger.info(`[Content Generation] Model Fallback: ${model} -> ${result.actualModel}`);
            model = result.actualModel;
        }

        if (result.isFallback) {
            logger.info(`[Content Generation] Fallback activated: ${CONFIG.MODEL_PROVIDER} -> ${toProvider} (uuid: ${actualUuid})`);
        } else {
            logger.info(`[Content Generation] Selected service adapter based on model: ${model}`);
        }
    }

    // 1. Convert request body from client format to backend format, if necessary.
    // 使用浅拷贝以避免直接变异 originalRequestBody，保持原始数据的纯净性以供后续钩子使用
    let processedRequestBody = { ...originalRequestBody };

    // 将 _monitorRequestId 注入到 requestBody 中，以便在 service 内部访问
    if (CONFIG._monitorRequestId) {
        processedRequestBody._monitorRequestId = CONFIG._monitorRequestId;
    }
    
    // 将 requestBaseUrl 注入到 requestBody 中，以便在转换器中使用
    if (CONFIG.requestBaseUrl) {
        processedRequestBody._requestBaseUrl = CONFIG.requestBaseUrl;
    }

    // fs.writeFile('originalRequestBody'+Date.now()+'.json', JSON.stringify(originalRequestBody));
    if (getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider)) {
        logger.info(`[Request Convert] Converting request from ${fromProvider} to ${toProvider}`);
        const preConvertBody = processedRequestBody;
        processedRequestBody = convertData(preConvertBody, 'request', fromProvider, toProvider);

        // 保持以 _ 开头的内部属性（如 _monitorRequestId, _requestBaseUrl）及生图专用参数
        ['aspect_ratio', 'aspectRatio', 'resolution', 'quality', 'size'].forEach(key => {
            if (preConvertBody[key] !== undefined && processedRequestBody[key] === undefined) {
                processedRequestBody[key] = preConvertBody[key];
            }
        });
        Object.keys(preConvertBody).forEach(key => {
            if (key.startsWith('_') && processedRequestBody[key] === undefined) {
                processedRequestBody[key] = preConvertBody[key];
            }
        });
    } else {
        logger.info(`[Request Convert] Request format matches backend provider. No conversion needed.`);
    }
    
    // 为 forward provider 添加原始请求路径作为 endpoint
    if (requestPath && getProtocolPrefix(toProvider) === MODEL_PROTOCOL_PREFIX.FORWARD) {
        logger.info(`[Forward API] Request path: ${requestPath}`);
        processedRequestBody.endpoint = requestPath;
    }

    // 3. Apply system prompt from file if configured.
    processedRequestBody = await _applySystemPromptFromFile(CONFIG, processedRequestBody, toProvider);
    await _manageSystemPrompt(processedRequestBody, toProvider);

    // 4. Log the incoming prompt (after potential conversion to the backend's format).
    const promptText = extractPromptText(processedRequestBody, toProvider);
    
    // 4.1. 应用自定义模型参数 (温度、最大长度等)
    if (customModelConfig) {
        _applyCustomModelParameters(processedRequestBody, customModelConfig, toProvider);
    }

    await logConversation('input', promptText, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
    
    // 5. Call the appropriate stream or unary handler, passing the provider info.
    // 创建重试上下文，包含 CONFIG 以便在认证错误时切换凭证重试
    // 凭证切换重试次数（默认 5），可在配置中自定义更大的值
    // 注意：这与底层的 429/5xx 重试（REQUEST_MAX_RETRIES）是不同层次的重试机制
    // - 底层重试：同一凭证遇到 429/5xx 时的重试
    // - 凭证切换重试：凭证被标记不健康后切换到其他凭证
    // 当没有不同的健康凭证可用时，重试会自动停止
    const credentialSwitchMaxRetries = CONFIG.CREDENTIAL_SWITCH_MAX_RETRIES || 5;
    const retryContext = { CONFIG, currentRetry: 0, maxRetries: credentialSwitchMaxRetries };
    
    if (isStream) {
        await handleStreamRequest(res, service, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, actualUuid, actualCustomName, retryContext);
    } else {
        await handleUnaryRequest(res, service, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, actualUuid, actualCustomName, retryContext);
    }

    // 同步更新模型名称（如果处理器内部或提供者发生了回退）
    if (processedRequestBody.model && processedRequestBody.model !== model) {
        model = processedRequestBody.model;
    }

    // 执行插件钩子：内容生成后
    try {
        const pluginManager = getPluginManager();
        await pluginManager.executeHook('onContentGenerated', {
            ...CONFIG,
            originalRequestBody,
            processedRequestBody,
            fromProvider,
            toProvider,
            model,
            isStream
        });
    } catch (e) { /* 静默失败，不影响主流程 */ }
}

/**
 * Helper function to extract model and stream information from the request.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {Object} requestBody The parsed request body.
 * @param {string} fromProvider The type of endpoint being called.
 * @returns {{model: string, isStream: boolean}} An object containing the model name and stream status.
 */
function _extractModelAndStreamInfo(req, requestBody, fromProvider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(fromProvider));
    return strategy.extractModelAndStreamInfo(req, requestBody);
}

async function _applySystemPromptFromFile(config, requestBody, toProvider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(toProvider));
    return strategy.applySystemPromptFromFile(config, requestBody);
}

export async function _manageSystemPrompt(requestBody, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    await strategy.manageSystemPrompt(requestBody);
}

// Helper functions for content extraction and conversion (from convert.js, but needed here)
export function extractResponseText(response, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    return strategy.extractResponseText(response);
}

export function extractPromptText(requestBody, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    return strategy.extractPromptText(requestBody);
}

/**
 * 应用自定义模型参数到请求体
 * @param {Object} requestBody - 处理后的请求体
 * @param {Object} customConfig - 自定义模型配置
 * @param {string} provider - 目标提供商
 */
function _applyCustomModelParameters(requestBody, customConfig, provider) {
    const protocol = getProtocolPrefix(provider);
    const hasConfiguredValue = (value) => value !== undefined && value !== null;

    // 参数映射表
    const mappings = {
        temperature: {
            [MODEL_PROTOCOL_PREFIX.OPENAI]: 'temperature',
            [MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]: 'temperature',
            [MODEL_PROTOCOL_PREFIX.CLAUDE]: 'temperature',
            [MODEL_PROTOCOL_PREFIX.GEMINI]: 'generationConfig.temperature'
        },
        maxTokens: {
            [MODEL_PROTOCOL_PREFIX.OPENAI]: 'max_tokens',
            [MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]: 'max_output_tokens',
            [MODEL_PROTOCOL_PREFIX.CLAUDE]: 'max_tokens',
            [MODEL_PROTOCOL_PREFIX.GEMINI]: 'generationConfig.maxOutputTokens'
        },
        topP: {
            [MODEL_PROTOCOL_PREFIX.OPENAI]: 'top_p',
            [MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]: 'top_p',
            [MODEL_PROTOCOL_PREFIX.CLAUDE]: 'top_p',
            [MODEL_PROTOCOL_PREFIX.GEMINI]: 'generationConfig.topP'
        }
    };

    // 处理嵌套路径 (例如 generationConfig.temperature)
    const setNestedProperty = (obj, path, value) => {
        const parts = path.split('.');
        let curr = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            if (!curr[parts[i]]) curr[parts[i]] = {};
            curr = curr[parts[i]];
        }
        curr[parts[parts.length - 1]] = value;
        logger.debug(`[Custom Model] Applied nested parameter ${path}=${value}`);
    };

    // 应用配置
    Object.keys(mappings).forEach(key => {
        const value = customConfig[key];
        const targetPath = mappings[key][protocol];
        
        if (hasConfiguredValue(value) && targetPath) {
            if (targetPath.includes('.')) {
                setNestedProperty(requestBody, targetPath, value);
            } else {
                requestBody[targetPath] = value;
                logger.debug(`[Custom Model] Applied ${key}=${value} to request (${targetPath})`);
            }
        }
    });

    // 处理特殊的 contextLength (通常不直接发给 API，但可能被某些插件使用)
    // if (hasConfiguredValue(customConfig.contextLength)) {
    //     requestBody._contextLength = customConfig.contextLength;
    // }
}

/**
 * 从请求体中提取系统提示词。
 * @param {Object} requestBody - 请求体对象。
 * @param {string} provider - 提供商类型（'openai', 'gemini', 'claude'）。
 * @returns {string} 提取到的系统提示词字符串。
 */
export function extractSystemPromptFromRequestBody(requestBody, provider) {
    let incomingSystemText = '';
    switch (provider) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            const openaiSystemMessage = requestBody.messages?.find(m => m.role === 'system' || m.role === 'developer');
            if (openaiSystemMessage?.content) {
                incomingSystemText = openaiSystemMessage.content;
            } else if (requestBody.messages?.length > 0) {
                // Fallback to first user message if no system message
                const userMessage = requestBody.messages.find(m => m.role === 'user');
                if (userMessage) {
                    incomingSystemText = userMessage.content;
                }
            }
            if (typeof incomingSystemText === 'object' && incomingSystemText !== null) {
                if (Array.isArray(incomingSystemText)) {
                    incomingSystemText = incomingSystemText
                        .map(item => (typeof item === 'string' ? item : item.text || JSON.stringify(item)))
                        .join('\n');
                } else {
                    incomingSystemText = JSON.stringify(incomingSystemText);
                }
            }
            break;
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            const geminiSystemInstruction = requestBody.system_instruction || requestBody.systemInstruction;
            if (geminiSystemInstruction?.parts) {
                incomingSystemText = geminiSystemInstruction.parts
                    .filter(p => p?.text)
                    .map(p => p.text)
                    .join('\n');
            } else if (requestBody.contents?.length > 0) {
                // Fallback to first user content if no system instruction
                const userContent = requestBody.contents[0];
                if (userContent?.parts) {
                    incomingSystemText = userContent.parts
                        .filter(p => p?.text)
                        .map(p => p.text)
                        .join('\n');
                }
            }
            break;
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            if (typeof requestBody.system === 'string') {
                incomingSystemText = requestBody.system;
            } else if (typeof requestBody.system === 'object') {
                incomingSystemText = JSON.stringify(requestBody.system);
            } else if (requestBody.messages?.length > 0) {
                // Fallback to first user message if no system property
                const userMessage = requestBody.messages.find(m => m.role === 'user');
                if (userMessage) {
                    if (Array.isArray(userMessage.content)) {
                        incomingSystemText = userMessage.content.map(block => block.text).join('');
                    } else {
                        incomingSystemText = userMessage.content;
                    }
                }
            }
            break;
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES: {
            if (typeof requestBody.instructions === 'string') {
                incomingSystemText = requestBody.instructions;
            } else if (requestBody.instructions) {
                incomingSystemText = JSON.stringify(requestBody.instructions);
            } else if (Array.isArray(requestBody.input)) {
                const responsesSystemItem = requestBody.input.find(item =>
                    item?.role === 'system' ||
                    item?.role === 'developer' ||
                    item?.type === 'system' ||
                    item?.type === 'developer' ||
                    (item?.type === 'message' && (item?.role === 'system' || item?.role === 'developer'))
                );

                const content = responsesSystemItem?.content;
                if (typeof content === 'string') {
                    incomingSystemText = content;
                } else if (Array.isArray(content)) {
                    incomingSystemText = content
                        .map(part => typeof part === 'string' ? part : (part?.text || part?.content || JSON.stringify(part)))
                        .join('\n');
                } else if (content) {
                    incomingSystemText = JSON.stringify(content);
                }
            }
            break;
        }
        default:
            logger.warn(`[System Prompt] Unknown provider: ${provider}`);
            break;
    }
    return incomingSystemText;
}

/**
 * Generates an MD5 hash for a given object by first converting it to a JSON string.
 * @param {object} obj - The object to hash.
 * @returns {string} The MD5 hash of the object's JSON string representation.
 */
export function getMD5Hash(obj) {
    const jsonString = JSON.stringify(obj);
    return crypto.createHash('md5').update(jsonString).digest('hex');
}

/**
 * 将日期转换为系统本地时间格式
 * @param {string|number} dateInput - 日期字符串或时间戳
 * @returns {string} 格式化后的时间字符串
 */
export function formatToLocal(dateInput) {
    try {
        if (!dateInput) return '--';
        // 处理数值型时间戳（秒 -> 毫秒）
        let finalInput = dateInput;
        if (typeof dateInput === 'number' && dateInput < 10000000000) {
            finalInput = dateInput * 1000;
        }
        const date = new Date(finalInput);
        if (isNaN(date.getTime())) return '--';
        
        return date.toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).replace(/\//g, '-');
    } catch (e) {
        return '--';
    }
}
