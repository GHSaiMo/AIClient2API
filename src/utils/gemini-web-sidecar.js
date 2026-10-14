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
    constructor() {
        this.process = null;
        this.port = DEFAULT_PORT;
        this.baseUrl = null;
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
        const arch = process.arch;
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
            if (fs.existsSync(p)) {
                return p;
            }
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
            this.port = options.port || parseInt(process.env.GEMINI_WEB_SIDECAR_PORT, 10) || DEFAULT_PORT;
            this.baseUrl = `http://127.0.0.1:${this.port}`;

            // 1. 检查是否已经有存活的实例
            const isAlreadyUp = await this.checkHealth(1500);
            if (isAlreadyUp) {
                logger.info(`[GeminiWeb-Sidecar] Existing instance detected at ${this.baseUrl}`);
                this.ready = true;
                this.starting = false;
                return true;
            }

            // 2. 查找二进制
            const binaryPath = options.binaryPath || this._findBinary();
            if (!binaryPath) {
                logger.error('[GeminiWeb-Sidecar] Binary not found. Please compile it to gemini-web-sidecar/');
                this.starting = false;
                return false;
            }

            // 3. 准备 Cookie 凭据
            const cookieHeader = await getGeminiWebCookieHeader(options.config || {});
            if (!cookieHeader) {
                logger.error('[GeminiWeb-Sidecar] Failed to obtain valid Google Gemini cookies.');
                this.starting = false;
                return false;
            }

            logger.info(`[GeminiWeb-Sidecar] Starting: ${binaryPath} on port ${this.port}`);

            if (process.platform !== 'win32') {
                try {
                    fs.chmodSync(binaryPath, 0o755);
                } catch (e) {
                    logger.warn(`[GeminiWeb-Sidecar] Failed to chmod binary: ${e.message}`);
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

            this.process = spawn(binaryPath, [], {
                env,
                cwd: path.dirname(binaryPath),
                stdio: ['ignore', 'pipe', 'pipe']
            });

            this.process.stdout.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) logger.info(`[GeminiWeb-Sidecar] ${msg}`);
            });

            this.process.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) logger.warn(`[GeminiWeb-Sidecar] ${msg}`);
            });

            this.process.on('exit', (code, signal) => {
                logger.warn(`[GeminiWeb-Sidecar] Process exited (code=${code}, signal=${signal})`);
                this.process = null;
                this.ready = false;

                if (!this.isShuttingDown && this.restartCount < MAX_RESTART_ATTEMPTS) {
                    this.restartCount++;
                    logger.info(`[GeminiWeb-Sidecar] Restarting in ${RESTART_DELAY}ms (attempt ${this.restartCount}/${MAX_RESTART_ATTEMPTS})`);
                    setTimeout(() => {
                        this.start(options);
                    }, RESTART_DELAY);
                }
            });

            // 4. 等待 Sidecar 初始化就绪
            const maxWaitMs = 20000;
            const startTime = Date.now();
            while (Date.now() - startTime < maxWaitMs) {
                if (!this.process) break;
                const ok = await this.checkHealth(1000);
                if (ok) {
                    logger.info(`[GeminiWeb-Sidecar] Ready and healthy on ${this.baseUrl} (${Date.now() - startTime}ms)`);
                    this.ready = true;
                    this.starting = false;
                    this.restartCount = 0;
                    return true;
                }
                await new Promise(r => setTimeout(r, 600));
            }

            logger.error(`[GeminiWeb-Sidecar] Failed to become ready within ${maxWaitMs}ms`);
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
            logger.info('[GeminiWeb-Sidecar] Stopping process...');
            this.process.kill('SIGTERM');

            await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    if (this.process) {
                        logger.warn('[GeminiWeb-Sidecar] Force killing with SIGKILL');
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

// 单例实例
let instance = null;

export function getGeminiWebSidecar() {
    if (!instance) {
        instance = new GeminiWebSidecar();
    }
    return instance;
}
