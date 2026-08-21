/**
 * 统一供应商错误语义化增强字典 (Provider Error Semantic Enhancer)
 * 
 * 借鉴 kiro-gateway kiro_errors.py 机制：
 * 将上游各供应商（AWS CodeWhisperer/Kiro, xAI Grok, Gemini, OpenAI Codex）返回的
 * 晦涩原始错误（如 JSON 结构报错、400 校验异常、额度耗尽等）转化为具备明确排查指引的标准化语义错误。
 */

export const ERROR_CODES = {
    QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
    RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
    AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
    INVALID_TURN_ORDER: 'INVALID_TURN_ORDER',
    SCHEMA_VALIDATION_FAILED: 'SCHEMA_VALIDATION_FAILED',
    UPSTREAM_HANG_OR_TIMEOUT: 'UPSTREAM_HANG_OR_TIMEOUT',
    UPSTREAM_SERVICE_UNAVAILABLE: 'UPSTREAM_SERVICE_UNAVAILABLE',
    UNKNOWN_PROVIDER_ERROR: 'UNKNOWN_PROVIDER_ERROR'
};

const ERROR_PATTERNS = [
    {
        code: ERROR_CODES.QUOTA_EXHAUSTED,
        status: 429,
        regexes: [
            /monthly.*limit.*reached/i,
            /quota.*exceeded/i,
            /insufficient.*quota/i,
            /credits.*exhausted/i,
            /out of credits/i,
            /resource_exhausted/i,
            /usage limit/i
        ],
        friendlyMessage: '上游供应商月度额度或积分已耗尽 (Monthly Quota / Credits Exhausted)，请轮换账号池或等待配额重置。'
    },
    {
        code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
        status: 429,
        regexes: [
            /rate.*limit/i,
            /too many requests/i,
            /throttl/i,
            /429/
        ],
        friendlyMessage: '触发上游请求速率限制 (Rate Limit Exceeded)，请稍后重试或配置适当的请求间隔。'
    },
    {
        code: ERROR_CODES.AUTH_TOKEN_EXPIRED,
        status: 401,
        regexes: [
            /token.*expired/i,
            /invalid.*token/i,
            /unauthorized/i,
            /authentication failed/i,
            /invalid_grant/i,
            /refresh_token.*invalid/i
        ],
        friendlyMessage: 'OAuth 访问凭证已过期或失效 (Auth Token Expired)，系统已排队触发自动刷新。'
    },
    {
        code: ERROR_CODES.INVALID_TURN_ORDER,
        status: 400,
        regexes: [
            /invalid.*turn/i,
            /must alternate/i,
            /tool_result.*without.*tool_use/i,
            /unexpected role/i
        ],
        friendlyMessage: '对话轮次交替顺序异常 (Invalid Turn Order)，例如存在未配对的 tool_result 或连续同角色消息。'
    },
    {
        code: ERROR_CODES.SCHEMA_VALIDATION_FAILED,
        status: 400,
        regexes: [
            /additionalproperties/i,
            /schema validation/i,
            /invalid input schema/i,
            /tool specification error/i
        ],
        friendlyMessage: '工具 inputSchema 格式不兼容上游校验 (Schema Validation Failed)，已启用 Schema 净化器自动清洗。'
    },
    {
        code: ERROR_CODES.UPSTREAM_HANG_OR_TIMEOUT,
        status: 504,
        regexes: [
            /timeout/i,
            /hang/i,
            /aborted/i,
            /premature close/i,
            /econnreset/i
        ],
        friendlyMessage: '上游连接超时或异常挂起 (Upstream Timeout / Hang)，建议检查网络代理与 Sidecar 状态。'
    }
];

/**
 * 识别并增强供应商错误信息
 * @param {Error|Object|string} error 
 * @param {string} [providerType] 
 * @param {Object} [context] 
 * @returns {{ code: string, status: number, originalMessage: string, message: string, friendlyMessage: string, isEnhanced: boolean }}
 */
export function enhanceProviderError(error, providerType = '', context = {}) {
    const rawMsg = typeof error === 'string' ? error : (error?.message || JSON.stringify(error) || 'Unknown error');
    
    for (const pattern of ERROR_PATTERNS) {
        for (const rx of pattern.regexes) {
            if (rx.test(rawMsg)) {
                return {
                    code: pattern.code,
                    status: error?.status || pattern.status,
                    providerType,
                    originalMessage: rawMsg,
                    friendlyMessage: pattern.friendlyMessage,
                    message: `[${providerType || 'Provider'} Error - ${pattern.code}] ${pattern.friendlyMessage} (Details: ${rawMsg})`,
                    isEnhanced: true
                };
            }
        }
    }

    return {
        code: ERROR_CODES.UNKNOWN_PROVIDER_ERROR,
        status: error?.status || 500,
        providerType,
        originalMessage: rawMsg,
        friendlyMessage: rawMsg,
        message: rawMsg,
        isEnhanced: false
    };
}

/**
 * 判断是否为额度耗尽类错误
 * @param {Error|Object|string} error 
 * @returns {boolean}
 */
export function isQuotaExhaustedError(error) {
    const enhanced = enhanceProviderError(error);
    return enhanced.code === ERROR_CODES.QUOTA_EXHAUSTED;
}

/**
 * 判断是否为认证过期类错误
 * @param {Error|Object|string} error 
 * @returns {boolean}
 */
export function isAuthExpiredError(error) {
    const enhanced = enhanceProviderError(error);
    return enhanced.code === ERROR_CODES.AUTH_TOKEN_EXPIRED;
}
