/**
 * Higher-order Express middleware that validates a request against a Joi
 * schema. Centralizing this means route handlers never see raw,
 * unvalidated req.body/query/params — by the time the handler runs, the
 * data has already been checked and coerced (e.g. trimmed, lowercased)
 * by Joi.
 */

const { apiError } = require("../utils/httpError");

/**
 * @param {import('joi').Schema} schema
 * @param {'body'|'query'|'params'} [source='body']
 * @returns {import('express').RequestHandler}
 */
function validate(schema, source = "body") {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[source], {
      abortEarly: false, // collect all validation errors, not just the first
      stripUnknown: true, // drop fields the client sent that we don't expect
    });

    if (error) {
      const fields = error.details.map((d) => ({
        field: d.path.join("."),
        message: d.message,
      }));
      throw apiError(400, "VALIDATION_ERROR", "Invalid request", { fields });
    }

    // Replace with the validated/coerced value so downstream code (the
    // service layer) always gets clean, predictable data.
    //
    // req.query is special in Express 5: it's defined as a getter that
    // re-parses req.url on every access (see express/lib/request.js),
    // not a plain writable property like req.body/req.params. A plain
    // `req.query = value` assignment is a silent no-op there (no error,
    // no effect) — coercion and Joi .default() values would otherwise
    // vanish and handlers would keep seeing raw query-string strings.
    // Object.defineProperty replaces the accessor outright, which works
    // for all three sources.
    Object.defineProperty(req, source, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    next();
  };
}

module.exports = validate;
