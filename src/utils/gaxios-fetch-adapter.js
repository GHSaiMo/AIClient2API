/**
 * src/utils/gaxios-fetch-adapter.js
 * 
 * 为 google-auth-library / gaxios 提供基于 Undici 的 fetch 适配层
 * 将 gaxios 的 node http.Agent 代理转译为 Undici Dispatcher，实现全项目统一使用 Undici。
 */

import { fetch as undiciFetch } from 'undici';
import { Readable } from 'stream';
import { getUndiciDispatcherForProvider, isTLSSidecarEnabledForProvider, getNodeProxyUrlFromBinding } from './proxy-utils.js';
import { UndiciHttpClient } from './undici-client.js';
import { getTLSSidecar } from './tls-sidecar.js';
import logger from './logger.js';

/**
 * 包装 Undici Response，当 gaxios 以 responseType: 'stream' 读取 body 时，
 * 惰性将 Web ReadableStream 转换为 Node.js Readable 流以完全兼容 Node readline 与流操作
 */
function wrapResponse(res) {
    if (!res) return res;
    let nodeStream = null;
    return new Proxy(res, {
        get(target, prop) {
            if (prop === 'body') {
                if (!nodeStream && target.body) {
                    nodeStream = Readable.fromWeb(target.body);
                }
                return nodeStream || target.body;
            }
            const val = Reflect.get(target, prop, target);
            if (typeof val === 'function') {
                return val.bind(target);
            }
            return val;
        }
    });
}

/**
 * 创建一个符合 fetch 签名的适配函数，用于注入 gaxios 的 transporterOptions.fetchImplementation
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商标识（如 antigravity, gemini 等）
 * @returns {Function} fetch 函数
 */
export function createGaxiosFetch(config, providerType) {
    return async (url, opts = {}) => {
        // gaxios 传入的 opts 会包含 agent（node http.Agent），undici 不识别且可能产生冲突，予以剥离
        const { agent, ...fetchOpts } = opts;

        let response;
        const sidecar = getTLSSidecar();
        if (sidecar.isReady() && isTLSSidecarEnabledForProvider(config, providerType)) {
            const sidecarBase = sidecar.getBaseUrl();
            const rawUrl = typeof url === 'string' ? url : (url?.href || url?.toString());
            
            // 确保 headers 对象结构可用
            const headers = fetchOpts.headers instanceof Headers
                ? new Headers(fetchOpts.headers)
                : { ...(fetchOpts.headers || {}) };

            const getHeader = (name) => headers instanceof Headers ? headers.get(name) : headers[name];
            const setHeader = (name, val) => {
                if (headers instanceof Headers) headers.set(name, val);
                else headers[name] = val;
            };

            // 如果尚未被 _applySidecar 包装过
            if (!getHeader('X-Target-Url') && !rawUrl.startsWith(sidecarBase)) {
                setHeader('X-Target-Url', rawUrl);
                const boundProxyUrl = getNodeProxyUrlFromBinding(config, providerType);
                const proxyUrl = boundProxyUrl || config.TLS_SIDECAR_PROXY_URL || config.PROXY_URL || null;
                if (proxyUrl) {
                    setHeader('X-Proxy-Url', proxyUrl);
                }
            }

            fetchOpts.headers = headers;
            // 访问本地 Sidecar，严格使用本地原生 Dispatcher，避免继承外部代理
            fetchOpts.dispatcher = UndiciHttpClient.getLocalDispatcher();

            const finalUrl = rawUrl.startsWith(sidecarBase) ? rawUrl : sidecarBase;
            response = await undiciFetch(finalUrl, fetchOpts);
        } else {
            // 2. 普通模式：若配置了外部代理，使用统一的 Undici Dispatcher
            const dispatcher = getUndiciDispatcherForProvider(config, providerType);
            if (dispatcher) {
                fetchOpts.dispatcher = dispatcher;
            }

            response = await undiciFetch(url, fetchOpts);
        }

        return wrapResponse(response);
    };
}

export default createGaxiosFetch;
