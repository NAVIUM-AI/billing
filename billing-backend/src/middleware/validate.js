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
    req[source] = value;
    next();
  };
}

module.exports = validate;
