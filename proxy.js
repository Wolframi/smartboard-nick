/**
 * Прокси: передаёт запросы на бэкенд и подставляет реальный IPv4 клиента
 * в X-RealIP / X Forwarded For (в User.csv бдут разные IP).
 * Запуск на хосте: node proxy.js (TARGET по умолчанию http://127.0.0.1:3001).
 * В Docker (Linux, network_mode: host): тот же скрипт, TARGET=http://127.0.0.1:3001.
 */
const http = require('http');
const httpProxy = require('http-proxy');

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '3000', 10);
const TARGET = (process.env.TARGET || 'http://127.0.0.1:3001').replace(/\/$/, '');

function clientIp(req) {
    const raw = req.socket?.remoteAddress || '';
    return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

const proxy = httpProxy.createProxyServer({ ws: true });

proxy.on('proxyReq', (proxyReq, req) => {
    const ip = clientIp(req);
    if (ip) {
        proxyReq.setHeader('X-Real-IP', ip);
        proxyReq.setHeader('X-Forwarded-For', ip);
    }
});

const server = http.createServer((req, res) => {
    const ip = clientIp(req);
    proxy.web(req, res, {
        target: TARGET,
        headers: { 'X-Real-IP': ip, 'X-Forwarded-For': ip }
    }, (err) => {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Bad Gateway');
    });
});

server.on('upgrade', (req, socket, head) => {
    const ip = clientIp(req);
    proxy.ws(req, socket, head, {
        target: TARGET,
        headers: { 'X-Real-IP': ip, 'X-Forwarded-For': ip }
    }, (err) => {
        socket.destroy();
    });
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`Proxy: http://0.0.0.0:${PROXY_PORT} -> ${TARGET} (real client IP in X-Real-IP)`);
});
