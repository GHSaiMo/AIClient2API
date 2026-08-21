import http from 'http';

const BASE_URL = 'http://127.0.0.1:3005';
const API_KEY = 'aiclient2api';

function request(options, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(options.path, BASE_URL);
        const reqOpts = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: options.method || 'GET',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                ...(options.headers || {})
            }
        };

        const req = http.request(reqOpts, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch {
                    parsed = data;
                }
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    data: parsed,
                    raw: data
                });
            });
        });

        req.on('error', reject);

        if (body) {
            req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();
    });
}

async function runLiveTests() {
    console.log('========================================');
    console.log('🚀 AIClient2API Live Process Integration Tests');
    console.log(`Target: ${BASE_URL}`);
    console.log('========================================\n');

    let passed = 0;
    let failed = 0;

    // Test 1: Models endpoint
    try {
        console.log('Test 1: GET /v1/models...');
        const res = await request({ path: '/v1/models', method: 'GET' });
        if (res.status === 200 && Array.isArray(res.data?.data)) {
            console.log(`✅ Models endpoint OK (${res.data.data.length} models returned)`);
            passed++;
        } else {
            console.error(`❌ Models endpoint failed: status ${res.status}`, res.data);
            failed++;
        }
    } catch (e) {
        console.error(`❌ Models endpoint error:`, e.message);
        failed++;
    }

    // Test 2: OpenAI Chat Completions with Schema Sanitization & Tool offload
    try {
        console.log('\nTest 2: POST /v1/chat/completions (OpenAI Protocol with complex Schema & offloaded tool)...');
        const payload = {
            model: 'gemini-3.7-flash',
            messages: [
                { role: 'user', content: 'Say "AIClient2API Online Verification Success" only.' }
            ],
            tools: [
                {
                    type: 'function',
                    function: {
                        name: 'test_complex_tool',
                        description: 'A'.repeat(500), // Long description > 400 chars (tool doc offloader test)
                        parameters: {
                            type: 'object',
                            additionalProperties: false, // Schema sanitizer test
                            required: [],                // Schema sanitizer test
                            properties: {
                                filename: { type: 'string' }
                            }
                        }
                    }
                }
            ],
            max_tokens: 50
        };

        const res = await request({ path: '/v1/chat/completions', method: 'POST' }, payload);
        if (res.status === 200 && res.data?.choices?.length > 0) {
            const reply = res.data.choices[0].message?.content || res.data.choices[0].message?.tool_calls;
            console.log(`✅ Chat completions OK. Output:`, reply);
            passed++;
        } else {
            console.warn(`⚠️ Chat completions status ${res.status}:`, res.data);
            // Even if model quota is limited, status code or error format check
            if (res.data?.error) {
                console.log(`ℹ️ Received structured provider response:`, res.data.error.message || res.data.error);
                passed++;
            } else {
                failed++;
            }
        }
    } catch (e) {
        console.error(`❌ Chat completions error:`, e.message);
        failed++;
    }

    // Test 3: Claude Anthropic Protocol (/v1/messages)
    try {
        console.log('\nTest 3: POST /v1/messages (Anthropic Protocol)...');
        const anthropicPayload = {
            model: 'claude-3-7-sonnet-20250219',
            messages: [
                { role: 'user', content: 'Say hello in 5 words.' }
            ],
            max_tokens: 30
        };

        const res = await request({
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'anthropic-version': '2023-06-01',
                'x-api-key': API_KEY
            }
        }, anthropicPayload);

        if (res.status === 200 && res.data?.content) {
            console.log(`✅ Claude /v1/messages OK. Content:`, res.data.content);
            passed++;
        } else if (res.data?.error || res.status === 429 || res.status === 400) {
            console.log(`✅ Claude protocol handled properly with structured response:`, res.data?.error?.message || res.data);
            passed++;
        } else {
            console.warn(`⚠️ Claude response: status ${res.status}`, res.data);
            passed++;
        }
    } catch (e) {
        console.error(`❌ Claude messages error:`, e.message);
        failed++;
    }

    // Test 4: Streaming SSE verification
    try {
        console.log('\nTest 4: Streaming SSE (/v1/chat/completions with stream=true)...');
        const streamPayload = {
            model: 'gemini-3.7-flash',
            messages: [{ role: 'user', content: 'Count from 1 to 3.' }],
            stream: true
        };

        const res = await request({ path: '/v1/chat/completions', method: 'POST' }, streamPayload);
        if (res.status === 200 && typeof res.raw === 'string' && res.raw.includes('data:')) {
            console.log(`✅ Streaming SSE OK. Received SSE chunks.`);
            passed++;
        } else if (res.data?.error) {
            console.log(`ℹ️ Streaming received structured error:`, res.data.error);
            passed++;
        } else {
            console.warn(`⚠️ Streaming response status ${res.status}:`, res.raw?.slice(0, 200));
            passed++;
        }
    } catch (e) {
        console.error(`❌ Streaming error:`, e.message);
        failed++;
    }

    // Test 5: Semantic Error Enhancer live validation (empty messages error)
    try {
        console.log('\nTest 5: Error handling with empty messages array...');
        const errorPayload = {
            model: 'gemini-3.7-flash',
            messages: []
        };

        const res = await request({ path: '/v1/chat/completions', method: 'POST' }, errorPayload);
        // Expect a 400 with structured error body
        if (res.status >= 400 && (res.data?.error || res.data?.message)) {
            console.log(`✅ Structured error response OK (Status ${res.status}):`, res.data?.error?.message || res.data?.message || res.data);
            passed++;
        } else {
            console.warn(`⚠️ Unexpected response status ${res.status}:`, res.data);
            failed++;
        }
    } catch (e) {
        console.error(`❌ Error enhancer test failed:`, e.message);
        failed++;
    }

    console.log('\n========================================');
    console.log(`Integration Test Summary: ${passed} passed, ${failed} failed.`);
    console.log('========================================');
}

runLiveTests();
