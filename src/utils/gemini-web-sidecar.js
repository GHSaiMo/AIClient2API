import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import logger from './logger.js';
import { getGeminiWebCookieHeader } from './gemini-cookie-extractor.js';

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFilePath);

const DEFAULT_PORT = 4981;
const HEALTH_CHECK_TIMEOUT = 3000;
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY = 2000;

class GeminiWebSidecar {
    constructor(port = DEFAULT_PORT) {
        this.process = null;
        this.port = port;
        this.baseUrl = `http://127.0.0.1:${port}`;
        this.ready = false;
        this.starting = false;
        this.startPromise = null;
        this.restartCount = 0;
        this.isShuttingDown = false;
    }

    /**
     * 查找适合当前平台的 Sidecar 二进制
     * @returns {string|null}
     */
    _findBinary() {
        const platform = process.platform;
        const arch = process.arch === 'x64' ? 'amd64' : process.arch;
        const ext = platform === 'win32' ? '.exe' : '';
        const projectRoot = path.resolve(currentDir, '../..');

        const candidates = [
            path.join(projectRoot, 'gemini-web-sidecar', `gemini-web-sidecar-${platform}-${arch}${ext}`),
            path.join(projectRoot, `gemini-web-sidecar-${platform}-${arch}${ext}`),
            path.join(projectRoot, 'gemini-web-sidecar', `gemini-web-sidecar${ext}`),
            path.join(projectRoot, `gemini-web-sidecar${ext}`),
            path.join(projectRoot, 'gemini-web-to-api', 'bin', `gemini-server${ext}`),
            path.join('/usr', 'local', 'bin', `gemini-web-sidecar${ext}`),
            path.join('/app', 'gemini-web-sidecar', `gemini-web-sidecar${ext}`),
        ];

        for (const p of candidates) {
            try {
                if (fs.existsSync(p) && fs.statSync(p).isFile()) {
                    return p;
                }
            } catch {}
        }
        return null;
    }

    /**
     * 检查 Sidecar 健康状态
     * @param {number} timeoutMs 
     * @returns {Promise<boolean>}
     */
    async checkHealth(timeoutMs = HEALTH_CHECK_TIMEOUT) {
        return new Promise((resolve) => {
            const req = http.get(`${this.baseUrl}/openai/v1/models`, { timeout: timeoutMs }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        return resolve(false);
                    }
                    try {
                        const json = JSON.parse(data);
                        // 必须等待 Gemini provider 完成 Google Web 握手并成功发现可用模型
                        resolve(Array.isArray(json.data) && json.data.length > 0);
                    } catch {
                        resolve(false);
                    }
                });
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
        });
    }

    /**
     * 启动 Sidecar 进程
     * @param {Object} options 
     * @returns {Promise<boolean>}
     */
    async start(options = {}) {
        if (this.ready) return true;
        if (this.starting) return this.startPromise;

        this.starting = true;
        this.startPromise = (async () => {
            this.port = options.port || this.port || parseInt(process.env.GEMINI_WEB_SIDECAR_PORT, 10) || DEFAULT_PORT;
            this.baseUrl = `http://127.0.0.1:${this.port}`;

            // 1. 检查是否已经有存活的实例
            const isAlreadyUp = await this.checkHealth(1500);
            if (isAlreadyUp) {
                logger.info(`[GeminiWeb-Sidecar:${this.port}] Existing instance detected at ${this.baseUrl}`);
                this.ready = true;
                this.starting = false;
                return true;
            }

            // 2. 查找二进制
            const binaryPath = options.binaryPath || this._findBinary();
            if (!binaryPath) {
                logger.error(`[GeminiWeb-Sidecar:${this.port}] Binary not found. Please compile it to gemini-web-sidecar/`);
                this.starting = false;
                return false;
            }

            // 3. 准备 Cookie 凭据
            const cookieHeader = await getGeminiWebCookieHeader(options.config || {});
            if (!cookieHeader) {
                logger.error(`[GeminiWeb-Sidecar:${this.port}] Failed to obtain valid Google Gemini cookies.`);
                this.starting = false;
                return false;
            }

            logger.info(`[GeminiWeb-Sidecar:${this.port}] Starting: ${binaryPath} on port ${this.port}`);

            if (process.platform !== 'win32') {
                try {
                    fs.chmodSync(binaryPath, 0o755);
                } catch (e) {
                    logger.warn(`[GeminiWeb-Sidecar:${this.port}] Failed to chmod binary: ${e.message}`);
                }
            }

            const env = {
                ...process.env,
                PORT: String(this.port),
                GEMINI_COOKIES: cookieHeader,
                APP_ENV: 'production',
                LOG_LEVEL: 'info',
                RATE_LIMIT_ENABLED: 'false'
            };

            if (options.config?.authUser !== undefined && options.config?.authUser !== null) {
                env.GEMINI_AUTH_USER = String(options.config.authUser);
            }

            const proxyUrl = process.env.PROXY_URL || 
                             options.config?.PROXY_URL || 
                             (process.platform === 'linux' ? 'socks5://192.168.50.9:7898' : '');
            if (proxyUrl) {
                env.PROXY_URL = proxyUrl;
                env.HTTP_PROXY = proxyUrl;
                env.HTTPS_PROXY = proxyUrl;
                env.ALL_PROXY = proxyUrl;
                env.http_proxy = proxyUrl;
                env.https_proxy = proxyUrl;
                env.all_proxy = proxyUrl;
            }

            this.process = spawn(binaryPath, [], {
                env,
                cwd: path.dirname(binaryPath),
                stdio: ['ignore', 'pipe', 'pipe']
            });

            this.process.stdout.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) logger.info(`[GeminiWeb-Sidecar:${this.port}] ${msg}`);
            });

            this.process.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) logger.warn(`[GeminiWeb-Sidecar:${this.port}] ${msg}`);
            });

            this.process.on('exit', (code, signal) => {
                logger.warn(`[GeminiWeb-Sidecar:${this.port}] Process exited (code=${code}, signal=${signal})`);
                this.process = null;
                this.ready = false;

                if (!this.isShuttingDown && this.restartCount < MAX_RESTART_ATTEMPTS) {
                    this.restartCount++;
                    logger.info(`[GeminiWeb-Sidecar:${this.port}] Restarting in ${RESTART_DELAY}ms (attempt ${this.restartCount}/${MAX_RESTART_ATTEMPTS})`);
                    setTimeout(() => {
                        this.start(options);
                    }, RESTART_DELAY);
                }
            });

            // 4. 等待 Sidecar 初始化就绪
            const maxWaitMs = 25000;
            const startTime = Date.now();
            while (Date.now() - startTime < maxWaitMs) {
                if (!this.process) break;
                const ok = await this.checkHealth(1000);
                if (ok) {
                    logger.info(`[GeminiWeb-Sidecar:${this.port}] Ready and healthy on ${this.baseUrl} (${Date.now() - startTime}ms)`);
                    this.ready = true;
                    this.starting = false;
                    this.restartCount = 0;
                    return true;
                }
                await new Promise(r => setTimeout(r, 600));
            }

            logger.error(`[GeminiWeb-Sidecar:${this.port}] Failed to become ready within ${maxWaitMs}ms`);
            this.starting = false;
            return false;
        })();

        return this.startPromise;
    }

    /**
     * 确保 Sidecar 处于就绪状态
     */
    async ensureReady(options = {}) {
        if (this.ready) return true;
        return this.start(options);
    }

    /**
     * 优雅停止 Sidecar
     */
    async stop() {
        this.isShuttingDown = true;
        if (this.process) {
            logger.info(`[GeminiWeb-Sidecar:${this.port}] Stopping process...`);
            this.process.kill('SIGTERM');

            await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    if (this.process) {
                        logger.warn(`[GeminiWeb-Sidecar:${this.port}] Force killing with SIGKILL`);
                        this.process.kill('SIGKILL');
                    }
                    resolve();
                }, 3000);

                if (this.process) {
                    this.process.once('exit', () => {
                        clearTimeout(timer);
                        resolve();
                    });
                } else {
                    clearTimeout(timer);
                    resolve();
                }
            });

            this.process = null;
            this.ready = false;
        }
    }
}

// 多端口 Sidecar 实例映射表
const sidecarInstances = new Map();

/**
 * 获取指定端口的 Sidecar 管理实例 (默认为 DEFAULT_PORT 4981)
 * @param {number|string} [port] 
 * @returns {GeminiWebSidecar}
 */
export function getGeminiWebSidecar(port = DEFAULT_PORT) {
    const numPort = parseInt(port || DEFAULT_PORT, 10);
    if (!sidecarInstances.has(numPort)) {
        sidecarInstances.set(numPort, new GeminiWebSidecar(numPort));
    }
    return sidecarInstances.get(numPort);
}

/**
 * 停止所有已启动的 Sidecar 实例
 */
export async function stopAllGeminiWebSidecars() {
    for (const [port, sidecar] of sidecarInstances.entries()) {
        try {
            await sidecar.stop();
        } catch (e) {
            logger.warn(`[GeminiWeb-Sidecar:${port}] Stop failed: ${e.message}`);
        }
    }
    sidecarInstances.clear();
}
