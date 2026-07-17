/**
 * Auth routes: signup, login, refresh, logout, and the "who am I" check.
 */

const express = require("express");

const validate = require("../../middleware/validate");
const authenticate = require("../../middleware/authenticate");
const { signupSchema, loginSchema } = require("../../validators/auth.validator");
const authService = require("../../services/auth.service");
const userRepository = require("../../repositories/user.repository");
const { apiError } = require("../../utils/httpError");
const env = require("../../config/env");

const router = express.Router();

const REFRESH_COOKIE_NAME = "refresh_token";
// Scoping the cookie to /api/v1/auth means the browser only ever sends
// it back on auth endpoints (login/refresh/logout), not on every request
// — reducing the surface area that could leak or misuse it.
const REFRESH_COOKIE_PATH = "/api/v1/auth";

/**
 * @param {import('express').Response} res
 * @param {string} rawToken
 * @param {Date} expiresAt
 */
function setRefreshCookie(res, rawToken, expiresAt) {
  res.cookie(REFRESH_COOKIE_NAME, rawToken, {
    httpOnly: true, // inaccessible to JS — mitigates XSS token theft
    secure: env.cookie.secure, // true in prod: cookie only sent over HTTPS
    sameSite: "lax",
    path: REFRESH_COOKIE_PATH,
    domain: env.cookie.domain,
    expires: expiresAt,
  });
}

// Express 5 forwards rejected promises from async route handlers to the
// error middleware automatically, so no try/catch or wrapper helper is
// needed here — throwing/rejecting inside a service function reaches
// errorHandler.js on its own.
router.post("/signup", validate(signupSchema), async (req, res) => {
  const { tenant, user } = await authService.signup(req.body);
  res.status(201).json({ tenant, user });
});

router.post("/login", validate(loginSchema), async (req, res) => {
  const { email, password } = req.body;
  const { user, accessToken, refreshToken, refreshExpiresAt } =
    await authService.login({
      email,
      password,
      userAgent: req.get("user-agent"),
      ipAddress: req.ip,
    });

  setRefreshCookie(res, refreshToken, refreshExpiresAt);
  // The refresh token only ever leaves the server in the HttpOnly
  // cookie above — never in the JSON body, where it'd be readable by
  // any JS on the page (and easily logged by accident).
  res.status(200).json({ user, accessToken });
});

router.post("/refresh", async (req, res) => {
  const rawRefreshToken = req.cookies[REFRESH_COOKIE_NAME];
  const { accessToken, refreshToken, refreshExpiresAt } =
    await authService.refresh({
      rawRefreshToken,
      userAgent: req.get("user-agent"),
      ipAddress: req.ip,
    });

  setRefreshCookie(res, refreshToken, refreshExpiresAt);
  res.status(200).json({ accessToken });
});

router.post("/logout", async (req, res) => {
  const rawRefreshToken = req.cookies[REFRESH_COOKIE_NAME];
  await authService.logout({ rawRefreshToken });
  // Must match the domain/path setRefreshCookie used, or the browser
  // treats this as clearing a different cookie and the original one
  // (and DB revocation aside, its own past-expiry replacement) both
  // linger in the jar.
  res.clearCookie(REFRESH_COOKIE_NAME, {
    path: REFRESH_COOKIE_PATH,
    domain: env.cookie.domain,
  });
  res.status(204).end();
});

router.get("/me", authenticate, async (req, res) => {
  const user = await userRepository.findById(req.user.userId);
  if (!user) {
    // The access token is valid, but the account it points to is gone
    // (e.g. deleted after the token was issued).
    throw apiError(401, "AUTH_INVALID", "Invalid token.");
  }
  delete user.password_hash;
  res.status(200).json({ user });
});

module.exports = router;
