import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { Command } from 'commander';

// Параметри командного рядка 

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

// Допоміжні функції 

function sendText(res, status, message, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...extraHeaders,
  });
  res.end(message + '\n');
}

// Сервер 

const server = http.createServer(async (req, res) => {
  try {
    sendText(res, 501, 'Ще не реалізовано');
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