const { fail } = require('./envelope');

// Runs any schema exposing safeParse (zod) and turns a failure into the
// standard error envelope, naming the first offending field.
function validate(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return { data: result.data };
  const issue = result.error.issues[0];
  const field = issue.path.length ? `${issue.path.join('.')}: ` : '';
  return { error: fail('INVALID_INPUT', `${field}${issue.message}`) };
}

// Final Express error handler. Body-parser errors are the client's fault and
// get a 4xx in the standard envelope instead of Express's default HTML page.
function errorHandler(serviceName) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json(fail('INVALID_JSON', 'request body is not valid JSON'));
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json(fail('PAYLOAD_TOO_LARGE', 'request body is too large'));
    }
    (req.log || console).error({ err }, `[${serviceName}] unhandled route error`);
    return res.status(500).json(fail('INTERNAL_ERROR', 'an unexpected error occurred'));
  };
}

module.exports = { validate, errorHandler };
