import axios from 'axios';
import logger from '../../utils/logger.js';
import { parseProxyUrl } from '../../utils/proxy-utils.js';
import { getChatGPTRunnerManager } from './chatgpt-runner-manager.js';

const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

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
 * @param {string} [proxyUrl] 
 * @returns {Promise<Object>}
 */
export async function refreshAccessToken(refreshToken, proxyUrl = null) {
    if (!refreshToken) {
        throw new Error('refresh_token is required');
    }

    // Try via ChatGPTRunner first if available
    try {
        const runner = getChatGPTRunnerManager();
        const isReady = await runner.ensureReady();
        if (isReady) {
            const res = await axios.post(`${runner.baseUrl}/refresh-token`, {
                refresh_token: refreshToken,
                proxy_url: proxyUrl
            }, { timeout: 30000 });
            if (res.data && res.data.access_token) {
                return res.data;
            }
        }
    } catch (e) {
        logger.warn(`[ChatGPT Token Service] Runner refresh failed, falling back to direct OAuth: ${e.message}`);
    }

    const axiosConfig = {
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': DEFAULT_USER_AGENT,
            'Accept': 'application/json'
        },
        timeout: 30000
    };

    if (proxyUrl) {
        const proxyConfig = parseProxyUrl(proxyUrl);
        if (proxyConfig) {
            axiosConfig.httpAgent = proxyConfig.httpAgent;
            axiosConfig.httpsAgent = proxyConfig.httpsAgent;
            axiosConfig.proxy = false;
        }
    }

    const payload = {
        grant_type: 'refresh_token',
        client_id: OAUTH_CLIENT_ID,
        refresh_token: refreshToken
    };

    logger.info('[ChatGPT Token Service] Refreshing access token via OAuth endpoint...');
    const response = await axios.post(OAUTH_TOKEN_URL, payload, axiosConfig);
    const data = response.data || {};

    if (!data.access_token) {
        throw new Error(`Token refresh failed: missing access_token in response (${JSON.stringify(data)})`);
    }

    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token || refreshToken,
        id_token: data.id_token || null,
        expires_in: data.expires_in || 3600
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
 * 获取账号详细信息及图片配额（通过 Python curl_cffi runner）
 * @param {string} accessToken 
 * @param {string} [proxyUrl] 
 * @param {Object} [fp] 
 * @returns {Promise<Object>}
 */
export async function fetchUserInfo(accessToken, proxyUrl = null, fp = {}) {
    if (!accessToken) {
        throw new Error('access_token is required to fetch user info');
    }

    const runner = getChatGPTRunnerManager();
    const isReady = await runner.ensureReady();
    if (!isReady) {
        throw new Error('ChatGPT-Web Python runner engine is not ready');
    }

    const res = await axios.post(`${runner.baseUrl}/user-info`, {
        access_token: accessToken,
        proxy_url: proxyUrl
    }, { timeout: 30000 });

    const info = res.data || {};
    return {
        email: info.email || decodeJwtPayload(accessToken)?.['https://api.openai.com/profile']?.email || null,
        user_id: info.user_id || null,
        type: info.type || 'free',
        quota: typeof info.quota === 'number' ? info.quota : 0,
        limits_progress: info.limits_progress || [],
        default_model_slug: info.default_model_slug || 'auto',
        restore_at: info.restore_at || null,
        status: info.status || (info.quota === 0 ? '限流' : '正常')
    };
}

export default {
    decodeJwtPayload,
    isJwtExpiredOrNear,
    refreshAccessToken,
    fetchUserInfo,
    extractQuotaAndRestoreAt
};
