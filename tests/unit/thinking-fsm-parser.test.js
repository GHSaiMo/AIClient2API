import { describe, it, expect } from '@jest/globals';
import { ThinkingStreamFSM, FSM_STATE } from '../../src/converters/utils/thinking-fsm-parser.js';

describe('Phase 4.1: Thinking Stream FSM Parser Suite', () => {

    describe('1. Single-Chunk and parseAll tests', () => {
        it('should parse text without thinking tags', () => {
            const raw = 'Hello world, how can I assist you today?';
            const { thinking, text } = ThinkingStreamFSM.parseAll(raw);
            expect(thinking).toBe('');
            expect(text).toBe(raw);
        });

        it('should extract thinking and text from complete payload', () => {
            const raw = '<thinking>\nLet me analyze this math problem.\nFirst, calculate 2+2=4.\n</thinking>\nThe answer is 4.';
            const { thinking, text } = ThinkingStreamFSM.parseAll(raw);
            expect(thinking).toBe('Let me analyze this math problem.\nFirst, calculate 2+2=4.\n');
            expect(text).toBe('The answer is 4.');
        });
    });

    describe('2. Streaming Cross-Chunk Boundary Resilience', () => {
        it('should correctly buffer partial <thinking> tag split across chunks', () => {
            const fsm = new ThinkingStreamFSM();

            // Chunk 1 ends with '<think'
            const events1 = fsm.feed('Prefix text <think');
            // Chunk 2 contains 'ing>Actual thought</thinking>Result text'
            const events2 = fsm.feed('ing>Actual thought</thinking>Result text');
            const events3 = fsm.flush();

            const allEvents = [...events1, ...events2, ...events3];

            const textEvents = allEvents.filter(e => e.type === 'text').map(e => e.content).join('');
            const thinkingEvents = allEvents.filter(e => e.type === 'thinking').map(e => e.content).join('');

            expect(textEvents).toBe('Prefix text Result text');
            expect(thinkingEvents).toBe('Actual thought');
        });

        it('should correctly buffer partial </thinking> tag split across chunks', () => {
            const fsm = new ThinkingStreamFSM();

            fsm.feed('<thinking>Deep calculation step 1...');
            fsm.feed('step 2...</thin');
            fsm.feed('king>Final conclusion');
            fsm.flush();

            expect(fsm.collectedThinking).toBe('Deep calculation step 1...step 2...');
            expect(fsm.collectedText).toBe('Final conclusion');
        });

        it('should flush unfinished tag as text if stream ends abruptly', () => {
            const fsm = new ThinkingStreamFSM();

            fsm.feed('Comparison: a < b and c < d');
            const flushed = fsm.flush();

            expect(fsm.collectedText).toContain('Comparison: a < b and c < d');
            expect(fsm.collectedThinking).toBe('');
        });
    });
});
