import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import superagent from 'superagent';

// ---------- Параметри командного рядка ----------

const program = new Command();

program
  .name('cache-proxy')
  .description('Кешуючий проксі-сервер для картинок з https://http.cat')
  // -h зайнята за замовчуванням під --help, тому довідку лишаємо лише як --help
  .helpOption('--help', 'показати довідку')
  .requiredOption('-h, --host <address>', 'адреса, на якій працює сервер')
  .requiredOption('-p, --port <number>', 'порт сервера', parsePort)
  .requiredOption('-c, --cache <path>', 'шлях до теки кешу');

program.parse();
const options = program.opts();

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    program.error(`error: некоректний порт "${value}" (потрібне ціле число 1–65535)`);
  }
  return port;
}

const CACHE_DIR = path.resolve(options.cache);
const UPSTREAM = 'https://http.cat';
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 МБ
const ALLOWED_METHODS = 'GET, PUT, DELETE';

// ---------- Допоміжні функції ----------

// Шлях має бути рівно "/<три цифри>". Регулярний вираз не пропускає
// "..", "/" та інші символи, тож вийти за межі теки кешу неможливо.
// Чи існує такий код насправді, вирішує http.cat (інакше — 404).
function parseCode(url) {
  const { pathname } = new URL(url, 'http://localhost');
  const match = /^\/(\d{3})$/.exec(pathname);
  return match ? match[1] : null;
}

function cacheFile(code) {
  return path.join(CACHE_DIR, `${code}.jpg`);
}

function sendText(res, status, message, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...extraHeaders,
  });
  res.end(message + '\n');
}

function sendImage(res, data, source) {
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': data.length,
    'X-Cache': source, // HIT — з кешу, MISS — щойно отримано з http.cat
  });
  res.end(data);
}

// Читання тіла запиту цілком: потік req ітерується через for await,
// жодних колбеків. Розмір обмежено, щоб не переповнити пам'ять.
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error('Тіло запиту завелике');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Атомарний запис: спочатку тимчасовий файл, потім rename.
// Читач ніколи не побачить наполовину записану картинку.
async function writeCacheFile(code, data) {
  const target = cacheFile(code);
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

async function readCacheFile(code) {
  try {
    return await fs.readFile(cacheFile(code));
  } catch (err) {
    if (err.code === 'ENOENT') return null; // промах кешу
    throw err; // інші помилки (немає прав тощо) — це 500
  }
}

// Запит до http.cat. Повертає Buffer із картинкою або null,
// якщо картинку отримати не вдалося (404, мережа, тайм-аут).
async function fetchFromUpstream(code) {
  try {
    const res = await superagent
      .get(`${UPSTREAM}/${code}`)
      .timeout(UPSTREAM_TIMEOUT_MS);

    if (!res.type.startsWith('image/') || !Buffer.isBuffer(res.body)) {
      console.error(`http.cat повернув не картинку для ${code}: ${res.type}`);
      return null;
    }
    return res.body;
  } catch (err) {
    if (err.response) {
      console.error(`http.cat відповів ${err.status} для коду ${code}`);
    } else {
      console.error(`Помилка запиту до http.cat (${code}): ${err.code ?? err.message}`);
    }
    return null;
  }
}

// ---------- Обробники методів ----------

async function handleGet(res, code) {
  const cached = await readCacheFile(code);
  if (cached) {
    sendImage(res, cached, 'HIT');
    return;
  }

  const image = await fetchFromUpstream(code);
  if (!image) {
    sendText(res, 404, `Картинку для коду ${code} не знайдено ні в кеші, ні на http.cat`);
    return;
  }

  await writeCacheFile(code, image); // спочатку в кеш,
  sendImage(res, image, 'MISS');     // потім клієнтові
}


async function handlePut(req, res, code) {
  const body = await readBody(req);
  if (body.length === 0) {
    sendText(res, 400, 'Тіло запиту порожнє: передайте картинку');
    return;
  }
  await writeCacheFile(code, body);
  sendText(res, 201, `Картинку для коду ${code} збережено в кеш`);
}


// ---------- Сервер ----------

const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'PUT', 'DELETE'].includes(req.method)) {
      sendText(res, 405, `Метод ${req.method} не підтримується`, { Allow: ALLOWED_METHODS });
      return;
    }

    const code = parseCode(req.url);
    if (!code) {
      sendText(res, 400, 'Некоректний шлях: очікується /<код стану HTTP>, наприклад /404');
      return;
    }

     if (req.method === 'GET') await handleGet(res, code);
    else if (req.method === 'PUT') await handlePut(req, res, code);
    else sendText(res, 501, `Метод ${req.method} ще не реалізовано`);
  } catch (err) {
    console.error(`${req.method} ${req.url}:`, err);
    if (!res.headersSent) {
      sendText(res, err.status ?? 500, err.status ? err.message : 'Внутрішня помилка сервера');
    } else {
      res.destroy();
    }
  }
});

try {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  server.listen(options.port, options.host);
  await once(server, 'listening'); // відхиляється, якщо сталася подія 'error'
  console.log(`Сервер працює на http://${options.host}:${options.port}`);
  console.log(`Тека кешу: ${CACHE_DIR}`);
} catch (err) {
  console.error(`Не вдалося запустити сервер: ${err.message}`);
  process.exit(1);
}