import { describe, it, expect, beforeEach } from '@jest/globals';
import { SingleflightGroup } from '../../src/utils/singleflight.js';

describe('Phase 3.1: Singleflight Concurrency Deduplication Suite', () => {
    let sf;

    beforeEach(() => {
        sf = new SingleflightGroup();
    });

    it('should execute single call and return result', async () => {
        let executionCount = 0;
        const result = await sf.do('key1', async () => {
            executionCount++;
            return 'success_val';
        });

        expect(result).toBe('success_val');
        expect(executionCount).toBe(1);
        expect(sf.activeCount).toBe(0);
    });

    it('should deduplicate concurrent duplicate calls to exactly 1 underlying execution', async () => {
        let executionCount = 0;

        // Create a slow promise
        const slowFn = async () => {
            executionCount++;
            await new Promise(resolve => setTimeout(resolve, 50));
            return 'shared_result';
        };

        // Fire 10 concurrent requests for the same key
        const promises = Array.from({ length: 10 }).map(() => sf.do('concurrent_key', slowFn));

        const results = await Promise.all(promises);

        // All 10 callers should receive the exact same result
        expect(results.every(r => r === 'shared_result')).toBe(true);
        // Underlying function should only execute ONCE
        expect(executionCount).toBe(1);
        expect(sf.activeCount).toBe(0);
    });

    it('should broadcast errors to all concurrent callers and clean up key', async () => {
        let executionCount = 0;

        const failingFn = async () => {
            executionCount++;
            await new Promise(resolve => setTimeout(resolve, 30));
            throw new Error('OAuth 429 Rate Limited');
        };

        const promises = Array.from({ length: 5 }).map(() => sf.do('failing_key', failingFn));

        const errors = await Promise.allSettled(promises);

        expect(executionCount).toBe(1);
        expect(errors.every(e => e.status === 'rejected' && e.reason.message.includes('OAuth 429'))).toBe(true);
        expect(sf.activeCount).toBe(0);

        // Subsequent call after completion should execute afresh
        const retryResult = await sf.do('failing_key', async () => 'recovered');
        expect(retryResult).toBe('recovered');
    });

    it('should allow different keys to execute independently in parallel', async () => {
        let countA = 0;
        let countB = 0;

        const [resA, resB] = await Promise.all([
            sf.do('key_A', async () => { countA++; return 'A'; }),
            sf.do('key_B', async () => { countB++; return 'B'; })
        ]);

        expect(resA).toBe('A');
        expect(resB).toBe('B');
        expect(countA).toBe(1);
        expect(countB).toBe(1);
    });
});
