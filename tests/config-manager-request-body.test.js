import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { initializeConfig } from '../src/core/config-manager.js';

const originalRequestBodyMaxBytes = process.env.REQUEST_BODY_MAX_BYTES;
const originalRequestBodyMaxMb = process.env.REQUEST_BODY_MAX_MB;
let consoleSpies = [];

beforeEach(() => {
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());

    if (originalRequestBodyMaxBytes === undefined) {
        delete process.env.REQUEST_BODY_MAX_BYTES;
    } else {
        process.env.REQUEST_BODY_MAX_BYTES = originalRequestBodyMaxBytes;
    }

    if (originalRequestBodyMaxMb === undefined) {
        delete process.env.REQUEST_BODY_MAX_MB;
    } else {
        process.env.REQUEST_BODY_MAX_MB = originalRequestBodyMaxMb;
    }
});

describe('request body size configuration', () => {
    test('keeps the default request body limit at 10MB', async () => {
        delete process.env.REQUEST_BODY_MAX_BYTES;
        delete process.env.REQUEST_BODY_MAX_MB;

        const config = await initializeConfig([], 'configs/missing-test-config.json');

        expect(config.REQUEST_BODY_MAX_BYTES).toBe(10 * 1024 * 1024);
    });

    test('uses REQUEST_BODY_MAX_BYTES from the environment', async () => {
        process.env.REQUEST_BODY_MAX_BYTES = '12345';
        delete process.env.REQUEST_BODY_MAX_MB;

        const config = await initializeConfig([], 'configs/missing-test-config.json');

        expect(config.REQUEST_BODY_MAX_BYTES).toBe(12345);
    });

    test('uses REQUEST_BODY_MAX_MB from the environment when bytes is not set', async () => {
        delete process.env.REQUEST_BODY_MAX_BYTES;
        process.env.REQUEST_BODY_MAX_MB = '64';

        const config = await initializeConfig([], 'configs/missing-test-config.json');

        expect(config.REQUEST_BODY_MAX_BYTES).toBe(64 * 1024 * 1024);
    });
});
