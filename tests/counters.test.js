process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1/cinephilium-test-counters';
process.env.JWT_ACCESS_SECRET = 'test-jwt-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret';
process.env.TMDB_API_KEY = 'test-tmdb-key';
process.env.ADMIN_SECRET_KEY = 'test-admin-key';
process.env.CORS_ORIGIN = 'https://film.ru';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Film = require('../src/models/Film');
const Rating = require('../src/models/Rating');
const Review = require('../src/models/Review');
const Comment = require('../src/models/Comment');
const Action = require('../src/models/Action');
const Event = require('../src/models/Event');
const { signAccessToken } = require('../src/utils/jwt');
const { incCounter } = require('../src/utils/counters');
const { countUserCounters, processUsers } = require('../src/utils/counterMaintenance');
const app = require('../src/app');

let server;
let baseUrl;
let ipCounter = 1;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
});

function query(value) {
  return Object.assign(value, {
    select() { return this; },
    lean() { return this; },
    toObject() { return value; },
    populate(path) {
      if (path === 'userId' && value.userId && !value.userId.nickname) value.userId = author;
      if (path === 'filmId' && value.filmId && !value.filmId.title) value.filmId = film;
      return this;
    }
  });
}

async function request(path, { method = 'POST', body, token = signAccessToken(userId), headers = {} } = {}) {
  const requestHeaders = {
    'x-forwarded-for': `198.51.100.${ipCounter++}`,
    ...headers
  };
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}/api/${path}`, {
    method,
    headers: requestHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

async function withOverrides(overrides, callback) {
  const originals = overrides.map(([object, key, value]) => {
    const original = object[key];
    object[key] = value;
    return [object, key, original];
  });
  try {
    return await callback();
  } finally {
    for (const [object, key, original] of originals.reverse()) object[key] = original;
  }
}

const userId = new mongoose.Types.ObjectId();
const authorId = new mongoose.Types.ObjectId();
const filmId = new mongoose.Types.ObjectId();
const ratingId = new mongoose.Types.ObjectId();
const contentId = new mongoose.Types.ObjectId();
const author = { _id: authorId, nickname: 'Author', isAdmin: false };
const film = { _id: filmId, title: 'Film', poster: '' };
const regularUser = { _id: userId, nickname: 'User', isAdmin: false, counters: {} };
const admin = { _id: userId, nickname: 'Admin', isAdmin: true, counters: {} };

function counterUpdateOverrides(calls) {
  return [
    [User, 'updateOne', async (...args) => { calls.push(args); return { modifiedCount: 1 }; }],
    [User, 'findById', id => query(String(id) === String(authorId) ? author : regularUser)],
    [User, 'findByIdAndUpdate', async () => ({})],
    [Action, 'create', async () => ({})],
    [Event, 'create', async () => ({})]
  ];
}

function ratingScores() {
  return {
    scenario: { plot: 8, ideas: 8, dialogue: 8 },
    characters: { depth: 8, chemistry: 8, functionality: 8 },
    visual: { composition: 8, cinematography: 8, pacing: 8, tone: 8 },
    sound: { music: 8, design: 8, narrative: 8 },
    style: { originality: 8, boldness: 8 }
  };
}

test('1. creating a rating increments ratings', async () => {
  const calls = [];
  const rating = { _id: ratingId, combinedScore: 80, technicalScore: 80, vibe: 8 };
  await withOverrides([
    ...counterUpdateOverrides(calls),
    [Film, 'findById', async () => film],
    [Rating, 'findOne', async () => null],
    [Rating, 'findOneAndUpdate', async () => rating]
  ], async () => {
    const response = await request('ratings', { body: { filmId, scores: ratingScores(), vibe: 8 } });
    assert.equal(response.status, 201);
    assert.ok(calls.some(([filter, update]) => String(filter._id) === String(userId) && update.$inc?.['counters.ratings'] === 1));
  });
});

test('2. updating an upserted rating does not increment ratings', async () => {
  const calls = [];
  await withOverrides([
    ...counterUpdateOverrides(calls),
    [Film, 'findById', async () => film],
    [Rating, 'findOne', async () => ({ _id: ratingId })],
    [Rating, 'findOneAndUpdate', async () => ({ _id: ratingId, combinedScore: 80, technicalScore: 80, vibe: 8 })]
  ], async () => {
    const response = await request('ratings', { body: { filmId, scores: ratingScores(), vibe: 8 } });
    assert.equal(response.status, 201);
    assert.equal(calls.filter(([, update]) => update.$inc?.['counters.ratings']).length, 0);
  });
});

test('3. creating a pending review increments only reviews', async () => {
  const calls = [];
  const review = { _id: contentId, userId, filmId, ratingId, title: 'Review', text: 'x'.repeat(450), status: 'pending' };
  await withOverrides([
    ...counterUpdateOverrides(calls),
    [Film, 'findById', async () => film],
    [Rating, 'findOne', async () => ({ _id: ratingId, userId, filmId })],
    [Review, 'findOne', async () => null],
    [Review.prototype, 'save', async function save() {}],
    [Review, 'findById', () => query(review)]
  ], async () => {
    const response = await request('reviews', { body: { filmId, ratingId, title: 'Review', text: 'x'.repeat(450) } });
    assert.equal(response.status, 200);
    assert.ok(calls.some(([, update]) => update.$inc?.['counters.reviews'] === 1));
    assert.equal(calls.some(([, update]) => update.$inc?.['counters.reviewsApproved']), false);
  });
});

test('4. approving a pending review increments reviewsApproved', async () => {
  await testReviewModeration('approve', 'pending', 1);
});

test('5. rejecting a pending review leaves reviewsApproved unchanged', async () => {
  await testReviewModeration('reject', 'pending', 0);
});

test('6. rejecting an approved review decrements reviewsApproved', async () => {
  await testReviewModeration('reject', 'approved', -1);
});

test('repeatedly approving an approved review does not increment reviewsApproved', async () => {
  await testReviewModeration('approve', 'approved', 0);
});

async function testReviewModeration(action, status, expectedDelta) {
  const calls = [];
  const review = { _id: contentId, userId: authorId, filmId, status };
  const route = `admin/reviews/${contentId}/${action}`;
  await withOverrides([
    ...counterUpdateOverrides(calls),
    [User, 'findById', id => query(String(id) === String(userId) ? admin : author)],
    [Review, 'findById', () => query({ ...review })],
    [Review, 'updateOne', async (_filter, update) => { review.status = update.$set.status; return {}; }]
  ], async () => {
    const response = await request(route, { method: 'PUT', token: signAccessToken(userId) });
    assert.equal(response.status, 200);
    const expected = expectedDelta > 0 ? 1 : -1;
    const counterUpdates = calls.filter(([, update]) => update.$inc?.['counters.reviewsApproved']);
    assert.equal(counterUpdates.length, expectedDelta === 0 ? 0 : 1);
    if (expectedDelta !== 0) assert.equal(counterUpdates[0][1].$inc['counters.reviewsApproved'], expected);
  });
}

test('7. creating a pending comment increments only comments', async () => {
  const calls = [];
  const comment = { _id: contentId, userId, filmId, text: 'Comment', status: 'pending' };
  await withOverrides([
    ...counterUpdateOverrides(calls),
    [Film, 'findById', async () => film],
    [Comment.prototype, 'save', async function save() {}],
    [Comment, 'findById', () => query(comment)]
  ], async () => {
    const response = await request('comments', { body: { filmId, text: 'Comment' } });
    assert.equal(response.status, 200);
    assert.ok(calls.some(([, update]) => update.$inc?.['counters.comments'] === 1));
    assert.equal(calls.some(([, update]) => update.$inc?.['counters.commentsApproved']), false);
  });
});

test('8. approving and rejecting comments updates commentsApproved only on transitions', async () => {
  await testCommentModeration('approve', 'pending', 1);
  await testCommentModeration('approve', 'approved', 0);
  await testCommentModeration('reject', 'approved', -1);
  await testCommentModeration('reject', 'pending', 0);
  await testCommentModeration('reject', 'rejected', 0);
});

async function testCommentModeration(action, status, expectedDelta) {
  const calls = [];
  const comment = { _id: contentId, userId: authorId, filmId, status };
  await withOverrides([
    ...counterUpdateOverrides(calls),
    [User, 'findById', id => query(String(id) === String(userId) ? admin : author)],
    [Comment, 'findById', () => query({ ...comment })],
    [Comment, 'updateOne', async (_filter, update) => { comment.status = update.$set.status; return {}; }]
  ], async () => {
    const response = await request(`admin/comments/${contentId}/${action}`, { method: 'PUT', token: signAccessToken(userId) });
    assert.equal(response.status, 200);
    const counterUpdates = calls.filter(([, update]) => update.$inc?.['counters.commentsApproved']);
    assert.equal(counterUpdates.length, expectedDelta === 0 ? 0 : 1);
    if (expectedDelta !== 0) assert.equal(counterUpdates[0][1].$inc['counters.commentsApproved'], expectedDelta);
  });
}

test('9. a review like increments likesReceived for its author', async () => {
  const calls = [];
  const review = { _id: contentId, userId: authorId, likes: [], save: async function save() {} };
  await withOverrides([
    ...counterUpdateOverrides(calls),
    [Review, 'findById', async () => review]
  ], async () => {
    const response = await request(`reviews/${contentId}/like`);
    assert.equal(response.status, 200);
    assert.ok(calls.some(([filter, update]) => String(filter._id) === String(authorId) && update.$inc?.['counters.likesReceived'] === 1));
  });
});

test('10. top users pipeline has no collection lookups and returns counters', async () => {
  let pipeline;
  await withOverrides([
    [User, 'countDocuments', async () => 0],
    [User, 'aggregate', async stages => { pipeline = stages; return []; }]
  ], async () => {
    const response = await request('top/users', { method: 'GET', token: null });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.items, []);
    assert.ok(body.pagination);
    assert.equal(pipeline.some(stage => '$lookup' in stage), false);
    assert.ok(pipeline.at(-1).$project.counters);
  });
});

test('11. migration recomputes counters for three users', async () => {
  const ids = [1, 2, 3].map(() => new mongoose.Types.ObjectId());
  const updates = [];
  const users = ids.map(_id => ({ _id, counters: {} }));
  const overrides = [
    [User, 'find', () => ({ select() { return this; }, lean() { return this; }, cursor() { return (async function* () { yield* users; })(); } })],
    [User, 'updateOne', async (filter, update) => { updates.push({ filter, update }); return {}; }],
    [Rating, 'countDocuments', async ({ userId: id, completeness }) => completeness === 'vibe' ? 1 : ids.indexOf(id) + 1],
    [Review, 'countDocuments', async filter => filter.status ? ids.indexOf(filter.userId) : ids.indexOf(filter.userId) + 2],
    [Comment, 'countDocuments', async filter => filter.status ? ids.indexOf(filter.userId) + 1 : ids.indexOf(filter.userId) + 3],
    [Action, 'countDocuments', async ({ userId: id }) => ids.indexOf(id) + 4]
  ];

  await withOverrides(overrides, async () => {
    const result = await processUsers();
    assert.deepEqual(result, { processed: 3, errors: 0 });
    assert.equal(updates.length, 3);
    assert.deepEqual(updates[1].update.$set.counters, {
      ratings: 2, vibes: 1, reviews: 3, reviewsApproved: 1, comments: 4, commentsApproved: 2,
      filmLikes: 0, watchlist: 0, followers: 0, following: 0, likesReceived: 5
    });
  });
});

test('12. reconciliation repairs a corrupted rating counter', async () => {
  const user = { _id: userId, counters: { ratings: 999 } };
  let updated;
  const overrides = [
    [User, 'find', () => ({ select() { return this; }, lean() { return this; }, cursor() { return (async function* () { yield user; })(); } })],
    [User, 'updateOne', async (_filter, update) => { updated = update.$set.counters; return {}; }],
    [Rating, 'countDocuments', async () => 2],
    [Review, 'countDocuments', async filter => filter.status ? 0 : 0],
    [Comment, 'countDocuments', async filter => filter.status ? 0 : 0],
    [Action, 'countDocuments', async () => 0]
  ];
  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.join(' '));
  try {
    await withOverrides(overrides, async () => {
      const result = await processUsers({ reconcile: true });
      assert.deepEqual(result, { processed: 1, errors: 0 });
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(updated.ratings, 2);
  assert.ok(logged.some(line => line.includes('field=ratings expected=2 actual=999')));
});

test('counter helper rejects unknown fields and guards negative updates', async () => {
  const calls = [];
  await withOverrides([[User, 'updateOne', async (...args) => { calls.push(args); return {}; }]], async () => {
    await assert.rejects(incCounter(userId, 'unknown'), /incCounter: bad args/);
    await incCounter(userId, 'ratings', -1);
    assert.deepEqual(calls[0][0]['counters.ratings'], { $gte: 1 });
  });
});

test('counter migration uses the same expected values as countDocuments', async () => {
  const overrides = [
    [Rating, 'countDocuments', async ({ completeness }) => completeness === 'vibe' ? 1 : 2],
    [Review, 'countDocuments', async filter => filter.status === 'approved' ? 1 : 3],
    [Comment, 'countDocuments', async filter => filter.status === 'approved' ? 4 : 5],
    [Action, 'countDocuments', async () => 6]
  ];
  await withOverrides(overrides, async () => {
    assert.deepEqual(await countUserCounters(userId), {
      ratings: 2, vibes: 1, reviews: 3, reviewsApproved: 1, comments: 5, commentsApproved: 4,
      filmLikes: 0, watchlist: 0, followers: 0, following: 0, likesReceived: 6
    });
  });
});