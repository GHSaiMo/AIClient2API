import { describe, it, expect } from '@jest/globals';
import { extractKiroPromptRemaining } from '../../src/providers/provider-pool-manager.js';

describe('Phase 3.2: Account Pool Quota Smart Ranking Suite', () => {

    describe('1. Kiro Pure Prompt Quota Extraction (extractKiroPromptRemaining)', () => {
        it('should calculate remaining prompt credits correctly without bonus interference', () => {
            const accountConfig = {
                credits_total: 1000,
                credits_used: 350,
                bonus_total: 500, // Should be ignored
                bonus_used: 100   // Should be ignored
            };

            const remaining = extractKiroPromptRemaining(accountConfig);
            expect(remaining).toBe(650); // 1000 - 350
        });

        it('should support camelCase properties', () => {
            const accountConfig = {
                creditsTotal: 500,
                creditsUsed: 120
            };

            const remaining = extractKiroPromptRemaining(accountConfig);
            expect(remaining).toBe(380);
        });

        it('should support nested usage object', () => {
            const accountConfig = {
                usage: {
                    credits_total: 200,
                    credits_used: 50
                }
            };

            const remaining = extractKiroPromptRemaining(accountConfig);
            expect(remaining).toBe(150);
        });

        it('should floor at 0 when usage exceeds total', () => {
            const accountConfig = {
                credits_total: 100,
                credits_used: 150
            };

            const remaining = extractKiroPromptRemaining(accountConfig);
            expect(remaining).toBe(0);
        });

        it('should return null when quota information is absent', () => {
            expect(extractKiroPromptRemaining(null)).toBeNull();
            expect(extractKiroPromptRemaining({})).toBeNull();
            expect(extractKiroPromptRemaining({ apiKey: 'sk-123' })).toBeNull();
        });
    });

    describe('2. Multi-Candidate Priority Ranking Simulation', () => {
        it('should sort candidates by remaining prompt quota descending', () => {
            const candidates = [
                { id: 'node_low', credits_total: 100, credits_used: 80 },   // remaining = 20
                { id: 'node_high', credits_total: 1000, credits_used: 100 }, // remaining = 900
                { id: 'node_mid', credits_total: 500, credits_used: 200 }    // remaining = 300
            ];

            const sorted = [...candidates].sort((a, b) => {
                const remA = extractKiroPromptRemaining(a) ?? 0;
                const remB = extractKiroPromptRemaining(b) ?? 0;
                return remB - remA; // Higher remaining quota comes first
            });

            expect(sorted[0].id).toBe('node_high');
            expect(sorted[1].id).toBe('node_mid');
            expect(sorted[2].id).toBe('node_low');
        });
    });
});
