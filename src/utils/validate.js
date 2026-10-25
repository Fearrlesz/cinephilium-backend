const { validationResult } = require('express-validator');
const { ValidationError } = require('./errors');

function checkValidation(req, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    next(new ValidationError(
      'Ошибка валидации',
      errors.array().map(error => ({ field: error.path, message: error.msg }))
    ));
    return true;
  }
  return false;
}

module.exports = { checkValidation };
