import logger from '../../utils/logger.js';

/**
 * AI 接口监控插件
 * 功能：
 * 1. 捕获 AI 接口的请求参数（转换前和转换后）
 * 2. 捕获 AI 接口的响应结果（转换前和转换后，流式响应聚合输出）
 */
// 用于存储流式响应的中间状态
const MAX_CACHED_CHUNKS = 100;
const STREAM_CACHE_TTL_MS = 3 * 60 * 1000;
let cacheCleanupTimer = null;

function ensureCacheCleanup(cacheMap) {
    if (!cacheCleanupTimer) {
        cacheCleanupTimer = setInterval(() => {
            const cutoff = Date.now() - STREAM_CACHE_TTL_MS;
            for (const [id, cache] of cacheMap.entries()) {
                if (cache.createdAt && cache.createdAt < cutoff) {
                    cacheMap.delete(id);
                }
            }
        }, 60 * 1000);
        if (cacheCleanupTimer.unref) {
            cacheCleanupTimer.unref();
        }
    }
}

const aiMonitorPlugin = {
    name: 'ai-monitor',
    version: '1.0.0',
    description: 'AI 接口监控插件 - 捕获请求和响应参数（全链路协议转换监控，流式聚合输出，用于调试和分析）',
    type: 'middleware',
    _priority: 100,

    // 用于存储流式响应的中间状态
    streamCache: new Map(),

    async init(config) {
        logger.info('[AI Monitor Plugin] Initialized');
    },

    /**
     * 中间件：初始化请求上下文
     */
    async middleware(req, res, requestUrl, config) {
        const aiPaths = [
            '/v1/chat/completions', 
            '/v1/responses', 
            '/v1/messages', 
            '/v1beta/models',
            '/v1/images/generations',
            '/v1/images/edits'
        ];
        const isAiPath = aiPaths.some(path => requestUrl.pathname.includes(path));

        if (isAiPath && req.method === 'POST' && !config._monitorRequestId) {
            // 在监控插件中生成请求标识，并存入 config 以供全链路追踪
            const requestId = Date.now() + Math.random().toString(36).substring(2, 10);
            config._monitorRequestId = requestId;
        }
        
        return { handled: false };
    },

    hooks: {
        /**
         * 请求转换后的钩子
         */
        async onContentGenerated(config) {
            const { originalRequestBody, processedRequestBody, fromProvider, toProvider, model, _monitorRequestId, isStream } = config;
            if (!originalRequestBody) return;
            const traceRequestId = _monitorRequestId;

            setImmediate(() => {
                const hasConversion = fromProvider !== toProvider || (
                    originalRequestBody !== processedRequestBody &&
                    JSON.stringify(originalRequestBody) !== JSON.stringify(processedRequestBody)
                );
                logger.info(`[AI Monitor][${traceRequestId}] >>> Req Protocol: ${fromProvider}${hasConversion ? ' -> ' + toProvider : ''} | Model: ${model}`);
                
                if (hasConversion) {
                    logger.info(`[AI Monitor][${traceRequestId}] [Req Original]: ${JSON.stringify(originalRequestBody)}`);
                    logger.info(`[AI Monitor][${traceRequestId}] [Req Processed]: ${JSON.stringify(processedRequestBody)}`);
                } else {
                    logger.info(`[AI Monitor][${traceRequestId}] [Req]: ${JSON.stringify(originalRequestBody)}`);
                }
            });

            // 处理流式响应的聚合输出
            if (isStream && traceRequestId) {
                setTimeout(() => {
                    const cache = aiMonitorPlugin.streamCache.get(traceRequestId);
                    if (cache) {
                        const hasConversion = cache.toProvider !== cache.fromProvider || (
                            JSON.stringify(cache.nativeChunks) !== JSON.stringify(cache.convertedChunks)
                        );
                        const isTruncated = (cache.nativeCount || 0) > cache.nativeChunks.length;
                        const truncSuffix = isTruncated ? ` (Sampled ${cache.nativeChunks.length}/${cache.nativeCount} chunks)` : '';
                        logger.info(`[AI Monitor][${traceRequestId}] <<< Stream Response Aggregated: ${hasConversion ? cache.toProvider + ' -> ' : ''}${cache.fromProvider}${truncSuffix}`);
                        
                        if (hasConversion) {
                            logger.info(`[AI Monitor][${traceRequestId}] [Res Native Full]: ${JSON.stringify(cache.nativeChunks)}`);
                            logger.info(`[AI Monitor][${traceRequestId}] [Res Converted Full]: ${JSON.stringify(cache.convertedChunks)}`);
                        } else {
                            logger.info(`[AI Monitor][${traceRequestId}] [Res Full]: ${JSON.stringify(cache.nativeChunks)}`);
                        }
                        
                        aiMonitorPlugin.streamCache.delete(traceRequestId);
                    }
                }, 2000); // 等待流传输完成
            }
        },

        /**
         * 非流式响应转换监控
         */
        async onUnaryResponse({ nativeResponse, clientResponse, fromProvider, toProvider, requestId }) {
            setImmediate(() => {
                const reqId = requestId || 'N/A';
                const hasConversion = fromProvider !== toProvider || (
                    nativeResponse !== clientResponse &&
                    JSON.stringify(nativeResponse) !== JSON.stringify(clientResponse)
                );
                logger.info(`[AI Monitor][${reqId}] <<< Res Protocol: ${hasConversion ? toProvider + ' -> ' : ''}${fromProvider} (Unary)`);
                
                if (hasConversion) {
                    logger.info(`[AI Monitor][${reqId}] [Res Native]: ${JSON.stringify(nativeResponse)}`);
                    logger.info(`[AI Monitor][${reqId}] [Res Converted]: ${JSON.stringify(clientResponse)}`);
                } else {
                    logger.info(`[AI Monitor][${reqId}] [Res]: ${JSON.stringify(nativeResponse)}`);
                }
            });
        },

        /**
         * 流式响应分块转换监控 - 聚合数据
         */
        async onStreamChunk({ nativeChunk, chunkToSend, fromProvider, toProvider, requestId }) {
            if (!requestId) return;

            if (!aiMonitorPlugin.streamCache.has(requestId)) {
                ensureCacheCleanup(aiMonitorPlugin.streamCache);
                aiMonitorPlugin.streamCache.set(requestId, {
                    nativeChunks: [],
                    convertedChunks: [],
                    fromProvider,
                    toProvider,
                    createdAt: Date.now(),
                    nativeCount: 0,
                    convertedCount: 0
                });
            }

            const cache = aiMonitorPlugin.streamCache.get(requestId);
            
            // 过滤 null 值，加入最大缓存数限制以防超长流式响应内存膨胀
            if (nativeChunk != null) {
                const items = Array.isArray(nativeChunk) ? nativeChunk.filter(item => item != null) : [nativeChunk];
                cache.nativeCount = (cache.nativeCount || 0) + items.length;
                if (cache.nativeChunks.length < MAX_CACHED_CHUNKS) {
                    cache.nativeChunks.push(...items.slice(0, MAX_CACHED_CHUNKS - cache.nativeChunks.length));
                }
            }
            
            if (chunkToSend != null) {
                const items = Array.isArray(chunkToSend) ? chunkToSend.filter(item => item != null) : [chunkToSend];
                cache.convertedCount = (cache.convertedCount || 0) + items.length;
                if (cache.convertedChunks.length < MAX_CACHED_CHUNKS) {
                    cache.convertedChunks.push(...items.slice(0, MAX_CACHED_CHUNKS - cache.convertedChunks.length));
                }
            }
        },

        /**
         * 内部请求转换监控
         */
        async onInternalRequestConverted({ requestId, internalRequest, converterName }) {
            setImmediate(() => {
                const reqId = requestId || 'N/A';
                logger.info(`[AI Monitor][${reqId}] >>> Internal Req Converted [${converterName}]: ${JSON.stringify(internalRequest)}`);
            });
        }
    }
};

export default aiMonitorPlugin;
