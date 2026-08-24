import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';
import { MODEL_PROVIDER, MODEL_PROTOCOL_PREFIX, isRetryableNetworkError, formatExpiryLog } from '../../utils/common.js';
import { refreshAccessToken, fetchUserInfo, isJwtExpiredOrNear, decodeJwtPayload } from './chatgpt-token-service.js';
import { getProviderPoolManager } from '../../services/service-manager.js';
import { getChatGPTRunnerManager } from './chatgpt-runner-manager.js';

export const CHATGPT_WEB_MODELS = [
    'gpt-image-2',
    'gpt-5',
    'gpt-5-1',
    'gpt-5-2',
    'gpt-5-3',
    'gpt-5-mini',
    'auto'
];

export class ImageContentPolicyError extends Error {
    constructor(message, conversationId = '') {
        super(message || 'Image generation blocked by content policy');
        this.name = 'ImageContentPolicyError';
        this.conversationId = conversationId;
        this.isPolicyError = true;
    }
}

export class ChatGPTWebService {
    constructor(config) {
        this.config = config || {};
        this.uuid = this.config.uuid || null;
        this.accessToken = this.config.access_token || this.config.accessToken || this.config.token || null;
        this.refreshTokenValue = this.config.refresh_token || this.config.refreshToken || null;
        this.email = this.config.email || null;
        this.accountType = this.config.accountType || this.config.type || 'free';
        this.quota = typeof this.config.quota === 'number' ? this.config.quota : null;
        this.restoreAt = this.config.restore_at || this.config.restoreAt || null;
        this.proxyUrl = this.config.PROXY_URL || this.config.proxy || null;
        this.runner = getChatGPTRunnerManager();
        this.isInitialized = false;
    }

    async initialize() {
        if (this.isInitialized) return;
        logger.info(`[ChatGPT Web] Initializing ChatGPT Web service (uuid: ${this.uuid || 'default'})...`);

        if (this.accessToken && !this.email) {
            const jwt = decodeJwtPayload(this.accessToken);
            this.email = jwt['https://api.openai.com/profile']?.email || jwt.email || null;
        }

        try {
            await this.runner.ensureReady();
        } catch (e) {
            logger.warn(`[ChatGPT Web] Failed to start runner on initialize: ${e.message}`);
        }

        this.isInitialized = true;
    }

    isExpiryDateNear() {
        if (!this.accessToken) return true;
        return isJwtExpiredOrNear(this.accessToken);
    }

    triggerBackgroundRefresh() {
        if (!this.refreshTokenValue) {
            logger.warn(`[ChatGPT Web] No refresh_token for ${this.email || this.uuid}, cannot refresh.`);
            return;
        }
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            logger.info(`[ChatGPT Web] Marking credential ${this.uuid} for background refresh`);
            poolManager.markProviderNeedRefresh(MODEL_PROVIDER.CHATGPT_WEB, { uuid: this.uuid });
        }
    }

    async refreshAccessToken() {
        if (!this.refreshTokenValue) {
            throw new Error(`Cannot refresh token for ${this.email || this.uuid}: refresh_token is missing.`);
        }
        try {
            logger.info(`[ChatGPT Web] Refreshing token for ${this.email || this.uuid}...`);
            const tokens = await refreshAccessToken(this.refreshTokenValue, this.proxyUrl);
            this.accessToken = tokens.access_token;
            if (tokens.refresh_token) {
                this.refreshTokenValue = tokens.refresh_token;
            }
            logger.info(`[ChatGPT Web] Token refreshed successfully for ${this.email || this.uuid}`);

            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                poolManager.resetProviderRefreshStatus(MODEL_PROVIDER.CHATGPT_WEB, this.uuid);
            }
            return tokens;
        } catch (error) {
            logger.error(`[ChatGPT Web] Refresh token failed for ${this.email || this.uuid}: ${error.message}`);
            throw error;
        }
    }

    async getUsageLimits() {
        if (!this.accessToken) return null;
        try {
            await this.runner.ensureReady();
            const userInfo = await fetchUserInfo(this.accessToken, this.proxyUrl);
            if (userInfo) {
                this.quota = userInfo.quota;
                this.restoreAt = userInfo.restore_at;
                this.email = userInfo.email || this.email;
                this.accountType = userInfo.type || this.accountType;
                return {
                    quota: this.quota,
                    restore_at: this.restoreAt,
                    email: this.email,
                    accountType: this.accountType,
                    status: userInfo.status
                };
            }
            return null;
        } catch (error) {
            logger.warn(`[ChatGPT Web] Failed to fetch usage limits: ${error.message}`);
            return null;
        }
    }

    _extractPrompt(requestBody) {
        if (typeof requestBody === 'string') return requestBody;
        if (requestBody.prompt) return String(requestBody.prompt);
        if (Array.isArray(requestBody.messages) && requestBody.messages.length > 0) {
            const lastMsg = requestBody.messages[requestBody.messages.length - 1];
            if (typeof lastMsg.content === 'string') return lastMsg.content;
            if (Array.isArray(lastMsg.content)) {
                for (const part of lastMsg.content) {
                    if (part.type === 'text' || part.type === 'input_text') return part.text || '';
                }
            }
        }
        if (Array.isArray(requestBody.input) && requestBody.input.length > 0) {
            const lastInput = requestBody.input[requestBody.input.length - 1];
            if (typeof lastInput.content === 'string') return lastInput.content;
            if (Array.isArray(lastInput.content)) {
                for (const part of lastInput.content) {
                    if (part.type === 'text' || part.type === 'input_text') return part.text || '';
                }
            }
        }
        return '';
    }

    async generateContent(model, requestBody) {
        await this.initialize();
        const runnerReady = await this.runner.ensureReady();
        if (!runnerReady) {
            throw new Error('ChatGPT-Web Python runner service is unavailable');
        }

        const isImageModel = model === 'gpt-image-2' || (requestBody.model && requestBody.model.includes('image'));
        const prompt = this._extractPrompt(requestBody);

        if (isImageModel || prompt) {
            logger.info(`[ChatGPT Web] Generating image via chatgpt2api runner: model=${model}, prompt="${prompt.slice(0, 40)}..."`);
            try {
                const res = await axios.post(`${this.runner.baseUrl}/images/generations`, {
                    access_token: this.accessToken,
                    prompt,
                    model: model || 'gpt-image-2',
                    proxy_url: this.proxyUrl,
                    response_format: requestBody.response_format || 'url',
                    n: requestBody.n || 1,
                    size: requestBody.size || null,
                    quality: requestBody.quality || 'auto',
                    base_url: requestBody._requestBaseUrl || ''
                }, { timeout: 300000 });

                return res.data;
            } catch (error) {
                const detail = error.response?.data?.detail || error.message;
                logger.error(`[ChatGPT Web] Image generation failed: ${detail}`);
                throw new Error(detail);
            }
        }

        throw new Error(`Unsupported model or request format: ${model}`);
    }

    async *generateContentStream(model, requestBody) {
        await this.initialize();
        const runnerReady = await this.runner.ensureReady();
        if (!runnerReady) {
            throw new Error('ChatGPT-Web Python runner service is unavailable');
        }

        const isImageModel = model === 'gpt-image-2' || (requestBody.model && requestBody.model.includes('image'));
        const prompt = this._extractPrompt(requestBody);

        if (isImageModel) {
            yield {
                type: 'conversation.delta',
                delta: 'Generating image...'
            };

            const result = await this.generateContent(model, requestBody);
            yield {
                type: 'result',
                data: result.data || [],
                created: result.created || Math.floor(Date.now() / 1000)
            };
            return;
        }

        // Text streaming via conversation endpoint
        const response = await axios.post(`${this.runner.baseUrl}/conversation`, {
            access_token: this.accessToken,
            prompt,
            model: model || 'auto',
            proxy_url: this.proxyUrl
        }, {
            responseType: 'stream',
            timeout: 300000
        });

        let buffer = '';
        for await (const chunk of response.data) {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data: ')) {
                    const dataStr = trimmed.slice(6);
                    if (dataStr === '[DONE]') return;
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
}

export default {
    ChatGPTWebService,
    CHATGPT_WEB_MODELS,
    ImageContentPolicyError
};
