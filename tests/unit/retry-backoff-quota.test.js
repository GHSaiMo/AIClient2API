import {
    isQuotaExhaustedError,
    getQuotaCooldownRecoveryTime,
    calculateRetryDelay,
    handleError
} from '../../src/utils/common.js';
import logger from '../../src/utils/logger.js';

describe('Retry Backoff, Quota Cooldown and Error Logging Suite', () => {
    describe('Quota Exhaustion Detection', () => {
        test('should identify 402 HTTP status as quota exhausted', () => {
            const error = { status: 402, message: 'Payment Required' };
            expect(isQuotaExhaustedError(error)).toBe(true);
        });

        test('should identify response.status 402', () => {
            const error = { response: { status: 402 }, message: 'Error' };
            expect(isQuotaExhaustedError(error)).toBe(true);
        });

        test('should identify spending-limit in error message', () => {
            const error = { message: 'personal-team-blocked:spending-limit' };
            expect(isQuotaExhaustedError(error)).toBe(true);
        });

        test('should identify monthly limit message from Kiro', () => {
            const error = { message: 'You have reached the limit | MONTHLY_REQUEST_COUNT' };
            expect(isQuotaExhaustedError(error)).toBe(true);
        });

        test('should identify quota in response data string', () => {
            const error = { message: 'Failed', response: { data: 'usage_limit_reached' } };
            expect(isQuotaExhaustedError(error)).toBe(true);
        });

        test('should return false for regular errors (e.g. 500, network error)', () => {
            expect(isQuotaExhaustedError({ status: 500, message: 'Internal Server Error' })).toBe(false);
            expect(isQuotaExhaustedError({ code: 'ECONNRESET', message: 'Connection reset' })).toBe(false);
            expect(isQuotaExhaustedError(null)).toBe(false);
        });
    });

    describe('Quota Cooldown Recovery Time', () => {
        test('should return scheduled recovery time ~5 mins in the future for quota error', () => {
            const now = Date.now();
            const error = { status: 402, message: 'Payment Required' };
            const recoveryTime = getQuotaCooldownRecoveryTime(error, {
                QUOTA_COOLDOWN_MS: 300000,
                QUOTA_COOLDOWN_JITTER_MS: 0
            }, now);

            expect(recoveryTime).toBeInstanceOf(Date);
            expect(recoveryTime.getTime()).toBe(now + 300000);
        });

        test('should return null for non-quota error', () => {
            const error = { status: 404, message: 'Not Found' };
            expect(getQuotaCooldownRecoveryTime(error)).toBeNull();
        });
    });

    describe('Exponential Backoff with Jitter', () => {
        test('should calculate bounded exponential backoff delays', () => {
            const delay0 = calculateRetryDelay(0, 1000, 8000);
            expect(delay0).toBeGreaterThanOrEqual(500);
            expect(delay0).toBeLessThanOrEqual(2000);

            const delay1 = calculateRetryDelay(1, 1000, 8000);
            expect(delay1).toBeGreaterThanOrEqual(1000);
            expect(delay1).toBeLessThanOrEqual(3000);

            const delay2 = calculateRetryDelay(2, 1000, 8000);
            expect(delay2).toBeGreaterThanOrEqual(1500);
            expect(delay2).toBeLessThanOrEqual(4500);

            // High retry capped at maxDelay + jitter
            const delay10 = calculateRetryDelay(10, 1000, 8000);
            expect(delay10).toBeLessThanOrEqual(9500);
        });
    });

    describe('Error Logging Optimization', () => {
        test('should handle client 401 error with single-line response without crashing', () => {
            const mockRes = {
                headersSent: false,
                writeHead: jest.fn(),
                end: jest.fn()
            };
            const error = { status: 401, message: 'Unauthorized: API key is invalid or missing.' };
            
            handleError(mockRes, error, 'gemini-antigravity');
            
            expect(mockRes.writeHead).toHaveBeenCalledWith(401, { 'Content-Type': 'application/json' });
            const body = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(body.error.code).toBe(401);
            expect(body.error.message).toContain('Unauthorized');
        });

        test('should handle server 500 error properly', () => {
            const mockRes = {
                headersSent: false,
                writeHead: jest.fn(),
                end: jest.fn()
            };
            const error = new Error('Database connection failed');
            error.statusCode = 500;
            
            handleError(mockRes, error);
            
            expect(mockRes.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
            const body = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(body.error.code).toBe(500);
        });
    });
});
