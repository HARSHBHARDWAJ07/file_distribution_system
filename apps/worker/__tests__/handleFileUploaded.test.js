// The job handler's edge cases, with Postgres and object storage faked.
// sharp is real, so "undecodable image" is a genuinely undecodable buffer.
const sharp = require('sharp');

jest.mock('../lib/db', () => ({ pool: { query: jest.fn() } }));
jest.mock('../lib/storage', () => ({
  getObjectBuffer: jest.fn(),
  putObject: jest.fn(async () => {}),
  deleteObject: jest.fn(async () => {}),
  replicateObject: jest.fn(async key => `replica/${key}`),
}));

const { pool } = require('../lib/db');
const storage = require('../lib/storage');
const { handleFileUploaded } = require('../jobs/handleFileUploaded');

const FILE_ID = '33333333-3333-4333-8333-333333333333';
const log = { info: jest.fn(), warn: jest.fn() };
const job = { id: 'job-1', data: { fileId: FILE_ID } };

// One files row; UPDATEs apply to it, and report 0 rows once it's "deleted".
function fakeRow(row) {
  const state = { row: row && { id: FILE_ID, storage_key: 'users/u/1-cat.png', status: 'complete',
    thumbnail_key: null, thumbnail_error: null, replicated_at: null, ...row } };
  pool.query.mockImplementation(async (sql, p) => {
    if (sql.startsWith('SELECT')) return { rows: state.row ? [{ ...state.row }] : [] };
    if (!state.row) return { rowCount: 0 };
    if (sql.includes('replicated_at = now()')) state.row.replicated_at = new Date();
    else if (sql.includes('thumbnail_key = $1')) state.row.thumbnail_key = p[0];
    else if (sql.includes('thumbnail_error = $1')) state.row.thumbnail_error = p[0];
    return { rowCount: 1 };
  });
  return state;
}

const pngBuffer = () => sharp({ create: { width: 400, height: 300, channels: 3, background: '#3a7' } }).png().toBuffer();

beforeEach(() => jest.clearAllMocks());

it('processes a fresh image: replica first, then thumbnail', async () => {
  const state = fakeRow({ content_type: 'image/png' });
  storage.getObjectBuffer.mockResolvedValue(await pngBuffer());

  await handleFileUploaded(job, log);

  expect(state.row.replicated_at).toBeInstanceOf(Date);
  expect(state.row.thumbnail_key).toBe(`thumbnails/${FILE_ID}.jpg`);
  const replicatedAt = storage.replicateObject.mock.invocationCallOrder[0];
  const thumbnailedAt = storage.putObject.mock.invocationCallOrder[0];
  expect(replicatedAt).toBeLessThan(thumbnailedAt);
  const [, thumb] = storage.putObject.mock.calls[0];
  expect((await sharp(thumb).metadata()).width).toBe(200);
});

it('a corrupt image is still replicated, and records why it has no thumbnail instead of failing the job', async () => {
  const state = fakeRow({ content_type: 'image/png' });
  storage.getObjectBuffer.mockResolvedValue(Buffer.from('not really a png'));

  await expect(handleFileUploaded(job, log)).resolves.toBeUndefined(); // no throw -> no pointless retries

  expect(state.row.replicated_at).toBeInstanceOf(Date);
  expect(state.row.thumbnail_key).toBeNull();
  expect(state.row.thumbnail_error).toMatch(/could not be decoded/);
});

it('a storage error while thumbnailing is rethrown so pg-boss retries it', async () => {
  fakeRow({ content_type: 'image/png' });
  storage.getObjectBuffer.mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
  await expect(handleFileUploaded(job, log)).rejects.toThrow('timeout');
});

it('a non-image file is only replicated', async () => {
  const state = fakeRow({ content_type: 'application/pdf' });
  await handleFileUploaded(job, log);
  expect(state.row.replicated_at).toBeInstanceOf(Date);
  expect(storage.getObjectBuffer).not.toHaveBeenCalled();
});

it('a file deleted before the job ran is skipped', async () => {
  fakeRow(null);
  await handleFileUploaded(job, log);
  expect(storage.replicateObject).not.toHaveBeenCalled();
});

it('a file deleted while the job ran gets the object the job just created cleaned up', async () => {
  const state = fakeRow({ content_type: 'application/pdf' });
  storage.replicateObject.mockImplementationOnce(async key => {
    state.row = null; // the user deleted the file during the copy
    return `replica/${key}`;
  });
  await handleFileUploaded(job, log);
  expect(storage.deleteObject).toHaveBeenCalledWith('replica/users/u/1-cat.png', undefined);
});

it('a redelivered job for a fully processed file does no storage work', async () => {
  fakeRow({ content_type: 'image/png', thumbnail_key: 'thumbnails/x.jpg', replicated_at: new Date() });
  await handleFileUploaded(job, log);
  expect(storage.replicateObject).not.toHaveBeenCalled();
  expect(storage.getObjectBuffer).not.toHaveBeenCalled();
});
