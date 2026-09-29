/**
 * src/utils/undici-client.js
 * 基于 Undici 封装的高性能同构 HTTP 客户端
 */

import { fetch, Agent as UndiciAgent } from 'undici';
import { Readable } from 'stream';
import logger from './logger.js';
import { NETWORK } from './constants.js';

/**
 * 统一 HTTP 错误类，完全兼容原有 Axios 错误结构
 */
export class HttpError extends Error {
    constructor(message, { status = 0, statusText = '', headers = {}, data = null, code = null, request = null } = {}) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.statusText = statusText;
        this.code = code || (status ? `ERR_BAD_RESPONSE_${status}` : 'ERR_NETWORK');
        this.isAxiosError = true; // 兼容上层对 AxiosError 的判断守卫

        // 兼容原有的 error.response 结构
        this.response = {
            status,
            statusText,
            headers,
            data
        };
        this.request = request;
    }
}

// 本地专用 Dispatcher 单例（仅用于与本地 Sidecar 通信，严格禁用外部代理）
let localDispatcherInstance = null;

function getLocalDispatcher() {
    if (!localDispatcherInstance) {
        localDispatcherInstance = new UndiciAgent({
            keepAliveTimeout: 30000,
            keepAliveMaxTimeout: 60000,
            connections: 64,
        });
    }
    return localDispatcherInstance;
}

export class UndiciHttpClient {
    /**
     * @param {Object} options
     * @param {string} [options.baseURL]
     * @param {Object} [options.headers]
     * @param {number} [options.timeout] 默认超时时间（毫秒）
     * @param {any} [options.dispatcher] Undici Dispatcher / Agent
     */
    constructor(options = {}) {
        this.baseURL = (options.baseURL || '').replace(/\/$/, '');
        this.defaultHeaders = options.headers || {};
        this.defaultTimeout = options.timeout || NETWORK.DEFAULT_TIMEOUT || 120000;
        this.dispatcher = options.dispatcher || null;
    }

    /**
     * 构建完整请求 URL
     * @param {string} endpoint 
     * @returns {string}
     */
    _buildUrl(endpoint) {
        if (!endpoint) return this.baseURL;
        if (/^https?:\/\//i.test(endpoint)) {
            return endpoint;
        }
        const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
        return `${this.baseURL}${path}`;
    }

    /**
     * 构建复合 AbortSignal（支持外部 signal 与内部超时 signal）
     * @param {AbortSignal} [customSignal]
     * @param {number} [timeoutMs]
     * @returns {AbortSignal}
     */
    _resolveSignal(customSignal, timeoutMs) {
        const timeout = timeoutMs || this.defaultTimeout;
        const timeoutSignal = AbortSignal.timeout(timeout);

        if (!customSignal) {
            return timeoutSignal;
        }

        if (typeof AbortSignal.any === 'function') {
            return AbortSignal.any([customSignal, timeoutSignal]);
        }

        // Fallback for runtimes lacking AbortSignal.any
        const controller = new AbortController();
        const onAbort = () => {
            if (!controller.signal.aborted) {
                controller.abort(customSignal.aborted ? customSignal.reason : timeoutSignal.reason);
            }
        };

        if (customSignal.aborted) {
            controller.abort(customSignal.reason);
            return controller.signal;
        }
        if (timeoutSignal.aborted) {
            controller.abort(timeoutSignal.reason);
            return controller.signal;
        }

        customSignal.addEventListener('abort', onAbort, { once: true });
        timeoutSignal.addEventListener('abort', onAbort, { once: true });
        return controller.signal;
    }

    /**
     * 合并请求头
     * @param {Object|Headers} [extraHeaders]
     * @returns {Object}
     */
    _mergeHeaders(extraHeaders) {
        const merged = { ...this.defaultHeaders };
        if (extraHeaders instanceof Headers) {
            extraHeaders.forEach((val, key) => {
                merged[key] = val;
            });
        } else if (extraHeaders && typeof extraHeaders === 'object') {
            Object.assign(merged, extraHeaders);
        }
        return merged;
    }

    /**
     * 发送普通 HTTP 请求（支持 JSON / text / arraybuffer / stream 响应）
     * @param {Object} options
     * @returns {Promise<Object>}
     */
    async request(options = {}) {
        const {
            url: endpoint,
            method = 'GET',
            headers = {},
            data = null,
            body: explicitBody = null,
            params = null,
            timeout,
            signal: customSignal,
            dispatcher = this.dispatcher,
            responseType = 'json',
            validateStatus
        } = options;

        let fullUrl = this._buildUrl(endpoint);
        if (params && typeof params === 'object') {
            const searchParams = new URLSearchParams(params);
            const queryString = searchParams.toString();
            if (queryString) {
                fullUrl += (fullUrl.includes('?') ? '&' : '?') + queryString;
            }
        }

        const mergedHeaders = this._mergeHeaders(headers);
        const signal = this._resolveSignal(customSignal, timeout);

        let reqBody = explicitBody !== null ? explicitBody : data;
        let isFormData = false;

        if (reqBody !== null && reqBody !== undefined) {
            if (typeof FormData !== 'undefined' && reqBody instanceof FormData) {
                isFormData = true;
                // 让 fetch 自动注入带有正确 boundary 的 multipart/form-data
                for (const key of Object.keys(mergedHeaders)) {
                    if (key.toLowerCase() === 'content-type') {
                        delete mergedHeaders[key];
                    }
                }
            } else if (
                typeof reqBody === 'string' ||
                reqBody instanceof ArrayBuffer ||
                ArrayBuffer.isView(reqBody) ||
                reqBody instanceof URLSearchParams
            ) {
                // 原样传递
            } else {
                // 默认 JSON 序列化
                reqBody = JSON.stringify(reqBody);
                if (!Object.keys(mergedHeaders).some(k => k.toLowerCase() === 'content-type')) {
                    mergedHeaders['Content-Type'] = 'application/json';
                }
            }
        }

        if (!isFormData && !Object.keys(mergedHeaders).some(k => k.toLowerCase() === 'accept')) {
            if (responseType === 'json') {
                mergedHeaders['Accept'] = 'application/json, text/plain, */*';
            } else if (responseType === 'arraybuffer') {
                mergedHeaders['Accept'] = '*/*';
            }
        }

        const reqMeta = { url: fullUrl, method: method.toUpperCase() };

        try {
            const response = await fetch(fullUrl, {
                method: reqMeta.method,
                headers: mergedHeaders,
                body: reqBody,
                signal,
                dispatcher: dispatcher || undefined,
            });

            // 转换响应 Headers 为普通小写 key 对象
            const resHeaders = {};
            response.headers.forEach((val, key) => {
                resHeaders[key.toLowerCase()] = val;
            });

            let responseData = null;
            if (responseType === 'stream') {
                responseData = response.body && typeof Readable.fromWeb === 'function'
                    ? Readable.fromWeb(response.body)
                    : response.body;
            } else if (responseType === 'arraybuffer') {
                const arrayBuffer = await response.arrayBuffer();
                responseData = Buffer.from(arrayBuffer);
            } else if (responseType === 'text') {
                responseData = await response.text();
            } else {
                // json
                const contentType = (resHeaders['content-type'] || '').toLowerCase();
                if (contentType.includes('application/json')) {
                    responseData = await response.json().catch(() => null);
                } else {
                    const text = await response.text();
                    try {
                        responseData = JSON.parse(text);
                    } catch {
                        responseData = text;
                    }
                }
            }

            const isSuccess = typeof validateStatus === 'function'
                ? validateStatus(response.status)
                : response.ok;

            if (!isSuccess) {
                const errorMsg = (typeof responseData === 'object' && responseData !== null)
                    ? (responseData.error?.message || responseData.message || `Request failed with status code ${response.status}`)
                    : (typeof responseData === 'string' && responseData.trim() ? responseData : `Request failed with status code ${response.status}`);

                throw new HttpError(errorMsg, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: resHeaders,
                    data: responseData,
                    request: reqMeta,
                });
            }

            return {
                data: responseData,
                status: response.status,
                statusText: response.statusText,
                headers: resHeaders,
                rawResponse: response,
            };
        } catch (error) {
            if (error instanceof HttpError) {
                throw error;
            }

            const isTimeout = error.name === 'TimeoutError' || error.code === 23 || (error.name === 'AbortError' && signal.aborted && signal.reason?.name === 'TimeoutError');
            const isAbort = error.name === 'AbortError' || error.code === 20;

            let errorCode = error.code;
            if (isTimeout || errorCode === 23) {
                errorCode = 'ETIMEDOUT';
            } else if (isAbort || errorCode === 20) {
                errorCode = 'ECONNABORTED';
            } else if (!errorCode || typeof errorCode === 'number') {
                errorCode = 'ECONNRESET';
            }

            throw new HttpError(error.message, {
                status: isTimeout ? 408 : 0,
                statusText: isTimeout ? 'Request Timeout' : (isAbort ? 'Aborted' : 'Network Error'),
                headers: {},
                data: null,
                code: errorCode,
                request: reqMeta,
            });
        }
    }

    async get(url, options = {}) {
        return this.request({ ...options, url, method: 'GET' });
    }

    async post(url, data, options = {}) {
        return this.request({ ...options, url, method: 'POST', data });
    }

    async put(url, data, options = {}) {
        return this.request({ ...options, url, method: 'PUT', data });
    }

    async delete(url, options = {}) {
        return this.request({ ...options, url, method: 'DELETE' });
    }

    /**
     * 高级流式请求：获取原始响应、流以及行切分生成器
     * @param {string} endpoint 
     * @param {Object} options
     * @returns {Promise<{ response: Response, body: ReadableStream, headers: Object, status: number, lines: AsyncGenerator<string> }>}
     */
    async streamRequest(endpoint, options = {}) {
        const {
            method = 'POST',
            data = null,
            body: explicitBody = null,
            headers = {},
            timeout = 300000,
            signal: customSignal,
            dispatcher = this.dispatcher,
            validateStatus
        } = options;

        const fullUrl = this._buildUrl(endpoint);
        const mergedHeaders = this._mergeHeaders(headers);
        if (!Object.keys(mergedHeaders).some(k => k.toLowerCase() === 'accept')) {
            mergedHeaders['Accept'] = 'text/event-stream';
        }
        if (!Object.keys(mergedHeaders).some(k => k.toLowerCase() === 'content-type')) {
            mergedHeaders['Content-Type'] = 'application/json';
        }

        const signal = this._resolveSignal(customSignal, timeout);
        let reqBody = explicitBody !== null ? explicitBody : data;
        if (reqBody !== null && typeof reqBody !== 'string' && !(reqBody instanceof ArrayBuffer) && !ArrayBuffer.isView(reqBody)) {
            reqBody = JSON.stringify(reqBody);
        }

        const reqMeta = { url: fullUrl, method: method.toUpperCase() };

        let response;
        try {
            response = await fetch(fullUrl, {
                method: reqMeta.method,
                headers: mergedHeaders,
                body: reqBody,
                signal,
                dispatcher: dispatcher || undefined,
            });
        } catch (error) {
            const isTimeout = error.name === 'TimeoutError' || error.code === 23 || (error.name === 'AbortError' && signal.aborted && signal.reason?.name === 'TimeoutError');
            const isAbort = error.name === 'AbortError' || error.code === 20;

            let errorCode = error.code;
            if (isTimeout || errorCode === 23) {
                errorCode = 'ETIMEDOUT';
            } else if (isAbort || errorCode === 20) {
                errorCode = 'ECONNABORTED';
            } else if (!errorCode || typeof errorCode === 'number') {
                errorCode = 'ECONNRESET';
            }
            throw new HttpError(error.message, {
                status: isTimeout ? 408 : 0,
                statusText: isTimeout ? 'Request Timeout' : (isAbort ? 'Aborted' : 'Network Error'),
                headers: {},
                data: null,
                code: errorCode,
                request: reqMeta,
            });
        }

        const resHeaders = {};
        response.headers.forEach((val, key) => {
            resHeaders[key.toLowerCase()] = val;
        });

        const isSuccess = typeof validateStatus === 'function'
            ? validateStatus(response.status)
            : response.ok;

        if (!isSuccess) {
            const errorText = await response.text().catch(() => '');
            let errorJson = null;
            try {
                errorJson = JSON.parse(errorText);
            } catch {
                // ignore
            }

            const errorMsg = errorJson?.error?.message || errorJson?.message || `Stream request failed with status code ${response.status}`;
            throw new HttpError(errorMsg, {
                status: response.status,
                statusText: response.statusText,
                headers: resHeaders,
                data: errorJson || errorText,
                request: reqMeta,
            });
        }

        return {
            response,
            body: response.body,
            headers: resHeaders,
            status: response.status,
            async *lines() {
                if (!response.body) return;
                const reader = response.body.getReader();
                const decoder = new TextDecoder('utf-8');
                let buffer = '';

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        buffer += decoder.decode(value, { stream: true });
                        let newlineIndex;
                        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                            const line = buffer.substring(0, newlineIndex);
                            buffer = buffer.substring(newlineIndex + 1);
                            yield line;
                        }
                    }

                    if (buffer.length > 0) {
                        yield buffer;
                    }
                } finally {
                    try {
                        reader.releaseLock();
                    } catch {
                        // ignore
                    }
                }
            }
        };
    }

    /**
     * 高性能流式生成器：直接产出 AsyncIterable<string>，按行切分
     * @param {string} endpoint 
     * @param {any} body 
     * @param {Object} options 
     * @returns {AsyncGenerator<string>}
     */
    async *stream(endpoint, body, options = {}) {
        const streamResult = await this.streamRequest(endpoint, {
            ...options,
            data: body,
            method: options.method || 'POST',
        });
        yield* streamResult.lines();
    }

    /**
     * 获取专用的本地 Dispatcher
     * @returns {UndiciAgent}
     */
    static getLocalDispatcher() {
        return getLocalDispatcher();
    }
}

export default UndiciHttpClient;
