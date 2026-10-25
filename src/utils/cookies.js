const { COOKIE_DOMAIN, COOKIE_SECURE, JWT_REFRESH_TTL_DAYS } = require('../config/env');

const refreshCookieOptions = {
  httpOnly: true,
  secure: COOKIE_SECURE,
  sameSite: 'lax',
  domain: COOKIE_DOMAIN,
  path: '/api/auth'
};

function setRefreshCookie(res, token) {
  res.cookie('refresh_token', token, {
    ...refreshCookieOptions,
    maxAge: JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000
  });
}

function clearRefreshCookie(res) {
  res.clearCookie('refresh_token', refreshCookieOptions);
}

module.exports = { setRefreshCookie, clearRefreshCookie };