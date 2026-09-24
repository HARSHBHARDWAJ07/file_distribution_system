const {
  CHUNK_SIZE_BYTES,
  CHUNK_THRESHOLD_BYTES,
  shouldUseChunkedUpload,
  calculatePartCount,
  remainingParts,
} = require('../lib/chunking');

describe('threshold selection', () => {
  it('uses single-shot for a file at or under the threshold', () => {
    expect(shouldUseChunkedUpload(CHUNK_THRESHOLD_BYTES)).toBe(false);
    expect(shouldUseChunkedUpload(1024)).toBe(false);
  });

  it('uses chunked upload for a file over the threshold', () => {
    expect(shouldUseChunkedUpload(CHUNK_THRESHOLD_BYTES + 1)).toBe(true);
  });
});

describe('part-count math', () => {
  it('divides evenly when size is an exact multiple of chunk size', () => {
    expect(calculatePartCount(CHUNK_SIZE_BYTES * 3)).toBe(3);
  });

  it('rounds up a partial final chunk instead of dropping it', () => {
    const sizeWithPartialLastChunk = CHUNK_SIZE_BYTES * 3 + 1024; // 3 full chunks + 1KB
    expect(calculatePartCount(sizeWithPartialLastChunk)).toBe(4);
  });

  it('treats a sub-one-chunk file as a single part', () => {
    expect(calculatePartCount(1024)).toBe(1);
  });
});

describe('resume / diffing logic', () => {
  it('reports every part as remaining when nothing has uploaded yet', () => {
    expect(remainingParts(4, [])).toEqual([1, 2, 3, 4]);
  });

  it('reports nothing remaining once every part has uploaded', () => {
    expect(remainingParts(4, [1, 2, 3, 4])).toEqual([]);
  });

  it('is unaffected by out-of-order or duplicate uploaded part records', () => {
    expect(remainingParts(4, [3, 1, 3, 1])).toEqual([2, 4]);
  });

  it('handles a single-part upload', () => {
    expect(remainingParts(1, [])).toEqual([1]);
  });
});
