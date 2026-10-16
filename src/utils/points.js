const User   = require('../models/User');
const Action = require('../models/Action');

async function addPoints(userId, actorId, type, points, refId = null) {
  const user = await User.findById(userId);
  if (!user) return false;

  await Action.create({ userId, actorId, type, points, refId });
  await User.findByIdAndUpdate(userId, { $inc: { totalPoints: points } });
  return true;
}

async function removePointsByAction(userId, actorId, refId, type) {
  const action = await Action.findOne({ userId, actorId, refId, type });
  if (action) {
    await User.findByIdAndUpdate(userId, { $inc: { totalPoints: -action.points } });
    await action.deleteOne();
    return true;
  }
  return false;
}

module.exports = { addPoints, removePointsByAction };
