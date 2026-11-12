import { UndiciHttpClient } from '../../utils/undici-client.js';
import logger from '../../utils/logger.js';
import { MODEL_PROVIDER } from '../../utils/common.js';
import { configureUndiciTLSSidecar, getUndiciDispatcherForUrl } from '../../utils/proxy-utils.js';
import { mergeSetCookieHeaders, extractCookieValue } from './chatgpt-cookie-extractor.js';

const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CHATGPT_BASE_URL = 'https://chatgpt.com';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const sharedClient = new UndiciHttpClient();

function normalizeRequestConfig(configOrProxy = null) {
    if (!configOrProxy) {
        return { MODEL_PROVIDER: MODEL_PROVIDER.CHATGPT_WEB };
    }
    if (typeof configOrProxy === 'string') {
        return {
            MODEL_PROVIDER: MODEL_PROVIDER.CHATGPT_WEB,
            PROXY_URL: configOrProxy,
            PROXY_ENABLED_PROVIDERS: [MODEL_PROVIDER.CHATGPT_WEB],
        };
    }
    return {
        ...configOrProxy,
        MODEL_PROVIDER: configOrProxy.MODEL_PROVIDER || MODEL_PROVIDER.CHATGPT_WEB,
    };
}

function buildChatGPTRequestOptions(url, { method = 'GET', headers = {}, data = null, timeout = 30000 } = {}, configOrProxy = null) {
    const config = normalizeRequestConfig(configOrProxy);
    const providerType = config.MODEL_PROVIDER || MODEL_PROVIDER.CHATGPT_WEB;
    const reqOptions = {
        url,
        method,
        headers: { ...headers },
        ...(data !== null ? { data } : {}),
        timeout,
    };
    configureUndiciTLSSidecar(reqOptions, config, providerType, CHATGPT_BASE_URL);
    if (!reqOptions.dispatcher && typeof configOrProxy === 'string' && configOrProxy) {
        reqOptions.dispatcher = getUndiciDispatcherForUrl(configOrProxy, 'ChatGPT-Token-Service');
        reqOptions.proxyUrl = configOrProxy;
    }
    return reqOptions;
}

/**
 * 解码 JWT Payload
 * @param {string} token
 * @returns {Object}
 */
export function decodeJwtPayload(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length < 2) return {};
        let payload = parts[1];
        payload += '='.repeat((4 - (payload.length % 4)) % 4);
        const jsonStr = Buffer.from(payload, 'base64').toString('utf8');
        const data = JSON.parse(jsonStr);
        return typeof data === 'object' && data !== null ? data : {};
    } catch {
        return {};
    }
}

/**
 * 从 ChatGPT JWT 中提取 chatgpt_account_id
 * @param {string} token
 * @returns {string|null}
 */
export function extractAccountIdFromJwt(token) {
    const payload = decodeJwtPayload(token);
    return payload?.['https://api.openai.com/auth']?.chatgpt_account_id || null;
}

/**
 * 判断 JWT 是否接近过期（默认剩余 24 小时以内）
 * @param {string} token
 * @param {number} skewSeconds
 * @returns {boolean}
 */
export function isJwtExpiredOrNear(token, skewSeconds = 24 * 60 * 60) {
    const payload = decodeJwtPayload(token);
    const exp = payload.exp;
    if (!exp) return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    return exp - nowSeconds <= skewSeconds;
}

/**
 * 刷新 ChatGPT OAuth Access Token
 * @param {string} refreshToken
 * @param {string|Object|null} [configOrProxy]
 * @returns {Promise<Object>}
 */
export async function refreshAccessToken(refreshToken, configOrProxy = null) {
    if (!refreshToken) {
        throw new Error('refresh_token is required');
    }

    const reqOptions = buildChatGPTRequestOptions(
        OAUTH_TOKEN_URL,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': DEFAULT_USER_AGENT,
                'Accept': 'application/json',
            },
            data: {
                grant_type: 'refresh_token',
                client_id: OAUTH_CLIENT_ID,
                refresh_token: refreshToken,
            },
            timeout: 30000,
        },
        configOrProxy
    );

    logger.info('[ChatGPT Token Service] Refreshing access token via OAuth endpoint...');
    const response = await sharedClient.request(reqOptions);
    const data = response.data || {};

    if (!data.access_token) {
        throw new Error(`Token refresh failed: missing access_token in response (${JSON.stringify(data)})`);
    }

    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token || refreshToken,
        id_token: data.id_token || null,
        expires_in: data.expires_in || 3600,
    };
}

/**
 * 使用 ChatGPT Web 浏览器 Cookie (NextAuth session-token) 换取或刷新 Access Token
 * @param {string} cookieHeader
 * @param {string|Object|null} [configOrProxy]
 * @param {Object} [fp]
 * @returns {Promise<Object>}
 */
export async function refreshSessionFromCookies(cookieHeader, configOrProxy = null, fp = {}) {
    if (!cookieHeader) {
        throw new Error('cookie_header is required to refresh ChatGPT Web session');
    }

    const userAgent = fp['user-agent'] || DEFAULT_USER_AGENT;
    const reqOptions = buildChatGPTRequestOptions(
        `${CHATGPT_BASE_URL}/api/auth/session`,
        {
            method: 'GET',
            headers: {
                'Cookie': cookieHeader,
                'User-Agent': userAgent,
                'Origin': CHATGPT_BASE_URL,
                'Referer': `${CHATGPT_BASE_URL}/`,
                'Accept': 'application/json',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
            timeout: 30000,
        },
        configOrProxy
    );

    logger.info('[ChatGPT Token Service] Exchanging browser cookies via /api/auth/session...');
    let response;
    try {
        response = await sharedClient.request(reqOptions);
    } catch (err) {
        const status = err.response?.status;
        if (status === 401) {
            err.isDefinitiveAuthFailure = true;
        }
        throw err;
    }

    const data = response.data;
    if (!data || typeof data !== 'object' || !data.accessToken) {
        const err = new Error('ChatGPT Web session expired or missing accessToken in /api/auth/session response');
        err.isDefinitiveAuthFailure = true;
        throw err;
    }

    const updatedCookieHeader = mergeSetCookieHeaders(cookieHeader, response.headers?.['set-cookie']);
    const jwt = decodeJwtPayload(data.accessToken);
    const authClaims = jwt['https://api.openai.com/auth'] || {};
    const profileClaims = jwt['https://api.openai.com/profile'] || {};

    return {
        access_token: data.accessToken,
        email: data.user?.email || profileClaims.email || null,
        user_id: data.user?.id || authClaims.user_id || null,
        account_id: data.account?.id || authClaims.chatgpt_account_id || null,
        accountType: data.account?.planType || authClaims.chatgpt_plan_type || 'free',
        expires: data.expires || (jwt.exp ? new Date(jwt.exp * 1000).toISOString() : null),
        cookie_header: updatedCookieHeader,
    };
}

/**
 * 提取配额与恢复时间
 * @param {Array} limitsProgress
 * @returns {[number, string|null]}
 */
export function extractQuotaAndRestoreAt(limitsProgress) {
    if (!Array.isArray(limitsProgress)) {
        return [0, null];
    }
    for (const item of limitsProgress) {
        if (item && typeof item === 'object' && item.feature_name === 'image_gen') {
            const quota = Number(item.remaining) || 0;
            const resetAfter = item.reset_after ? String(item.reset_after) : null;
            return [quota, resetAfter];
        }
    }
    return [0, null];
}

/**
 * 获取账号详细信息及图片配额（纯 Node.js + Undici/TLS Sidecar 直连）
 * @param {string} accessToken
 * @param {string|Object|null} [configOrProxy]
 * @param {Object} [fp]
 * @param {string|null} [cookieHeader]
 * @returns {Promise<Object>}
 */
export async function fetchUserInfo(accessToken, configOrProxy = null, fp = {}, cookieHeader = null) {
    if (!accessToken) {
        throw new Error('access_token is required to fetch user info');
    }

    const userAgent = fp['user-agent'] || DEFAULT_USER_AGENT;
    const accountId = extractAccountIdFromJwt(accessToken);
    const cookieDeviceId = extractCookieValue(cookieHeader, 'oai-did');
    const deviceId = fp['oai-device-id'] || cookieDeviceId || '00000000-0000-4000-8000-000000000000';
    const sessionId = fp['oai-session-id'] || '00000000-0000-4000-8000-000000000001';

    const buildHeaders = (targetPath) => ({
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': userAgent,
        'Origin': CHATGPT_BASE_URL,
        'Referer': `${CHATGPT_BASE_URL}/`,
        'Accept': 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'OAI-Device-Id': deviceId,
        'OAI-Session-Id': sessionId,
        'OAI-Language': 'zh-CN',
        'X-OpenAI-Target-Path': targetPath,
        'X-OpenAI-Target-Route': targetPath,
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
        ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
    });

    const getMe = async () => {
        const targetPath = '/backend-api/me';
        const res = await sharedClient.request(
            buildChatGPTRequestOptions(`${CHATGPT_BASE_URL}${targetPath}`, {
                method: 'GET',
                headers: buildHeaders(targetPath),
                timeout: 20000,
            }, configOrProxy)
        );
        return res.data || {};
    };

    const getInit = async () => {
        const targetPath = '/backend-api/conversation/init';
        const res = await sharedClient.request(
            buildChatGPTRequestOptions(`${CHATGPT_BASE_URL}${targetPath}`, {
                method: 'POST',
                headers: { ...buildHeaders(targetPath), 'Content-Type': 'application/json' },
                data: {
                    gizmo_id: null,
                    requested_default_model: null,
                    conversation_id: null,
                    timezone_offset_min: -480,
                },
                timeout: 20000,
            }, configOrProxy)
        );
        return res.data || {};
    };

    const getDefaultAccount = async () => {
        const targetPath = '/backend-api/accounts/check/v4-2023-04-27';
        const res = await sharedClient.request(
            buildChatGPTRequestOptions(`${CHATGPT_BASE_URL}${targetPath}?timezone_offset_min=-480`, {
                method: 'GET',
                headers: buildHeaders(targetPath),
                timeout: 20000,
            }, configOrProxy)
        );
        const accountsData = res.data || {};
        const acctMap = accountsData.accounts || {};
        const defaultAcct = acctMap.default || Object.values(acctMap)[0] || {};
        return defaultAcct.account || defaultAcct || {};
    };

    const [meRes, initRes, acctRes] = await Promise.allSettled([getMe(), getInit(), getDefaultAccount()]);

    if (meRes.status === 'rejected' && initRes.status === 'rejected' && acctRes.status === 'rejected') {
        throw meRes.reason || initRes.reason || acctRes.reason;
    }

    const me = meRes.status === 'fulfilled' ? meRes.value : {};
    const init = initRes.status === 'fulfilled' ? initRes.value : {};
    const acct = acctRes.status === 'fulfilled' ? acctRes.value : {};

    const jwt = decodeJwtPayload(accessToken);
    const jwtAuth = jwt['https://api.openai.com/auth'] || {};
    const jwtProfile = jwt['https://api.openai.com/profile'] || {};

    const email = me.email || jwtProfile.email || jwt.email || null;
    const userId = me.id || jwtAuth.user_id || null;
    const planType = acct.plan_type || jwtAuth.chatgpt_plan_type || 'free';
    const limitsProgress = init.limits_progress || [];
    const [quota, restoreAt] = extractQuotaAndRestoreAt(limitsProgress);

    return {
        email,
        user_id: userId,
        account_id: accountId,
        type: planType,
        quota,
        limits_progress: limitsProgress,
        default_model_slug: init.default_model_slug || 'auto',
        restore_at: restoreAt,
        status: limitsProgress.some(l => l?.feature_name === 'image_gen') && quota === 0 ? '限流' : '正常',
    };
}

export default {
    decodeJwtPayload,
    extractAccountIdFromJwt,
    isJwtExpiredOrNear,
    refreshAccessToken,
    refreshSessionFromCookies,
    fetchUserInfo,
    extractQuotaAndRestoreAt,
};
