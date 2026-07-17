/**
 * Auth routes: signup today, login/refresh in later tasks.
 */

const express = require("express");

const validate = require("../../middleware/validate");
const { signupSchema } = require("../../validators/auth.validator");
const authService = require("../../services/auth.service");

const router = express.Router();

// Express 5 forwards rejected promises from async route handlers to the
// error middleware automatically, so no try/catch or wrapper helper is
// needed here — throwing/rejecting inside `signup()` reaches
// errorHandler.js on its own.
router.post("/signup", validate(signupSchema), async (req, res) => {
  const { tenant, user } = await authService.signup(req.body);
  res.status(201).json({ tenant, user });
});

module.exports = router;
