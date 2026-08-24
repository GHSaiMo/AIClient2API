import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

export const DEFAULT_POW_SCRIPT = 'https://chatgpt.com/backend-api/sentinel/sdk.js';

const CORES = [8, 16, 24, 32];
const DOCUMENT_KEYS = ['__reactContainer$fzelfjyxej8', '_reactListening5dehydibo78', 'location'];
const SCREEN_RESOLUTIONS = [[1920, 1080], [1440, 900], [2560, 1440], [3840, 2160]];

/**
 * 从首页 HTML 内容中提取 script sources 和 data-build
 * @param {string} htmlContent
 * @returns {[string[], string]}
 */
export function parsePowResources(htmlContent) {
    if (!htmlContent || typeof htmlContent !== 'string') {
        return [[DEFAULT_POW_SCRIPT], ''];
    }

    const scriptSources = [];
    let dataBuild = '';

    const scriptSrcRegex = /<script[^>]+src=["']([^"']+)["']/gi;
    let match;
    while ((match = scriptSrcRegex.exec(htmlContent)) !== null) {
        const src = match[1];
        scriptSources.push(src);
        const buildMatch = src.match(/c\/[^/]*\/_/);
        if (buildMatch) {
            dataBuild = buildMatch[0];
        }
    }

    if (!dataBuild) {
        const htmlBuildMatch = htmlContent.match(/<html[^>]*data-build=["']([^"']*)["']/i);
        if (htmlBuildMatch) {
            dataBuild = htmlBuildMatch[1];
        }
    }

    return [scriptSources.length > 0 ? scriptSources : [DEFAULT_POW_SCRIPT], dataBuild];
}

function legacyParseTime() {
    // 构造 GMT-0500 (Eastern Standard Time)
    const now = new Date();
    const estOffsetMs = -5 * 60 * 60 * 1000;
    const utcMs = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
    const estDate = new Date(utcMs + estOffsetMs);

    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const pad = (num) => String(num).padStart(2, '0');
    const dayName = days[estDate.getDay()];
    const monthName = months[estDate.getMonth()];
    const dateNum = pad(estDate.getDate());
    const year = estDate.getFullYear();
    const hours = pad(estDate.getHours());
    const minutes = pad(estDate.getMinutes());
    const seconds = pad(estDate.getSeconds());

    return `${dayName} ${monthName} ${dateNum} ${year} ${hours}:${minutes}:${seconds} GMT-0500 (Eastern Standard Time)`;
}

const NAVIGATOR_KEYS = [
    'registerProtocolHandler−function registerProtocolHandler() { [native code] }',
    'storage−[object StorageManager]',
    'locks−[object LockManager]',
    'appCodeName−Mozilla',
    'permissions−[object Permissions]',
    'share−function share() { [native code] }',
    'webdriver−false',
    'managed−[object NavigatorManagedData]',
    'canShare−function canShare() { [native code] }',
    'vendor−Google Inc.',
    'mediaDevices−[object MediaDevices]',
    'vibrate−function vibrate() { [native code] }',
    'storageBuckets−[object StorageBucketManager]',
    'mediaCapabilities−[object MediaCapabilities]',
    'cookieEnabled−true',
    'virtualKeyboard−[object VirtualKeyboard]',
    'product−Gecko',
    'presentation−[object Presentation]',
    'onLine−true',
    'mimeTypes−[object MimeTypeArray]',
    'credentials−[object CredentialsContainer]',
    'serviceWorker−[object ServiceWorkerContainer]',
    'keyboard−[object Keyboard]',
    'gpu−[object GPU]',
    'doNotTrack',
    'serial−[object Serial]',
    'pdfViewerEnabled−true',
    'language−zh-CN',
    'geolocation−[object Geolocation]',
    'userAgentData−[object NavigatorUAData]',
    'getUserMedia−function getUserMedia() { [native code] }',
    'sendBeacon−function sendBeacon() { [native code] }',
    'hardwareConcurrency−32',
    'windowControlsOverlay−[object WindowControlsOverlay]'
];

const WINDOW_KEYS = [
    '0', 'window', 'self', 'document', 'name', 'location',
    'customElements', 'history', 'navigation', 'innerWidth', 'innerHeight',
    'scrollX', 'scrollY', 'visualViewport', 'screenX', 'screenY',
    'outerWidth', 'outerHeight', 'devicePixelRatio', 'screen', 'chrome',
    'navigator', 'onresize', 'performance', 'crypto', 'indexedDB',
    'sessionStorage', 'localStorage', 'scheduler', 'alert', 'atob',
    'btoa', 'fetch', 'matchMedia', 'postMessage', 'queueMicrotask',
    'requestAnimationFrame', 'setInterval', 'setTimeout', 'caches',
    '__NEXT_DATA__', '__BUILD_MANIFEST', '__NEXT_PRELOADREADY'
];

function randomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

export function buildPowConfig(userAgent, scriptSources = null, dataBuild = '') {
    const randomRes = randomChoice(SCREEN_RESOLUTIONS);
    const screenResSum = randomRes[0] + randomRes[1];
    const scriptSource = scriptSources && scriptSources.length > 0
        ? randomChoice(scriptSources)
        : DEFAULT_POW_SCRIPT;

    const perfNow = performance.now();
    const timeNow = Date.now();

    return [
        screenResSum,
        legacyParseTime(),
        4294705152,
        1,
        userAgent,
        scriptSource,
        dataBuild,
        'en-US',
        'en-US,es-US,en,es',
        Math.random(),
        randomChoice(NAVIGATOR_KEYS),
        randomChoice(DOCUMENT_KEYS),
        randomChoice(WINDOW_KEYS),
        perfNow,
        uuidv4(),
        '',
        randomChoice(CORES),
        timeNow - perfNow,
        0, 0, 0, 0, 0, 0,
        0 // 0 = edge/chrome, 1 = firefox
    ];
}

export function powGenerate(seed, difficulty, config, limit = 500000) {
    const target = Buffer.from(difficulty, 'hex');
    const diffLen = Math.floor(difficulty.length / 2);
    const seedBytes = Buffer.from(seed, 'utf8');

    const static1 = Buffer.from(JSON.stringify(config.slice(0, 3)).slice(0, -1) + ',', 'utf8');
    const static2 = Buffer.from(',' + JSON.stringify(config.slice(4, 9)).slice(1, -1) + ',', 'utf8');
    const static3 = Buffer.from(',' + JSON.stringify(config.slice(10)).slice(1), 'utf8');

    for (let i = 0; i < limit; i++) {
        const finalJson = Buffer.concat([
            static1,
            Buffer.from(String(i), 'utf8'),
            static2,
            Buffer.from(String(i >> 1), 'utf8'),
            static3
        ]);
        const encoded = finalJson.toString('base64');
        const encodedBytes = Buffer.from(encoded, 'utf8');

        const digest = crypto.createHash('sha3-512')
            .update(Buffer.concat([seedBytes, encodedBytes]))
            .digest();

        if (Buffer.compare(digest.subarray(0, diffLen), target) <= 0) {
            return [encoded, true];
        }
    }

    const fallback = 'wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D' + Buffer.from(JSON.stringify(seed), 'utf8').toString('base64');
    return [fallback, false];
}

export function buildLegacyRequirementsToken(userAgent, scriptSources = null, dataBuild = '') {
    const config = buildPowConfig(userAgent, scriptSources, dataBuild);
    return 'gAAAAAC' + Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
}

export function buildProofToken(seed, difficulty, userAgent, scriptSources = null, dataBuild = '') {
    const config = buildPowConfig(userAgent, scriptSources, dataBuild);
    const [answer, solved] = powGenerate(seed, difficulty, config);
    if (!solved) {
        throw new Error(`failed to solve proof token: difficulty=${difficulty}`);
    }
    return 'gAAAAAB' + answer;
}
