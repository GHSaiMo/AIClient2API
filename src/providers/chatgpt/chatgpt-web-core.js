import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';
import { MODEL_PROVIDER, MODEL_PROTOCOL_PREFIX, isRetryableNetworkError, formatExpiryLog } from '../../utils/common.js';
import { parseProxyUrl, configureTLSSidecar } from '../../utils/proxy-utils.js';
import { parsePowResources, buildLegacyRequirementsToken, buildProofToken, DEFAULT_POW_SCRIPT } from './chatgpt-pow.js';
import { solveTurnstileToken } from './chatgpt-turnstile.js';
import { refreshAccessToken, fetchUserInfo, isJwtExpiredOrNear, decodeJwtPayload } from './chatgpt-token-service.js';
import { uploadImageToChatGPT, decodeImageBase64 } from './chatgpt-file-service.js';
import { getProviderPoolManager } from '../../services/service-manager.js';

export const CHATGPT_WEB_MODELS = [
    'gpt-image-2',
    'gpt-5',
    'gpt-5-1',
    'gpt-5-2',
    'gpt-5-3',
    'gpt-5-mini',
    'auto'
];

const DEFAULT_CLIENT_VERSION = 'prod-a194cd50d4416d3c0b47c740f206b12ce60f5887';
const DEFAULT_CLIENT_BUILD_NUMBER = '6708908';
const FILE_SERVICE_ID_RE = /file-service:\/\/([A-Za-z0-9_-]+)/g;
const REAL_IMAGE_FILE_ID_RE = /\bfile_00000000[a-f0-9]{24}\b/g;
const SEDIMENT_ID_RE = /sediment:\/\/([A-Za-z0-9_-]+)/g;

const CONTENT_POLICY_KEYWORDS = [
    '内容政策', '防护限制', '违反', 'moderation', 'policy', 'blocked',
    '不能生成', '无法生成', '不能帮助', '无法帮助',
    '裸体', '裸露', '色情', '性内容', '未成年',
    '抱歉，我不能', 'sorry, i cannot'
];

function isContentPolicyError(msg) {
    if (!msg || typeof msg !== 'string') return false;
    const lower = msg.toLowerCase();
    return CONTENT_POLICY_KEYWORDS.some(kw => lower.includes(kw));
}

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

        this.baseUrl = 'https://chatgpt.com';
        this.clientVersion = DEFAULT_CLIENT_VERSION;
        this.clientBuildNumber = DEFAULT_CLIENT_BUILD_NUMBER;
        this.powScriptSources = [DEFAULT_POW_SCRIPT];
        this.powDataBuild = '';

        this.fp = this._buildFp();
        this.userAgent = this.fp['user-agent'];
        this.deviceId = this.fp['oai-device-id'];
        this.sessionId = this.fp['oai-session-id'];
        this.isInitialized = false;
    }

    _buildFp() {
        const rawFp = this.config.fp && typeof this.config.fp === 'object' ? this.config.fp : {};
        const fp = {};
        for (const [k, v] of Object.entries(rawFp)) {
            fp[k.toLowerCase()] = String(v || '').trim();
        }

        fp['user-agent'] = fp['user-agent'] || this.config.USER_AGENT ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
        fp['oai-device-id'] = fp['oai-device-id'] || uuidv4();
        fp['oai-session-id'] = fp['oai-session-id'] || uuidv4();
        fp['sec-ch-ua'] = fp['sec-ch-ua'] || '"Chromium";v="145", "Not A(Brand";v="24"';
        fp['sec-ch-ua-mobile'] = fp['sec-ch-ua-mobile'] || '?0';
        fp['sec-ch-ua-platform'] = fp['sec-ch-ua-platform'] || '"Windows"';
        return fp;
    }

    _applySidecar(axiosConfig) {
        return configureTLSSidecar(axiosConfig, this.config, MODEL_PROVIDER.CHATGPT_WEB, this.baseUrl);
    }

    _buildHeaders(path, extra = {}) {
        const headers = {
            'User-Agent': this.userAgent,
            'Origin': this.baseUrl,
            'Referer': `${this.baseUrl}/`,
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Sec-Ch-Ua': this.fp['sec-ch-ua'],
            'Sec-Ch-Ua-Mobile': this.fp['sec-ch-ua-mobile'],
            'Sec-Ch-Ua-Platform': this.fp['sec-ch-ua-platform'],
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'OAI-Device-Id': this.deviceId,
            'OAI-Session-Id': this.sessionId,
            'OAI-Language': 'zh-CN',
            'OAI-Client-Version': this.clientVersion,
            'OAI-Client-Build-Number': this.clientBuildNumber,
            'X-OpenAI-Target-Path': path,
            'X-OpenAI-Target-Route': path,
            ...extra
        };

        if (this.accessToken) {
            headers['Authorization'] = `Bearer ${this.accessToken}`;
        }
        return headers;
    }

    _getAxiosConfig(extraHeaders = {}, timeout = 60000) {
        const axiosConfig = {
            headers: extraHeaders,
            timeout
        };

        if (this.proxyUrl) {
            const proxyConfig = parseProxyUrl(this.proxyUrl);
            if (proxyConfig) {
                axiosConfig.httpAgent = proxyConfig.httpAgent;
                axiosConfig.httpsAgent = proxyConfig.httpsAgent;
                axiosConfig.proxy = false;
            }
        }

        return this._applySidecar(axiosConfig);
    }

    async initialize() {
        if (this.isInitialized) return;
        logger.info(`[ChatGPT Web] Initializing ChatGPT Web service (uuid: ${this.uuid || 'default'})...`);

        if (!this.accessToken && this.refreshTokenValue) {
            await this.refreshToken();
        } else if (this.accessToken && isJwtExpiredOrNear(this.accessToken, 60 * 60)) {
            if (this.refreshTokenValue) {
                await this.refreshToken();
            }
        }

        this.isInitialized = true;
    }

    async bootstrap() {
        try {
            const headers = {
                'User-Agent': this.userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Sec-Ch-Ua': this.fp['sec-ch-ua'],
                'Sec-Ch-Ua-Mobile': this.fp['sec-ch-ua-mobile'],
                'Sec-Ch-Ua-Platform': this.fp['sec-ch-ua-platform'],
                'Upgrade-Insecure-Requests': '1'
            };
            const res = await axios.get(this.baseUrl + '/', this._getAxiosConfig(headers, 20000));
            const [sources, dataBuild] = parsePowResources(res.data);
            if (sources && sources.length > 0) this.powScriptSources = sources;
            if (dataBuild) this.powDataBuild = dataBuild;
        } catch (e) {
            logger.debug(`[ChatGPT Web] Bootstrap warning: ${e.message}`);
        }
    }

    async getChatRequirements() {
        await this.bootstrap();
        const base = this.accessToken
            ? '/backend-api/sentinel/chat-requirements'
            : '/backend-anon/sentinel/chat-requirements';

        const pToken = buildLegacyRequirementsToken(this.userAgent, this.powScriptSources, this.powDataBuild);

        // 1. Prepare
        const preparePath = `${base}/prepare`;
        const prepHeaders = this._buildHeaders(preparePath, { 'Content-Type': 'application/json' });
        const prepRes = await axios.post(this.baseUrl + preparePath, { p: pToken }, this._getAxiosConfig(prepHeaders, 20000));
        const prepData = prepRes.data || {};

        if (prepData.arkose?.required) {
            throw new Error('chat requirements requires arkose token, which is not implemented');
        }

        // 2. PoW
        let proofToken = '';
        const proofInfo = prepData.proofofwork || {};
        if (proofInfo.required && proofInfo.seed && proofInfo.difficulty) {
            proofToken = buildProofToken(
                proofInfo.seed,
                proofInfo.difficulty,
                this.userAgent,
                this.powScriptSources,
                this.powDataBuild
            );
        }

        // 3. Turnstile
        let turnstileToken = '';
        const turnstileInfo = prepData.turnstile || {};
        if (turnstileInfo.required && turnstileInfo.dx) {
            turnstileToken = solveTurnstileToken(turnstileInfo.dx, pToken) || '';
        }

        // 4. Finalize
        const finalizePath = `${base}/finalize`;
        const finHeaders = this._buildHeaders(finalizePath, { 'Content-Type': 'application/json' });
        const finRes = await axios.post(this.baseUrl + finalizePath, {
            prepare_token: prepData.prepare_token || '',
            proof_token: proofToken,
            turnstile_token: turnstileToken
        }, this._getAxiosConfig(finHeaders, 20000));

        const finData = finRes.data || {};
        const token = finData.token || '';
        if (!token) {
            throw new Error(`Failed to obtain sentinel chat requirements token: ${JSON.stringify(finData)}`);
        }

        return {
            token,
            proof_token: proofToken,
            turnstile_token: turnstileToken,
            so_token: finData.so_token || ''
        };
    }

    async prepareImageConversation(prompt, requirements, model = 'gpt-image-2') {
        const path = '/backend-api/f/conversation/prepare';
        const headers = this._buildHeaders(path, {
            'Content-Type': 'application/json',
            'OpenAI-Sentinel-Chat-Requirements-Token': requirements.token,
            ...(requirements.proof_token ? { 'OpenAI-Sentinel-Proof-Token': requirements.proof_token } : {}),
            ...(requirements.turnstile_token ? { 'OpenAI-Sentinel-Turnstile-Token': requirements.turnstile_token } : {}),
            ...(requirements.so_token ? { 'OpenAI-Sentinel-SO-Token': requirements.so_token } : {})
        });

        const payload = {
            action: 'next',
            fork_from_shared_post: false,
            parent_message_id: uuidv4(),
            model: 'gpt-image-2',
            client_prepare_state: 'success',
            timezone_offset_min: -480,
            timezone: 'Asia/Shanghai',
            conversation_mode: { kind: 'primary_assistant' },
            system_hints: ['picture_v2'],
            partial_query: {
                id: uuidv4(),
                author: { role: 'user' },
                content: { content_type: 'text', parts: [prompt] }
            },
            supports_buffering: true,
            supported_encodings: ['v1'],
            client_contextual_info: { app_name: 'chatgpt.com' }
        };

        const res = await axios.post(this.baseUrl + path, payload, this._getAxiosConfig(headers, 30000));
        const data = res.data || {};
        return data.conduit_token || '';
    }

    async startImageGeneration(prompt, requirements, conduitToken, model = 'gpt-image-2', references = []) {
        const path = '/backend-api/f/conversation';
        const headers = this._buildHeaders(path, {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'X-Conduit-Token': conduitToken,
            'OpenAI-Sentinel-Chat-Requirements-Token': requirements.token,
            ...(requirements.proof_token ? { 'OpenAI-Sentinel-Proof-Token': requirements.proof_token } : {}),
            ...(requirements.turnstile_token ? { 'OpenAI-Sentinel-Turnstile-Token': requirements.turnstile_token } : {}),
            ...(requirements.so_token ? { 'OpenAI-Sentinel-SO-Token': requirements.so_token } : {})
        });

        const parts = [];
        if (references && references.length > 0) {
            for (const item of references) {
                parts.push({
                    content_type: 'image_asset_pointer',
                    asset_pointer: `file-service://${item.file_id}`,
                    width: item.width,
                    height: item.height,
                    size_bytes: item.file_size
                });
            }
        }
        parts.push(prompt);

        const content = references && references.length > 0
            ? { content_type: 'multimodal_text', parts }
            : { content_type: 'text', parts: [prompt] };

        const metadata = {
            developer_mode_connector_ids: [],
            selected_github_repos: [],
            selected_all_github_repos: false,
            system_hints: ['picture_v2'],
            serialization_metadata: { custom_symbol_offsets: [] }
        };

        if (references && references.length > 0) {
            metadata.attachments = references.map(item => ({
                id: item.file_id,
                mimeType: item.mime_type,
                name: item.file_name,
                size: item.file_size,
                width: item.width,
                height: item.height
            }));
        }

        const payload = {
            action: 'next',
            messages: [{
                id: uuidv4(),
                author: { role: 'user' },
                create_time: Date.now() / 1000,
                content,
                metadata
            }],
            parent_message_id: uuidv4(),
            model: 'gpt-image-2',
            client_prepare_state: 'sent',
            timezone_offset_min: -480,
            timezone: 'Asia/Shanghai',
            conversation_mode: { kind: 'primary_assistant' },
            enable_message_followups: true,
            system_hints: ['picture_v2'],
            supports_buffering: true,
            supported_encodings: ['v1'],
            client_contextual_info: {
                is_dark_mode: false,
                time_since_loaded: 1200,
                page_height: 1072,
                page_width: 1724,
                pixel_ratio: 1.2,
                screen_height: 1440,
                screen_width: 2560,
                app_name: 'chatgpt.com'
            },
            paragen_cot_summary_display_override: 'allow',
            force_parallel_switch: 'auto'
        };

        const res = await axios.post(this.baseUrl + path, payload, {
            ...this._getAxiosConfig(headers, 180000),
            responseType: 'stream'
        });

        return res.data;
    }

    _extractImageReferenceIds(payload) {
        const fileIds = [];
        const sedimentIds = [];
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);

        let match;
        const fileServiceRe = /file-service:\/\/([A-Za-z0-9_-]+)/g;
        while ((match = fileServiceRe.exec(text)) !== null) {
            if (!fileIds.includes(match[1])) fileIds.push(match[1]);
        }

        const realImgRe = /\bfile_00000000[a-f0-9]{24}\b/g;
        while ((match = realImgRe.exec(text)) !== null) {
            if (!fileIds.includes(match[0])) fileIds.push(match[0]);
        }

        const sedRe = /sediment:\/\/([A-Za-z0-9_-]+)/g;
        while ((match = sedRe.exec(text)) !== null) {
            if (!sedimentIds.includes(match[1])) sedimentIds.push(match[1]);
        }

        return { fileIds, sedimentIds };
    }

    async getConversation(conversationId) {
        const path = `/backend-api/conversation/${conversationId}`;
        const headers = this._buildHeaders(path, { 'Accept': 'application/json' });
        const res = await axios.get(this.baseUrl + path, this._getAxiosConfig(headers, 30000));
        return res.data || {};
    }

    async getFileDownloadUrl(fileId) {
        const path = `/backend-api/files/${fileId}/download`;
        const headers = this._buildHeaders(path, { 'Accept': 'application/json' });
        const res = await axios.get(this.baseUrl + path, this._getAxiosConfig(headers, 30000));
        const data = res.data || {};
        return data.download_url || data.url || '';
    }

    async getAttachmentDownloadUrl(conversationId, attachmentId) {
        const path = `/backend-api/conversation/${conversationId}/attachment/${attachmentId}/download`;
        const headers = this._buildHeaders(path, { 'Accept': 'application/json' });
        const res = await axios.get(this.baseUrl + path, this._getAxiosConfig(headers, 30000));
        const data = res.data || {};
        return data.download_url || data.url || '';
    }

    async pollImageResults(conversationId, timeoutSecs = 120, initialFileIds = [], initialSedimentIds = []) {
        const startTime = Date.now();
        const intervalMs = 5000;
        const fileIds = [...initialFileIds];
        const sedimentIds = [...initialSedimentIds];

        logger.info(`[ChatGPT Web] Polling image results for conversation ${conversationId}...`);

        while ((Date.now() - startTime) < timeoutSecs * 1000) {
            await new Promise(r => setTimeout(r, intervalMs));

            let conversation;
            try {
                conversation = await this.getConversation(conversationId);
            } catch (err) {
                if (err.response?.status === 429 || err.response?.status >= 500) {
                    continue;
                }
                throw err;
            }

            const { fileIds: polledFiles, sedimentIds: polledSeds } = this._extractImageReferenceIds(conversation);
            for (const f of polledFiles) {
                if (!fileIds.includes(f)) fileIds.push(f);
            }
            for (const s of polledSeds) {
                if (!sedimentIds.includes(s)) sedimentIds.push(s);
            }

            // 检查内容审核违规
            if (fileIds.length === 0 && sedimentIds.length === 0) {
                const mapping = conversation.mapping || {};
                for (const node of Object.values(mapping)) {
                    const msg = node?.message || {};
                    const role = msg.author?.role;
                    if (role === 'assistant' || role === 'tool') {
                        const parts = msg.content?.parts || [];
                        const text = Array.isArray(parts) ? parts.join('\n') : String(msg.content?.text || '');
                        if (isContentPolicyError(text)) {
                            throw new ImageContentPolicyError(text.slice(0, 300), conversationId);
                        }
                    }
                }
            }

            if (fileIds.length > 0 || sedimentIds.length > 0) {
                return { fileIds, sedimentIds };
            }
        }

        throw new Error(`ChatGPT Web image polling timed out after ${timeoutSecs}s for conversation ${conversationId}`);
    }

    async resolveImageUrls(conversationId, fileIds, sedimentIds) {
        const urls = [];
        for (const fileId of fileIds) {
            try {
                const url = await this.getFileDownloadUrl(fileId);
                if (url && !urls.includes(url)) urls.push(url);
            } catch (err) {
                logger.debug(`[ChatGPT Web] Failed to resolve file URL for ${fileId}: ${err.message}`);
            }
        }
        if (conversationId && sedimentIds) {
            for (const sedId of sedimentIds) {
                try {
                    const url = await this.getAttachmentDownloadUrl(conversationId, sedId);
                    if (url && !urls.includes(url)) urls.push(url);
                } catch (err) {
                    logger.debug(`[ChatGPT Web] Failed to resolve sediment URL for ${sedId}: ${err.message}`);
                }
            }
        }
        return urls;
    }

    async downloadImageAsBase64(url) {
        const res = await axios.get(url, {
            ...this._getAxiosConfig({}, 60000),
            responseType: 'arraybuffer'
        });
        return Buffer.from(res.data).toString('base64');
    }

    /**
     * 核心生图与图生图入口
     */
    async generateContent(model, requestBody) {
        await this.initialize();

        const prompt = requestBody.prompt ||
            (Array.isArray(requestBody.messages)
                ? requestBody.messages.map(m => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.find(c => c.type === 'text')?.text || '' : '')).filter(Boolean).join('\n')
                : '');

        const responseFormat = requestBody.response_format || 'b64_json';
        const references = [];

        // 处理参考图片（图生图 / Edits 场景）
        if (Array.isArray(requestBody.messages)) {
            for (const msg of requestBody.messages) {
                if (Array.isArray(msg.content)) {
                    for (const part of msg.content) {
                        if (part.type === 'image_url' && part.image_url?.url) {
                            const rawUrl = part.image_url.url;
                            if (rawUrl.startsWith('data:') || rawUrl.length > 200) {
                                logger.info('[ChatGPT Web] Uploading reference image to ChatGPT files API...');
                                const uploaded = await uploadImageToChatGPT({
                                    image: rawUrl,
                                    fileName: `ref_${references.length + 1}.png`,
                                    accessToken: this.accessToken,
                                    proxyUrl: this.proxyUrl,
                                    headers: this._buildHeaders('/backend-api/files')
                                });
                                references.push(uploaded);
                            }
                        }
                    }
                }
            }
        }

        logger.info(`[ChatGPT Web] Starting image generation with model=${model}, prompt="${prompt.slice(0, 50)}...", refs=${references.length}`);

        const requirements = await this.getChatRequirements();
        const conduitToken = await this.prepareImageConversation(prompt, requirements, model);
        const stream = await this.startImageGeneration(prompt, requirements, conduitToken, model, references);

        let conversationId = '';
        let initialFileIds = [];
        let initialSedimentIds = [];

        // 消费 SSE 流并提取初始 IDs
        await new Promise((resolve, reject) => {
            let buffer = '';
            stream.on('data', chunk => {
                buffer += chunk.toString('utf8');
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;
                    const dataStr = trimmed.slice(5).trim();
                    if (dataStr === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(dataStr);
                        if (parsed.conversation_id && !conversationId) {
                            conversationId = parsed.conversation_id;
                        }
                        const { fileIds, sedimentIds } = this._extractImageReferenceIds(parsed);
                        for (const f of fileIds) {
                            if (!initialFileIds.includes(f)) initialFileIds.push(f);
                        }
                        for (const s of sedimentIds) {
                            if (!initialSedimentIds.includes(s)) initialSedimentIds.push(s);
                        }
                    } catch {}
                }
            });

            stream.on('end', resolve);
            stream.on('error', reject);
        });

        logger.info(`[ChatGPT Web] Stream finished. conversationId=${conversationId}, initialFiles=${initialFileIds.length}`);

        // 轮询并解析图片
        let finalFileIds = [...initialFileIds];
        let finalSedimentIds = [...initialSedimentIds];

        if (conversationId && (finalFileIds.length === 0 && finalSedimentIds.length === 0)) {
            const polled = await this.pollImageResults(conversationId, 120, finalFileIds, finalSedimentIds);
            finalFileIds = polled.fileIds;
            finalSedimentIds = polled.sedimentIds;
        }

        const urls = await this.resolveImageUrls(conversationId, finalFileIds, finalSedimentIds);
        if (urls.length === 0) {
            throw new Error(`Failed to resolve generated image URLs for conversation ${conversationId}`);
        }

        const data = [];
        for (const url of urls) {
            if (responseFormat === 'url') {
                data.push({ url });
            } else {
                const b64 = await this.downloadImageAsBase64(url);
                data.push({ b64_json: b64 });
            }
        }

        return {
            created: Math.floor(Date.now() / 1000),
            data,
            _uuid: this.uuid
        };
    }

    async *generateContentStream(model, requestBody) {
        const result = await this.generateContent(model, requestBody);
        yield {
            id: `chatcmpl-${uuidv4()}`,
            object: 'chat.completion.chunk',
            created: result.created,
            model,
            choices: [{
                index: 0,
                delta: { content: `![Generated Image](${result.data[0]?.url || 'data:image/png;base64,' + result.data[0]?.b64_json})` },
                finish_reason: 'stop'
            }]
        };
    }

    async listModels() {
        return {
            object: 'list',
            data: CHATGPT_WEB_MODELS.map(id => ({
                id,
                object: 'model',
                created: 1700000000,
                owned_by: 'chatgpt'
            }))
        };
    }

    async refreshToken() {
        if (!this.refreshTokenValue) {
            logger.warn(`[ChatGPT Web] No refresh_token available for node ${this.uuid || 'default'}`);
            return false;
        }
        try {
            const res = await refreshAccessToken(this.refreshTokenValue, this.proxyUrl);
            this.accessToken = res.access_token;
            if (res.refresh_token) {
                this.refreshTokenValue = res.refresh_token;
            }
            if (this.config) {
                this.config.access_token = this.accessToken;
                this.config.refresh_token = this.refreshTokenValue;
            }
            logger.info(`[ChatGPT Web] Successfully refreshed access token for node ${this.uuid || 'default'}`);
            return true;
        } catch (err) {
            logger.error(`[ChatGPT Web] Token refresh failed for node ${this.uuid || 'default'}: ${err.message}`);
            throw err;
        }
    }

    async forceRefreshToken() {
        return this.refreshToken();
    }

    isExpiryDateNear() {
        if (!this.accessToken) return true;
        return isJwtExpiredOrNear(this.accessToken, 24 * 60 * 60);
    }

    async getUsageLimits() {
        if (!this.accessToken) return null;
        try {
            const userInfo = await fetchUserInfo(this.accessToken, this.proxyUrl, this.fp);
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
        } catch (err) {
            logger.debug(`[ChatGPT Web] Failed to fetch usage limits: ${err.message}`);
            return null;
        }
    }
}
