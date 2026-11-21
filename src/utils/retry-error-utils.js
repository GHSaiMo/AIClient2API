import logger from './logger.js';
import { MODEL_PROTOCOL_PREFIX } from './constants.js';
import { getProtocolPrefix } from './protocol-utils.js';

/**
 * 可重试的网络错误标识列表
 * 这些错误可能出现在 error.code 或 error.message 中
 */
export const RETRYABLE_NETWORK_ERRORS = [
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ENOTFOUND',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'EPIPE',
    'EAI_AGAIN',
    'ECONNABORTED',
    'ESOCKETTIMEDOUT',
    'ERR_STREAM_WRITE_AFTER_END',
    'ERR_STREAM_DESTROYED',
    'ERR_STREAM_PREMATURE_CLOSE',
    'ERR_STREAM_ALREADY_FINISHED',
    'ERR_HTTP_HEADERS_SENT',
    'ECANCELED',
    'UND_ERR_SOCKET',
    'UND_ERR_ABORTED',
];

export const RETRYABLE_NETWORK_ERRORS_SET = new Set(RETRYABLE_NETWORK_ERRORS);

/**
 * 检查是否为可重试的网络错误
 */
export function isRetryableNetworkError(error) {
    if (!error) return false;

    const errorCode = error.code || error.cause?.code || '';
    if (errorCode && RETRYABLE_NETWORK_ERRORS_SET.has(errorCode)) {
        return true;
    }

    const errorMessage = error.message || error.cause?.message || (typeof error === 'string' ? error : '');
    if (!errorMessage) return false;

    return RETRYABLE_NETWORK_ERRORS.some(err => errorMessage.includes(err));
}

/**
 * 确保状态码是有效的 HTTP 状态码
 */
export function ensureValidStatusCode(code) {
    const num = parseInt(code, 10);
    if (!isNaN(num) && num >= 100 && num < 600) {
        return num;
    }
    return 500;
}

export function getErrorStatusCode(error) {
    return error?.response?.status || error?.status || error?.statusCode || error?.code || null;
}

function getHttpStatusLabel(status) {
    switch (status) {
        case 400: return 'Bad Request';
        case 401: return 'Unauthorized';
        case 402: return 'Payment Required';
        case 403: return 'Forbidden';
        case 404: return 'Not Found';
        case 408: return 'Request Timeout';
        case 409: return 'Conflict';
        case 422: return 'Unprocessable Entity';
        case 429: return 'Too Many Requests';
        case 500: return 'Internal Server Error';
        case 502: return 'Bad Gateway';
        case 503: return 'Service Unavailable';
        case 504: return 'Gateway Timeout';
        default: return 'HTTP Error';
    }
}

function extractReadableErrorText(data) {
    if (data === undefined || data === null) return '';
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');

    if (Array.isArray(data)) {
        return data
            .map(item => extractReadableErrorText(item))
            .filter(Boolean)
            .join(' | ');
    }

    if (typeof data !== 'object') {
        return String(data);
    }

    const directFields = [
        data.message,
        data.error_description,
        data.description,
        data.detail,
        data.reason,
        data.msg
    ].filter(value => typeof value === 'string' && value.trim());

    if (directFields.length > 0) {
        return directFields.join(' | ');
    }

    if (typeof data.error === 'string' && data.error.trim()) {
        return data.error;
    }

    if (data.error && typeof data.error === 'object') {
        const nestedError = extractReadableErrorText(data.error);
        if (nestedError) return nestedError;
    }

    if (Array.isArray(data.details)) {
        const detailText = data.details
            .map(detail => extractReadableErrorText(detail))
            .filter(Boolean)
            .join(' | ');
        if (detailText) return detailText;
    }

    if (data.metadata && typeof data.metadata === 'object') {
        const metadataText = extractReadableErrorText(data.metadata);
        if (metadataText) return metadataText;
    }

    try {
        return JSON.stringify(data);
    } catch {
        return String(data);
    }
}

export async function getNormalizedErrorResponseText(error) {
    const data = error?.response?.data;
    const fallbackText = extractReadableErrorText(data) || error?.message || '';

    if (!data || typeof data?.on !== 'function' || typeof data?.read !== 'function') {
        return fallbackText;
    }

    const chunks = [];
    try {
        for await (const chunk of data) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }

        const bodyText = Buffer.concat(chunks).toString('utf8');
        if (!bodyText) return fallbackText;

        try {
            const parsed = JSON.parse(bodyText);
            return extractReadableErrorText(parsed) || bodyText;
        } catch {
            return bodyText;
        }
    } catch (readError) {
        logger.warn(`[Error Normalize] Failed to read error response stream: ${readError.message}`);
        return fallbackText;
    }
}

export function buildHttpErrorReason(status, context, responseText = '', options = {}) {
    const statusLabel = getHttpStatusLabel(status);
    const responseSnippet = responseText ? responseText.substring(0, 500) : '';
    const suffix = options.suffix ? ` - ${options.suffix}` : '';
    const prefix = status ? `${status} ${statusLabel}` : statusLabel;
    return `${prefix}${context ? ` (${context})` : ''}${suffix}${responseSnippet ? `: ${responseSnippet}` : ''}`;
}

export async function normalizeProviderErrorMessage(error, options = {}) {
    const status = options.status ?? getErrorStatusCode(error);
    const responseText = await getNormalizedErrorResponseText(error);
    const reason = buildHttpErrorReason(status, options.context || '', responseText, {
        suffix: options.suffix || ''
    });
    error.message = reason;
    return { responseText, reason, status };
}

function getHeaderValue(headers, headerName) {
    if (!headers) return null;

    if (typeof headers.get === 'function') {
        return headers.get(headerName) || headers.get(headerName.toLowerCase());
    }

    const lowerName = headerName.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === lowerName) {
            return Array.isArray(value) ? value[0] : value;
        }
    }

    return null;
}

function parseRetryAfterMs(value, now = Date.now()) {
    if (value === null || value === undefined) return null;

    const rawValue = Array.isArray(value) ? value[0] : value;
    const text = String(rawValue).trim();
    if (!text) return null;

    const seconds = Number(text);
    if (Number.isFinite(seconds)) {
        return Math.max(0, Math.round(seconds * 1000));
    }

    const dateMs = Date.parse(text);
    if (!Number.isNaN(dateMs)) {
        return Math.max(0, dateMs - now);
    }

    return null;
}

function parseDurationMs(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));

    const text = String(value).trim();
    const match = text.match(/^([\d.]+)\s*(ms|s)?$/i);
    if (!match) return null;

    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return null;

    return Math.max(0, Math.round(match[2]?.toLowerCase() === 's' ? amount * 1000 : amount));
}

function getRetryDelayFromBody(errorBody) {
    try {
        const data = typeof errorBody === 'string' ? JSON.parse(errorBody) : errorBody;

        const directDelay = parseDurationMs(data?.retryDelay ?? data?.retry_delay ?? data?.retryAfterMs);
        if (directDelay !== null) return directDelay;

        const details = data?.error?.details;
        if (Array.isArray(details)) {
            for (const detail of details) {
                const retryDelay = parseDurationMs(detail?.retryDelay || detail?.metadata?.quotaResetDelay);
                if (retryDelay !== null) return retryDelay;
            }
        }

        const message = data?.error?.message;
        if (message) {
            const match = message.match(/after\s+([\d.]+)\s*(ms|s)?\.?/i);
            if (match) {
                const amount = parseFloat(match[1]);
                return Math.max(0, Math.round(match[2]?.toLowerCase() === 'ms' ? amount : amount * 1000));
            }
        }
    } catch {}

    return null;
}

export function getRetryAfterMs(error, now = Date.now()) {
    const headerDelay = parseRetryAfterMs(getHeaderValue(error?.response?.headers, 'retry-after'), now);
    if (headerDelay !== null) return headerDelay;

    const explicitDelay = parseDurationMs(error?.retryAfterMs);
    if (explicitDelay !== null) return explicitDelay;

    const internalRetryAfterDelay = parseDurationMs(error?.retryAfter);
    if (internalRetryAfterDelay !== null) return internalRetryAfterDelay;

    const retryAfterDelay = parseRetryAfterMs(error?.response?.data?.retryAfter ?? error?.response?.data?.retry_after, now);
    if (retryAfterDelay !== null) return retryAfterDelay;

    return getRetryDelayFromBody(error?.response?.data);
}

function getPositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

export function isRateLimitError(error) {
    if (!error) return false;
    const status = Number(getErrorStatusCode(error));
    if (status === 429 || error.status === 429 || error.statusCode === 429 || error.code === 429 || error.err_code === 'rate_limit_exceeded') {
        return true;
    }
    if (error.isRateLimit === true) return true;
    const msg = String(error.message || '').toLowerCase();
    if (msg.includes('rate limit') || msg.includes('rate_limit') || msg.includes('too many requests') || msg.includes('image rate limit')) {
        return true;
    }
    const rawData = error.response?.data;
    if (typeof rawData === 'string') {
        const lower = rawData.toLowerCase();
        if (lower.includes('rate limit') || lower.includes('rate_limit') || lower.includes('too many requests') || lower.includes('rate_limit_exceeded')) {
            return true;
        }
    }
    return false;
}

export function getRateLimitCooldownRecoveryTime(error, config = {}, now = Date.now()) {
    if (!isRateLimitError(error)) {
        return null;
    }

    const defaultCooldownMs = getPositiveInteger(config.RATE_LIMIT_COOLDOWN_MS, 60000);
    const maxCooldownMs = getPositiveInteger(config.RATE_LIMIT_COOLDOWN_MAX_MS, 300000);
    const jitterMs = getPositiveInteger(config.RATE_LIMIT_COOLDOWN_JITTER_MS, 0);
    const retryAfterMs = getRetryAfterMs(error, now);
    const baseCooldownMs = retryAfterMs === null ? defaultCooldownMs : retryAfterMs;
    const cappedCooldownMs = Math.min(baseCooldownMs, Math.max(defaultCooldownMs, maxCooldownMs));
    const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;

    return new Date(now + cappedCooldownMs + jitter);
}

export function isQuotaExhaustedError(error) {
    if (!error) return false;
    const status = Number(getErrorStatusCode(error));
    if (status === 402 || error.status === 402 || error.statusCode === 402 || error.code === 402) return true;
    if (error.isQuotaExhausted === true) return true;

    const errCode = String(error.err_code || error.code || '').toLowerCase();
    if (errCode === 'usage_pool_exhausted' || errCode === 'quota_exceeded' || errCode === 'insufficient_quota') {
        return true;
    }

    const msg = String(error.message || '').toLowerCase();

    let dataStr = '';
    const rawData = error.response?.data;
    if (typeof rawData === 'string') {
        dataStr = rawData.toLowerCase();
    } else if (rawData && typeof rawData.on !== 'function' && typeof rawData.read !== 'function' && !Buffer.isBuffer(rawData)) {
        try {
            dataStr = JSON.stringify(rawData).toLowerCase();
        } catch {
            dataStr = '';
        }
    }

    const quotaKeywords = [
        'spending-limit',
        'monthly_request_count',
        'payment required',
        'payment_required',
        'usage_limit_reached',
        'usage_pool_exhausted',
        'usage limit exceeded',
        'usage limit',
        'media generation credits',
        'used up your media generation',
        'insufficient_quota',
        'quota exceeded',
        'out of credits',
    ];

    return quotaKeywords.some(kw => msg.includes(kw) || dataStr.includes(kw));
}

export function getQuotaCooldownRecoveryTime(error, config = {}, now = Date.now()) {
    if (!isQuotaExhaustedError(error)) {
        return null;
    }
    const defaultCooldownMs = getPositiveInteger(config.QUOTA_COOLDOWN_MS, 300000);
    const jitterMs = getPositiveInteger(config.QUOTA_COOLDOWN_JITTER_MS, 30000);
    const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
    return new Date(now + defaultCooldownMs + jitter);
}

export function calculateRetryDelay(currentRetry = 0, baseDelay = 1000, maxDelay = 8000) {
    const expDelay = Math.min(maxDelay, baseDelay * Math.pow(1.5, currentRetry));
    const jitter = Math.floor(Math.random() * Math.min(expDelay * 0.4, 1000));
    return Math.max(500, Math.floor(expDelay + jitter));
}

export function createEmptyUpstreamResponseError(providerLabel = 'Upstream') {
    const error = new Error(`[${providerLabel}] Upstream returned an empty response (no text, tool call, or thinking content).`);
    error.isEmptyUpstreamResponse = true;
    error.shouldSwitchCredential = true;
    error.skipErrorCount = true;
    return error;
}

function getProtocolErrorType(code) {
    if (code === 401) return 'authentication_error';
    if (code === 403) return 'permission_error';
    if (code === 429) return 'rate_limit_error';
    if (code >= 500) return 'server_error';
    return 'invalid_request_error';
}

function getGeminiErrorStatus(code) {
    if (code === 400) return 'INVALID_ARGUMENT';
    if (code === 401) return 'UNAUTHENTICATED';
    if (code === 403) return 'PERMISSION_DENIED';
    if (code === 404) return 'NOT_FOUND';
    if (code === 429) return 'RESOURCE_EXHAUSTED';
    if (code >= 500) return 'INTERNAL';
    return 'UNKNOWN';
}

export function createErrorResponse(error, fromProvider) {
    const protocolPrefix = getProtocolPrefix(fromProvider);
    const rawStatusCode = error.status || error.code || 500;
    const statusCode = ensureValidStatusCode(rawStatusCode);
    const errorMessage = error.message || "An error occurred during processing.";

    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            return {
                error: {
                    message: errorMessage,
                    type: getProtocolErrorType(statusCode),
                    code: getProtocolErrorType(statusCode)
                }
            };

        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            return {
                error: {
                    type: getProtocolErrorType(statusCode),
                    message: errorMessage,
                    code: getProtocolErrorType(statusCode)
                }
            };

        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            return {
                type: "error",
                error: {
                    type: getProtocolErrorType(statusCode),
                    message: errorMessage
                }
            };

        case MODEL_PROTOCOL_PREFIX.GEMINI:
            return {
                error: {
                    code: statusCode,
                    message: errorMessage,
                    status: getGeminiErrorStatus(statusCode)
                }
            };

        default:
            return {
                error: {
                    message: errorMessage,
                    type: getProtocolErrorType(statusCode),
                    code: getProtocolErrorType(statusCode)
                }
            };
    }
}

export function createStreamErrorResponse(error, fromProvider) {
    const protocolPrefix = getProtocolPrefix(fromProvider);
    const rawStatusCode = error.status || error.code || 500;
    const statusCode = ensureValidStatusCode(rawStatusCode);
    const errorMessage = error.message || "An error occurred during streaming.";

    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.OPENAI: {
            const openaiError = {
                error: {
                    message: errorMessage,
                    type: getProtocolErrorType(statusCode),
                    code: null
                }
            };
            return `data: ${JSON.stringify(openaiError)}\n\n`;
        }

        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES: {
            const responsesError = {
                id: `resp_${Date.now()}`,
                object: "error",
                created: Math.floor(Date.now() / 1000),
                error: {
                    type: getProtocolErrorType(statusCode),
                    message: errorMessage,
                    code: getProtocolErrorType(statusCode)
                }
            };
            return `event: error\ndata: ${JSON.stringify(responsesError)}\n\n`;
        }

        case MODEL_PROTOCOL_PREFIX.CLAUDE: {
            const claudeError = {
                type: "error",
                error: {
                    type: getProtocolErrorType(statusCode),
                    message: errorMessage
                }
            };
            return `event: error\ndata: ${JSON.stringify(claudeError)}\n\n`;
        }

        case MODEL_PROTOCOL_PREFIX.GEMINI: {
            const geminiError = {
                error: {
                    code: statusCode,
                    message: errorMessage,
                    status: getGeminiErrorStatus(statusCode)
                }
            };
            return `data: ${JSON.stringify(geminiError)}\n\n`;
        }

        default: {
            const defaultError = {
                error: {
                    message: errorMessage,
                    type: getProtocolErrorType(statusCode),
                    code: null
                }
            };
            return `data: ${JSON.stringify(defaultError)}\n\n`;
        }
    }
}

function _getProviderSpecificSuggestions(statusCode, provider) {
    const protocolPrefix = provider ? getProtocolPrefix(provider) : null;

    const defaultSuggestions = {
        auth: [
            'Verify your API key or credentials are valid',
            'Check if your credentials have expired',
            'Ensure the API key has the necessary permissions'
        ],
        permission: [
            'Check if your account has the necessary permissions',
            'Verify the API endpoint is accessible with your credentials',
            'Contact your administrator if permissions are restricted'
        ],
        rateLimit: [
            'The request has been automatically retried with exponential backoff',
            'If the issue persists, try reducing the request frequency',
            'Consider upgrading your API quota if available'
        ],
        serverError: [
            'The request has been automatically retried',
            'If the issue persists, try again in a few minutes',
            'Check the service status page for outages'
        ],
        clientError: [
            'Check your request format and parameters',
            'Verify the model name is correct',
            'Ensure all required fields are provided'
        ]
    };

    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            return {
                auth: [
                    'Verify your OAuth credentials are valid',
                    'Try re-authenticating by deleting the credentials file',
                    'Check if your Google Cloud project has the necessary permissions'
                ],
                permission: [
                    'Ensure your Google Cloud project has the Gemini API enabled',
                    'Check if your account has the necessary permissions',
                    'Verify the project ID is correct'
                ],
                rateLimit: [
                    'The request has been automatically retried with exponential backoff',
                    'If the issue persists, try reducing the request frequency',
                    'Consider upgrading your Google Cloud API quota'
                ],
                serverError: [
                    'The request has been automatically retried',
                    'If the issue persists, try again in a few minutes',
                    'Check Google Cloud status page for service outages'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is a valid Gemini model',
                    'Ensure all required fields are provided'
                ]
            };

        case MODEL_PROTOCOL_PREFIX.OPENAI:
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            return {
                auth: [
                    'Verify your OpenAI API key is valid',
                    'Check if your API key has expired or been revoked',
                    'Ensure the API key is correctly formatted (starts with sk-)'
                ],
                permission: [
                    'Check if your OpenAI account has access to the requested model',
                    'Verify your organization settings allow this operation',
                    'Ensure you have sufficient credits in your account'
                ],
                rateLimit: [
                    'The request has been automatically retried with exponential backoff',
                    'If the issue persists, try reducing the request frequency',
                    'Consider upgrading your OpenAI usage tier for higher limits'
                ],
                serverError: [
                    'The request has been automatically retried',
                    'If the issue persists, try again in a few minutes',
                    'Check OpenAI status page (status.openai.com) for outages'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is a valid OpenAI model',
                    'Ensure the message format is correct (role and content fields)'
                ]
            };

        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            return {
                auth: [
                    'Verify your Anthropic API key is valid',
                    'Check if your API key has expired or been revoked',
                    'Ensure the x-api-key header is correctly set'
                ],
                permission: [
                    'Check if your Anthropic account has access to the requested model',
                    'Verify your account is in good standing',
                    'Ensure you have sufficient credits in your account'
                ],
                rateLimit: [
                    'The request has been automatically retried with exponential backoff',
                    'If the issue persists, try reducing the request frequency',
                    'Consider upgrading your Anthropic usage tier for higher limits'
                ],
                serverError: [
                    'The request has been automatically retried',
                    'If the issue persists, try again in a few minutes',
                    'Check Anthropic status page for service outages'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is a valid Claude model',
                    'Ensure the message format follows Anthropic API specifications'
                ]
            };

        default:
            return defaultSuggestions;
    }
}

export function handleError(res, error, provider = null, fromProvider = null, req = null) {
    const rawStatusCode = error.response?.status || error.statusCode || error.status || error.code || 500;
    const statusCode = ensureValidStatusCode(rawStatusCode);

    if (!fromProvider && req && req.url) {
        if (req.url.includes('/v1/messages')) fromProvider = MODEL_PROTOCOL_PREFIX.CLAUDE;
        else if (req.url.includes('/v1/chat/completions')) fromProvider = MODEL_PROTOCOL_PREFIX.OPENAI;
        else if (req.url.includes('/v1beta/models')) fromProvider = MODEL_PROTOCOL_PREFIX.GEMINI;
    }

    if (fromProvider) {
        if (res.writableEnded || res.destroyed || res.finished) {
            logger.warn('[Server] Response already ended or destroyed, skipping protocol error response');
            return;
        }
        const errorResponse = createErrorResponse(error, fromProvider);
        if (!res.headersSent) {
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        }
        try {
            res.end(JSON.stringify(errorResponse));
        } catch (e) {}
        return;
    }

    const hasOriginalMessage = error.message && error.message.trim() !== '';
    let errorMessage = error.message;
    let suggestions = [];

    const providerSuggestions = _getProviderSpecificSuggestions(statusCode, provider);

    switch (statusCode) {
        case 401:
            errorMessage = 'Authentication failed. Please check your credentials.';
            suggestions = providerSuggestions.auth;
            break;
        case 403:
            errorMessage = 'Access forbidden. Insufficient permissions.';
            suggestions = providerSuggestions.permission;
            break;
        case 429:
            errorMessage = 'Too many requests. Rate limit exceeded.';
            suggestions = providerSuggestions.rateLimit;
            break;
        case 500:
        case 502:
        case 503:
        case 504:
            errorMessage = 'Server error occurred. This is usually temporary.';
            suggestions = providerSuggestions.serverError;
            break;
        default:
            if (statusCode >= 400 && statusCode < 500) {
                errorMessage = `Client error (${statusCode}): ${error.message}`;
                suggestions = providerSuggestions.clientError;
            } else if (statusCode >= 500) {
                errorMessage = `Server error (${statusCode}): ${error.message}`;
                suggestions = providerSuggestions.serverError;
            }
    }

    errorMessage = hasOriginalMessage ? error.message.trim() : errorMessage;
    if (statusCode >= 400 && statusCode < 500) {
        const hint = suggestions.length > 0 ? ` (Hint: ${suggestions[0]})` : '';
        logger.warn(`[Server] Request failed (${statusCode}): ${errorMessage}${hint}`);
        if (error.stack) {
            logger.debug('[Server] Full error details:', error.stack);
        }
    } else {
        const suggestionsSummary = suggestions.length > 0 ? ` | Suggestions: ${suggestions.join('; ')}` : '';
        logger.error(`\n[Server] Request failed (${statusCode}): ${errorMessage}${suggestionsSummary}`);
        if (error.stack) {
            logger.error('[Server] Full error details:', error.stack);
        }
    }

    if (res.writableEnded || res.destroyed || res.finished) {
        logger.warn('[Server] Response already ended or destroyed, skipping error response');
        return;
    }

    if (!res.headersSent) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    }

    let safeDetails = error.response?.data;
    if (safeDetails && (typeof safeDetails.on === 'function' || typeof safeDetails.read === 'function' || Buffer.isBuffer(safeDetails))) {
        safeDetails = '[Stream response]';
    }

    const errorPayload = {
        error: {
            message: errorMessage,
            code: statusCode,
            suggestions: suggestions,
            details: safeDetails
        }
    };

    try {
        res.end(JSON.stringify(errorPayload));
    } catch (writeError) {
        logger.error('[Server] Failed to write error response:', writeError.message);
    }
}
