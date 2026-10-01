/**
 * 代理工具模块
 * 支持 HTTP、HTTPS 和 SOCKS5 代理
 */

import { HttpsProxyAgent } from 'https-proxy-agent';
import logger from './logger.js';
import requestContext from './context.js';
import { HttpProxyAgent } from 'http-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { Agent as UndiciAgent, ProxyAgent as UndiciProxyAgent } from 'undici';
import { getTLSSidecar } from './tls-sidecar.js';
import { NETWORK } from './constants.js';

// 代理 Agent 缓存，避免重复创建 Agent 导致连接池失效和内存泄漏
const agentCache = new Map();

// Undici Dispatcher 缓存，复用连接池
const undiciDispatcherCache = new Map();

// 用于存储全局通配符代理获取器，解决启动初始化时无请求上下文的问题
let wildcardProxyResolver = null;

/**
 * 注册全局通配符代理获取器
 * @param {Function} resolver 
 */
export function registerWildcardProxyResolver(resolver) {
    wildcardProxyResolver = resolver;
}

/**
 * 从插件或上下文中解析当前节点的代理 URL。
 * 检查 context 或 config 中是否由插件注入了 ipNodeProxy.getProxyUrl 方法。
 *
 * @param {Object} config - 已合并节点配置的请求配置
 * @param {string} providerType - 提供商类型
 * @returns {string|null} 绑定的代理 URL
 */
export function getNodeProxyUrlFromBinding(config, providerType) {
    // 优先从线程级上下文获取（解决提供商实例缓存 config 导致获取不到最新插件方法的问题）
    const contextIpNodeProxy = requestContext.get('ipNodeProxy');
    if (typeof contextIpNodeProxy?.getProxyUrl === 'function') {
        try {
            return contextIpNodeProxy.getProxyUrl(providerType, config.uuid);
        } catch (error) {
            const nodeName = config?.customName || config?.uuid || 'unknown';
            logger.error(`[Proxy] Error calling ipNodeProxy.getProxyUrl from context for ${providerType}/${nodeName}:`, error.message);
        }
    }

    // 兜底：从 config 获取
    if (typeof config?.ipNodeProxy?.getProxyUrl === 'function') {
        try {
            return config.ipNodeProxy.getProxyUrl(providerType, config.uuid);
        } catch (error) {
            const nodeName = config?.customName || config?.uuid || 'unknown';
            logger.error(`[Proxy] Error calling ipNodeProxy.getProxyUrl from config for ${providerType}/${nodeName}:`, error.message);
        }
    }

    // 最后的兜底：如果没有上下文（如项目启动初始化），使用全局通配符 '*'
    if (typeof wildcardProxyResolver === 'function') {
        return wildcardProxyResolver(providerType, config.uuid);
    }

    return null;
}


/**
 * 解析代理URL并返回相应的代理配置
 * @param {string} proxyUrl - 代理URL，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080
 * @returns {Object|null} 代理配置对象，包含 httpAgent 和 httpsAgent
 */
export function parseProxyUrl(proxyUrl) {
    if (!proxyUrl || typeof proxyUrl !== 'string') {
        return null;
    }

    const trimmedUrl = proxyUrl.trim();
    if (!trimmedUrl) {
        return null;
    }

    // 检查缓存
    if (agentCache.has(trimmedUrl)) {
        return agentCache.get(trimmedUrl);
    }

    try {
        const url = new URL(trimmedUrl);
        const protocol = url.protocol.toLowerCase();

        // 默认 Agent 配置
        const agentOptions = {
            keepAlive: true,
            maxSockets: 64,        // 每个主机最多 64 个连接（稍微下调，平衡性能与资源）
            maxFreeSockets: 8,     // 最多保留 8 个空闲连接
            timeout: NETWORK.DEFAULT_TIMEOUT
        };

        let result = null;
        if (protocol === 'socks5:' || protocol === 'socks5h:' || protocol === 'socks4:' || protocol === 'socks4a:' || protocol === 'socks:') {
            // SOCKS 代理：对于 socks5，升级为 socks5h 确保远程 DNS 解析，防止隔离网段/无外网DNS环境解析失败
            const effectiveSocksUrl = trimmedUrl.replace(/^socks5:\/\//i, 'socks5h://');
            const socksAgent = new SocksProxyAgent(effectiveSocksUrl, agentOptions);
            result = {
                httpAgent: socksAgent,
                httpsAgent: socksAgent,
                proxyType: 'socks'
            };
        } else if (protocol === 'http:' || protocol === 'https:') {
            // HTTP/HTTPS 代理
            result = {
                httpAgent: new HttpProxyAgent(trimmedUrl, agentOptions),
                httpsAgent: new HttpsProxyAgent(trimmedUrl, agentOptions),
                proxyType: 'http'
            };
        } else {
            logger.warn(`[Proxy] Unsupported proxy protocol: ${protocol}`);
            return null;
        }

        // 存入缓存
        if (result) {
            agentCache.set(trimmedUrl, result);
        }
        return result;
    } catch (error) {
        logger.error(`[Proxy] Failed to parse proxy URL: ${error.message}`);
        return null;
    }
}

/**
 * 检查指定的提供商是否启用了代理（支持前缀匹配）
 * @param {Object} config - 配置对象
 * @param {string} providerType - 提供商类型
 * @returns {boolean} 是否启用代理
 */
export function isProxyEnabledForProvider(config, providerType) {
    if (getNodeProxyUrlFromBinding(config, providerType)) {
        return true;
    }

    if (!config || !config.PROXY_URL || !config.PROXY_ENABLED_PROVIDERS) {
        return false;
    }

    const enabledProviders = config.PROXY_ENABLED_PROVIDERS;
    if (!Array.isArray(enabledProviders)) {
        return false;
    }

    // 1. 尝试精确匹配
    if (enabledProviders.includes(providerType)) {
        return true;
    }

    // 2. 尝试前缀匹配 (例如 openai-custom-prod 继承 openai-custom 的配置)
    return enabledProviders.some(p => providerType.startsWith(p + '-'));
}

/**
 * 获取指定提供商的代理配置
 * @param {Object} config - 配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object|null} 代理配置对象或 null
 */
export function getProxyConfigForProvider(config, providerType) {
    if (!isProxyEnabledForProvider(config, providerType)) {
        return null;
    }

    const boundProxyUrl = getNodeProxyUrlFromBinding(config, providerType);
    const proxyUrl = boundProxyUrl || config.PROXY_URL;
    const proxyConfig = parseProxyUrl(proxyUrl);
    if (proxyConfig) {
        const nodeName = config?.customName || config?.uuid;
        const nodeDisplay = nodeName ? `${providerType}/${nodeName}` : providerType;
        
        // 优先从上下文中获取 clientIp
        const contextIpNodeProxy = requestContext.get('ipNodeProxy');
        const clientIp = contextIpNodeProxy?.clientIp || config.ipNodeProxy?.clientIp || 'unknown';
        
        const source = boundProxyUrl ? `${nodeDisplay} (IP binding ${clientIp})` : nodeDisplay;
        logger.info(`[Proxy] Using ${proxyConfig.proxyType} proxy for ${source}: ${proxyUrl}`);
    }

    return proxyConfig;
}

/**
 * 为 axios 配置代理
 * @param {Object} axiosConfig - axios 配置对象
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object} 更新后的 axios 配置
 */
export function configureAxiosProxy(axiosConfig, config, providerType) {
    const proxyConfig = getProxyConfigForProvider(config, providerType);

    if (proxyConfig) {
        // 使用代理 agent
        axiosConfig.httpAgent = proxyConfig.httpAgent;
        axiosConfig.httpsAgent = proxyConfig.httpsAgent;
        // 禁用 axios 内置的代理配置，使用我们的 agent
        axiosConfig.proxy = false;
    }

    return axiosConfig;
}

/**
 * 检查指定的提供商是否启用了 TLS Sidecar（支持前缀匹配）
 * @param {Object} config - 配置对象
 * @param {string} providerType - 提供商类型
 * @returns {boolean} 是否启用 TLS Sidecar
 */
export function isTLSSidecarEnabledForProvider(config, providerType) {
    // if (getNodeProxyUrlFromBinding(config, providerType)) {
    //     return true;
    // }

    if (!config || !config.TLS_SIDECAR_ENABLED || !config.TLS_SIDECAR_ENABLED_PROVIDERS) {
        return false;
    }

    const enabledProviders = config.TLS_SIDECAR_ENABLED_PROVIDERS;
    if (!Array.isArray(enabledProviders)) {
        return false;
    }

    // 1. 尝试精确匹配
    if (enabledProviders.includes(providerType)) {
        return true;
    }

    // 2. 尝试前缀匹配
    return enabledProviders.some(p => providerType.startsWith(p + '-'));
}

/**
 * 为 axios 配置 TLS Sidecar
 * @param {Object} axiosConfig - axios 配置对象
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @param {string} [defaultBaseUrl] - 默认基础 URL（用于处理相对路径）
 * @returns {Object} 更新后的 axios 配置
 */
export function configureTLSSidecar(axiosConfig, config, providerType, defaultBaseUrl = null) {
    const sidecar = getTLSSidecar();
    if (sidecar.isReady() && isTLSSidecarEnabledForProvider(config, providerType)) {
        // 优先使用 IP 绑定的代理，其次使用 Sidecar 专用的代理，最后使用全局代理
        const boundProxyUrl = getNodeProxyUrlFromBinding(config, providerType);
        const proxyUrl = boundProxyUrl || config.TLS_SIDECAR_PROXY_URL || config.PROXY_URL || null;
        
        // 处理相对路径
        if (axiosConfig.url && !axiosConfig.url.startsWith('http')) {
            const baseUrl = (axiosConfig.baseURL || defaultBaseUrl || '').replace(/\/$/, '');
            if (baseUrl) {
                const path = axiosConfig.url.startsWith('/') ? axiosConfig.url : '/' + axiosConfig.url;
                axiosConfig.url = baseUrl + path;
            }
        }
        
        const nodeName = config?.customName || config?.uuid;
        const nodeDisplay = nodeName ? `${providerType}/${nodeName}` : providerType;
        
        // 优先从上下文中获取 clientIp
        const contextIpNodeProxy = requestContext.get('ipNodeProxy');
        const clientIp = contextIpNodeProxy?.clientIp || config.ipNodeProxy?.clientIp || 'unknown';
        
        const source = boundProxyUrl ? `${nodeDisplay} (IP binding ${clientIp})` : nodeDisplay;
        logger.info(`[TLS Sidecar] Using sidecar for ${source}${proxyUrl ? ` (proxy: ${proxyUrl})` : ''}`);
        
        sidecar.wrapAxiosConfig(axiosConfig, proxyUrl);
    }else{
        // 未启用 TLS Sidecar，直接使用全局代理
        configureAxiosProxy(axiosConfig, config, providerType);
    }
    return axiosConfig;
}

/**
 * 为 google-auth-library 配置代理
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object|null} transporter 配置对象或 null
 */
export function getGoogleAuthProxyConfig(config, providerType) {
    const proxyConfig = getProxyConfigForProvider(config, providerType);

    if (proxyConfig) {
        return {
            agent: proxyConfig.httpsAgent
        };
    }

    return null;
}

/**
 * 根据代理 URL 获取或创建 Undici Dispatcher
 * 完整支持 HTTP、HTTPS 和 SOCKS5/SOCKS5h 代理
 * @param {string} proxyUrl - 代理 URL (http, https, socks5, socks5h)
 * @param {string} [sourceDisplay] - 来源描述（用于日志）
 * @returns {any|null} Undici Dispatcher
 */
export function getUndiciDispatcherForUrl(proxyUrl, sourceDisplay = '') {
    const cleanUrl = (proxyUrl || '').trim();
    if (!cleanUrl) return null;

    if (undiciDispatcherCache.has(cleanUrl)) {
        return undiciDispatcherCache.get(cleanUrl);
    }

    try {
        const url = new URL(cleanUrl);
        const protocol = url.protocol.toLowerCase();

        let dispatcher = null;
        if (protocol === 'http:' || protocol === 'https:') {
            // HTTP/HTTPS 代理：直接使用 Undici 原生 ProxyAgent
            dispatcher = new UndiciProxyAgent({
                uri: cleanUrl,
                keepAliveTimeout: 30000,
                keepAliveMaxTimeout: 60000,
                maxRedirections: 3,
            });
        } else if (protocol.startsWith('socks')) {
            // SOCKS 代理：通过 socks-proxy-agent 建立 TCP 隧道并桥接给 Undici Agent
            const effectiveSocksUrl = cleanUrl.replace(/^socks5:\/\//i, 'socks5h://');
            const socksAgent = new SocksProxyAgent(effectiveSocksUrl);
            dispatcher = new UndiciAgent({
                connect: async (opts, cb) => {
                    try {
                        const isHttps = opts.protocol === 'https:';
                        const port = Number(opts.port) || (isHttps ? 443 : 80);
                        const host = opts.hostname || opts.host;
                        const target = {
                            host,
                            port,
                            servername: opts.servername || host,
                            secureEndpoint: isHttps,
                        };
                        const dummyReq = { destroy() {} };
                        const socket = await socksAgent.connect(dummyReq, target);
                        cb(null, socket);
                    } catch (err) {
                        cb(err);
                    }
                },
                keepAliveTimeout: 30000,
                keepAliveMaxTimeout: 60000,
            });
        } else {
            logger.warn(`[Proxy] Unsupported proxy protocol for Undici: ${protocol}`);
            return null;
        }

        if (dispatcher) {
            dispatcher._proxyUrl = cleanUrl;
            undiciDispatcherCache.set(cleanUrl, dispatcher);
            const source = sourceDisplay ? ` for ${sourceDisplay}` : '';
            logger.info(`[Proxy] Created Undici Dispatcher${source}: ${cleanUrl}`);
        }
        return dispatcher;
    } catch (e) {
        logger.error(`[Proxy] Failed to create Undici Dispatcher for ${cleanUrl}:`, e.message);
        return null;
    }
}

/**
 * 根据提供商配置获取 Undici Dispatcher
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @returns {any|null} Undici Dispatcher
 */
export function getUndiciDispatcherForProvider(config, providerType) {
    if (!isProxyEnabledForProvider(config, providerType)) {
        return null;
    }

    const boundProxyUrl = getNodeProxyUrlFromBinding(config, providerType);
    const proxyUrl = (boundProxyUrl || config.PROXY_URL || '').trim();
    if (!proxyUrl) return null;

    const nodeName = config?.customName || config?.uuid;
    const nodeDisplay = nodeName ? `${providerType}/${nodeName}` : providerType;
    const contextIpNodeProxy = requestContext.get('ipNodeProxy');
    const clientIp = contextIpNodeProxy?.clientIp || config.ipNodeProxy?.clientIp || 'unknown';
    const source = boundProxyUrl ? `${nodeDisplay} (IP binding ${clientIp})` : nodeDisplay;

    return getUndiciDispatcherForUrl(proxyUrl, source);
}

/**
 * 为 Undici 请求配置代理 Dispatcher
 * @param {Object} requestOptions - 请求选项对象
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object} 更新后的 requestOptions
 */
export function configureUndiciProxy(requestOptions, config, providerType) {
    if (!isProxyEnabledForProvider(config, providerType)) {
        return requestOptions;
    }

    const boundProxyUrl = getNodeProxyUrlFromBinding(config, providerType);
    const proxyUrl = (boundProxyUrl || config.PROXY_URL || '').trim();
    if (proxyUrl) {
        requestOptions.proxyUrl = proxyUrl;
    }

    const dispatcher = getUndiciDispatcherForProvider(config, providerType);
    if (dispatcher) {
        requestOptions.dispatcher = dispatcher;
    }
    return requestOptions;
}

/**
 * 为 Undici 请求配置 TLS Sidecar 或外部代理
 * @param {Object} requestOptions - 请求选项对象
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @param {string} [defaultBaseUrl] - 默认基础 URL（用于解析相对路径）
 * @returns {Object} 更新后的 requestOptions
 */
export function configureUndiciTLSSidecar(requestOptions, config, providerType, defaultBaseUrl = null) {
    const sidecar = getTLSSidecar();
    if (sidecar.isReady() && isTLSSidecarEnabledForProvider(config, providerType)) {
        const boundProxyUrl = getNodeProxyUrlFromBinding(config, providerType);
        const proxyUrl = boundProxyUrl || config.TLS_SIDECAR_PROXY_URL || config.PROXY_URL || null;

        // 处理相对路径
        if (requestOptions.url && !/^https?:\/\//i.test(requestOptions.url)) {
            const baseUrl = (requestOptions.baseURL || defaultBaseUrl || '').replace(/\/$/, '');
            if (baseUrl) {
                const path = requestOptions.url.startsWith('/') ? requestOptions.url : '/' + requestOptions.url;
                requestOptions.url = baseUrl + path;
            }
        }

        const nodeName = config?.customName || config?.uuid;
        const nodeDisplay = nodeName ? `${providerType}/${nodeName}` : providerType;
        const contextIpNodeProxy = requestContext.get('ipNodeProxy');
        const clientIp = contextIpNodeProxy?.clientIp || config.ipNodeProxy?.clientIp || 'unknown';
        const source = boundProxyUrl ? `${nodeDisplay} (IP binding ${clientIp})` : nodeDisplay;
        logger.info(`[TLS Sidecar] Using sidecar (Undici) for ${source}${proxyUrl ? ` (proxy: ${proxyUrl})` : ''}`);

        sidecar.wrapUndiciRequest(requestOptions, proxyUrl);
    } else {
        // 未启用 TLS Sidecar，配置常规代理
        configureUndiciProxy(requestOptions, config, providerType);
    }
    return requestOptions;
}

