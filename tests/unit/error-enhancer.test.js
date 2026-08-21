import { describe, it, expect } from '@jest/globals';
import {
    enhanceProviderError,
    isQuotaExhaustedError,
    isAuthExpiredError,
    ERROR_CODES
} from '../../src/utils/error-enhancer.js';

describe('Phase 4.2: Provider Error Semantic Enhancer Suite', () => {

    describe('1. Error Pattern Matching and Categorization', () => {
        it('should classify AWS CodeWhisperer monthly limit error as QUOTA_EXHAUSTED', () => {
            const rawError = new Error('Client error: Monthly limit reached for conversation queries');
            const enhanced = enhanceProviderError(rawError, 'claude-kiro-oauth');

            expect(enhanced.code).toBe(ERROR_CODES.QUOTA_EXHAUSTED);
            expect(enhanced.status).toBe(429);
            expect(enhanced.friendlyMessage).toContain('月度额度或积分已耗尽');
            expect(isQuotaExhaustedError(rawError)).toBe(true);
        });

        it('should classify invalid token error as AUTH_TOKEN_EXPIRED', () => {
            const rawError = { message: 'OAuth request failed: invalid_grant - refresh token has expired or been revoked', status: 401 };
            const enhanced = enhanceProviderError(rawError, 'grok-cli-oauth');

            expect(enhanced.code).toBe(ERROR_CODES.AUTH_TOKEN_EXPIRED);
            expect(enhanced.status).toBe(401);
            expect(enhanced.friendlyMessage).toContain('凭证已过期或失效');
            expect(isAuthExpiredError(rawError)).toBe(true);
        });

        it('should classify schema error as SCHEMA_VALIDATION_FAILED', () => {
            const rawError = 'Validation error: schema contains forbidden keyword additionalProperties';
            const enhanced = enhanceProviderError(rawError, 'claude-kiro-oauth');

            expect(enhanced.code).toBe(ERROR_CODES.SCHEMA_VALIDATION_FAILED);
            expect(enhanced.status).toBe(400);
            expect(enhanced.friendlyMessage).toContain('工具 inputSchema 格式不兼容');
        });

        it('should classify turn sequence error as INVALID_TURN_ORDER', () => {
            const rawError = new Error('Conversation turns must alternate between user and assistant');
            const enhanced = enhanceProviderError(rawError, 'claude-kiro-oauth');

            expect(enhanced.code).toBe(ERROR_CODES.INVALID_TURN_ORDER);
            expect(enhanced.status).toBe(400);
            expect(enhanced.friendlyMessage).toContain('对话轮次交替顺序异常');
        });

        it('should pass through unknown errors cleanly with isEnhanced=false', () => {
            const rawError = new Error('Custom mysterious internal error 987');
            const enhanced = enhanceProviderError(rawError, 'custom-provider');

            expect(enhanced.code).toBe(ERROR_CODES.UNKNOWN_PROVIDER_ERROR);
            expect(enhanced.isEnhanced).toBe(false);
            expect(enhanced.message).toBe('Custom mysterious internal error 987');
        });
    });
});
