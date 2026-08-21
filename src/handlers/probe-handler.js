import { existsSync, readFileSync } from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

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
 * Checks whether a request path is a known client probe endpoint
 * @param {string} method - HTTP method
 * @param {string} reqPath - Normalized request path
 * @returns {boolean}
 */
export function isClientProbePath(method, reqPath) {
    if (method === 'GET') {
        return (
            reqPath === '/version' ||
            reqPath === '/api/version' ||
            reqPath === '/props' ||
            reqPath === '/v1/props' ||
            reqPath === '/api/tags' ||
            reqPath === '/api/ps'
        );
    }
    if (method === 'POST') {
        return reqPath === '/api/show';
    }
    return false;
}

/**
 * Handle known client probe requests (Ollama, llama.cpp, web UI version probes)
 * with lightweight, standard-compliant responses to prevent 401/404 log noise.
 * @param {string} method - HTTP method
 * @param {string} reqPath - Normalized request path
 * @param {http.IncomingMessage} req - HTTP request
 * @param {http.ServerResponse} res - HTTP response
 * @returns {boolean} - true if the probe was handled
 */
export function handleClientProbeRequest(method, reqPath, req, res) {
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
                default_generation_settings: {},
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
