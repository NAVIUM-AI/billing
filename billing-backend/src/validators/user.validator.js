/**
 * Joi schemas for the user-management routes. Kept separate from the
 * route file so validation rules are easy to find and reuse.
 */

const Joi = require("joi");

// Deliberately excludes 'owner': there is exactly one owner per tenant,
// set at signup (see auth.service.js). Owner status is never granted
// through this endpoint, and never removed through updateRoleSchema
// either — see userService.updateUserRole's CANNOT_MODIFY_OWNER guard.
const ASSIGNABLE_ROLES = ["admin", "accountant", "staff", "viewer"];

const createUserSchema = Joi.object({
  email: Joi.string().email().trim().lowercase().required(),

  // Same complexity rule as signup (auth.validator.js) — at least one
  // letter and one number.
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

  role: Joi.string()
    .valid(...ASSIGNABLE_ROLES)
    .required(),
});

const updateRoleSchema = Joi.object({
  role: Joi.string()
    .valid(...ASSIGNABLE_ROLES)
    .required(),
});

const setActiveSchema = Joi.object({
  isActive: Joi.boolean().required(),
});

const userIdParamSchema = Joi.object({
  userId: Joi.string().guid({ version: "uuidv4" }).required(),
});

const listUsersQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0),
  includeInactive: Joi.boolean().default(false),
});

module.exports = {
  createUserSchema,
  updateRoleSchema,
  setActiveSchema,
  userIdParamSchema,
  listUsersQuerySchema,
};
