require('dotenv').config();

const mongoose = require('mongoose');
const Film = require('../src/models/Film');

const TMDB_POSTER_URL = /^https:\/\/image\.tmdb\.org\/t\/p\/[^/]+\/(.+)$/;

async function migratePosters(FilmModel = Film, logger = console) {
  const films = await FilmModel.find({
    poster: /^https:\/\/image\.tmdb\.org\/t\/p\//
  });
  let migrated = 0;
  let skipped = 0;

  for (const film of films) {
    if (film.posterPath) {
      skipped += 1;
      continue;
    }

    const match = film.poster?.match(TMDB_POSTER_URL);
    if (!match) {
      skipped += 1;
      continue;
    }

    film.posterPath = `/${match[1]}`;
    await film.save();
    migrated += 1;
  }

  logger.log(`migrated: ${migrated}, skipped: ${skipped}`);
  return { migrated, skipped };
}

if (require.main === module) {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI must be set to run the poster migration');
    process.exitCode = 1;
  } else {
    mongoose.connect(process.env.MONGODB_URI)
      .then(() => migratePosters())
      .catch(error => {
        console.error('Poster migration failed:', error);
        process.exitCode = 1;
      })
      .finally(() => mongoose.disconnect());
  }
}

module.exports = { migratePosters };
