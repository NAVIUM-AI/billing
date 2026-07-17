/**
 * Joi schemas for the auth routes. Kept separate from the route file so
 * the validation rules are easy to find and reuse (e.g. from tests).
 */

const Joi = require("joi");

const signupSchema = Joi.object({
  businessName: Joi.string().min(2).max(255).required(),

  email: Joi.string().email().trim().lowercase().required(),

  // Requires at least one letter and one number — plain min-length alone
  // lets people pick weak all-numeric or all-letter passwords.
  password: Joi.string()
    .min(8)
    .max(100)
    .pattern(/^(?=.*[A-Za-z])(?=.*\d).+$/)
    .required()
    .messages({
      "string.pattern.base":
        "Password must contain at least one letter and one number",
    }),

  fullName: Joi.string().min(2).max(255).required(),

  // GSTIN: 15-char alphanumeric identifier issued by Indian tax
  // authorities. Optional at signup since not every business has one
  // registered yet.
  gstin: Joi.string()
    .length(15)
    .pattern(/^[0-9A-Z]{15}$/)
    .optional(),

  stateCode: Joi.string().length(2).uppercase().optional(),
});

module.exports = { signupSchema };
