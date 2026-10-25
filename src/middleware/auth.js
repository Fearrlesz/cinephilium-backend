const User = require('../models/User');
const { verifyAccessToken } = require('../utils/jwt');
const { extractBearer } = require('./security');
const { UnauthorizedError, ForbiddenError, AppError } = require('../utils/errors');

const authenticate = async (req, res, next) => {
  const token = extractBearer(req);
  if (!token) return next(new UnauthorizedError());

  try {
    const decoded = verifyAccessToken(token);
    const user = await User.findById(decoded.userId);
    if (!user) return next(new UnauthorizedError('Пользователь не найден'));

    req.userId  = user._id;
    req.user    = user;
    req.isAdmin = user.isAdmin || false;
    return next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return next(new UnauthorizedError('Невалидный токен'));
    }
    return next(error);
  }
};

const isAdmin = async (req, res, next) => {
  if (!req.isAdmin) return next(new ForbiddenError('Требуются права администратора'));
  return next();
};

module.exports = { authenticate, isAdmin };
