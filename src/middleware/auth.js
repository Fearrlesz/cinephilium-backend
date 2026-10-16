const User = require('../models/User');
const { verifyToken, extractBearer } = require('./security');

const authenticate = async (req, res, next) => {
  const token = extractBearer(req);
  if (!token) return res.status(401).json({ error: 'Не авторизован' });

  try {
    const decoded = verifyToken(token);
    const user = await User.findById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });

    req.userId  = user._id;
    req.user    = user;
    req.isAdmin = user.isAdmin || false;
    next();
  } catch {
    res.status(401).json({ error: 'Неверный токен' });
  }
};

const isAdmin = async (req, res, next) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Доступ только для администратора' });
  next();
};

module.exports = { authenticate, isAdmin };
