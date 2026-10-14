import { UndiciHttpClient } from '../../utils/undici-client.js';
import logger from '../../utils/logger.js';
import { getGeminiWebSidecar } from '../../utils/gemini-web-sidecar.js';

export const GEMINI_WEB_MODELS = [
    'gemini-4-argon'
];

export class GeminiWebCore {
    constructor(config = {}) {
        this.config = config;
        this.uuid = config.uuid || 'gemini-web-default';
        this.sidecar = getGeminiWebSidecar();
        this.port = parseInt(config.port || process.env.GEMINI_WEB_SIDECAR_PORT || '4981', 10);
        this.baseUrl = `http://127.0.0.1:${this.port}`;
        // 使用针对本地 sidecar 的高性能直连 dispatcher
        this.client = new UndiciHttpClient({
            baseURL: this.baseUrl,
            dispatcher: UndiciHttpClient.getLocalDispatcher(),
            timeout: 300000 // 5 分钟超时（针对大模型长思考）
        });
        this.isInitialized = false;
    }

    async initialize() {
        if (this.isInitialized) return;
        logger.info(`[GeminiWebCore] Initializing Gemini Web provider (${this.uuid})...`);
        try {
            await this.sidecar.ensureReady({ config: this.config, port: this.port });
        } catch (e) {
            logger.warn(`[GeminiWebCore] Sidecar startup warning: ${e.message}`);
        }
        this.isInitialized = true;
    }

    /**
     * 仅暴露用户指定的 gemini-4-argon 模型
     */
    async listModels() {
        return {
            object: 'list',
            data: GEMINI_WEB_MODELS.map(id => ({
                id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'google-web',
                display_name: 'Gemini 4 Argon'
            }))
        };
    }

    /**
     * 处理模型名称规范化，锁定在 gemini-4-argon
     */
    _normalizeModel(model) {
        if (!model) return 'gemini-4-argon';
        let cleanModel = model;
        if (cleanModel.startsWith('gemini-web:')) {
            cleanModel = cleanModel.replace('gemini-web:', '');
        }
        if (cleanModel === 'argon' || cleanModel === '4-argon' || cleanModel === 'gemini-4-argon') {
            return 'gemini-4-argon';
        }
        throw new Error(`Provider 'gemini-web' strictly only exposes 'gemini-4-argon' (requested: '${model}'). For other Gemini models, please use antigravity.`);
    }

    /**
     * 一元非流式内容生成
     */
    async generateContent(model, requestBody) {
        await this.sidecar.ensureReady({ config: this.config, port: this.port });
        const targetModel = this._normalizeModel(model);

        const payload = {
            ...requestBody,
            model: targetModel,
            stream: false
        };

        logger.debug(`[GeminiWebCore] Sending unary request to sidecar for model: ${targetModel}`);
        const response = await this.client.request({
            method: 'POST',
            url: '/openai/v1/chat/completions',
            data: payload,
            headers: {
                'Content-Type': 'application/json'
            }
        });

        return response.data;
    }

    /**
     * 流式内容生成
     */
    async *generateContentStream(model, requestBody) {
        await this.sidecar.ensureReady({ config: this.config, port: this.port });
        const targetModel = this._normalizeModel(model);

        const payload = {
            ...requestBody,
            model: targetModel,
            stream: true
        };

        logger.debug(`[GeminiWebCore] Sending stream request to sidecar for model: ${targetModel}`);
        const response = await this.client.request({
            method: 'POST',
            url: '/openai/v1/chat/completions',
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
                        // 忽略格式解析残缺
                    }
                }
            }
        }
    }

    isExpiryDateNear() {
        return false;
    }

    async refreshToken() {
        return await this.sidecar.checkHealth();
    }

    async forceRefreshToken() {
        return await this.sidecar.checkHealth();
    }
}
