const { param } = require('express-validator');

const validateObjectId = (paramName) => [
  param(paramName).isMongoId().withMessage('Неверный ID')
];

module.exports = { validateObjectId };
