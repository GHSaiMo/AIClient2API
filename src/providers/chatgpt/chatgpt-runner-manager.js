import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger.js';

class ChatGPTRunnerManager {
    constructor() {
        this.process = null;
        this.port = parseInt(process.env.CHATGPT_RUNNER_PORT || '9092', 10);
        this.host = process.env.CHATGPT_RUNNER_HOST || '127.0.0.1';
        this.baseUrl = `http://${this.host}:${this.port}`;
        this.ready = false;
        this.starting = false;
        this.startPromise = null;
        this.scriptPath = path.resolve(process.cwd(), 'src/providers/chatgpt/chatgpt-runner.py');
    }

    findPythonPath() {
        const candidatePaths = [
            '/Users/hal9000/Projects/chatgpt2api/.venv/bin/python',
            path.resolve(process.cwd(), '../chatgpt2api/.venv/bin/python'),
            path.resolve(process.cwd(), '.venv/bin/python'),
            'python3',
            'python'
        ];

        for (const candidate of candidatePaths) {
            if (candidate.startsWith('/') || candidate.startsWith('.')) {
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            } else {
                return candidate;
            }
        }
        return 'python3';
    }

    async checkHealth(timeoutMs = 1000) {
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
            // 1. First check if runner is already listening on this.port
            const alreadyHealthy = await this.checkHealth(1500);
            if (alreadyHealthy) {
                logger.info(`[ChatGPT Runner] Found existing runner active on ${this.baseUrl}`);
                this.ready = true;
                this.starting = false;
                return true;
            }

            const pythonPath = this.findPythonPath();
            logger.info(`[ChatGPT Runner] Spawning runner on port ${this.port} using: ${pythonPath}`);

            const env = {
                ...process.env,
                CHATGPT_RUNNER_PORT: String(this.port),
                CHATGPT_RUNNER_HOST: this.host,
                PYTHONUNBUFFERED: '1'
            };

            this.process = spawn(pythonPath, [this.scriptPath], {
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: false
            });

            this.process.stdout.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) logger.debug(`[ChatGPT Runner stdout] ${msg}`);
            });

            this.process.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) logger.warn(`[ChatGPT Runner stderr] ${msg}`);
            });

            this.process.on('exit', (code, signal) => {
                logger.warn(`[ChatGPT Runner] Process exited with code: ${code}, signal: ${signal}`);
                this.ready = false;
                this.process = null;
            });

            // 2. Poll health until ready
            const maxWait = 10000;
            const start = Date.now();
            while (Date.now() - start < maxWait) {
                await new Promise((r) => setTimeout(r, 400));
                const ok = await this.checkHealth(800);
                if (ok) {
                    logger.info(`[ChatGPT Runner] Runner is online and healthy on ${this.baseUrl}`);
                    this.ready = true;
                    this.starting = false;
                    return true;
                }
            }

            this.starting = false;
            logger.error(`[ChatGPT Runner] Timed out waiting for runner on ${this.baseUrl}`);
            return false;
        })();

        return this.startPromise;
    }

    async ensureReady() {
        if (!this.ready) {
            await this.start();
        }
        return this.ready;
    }

    stop() {
        if (this.process) {
            try {
                this.process.kill('SIGTERM');
            } catch (e) {
                logger.warn(`[ChatGPT Runner] Error killing runner process: ${e.message}`);
            }
            this.process = null;
            this.ready = false;
        }
    }
}

let instance = null;

export function getChatGPTRunnerManager() {
    if (!instance) {
        instance = new ChatGPTRunnerManager();
    }
    return instance;
}

export default getChatGPTRunnerManager;
