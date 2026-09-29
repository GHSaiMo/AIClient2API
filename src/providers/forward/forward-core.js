import { UndiciHttpClient } from '../../utils/undici-client.js';
import logger from '../../utils/logger.js';
import { configureUndiciTLSSidecar } from '../../utils/proxy-utils.js';
import { isRetryableNetworkError, MODEL_PROVIDER, getRetryAfterMs } from '../../utils/common.js';

/**
 * ForwardApiService - A provider that forwards requests to a specified API endpoint.
 * Transparently passes all parameters and includes an API key in the headers.
 */
export class ForwardApiService {
    constructor(config) {
        if (!config.FORWARD_API_KEY) {
            throw new Error("API Key is required for ForwardApiService (FORWARD_API_KEY).");
        }
        if (!config.FORWARD_BASE_URL) {
            throw new Error("Base URL is required for ForwardApiService (FORWARD_BASE_URL).");
        }
        
        this.config = config;
        this.apiKey = config.FORWARD_API_KEY;
        this.baseUrl = config.FORWARD_BASE_URL;
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_FORWARD ?? false;
        this.headerName = config?.FORWARD_HEADER_NAME || 'Authorization';
        this.headerValuePrefix = config?.FORWARD_HEADER_VALUE_PREFIX || 'Bearer ';

        logger.info(`[Forward] Base URL: ${this.baseUrl}, System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);

        const headers = {};
        headers[this.headerName] = `${this.headerValuePrefix}${this.apiKey}`;

        this.client = new UndiciHttpClient({
            baseURL: this.baseUrl,
            headers,
        });
    }

    _applySidecar(requestOptions) {
        return configureUndiciTLSSidecar(
            requestOptions,
            this.config,
            this.config.MODEL_PROVIDER || MODEL_PROVIDER.FORWARD_API,
            this.baseUrl
        );
    }

    async callApi(endpoint, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;

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
            const data = error.response?.data;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            const isNetworkError = isRetryableNetworkError(error);
            
            if (status === 401 || status === 403) {
                logger.error(`[Forward API] Received ${status}. API Key might be invalid or expired.`);
                throw error;
            }

            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[Forward API] Received 429 with Retry-After: ${retryAfter}ms. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[Forward API] Received 429 (Too Many Requests). No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.callApi(endpoint, body, isRetry, retryCount + 1);
                }
            }

            if (((status >= 500 && status < 600) || isNetworkError) && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[Forward API] Error ${status || errorCode}. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, isRetry, retryCount + 1);
            }

            logger.error(`[Forward API] Error calling API (Status: ${status}, Code: ${errorCode}):`, errorMessage);
            throw error;
        }
    }

    async *streamApi(endpoint, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;

        try {
            const reqOptions = {
                method: 'POST',
                url: endpoint,
                data: body,
                headers: {
                    'Accept': 'text/event-stream'
                }
            };
            this._applySidecar(reqOptions);

            for await (const line of this.client.stream(reqOptions.url, reqOptions.data, reqOptions)) {
                const trimmedLine = line.trim();
                if (!trimmedLine) continue;

                if (trimmedLine.startsWith('data: ')) {
                    const jsonData = trimmedLine.substring(6).trim();
                    if (jsonData === '[DONE]') {
                        return;
                    }
                    try {
                        const parsedChunk = JSON.parse(jsonData);
                        yield parsedChunk;
                    } catch (e) {
                        logger.warn("[ForwardApiService] Failed to parse stream chunk JSON:", e.message, "Data:", jsonData);
                    }
                }
            }
        } catch (error) {
            const status = error.response?.status;
            const errorCode = error.code;
            const isNetworkError = isRetryableNetworkError(error);
            
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[Forward API] Received 429 with Retry-After: ${retryAfter}ms during stream. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[Forward API] Received 429 (Too Many Requests) during stream. No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                    return;
                }
            }

            if (((status >= 500 && status < 600) || isNetworkError) && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[Forward API] Stream error ${status || errorCode}. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                return;
            }

            const errorMessage = error.message || '';
            logger.error(`[Forward API] Error calling streaming API (Status: ${status || errorCode}):`, errorMessage);
            throw error;
        }
    }

    async generateContent(model, requestBody) {
        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        // Transparently pass the endpoint if provided in requestBody, otherwise use default
        const endpoint = requestBody.endpoint || '';
        return this.callApi(endpoint, requestBody);
    }

    async *generateContentStream(model, requestBody) {
        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        const endpoint = requestBody.endpoint || '';
        yield* this.streamApi(endpoint, requestBody);
    }

    async listModels() {
        try {
            const reqOptions = {
                method: 'GET',
                url: '/models'
            };
            this._applySidecar(reqOptions);
            const response = await this.client.request(reqOptions);
            return response.data;
        } catch (error) {
            logger.error(`Error listing Forward models:`, error.message);
            return { data: [] };
        }
    }
}
