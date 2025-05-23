const { Client } = require("pg");

// Database configuration
const dbConfig = {
  connectionString: "postgresql://ntm0uo:xau_WRxpN60kT7cEqyx22FLMcH7tp7vkmwDr0@us-east-1.sql.xata.sh/webnovelvault:main?sslmode=require",
  ssl: {
    rejectUnauthorized: false,
  },
  // Connection pool settings for better resource management
  max: 2, // Reduce max connections
  idleTimeoutMillis: 5000, // Reduce idle timeout
  connectionTimeoutMillis: 10000,
};

// Enhanced retry configuration
const MAX_RETRIES = 5;
const BASE_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 10000;

// Rate limiting - respect Xata's 6 concurrent requests limit
class RateLimiter {
  constructor(maxConcurrent = 2) { // Reduced from 4 to 2
    this.maxConcurrent = maxConcurrent;
    this.currentRequests = 0;
    this.queue = [];
  }

  async execute(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.currentRequests >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const { fn, resolve, reject } = this.queue.shift();
    this.currentRequests++;

    try {
      const result = await fn();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.currentRequests--;
      // Process next item in queue
      setTimeout(() => this.processQueue(), 100);
    }
  }
}

const rateLimiter = new RateLimiter(2);

// Enhanced retry function with exponential backoff
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const getRetryDelay = (attempt) => Math.min(BASE_RETRY_DELAY * Math.pow(2, attempt), MAX_RETRY_DELAY);

// Shared connection pool
let client = null;
let isConnecting = false;

async function getClient() {
  if (!client || client._ending) {
    if (isConnecting) {
      // Wait for existing connection attempt
      await new Promise(resolve => setTimeout(resolve, 1000));
      return getClient();
    }
    
    isConnecting = true;
    try {
      // Close existing connection if any
      if (client) {
        try {
          await client.end();
        } catch (err) {
          console.warn('Error closing previous connection:', err.message);
        }
      }
      
      client = new Client(dbConfig);
      await client.connect();
      isConnecting = false;
    } catch (err) {
      isConnecting = false;
      throw err;
    }
  }
  return client;
}

// Enhanced error handling
function isRetryableError(error) {
  // Retry on connection issues, timeouts, and rate limits
  return (
    error.code === 'ECONNRESET' ||
    error.code === 'ENOTFOUND' ||
    error.code === 'ETIMEDOUT' ||
    error.message.includes('429') ||
    error.message.includes('rate limit') ||
    error.message.includes('timeout')
  );
}

// Rate-limited query execution
async function executeQuery(query, params = []) {
  return rateLimiter.execute(async () => {
    let retries = 0;
    
    while (retries < MAX_RETRIES) {
      try {
        const dbClient = await getClient();
        const result = await dbClient.query(query, params);
        return result;
      } catch (error) {
        console.error(`Query attempt ${retries + 1} failed:`, error.message);
        
        if (error.code === 'XATA_CONCURRENCY_LIMIT') {
          // Force connection reset on concurrency error
          if (client) {
            try {
              await client.end();
            } catch (err) {
              console.warn('Error closing client:', err.message);
            }
            client = null;
          }
          // Wait longer on concurrency errors
          await wait(5000);
        }
        
        if (!isRetryableError(error) || retries === MAX_RETRIES - 1) {
          throw error;
        }
        
        retries++;
        const delay = getRetryDelay(retries);
        console.log(`Retrying in ${delay}ms... (${retries}/${MAX_RETRIES})`);
        await wait(delay);
      }
    }
  });
}

// Batch processing utilities
class BatchProcessor {
  constructor(batchSize = 50) {
    this.batchSize = batchSize;
  }

  async processBatch(items, processor) {
    const results = [];
    
    for (let i = 0; i < items.length; i += this.batchSize) {
      const batch = items.slice(i, i + this.batchSize);
      console.log(`Processing batch ${Math.floor(i / this.batchSize) + 1}/${Math.ceil(items.length / this.batchSize)}`);
      
      try {
        const batchResults = await processor(batch);
        results.push(...batchResults);
        
        // Small delay between batches to be nice to the database
        if (i + this.batchSize < items.length) {
          await wait(200);
        }
      } catch (error) {
        console.error(`Batch processing failed for items ${i}-${i + batch.length - 1}:`, error);
        // Continue with next batch rather than failing completely
      }
    }
    
    return results;
  }
}

const batchProcessor = new BatchProcessor(50);

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

// Optimized novel existence check with caching
const novelCache = new Map();

async function checkNovelExists(title, author) {
  const cacheKey = `${title}|${author}`;
  
  if (novelCache.has(cacheKey)) {
    return novelCache.get(cacheKey);
  }

  try {
    const result = await executeQuery(
      `SELECT novel_id, title, author FROM novels WHERE title = $1 AND author = $2`,
      [title, author]
    );
    
    const novel = result.rows.length > 0 ? result.rows[0] : null;
    novelCache.set(cacheKey, novel);
    
    if (novel) {
      console.log(`Novel "${title}" by ${author} already exists with ID: ${novel.novel_id}`);
    }
    
    return novel;
  } catch (error) {
    console.error("Error checking if novel exists:", error);
    return null;
  }
}

async function getLatestChapterNumber(novelId) {
  try {
    const result = await executeQuery(
      `SELECT MAX(chapter_number) as latest_chapter FROM chapters WHERE novel_id = $1`,
      [novelId]
    );
    
    return result.rows[0].latest_chapter || 0;
  } catch (error) {
    console.error("Error getting latest chapter number:", error);
    return 0;
  }
}

// Optimized transaction with better error handling
async function executeTransaction(callback) {
  return rateLimiter.execute(async () => {
    let client = null;
    let retries = 0;
    
    while (retries < MAX_RETRIES) {
      try {
        client = new Client(dbConfig);
        await client.connect();
        await client.query('BEGIN');
        
        const result = await callback(client);
        
        await client.query('COMMIT');
        return result;
      } catch (error) {
        if (client) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            console.error("Error rolling back transaction:", rollbackError);
          }
        }
        
        if (!isRetryableError(error) || retries === MAX_RETRIES - 1) {
          throw error;
        }
        
        retries++;
        const delay = getRetryDelay(retries);
        console.log(`Transaction retry ${retries}/${MAX_RETRIES} in ${delay}ms`);
        await wait(delay);
      } finally {
        if (client) {
          try {
            await client.end();
          } catch (endError) {
            console.error("Error closing transaction client:", endError);
          }
        }
      }
    }
  });
}

// Batch novel processing
async function insertNovels(novels) {
  return batchProcessor.processBatch(novels, async (novelBatch) => {
    const results = [];
    
    for (const novel of novelBatch) {
      try {
        const novelId = await insertNovel(novel);
        results.push({ novel: novel.title, novelId });
      } catch (error) {
        console.error(`Failed to insert novel "${novel.title}":`, error);
        results.push({ novel: novel.title, error: error.message });
      }
    }
    
    return results;
  });
}

// Optimized novel insertion with upsert logic
async function insertNovel(novel) {
  return executeTransaction(async (client) => {
    // Check if novel already exists
    const existingNovel = await checkNovelExists(novel.title, novel.author);
    if (existingNovel) {
      await updateNovelMetadata(existingNovel.novel_id, novel);
      return existingNovel.novel_id;
    }
    
    // Insert the novel
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
        novel.status?.toLowerCase() || 'ongoing',
        slugify(novel.title),
      ]
    );
    
    const novelId = novelResult.rows[0].novel_id;
    
    // Process genres in batch
    if (novel.genres && novel.genres.length > 0) {
      await processGenres(client, novelId, novel.genres);
    }

    // Process tags in batch
    if (novel.tags && novel.tags.length > 0) {
      await processTags(client, novelId, novel.tags);
    }
    
    console.log(`Novel inserted with ID: ${novelId}`);
    return novelId;
  });
}

// Optimized genre processing
async function processGenres(client, novelId, genres) {
  // Insert all genres in batch
  const genreValues = genres.map((_, index) => `($${index + 1})`).join(',');
  await client.query(
    `INSERT INTO genres (name) VALUES ${genreValues} ON CONFLICT (name) DO NOTHING`,
    genres
  );
  
  // Get all genre IDs
  const placeholders = genres.map((_, index) => `$${index + 1}`).join(',');
  const genreResult = await client.query(
    `SELECT genre_id, name FROM genres WHERE name IN (${placeholders})`,
    genres
  );
  
  // Insert novel-genre relationships in batch
  if (genreResult.rows.length > 0) {
    const relationshipValues = genreResult.rows
      .map((_, index) => `($1, $${index + 2})`)
      .join(',');
    const params = [novelId, ...genreResult.rows.map(row => row.genre_id)];
    
    await client.query(
      `INSERT INTO novel_genres (novel_id, genre_id) VALUES ${relationshipValues} ON CONFLICT DO NOTHING`,
      params
    );
  }
}

// Optimized tag processing
async function processTags(client, novelId, tags) {
  // Insert all tags in batch
  const tagValues = tags.map((_, index) => `($${index + 1})`).join(',');
  await client.query(
    `INSERT INTO tags (name) VALUES ${tagValues} ON CONFLICT (name) DO NOTHING`,
    tags
  );
  
  // Get all tag IDs
  const placeholders = tags.map((_, index) => `$${index + 1}`).join(',');
  const tagResult = await client.query(
    `SELECT tag_id, name FROM tags WHERE name IN (${placeholders})`,
    tags
  );
  
  // Insert novel-tag relationships in batch
  if (tagResult.rows.length > 0) {
    const relationshipValues = tagResult.rows
      .map((_, index) => `($1, $${index + 2})`)
      .join(',');
    const params = [novelId, ...tagResult.rows.map(row => row.tag_id)];
    
    await client.query(
      `INSERT INTO novel_tags (novel_id, tag_id) VALUES ${relationshipValues} ON CONFLICT DO NOTHING`,
      params
    );
  }
}

// Batch chapter insertion with conflict handling
async function insertChapters(novelId, chapters) {
  return executeTransaction(async (client) => {
    const latestChapterNumber = await getLatestChapterNumber(novelId);
    console.log(`Current latest chapter: ${latestChapterNumber}`);
    
    let newChaptersCount = 0;
    const batchSize = 10; // Process chapters in batches

    // Process chapters in batches to avoid long-running operations
    for (let i = 0; i < chapters.length; i += batchSize) {
      const batch = chapters.slice(i, i + batchSize);
      
      for (let j = 0; j < batch.length; j++) {
        const chapter = batch[j];
        const chapterNumber = latestChapterNumber + i + j + 1;
        
        try {
          // Check if this chapter already exists
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
              chapter.title?.substring(0, 500), 
              chapter.content?.substring(0, 100000), 
              new Date(),
              true
            ]
          );
          
          newChaptersCount++;
          console.log(`Chapter ${chapterNumber} inserted.`);
          
        } catch (error) {
          console.error(`Error inserting chapter ${chapterNumber}:`, error.message);
          // Continue with next chapter
        }
      }
      
      // Brief pause between batches
      if (i + batchSize < chapters.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // Update the novel's updated_at timestamp
    await client.query(
      `UPDATE novels SET updated_at = CURRENT_TIMESTAMP WHERE novel_id = $1`,
      [novelId]
    );

    console.log(`${newChaptersCount} new chapters inserted successfully.`);
    return newChaptersCount;
  });
}

// Enhanced novel metadata update
async function updateNovelMetadata(novelId, novel) {
  return executeTransaction(async (client) => {
    // Update novel basic info
    await client.query(
      `UPDATE novels SET 
        description = $1, 
        cover_image_url = $2, 
        status = $3,
        updated_at = CURRENT_TIMESTAMP
      WHERE novel_id = $4`,
      [
        novel.description,
        novel.cover_image_url,
        novel.status?.toLowerCase() || 'ongoing',
        novelId
      ]
    );
    
    // Update genres
    if (novel.genres && novel.genres.length > 0) {
      // Clear existing genres
      await client.query(`DELETE FROM novel_genres WHERE novel_id = $1`, [novelId]);
      // Add new genres
      await processGenres(client, novelId, novel.genres);
    }
    
    // Update tags
    if (novel.tags && novel.tags.length > 0) {
      // Clear existing tags
      await client.query(`DELETE FROM novel_tags WHERE novel_id = $1`, [novelId]);
      // Add new tags
      await processTags(client, novelId, novel.tags);
    }
    
    console.log(`Novel metadata updated for ID: ${novelId}`);
    return true;
  });
}

// Rating functions (unchanged but with rate limiting)
async function addOrUpdateRating(novelId, userId, score, review = null) {
  return executeTransaction(async (client) => {
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

    return true;
  });
}

async function updateNovelRating(novelId) {
  try {
    await executeQuery(
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

// Graceful shutdown
async function closeDbConnection() {
  if (client) {
    try {
      await client.end();
      client = null;
      console.log("Database connection closed");
    } catch (error) {
      console.error("Error closing database connection:", error);
      // Force client to null even on error
      client = null;
    }
  }
}

// Health check function
async function healthCheck() {
  try {
    // Don't create a new connection just for health check if one exists
    if (client && !client._ending) {
      await client.query('SELECT 1');
      return true;
    }
    return true; // Assume healthy if no connection exists
  } catch (error) {
    console.error("Database health check failed:", error);
    return false;
  }
}

module.exports = {
  insertNovel,
  insertNovels,
  insertChapters,
  checkNovelExists,
  updateNovelMetadata,
  getLatestChapterNumber,
  addOrUpdateRating,
  updateNovelRating,
  closeDbConnection,
  healthCheck,
  rateLimiter,
  batchProcessor
};
