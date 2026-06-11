import { describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import { getRequestBody } from '../src/utils/common.js';

function makeRequest(chunks) {
    return Readable.from(chunks);
}

describe('getRequestBody', () => {
    test('parses JSON when body is within optional maxBytes limit', async () => {
        await expect(
            getRequestBody(makeRequest(['{"ok":true}']), { maxBytes: 32 })
        ).resolves.toEqual({ ok: true });
    });

    test('rejects JSON bodies larger than the default 10MB limit', async () => {
        const req = new EventEmitter();
        req.headers = { 'content-length': String(10 * 1024 * 1024 + 1) };
        req.resume = jest.fn();

        await expect(
            getRequestBody(req)
        ).rejects.toMatchObject({
            statusCode: 413
        });
        expect(req.resume).toHaveBeenCalledTimes(1);
    });

    test('parses JSON bodies larger than 10MB when maxBytes is increased', async () => {
        const payload = 'x'.repeat(10 * 1024 * 1024 + 1);

        await expect(
            getRequestBody(makeRequest([JSON.stringify({ payload })]), { maxBytes: 12 * 1024 * 1024 })
        ).resolves.toEqual({ payload });
    });

    test('rejects JSON bodies that exceed optional maxBytes limit', async () => {
        const req = new EventEmitter();
        req.destroy = jest.fn();
        const promise = getRequestBody(req, { maxBytes: 8 });

        req.emit('data', Buffer.from('{"payload":"too-large"}'));
        req.emit('end');

        await expect(promise).rejects.toMatchObject({
            statusCode: 413
        });
        expect(req.destroy).not.toHaveBeenCalled();
    });
});
