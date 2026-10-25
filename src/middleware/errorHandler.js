const {
  AppError,
  NotFoundError
} = require('../utils/errors');

function notFoundHandler(_req, _res, next) {
  next(new NotFoundError('Маршрут не найден'));
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  let statusCode = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Внутренняя ошибка сервера';
  let details;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err.name === 'ValidationError' && err.errors) {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    message = 'Ошибка валидации';
    details = Object.entries(err.errors).map(([field, error]) => ({
      field,
      message: error.message
    }));
  } else if (err.name === 'CastError') {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    message = 'Некорректный ID';
  } else if (err.code === 11000) {
    statusCode = 409;
    code = 'CONFLICT';
    message = 'Ресурс уже существует';
  } else if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    statusCode = 401;
    code = 'UNAUTHORIZED';
    message = 'Невалидный токен';
  } else if (err.type === 'entity.parse.failed') {
    // Битый JSON от body-parser: без этой ветки уходил как 500.
    statusCode = 400;
    code = 'INVALID_JSON';
    message = 'Некорректный JSON в теле запроса';
  } else if (err.type === 'entity.too.large') {
    statusCode = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Тело запроса слишком велико';
  } else if (err.expose && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    // Прочие «операционные» 4xx от middleware (например, ограничения body-parser).
    statusCode = err.status;
    code = 'BAD_REQUEST';
    message = err.message;
  }

  console.error('[ERROR]', {
    code: err.code,
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });

  return res.status(statusCode).json({
    error: { code, message, details: details ?? undefined }
  });
}

module.exports = { notFoundHandler, errorHandler };
