class OrderedMap {
    constructor() {
        this.keys = [];
        this.values = {};
    }

    add(key, value) {
        if (!(key in this.values)) {
            this.keys.push(key);
        }
        this.values[key] = value;
    }
}

function turnstileToStr(value) {
    if (value === null || value === undefined) {
        return 'undefined';
    }
    if (typeof value === 'number') {
        return String(value);
    }
    if (typeof value === 'string') {
        const special = {
            'window.Math': '[object Math]',
            'window.Reflect': '[object Reflect]',
            'window.performance': '[object Performance]',
            'window.localStorage': '[object Storage]',
            'window.Object': 'function Object() { [native code] }',
            'window.Reflect.set': 'function set() { [native code] }',
            'window.performance.now': 'function () { [native code] }',
            'window.Object.create': 'function create() { [native code] }',
            'window.Object.keys': 'function keys() { [native code] }',
            'window.Math.random': 'function random() { [native code] }',
        };
        return special[value] || value;
    }
    if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
        return value.join(',');
    }
    return String(value);
}

function xorString(text, key) {
    if (!key || typeof text !== 'string') {
        return text;
    }
    let res = '';
    for (let i = 0; i < text.length; i++) {
        res += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return res;
}

export function solveTurnstileToken(dx, p) {
    if (!dx || !p) return null;

    let tokenList;
    try {
        const decoded = Buffer.from(dx, 'base64').toString('utf8');
        tokenList = JSON.parse(xorString(decoded, p));
    } catch {
        return null;
    }

    if (!Array.isArray(tokenList)) {
        return null;
    }

    const processMap = {};
    const startTime = Date.now();
    let result = '';

    const func_1 = (e, t) => {
        processMap[e] = xorString(turnstileToStr(processMap[e]), turnstileToStr(processMap[t]));
    };

    const func_2 = (e, t) => {
        processMap[e] = t;
    };

    const func_3 = (e) => {
        result = Buffer.from(String(e), 'utf8').toString('base64');
    };

    const func_5 = (e, t) => {
        const current = processMap[e];
        const incoming = processMap[t];
        if (Array.isArray(current)) {
            processMap[e] = [...current, incoming];
            return;
        }
        if (typeof current === 'string' || typeof current === 'number' || typeof incoming === 'string' || typeof incoming === 'number') {
            processMap[e] = turnstileToStr(current) + turnstileToStr(incoming);
            return;
        }
        processMap[e] = 'NaN';
    };

    const func_6 = (e, t, n) => {
        const tv = processMap[t];
        const nv = processMap[n];
        if (typeof tv === 'string' && typeof nv === 'string') {
            const val = `${tv}.${nv}`;
            processMap[e] = val === 'window.document.location' ? 'https://chatgpt.com/' : val;
        }
    };

    const func_7 = (e, ...args) => {
        const target = processMap[e];
        const values = args.map(arg => processMap[arg]);
        if (typeof target === 'string' && target === 'window.Reflect.set') {
            const [obj, keyName, val] = values;
            if (obj && typeof obj.add === 'function') {
                obj.add(String(keyName), val);
            }
        } else if (typeof target === 'function') {
            target(...values);
        }
    };

    const func_8 = (e, t) => {
        processMap[e] = processMap[t];
    };

    const func_14 = (e, t) => {
        try {
            processMap[e] = JSON.parse(processMap[t]);
        } catch {
            processMap[e] = null;
        }
    };

    const func_15 = (e, t) => {
        try {
            processMap[e] = JSON.stringify(processMap[t]);
        } catch {
            processMap[e] = '';
        }
    };

    const func_17 = (e, t, ...args) => {
        const callArgs = args.map(arg => processMap[arg]);
        const target = processMap[t];
        if (target === 'window.performance.now') {
            const elapsedMs = Date.now() - startTime;
            processMap[e] = elapsedMs + Math.random();
        } else if (target === 'window.Object.create') {
            processMap[e] = new OrderedMap();
        } else if (target === 'window.Object.keys') {
            if (callArgs.length > 0 && callArgs[0] === 'window.localStorage') {
                processMap[e] = [
                    'STATSIG_LOCAL_STORAGE_INTERNAL_STORE_V4',
                    'STATSIG_LOCAL_STORAGE_STABLE_ID',
                    'client-correlated-secret',
                    'oai/apps/capExpiresAt',
                    'oai-did',
                    'STATSIG_LOCAL_STORAGE_LOGGING_REQUEST',
                    'UiState.isNavigationCollapsed.1'
                ];
            } else if (callArgs.length > 0 && callArgs[0] instanceof OrderedMap) {
                processMap[e] = callArgs[0].keys;
            } else if (callArgs.length > 0 && typeof callArgs[0] === 'object' && callArgs[0] !== null) {
                processMap[e] = Object.keys(callArgs[0]);
            }
        } else if (target === 'window.Math.random') {
            processMap[e] = Math.random();
        } else if (typeof target === 'function') {
            processMap[e] = target(...callArgs);
        }
    };

    const func_18 = (e) => {
        try {
            processMap[e] = Buffer.from(turnstileToStr(processMap[e]), 'base64').toString('utf8');
        } catch {
            processMap[e] = '';
        }
    };

    const func_19 = (e) => {
        processMap[e] = Buffer.from(turnstileToStr(processMap[e]), 'utf8').toString('base64');
    };

    const func_20 = (e, t, n, ...args) => {
        if (processMap[e] === processMap[t]) {
            const target = processMap[n];
            if (typeof target === 'function') {
                target(...args.map(arg => processMap[arg]));
            }
        }
    };

    const func_21 = () => {};

    const func_23 = (e, t, ...args) => {
        if (processMap[e] !== null && typeof processMap[t] === 'function') {
            processMap[t](...args);
        }
    };

    const func_24 = (e, t, n) => {
        const tv = processMap[t];
        const nv = processMap[n];
        if (typeof tv === 'string' && typeof nv === 'string') {
            processMap[e] = `${tv}.${nv}`;
        }
    };

    Object.assign(processMap, {
        1: func_1,
        2: func_2,
        3: func_3,
        5: func_5,
        6: func_6,
        7: func_7,
        8: func_8,
        9: tokenList,
        10: 'window',
        14: func_14,
        15: func_15,
        16: p,
        17: func_17,
        18: func_18,
        19: func_19,
        20: func_20,
        21: func_21,
        23: func_23,
        24: func_24
    });

    for (const token of tokenList) {
        try {
            if (!Array.isArray(token) || token.length === 0) continue;
            const fn = processMap[token[0]];
            if (typeof fn === 'function') {
                fn(...token.slice(1));
            }
        } catch {
            continue;
        }
    }

    return result || null;
}
