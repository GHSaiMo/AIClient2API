import { UndiciHttpClient } from '../../utils/undici-client.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger.js';
import { MODEL_PROVIDER } from '../../utils/common.js';
import { configureUndiciTLSSidecar, getUndiciDispatcherForUrl } from '../../utils/proxy-utils.js';
import { parsePowResources, buildLegacyRequirementsToken, buildProofToken, DEFAULT_POW_SCRIPT } from './chatgpt-pow.js';
import { solveTurnstileToken } from './chatgpt-turnstile.js';
import {
    refreshAccessToken,
    refreshSessionFromCookies,
    fetchUserInfo,
    isJwtExpiredOrNear,
    decodeJwtPayload,
    extractAccountIdFromJwt
} from './chatgpt-token-service.js';
import { uploadImageToChatGPT } from './chatgpt-file-service.js';
import { extractCookieValue, extractChatGPTSessionCookies } from './chatgpt-cookie-extractor.js';
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
        this.cookieHeader = this._resolveInitialCookieHeader(this.config);
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
        this.hasBootstrapped = false;

        this.fp = this._buildFp();
        this.userAgent = this.fp['user-agent'];
        this.deviceId = this.fp['oai-device-id'];
        this.sessionId = this.fp['oai-session-id'];
        this.accountId = extractAccountIdFromJwt(this.accessToken);
        this.client = new UndiciHttpClient();
        this.isInitialized = false;
    }

    _resolveInitialCookieHeader(config) {
        const raw = config.cookie_header || config.cookieHeader || config.cookie || null;
        if (raw && typeof raw === 'string' && raw.trim()) {
            return raw.trim();
        }
        const sessionToken = config.session_token || config.sessionToken || null;
        if (sessionToken && typeof sessionToken === 'string' && sessionToken.trim()) {
            return `__Secure-next-auth.session-token=${sessionToken.trim()}`;
        }
        return null;
    }

    _buildFp() {
        const rawFp = this.config.fp && typeof this.config.fp === 'object' ? this.config.fp : {};
        const fp = {};
        for (const [k, v] of Object.entries(rawFp)) {
            fp[k.toLowerCase()] = String(v || '').trim();
        }

        const cookieDeviceId = extractCookieValue(this.cookieHeader, 'oai-did');
        fp['user-agent'] = fp['user-agent'] || this.config.USER_AGENT ||
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
        fp['oai-device-id'] = fp['oai-device-id'] || cookieDeviceId || uuidv4();
        fp['oai-session-id'] = fp['oai-session-id'] || uuidv4();
        fp['sec-ch-ua'] = fp['sec-ch-ua'] || '"Chromium";v="145", "Not A(Brand";v="24"';
        fp['sec-ch-ua-mobile'] = fp['sec-ch-ua-mobile'] || '?0';
        fp['sec-ch-ua-platform'] = fp['sec-ch-ua-platform'] || '"macOS"';
        return fp;
    }

    _getEffectiveConfig() {
        const providerType = this.config.MODEL_PROVIDER || MODEL_PROVIDER.CHATGPT_WEB;
        const effective = {
            ...this.config,
            MODEL_PROVIDER: providerType,
        };
        if (this.proxyUrl && !effective.PROXY_URL) {
            effective.PROXY_URL = this.proxyUrl;
        }
        if (effective.PROXY_URL && !Array.isArray(effective.PROXY_ENABLED_PROVIDERS)) {
            effective.PROXY_ENABLED_PROVIDERS = [providerType];
        }
        return effective;
    }

    _request(urlOrPath, { method = 'GET', headers = {}, data = null, timeout = 60000, responseType = 'json' } = {}) {
        const fullUrl = /^https?:\/\//i.test(urlOrPath) ? urlOrPath : `${this.baseUrl}${urlOrPath}`;
        const effectiveConfig = this._getEffectiveConfig();
        const providerType = effectiveConfig.MODEL_PROVIDER || MODEL_PROVIDER.CHATGPT_WEB;

        const reqOptions = {
            url: fullUrl,
            method,
            headers: { ...headers },
            ...(data !== null ? { data } : {}),
            timeout,
            responseType,
        };

        configureUndiciTLSSidecar(reqOptions, effectiveConfig, providerType, this.baseUrl);
        if (!reqOptions.dispatcher && this.proxyUrl) {
            reqOptions.dispatcher = getUndiciDispatcherForUrl(this.proxyUrl, 'ChatGPT-Web');
            reqOptions.proxyUrl = this.proxyUrl;
        }
        return this.client.request(reqOptions);
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
            ...extra,
        };

        if (this.accessToken) {
            headers['Authorization'] = `Bearer ${this.accessToken}`;
        }
        if (this.accountId) {
            headers['ChatGPT-Account-Id'] = this.accountId;
        }
        if (this.cookieHeader) {
            headers['Cookie'] = this.cookieHeader;
        }
        return headers;
    }

    _canRefresh() {
        return Boolean(this.refreshTokenValue || this.cookieHeader || process.platform === 'darwin');
    }

    _syncTokenMetadata() {
        if (this.accessToken) {
            const jwt = decodeJwtPayload(this.accessToken);
            this.email = jwt['https://api.openai.com/profile']?.email || jwt.email || this.email;
            this.accountId = extractAccountIdFromJwt(this.accessToken) || this.accountId;
            this.accountType = jwt['https://api.openai.com/auth']?.chatgpt_plan_type || this.accountType;
        }
        const cookieDeviceId = extractCookieValue(this.cookieHeader, 'oai-did');
        if (cookieDeviceId && !this.config.fp?.['oai-device-id']) {
            this.deviceId = cookieDeviceId;
        }
    }

    _syncToPoolManager() {
        if (this.config) {
            this.config.access_token = this.accessToken;
            if (this.refreshTokenValue) {
                this.config.refresh_token = this.refreshTokenValue;
            }
            if (this.cookieHeader) {
                this.config.cookie_header = this.cookieHeader;
            }
            if (this.email) {
                this.config.email = this.email;
            }
            if (this.accountType) {
                this.config.accountType = this.accountType;
            }
        }

        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            const poolType = this.config.MODEL_PROVIDER || MODEL_PROVIDER.CHATGPT_WEB;
            const poolItem = poolManager._findProvider?.(poolType, this.uuid);
            if (poolItem?.config) {
                poolItem.config.access_token = this.accessToken;
                if (this.refreshTokenValue) {
                    poolItem.config.refresh_token = this.refreshTokenValue;
                }
                if (this.cookieHeader) {
                    poolItem.config.cookie_header = this.cookieHeader;
                }
                if (this.email) {
                    poolItem.config.email = this.email;
                }
                if (this.accountType) {
                    poolItem.config.accountType = this.accountType;
                }
                poolItem.config.isHealthy = true;
                poolItem.config.needsRefresh = false;
                poolItem.config.lastRefreshTime = Date.now();
                poolManager._debouncedSave?.(poolType);
            }
            poolManager.resetProviderRefreshStatus?.(poolType, this.uuid);
        }
    }

    async initialize() {
        if (this.isInitialized) return;
        logger.info(`[ChatGPT Web] Initializing ChatGPT Web service (uuid: ${this.uuid || 'default'})...`);

        this._syncTokenMetadata();

        const isExpired = !this.accessToken || isJwtExpiredOrNear(this.accessToken, 60);
        if (isExpired && this._canRefresh()) {
            await this.refreshToken();
        } else if (this.accessToken && isJwtExpiredOrNear(this.accessToken, 24 * 60 * 60) && this._canRefresh()) {
            this.triggerBackgroundRefresh();
        }

        this.isInitialized = true;
    }

    async listModels() {
        return {
            object: 'list',
            data: CHATGPT_WEB_MODELS.map(id => ({
                id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'openai-web',
            })),
        };
    }

    isExpiryDateNear() {
        if (!this.accessToken) return true;
        return isJwtExpiredOrNear(this.accessToken, 24 * 60 * 60);
    }

    triggerBackgroundRefresh() {
        if (!this._canRefresh()) {
            logger.warn(`[ChatGPT Web] No refresh_token or cookie_header for ${this.email || this.uuid}, cannot refresh.`);
            return;
        }
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            logger.info(`[ChatGPT Web] Marking credential ${this.uuid} for background refresh`);
            poolManager.markProviderNeedRefresh(this.config.MODEL_PROVIDER || MODEL_PROVIDER.CHATGPT_WEB, { uuid: this.uuid });
        }
    }

    async refreshToken() {
        if (this.refreshTokenValue) {
            try {
                logger.info(`[ChatGPT Web] Refreshing token via OAuth for ${this.email || this.uuid || 'default'}...`);
                const tokens = await refreshAccessToken(this.refreshTokenValue, this._getEffectiveConfig());
                this.accessToken = tokens.access_token;
                if (tokens.refresh_token) {
                    this.refreshTokenValue = tokens.refresh_token;
                }
                this._syncTokenMetadata();
                this._syncToPoolManager();
                logger.info(`[ChatGPT Web] OAuth token refreshed successfully for ${this.email || this.uuid || 'default'}`);
                return true;
            } catch (error) {
                logger.warn(`[ChatGPT Web] OAuth token refresh failed (${error.message}); checking browser cookie fallback...`);
                if (!this.cookieHeader && process.platform !== 'darwin') {
                    throw error;
                }
            }
        }

        let cookieHeader = this.cookieHeader;
        if (!cookieHeader && process.platform === 'darwin') {
            const extracted = extractChatGPTSessionCookies({
                preferredBrowser: this.config.browser || 'ego',
                preferredProfile: this.config.profile || 'Profile 4',
            });
            if (extracted?.cookieHeader) {
                cookieHeader = extracted.cookieHeader;
            }
        }

        if (!cookieHeader) {
            throw new Error(`Cannot refresh token for ${this.email || this.uuid || 'default'}: refresh_token and cookie_header are both missing.`);
        }

        logger.info(`[ChatGPT Web] Refreshing session via ChatGPT Web cookies for ${this.email || this.uuid || 'default'}...`);
        const sessionInfo = await refreshSessionFromCookies(cookieHeader, this._getEffectiveConfig(), this.fp);
        this.accessToken = sessionInfo.access_token;
        this.cookieHeader = sessionInfo.cookie_header || cookieHeader;
        this.email = sessionInfo.email || this.email;
        this.accountType = sessionInfo.accountType || this.accountType;
        this.accountId = sessionInfo.account_id || this.accountId;
        this._syncTokenMetadata();
        this._syncToPoolManager();

        logger.info(`[ChatGPT Web] Cookie session refreshed successfully for ${this.email || this.uuid || 'default'} (${this.accountType})`);
        return true;
    }

    async forceRefreshToken() {
        return this.refreshToken();
    }

    async refreshAccessToken() {
        return this.refreshToken();
    }

    async getUsageLimits() {
        if (!this.accessToken && this._canRefresh()) {
            await this.refreshToken();
        }
        if (!this.accessToken) return null;

        try {
            const userInfo = await fetchUserInfo(this.accessToken, this._getEffectiveConfig(), this.fp, this.cookieHeader);
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
                    status: userInfo.status,
                };
            }
            return null;
        } catch (error) {
            logger.warn(`[ChatGPT Web] Failed to fetch usage limits: ${error.message}`);
            return null;
        }
    }

    async bootstrap() {
        if (this.hasBootstrapped) return;
        try {
            const res = await this._request('/', {
                method: 'GET',
                headers: {
                    'User-Agent': this.userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Sec-Ch-Ua': this.fp['sec-ch-ua'],
                    'Sec-Ch-Ua-Mobile': this.fp['sec-ch-ua-mobile'],
                    'Sec-Ch-Ua-Platform': this.fp['sec-ch-ua-platform'],
                    ...(this.cookieHeader ? { 'Cookie': this.cookieHeader } : {}),
                },
                timeout: 15000,
                responseType: 'text',
            });
            const [sources, dataBuild] = parsePowResources(res.data);
            if (sources && sources.length > 0) this.powScriptSources = sources;
            if (dataBuild) this.powDataBuild = dataBuild;
            this.hasBootstrapped = true;
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
        const prepRes = await this._request(preparePath, {
            method: 'POST',
            headers: this._buildHeaders(preparePath, { 'Content-Type': 'application/json' }),
            data: { p: pToken },
            timeout: 20000,
        });
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

        // 3. Turnstile (optional VM solver)
        let turnstileToken = '';
        const turnstileInfo = prepData.turnstile || {};
        if (turnstileInfo.required && turnstileInfo.dx) {
            turnstileToken = solveTurnstileToken(turnstileInfo.dx, pToken) || '';
        }

        // 4. Finalize
        const finalizePath = `${base}/finalize`;
        const finRes = await this._request(finalizePath, {
            method: 'POST',
            headers: this._buildHeaders(finalizePath, { 'Content-Type': 'application/json' }),
            data: {
                prepare_token: prepData.prepare_token || '',
                proof_token: proofToken,
                turnstile_token: turnstileToken,
            },
            timeout: 20000,
        });

        const finData = finRes.data || {};
        const token = finData.token || '';
        if (!token) {
            throw new Error(`Failed to obtain sentinel chat requirements token: ${JSON.stringify(finData)}`);
        }

        return {
            token,
            proof_token: proofToken,
            turnstile_token: turnstileToken,
            so_token: finData.so_token || '',
        };
    }

    _buildSentinelHeaders(path, requirements, extra = {}) {
        return this._buildHeaders(path, {
            'Content-Type': 'application/json',
            'OpenAI-Sentinel-Chat-Requirements-Token': requirements.token,
            ...(requirements.proof_token ? { 'OpenAI-Sentinel-Proof-Token': requirements.proof_token } : {}),
            ...(requirements.turnstile_token ? { 'OpenAI-Sentinel-Turnstile-Token': requirements.turnstile_token } : {}),
            ...(requirements.so_token ? { 'OpenAI-Sentinel-SO-Token': requirements.so_token } : {}),
            ...extra,
        });
    }

    async prepareConversation(prompt, requirements, model = 'gpt-image-2', isImageMode = true) {
        const path = '/backend-api/f/conversation/prepare';
        const headers = this._buildSentinelHeaders(path, requirements);

        const payload = {
            action: 'next',
            fork_from_shared_post: false,
            parent_message_id: uuidv4(),
            model: isImageMode ? 'gpt-image-2' : (model || 'auto'),
            client_prepare_state: 'success',
            timezone_offset_min: -480,
            timezone: 'Asia/Shanghai',
            conversation_mode: { kind: 'primary_assistant' },
            ...(isImageMode ? { system_hints: ['picture_v2'] } : {}),
            partial_query: {
                id: uuidv4(),
                author: { role: 'user' },
                content: { content_type: 'text', parts: [prompt] },
            },
            supports_buffering: true,
            supported_encodings: ['v1'],
            client_contextual_info: { app_name: 'chatgpt.com' },
        };

        const res = await this._request(path, {
            method: 'POST',
            headers,
            data: payload,
            timeout: 30000,
        });
        const data = res.data || {};
        return data.conduit_token || '';
    }

    async startConversationStream(prompt, requirements, conduitToken, model = 'gpt-image-2', references = [], isImageMode = true) {
        const path = '/backend-api/f/conversation';
        const headers = this._buildSentinelHeaders(path, requirements, {
            'Accept': 'text/event-stream',
            ...(conduitToken ? { 'X-Conduit-Token': conduitToken } : {}),
        });

        const parts = [];
        if (references && references.length > 0) {
            for (const item of references) {
                parts.push({
                    content_type: 'image_asset_pointer',
                    asset_pointer: `file-service://${item.file_id}`,
                    width: item.width,
                    height: item.height,
                    size_bytes: item.file_size,
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
            ...(isImageMode ? { system_hints: ['picture_v2'] } : {}),
            serialization_metadata: { custom_symbol_offsets: [] },
        };

        if (references && references.length > 0) {
            metadata.attachments = references.map(item => ({
                id: item.file_id,
                mimeType: item.mime_type,
                name: item.file_name,
                size: item.file_size,
                width: item.width,
                height: item.height,
            }));
        }

        const payload = {
            action: 'next',
            messages: [{
                id: uuidv4(),
                author: { role: 'user' },
                create_time: Date.now() / 1000,
                content,
                metadata,
            }],
            parent_message_id: uuidv4(),
            model: isImageMode ? 'gpt-image-2' : (model || 'auto'),
            client_prepare_state: 'sent',
            timezone_offset_min: -480,
            timezone: 'Asia/Shanghai',
            conversation_mode: { kind: 'primary_assistant' },
            enable_message_followups: true,
            ...(isImageMode ? { system_hints: ['picture_v2'] } : {}),
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
                app_name: 'chatgpt.com',
            },
            paragen_cot_summary_display_override: 'allow',
            force_parallel_switch: 'auto',
        };

        const res = await this._request(path, {
            method: 'POST',
            headers,
            data: payload,
            timeout: 180000,
            responseType: 'stream',
        });

        return res.data;
    }

    _extractImageReferenceIds(payload) {
        const fileIds = [];
        const sedimentIds = [];
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);

        let match;
        FILE_SERVICE_ID_RE.lastIndex = 0;
        while ((match = FILE_SERVICE_ID_RE.exec(text)) !== null) {
            if (!fileIds.includes(match[1])) fileIds.push(match[1]);
        }

        REAL_IMAGE_FILE_ID_RE.lastIndex = 0;
        while ((match = REAL_IMAGE_FILE_ID_RE.exec(text)) !== null) {
            if (!fileIds.includes(match[0])) fileIds.push(match[0]);
        }

        SEDIMENT_ID_RE.lastIndex = 0;
        while ((match = SEDIMENT_ID_RE.exec(text)) !== null) {
            if (!sedimentIds.includes(match[1])) sedimentIds.push(match[1]);
        }

        return { fileIds, sedimentIds };
    }

    async getConversation(conversationId) {
        const path = `/backend-api/conversation/${conversationId}`;
        const res = await this._request(path, {
            method: 'GET',
            headers: this._buildHeaders(path, { 'Accept': 'application/json' }),
            timeout: 30000,
        });
        return res.data || {};
    }

    async getFileDownloadUrl(fileId) {
        const path = `/backend-api/files/${fileId}/download`;
        const res = await this._request(path, {
            method: 'GET',
            headers: this._buildHeaders(path, { 'Accept': 'application/json' }),
            timeout: 30000,
        });
        const data = res.data || {};
        return data.download_url || data.url || '';
    }

    async getAttachmentDownloadUrl(conversationId, attachmentId) {
        const path = `/backend-api/conversation/${conversationId}/attachment/${attachmentId}/download`;
        const res = await this._request(path, {
            method: 'GET',
            headers: this._buildHeaders(path, { 'Accept': 'application/json' }),
            timeout: 30000,
        });
        const data = res.data || {};
        return data.download_url || data.url || '';
    }

    async pollImageResults(conversationId, timeoutSecs = 120, initialFileIds = [], initialSedimentIds = []) {
        const startTime = Date.now();
        const intervalMs = 4000;
        const fileIds = [...initialFileIds];
        const sedimentIds = [...initialSedimentIds];

        logger.info(`[ChatGPT Web] Polling image results for conversation ${conversationId}...`);

        while ((Date.now() - startTime) < timeoutSecs * 1000) {
            await new Promise(r => setTimeout(r, intervalMs));

            let conversation;
            try {
                conversation = await this.getConversation(conversationId);
            } catch (err) {
                const status = err.response?.status;
                if (status === 429 || status >= 500) {
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
                if (conversationId) {
                    try {
                        const fallbackUrl = await this.getAttachmentDownloadUrl(conversationId, fileId);
                        if (fallbackUrl && !urls.includes(fallbackUrl)) urls.push(fallbackUrl);
                    } catch (fallbackErr) {
                        logger.debug(`[ChatGPT Web] Attachment fallback failed for ${fileId}: ${fallbackErr.message}`);
                    }
                }
            }
        }
        if (conversationId && sedimentIds) {
            for (const sedId of sedimentIds) {
                try {
                    const url = await this.getAttachmentDownloadUrl(conversationId, sedId);
                    if (url && !urls.includes(url)) urls.push(url);
                } catch (err) {
                    logger.debug(`[ChatGPT Web] Failed to resolve sediment URL for ${sedId}: ${err.message}`);
                    try {
                        const fallbackUrl = await this.getFileDownloadUrl(sedId);
                        if (fallbackUrl && !urls.includes(fallbackUrl)) urls.push(fallbackUrl);
                    } catch (fallbackErr) {
                        logger.debug(`[ChatGPT Web] File fallback failed for ${sedId}: ${fallbackErr.message}`);
                    }
                }
            }
        }
        return urls;
    }

    async downloadImageAsBase64(url) {
        const isChatGPTDomain = /^https:\/\/([^/]+\.)?chatgpt\.com(\/|$)/i.test(url);
        const headers = isChatGPTDomain
            ? this._buildHeaders(new URL(url).pathname, { 'Accept': '*/*' })
            : { 'User-Agent': this.userAgent, 'Accept': '*/*' };

        const res = await this._request(url, {
            method: 'GET',
            headers,
            timeout: 60000,
            responseType: 'arraybuffer',
        });
        return Buffer.from(res.data).toString('base64');
    }

    _extractPrompt(requestBody) {
        if (typeof requestBody === 'string') return requestBody;
        if (requestBody.prompt) return String(requestBody.prompt);
        if (Array.isArray(requestBody.messages)) {
            return requestBody.messages.map(m => {
                if (typeof m.content === 'string') return m.content;
                if (Array.isArray(m.content)) {
                    return m.content
                        .filter(c => c.type === 'text' || c.type === 'input_text')
                        .map(c => c.text || '')
                        .join('\n');
                }
                return '';
            }).filter(Boolean).join('\n');
        }
        if (Array.isArray(requestBody.input)) {
            return requestBody.input.map(item => {
                if (typeof item.content === 'string') return item.content;
                if (Array.isArray(item.content)) {
                    return item.content
                        .filter(c => c.type === 'text' || c.type === 'input_text')
                        .map(c => c.text || '')
                        .join('\n');
                }
                return '';
            }).filter(Boolean).join('\n');
        }
        return '';
    }

    _extractReferenceImages(requestBody) {
        const refs = [];
        if (Array.isArray(requestBody?.messages)) {
            for (const msg of requestBody.messages) {
                if (!Array.isArray(msg.content)) continue;
                for (const part of msg.content) {
                    if (part.type === 'image_url' && part.image_url?.url) {
                        const rawUrl = part.image_url.url;
                        if (rawUrl.startsWith('data:') || rawUrl.length > 200) {
                            refs.push(rawUrl);
                        }
                    }
                }
            }
        }
        return refs;
    }

    _extractTextFromConversationMapping(conversation) {
        const mapping = conversation?.mapping || {};
        let latestText = '';
        let latestTime = -1;
        for (const node of Object.values(mapping)) {
            const msg = node?.message;
            if (!msg || msg.author?.role !== 'assistant') continue;
            const createTime = Number(msg.create_time) || 0;
            const parts = msg.content?.parts;
            const text = Array.isArray(parts)
                ? parts.filter(p => typeof p === 'string').join('\n')
                : String(msg.content?.text || '');
            if (text && createTime >= latestTime) {
                latestTime = createTime;
                latestText = text;
            }
        }
        return latestText;
    }

    async _consumeConversationSSE(stream) {
        let buffer = '';
        let conversationId = '';
        let streamError = null;
        const initialFileIds = [];
        const initialSedimentIds = [];
        let lastAssistantText = '';

        for await (const chunk of stream) {
            buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : Buffer.from(chunk).toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const dataStr = trimmed.slice(5).trim();
                if (!dataStr || dataStr === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(dataStr);
                    const convId = parsed.conversation_id || parsed.v?.conversation_id;
                    if (convId && !conversationId) {
                        conversationId = convId;
                    }

                    if (parsed.error) {
                        streamError = typeof parsed.error === 'string'
                            ? parsed.error
                            : (parsed.error.message || JSON.stringify(parsed.error));
                    }

                    const msg = parsed.v?.message || parsed.message;
                    if (msg?.author?.role === 'assistant' && Array.isArray(msg?.content?.parts)) {
                        const text = msg.content.parts.filter(p => typeof p === 'string').join('');
                        if (text) lastAssistantText = text;
                    }

                    const { fileIds, sedimentIds } = this._extractImageReferenceIds(parsed);
                    for (const f of fileIds) {
                        if (!initialFileIds.includes(f)) initialFileIds.push(f);
                    }
                    for (const s of sedimentIds) {
                        if (!initialSedimentIds.includes(s)) initialSedimentIds.push(s);
                    }
                } catch {
                    // ignore partial/non-JSON SSE frames
                }
            }
        }

        return { conversationId, initialFileIds, initialSedimentIds, streamError, lastAssistantText };
    }

    async _generateImageInternal(model, requestBody) {
        const prompt = this._extractPrompt(requestBody);
        const responseFormat = requestBody.response_format || 'b64_json';
        const rawRefs = this._extractReferenceImages(requestBody);
        const references = [];

        for (const rawUrl of rawRefs) {
            logger.info('[ChatGPT Web] Uploading reference image to ChatGPT files API...');
            const uploaded = await uploadImageToChatGPT({
                image: rawUrl,
                fileName: `ref_${references.length + 1}.png`,
                accessToken: this.accessToken,
                proxyUrl: this.proxyUrl,
                config: this._getEffectiveConfig(),
                headers: this._buildHeaders('/backend-api/files'),
            });
            references.push(uploaded);
        }

        logger.info(`[ChatGPT Web] Starting image generation with model=${model}, prompt="${prompt.slice(0, 50)}...", refs=${references.length}`);

        const requirements = await this.getChatRequirements();
        const conduitToken = await this.prepareConversation(prompt, requirements, model, true);
        const stream = await this.startConversationStream(prompt, requirements, conduitToken, model, references, true);

        const { conversationId, initialFileIds, initialSedimentIds, streamError } = await this._consumeConversationSSE(stream);
        logger.info(`[ChatGPT Web] Stream finished. conversationId=${conversationId}, initialFiles=${initialFileIds.length}, initialSediments=${initialSedimentIds.length}`);

        if (streamError && initialFileIds.length === 0 && initialSedimentIds.length === 0) {
            throw new Error(`ChatGPT Web stream error: ${streamError}`);
        }

        let finalFileIds = [...initialFileIds];
        let finalSedimentIds = [...initialSedimentIds];

        if (conversationId && finalFileIds.length === 0 && finalSedimentIds.length === 0) {
            const polled = await this.pollImageResults(conversationId, 120, finalFileIds, finalSedimentIds);
            finalFileIds = polled.fileIds;
            finalSedimentIds = polled.sedimentIds;
        }

        const urls = await this.resolveImageUrls(conversationId, finalFileIds, finalSedimentIds);
        if (urls.length === 0) {
            throw new Error(`Failed to resolve generated image URLs for conversation ${conversationId || 'unknown'}`);
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
            _uuid: this.uuid,
        };
    }

    async _generateTextInternal(model, requestBody) {
        const prompt = this._extractPrompt(requestBody);
        const requirements = await this.getChatRequirements();
        const conduitToken = await this.prepareConversation(prompt, requirements, model, false);
        const stream = await this.startConversationStream(prompt, requirements, conduitToken, model, [], false);
        const { conversationId, streamError, lastAssistantText } = await this._consumeConversationSSE(stream);

        if (streamError && !lastAssistantText) {
            throw new Error(`ChatGPT Web conversation error: ${streamError}`);
        }

        let content = lastAssistantText;
        if (!content && conversationId) {
            const conversation = await this.getConversation(conversationId);
            content = this._extractTextFromConversationMapping(conversation);
        }

        return {
            id: `chatcmpl-${uuidv4()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model || 'auto',
            choices: [{
                index: 0,
                message: { role: 'assistant', content: content || '' },
                finish_reason: 'stop',
            }],
        };
    }

    async generateContent(model, requestBody, retryOnAuth = true) {
        await this.initialize();

        const isImageRequest = model === 'gpt-image-2' ||
            String(model || '').includes('image') ||
            String(requestBody?.model || '').includes('image') ||
            Boolean(requestBody?.response_format);

        try {
            if (isImageRequest) {
                return await this._generateImageInternal(model || 'gpt-image-2', requestBody);
            }
            return await this._generateTextInternal(model || 'auto', requestBody);
        } catch (err) {
            const status = err.response?.status;
            if (retryOnAuth && (status === 401 || status === 403) && this._canRefresh()) {
                logger.warn(`[ChatGPT Web] Received ${status} on generateContent; attempting token/session refresh and single retry...`);
                try {
                    await this.refreshToken();
                    return await this.generateContent(model, requestBody, false);
                } catch (refreshErr) {
                    logger.error(`[ChatGPT Web] In-flight refresh failed: ${refreshErr.message}`);
                    refreshErr.shouldSwitchCredential = true;
                    throw refreshErr;
                }
            }
            if (status === 401 || status === 403 || status === 429) {
                err.shouldSwitchCredential = true;
            }
            throw err;
        }
    }

    async *generateContentStream(model, requestBody) {
        const result = await this.generateContent(model, requestBody);
        if (Array.isArray(result?.data)) {
            const first = result.data[0];
            const imgRef = first?.url || (first?.b64_json ? `data:image/png;base64,${first.b64_json}` : '');
            yield {
                id: `chatcmpl-${uuidv4()}`,
                object: 'chat.completion.chunk',
                created: result.created || Math.floor(Date.now() / 1000),
                model,
                choices: [{
                    index: 0,
                    delta: { content: imgRef ? `![Generated Image](${imgRef})` : '' },
                    finish_reason: 'stop',
                }],
            };
            return;
        }

        const text = result?.choices?.[0]?.message?.content || '';
        yield {
            id: result?.id || `chatcmpl-${uuidv4()}`,
            object: 'chat.completion.chunk',
            created: result?.created || Math.floor(Date.now() / 1000),
            model: model || 'auto',
            choices: [{
                index: 0,
                delta: { content: text },
                finish_reason: 'stop',
            }],
        };
    }
}

export default {
    ChatGPTWebService,
    ImageContentPolicyError,
    CHATGPT_WEB_MODELS,
};
