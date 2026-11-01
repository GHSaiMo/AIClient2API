import { describe, it, expect } from '@jest/globals';
import {
    estimatePayloadTokensAndMedia,
    computeDynamicTimeout,
    ANTIGRAVITY_TIMEOUT_BASE_MS,
    ANTIGRAVITY_TIMEOUT_MIN_MS,
    ANTIGRAVITY_TIMEOUT_MAX_MS
} from '../../src/providers/gemini/antigravity-core.js';

describe('Antigravity Dynamic Adaptive Timeout Suite', () => {

    describe('1. estimatePayloadTokensAndMedia', () => {
        it('should handle null/empty body safely', () => {
            const res = estimatePayloadTokensAndMedia(null);
            expect(res.estimatedTokens).toBe(0);
            expect(res.mediaCount).toBe(0);
            expect(res.hasThinking).toBe(false);
        });

        it('should estimate tokens from text in systemInstruction and contents', () => {
            const body = {
                model: 'gemini-3.8-flash-low',
                request: {
                    systemInstruction: {
                        parts: [{ text: 'a'.repeat(380) }] // ~100 tokens
                    },
                    contents: [
                        {
                            role: 'user',
                            parts: [{ text: 'b'.repeat(380) }] // ~100 tokens
                        }
                    ]
                }
            };
            const res = estimatePayloadTokensAndMedia(body);
            expect(res.estimatedTokens).toBeGreaterThanOrEqual(200);
            expect(res.mediaCount).toBe(0);
            expect(res.hasThinking).toBe(false);
        });

        it('should detect multimodal inlineData parts', () => {
            const body = {
                model: 'gemini-3.8-flash-low',
                request: {
                    contents: [
                        {
                            role: 'user',
                            parts: [
                                { text: 'Analyze this' },
                                { inlineData: { mimeType: 'image/png', data: 'xyz' } },
                                { inlineData: { mimeType: 'image/jpeg', data: 'abc' } }
                            ]
                        }
                    ]
                }
            };
            const res = estimatePayloadTokensAndMedia(body);
            expect(res.mediaCount).toBe(2);
        });

        it('should detect thinking models and thinkingConfig', () => {
            const bodyThinkingModel = {
                model: 'gemini-3.8-flash-thinking',
                request: { contents: [{ parts: [{ text: 'hello' }] }] }
            };
            expect(estimatePayloadTokensAndMedia(bodyThinkingModel).hasThinking).toBe(true);

            const bodyThinkingConfig = {
                model: 'gemini-3.8-flash-low',
                request: {
                    generationConfig: {
                        thinkingConfig: { thinkingBudget: 2048 }
                    },
                    contents: [{ parts: [{ text: 'hello' }] }]
                }
            };
            expect(estimatePayloadTokensAndMedia(bodyThinkingConfig).hasThinking).toBe(true);
        });
    });

    describe('2. computeDynamicTimeout Scaling Tiers', () => {
        it('should return base 60s for standard short turns (< 15k tokens)', () => {
            const body = {
                model: 'gemini-3.8-flash-low',
                request: {
                    contents: [{ parts: [{ text: 'Quick query' }] }]
                }
            };
            const { timeoutMs, details } = computeDynamicTimeout(body);
            expect(timeoutMs).toBe(60000);
            expect(details.contextBonusMs).toBe(0);
            expect(details.mediaBonusMs).toBe(0);
        });

        it('should scale to 90s for medium context (15k - 50k tokens)', () => {
            // ~20k tokens = ~76k characters
            const body = {
                model: 'gemini-3.8-flash-low',
                request: {
                    contents: [{ parts: [{ text: 'x'.repeat(76000) }] }]
                }
            };
            const { timeoutMs, details } = computeDynamicTimeout(body);
            expect(timeoutMs).toBe(90000);
            expect(details.contextBonusMs).toBe(30000);
        });

        it('should scale to 150s for heavy context (50k - 100k tokens)', () => {
            // ~60k tokens = ~228k characters
            const body = {
                model: 'gemini-3.8-flash-low',
                request: {
                    contents: [{ parts: [{ text: 'x'.repeat(228000) }] }]
                }
            };
            const { timeoutMs, details } = computeDynamicTimeout(body);
            expect(timeoutMs).toBe(150000);
            expect(details.contextBonusMs).toBe(90000);
        });

        it('should scale to 240s for ultra-long context (>= 100k tokens)', () => {
            // ~110k tokens = ~418k characters
            const body = {
                model: 'gemini-3.8-flash-low',
                request: {
                    contents: [{ parts: [{ text: 'x'.repeat(418000) }] }]
                }
            };
            const { timeoutMs, details } = computeDynamicTimeout(body);
            expect(timeoutMs).toBe(240000);
            expect(details.contextBonusMs).toBe(180000);
        });

        it('should add media bonus (+10s per part, capped at +60s)', () => {
            const body = {
                model: 'gemini-3.8-flash-low',
                request: {
                    contents: [{
                        parts: [
                            { text: 'Look at images' },
                            { inlineData: { mimeType: 'image/png' } },
                            { inlineData: { mimeType: 'image/png' } }
                        ]
                    }]
                }
            };
            const { timeoutMs, details } = computeDynamicTimeout(body);
            expect(details.mediaBonusMs).toBe(20000);
            expect(timeoutMs).toBe(80000);
        });

        it('should floor thinking models at 120s minimum', () => {
            const body = {
                model: 'gemini-3.8-flash-thinking',
                request: {
                    contents: [{ parts: [{ text: 'Ponder this deeply' }] }]
                }
            };
            const { timeoutMs, details } = computeDynamicTimeout(body);
            expect(details.hasThinking).toBe(true);
            expect(timeoutMs).toBe(120000);
        });

        it('should respect maxTimeoutMs ceiling clamp (300s)', () => {
            const body = {
                model: 'gemini-3.8-flash-thinking',
                request: {
                    contents: [
                        { parts: [{ text: 'x'.repeat(600000) }] }, // >150k tokens
                        { inlineData: { mimeType: 'image/png' } }
                    ]
                }
            };
            const { timeoutMs } = computeDynamicTimeout(body);
            expect(timeoutMs).toBeLessThanOrEqual(300000);
        });
    });
});
