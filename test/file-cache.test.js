const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FileCacheService } = require('../server/lib/services/file-cache');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('FileCacheService', function () {
  let tempDir;

  beforeEach(function () {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-vault-file-cache-'));
  });

  afterEach(function () {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores a full response and serves byte ranges from cache', async function () {
    const service = new FileCacheService({
      dir: tempDir,
      maxFileBytes: 1024,
      maxBytes: 10 * 1024,
      maxFiles: 100,
      minFreeBytes: 1,
    });
    const file = {
      id: 'file-1',
      file_name: 'hello.txt',
      mime_type: 'text/plain',
      file_size: 11,
    };

    await service.storeFromWebStream(file, new Response(Buffer.from('hello world')).body);

    const full = await service.createResponse(file, '', 'GET');
    assert.strictEqual(await full.text(), 'hello world');

    const partial = await service.createResponse(file, 'bytes=0-4', 'GET');
    assert.strictEqual(partial.status, 206);
    assert.strictEqual(await partial.text(), 'hello');
  });

  it('cleans least recently used entries when cache exceeds max bytes', async function () {
    const service = new FileCacheService({
      dir: tempDir,
      maxFileBytes: 1024,
      maxBytes: 10,
      maxFiles: 100,
      minFreeBytes: 1,
    });
    service.config.maxBytes = 10;
    service.config.minFreeBytes = 1;
    const first = {
      id: 'file-1',
      file_name: 'first.bin',
      mime_type: 'application/octet-stream',
      file_size: 8,
    };
    const second = {
      id: 'file-2',
      file_name: 'second.bin',
      mime_type: 'application/octet-stream',
      file_size: 8,
    };

    await service.storeFromWebStream(first, new Response(Buffer.from('12345678')).body);
    await delay(20);
    await service.storeFromWebStream(second, new Response(Buffer.from('abcdefgh')).body);
    await service.cleanup('test');

    const firstCached = await service.getCachedMeta(first);
    const secondCached = await service.getCachedMeta(second);

    assert.strictEqual(firstCached, null);
    assert.ok(secondCached);
  });
});
