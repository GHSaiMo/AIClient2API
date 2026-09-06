import { existsSync, readFileSync } from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { CONFIG } from '../core/config-manager.js';
import { MODEL_PROVIDER } from '../utils/constants.js';
import {
    getConfiguredSupportedModels,
    getCustomModelConfig,
    PROVIDER_MODELS
} from '../providers/provider-models.js';

let cachedAppVersion = null;

/**
 * Read application version from VERSION file or fallback
 */
export function getAppVersion() {
    if (cachedAppVersion) return cachedAppVersion;
    try {
        const versionFilePath = path.join(process.cwd(), 'VERSION');
        if (existsSync(versionFilePath)) {
            cachedAppVersion = readFileSync(versionFilePath, 'utf8').trim();
            return cachedAppVersion;
        }
    } catch {
        // ignore
    }
    try {
        const pkgPath = path.join(process.cwd(), 'package.json');
        if (existsSync(pkgPath)) {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
            cachedAppVersion = pkg.version || 'unknown';
            return cachedAppVersion;
        }
    } catch {
        // ignore
    }
    cachedAppVersion = '3.4.2.1';
    return cachedAppVersion;
}

/**
 * Estimate or retrieve the model context length
 * @param {string} modelId
 * @param {string} [providerType]
 * @returns {number}
 */
export function getEstimatedModelContextLength(modelId, providerType = null) {
    try {
        const customConfig = getCustomModelConfig(modelId, providerType);
        if (customConfig?.contextLength && typeof customConfig.contextLength === 'number') {
            return customConfig.contextLength;
        }
    } catch {
        // ignore
    }
    const lower = (modelId || '').toLowerCase();
    if (lower.includes('gemini')) {
        if (lower.includes('pro')) return 2097152;
        return 1048576;
    }
    if (lower.includes('claude')) {
        if (lower.includes('1m') || lower.includes('1-m')) return 1000000;
        return 200000;
    }
    if (lower.includes('grok')) return 131072;
    if (lower.includes('deepseek')) return 65536;
    if (lower.includes('gpt-4') || lower.includes('o1') || lower.includes('o3') || lower.includes('o4')) return 128000;
    return 1048576;
}

/**
 * Checks whether the incoming request is from Hermes Agent or Hermes CLI
 * @param {http.IncomingMessage} req
 * @returns {boolean}
 */
export function isHermesClient(req) {
    const userAgent = (req?.headers?.['user-agent'] || '').toLowerCase();
    return (
        userAgent.includes('hermes') ||
        userAgent.includes('python-httpx') ||
        userAgent.includes('python-requests') ||
        userAgent.includes('python-urllib')
    );
}

/**
 * Checks whether a request is a probe request from Hermes (or an unauthenticated client probe)
 * @param {string} method
 * @param {string} reqPath
 * @param {http.IncomingMessage} [req]
 * @returns {boolean}
 */
export function isHermesProbeRequest(method, reqPath, req = null) {
    if (method !== 'GET' || !req) return false;

    const isModelPath = (
        reqPath === '/v1/models' ||
        reqPath === '/api/v1/models' ||
        reqPath.startsWith('/v1/models/') ||
        reqPath.startsWith('/api/v1/models/') ||
        reqPath === '/v1beta/models' ||
        reqPath.startsWith('/v1beta/models/')
    );

    if (!isModelPath) return false;

    // If it's a Hermes client, it's always treated as a Hermes probe
    if (isHermesClient(req)) return true;

    // If unauthenticated, treat as model probe to avoid 401
    const hasAuth = Boolean(
        req?.headers?.['authorization'] ||
        req?.headers?.['x-api-key'] ||
        req?.headers?.['x-goog-api-key']
    );

    return !hasAuth;
}

/**
 * Checks whether a request path is a known client probe endpoint
 * @param {string} method - HTTP method
 * @param {string} reqPath - Normalized request path
 * @param {http.IncomingMessage} [req] - HTTP request
 * @returns {boolean}
 */
export function isClientProbePath(method, reqPath, req = null) {
    if (method === 'GET') {
        if (
            reqPath === '/version' ||
            reqPath === '/api/version' ||
            reqPath === '/props' ||
            reqPath === '/v1/props' ||
            reqPath === '/api/tags' ||
            reqPath === '/api/ps'
        ) {
            return true;
        }
        if (isHermesProbeRequest(method, reqPath, req)) {
            return true;
        }
    }
    if (method === 'POST') {
        return reqPath === '/api/show';
    }
    return false;
}

/**
 * Handle Hermes model probe requests (e.g. GET /v1/models, GET /v1/models/:model)
 * @param {string} method
 * @param {string} reqPath
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {Object} [currentConfig]
 * @param {Object} [providerPoolManager]
 * @returns {boolean}
 */
export function handleHermesModelProbe(method, reqPath, req, res, currentConfig = null, providerPoolManager = null) {
    const activeConfig = currentConfig || CONFIG;
    const provider = activeConfig?.MODEL_PROVIDER || MODEL_PROVIDER.GEMINI_ANTIGRAVITY;
    const isSingleModel = reqPath.startsWith('/v1/models/') || reqPath.startsWith('/api/v1/models/');
    const isModelList = reqPath === '/v1/models' || reqPath === '/api/v1/models' || reqPath === '/v1beta/models';

    if (isSingleModel) {
        const modelId = reqPath.replace(/^\/(?:api\/)?v1\/models\//, '');
        const ctx = getEstimatedModelContextLength(modelId, provider);
        const modelResponse = {
            id: modelId,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: provider || 'system',
            context_length: ctx,
            max_input_tokens: ctx,
            max_tokens: 65536
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(modelResponse));
        logger.info(`[Probe] Handled Hermes model detail probe: ${reqPath} (model: ${modelId}, context_length: ${ctx})`);
        return true;
    }

    if (isModelList) {
        let models = [];
        try {
            if (providerPoolManager && typeof providerPoolManager.getProviderPool === 'function') {
                const pool = providerPoolManager.getProviderPool(provider);
                if (pool && Array.isArray(pool) && pool.length > 0) {
                    models = [...new Set(pool.flatMap(p => getConfiguredSupportedModels(provider, p.config)))];
                }
            }
            if (!models || models.length === 0) {
                models = getConfiguredSupportedModels(provider, activeConfig);
            }
        } catch {
            // fallback
        }
        if (!models || models.length === 0) {
            models = PROVIDER_MODELS[provider] || ['gemini-3.8-flash'];
        }

        const responseData = {
            object: 'list',
            data: models.map(m => {
                const ctx = getEstimatedModelContextLength(m, provider);
                return {
                    id: m,
                    object: 'model',
                    created: Math.floor(Date.now() / 1000),
                    owned_by: provider || 'system',
                    context_length: ctx,
                    max_input_tokens: ctx,
                    max_tokens: 65536
                };
            })
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
        logger.info(`[Probe] Handled Hermes model list probe: ${reqPath} (${models.length} models for ${provider})`);
        return true;
    }

    return false;
}

/**
 * Handle known client probe requests (Ollama, llama.cpp, web UI version probes, Hermes model probes)
 * with lightweight, standard-compliant responses to prevent 401/404 log noise.
 * @param {string} method - HTTP method
 * @param {string} reqPath - Normalized request path
 * @param {http.IncomingMessage} req - HTTP request
 * @param {http.ServerResponse} res - HTTP response
 * @param {Object} [currentConfig] - Server config
 * @param {Object} [providerPoolManager] - Pool manager
 * @returns {boolean} - true if the probe was handled
 */
export function handleClientProbeRequest(method, reqPath, req, res, currentConfig = null, providerPoolManager = null) {
    if (method === 'GET') {
        if (reqPath === '/version' || reqPath === '/api/version') {
            const version = getAppVersion();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ version, status: 'ok' }));
            logger.debug(`[Probe] Handled version probe: ${reqPath} -> ${version}`);
            return true;
        }

        if (reqPath === '/props' || reqPath === '/v1/props') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                default_generation_settings: {
                    n_ctx: 1048576
                },
                total_slots: 1,
                status: 'ok'
            }));
            logger.debug(`[Probe] Handled props probe: ${reqPath}`);
            return true;
        }

        if (reqPath === '/api/tags') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: [] }));
            logger.debug(`[Probe] Handled Ollama tags probe: ${reqPath}`);
            return true;
        }

        if (reqPath === '/api/ps') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: [] }));
            logger.debug(`[Probe] Handled Ollama ps probe: ${reqPath}`);
            return true;
        }

        // Hermes and unauthenticated model probes
        if (isHermesProbeRequest(method, reqPath, req)) {
            return handleHermesModelProbe(method, reqPath, req, res, currentConfig, providerPoolManager);
        }
    }

    if (method === 'POST' && reqPath === '/api/show') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            license: '',
            modelfile: '',
            parameters: '',
            template: '',
            system: '',
            details: {
                parent_model: '',
                format: 'gguf',
                family: 'llama',
                families: ['llama'],
                parameter_size: '7B',
                quantization_level: 'Q4_0'
            },
            model_info: {}
        }));
        logger.debug(`[Probe] Handled Ollama show probe: ${reqPath}`);
        return true;
    }

    return false;
}
