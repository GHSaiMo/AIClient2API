import { UndiciHttpClient } from '../../utils/undici-client.js';
import logger from '../../utils/logger.js';
import { configureUndiciTLSSidecar } from '../../utils/proxy-utils.js';
import { isRetryableNetworkError, MODEL_PROVIDER, getRetryAfterMs } from '../../utils/common.js';

/**
 * Claude API Core Service Class.
 * Encapsulates the interaction logic with the Anthropic Claude API.
 */
export class ClaudeApiService {
    /**
     * Constructor
     * @param {Object} config - Provider configuration.
     */
    constructor(config) {
        if (!config.CLAUDE_API_KEY) {
            throw new Error("Claude API Key is required for ClaudeApiService.");
        }
        this.config = config;
        this.apiKey = config.CLAUDE_API_KEY;
        this.baseUrl = config.CLAUDE_BASE_URL;
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_CLAUDE ?? false;
        logger.info(`[Claude] System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);
        this.client = this.createClient();
    }

    /**
     * Creates an UndiciHttpClient instance for communication with the Claude API.
     * @returns {UndiciHttpClient}
     */
    createClient() {
        return new UndiciHttpClient({
            baseURL: this.baseUrl,
            headers: {
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01', // Claude API 版本
            },
        });
    }

    _applySidecar(requestOptions) {
        return configureUndiciTLSSidecar(
            requestOptions,
            this.config,
            this.config.MODEL_PROVIDER || MODEL_PROVIDER.CLAUDE_CUSTOM,
            this.baseUrl
        );
    }

    /**
     * Generic method to call the Claude API, with retry mechanism.
     * @param {string} endpoint - API endpoint, e.g., '/messages'.
     * @param {object} body - Request body.
     * @param {boolean} isRetry - Whether it's a retry call.
     * @param {number} retryCount - Current retry count.
     * @returns {Promise<object>} API response data.
     */
    async callApi(endpoint, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000; // 1 second base delay

        try {
            const reqOptions = {
                method: 'POST',
                url: endpoint,
                data: body
            };
            this._applySidecar(reqOptions);
            const response = await this.client.request(reqOptions);
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            // 对于 Claude API，401 通常意味着 API Key 无效，不进行重试
            if (status === 401 || status === 403) {
                logger.error(`[Claude API] Received ${status}. API Key might be invalid or expired.`);
                throw error;
            }

            // 处理 429 (Too Many Requests)
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[Claude API] Received 429 with Retry-After: ${retryAfter}ms. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[Claude API] Received 429 (Too Many Requests). No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.callApi(endpoint, body, isRetry, retryCount + 1);
                }
            }

            // 处理其他可重试错误 (5xx 服务器错误)
            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[Claude API] Received ${status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, isRetry, retryCount + 1);
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                logger.info(`[Claude API] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, isRetry, retryCount + 1);
            }

            logger.error(`[Claude API] Error calling API (Status: ${status}, Code: ${errorCode}):`, error.message);
            throw error;
        }
    }

    /**
     * Generic method to stream from the Claude API, with retry mechanism.
     * @param {string} endpoint - API endpoint, e.g., '/messages'.
     * @param {object} body - Request body.
     * @param {boolean} isRetry - Whether it's a retry call.
     * @param {number} retryCount - Current retry count.
     * @returns {AsyncIterable<object>} API response stream.
     */
    async *streamApi(endpoint, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000; // 1 second base delay

        try {
            const reqOptions = {
                method: 'POST',
                url: endpoint,
                data: { ...body, stream: true },
                headers: {
                    'Accept': 'text/event-stream'
                }
            };
            this._applySidecar(reqOptions);

            for await (const line of this.client.stream(reqOptions.url, reqOptions.data, reqOptions)) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                if (trimmed.startsWith('data: ')) {
                    const data = trimmed.substring(6).trim();
                    if (data) {
                        try {
                            const parsedChunk = JSON.parse(data);
                            yield parsedChunk;
                            if (parsedChunk.type === 'message_stop') {
                                return;
                            }
                        } catch (e) {
                            logger.warn("[ClaudeApiService] Failed to parse stream chunk JSON:", e.message, "Data:", data);
                        }
                    }
                }
            }
        } catch (error) {
            const status = error.response?.status;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            // 对于 Claude API，401 通常意味着 API Key 无效，不进行重试
            if (status === 401 || status === 403) {
                logger.error(`[Claude API] Received ${status} during stream. API Key might be invalid or expired.`);
                throw error;
            }

            // 处理 429 (Too Many Requests)
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[Claude API] Received 429 with Retry-After: ${retryAfter}ms during stream. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[Claude API] Received 429 (Too Many Requests) during stream. No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                    return;
                }
            }

            // 处理其他可重试错误 (5xx 服务器错误)
            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[Claude API] Received ${status} server error during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                return;
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                logger.info(`[Claude API] Network error (${errorIdentifier}) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                return;
            }

            logger.error(`[Claude API] Error generating content stream (Status: ${status}, Code: ${errorCode}):`, error.response ? error.response.data : error.message);
            throw error;
        }
    }

    /**
     * Generates content (non-streaming).
     * @param {string} model - Model name.
     * @param {object} requestBody - Request body (Claude format).
     * @returns {Promise<object>} Claude API response (Claude compatible format).
     */
    async generateContent(model, requestBody) {
        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }
        
        const response = await this.callApi('/messages', requestBody);
        return response;
    }

    /**
     * Streams content generation.
     * @param {string} model - Model name.
     * @param {object} requestBody - Request body (Claude format).
     * @returns {AsyncIterable<object>} Claude API response stream (Claude compatible format).
     */
    async *generateContentStream(model, requestBody) {
        const stream = this.streamApi('/messages', requestBody);
        for await (const chunk of stream) {
            yield chunk;
        }
    }

    /**
     * Lists available models.
     * @returns {Promise<object>} List of models.
     */
    async listModels() {
        logger.info('[ClaudeApiService] Listing available models.');
        try {
            const reqOptions = {
                method: 'GET',
                url: '/models'
            };
            this._applySidecar(reqOptions);
            const response = await this.client.request(reqOptions);
            if (Array.isArray(response.data?.data)) {
                return { models: response.data.data };
            }
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;
            logger.warn(`[ClaudeApiService] Failed to fetch models from upstream (Status: ${status || 'N/A'}), using fallback list:`, data || error.message);
        }

        const models = [
            { id: "claude-4-sonnet", name: "claude-4-sonnet" },
            { id: "claude-sonnet-4-20250514", name: "claude-sonnet-4-20250514" },
            { id: "claude-opus-4-20250514", name: "claude-opus-4-20250514" },
            { id: "claude-3-7-sonnet-20250219", name: "claude-3-7-sonnet-20250219" },
            { id: "claude-3-5-sonnet-20241022", name: "claude-3-5-sonnet-20241022" },
            { id: "claude-3-5-haiku-20241022", name: "claude-3-5-haiku-20241022" },
            { id: "claude-3-opus-20240229", name: "claude-3-opus-20240229" },
            { id: "claude-3-haiku-20240307", name: "claude-3-haiku-20240307" },
        ];

        return { models: models.map(m => ({ name: m.name })) };
    }
}
