/**
 * Express сервер для Agile доски.
 * WebSocket — рассылка обновлений всем клиентам при изменениях.
 * 
 * ЛОГИ: заход/выход, кол-во на сайте, SmartCap discovery, карточки, скриншоты.
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');
const iconv = require('iconv-lite');
// --- КОНФИГУРАЦИЯ ---
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

function isIpv4Interface(iface) {
    return iface && (iface.family === 'IPv4' || iface.family === 4);
}

function isLikelyVirtualIface(name) {
    const lower = String(name || '').trim().toLowerCase();
    if (!lower) return false;
    if (/^(lo|loopback)/.test(lower)) return true;
    if (/docker|vmware|virtualbox|vboxnet|npcap|zerotier|tailscale|hamachi|happ-tun/.test(lower)) return true;
    if (/\bwsl\b/.test(lower)) return true;
    if (/hyper-v/.test(lower)) return true;
    if (/vethernet/.test(lower) && /(default switch|wsl)/.test(lower)) return true;
    return false;
}

function isPrivateLanIp(addr) {
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(addr || '');
}

/** Все IPv4 этого ПК (без loopback и виртуальных адаптеров). Сначала LAN. */
function getLanIpv4List() {
    const interfaces = os.networkInterfaces();
    const seen = new Set();
    const candidates = [];
    for (const name of Object.keys(interfaces)) {
        if (isLikelyVirtualIface(name)) continue;
        for (const iface of interfaces[name] || []) {
            if (isIpv4Interface(iface) && !iface.internal && iface.address && !seen.has(iface.address)) {
                seen.add(iface.address);
                candidates.push(iface.address);
            }
        }
    }
    const privateIps = candidates.filter(isPrivateLanIp);
    const others = candidates.filter(addr => !isPrivateLanIp(addr));
    return privateIps.concat(others);
}

/** Предпочитает реальный LAN IPv4 (не loopback, не виртуальные адаптеры). */
function getLocalIP() {
    return getLanIpv4List()[0] || '127.0.0.1';
}

let LOCAL_IP = getLocalIP();
let BASE_URL = `http://${LOCAL_IP}:${PORT}`;

function refreshPublicBaseUrl() {
    LOCAL_IP = getLocalIP();
    const fromEnv = (process.env.SMARTBOARD_PUBLIC_URL || '').trim();
    BASE_URL = fromEnv || `http://${LOCAL_IP}:${PORT}`;
    return { localIp: LOCAL_IP, baseUrl: BASE_URL, lanIps: getLanIpv4List(), fromEnv };
} 

// Локально: данные в data/. В Docker задаём SMARTBOARD_DATA_DIR=/app/data.
const DATA_BASE = process.env.SMARTBOARD_DATA_DIR || path.join(__dirname, 'data');
const DATA_ROOT = path.join(DATA_BASE, 'SmartBoardData');
const BOARDS_ROOT = path.join(DATA_ROOT, 'boards');
const BOARDS_FILE = path.join(DATA_ROOT, 'boards.json');
const MIGRATION_BOARD_ID = 'migrated';
const MIGRATION_BOARD_NAME = 'Перенесенная доска';
const USERS_CSV_PATH = path.join(DATA_BASE, 'User.csv');

// --- ЛОГИРОВАНИЕ (краткое: заход/выход, карточки, скриншоты, SmartCap) ---
function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function parseCSV(content) {
    const lines = (content || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return [];
    const rows = [];
    for (const line of lines) {
        const fields = [];
        let cur = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (c === '"') { inQuotes = !inQuotes; continue; }
            if (!inQuotes && c === ',') { fields.push(cur.trim()); cur = ''; continue; }
            cur += c;
        }
        fields.push(cur.trim());
        rows.push(fields);
    }
    return rows;
}
function writeCSV(rows) {
    const escape = (v) => {
        const s = String(v == null ? '' : v);
        if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
        return s;
    };
    return rows.map(row => row.map(escape).join(',')).join('\n');
}

/** Кэш User.csv: TTL + сброс при изменении mtime файла (правка в Excel сразу видна в /api/me). */
let usersCsvCache = { rows: null, ts: 0, mtime: null };
const USERS_CSV_TTL_MS = 5000;
// Кэш IP→имя: getAuthorByClientIp зовётся часто (в т.ч. на каждую картинку приватной доски).
const _ipNameCache = new Map();
function invalidateUsersCache() { usersCsvCache = { rows: null, ts: 0, mtime: null }; _ipNameCache.clear(); }

const UTF8_BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

function isValidUtf8Buffer(buf) {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buf);
        return true;
    } catch (e) {
        return false;
    }
}

/** Имя из CSV с U+FFFD или «пїЅ» (UTF-8 replacement, прочитанный как win1251) — считаем битым. */
function isCorruptedUserName(name) {
    const n = String(name || '').trim();
    if (!n) return false;
    if (n.includes('\uFFFD')) return true;
    if (/пїЅ/i.test(n)) return true;
    return false;
}

function sanitizeUserName(name) {
    const n = String(name || '').trim();
    if (!n || isCorruptedUserName(n)) return '';
    return n;
}

function validateNickname(name) {
    const n = String(name || '').trim();
    if (n.length < 2) return 'Никнейм должен быть не короче 2 символов';
    if (n.length > 32) return 'Никнейм не длиннее 32 символов';
    if (!/^[\p{L}\p{N}_.\- ]+$/u.test(n)) return 'Никнейм: буквы, цифры, пробел, _ . -';
    return null;
}

function normalizeNicknameKey(name) {
    return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Декодируем буфер User.csv: UTF-8 (BOM или валидный UTF-8) или legacy Windows-1251. */
function decodeUsersCsvBuffer(buf) {
    if (buf.length >= 3 && buf[0] === UTF8_BOM[0] && buf[1] === UTF8_BOM[1] && buf[2] === UTF8_BOM[2]) {
        return buf.slice(3).toString('utf-8');
    }
    if (isValidUtf8Buffer(buf)) {
        return buf.toString('utf-8');
    }
    return iconv.decode(buf, 'win1251');
}

/** Читаем User.csv: UTF-8 (с BOM или без) или Windows-1251 (старые файлы). */
function readUsersCSV() {
    const now = Date.now();
    let mtimeKey = 0;
    try {
        if (fs.existsSync(USERS_CSV_PATH)) mtimeKey = fs.statSync(USERS_CSV_PATH).mtimeMs;
    } catch (e) {
        mtimeKey = NaN;
    }
    if (usersCsvCache.rows != null
        && usersCsvCache.mtime === mtimeKey
        && !Number.isNaN(mtimeKey)
        && (now - usersCsvCache.ts) < USERS_CSV_TTL_MS) {
        return usersCsvCache.rows;
    }
    try {
        if (!fs.existsSync(USERS_CSV_PATH)) {
            usersCsvCache = { rows: [], ts: now, mtime: 0 };
            return [];
        }
        const buf = fs.readFileSync(USERS_CSV_PATH);
        const content = decodeUsersCsvBuffer(buf);
        const rows = parseCSV(content);
        usersCsvCache = { rows, ts: now, mtime: mtimeKey };
        return rows;
    } catch (e) { return []; }
}

/** Пишем User.csv в UTF-8 с BOM (Excel и браузер без потери кириллицы). */
function writeUsersCSV(rows) {
    const headerRow = rows[0] || [];
    let ipCol = 0, nameCol = 1;
    const h = (i) => String(headerRow[i] != null ? headerRow[i] : '').trim();
    for (let i = 0; i < headerRow.length; i++) {
        if (/^ip$/i.test(h(i))) ipCol = i;
        if (/^name$|^имя$|^фио$|^ник$|^никнейм$/i.test(h(i))) nameCol = i;
    }
    const normalized = [['IP', 'Name']];
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i] || [];
        const ip = String(r[ipCol] != null ? r[ipCol] : '').trim();
        const name = sanitizeUserName(r[nameCol] != null ? r[nameCol] : '');
        normalized.push([ip, name]);
    }
    const csv = writeCSV(normalized);
    // ВАЖНО: пишем на месте, без temp+rename. В Docker User.csv смонтирован как отдельный
    // файл (bind-mount), и rename поверх точки монтирования падает с EBUSY.
    fs.writeFileSync(USERS_CSV_PATH, Buffer.concat([UTF8_BOM, Buffer.from(csv, 'utf-8')]));
    invalidateUsersCache();
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

/** Транслитерация кириллицы в латиницу (читаемые имена папок: «Дом» → Dom, «Большой завод» → Bolshoi_zavod). */
const CYR_TO_LAT = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
    х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
    і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u'
};
const RESERVED_STORAGE_IDS = new Set(['migrated', 'boards', 'board']);

function transliterateMixedToLatinAscii(input) {
    let out = '';
    for (const ch of String(input || '')) {
        const lo = ch.toLowerCase();
        if (CYR_TO_LAT[lo] !== undefined) {
            out += CYR_TO_LAT[lo];
            continue;
        }
        if (/[a-z0-9]/i.test(ch)) {
            out += ch.toLowerCase();
            continue;
        }
        if (/\s/.test(ch) || ch === '-' || ch === '_') {
            out += ' ';
        }
    }
    return out.trim();
}

/**
 * Человекочитаемый id папки: латиница, цифры, подчёркивание; пробелы → _;
 * стиль как в примере: первая буква заглавная, остальное как после транслита (Bolshoi_zavod).
 */
function slugifyStorageIdFromLabel(label, fallbackPrefix) {
    let s = transliterateMixedToLatinAscii(label);
    s = s.replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    s = s.replace(/[^a-z0-9_]/gi, '');
    s = s.replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (!s) s = `${fallbackPrefix}_${Date.now()}`;
    if (s.length > 56) s = s.slice(0, 56).replace(/_+$/g, '');
    if (!s) s = `${fallbackPrefix}_${Date.now()}`;
    s = s.charAt(0).toUpperCase() + s.slice(1);
    return s;
}

function isSafeBoardId(boardId) {
    return !!boardId && /^[a-zA-Z0-9_-]+$/.test(String(boardId).trim());
}
function getBoardRoot(boardId) {
    return path.join(BOARDS_ROOT, boardId);
}
function getBoardOrderFile(boardId) {
    return path.join(getBoardRoot(boardId), 'order.json');
}
function invalidateBoardsCache() { boardsMetaCache = null; }
function readBoardsMeta() {
    if (boardsMetaCache) return boardsMetaCache;
    try {
        if (fs.existsSync(BOARDS_FILE)) {
            const raw = fs.readFileSync(BOARDS_FILE, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                boardsMetaCache = parsed
                    .map(b => normalizeBoardRecord(b))
                    .filter(Boolean);
                return boardsMetaCache;
            }
        }
    } catch (e) {}
    boardsMetaCache = [];
    return boardsMetaCache;
}
function writeBoardsMeta(boards) {
    boardsMetaCache = boards;
    const tmp = BOARDS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(boards, null, 2));
    fs.renameSync(tmp, BOARDS_FILE);
}
function normalizeBoardRecord(b) {
    if (!b || !isSafeBoardId(b.id)) return null;
    const visibility = b.visibility === 'private' ? 'private' : 'public';
    const owner = String(b.owner || '').trim();
    let members = Array.isArray(b.members) ? b.members.map(m => String(m || '').trim()).filter(Boolean) : [];
    if (visibility === 'private') {
        const set = new Set(members);
        if (owner) set.add(owner);
        members = Array.from(set);
    } else {
        members = [];
    }
    const out = {
        id: String(b.id).trim(),
        name: String(b.name || b.id).trim() || String(b.id).trim(),
        createdAt: b.createdAt || new Date().toISOString(),
        visibility
    };
    if (owner) out.owner = owner;
    if (visibility === 'private') {
        out.members = members;
    }
    return out;
}
function isBoardOwner(board, userName) {
    if (!board) return false;
    const owner = String(board.owner || '').trim();
    if (!owner) return false;
    const name = String(userName || '').trim();
    return !!name && owner === name;
}
function getBoardMeta(boardId) {
    return readBoardsMeta().find(b => b.id === boardId) || null;
}
function canAccessBoard(board, userName) {
    if (!board) return false;
    if (board.visibility !== 'private') return true;
    const name = String(userName || '').trim();
    if (!name) return false;
    if (board.owner && board.owner === name) return true;
    const members = Array.isArray(board.members) ? board.members : [];
    return members.some(m => String(m).trim() === name);
}
function filterBoardsForUser(boards, userName) {
    return boards.filter(b => canAccessBoard(b, userName));
}
function getDefaultBoardIdForUser(userName) {
    const boards = filterBoardsForUser(readBoardsMeta(), userName);
    return boards[0]?.id || '';
}
function getDefaultBoardId() {
    return getDefaultBoardIdForUser('');
}
function boardExists(boardId) {
    return readBoardsMeta().some(b => b.id === boardId);
}
function assertBoardAccess(req, res, boardId) {
    if (!boardId || !isSafeBoardId(boardId)) {
        res.status(400).json({ error: 'Invalid board id' });
        return false;
    }
    const board = getBoardMeta(boardId);
    if (!board) {
        res.status(404).json({ error: 'Board not found' });
        return false;
    }
    const userName = getAuthorByClientIp(req) || '';
    if (!canAccessBoard(board, userName)) {
        res.status(403).json({ error: 'Нет доступа к этой доске' });
        return false;
    }
    return true;
}
/** Сравнение названий досок: без учёта регистра, схлопывание пробелов. */
function normalizeBoardDisplayNameKey(name) {
    return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}
/** Другая доска с тем же отображаемым названием (excludeBoardId — текущая при переименовании). */
function findOtherBoardWithSameDisplayName(name, excludeBoardId) {
    const key = normalizeBoardDisplayNameKey(name);
    if (!key) return null;
    const ex = excludeBoardId != null ? String(excludeBoardId).trim() : '';
    return readBoardsMeta().find(b => b.id !== ex && normalizeBoardDisplayNameKey(b.name) === key) || null;
}
function generateBoardIdFromName(displayName) {
    const boards = readBoardsMeta();
    let base = slugifyStorageIdFromLabel(displayName, 'board');
    if (!isSafeBoardId(base) || RESERVED_STORAGE_IDS.has(base.toLowerCase())) {
        base = `Board_${Date.now()}`;
    }
    let candidate = base;
    let n = 2;
    while (boards.some(b => b.id === candidate) || fs.existsSync(getBoardRoot(candidate))) {
        candidate = `${base}_${n++}`;
    }
    return candidate;
}

function generateColumnFolderFromName(displayName, boardId) {
    const order = getColumnOrder(boardId);
    const used = new Set(order.map(col => {
        const f = typeof col === 'object' && col && col.folder != null ? String(col.folder) : String(col);
        return f.trim();
    }));
    let base = slugifyStorageIdFromLabel(displayName, 'column');
    if (!isSafeBoardId(base) || RESERVED_STORAGE_IDS.has(base.toLowerCase())) {
        base = `Column_${Date.now()}`;
    }
    let candidate = base;
    let n = 2;
    const root = getBoardRoot(boardId);
    while (used.has(candidate) || fs.existsSync(path.join(root, candidate))) {
        candidate = `${base}_${n++}`;
    }
    return candidate;
}
function ensureBoardStructure(boardId) {
    ensureDir(getBoardRoot(boardId));
}
function migrateLegacyStorage() {
    ensureDir(DATA_ROOT);
    ensureDir(BOARDS_ROOT);
    const legacyOrderFile = path.join(DATA_ROOT, 'order.json');
    const legacyEntries = fs.readdirSync(DATA_ROOT, { withFileTypes: true }).filter(entry =>
        entry.name !== 'boards' &&
        entry.name !== 'boards.json'
    );
    const hasLegacyData = fs.existsSync(legacyOrderFile) || legacyEntries.some(entry => entry.isDirectory());
    if (!fs.existsSync(BOARDS_FILE) && hasLegacyData) {
        const defaultRoot = getBoardRoot(MIGRATION_BOARD_ID);
        ensureDir(defaultRoot);
        for (const entry of legacyEntries) {
            const fromPath = path.join(DATA_ROOT, entry.name);
            const toPath = path.join(defaultRoot, entry.name);
            if (entry.name === 'boards' || entry.name === 'boards.json') continue;
            if (entry.isDirectory() || entry.name === 'order.json') {
                try {
                    if (!fs.existsSync(toPath)) fs.renameSync(fromPath, toPath);
                } catch (e) {
                    console.warn(`[INIT] Failed to migrate ${entry.name}: ${e.message}`);
                }
            }
        }
        writeBoardsMeta([{ id: MIGRATION_BOARD_ID, name: MIGRATION_BOARD_NAME, createdAt: new Date().toISOString() }]);
    }
    let boards = readBoardsMeta();
    boards.forEach(board => ensureBoardStructure(board.id));
}

let boardsMetaCache = null;
let boardCache = new Map();
let columnOrderCache = new Map();
const BOARD_CACHE_TTL_MS = 2500;

/** При старте: UTF-8 BOM, миграция win1251, очистка битых имён (U+FFFD / «пїЅ»). */
function repairUsersCsvOnStartup() {
    if (!fs.existsSync(USERS_CSV_PATH)) return;
    const buf = fs.readFileSync(USERS_CSV_PATH);
    const hasBom = buf.length >= 3 && buf[0] === UTF8_BOM[0] && buf[1] === UTF8_BOM[1] && buf[2] === UTF8_BOM[2];
    const rows = readUsersCSV();
    if (rows.length === 0) return;
    const headerRow = rows[0] || [];
    let nameCol = 1;
    const h = (i) => String(headerRow[i] != null ? headerRow[i] : '').trim();
    for (let i = 0; i < headerRow.length; i++) {
        if (/^name$|^имя$|^фио$|^ник$|^никнейм$/i.test(h(i))) { nameCol = i; break; }
    }
    let hasCorrupted = false;
    for (let i = 1; i < rows.length; i++) {
        const raw = String(rows[i][nameCol] != null ? rows[i][nameCol] : '').trim();
        if (isCorruptedUserName(raw)) hasCorrupted = true;
    }
    const isLegacyWin1251 = !hasBom && !isValidUtf8Buffer(buf);
    if (hasCorrupted || !hasBom || isLegacyWin1251) {
        writeUsersCSV(rows);
        if (hasCorrupted) log('[INIT] User.csv: очищены повреждённые имена — нужна повторная регистрация');
        else log('[INIT] User.csv: пересохранён в UTF-8 (BOM)');
    }
}

migrateLegacyStorage();
console.log(`[INIT] Data directory exists: ${DATA_ROOT}`);

// Проверка User.csv при старте
if (fs.existsSync(USERS_CSV_PATH)) {
    repairUsersCsvOnStartup();
    const rows = readUsersCSV();
    console.log(`[INIT] User.csv loaded: ${Math.max(0, rows.length - 1)} users`);
} else {
    console.log(`[INIT] User.csv not found: ${USERS_CSV_PATH}`);
}

// --- EXPRESS APP ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/ico', express.static(path.join(__dirname, 'ico')));

// Авторизация доступа к файлам досок: приватная доска видна только владельцу/участникам.
app.use('/images', (req, res, next) => {
    let rel = '';
    try {
        rel = decodeURIComponent(req.path || '');
    } catch (e) {
        return res.status(400).end();
    }
    rel = rel.replace(/\\/g, '/').replace(/^\/+/, '');

    // Индекс с метаданными всех досок наружу не отдаём.
    if (rel.toLowerCase() === 'boards.json') {
        return res.status(404).end();
    }

    const m = rel.match(/^boards\/([^/]+)\//);
    if (m) {
        const board = getBoardMeta(m[1]);
        if (board && board.visibility === 'private') {
            const userName = getAuthorByClientIp(req) || '';
            if (!canAccessBoard(board, userName)) {
                return res.status(403).end();
            }
        }
    }
    next();
});
app.use('/images', express.static(DATA_ROOT));

// --- HTTP + WebSocket ---
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

function getOnlinePeopleCount() {
    const onlineKeys = new Set();
    wss.clients.forEach(client => {
        if ((client.readyState === 0 || client.readyState === 1) && client.onlineKey) {
            onlineKeys.add(client.onlineKey);
        }
    });
    return onlineKeys.size;
}

function getOnlineConnectionsCount(onlineKey) {
    let count = 0;
    wss.clients.forEach(client => {
        if ((client.readyState === 0 || client.readyState === 1) && client.onlineKey === onlineKey) {
            count++;
        }
    });
    return count;
}

wss.on('connection', (ws, req) => {
    const clientIp = normalizeIp(getClientIp(req));
    const author = getAuthorByClientIp(req) || clientIp || '?';
    ws.onlineKey = clientIp ? `ip:${clientIp}` : `name:${author.toLowerCase()}`;
    const n = getOnlinePeopleCount();
    if (getOnlineConnectionsCount(ws.onlineKey) === 1) {
        log(`Зашёл: ${author} | на сайте ${n} чел.`);
    }

    ws.isAlive = true;
    ws.on('message', (data) => {
        try { const d = JSON.parse(data); if (d.type === 'pong') ws.isAlive = true; } catch (e) {}
    });

    ws.on('close', () => {
        if (getOnlineConnectionsCount(ws.onlineKey) === 0) {
            const m = getOnlinePeopleCount();
            log(`Вышел: ${author} | на сайте ${m} чел.`);
        }
    });
    
    ws.on('error', () => {});
});

// Ping каждые 30 сек — выявляет мёртвые соединения
const wsHeartbeatInterval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) { ws.terminate(); return; }
        ws.isAlive = false;
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
    });
}, 30000);

function invalidateBoardCache(boardId) {
    if (boardId) boardCache.delete(boardId);
    else boardCache.clear();
}
function sendRefreshNow(boardId, extra) {
    const msg = JSON.stringify({ type: 'refresh', boardId: boardId || null, ...extra });
    wss.clients.forEach(client => { if (client.readyState === 1) client.send(msg); });
}
// Коалесинг частых refresh (например, при загрузке нескольких фото подряд):
// кэш сбрасываем сразу, а саму рассылку дебаунсим на 200мс. Срочные структурные
// изменения (удаление доски / изменение списка досок) шлём немедленно.
const _refreshTimers = new Map();
const _refreshPending = new Map();
const REFRESH_DEBOUNCE_MS = 200;
function broadcastRefresh(boardId, extra = {}) {
    invalidateBoardCache(boardId);
    const key = boardId || '__global__';
    if (extra && (extra.boardDeleted || extra.boardsListChanged)) {
        if (_refreshTimers.has(key)) { clearTimeout(_refreshTimers.get(key)); _refreshTimers.delete(key); }
        _refreshPending.delete(key);
        sendRefreshNow(boardId, extra);
        return;
    }
    const merged = Object.assign(_refreshPending.get(key) || {}, extra);
    _refreshPending.set(key, merged);
    if (_refreshTimers.has(key)) return;
    _refreshTimers.set(key, setTimeout(() => {
        const e = _refreshPending.get(key) || {};
        _refreshTimers.delete(key);
        _refreshPending.delete(key);
        sendRefreshNow(boardId, e);
    }, REFRESH_DEBOUNCE_MS));
}

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
function getRequestedBoardId(req) {
    const relPath = String(req.body?.relPath || req.query?.relPath || '').trim();
    const raw = (req.query?.boardId || req.body?.boardId || req.headers['x-board-id'] || '').trim();
    const userName = getAuthorByClientIp(req) || '';
    let boardId = raw || getBoardIdFromRelPath(relPath);
    if (boardId && isSafeBoardId(boardId) && boardExists(boardId)) {
        if (canAccessBoard(getBoardMeta(boardId), userName)) return boardId;
        return '';
    }
    return getDefaultBoardIdForUser(userName);
}
function requireRequestedBoardId(req, res) {
    const relPath = String(req.body?.relPath || req.query?.relPath || '').trim();
    const raw = (req.query?.boardId || req.body?.boardId || req.headers['x-board-id'] || '').trim();
    const userName = getAuthorByClientIp(req) || '';
    let boardId = raw || getBoardIdFromRelPath(relPath);
    if (boardId && isSafeBoardId(boardId) && boardExists(boardId)) {
        if (!canAccessBoard(getBoardMeta(boardId), userName)) {
            res.status(403).json({ error: 'Нет доступа к этой доске' });
            return '';
        }
        return boardId;
    }
    boardId = getDefaultBoardIdForUser(userName);
    if (!boardId) {
        res.status(400).json({ error: 'Board is not selected' });
        return '';
    }
    return boardId;
}
function getBoardIdFromRelPath(relPath) {
    const m = String(relPath || '').replace(/\\/g, '/').match(/^boards\/([^/]+)\//);
    return m ? m[1] : '';
}
function getColumnOrder(boardId) {
    if (columnOrderCache.has(boardId)) return columnOrderCache.get(boardId);
    const orderFile = getBoardOrderFile(boardId);
    try { 
        if (fs.existsSync(orderFile)) {
            let raw = fs.readFileSync(orderFile, 'utf-8');
            if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
                const normalized = parsed.map(name => ({ folder: name, name }));
                columnOrderCache.set(boardId, normalized);
                return normalized;
            }
            columnOrderCache.set(boardId, parsed);
            return parsed;
        }
    } catch (e) {}
    columnOrderCache.set(boardId, []);
    return [];
}
function saveColumnOrder(boardId, order) {
    columnOrderCache.set(boardId, order);
    try { fs.writeFileSync(getBoardOrderFile(boardId), JSON.stringify(order, null, 2)); } catch (e) {}
}
function getResolvedPathForBoard(req, relPath) {
    const cleanRelPath = String(relPath || '').trim().replace(/\\/g, '/');
    if (!cleanRelPath) return '';
    const relBoardId = getBoardIdFromRelPath(cleanRelPath);
    if (relBoardId) return path.resolve(DATA_ROOT, cleanRelPath);
    return path.resolve(getBoardRoot(getRequestedBoardId(req)), cleanRelPath);
}
async function buildBoardData(boardId) {
    const columns = [];
    const boardRoot = getBoardRoot(boardId);
    
    try {
        await fs.promises.access(boardRoot);
    } catch {
        return columns; // Папки нет, возвращаем пустоту
    }
    
    const entries = await fs.promises.readdir(boardRoot, { withFileTypes: true });
    const folderNames = entries
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .filter(n => isSafeDirName(n));

    const prevOrder = getColumnOrder(boardId).slice();
    const orderedCols = [];
    prevOrder.forEach(col => { 
        const folderToUse = (typeof col === 'object' && col.folder) ? col.folder : col;
        const m = folderNames.find(f => f === folderToUse); 
        if (m) orderedCols.push(typeof col === 'object' ? col : {folder: m, name: m}); 
    });
    folderNames.forEach(fn => { 
        if (!orderedCols.some(c => c.folder === fn)) orderedCols.push({folder: fn, name: fn}); 
    });
    
    const toSave = orderedCols.slice();
    const prevFolders = prevOrder.map(c => (typeof c === 'object' ? c.folder : c));
    const nowFolders = toSave.map(c => c.folder);
    if (nowFolders.length !== prevFolders.length || nowFolders.some((f, i) => f !== prevFolders[i])) {
        saveColumnOrder(boardId, toSave);
    }

    // Читаем все колонки параллельно
    const columnsData = await Promise.all(orderedCols.map(async (col) => {
        const folderName = col.folder;
        const displayName = col.name;
        if (!folderName || !String(folderName).trim()) return null;

        try {
            const colPath = path.join(boardRoot, folderName);
            let colEntries;
            try {
                colEntries = await fs.promises.readdir(colPath, { withFileTypes: true });
            } catch {
                return null;
            }

            const taskDirs = colEntries.filter(t => t.isDirectory());

            // Читаем все карточки внутри колонки ПАРАЛЛЕЛЬНО
            const tasks = await Promise.all(taskDirs.map(async (t) => {
                const taskPath = path.join(colPath, t.name);

                // Запускаем чтение всех файлов карточки одновременно
                const [descRes, dateRes, metaRes, filesRes] = await Promise.allSettled([
                    fs.promises.readFile(path.join(taskPath, 'desc.txt'), 'utf-8'),
                    fs.promises.readFile(path.join(taskPath, 'date.txt'), 'utf-8'),
                    fs.promises.readFile(path.join(taskPath, 'meta.json'), 'utf-8'),
                    fs.promises.readdir(taskPath)
                ]);

                const desc = descRes.status === 'fulfilled' ? descRes.value : '';
                const deadline = dateRes.status === 'fulfilled' ? dateRes.value : '';
                let meta = null;
                
                if (metaRes.status === 'fulfilled') {
                    try { meta = JSON.parse(metaRes.value); } catch (e) {}
                }
                
                const images = filesRes.status === 'fulfilled' 
                    ? filesRes.value.filter(f => f.toLowerCase().endsWith('.png')) 
                    : [];

                const displayTitle = (meta && meta.title) ? meta.title : t.name;
                const author = meta;
                const participants = (meta && Array.isArray(meta.participants)) ? meta.participants : [];
                const done = !!(meta && meta.done);

                return { 
                    taskId: t.name, 
                    title: displayTitle, 
                    desc, 
                    deadline, 
                    images, 
                    author, 
                    participants, 
                    done, 
                    relPath: path.join('boards', boardId, folderName, t.name).replace(/\\/g, '/') 
                };
            }));

            return { folder: folderName, name: displayName, tasks };
        } catch (e) {
            console.warn(`[buildBoardData] Пропуск колонки "${displayName}" (${folderName}):`, e.message);
            return null;
        }
    }));

    // Фильтруем пустые (ошибочные) колонки и возвращаем результат
    return columnsData.filter(Boolean);
}

// === API ===

app.get('/api/server-info', (req, res) => res.json({ baseUrl: BASE_URL, apiUrl: BASE_URL + '/api' }));
app.get('/api/boards', (req, res) => {
    const userName = getAuthorByClientIp(req) || '';
    const boards = filterBoardsForUser(readBoardsMeta(), userName);
    res.json({ boards, defaultBoardId: boards[0]?.id || '' });
});
app.post('/api/boards', (req, res) => {
    try {
        const name = String(req.body?.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Empty board name' });
        const dup = findOtherBoardWithSameDisplayName(name, null);
        if (dup) {
            return res.status(409).json({ error: `Уже есть доска с названием «${dup.name}».` });
        }
        const isPrivate = !!req.body?.isPrivate;
        const owner = getAuthorByClientIp(req) || '';
        if (isPrivate && !owner) {
            return res.status(403).json({ error: 'Для приватной доски нужна регистрация (никнейм)' });
        }
        if (!owner) {
            return res.status(403).json({ error: 'Для создания доски нужна регистрация (никнейм)' });
        }
        const boardId = generateBoardIdFromName(name);
        const board = {
            id: boardId,
            name,
            createdAt: new Date().toISOString(),
            visibility: isPrivate ? 'private' : 'public',
            owner
        };
        if (isPrivate) {
            board.members = [owner];
        }
        const boards = readBoardsMeta().slice();
        boards.push(normalizeBoardRecord(board));
        ensureBoardStructure(boardId);
        saveColumnOrder(boardId, []);
        writeBoardsMeta(boards);
        res.json({ success: true, board: getBoardMeta(boardId) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.patch('/api/boards/:boardId', async (req, res) => {
    try {
        const boardId = String(req.params.boardId || '').trim();
        if (!isSafeBoardId(boardId)) return res.status(400).json({ error: 'Invalid board id' });
        if (!boardExists(boardId)) return res.status(404).json({ error: 'Board not found' });
        if (!assertBoardAccess(req, res, boardId)) return;
        const existing = getBoardMeta(boardId);
        const userName = getAuthorByClientIp(req) || '';
        const hasName = req.body?.name !== undefined;
        const hasMembers = req.body?.members !== undefined;
        const hasVisibility = req.body?.visibility !== undefined || req.body?.isPrivate !== undefined;
        if (!hasName && !hasMembers && !hasVisibility) {
            return res.status(400).json({ error: 'Nothing to update' });
        }

        let next = { ...existing };
        if (hasVisibility) {
            if (!isBoardOwner(existing, userName)) {
                return res.status(403).json({ error: 'Только создатель доски может менять видимость' });
            }
            let vis = existing.visibility === 'private' ? 'private' : 'public';
            if (req.body?.visibility !== undefined) {
                vis = String(req.body.visibility).trim().toLowerCase() === 'private' ? 'private' : 'public';
            } else if (req.body?.isPrivate !== undefined) {
                vis = req.body.isPrivate ? 'private' : 'public';
            }
            if (vis === 'private' && existing.visibility !== 'private') {
                const owner = existing.owner || userName;
                if (!owner) {
                    return res.status(403).json({ error: 'Для приватной доски нужна регистрация (никнейм)' });
                }
                next.visibility = 'private';
                next.owner = owner;
                if (!hasMembers) {
                    const fromCards = await collectBoardCardParticipants(boardId);
                    next.members = validateBoardMemberNames(fromCards, owner);
                }
            } else if (vis === 'public' && existing.visibility === 'private') {
                next.visibility = 'public';
                delete next.members;
            } else {
                next.visibility = vis;
            }
        }
        if (hasName) {
            if (existing.owner && !isBoardOwner(existing, userName)) {
                return res.status(403).json({ error: 'Только создатель доски может её переименовать' });
            }
            const name = String(req.body.name || '').trim();
            if (!name) return res.status(400).json({ error: 'Empty name' });
            const dup = findOtherBoardWithSameDisplayName(name, boardId);
            if (dup) {
                return res.status(409).json({ error: `Уже есть доска с таким названием: «${dup.name}».` });
            }
            next.name = name;
        }
        if (hasMembers) {
            const vis = next.visibility === 'private' ? 'private' : (existing.visibility === 'private' ? 'private' : 'public');
            if (vis !== 'private') {
                return res.status(400).json({ error: 'Участники доступны только для приватной доски' });
            }
            if (!isBoardOwner(existing, userName)) {
                return res.status(403).json({ error: 'Только создатель доски может менять участников' });
            }
            const rawMembers = Array.isArray(req.body.members) ? req.body.members : [];
            next.members = validateBoardMemberNames(rawMembers, next.owner || existing.owner);
        }

        const boards = readBoardsMeta().map(b => (b.id === boardId ? normalizeBoardRecord(next) : b));
        writeBoardsMeta(boards);
        const board = getBoardMeta(boardId);
        broadcastRefresh(boardId, { boardsListChanged: true });
        res.json({ success: true, board });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/boards/:boardId', (req, res) => {
    try {
        const boardId = String(req.params.boardId || '').trim();
        if (!isSafeBoardId(boardId)) return res.status(400).json({ error: 'Invalid board id' });
        if (!boardExists(boardId)) return res.status(404).json({ error: 'Board not found' });
        if (!assertBoardAccess(req, res, boardId)) return;
        const board = getBoardMeta(boardId);
        const userName = getAuthorByClientIp(req) || '';
        if (board.owner && !isBoardOwner(board, userName)) {
            return res.status(403).json({ error: 'Только создатель доски может её удалить' });
        }
        try {
            fs.rmSync(getBoardRoot(boardId), { recursive: true, force: true });
        } catch (e) {
            log(`Удаление папки доски ${boardId}: ${e.message}`);
        }
        const boards = readBoardsMeta().filter(b => b.id !== boardId);
        writeBoardsMeta(boards);
        columnOrderCache.delete(boardId);
        boardCache.delete(boardId);
        broadcastRefresh(boardId, { boardDeleted: true });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/** Список никнеймов из User.csv (колонка B — Name) для выбора участников. */
function getUserNamesFromCsv() {
    const rows = readUsersCSV();
    if (rows.length < 2) return [];
    const headerRow = rows[0] || [];
    let nameCol = 1;
    const h = (i) => String(headerRow[i] != null ? headerRow[i] : '').trim();
    for (let i = 0; i < headerRow.length; i++) {
        if (/^name$|^имя$|^фио$|^ник$|^никнейм$/i.test(h(i))) { nameCol = i; break; }
    }
    const names = [];
    const seen = new Set();
    for (let i = 1; i < rows.length; i++) {
        const n = sanitizeUserName(rows[i][nameCol] != null ? rows[i][nameCol] : '');
        if (n && !seen.has(n)) { seen.add(n); names.push(n); }
    }
    return names;
}

function validateBoardMemberNames(members, owner) {
    const known = new Set(getUserNamesFromCsv());
    const set = new Set();
    const own = String(owner || '').trim();
    if (own && known.has(own)) set.add(own);
    for (const m of members || []) {
        const n = String(m || '').trim();
        if (n && known.has(n)) set.add(n);
    }
    return Array.from(set);
}

function getUserNamesForBoardPicker(boardId) {
    if (!boardId || !isSafeBoardId(boardId)) return getUserNamesFromCsv();
    const board = getBoardMeta(boardId);
    if (!board || board.visibility !== 'private') return getUserNamesFromCsv();
    const known = new Set(getUserNamesFromCsv());
    const members = Array.isArray(board.members) ? board.members : [];
    return members
        .map(m => String(m || '').trim())
        .filter(n => n && known.has(n))
        .sort((a, b) => a.localeCompare(b, 'ru'));
}

function filterParticipantsForBoard(participants, boardId) {
    const list = Array.isArray(participants) ? participants : [];
    const board = getBoardMeta(boardId);
    if (!board || board.visibility !== 'private') {
        return list.map(p => String(p || '').trim()).filter(Boolean);
    }
    const allowed = new Set(getUserNamesForBoardPicker(boardId));
    const out = [];
    for (const p of list) {
        const n = String(p || '').trim();
        if (n && allowed.has(n) && !out.includes(n)) out.push(n);
    }
    return out;
}

/** Все никнеймы с карточек доски (авторы и участники) — для первоначального списка приватной доски. */
async function collectBoardCardParticipants(boardId) {
    const names = new Set();
    const boardRoot = getBoardRoot(boardId);
    try {
        await fs.promises.access(boardRoot);
    } catch {
        return [];
    }
    const colEntries = await fs.promises.readdir(boardRoot, { withFileTypes: true });
    for (const col of colEntries) {
        if (!col.isDirectory() || !isSafeDirName(col.name)) continue;
        const colPath = path.join(boardRoot, col.name);
        let taskEntries;
        try {
            taskEntries = await fs.promises.readdir(colPath, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const task of taskEntries) {
            if (!task.isDirectory()) continue;
            try {
                const raw = await fs.promises.readFile(path.join(colPath, task.name, 'meta.json'), 'utf-8');
                const meta = JSON.parse(raw);
                let author = '';
                if (typeof meta.author === 'string') author = meta.author;
                else if (meta.author && typeof meta.author === 'object' && meta.author.author) {
                    author = String(meta.author.author);
                }
                if (author && author.trim()) names.add(author.trim());
                if (Array.isArray(meta.participants)) {
                    meta.participants.forEach(p => {
                        const n = String(p || '').trim();
                        if (n) names.add(n);
                    });
                }
            } catch (e) {}
        }
    }
    return Array.from(names);
}

app.get('/api/user-list', (req, res) => {
    const boardId = String(req.query.boardId || req.query.board || '').trim();
    if (boardId) {
        if (!isSafeBoardId(boardId)) return res.status(400).json({ error: 'Invalid board id' });
        if (!assertBoardAccess(req, res, boardId)) return;
        return res.json({ names: getUserNamesForBoardPicker(boardId) });
    }
    res.json({ names: getUserNamesFromCsv() });
});

/** Достаёт IP клиента: сначала из заголовков прокси (Docker/nginx), иначе remoteAddress. */
function getClientIp(req) {
    const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const realIp = (req.headers['x-real-ip'] || '').trim();
    const raw = forwarded || realIp || req.connection?.remoteAddress || req.socket?.remoteAddress || '';
    let ip = raw;
    if (ip && ip.startsWith('::ffff:')) ip = ip.slice(7);
    return ip || '';
}

/** Нормализует IP для сравнения (убирает ::ffff: и т.п.). */
function normalizeIp(ip) {
    if (!ip || typeof ip !== 'string') return '';
    const s = ip.trim();
    return s.startsWith('::ffff:') ? s.slice(7) : s;
}

/** Никнейм по IP клиента. User.csv: колонка A=IP, колонка B=Name. */
function getAuthorByClientIp(req) {
    const ip = normalizeIp(getClientIp(req));
    if (!ip || ip === '::1' || ip === '127.0.0.1') return '';
    const rows = readUsersCSV();
    // Кэш привязан к версии (ts) кэша CSV: при перечитывании файла записи устаревают сами.
    const cacheVer = usersCsvCache.ts;
    const cached = _ipNameCache.get(ip);
    if (cached && cached.ver === cacheVer) return cached.name;

    let name = '';
    if (rows.length >= 2) {
        const headerRow = rows[0] || [];
        let ipCol = 0, nameCol = 1;
        const h = (i) => String(headerRow[i] != null ? headerRow[i] : '').trim();
        for (let i = 0; i < headerRow.length; i++) {
            if (/^ip$/i.test(h(i))) ipCol = i;
            if (/^name$|^имя$|^фио$|^ник$|^никнейм$/i.test(h(i))) nameCol = i;
        }
        if (ipCol >= 0 && nameCol >= 0) {
            const ipNorm = ip.trim();
            const row = rows.slice(1).find(r => normalizeIp(String(r[ipCol] != null ? r[ipCol] : '')) === ipNorm);
            name = row ? sanitizeUserName(row[nameCol] != null ? row[nameCol] : '') : '';
        }
    }
    _ipNameCache.set(ip, { name, ver: cacheVer });
    return name;
}

app.get('/api/me', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({ name: getAuthorByClientIp(req) || '' });
});

app.get('/api/debug-ip', (req, res) => {
    const rows = readUsersCSV();
    res.json({
        clientIp: getClientIp(req),
        normalized: normalizeIp(getClientIp(req)),
        'x-forwarded-for': req.headers['x-forwarded-for'] || null,
        'x-real-ip': req.headers['x-real-ip'] || null,
        remoteAddress: req.socket?.remoteAddress || null,
        usersCsvPath: USERS_CSV_PATH,
        usersCsvDataRows: Math.max(0, rows.length - 1)
    });
});

/** Регистрация пользователя по IP: добавить или обновить строку в User.csv */
app.post('/api/register-user', (req, res) => {
    try {
        const clientIp = getClientIp(req);
        const name = (req.body.name && String(req.body.name).trim()) ? String(req.body.name).trim() : '';
        const nickErr = validateNickname(name);
        if (nickErr) return res.status(400).json({ error: nickErr });
        const ip = normalizeIp(clientIp);
        if (!ip || ip === '::1' || ip === '127.0.0.1') return res.status(400).json({ error: 'Откройте сайт по IP компьютера из консоли запуска, не через localhost' });

        let rows = readUsersCSV();
        if (rows.length === 0) {
            rows = [['IP', 'Name']];
        }
        const headerRow = rows[0] || [];
        let ipCol = 0, nameCol = 1;
        const h = (i) => String(headerRow[i] != null ? headerRow[i] : '').trim();
        for (let i = 0; i < headerRow.length; i++) {
            if (/^ip$/i.test(h(i))) ipCol = i;
            if (/^name$|^имя$|^фио$|^ник$|^никнейм$/i.test(h(i))) nameCol = i;
        }
        if (ipCol < 0 || nameCol < 0) {
            rows = [['IP', 'Name']];
            ipCol = 0;
            nameCol = 1;
        }

        const nickKey = normalizeNicknameKey(name);
        const takenByOther = rows.slice(1).some((r) => {
            const rowIp = normalizeIp(String(r[ipCol] != null ? r[ipCol] : ''));
            const rowName = sanitizeUserName(r[nameCol] != null ? r[nameCol] : '');
            return rowIp !== ip && normalizeNicknameKey(rowName) === nickKey;
        });
        if (takenByOther) return res.status(409).json({ error: 'Этот никнейм уже занят' });
        
        const existing = rows.slice(1).findIndex(r => normalizeIp(String(r[ipCol] != null ? r[ipCol] : '')) === ip);
        if (existing >= 0) {
            const row = rows[existing + 1];
            while (row.length <= nameCol) row.push('');
            row[nameCol] = name;
        } else {
            const newRow = [];
            for (let i = 0; i < headerRow.length; i++) newRow[i] = '';
            newRow[ipCol] = ip;
            newRow[nameCol] = name;
            rows.push(newRow);
        }
        writeUsersCSV(rows);
        log(`Зарегистрировался: ${name} (${ip})`);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message || 'Ошибка записи' }); }
});

/** Никнейм по имени ПК из User.csv (колонки A=IP, B=Name; для поиска по PC нужна колонка PC) */
app.get('/api/user-by-pc', (req, res) => {
    try {
        const pc = (req.query.pc || '').trim();
        if (!pc) return res.json({ author: '' });
        const rows = readUsersCSV();
        if (rows.length < 2) return res.json({ author: '' });
        
        const headerRow = rows[0] || [];
        let pcCol = -1, nameCol = 1;
        const h = (i) => String(headerRow[i] != null ? headerRow[i] : '').trim();
        for (let i = 0; i < headerRow.length; i++) {
            if (/^pc$|^dns$/i.test(h(i))) pcCol = i;
            if (/^name$|^имя$|^фио$|^ник$|^никнейм$/i.test(h(i))) nameCol = i;
        }
        
        if (pcCol < 0 || nameCol < 0) return res.json({ author: '' });
        
        const pcNorm = pc.split('.')[0].trim().toUpperCase();
        const row = rows.slice(1).find(r => {
            const cell = String(r[pcCol] != null ? r[pcCol] : '').trim();
            return cell.toUpperCase() === pcNorm || cell.split('.')[0].trim().toUpperCase() === pcNorm;
        });
        const author = row ? String(row[nameCol] != null ? row[nameCol] : '').trim() : '';
        res.json({ author });
    } catch (e) { res.json({ author: '' }); }
});

app.get('/api/board', async (req, res) => {
    try {
        const boardId = requireRequestedBoardId(req, res);
        if (!boardId) return;
        const now = Date.now();
        const cached = boardCache.get(boardId);
        if (cached && (now - cached.ts) < BOARD_CACHE_TTL_MS) return res.json(cached.data);
        
        const columns = await buildBoardData(boardId); 
        
        boardCache.set(boardId, { data: columns, ts: now });
        res.json(columns);
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});
/** Проверяет, что resolved-путь находится строго внутри ROOT_PATH (защита от path traversal). */
function isInsideRoot(fullPath, rootPath = DATA_ROOT) {
    const root = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
    return fullPath === rootPath || fullPath.startsWith(root);
}

function isSafeDirName(name) {
    if (!name || typeof name !== 'string') return false;
    const s = name.trim();
    if (!s) return false;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if ((c >= 0x20 && c <= 0x7E) || (c >= 0x0400 && c <= 0x04FF)) continue;
        return false;
    }
    return true;
}
function generateSafeTaskId() {
    return 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}
app.post('/api/column', (req, res) => {
    try {
        const boardId = requireRequestedBoardId(req, res);
        if (!boardId) return;
        if (!req.body.name) return res.status(400).json({ error: 'No name' });
        const displayName = String(req.body.name).trim();
        if (!displayName) return res.status(400).json({ error: 'Empty name' });
        const folderId = generateColumnFolderFromName(displayName, boardId);
        const p = path.join(getBoardRoot(boardId), folderId);
        fs.mkdirSync(p);
        const order = getColumnOrder(boardId);
        order.push({folder: folderId, name: displayName});
        saveColumnOrder(boardId, order);
        res.json({ success: true, folder: folderId, name: displayName });
        broadcastRefresh(boardId);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/column', (req, res) => {
    try {
        const boardId = requireRequestedBoardId(req, res);
        if (!boardId) return;
        const folder = String(req.body?.folder || '').trim();
        const displayName = String(req.body?.name ?? '').trim();
        if (!folder) return res.status(400).json({ error: 'No folder' });
        if (!isSafeDirName(folder)) return res.status(400).json({ error: 'Invalid folder' });
        if (!displayName) return res.status(400).json({ error: 'Empty name' });
        if (!isSafeDirName(displayName)) return res.status(400).json({ error: 'Invalid column name' });
        const colDir = path.join(getBoardRoot(boardId), folder);
        try {
            if (!fs.existsSync(colDir) || !fs.statSync(colDir).isDirectory()) {
                return res.status(404).json({ error: 'Column not found' });
            }
        } catch (e) {
            return res.status(404).json({ error: 'Column not found' });
        }
        const order = getColumnOrder(boardId).slice();
        let found = false;
        const next = order.map(col => {
            const f = typeof col === 'object' && col && col.folder != null ? String(col.folder) : String(col);
            if (f !== folder) {
                return typeof col === 'object' && col && col.folder != null
                    ? col
                    : { folder: f, name: f };
            }
            found = true;
            return { folder, name: displayName };
        });
        if (!found) next.push({ folder, name: displayName });
        saveColumnOrder(boardId, next);
        broadcastRefresh(boardId);
        res.json({ success: true, folder, name: displayName });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ticket', async (req, res) => {
    try {
        const boardId = requireRequestedBoardId(req, res);
        if (!boardId) return;
        let { title, column, desc, image, deadline, author, email, participants } = req.body;
        const clientIp = getClientIp(req);
        
        if (!title || !column) return res.status(400).json({ error: 'No data' });
        
        if (!author || !String(author).trim()) author = getAuthorByClientIp(req);
        author = (author && String(author).trim()) ? String(author).trim() : 'User';

        const displayTitle = String(title).trim();
        const taskId = generateSafeTaskId();
        const taskPath = path.join(getBoardRoot(boardId), column, taskId);

        // Проверяем существование папки асинхронно
        try {
            await fs.promises.access(taskPath);
            return res.status(400).json({ error: 'Exists' });
        } catch {
            // Если папки нет (выдало ошибку access) — создаем асинхронно
            await fs.promises.mkdir(taskPath, { recursive: true });
            
            // Собираем все задачи на запись в один массив
            const writeTasks = [];

            if (desc) writeTasks.push(fs.promises.writeFile(path.join(taskPath, 'desc.txt'), desc));
            if (deadline) writeTasks.push(fs.promises.writeFile(path.join(taskPath, 'date.txt'), deadline));
            
            let partList = Array.isArray(participants) ? participants.filter(p => p && String(p).trim()) : [];
            if (author && !partList.includes(author)) partList = [author, ...partList];
            partList = filterParticipantsForBoard(partList, boardId);
            if (author && !partList.includes(author)) partList = [author, ...partList];
            const meta = { title: displayTitle, author, email: email || '', created: new Date().toISOString(), participants: partList };
            
            writeTasks.push(fs.promises.writeFile(path.join(taskPath, 'meta.json'), JSON.stringify(meta)));

            if (image) {
                const base64Data = image.replace(/^data:image\/png;base64,/, "");
                const filename = `img_${Date.now()}.png`;
                writeTasks.push(fs.promises.writeFile(path.join(taskPath, filename), base64Data, 'base64'));
            }

            // ВЫПОЛНЯЕМ ВСЕ ЗАПИСИ ОДНОВРЕМЕННО
            await Promise.all(writeTasks);

            log(`Карточка добавлена: "${displayTitle}" (${column}) | ${author}${image ? ' | скриншот' : ''}`);
            
            res.json({ success: true, taskId, title: displayTitle });
            broadcastRefresh(boardId);
        }
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});

app.post('/api/update-ticket', async (req, res) => {
    try {
        const { relPath, newTitle, newDesc, newDate, newDone, image } = req.body;
        
        if (!relPath) return res.status(400).json({ error: 'No relPath' });
        const taskPath = getResolvedPathForBoard(req, relPath);
        const boardId = getBoardIdFromRelPath(relPath) || requireRequestedBoardId(req, res);
        if (!boardId) return;
        if (!assertBoardAccess(req, res, boardId)) return;
        
        if (!isInsideRoot(taskPath, DATA_ROOT)) return res.status(400).json({ error: 'Invalid path' });
        
        // Асинхронно проверяем, существует ли папка карточки
        try {
            await fs.promises.access(taskPath);
        } catch {
            return res.status(404).json({ error: 'Card not found' });
        }
        
        const writeTasks = []; // Массив для всех параллельных операций записи
        
        // Обновление meta.json (заголовок и статус "выполнено")
        if (newTitle !== undefined || newDone !== undefined) {
            const metaPath = path.join(taskPath, 'meta.json');
            let meta = {};
            try { 
                const metaContent = await fs.promises.readFile(metaPath, 'utf-8');
                meta = JSON.parse(metaContent); 
            } catch (e) {}
            
            if (newTitle !== undefined) meta.title = String(newTitle).trim();
            if (newDone !== undefined) meta.done = !!newDone;
            
            writeTasks.push(fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2)));
        }
        
        // Обновление описания
        if (newDesc !== undefined) {
            writeTasks.push(fs.promises.writeFile(path.join(taskPath, 'desc.txt'), newDesc));
        }
        
        // Обновление даты
        if (newDate !== undefined) {
            writeTasks.push(fs.promises.writeFile(path.join(taskPath, 'date.txt'), newDate));
        }
        
        // Сохранение новой картинки
        let newImage = null;
        if (image) {
            const base64Data = image.replace(/^data:image\/png;base64,/, "").replace(/^data:image\/\w+;base64,/, "");
            const filename = `img_${Date.now()}.png`;
            writeTasks.push(fs.promises.writeFile(path.join(taskPath, filename), base64Data, 'base64'));
            newImage = filename;
            const author = getAuthorByClientIp(req) || '?';
            log(`Скриншот добавлен в карточку | ${author}`);
        }
        
        // Запускаем ВСЕ операции сохранения на диск ОДНОВРЕМЕННО
        await Promise.all(writeTasks);
        res.json({ success: true, newImage });
        broadcastRefresh(boardId);
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});

/** Обновить список участников карточки. Создателя карточки (author) убрать нельзя — он всегда остаётся в списке. */
app.post('/api/ticket-participants', async (req, res) => {
    try {
        const { relPath, participants: partList } = req.body;
        if (!relPath) return res.status(400).json({ error: 'No relPath' });
        const taskPath = getResolvedPathForBoard(req, relPath);
        const boardId = getBoardIdFromRelPath(relPath) || requireRequestedBoardId(req, res);
        if (!boardId) return;
        if (!assertBoardAccess(req, res, boardId)) return;
        
        try {
            await fs.promises.access(taskPath);
        } catch {
            return res.status(404).json({ error: 'Card not found' });
        }
        
        const metaPath = path.join(taskPath, 'meta.json');
        let meta = {};
        try {
            const metaContent = await fs.promises.readFile(metaPath, 'utf-8');
            meta = JSON.parse(metaContent);
        } catch (e) {}
        
        const author = (meta.author && String(meta.author).trim()) ? String(meta.author).trim() : '';
        let participants = Array.isArray(partList) ? partList.filter(p => p && String(p).trim()) : [];
        if (author && !participants.includes(author)) participants = [author, ...participants];
        participants = filterParticipantsForBoard(participants, boardId);
        if (author && !participants.includes(author)) participants = [author, ...participants];
        meta.participants = participants;
        
        // Асинхронная запись
        await fs.promises.writeFile(metaPath, JSON.stringify(meta));
        
        res.json({ success: true });
        broadcastRefresh(boardId);
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});
// --- УСИЛЕННЫЙ БЛОК УДАЛЕНИЯ ---
app.post('/api/delete', async (req, res) => {
    let targetRelativePath = "";
    try {
        const { relPath, isColumn, columnName } = req.body;
        const boardId = getBoardIdFromRelPath(relPath || '') || requireRequestedBoardId(req, res);
        if (!boardId) return;
        if (!assertBoardAccess(req, res, boardId)) return;
        
        if (isColumn && columnName) {
            targetRelativePath = String(columnName).trim();
        } else if (relPath) {
            targetRelativePath = String(relPath).trim();
        } else {
            return res.status(400).json({ error: 'No relPath or columnName' });
        }

        if (!targetRelativePath) return res.status(400).json({ error: 'No path' });

        const fullPath = isColumn
            ? path.resolve(getBoardRoot(boardId), targetRelativePath)
            : getResolvedPathForBoard(req, targetRelativePath);

        if (!isInsideRoot(fullPath, DATA_ROOT)) return res.status(400).json({ error: 'Invalid path' });
        if (!fs.existsSync(fullPath)) return res.json({ success: true });

        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const st = await fs.promises.stat(fullPath); // <-- Асинхронно
                if (st.isDirectory()) {
                    await fs.promises.rm(fullPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
                } else {
                    await fs.promises.unlink(fullPath); // <-- Асинхронно
                }
                break;
            } catch (err) {
                lastErr = err;
                if (attempt < 2) await new Promise(r => setTimeout(r, 300));
            }
        }

        if (fs.existsSync(fullPath)) {
            const errMsg = lastErr ? lastErr.message : "Не удалось удалить";
            log(`Ошибка удаления: ${targetRelativePath} | ${errMsg}`);
            return res.status(500).json({ error: errMsg });
        }

        if (isColumn) {
            const colName = columnName || relPath;
            const order = getColumnOrder(boardId).filter(c => {
                if (typeof c === 'object') return c.folder !== colName && c.name !== colName;
                return c !== colName;
            });
            saveColumnOrder(boardId, order);
            log(`Колонка удалена: ${colName}`);
        } else {
            log(`Карточка удалена: ${targetRelativePath}`);
        }

        res.json({ success: true });
        broadcastRefresh(boardId);
    } catch (e) {
        log(`Ошибка удаления: ${e.message} | ${targetRelativePath || '?'}`);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/move-ticket', async (req, res) => { // <-- добавили async
    try {
        const { taskId, fromColumn, toColumn } = req.body;
        const boardId = requireRequestedBoardId(req, res);
        if (!boardId) return;
        if (!assertBoardAccess(req, res, boardId)) return;
        if (!taskId || !fromColumn || !toColumn) return res.status(400).json({ error: 'No taskId/fromColumn/toColumn' });
        const boardRoot = getBoardRoot(boardId);
        const oldP = path.resolve(boardRoot, fromColumn, taskId);
        const newColPath = path.resolve(boardRoot, toColumn);
        const newP = path.resolve(newColPath, taskId);

        if (!isInsideRoot(oldP, DATA_ROOT) || !isInsideRoot(newP, DATA_ROOT)) return res.status(400).json({ error: 'Invalid path' });

        try {
            await fs.promises.access(oldP); // Проверяем, существует ли старая папка
            try {
                await fs.promises.access(newColPath); // Проверяем колонку назначения
            } catch {
                await fs.promises.mkdir(newColPath, { recursive: true });
            }
            await fs.promises.rename(oldP, newP); // Асинхронный перенос
        } catch (e) {
            // Перенос не удался (нет исходной папки или ошибка ФС) — не сообщаем ложный успех.
            return res.status(404).json({ error: 'Карточка не найдена или не может быть перемещена' });
        }
        
        res.json({ success: true });
        broadcastRefresh(boardId);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reorder-columns', (req, res) => { 
    const boardId = requireRequestedBoardId(req, res);
    if (!boardId) return;
    saveColumnOrder(boardId, req.body.order || []); 
    res.json({ success: true }); 
    broadcastRefresh(boardId); 
});

app.post('/api/open-folder', (req, res) => {
    res.json({ success: true, message: "Not supported in web" });
});

const DISCOVERY_PORT = 39452;
const DISCOVERY_MAGIC_WHO = 'SMARTBOARD_WHO';
const DISCOVERY_MAGIC_OK = 'SMARTBOARD_OK|';
/** Порт, на котором SmartCap слушает уведомления о старте и остановке доски */
const SMARTCAP_STOP_PORT = 39453;
const DISCOVERY_MAGIC_STOP = 'SMARTBOARD_STOP';
const DISCOVERY_MAGIC_START = 'SMARTBOARD_START|';

/** Вычисляет broadcast-адрес подсети по IP и маске. */
function subnetBroadcast(addr, netmask) {
    const toInt = (s) => s.split('.').reduce((n, o) => (n << 8) + parseInt(o, 10), 0) >>> 0;
    const toStr = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
    return toStr((toInt(addr) & toInt(netmask)) | (~toInt(netmask) >>> 0));
}

/** Список broadcast-адресов всех сетевых интерфейсов сервера. */
function getBroadcastTargets() {
    const targets = new Set(['255.255.255.255']);
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces || {})) {
        if (isLikelyVirtualIface(name)) continue;
        for (const iface of (ifaces[name] || [])) {
            if (isIpv4Interface(iface) && !iface.internal && iface.address && iface.netmask)
                targets.add(subnetBroadcast(iface.address, iface.netmask));
        }
    }
    return Array.from(targets);
}

/** Отправляет broadcast всем SmartCap-клиентам. Возвращает Promise (resolves когда всё отправлено). */
function broadcastNotify(message, retries = 3, intervalMs = 2000) {
    return new Promise((resolve) => {
        try {
            const sock = dgram.createSocket('udp4');
            const buf = Buffer.from(message, 'utf8');
            const targets = getBroadcastTargets();
            let attempt = 0;
            const send = () => {
                for (const ip of targets) {
                    try { sock.send(buf, 0, buf.length, SMARTCAP_STOP_PORT, ip, () => {}); } catch (e) {}
                }
                attempt++;
                if (attempt >= retries) {
                    setTimeout(() => { try { sock.close(); } catch (e) {} resolve(); }, 50);
                } else {
                    setTimeout(send, intervalMs);
                }
            };
            sock.bind(() => {
                sock.setBroadcast(true);
                send();
            });
            sock.on('error', () => { try { sock.close(); } catch (e) {} resolve(); });
        } catch (e) { resolve(); }
    });
}

/** Отправляет broadcast SmartCap-клиентам: доска запущена, вот URL. */
function notifySmartCapStarted() {
    broadcastNotify(DISCOVERY_MAGIC_START + BASE_URL);
}

/** Доска остановлена: несколько раз шлём STOP всем SmartCap в LAN (на порт 39453). */
function notifySmartCapStopped() {
    return broadcastNotify(DISCOVERY_MAGIC_STOP, 12, 50);
}

function gracefulShutdown() {
    if (global.__shuttingDown) return;
    global.__shuttingDown = true;
    clearInterval(wsHeartbeatInterval);
    httpServer.close(() => {});
    notifySmartCapStopped().then(() => {
        process.exit(0);
    }).catch(() => process.exit(0));
    setTimeout(() => process.exit(1), 4000);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Порт ${PORT} уже занят. Завершите другой процесс или задайте PORT в .env`);
    } else {
        console.error('\n❌ Ошибка сервера:', err.message);
    }
    process.exit(1);
});

httpServer.listen(PORT, HOST, () => {
    const info = refreshPublicBaseUrl();
    console.log(`==========================================`);
    console.log(`Server started (listen: ${HOST}:${PORT})`);
    console.log(`Local:   http://localhost:${PORT}`);
    if (info.lanIps.length) {
        info.lanIps.forEach((ip) => {
            const mark = ip === info.localIp ? '  <- этот ПК' : '';
            console.log(`Network: http://${ip}:${PORT}${mark}`);
        });
    } else {
        console.log(`Network: ${info.baseUrl}`);
    }
    if (info.fromEnv) {
        console.log(`Public:  ${info.fromEnv}  (SMARTBOARD_PUBLIC_URL)`);
    }
    console.log(`==========================================`);
    
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('message', (msg, rinfo) => {
        const str = (msg.toString() || '').trim();
        if (str === DISCOVERY_MAGIC_WHO) {
            const reply = Buffer.from(DISCOVERY_MAGIC_OK + BASE_URL, 'utf8');
            udp.send(reply, 0, reply.length, rinfo.port, rinfo.address);
            log(`SmartCap нашёл сервер: клиент ${rinfo.address}`);
        }
    });
    udp.on('error', (err) => { try { udp.close(); } catch (e) {} });
    udp.bind({ port: DISCOVERY_PORT, address: '0.0.0.0' }, () => udp.setBroadcast(false));

    // Уведомляем SmartCap-клиентов о запуске: сразу, повтор через 1с и 2с, затем каждые 10с
    setTimeout(notifySmartCapStarted, 100);
    setTimeout(notifySmartCapStarted, 1100);
    setTimeout(notifySmartCapStarted, 2100);
    setInterval(notifySmartCapStarted, 10000);
});