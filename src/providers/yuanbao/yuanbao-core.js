import { UndiciHttpClient } from '../../utils/undici-client.js';
import logger from '../../utils/logger.js';
import { yuanbaoRunnerManager } from './yuanbao-runner-manager.js';
import { refreshYuanbaoToken } from './yuanbao-token-refresher.js';

export const YUANBAO_MODELS = [
    'yuanbao-hunyuan',
    'yuanbao-deepseek-r1',
    'yuanbao-deepseek-v3',
    'yuanbao'
];

export class YuanbaoWebService {
    constructor(config = {}) {
        this.config = config;
        this.uuid = config.uuid || 'yuanbao-web-default';
        this.runner = yuanbaoRunnerManager;
        this.baseUrl = this.runner.baseUrl;
        this.client = new UndiciHttpClient({
            baseURL: this.baseUrl,
            dispatcher: UndiciHttpClient.getLocalDispatcher(),
            timeout: 300000 // 5 分钟长超时（针对视频长分析）
        });
        this.isInitialized = false;
    }

    async initialize() {
        if (this.isInitialized) return;
        logger.info(`[YuanbaoWebService] Initializing Yuanbao Web provider (${this.uuid})...`);
        try {
            await this.runner.ensureReady();
        } catch (e) {
            logger.warn(`[YuanbaoWebService] Runner startup warning: ${e.message}`);
        }
        this.isInitialized = true;
    }

    async listModels() {
        return {
            object: 'list',
            data: YUANBAO_MODELS.map(id => ({
                id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'tencent-yuanbao',
                display_name: `Tencent Yuanbao (${id})`
            }))
        };
    }

    _normalizeModel(model) {
        if (!model) return 'yuanbao-hunyuan';
        let clean = model;
        if (clean.startsWith('yuanbao-web:')) {
            clean = clean.replace('yuanbao-web:', '');
        }
        if (clean.startsWith('yuanbao:')) {
            clean = clean.replace('yuanbao:', '');
        }
        if (clean === 'yuanbao' || clean === 'hunyuan' || clean === 'yuanbao-hunyuan') {
            return 'yuanbao-hunyuan';
        }
        if (clean.includes('r1') || clean.includes('deepseek-r1')) {
            return 'yuanbao-deepseek-r1';
        }
        if (clean.includes('v3') || clean.includes('deepseek-v3')) {
            return 'yuanbao-deepseek-v3';
        }
        return 'yuanbao-hunyuan';
    }

    async generateContent(model, requestBody) {
        await this.runner.ensureReady();
        const targetModel = this._normalizeModel(model);

        const payload = {
            ...requestBody,
            model: targetModel,
            stream: false
        };

        logger.debug(`[YuanbaoWebService] Sending unary request to runner for model: ${targetModel}`);
        const response = await this.client.request({
            method: 'POST',
            url: '/v1/chat/completions',
            data: payload,
            headers: {
                'Content-Type': 'application/json'
            }
        });

        return response.data;
    }

    async *generateContentStream(model, requestBody) {
        await this.runner.ensureReady();
        const targetModel = this._normalizeModel(model);

        const payload = {
            ...requestBody,
            model: targetModel,
            stream: true
        };

        logger.debug(`[YuanbaoWebService] Sending stream request to runner for model: ${targetModel}`);
        const response = await this.client.request({
            method: 'POST',
            url: '/v1/chat/completions',
            data: payload,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
            },
            responseType: 'stream'
        });

        const stream = response.data;
        let buffer = '';

        for await (const chunk of stream) {
            buffer += chunk.toString('utf-8');
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(':')) continue;

                if (trimmed.startsWith('data: ')) {
                    const dataStr = trimmed.slice(6).trim();
                    if (dataStr === '[DONE]') {
                        return;
                    }
                    try {
                        const parsed = JSON.parse(dataStr);
                        yield parsed;
                    } catch {
                        // ignore malformed lines
                    }
                }
            }
        }
    }

    isExpiryDateNear() {
        return false;
    }

    async refreshToken() {
        try {
            await refreshYuanbaoToken(this.config);
            return await this.runner.checkHealth();
        } catch {
            return false;
        }
    }

    async forceRefreshToken() {
        return await this.refreshToken();
    }
}
