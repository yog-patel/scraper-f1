const { Client } = require("pg");

// Database configuration
const dbConfig = {
  connectionString: "postgresql://ntm0uo:xau_WRxpN60kT7cEqyx22FLMcH7tp7vkmwDr0@us-east-1.sql.xata.sh/webnovelvault:main?sslmode=require",
  ssl: {
    rejectUnauthorized: false,
  },
};

// Shared client for the process
const client = new Client(dbConfig);
let clientConnected = false;

async function ensureConnected() {
  if (!clientConnected) {
    await client.connect();
    clientConnected = true;
  }
}

function slugify(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// Function to check if novel exists
async function checkNovelExists(title, author) {
  await ensureConnected();
  try {
    const result = await client.query(
      `SELECT novel_id, title, author FROM novels WHERE title = $1 AND author = $2`,
      [title, author]
    );
    if (result.rows.length > 0) {
      console.log(`Novel "${title}" by ${author} already exists with ID: ${result.rows[0].novel_id}`);
      return result.rows[0];
    }
    return null;
  } catch (error) {
    console.error("Error checking if novel exists:", error);
    return null;
  }
}

// Function to get the latest chapter number for a novel
async function getLatestChapterNumber(novelId) {
  await ensureConnected();
  try {
    const result = await client.query(
      `SELECT MAX(chapter_number) as latest_chapter FROM chapters WHERE novel_id = $1`,
      [novelId]
    );
    return result.rows[0].latest_chapter || 0;
  } catch (error) {
    console.error("Error getting latest chapter number:", error);
    return 0;
  }
}

// Function to update timestamps
async function updateTimestamp(tableName, idColumn, idValue) {
  await ensureConnected();
  try {
    await client.query(
      `UPDATE ${tableName} SET updated_at = CURRENT_TIMESTAMP WHERE ${idColumn} = $1`,
      [idValue]
    );
  } catch (error) {
    console.error(`Error updating timestamp for ${tableName}:`, error);
  }
}

// Function to update novel rating
async function updateNovelRating(novelId) {
  await ensureConnected();
  try {
    await client.query(
      `UPDATE novels 
       SET average_rating = (
         SELECT COALESCE(AVG(score), 0)
         FROM ratings
         WHERE novel_id = $1
       )
       WHERE novel_id = $1`,
      [novelId]
    );
  } catch (error) {
    console.error("Error updating novel rating:", error);
  }
}

// Function to add or update a rating
async function addOrUpdateRating(novelId, userId, score, review = null) {
  await ensureConnected();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO ratings (novel_id, user_id, score, review)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (novel_id, user_id) 
       DO UPDATE SET 
         score = $3,
         review = $4,
         updated_at = CURRENT_TIMESTAMP`,
      [novelId, userId, score, review]
    );
    await updateNovelRating(novelId);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error adding/updating rating:", error);
    return false;
  }
}

// Function to update novel metadata
async function updateNovelMetadata(novelId, novel) {
  await ensureConnected();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE novels SET 
        description = $1, 
        cover_image_url = $2, 
        status = $3
      WHERE novel_id = $4`,
      [
        novel.description,
        novel.cover_image_url,
        novel.status.toLowerCase(),
        novelId
      ]
    );
    await updateTimestamp('novels', 'novel_id', novelId);

    if (novel.genres && novel.genres.length > 0) {
      await client.query(
        `DELETE FROM novel_genres WHERE novel_id = $1`,
        [novelId]
      );
      for (const genreName of novel.genres) {
        await client.query(
          `INSERT INTO genres (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
          [genreName]
        );
        const genreResult = await client.query(
          `SELECT genre_id FROM genres WHERE name = $1`,
          [genreName]
        );
        if (genreResult.rows.length > 0) {
          await client.query(
            `INSERT INTO novel_genres (novel_id, genre_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [novelId, genreResult.rows[0].genre_id]
          );
        }
      }
    }

    if (novel.tags && novel.tags.length > 0) {
      await client.query(
        `DELETE FROM novel_tags WHERE novel_id = $1`,
        [novelId]
      );
      for (const tagName of novel.tags) {
        await client.query(
          `INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
          [tagName]
        );
        const tagResult = await client.query(
          `SELECT tag_id FROM tags WHERE name = $1`,
          [tagName]
        );
        if (tagResult.rows.length > 0) {
          await client.query(
            `INSERT INTO novel_tags (novel_id, tag_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [novelId, tagResult.rows[0].tag_id]
          );
        }
      }
    }

    await client.query('COMMIT');
    console.log(`Novel metadata updated for ID: ${novelId}`);
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error updating novel metadata:", error);
    return false;
  }
}

// Function to insert novel data
async function insertNovel(novel) {
  await ensureConnected();
  try {
    const existingNovel = await checkNovelExists(novel.title, novel.author);
    if (existingNovel) {
      await updateNovelMetadata(existingNovel.novel_id, novel);
      return existingNovel.novel_id;
    }
    await client.query('BEGIN');
    const novelResult = await client.query(
      `INSERT INTO novels (
        title, 
        author, 
        description, 
        cover_image_url, 
        status,
        slug
      ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING novel_id`,
      [
        novel.title,
        novel.author,
        novel.description,
        novel.cover_image_url,
        novel.status.toLowerCase(),
        slugify(novel.title),
      ]
    );
    const novelId = novelResult.rows[0].novel_id;

    if (novel.genres && novel.genres.length > 0) {
      for (const genreName of novel.genres) {
        await client.query(
          `INSERT INTO genres (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
          [genreName]
        );
        const genreResult = await client.query(
          `SELECT genre_id FROM genres WHERE name = $1`,
          [genreName]
        );
        if (genreResult.rows.length > 0) {
          await client.query(
            `INSERT INTO novel_genres (novel_id, genre_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [novelId, genreResult.rows[0].genre_id]
          );
        }
      }
    }

    if (novel.tags && novel.tags.length > 0) {
      for (const tagName of novel.tags) {
        await client.query(
          `INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
          [tagName]
        );
        const tagResult = await client.query(
          `SELECT tag_id FROM tags WHERE name = $1`,
          [tagName]
        );
        if (tagResult.rows.length > 0) {
          await client.query(
            `INSERT INTO novel_tags (novel_id, tag_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [novelId, tagResult.rows[0].tag_id]
          );
        }
      }
    }

    await client.query('COMMIT');
    console.log(`Novel inserted with ID: ${novelId}`);
    return novelId;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error inserting novel:", error);
    return null;
  }
}

// Function to insert chapter data
async function insertChapters(novelId, chapters) {
  await ensureConnected();
  try {
    const latestChapterNumber = await getLatestChapterNumber(novelId);
    console.log(`Current latest chapter: ${latestChapterNumber}`);
    await client.query('BEGIN');
    let newChaptersCount = 0;
    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];
      const chapterNumber = latestChapterNumber + i + 1;
      const chapterExists = await client.query(
        `SELECT chapter_id FROM chapters WHERE novel_id = $1 AND chapter_number = $2`,
        [novelId, chapterNumber]
      );
      if (chapterExists.rows.length > 0) {
        console.log(`Chapter ${chapterNumber} already exists. Skipping.`);
        continue;
      }
      await client.query(
        `INSERT INTO chapters (
          novel_id, 
          chapter_number, 
          title, 
          content, 
          created_at,
          is_free
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          novelId, 
          chapterNumber, 
          chapter.title, 
          chapter.content, 
          new Date(),
          true
        ]
      );
      newChaptersCount++;
      console.log(`Chapter ${chapterNumber} inserted.`);
    }
    await updateTimestamp('novels', 'novel_id', novelId);
    await client.query('COMMIT');
    console.log(`${newChaptersCount} new chapters inserted successfully.`);
    return newChaptersCount;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error inserting chapters:", error);
    return 0;
  }
}

// Close the shared database connection
async function closeDbConnection() {
  if (clientConnected) {
    await client.end();
    clientConnected = false;
    console.log("Database connection closed.");
  }
}

module.exports = {
  insertNovel,
  insertChapters,
  checkNovelExists,
  updateNovelMetadata,
  getLatestChapterNumber,
  closeDbConnection,
  addOrUpdateRating,
  updateNovelRating
};
