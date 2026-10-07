const { z } = require('zod');

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());

// bcrypt silently ignores everything past 72 bytes, so a longer password
// would "work" while only its prefix is checked. Reject it instead.
const newPassword = z.string().min(8, 'must be at least 8 characters')
  .refine(p => Buffer.byteLength(p, 'utf8') <= 72, 'must be at most 72 bytes');

const signupBody = z.object({ email, password: newPassword });

// Login doesn't re-apply signup's rules (they may change over time); it only
// bounds the input so a huge string can't be fed to bcrypt.
const loginBody = z.object({
  email: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(1024),
});

// Issued as `${userId}.${tokenId}`, both UUIDs.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const refreshBody = z.object({
  refreshToken: z.string().regex(new RegExp(`^${UUID}\\.${UUID}$`, 'i'), 'is malformed'),
});

module.exports = { signupBody, loginBody, refreshBody };
