// Presigned URLs, generated locally by the real AWS SDK (no network). Storage,
// not our code, enforces expiry - what we can test is that every URL asks for
// the right TTL and is bound to exactly one object.
process.env.STORAGE_BUCKET = 'test-bucket';
process.env.STORAGE_ENDPOINT = 'https://storage.example.com';
process.env.STORAGE_ACCESS_KEY_ID = 'test-key';
process.env.STORAGE_SECRET_ACCESS_KEY = 'test-secret';
delete process.env.STORAGE_PUBLIC_ENDPOINT;

const storage = require('../lib/storage');

const OWNER = '11111111-1111-4111-8111-111111111111';
const params = url => new URL(url).searchParams;

describe('presigned URL expiry', () => {
  it.each([
    ['upload', () => storage.getPresignedUploadUrl('users/u/k-a.png', 'image/png')],
    ['part', () => storage.getPresignedPartUploadUrl('users/u/k-a.bin', 'mpu-1', 2)],
    ['download', () => storage.getPresignedDownloadUrl('users/u/k-a.png', 'a.png')],
  ])('the %s URL expires after 300 seconds', async (_, make) => {
    expect(params(await make()).get('X-Amz-Expires')).toBe(String(storage.PRESIGN_EXPIRY_SECONDS));
    expect(storage.PRESIGN_EXPIRY_SECONDS).toBe(300);
  });
});

describe('presigned URL binding', () => {
  it('binds a part URL to one upload id and one part number', async () => {
    const p = params(await storage.getPresignedPartUploadUrl('users/u/k-a.bin', 'mpu-1', 2));
    expect(p.get('uploadId')).toBe('mpu-1');
    expect(p.get('partNumber')).toBe('2');
  });

  it('signs a different signature for a different object', async () => {
    const a = params(await storage.getPresignedDownloadUrl('users/u/k-a.png', 'a.png')).get('X-Amz-Signature');
    const b = params(await storage.getPresignedDownloadUrl('users/u/k-b.png', 'a.png')).get('X-Amz-Signature');
    expect(a).not.toBe(b);
  });

  it('forces a download under the original name, so uploaded HTML never renders inline', async () => {
    const p = params(await storage.getPresignedDownloadUrl('users/u/k-x.html', 'résumé "final".html'));
    expect(p.get('response-content-disposition'))
      .toBe(`attachment; filename="r_sum_ _final_.html"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.html`);
  });
});

describe('buildKey', () => {
  it('never collides, even for the same name in the same millisecond', () => {
    const keys = new Set(Array.from({ length: 1000 }, () => storage.buildKey(OWNER, 'cat.png')));
    expect(keys.size).toBe(1000);
  });

  it.each(['../../other-user/secret.txt', '..\\..\\x', 'a/../../b', '%2e%2e%2f'])(
    'keeps the traversal name %p inside the owner prefix', name => {
      const key = storage.buildKey(OWNER, name);
      expect(key.startsWith(`users/${OWNER}/`)).toBe(true);
      expect(key.slice(`users/${OWNER}/`.length)).not.toMatch(/[/\\]/);
    });

  it('caps the name part at 100 characters', () => {
    const key = storage.buildKey(OWNER, 'a'.repeat(500));
    expect(key.split('-').pop().length).toBe(100);
  });
});
