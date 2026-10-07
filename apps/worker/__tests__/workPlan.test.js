const { isImageContentType, planWork } = require('../lib/workPlan');

describe('isImageContentType', () => {
  it('accepts the supported image types', () => {
    expect(isImageContentType('image/jpeg')).toBe(true);
    expect(isImageContentType('image/png')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isImageContentType('IMAGE/PNG')).toBe(true);
  });

  it('rejects non-image types', () => {
    expect(isImageContentType('application/pdf')).toBe(false);
    expect(isImageContentType('image/svg+xml')).toBe(false); // not rasterized by design
  });

  it('treats a missing content type as non-image', () => {
    expect(isImageContentType(null)).toBe(false);
    expect(isImageContentType(undefined)).toBe(false);
  });
});

describe('planWork', () => {
  it('a fresh image upload needs both a thumbnail and replication', () => {
    const plan = planWork({ content_type: 'image/jpeg', thumbnail_key: null, replicated_at: null });
    expect(plan).toEqual({ needsThumbnail: true, needsReplication: true, isFullyProcessed: false });
  });

  it('a non-image upload only needs replication', () => {
    const plan = planWork({ content_type: 'application/pdf', thumbnail_key: null, replicated_at: null });
    expect(plan).toEqual({ needsThumbnail: false, needsReplication: true, isFullyProcessed: false });
  });

  it('a redelivered job for an already-thumbnailed, already-replicated file is a no-op', () => {
    const plan = planWork({ content_type: 'image/png', thumbnail_key: 'thumbnails/abc.jpg', replicated_at: new Date() });
    expect(plan.isFullyProcessed).toBe(true);
  });

  it('an image already found undecodable is never retried for a thumbnail', () => {
    const plan = planWork({ content_type: 'image/png', thumbnail_key: null, thumbnail_error: 'bad input', replicated_at: new Date() });
    expect(plan).toEqual({ needsThumbnail: false, needsReplication: false, isFullyProcessed: true });
  });

  it('a job that crashed after thumbnailing but before replication only redoes replication', () => {
    const plan = planWork({ content_type: 'image/png', thumbnail_key: 'thumbnails/abc.jpg', replicated_at: null });
    expect(plan).toEqual({ needsThumbnail: false, needsReplication: true, isFullyProcessed: false });
  });
});
