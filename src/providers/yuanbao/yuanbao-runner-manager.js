import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger.js';

function findEgoBrowserBinary() {
    const candidates = [
        path.join(process.env.HOME || '', '.local/bin/ego-browser'),
        '/Users/hal9000/.local/bin/ego-browser',
        '/usr/local/bin/ego-browser',
        'ego-browser'
    ];
    for (const c of candidates) {
        if (c.startsWith('/') && fs.existsSync(c)) return c;
    }
    return 'ego-browser';
}

class YuanbaoRunnerManager {
    constructor() {
        this.process = null;
        this.port = parseInt(process.env.YUANBAO_RUNNER_PORT || '9094', 10);
        // 如果在 Linux 环境（如飞牛 NAS），默认目标是 Mac 宿主机 IP: 192.168.50.9
        const defaultHost = process.platform === 'linux' ? '192.168.50.9' : '127.0.0.1';
        this.host = process.env.YUANBAO_RUNNER_HOST || defaultHost;
        this.baseUrl = process.env.YUANBAO_RUNNER_URL || `http://${this.host}:${this.port}`;
        this.ready = false;
        this.starting = false;
        this.startPromise = null;
        this.scriptPath = path.resolve(process.cwd(), 'src/providers/yuanbao/yuanbao-runner.js');
    }

    async checkHealth(timeoutMs = 1500) {
        return new Promise((resolve) => {
            const req = http.get(`${this.baseUrl}/health`, { timeout: timeoutMs }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve(json.status === 'ok');
                    } catch {
                        resolve(false);
                    }
                });
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
    }

    async start() {
        if (this.ready) return true;
        if (this.starting) return this.startPromise;

        this.starting = true;
        this.startPromise = (async () => {
            // 1. First check if runner is already listening on this.baseUrl
            const alreadyHealthy = await this.checkHealth(1500);
            if (alreadyHealthy) {
                logger.info(`[Yuanbao Runner] Found existing runner active on ${this.baseUrl}`);
                this.ready = true;
                this.starting = false;
                return true;
            }

            // 2. If running on Linux (NAS), runner cannot be spawned locally (no browser)
            // It expects the Mac host to be running the runner on LAN
            if (process.platform === 'linux') {
                logger.warn(`[Yuanbao Runner] Running on Linux/NAS. Expecting Mac host runner at ${this.baseUrl}`);
                for (let i = 0; i < 5; i++) {
                    if (await this.checkHealth(1000)) {
                        this.ready = true;
                        this.starting = false;
                        return true;
                    }
                    await new Promise(r => setTimeout(r, 1000));
                }
                logger.error(`[Yuanbao Runner] Cannot connect to Mac Yuanbao runner at ${this.baseUrl}`);
                this.starting = false;
                return false;
            }

            // 3. Spawning on Mac via ego-browser nodejs
            const egoBin = findEgoBrowserBinary();
            logger.info(`[Yuanbao Runner] Spawning runner on port ${this.port} via ${egoBin}...`);

            const env = {
                ...process.env,
                PATH: `/Users/hal9000/.local/bin:${process.env.PATH || ''}`,
                YUANBAO_RUNNER_PORT: String(this.port),
                YUANBAO_RUNNER_HOST: '0.0.0.0'
            };

            const inFd = fs.openSync(this.scriptPath, 'r');

            this.process = spawn(egoBin, ['nodejs'], {
                stdio: [inFd, 'pipe', 'pipe'],
                env,
                detached: false
            });

            this.process.stdout.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) logger.debug(`[Yuanbao Runner stdout] ${msg}`);
            });

            this.process.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) logger.warn(`[Yuanbao Runner stderr] ${msg}`);
            });

            this.process.on('exit', (code, signal) => {
                logger.warn(`[Yuanbao Runner] Process exited with code=${code}, signal=${signal}`);
                this.ready = false;
                this.process = null;
            });

            // 4. Poll health check until ready (up to 20s)
            for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 1000));
                if (await this.checkHealth(1000)) {
                    logger.info(`[Yuanbao Runner] Runner is healthy and ready on ${this.baseUrl}`);
                    this.ready = true;
                    this.starting = false;
                    return true;
                }
            }

            this.starting = false;
            throw new Error(`[Yuanbao Runner] Timeout waiting for runner to become healthy on ${this.baseUrl}`);
        })();

        return this.startPromise;
    }

    async ensureReady() {
        if (await this.checkHealth(1000)) {
            this.ready = true;
            return true;
        }
        return this.start();
    }
}

export const yuanbaoRunnerManager = new YuanbaoRunnerManager();
