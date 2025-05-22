// const { Client, Pool } = require("pg");

// // Database configuration optimized for long-running operations
// const dbConfig = {
//   connectionString: "postgresql://ntm0uo:xau_WRxpN60kT7cEqyx22FLMcH7tp7vkmwDr0@us-east-1.sql.xata.sh/webnovelvault:main?sslmode=require",
//   ssl: {
//     rejectUnauthorized: false,
//   },
//   // Conservative pool settings for Xata free tier
//   max: 2, // Only 2 connections (leaving 3 for other operations)
//   min: 0, 
//   idleTimeoutMillis: 15000, // Close idle connections quickly
//   connectionTimeoutMillis: 8000,
//   acquireTimeoutMillis: 10000,
//   allowExitOnIdle: true,
//   // Additional settings for stability
//   query_timeout: 30000,
//   statement_timeout: 30000,
// };

// const pool = new Pool(dbConfig);

// // Enhanced error handling
// pool.on('error', (err) => {
//   console.error('Database pool error:', err);
// });

// // Graceful shutdown
// const gracefulShutdown = async () => {
//   console.log('Shutting down gracefully...');
//   await closeDbConnection();
//   process.exit(0);
// };

// process.on('SIGINT', gracefulShutdown);
// process.on('SIGTERM', gracefulShutdown);

// function slugify(str) {
//   return str
//     .toLowerCase()
//     .normalize('NFD')
//     .replace(/[\u0300-\u036f]/g, '')
//     .replace(/[^a-z0-9\s-]/g, '')
//     .trim()
//     .replace(/\s+/g, '-')
//     .replace(/-+/g, '-');
// }

// // Simplified retry for critical operations only
// async function withDbRetry(fn, maxRetries = 2) {
//   for (let attempt = 0; attempt < maxRetries; attempt++) {
//     try {
//       return await fn();
//     } catch (err) {
//       const isRetryable = err.code === 'ECONNRESET' || 
//         err.code === 'ETIMEDOUT' ||
//         err.message?.includes('Connection terminated') ||
//         err.message?.includes('server closed the connection');

//       if (isRetryable && attempt < maxRetries - 1) {
//         const delay = 1000 * (attempt + 1);
//         console.warn(`DB retry ${attempt + 1}/${maxRetries} in ${delay}ms:`, err.message);
//         await new Promise(res => setTimeout(res, delay));
//         continue;
//       }
//       throw err;
//     }
//   }
// }

// // Simple query wrapper
// async function executeQuery(queryText, params = []) {
//   return withDbRetry(async () => {
//     const client = await pool.connect();
//     try {
//       return await client.query(queryText, params);
//     } finally {
//       client.release();
//     }
//   });
// }

// // Transaction wrapper
// async function executeTransaction(operations) {
//   return withDbRetry(async () => {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');
//       let result;
//       for (const operation of operations) {
//         result = await operation(client);
//       }
//       await client.query('COMMIT');
//       return result;
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   });
// }

// // Basic utility functions
// async function checkNovelExists(title, author) {
//   try {
//     const result = await executeQuery(
//       `SELECT novel_id, title, author FROM novels WHERE title = $1 AND author = $2`,
//       [title, author]
//     );
//     if (result.rows.length > 0) {
//       console.log(`Novel "${title}" by ${author} already exists with ID: ${result.rows[0].novel_id}`);
//       return result.rows[0];
//     }
//     return null;
//   } catch (error) {
//     console.error("Error checking if novel exists:", error);
//     return null;
//   }
// }

// async function getLatestChapterNumber(novelId) {
//   try {
//     const result = await executeQuery(
//       `SELECT MAX(chapter_number) as latest_chapter FROM chapters WHERE novel_id = $1`,
//       [novelId]
//     );
//     return result.rows[0].latest_chapter || 0;
//   } catch (error) {
//     console.error("Error getting latest chapter number:", error);
//     return 0;
//   }
// }

// async function updateTimestamp(tableName, idColumn, idValue) {
//   try {
//     await executeQuery(
//       `UPDATE ${tableName} SET updated_at = CURRENT_TIMESTAMP WHERE ${idColumn} = $1`,
//       [idValue]
//     );
//   } catch (error) {
//     console.error(`Error updating timestamp for ${tableName}:`, error);
//   }
// }

// async function updateNovelRating(novelId) {
//   try {
//     await executeQuery(
//       `UPDATE novels 
//        SET average_rating = (
//          SELECT COALESCE(AVG(score), 0)
//          FROM ratings
//          WHERE novel_id = $1
//        )
//        WHERE novel_id = $1`,
//       [novelId]
//     );
//   } catch (error) {
//     console.error("Error updating novel rating:", error);
//   }
// }

// async function addOrUpdateRating(novelId, userId, score, review = null) {
//   try {
//     await executeTransaction([
//       async (client) => {
//         await client.query(
//           `INSERT INTO ratings (novel_id, user_id, score, review)
//            VALUES ($1, $2, $3, $4)
//            ON CONFLICT (novel_id, user_id) 
//            DO UPDATE SET 
//              score = $3,
//              review = $4,
//              updated_at = CURRENT_TIMESTAMP`,
//           [novelId, userId, score, review]
//         );
        
//         await client.query(
//           `UPDATE novels 
//            SET average_rating = (
//              SELECT COALESCE(AVG(score), 0)
//              FROM ratings
//              WHERE novel_id = $1
//            )
//            WHERE novel_id = $1`,
//           [novelId]
//         );
//       }
//     ]);
//     return true;
//   } catch (error) {
//     console.error("Error adding/updating rating:", error);
//     return false;
//   }
// }

// // Optimized novel metadata update
// async function updateNovelMetadata(novelId, novel) {
//   try {
//     await executeTransaction([
//       async (client) => {
//         await client.query(
//           `UPDATE novels SET 
//             description = $1, 
//             cover_image_url = $2, 
//             status = $3,
//             updated_at = CURRENT_TIMESTAMP
//           WHERE novel_id = $4`,
//           [novel.description, novel.cover_image_url, novel.status.toLowerCase(), novelId]
//         );

//         // Handle genres efficiently
//         if (novel.genres?.length > 0) {
//           await client.query(`DELETE FROM novel_genres WHERE novel_id = $1`, [novelId]);
          
//           const genreValues = novel.genres.map((_, i) => `($${i + 1})`).join(',');
//           await client.query(
//             `INSERT INTO genres (name) VALUES ${genreValues} ON CONFLICT (name) DO NOTHING`,
//             novel.genres
//           );
          
//           const genreResult = await client.query(
//             `SELECT genre_id FROM genres WHERE name = ANY($1)`,
//             [novel.genres]
//           );
          
//           if (genreResult.rows.length > 0) {
//             const genreInserts = genreResult.rows.map((_, i) => `($1, $${i + 2})`).join(',');
//             await client.query(
//               `INSERT INTO novel_genres (novel_id, genre_id) VALUES ${genreInserts} ON CONFLICT DO NOTHING`,
//               [novelId, ...genreResult.rows.map(row => row.genre_id)]
//             );
//           }
//         }

//         // Handle tags efficiently  
//         if (novel.tags?.length > 0) {
//           await client.query(`DELETE FROM novel_tags WHERE novel_id = $1`, [novelId]);
          
//           const tagValues = novel.tags.map((_, i) => `($${i + 1})`).join(',');
//           await client.query(
//             `INSERT INTO tags (name) VALUES ${tagValues} ON CONFLICT (name) DO NOTHING`,
//             novel.tags
//           );
          
//           const tagResult = await client.query(
//             `SELECT tag_id FROM tags WHERE name = ANY($1)`,
//             [novel.tags]
//           );
          
//           if (tagResult.rows.length > 0) {
//             const tagInserts = tagResult.rows.map((_, i) => `($1, $${i + 2})`).join(',');
//             await client.query(
//               `INSERT INTO novel_tags (novel_id, tag_id) VALUES ${tagInserts} ON CONFLICT DO NOTHING`,
//               [novelId, ...tagResult.rows.map(row => row.tag_id)]
//             );
//           }
//         }
//       }
//     ]);
    
//     console.log(`Novel metadata updated for ID: ${novelId}`);
//     return true;
//   } catch (error) {
//     console.error("Error updating novel metadata:", error);
//     return false;
//   }
// }

// // Optimized novel insertion
// async function insertNovel(novel) {
//   try {
//     const existingNovel = await checkNovelExists(novel.title, novel.author);
//     if (existingNovel) {
//       await updateNovelMetadata(existingNovel.novel_id, novel);
//       return existingNovel.novel_id;
//     }

//     const novelId = await executeTransaction([
//       async (client) => {
//         const novelResult = await client.query(
//           `INSERT INTO novels (title, author, description, cover_image_url, status, slug)
//            VALUES ($1, $2, $3, $4, $5, $6) RETURNING novel_id`,
//           [novel.title, novel.author, novel.description, novel.cover_image_url, 
//            novel.status.toLowerCase(), slugify(novel.title)]
//         );
        
//         const novelId = novelResult.rows[0].novel_id;

//         // Batch insert genres
//         if (novel.genres?.length > 0) {
//           const genreValues = novel.genres.map((_, i) => `($${i + 1})`).join(',');
//           await client.query(
//             `INSERT INTO genres (name) VALUES ${genreValues} ON CONFLICT (name) DO NOTHING`,
//             novel.genres
//           );
          
//           const genreResult = await client.query(
//             `SELECT genre_id FROM genres WHERE name = ANY($1)`,
//             [novel.genres]
//           );
          
//           if (genreResult.rows.length > 0) {
//             const genreInserts = genreResult.rows.map((_, i) => `($1, $${i + 2})`).join(',');
//             await client.query(
//               `INSERT INTO novel_genres (novel_id, genre_id) VALUES ${genreInserts}`,
//               [novelId, ...genreResult.rows.map(row => row.genre_id)]
//             );
//           }
//         }

//         // Batch insert tags
//         if (novel.tags?.length > 0) {
//           const tagValues = novel.tags.map((_, i) => `($${i + 1})`).join(',');
//           await client.query(
//             `INSERT INTO tags (name) VALUES ${tagValues} ON CONFLICT (name) DO NOTHING`,
//             novel.tags
//           );
          
//           const tagResult = await client.query(
//             `SELECT tag_id FROM tags WHERE name = ANY($1)`,
//             [novel.tags]
//           );
          
//           if (tagResult.rows.length > 0) {
//             const tagInserts = tagResult.rows.map((_, i) => `($1, $${i + 2})`).join(',');
//             await client.query(
//               `INSERT INTO novel_tags (novel_id, tag_id) VALUES ${tagInserts}`,
//               [novelId, ...tagResult.rows.map(row => row.tag_id)]
//             );
//           }
//         }
        
//         return novelId;
//       }
//     ]);

//     console.log(`Novel inserted with ID: ${novelId}`);
//     return novelId;
//   } catch (error) {
//     console.error("Error inserting novel:", error);
//     return null;
//   }
// }

// // **IMPROVED CHAPTER INSERTION WITH PROPER ERROR HANDLING AND ORDER GUARANTEE**
// async function insertChapters(novelId, chapters) {
//   if (!chapters || chapters.length === 0) return { inserted: 0, failed: 0, errors: [] };
  
//   console.log(`Starting insertion of ${chapters.length} chapters for novel ${novelId}`);
  
//   const startTime = Date.now();
//   let totalInserted = 0;
//   const errors = [];
  
//   // Get the current latest chapter number and lock it for the duration
//   const latestChapterNumber = await getLatestChapterNumber(novelId);
  
//   // Smaller batch size for better error isolation and recovery
//   const batchSize = 25;
  
//   for (let i = 0; i < chapters.length; i += batchSize) {
//     const batch = chapters.slice(i, i + batchSize);
//     const batchStartTime = Date.now();
//     const batchNumber = Math.floor(i / batchSize) + 1;
//     const totalBatches = Math.ceil(chapters.length / batchSize);
    
//     try {
//       const inserted = await executeTransaction([
//         async (client) => {
//           // Build bulk insert query with guaranteed sequential chapter numbers
//           const values = [];
//           const params = [];
//           let paramIndex = 1;
          
//           for (let j = 0; j < batch.length; j++) {
//             const chapter = batch[j];
//             // Guarantee sequential chapter numbering based on original array position
//             const chapterNumber = latestChapterNumber + i + j + 1;
            
//             values.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5})`);
//             params.push(
//               novelId,
//               chapterNumber,
//               chapter.title,
//               chapter.content,
//               new Date(),
//               true
//             );
//             paramIndex += 6;
//           }
          
//           // Single bulk insert with conflict handling
//           const query = `
//             INSERT INTO chapters (novel_id, chapter_number, title, content, created_at, is_free)
//             VALUES ${values.join(', ')}
//             ON CONFLICT (novel_id, chapter_number) DO UPDATE SET
//               title = EXCLUDED.title,
//               content = EXCLUDED.content,
//               updated_at = CURRENT_TIMESTAMP
//           `;
          
//           const result = await client.query(query, params);
//           return result.rowCount;
//         }
//       ]);
      
//       totalInserted += inserted;
//       const batchTime = Date.now() - batchStartTime;
//       const progress = ((i + batch.length) / chapters.length * 100).toFixed(1);
      
//       console.log(`Batch ${batchNumber}/${totalBatches}: ${inserted} chapters inserted in ${batchTime}ms (${progress}% complete)`);
      
//       // Short delay to prevent overwhelming the database
//       if (i + batchSize < chapters.length) {
//         await new Promise(res => setTimeout(res, 100));
//       }
      
//     } catch (error) {
//       const errorInfo = {
//         batchNumber,
//         batchRange: `${i + 1}-${Math.min(i + batchSize, chapters.length)}`,
//         error: error.message,
//         timestamp: new Date().toISOString()
//       };
//       errors.push(errorInfo);
      
//       console.error(`CRITICAL ERROR in batch ${batchNumber}/${totalBatches} (chapters ${errorInfo.batchRange}):`, error.message);
//       console.error('Stopping insertion process due to batch failure.');
      
//       // Stop the entire process on first batch failure
//       break;
//     }
//   }
  
//   // Only update novel timestamp if some chapters were successfully inserted
//   if (totalInserted > 0) {
//     await updateTimestamp('novels', 'novel_id', novelId);
//   }
  
//   const totalTime = Date.now() - startTime;
//   const rate = totalInserted > 0 ? totalInserted / (totalTime / 1000) : 0;
//   const result = {
//     inserted: totalInserted,
//     failed: chapters.length - totalInserted,
//     errors: errors,
//     totalTime: totalTime,
//     rate: rate
//   };
  
//   if (errors.length > 0) {
//     console.error(`Chapter insertion FAILED: ${result.inserted}/${chapters.length} chapters inserted before failure`);
//     console.error(`Failure details:`, errors);
//   } else {
//     console.log(`Chapter insertion COMPLETED: ${result.inserted}/${chapters.length} chapters in ${totalTime}ms (${rate.toFixed(1)} chapters/sec)`);
//   }
  
//   return result;
// }

// // **ENHANCED STREAMING CHAPTER PROCESSOR WITH STRICT ORDER AND FAILURE HANDLING**
// class ChapterStreamProcessor {
//   constructor(novelId, options = {}) {
//     this.novelId = novelId;
//     this.batchSize = options.batchSize || 50;
//     this.delayBetweenBatches = options.delayBetweenBatches || 100;
//     this.stopOnError = options.stopOnError !== false; // Default to true
    
//     this.buffer = [];
//     this.processing = false;
//     this.processed = 0;
//     this.failed = 0;
//     this.errors = [];
//     this.stopped = false;
//     this.startingChapterNumber = null;
//   }

//   async initialize() {
//     this.startingChapterNumber = await getLatestChapterNumber(this.novelId);
//     console.log(`Stream processor initialized. Starting from chapter number: ${this.startingChapterNumber + 1}`);
//   }

//   async addChapter(chapter) {
//     if (this.stopped) {
//       throw new Error('Processor stopped due to previous errors. Cannot add more chapters.');
//     }
    
//     this.buffer.push(chapter);
    
//     // Auto-process when buffer is full
//     if (this.buffer.length >= this.batchSize && !this.processing) {
//       await this.processBatch();
//     }
//   }

//   async addChapters(chapters) {
//     if (this.stopped) {
//       throw new Error('Processor stopped due to previous errors. Cannot add more chapters.');
//     }
    
//     this.buffer.push(...chapters);
//     if (!this.processing) {
//       await this.processAll();
//     }
//   }

//   async processBatch() {
//     if (this.buffer.length === 0 || this.stopped) return;
    
//     const batch = this.buffer.splice(0, this.batchSize);
//     this.processing = true;
    
//     try {
//       const inserted = await this.insertBatch(batch);
//       this.processed += inserted;
//       console.log(`Streamed batch: ${inserted} chapters (Total: ${this.processed})`);
//     } catch (error) {
//       const errorInfo = {
//         batchNumber: Math.floor(this.processed / this.batchSize) + 1,
//         chapterRange: `${this.processed + 1}-${this.processed + batch.length}`,
//         error: error.message,
//         timestamp: new Date().toISOString()
//       };
//       this.errors.push(errorInfo);
//       this.failed += batch.length;
      
//       console.error(`Stream processing error in batch ${errorInfo.batchNumber}:`, error.message);
      
//       if (this.stopOnError) {
//         this.stopped = true;
//         console.error('Stream processor stopped due to error.');
//         // Don't re-add chapters to buffer when stopping on error
//       } else {
//         // Re-add failed chapters to buffer for retry (only if not stopping on error)
//         this.buffer.unshift(...batch);
//       }
//     }
    
//     this.processing = false;
//   }

//   async processAll() {
//     if (this.startingChapterNumber === null) {
//       await this.initialize();
//     }
    
//     this.processing = true;
    
//     while (this.buffer.length > 0 && !this.stopped) {
//       const batch = this.buffer.splice(0, this.batchSize);
      
//       try {
//         const inserted = await this.insertBatch(batch);
//         this.processed += inserted;
        
//         if (this.buffer.length > 0) {
//           await new Promise(res => setTimeout(res, this.delayBetweenBatches));
//         }
//       } catch (error) {
//         const errorInfo = {
//           batchNumber: Math.floor(this.processed / this.batchSize) + 1,
//           chapterRange: `${this.processed + 1}-${this.processed + batch.length}`,
//           error: error.message,
//           timestamp: new Date().toISOString()
//         };
//         this.errors.push(errorInfo);
//         this.failed += batch.length;
        
//         console.error(`Stream processing error in batch ${errorInfo.batchNumber}:`, error.message);
        
//         if (this.stopOnError) {
//           this.stopped = true;
//           console.error('Stream processor stopped due to error.');
//           break;
//         } else {
//           await new Promise(res => setTimeout(res, 2000)); // Wait longer on error
//         }
//       }
//     }
    
//     // Only update novel timestamp if some chapters were successfully processed
//     if (this.processed > 0) {
//       await updateTimestamp('novels', 'novel_id', this.novelId);
//     }
    
//     this.processing = false;
    
//     const status = this.stopped && this.errors.length > 0 ? 'FAILED' : 'COMPLETED';
//     console.log(`Stream processing ${status}: ${this.processed} chapters processed, ${this.failed} failed, ${this.errors.length} errors`);
    
//     return { 
//       processed: this.processed, 
//       failed: this.failed, 
//       errors: this.errors, 
//       stopped: this.stopped,
//       remaining: this.buffer.length
//     };
//   }

//   async insertBatch(batch) {
//     return executeTransaction([
//       async (client) => {
//         const values = [];
//         const params = [];
//         let paramIndex = 1;
        
//         for (let i = 0; i < batch.length; i++) {
//           const chapter = batch[i];
//           // Guarantee sequential chapter numbering
//           const chapterNumber = this.startingChapterNumber + this.processed + i + 1;
          
//           values.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5})`);
//           params.push(
//             this.novelId,
//             chapterNumber,
//             chapter.title,
//             chapter.content,
//             new Date(),
//             true
//           );
//           paramIndex += 6;
//         }
        
//         const query = `
//           INSERT INTO chapters (novel_id, chapter_number, title, content, created_at, is_free)
//           VALUES ${values.join(', ')}
//           ON CONFLICT (novel_id, chapter_number) DO UPDATE SET
//             title = EXCLUDED.title,
//             content = EXCLUDED.content,
//             updated_at = CURRENT_TIMESTAMP
//         `;
        
//         const result = await client.query(query, params);
//         return result.rowCount;
//       }
//     ]);
//   }

//   getStats() {
//     return {
//       processed: this.processed,
//       failed: this.failed,
//       errors: this.errors.length,
//       buffered: this.buffer.length,
//       processing: this.processing,
//       stopped: this.stopped
//     };
//   }

//   reset() {
//     this.buffer = [];
//     this.processed = 0;
//     this.failed = 0;
//     this.errors = [];
//     this.stopped = false;
//     this.processing = false;
//     this.startingChapterNumber = null;
//   }
// }

// // Enhanced progress tracker with failure tracking
// class ProgressTracker {
//   constructor(total, name = 'Operation') {
//     this.total = total;
//     this.name = name;
//     this.processed = 0;
//     this.failed = 0;
//     this.startTime = Date.now();
//     this.lastUpdate = 0;
//   }

//   update(increment = 1, failures = 0) {
//     this.processed += increment;
//     this.failed += failures;
//     const now = Date.now();
    
//     // Update every 5 seconds or at completion
//     if (now - this.lastUpdate > 5000 || (this.processed + this.failed) >= this.total) {
//       const elapsed = now - this.startTime;
//       const rate = this.processed / (elapsed / 1000);
//       const completed = this.processed + this.failed;
//       const progress = (completed / this.total * 100).toFixed(1);
//       const eta = this.processed > 0 ? ((this.total - completed) / rate) : 0;
      
//       const failureInfo = this.failed > 0 ? ` (${this.failed} failed)` : '';
//       console.log(`${this.name}: ${this.processed}/${this.total}${failureInfo} (${progress}%) - ${rate.toFixed(1)}/sec - ETA: ${Math.round(eta)}s`);
//       this.lastUpdate = now;
//     }
//   }

//   getStats() {
//     return {
//       processed: this.processed,
//       failed: this.failed,
//       total: this.total,
//       successRate: this.total > 0 ? (this.processed / this.total * 100).toFixed(1) : 0
//     };
//   }
// }

// async function closeDbConnection() {
//   try {
//     await pool.end();
//     console.log("Database connection pool closed.");
//   } catch (error) {
//     console.error("Error closing database connection pool:", error);
//   }
// }

// function getPoolStats() {
//   return {
//     totalCount: pool.totalCount,
//     idleCount: pool.idleCount,
//     waitingCount: pool.waitingCount
//   };
// }

// async function healthCheck() {
//   try {
//     const result = await executeQuery('SELECT 1 as health');
//     return result.rows[0].health === 1;
//   } catch (error) {
//     console.error("Database health check failed:", error);
//     return false;
//   }
// }

// module.exports = {
//   // Core functions
//   insertNovel,
//   insertChapters,
//   checkNovelExists,
//   updateNovelMetadata,
//   getLatestChapterNumber,
//   addOrUpdateRating,
//   updateNovelRating,
  
//   // Advanced processing for large operations
//   ChapterStreamProcessor,
//   ProgressTracker,
  
//   // Utilities
//   closeDbConnection,
//   healthCheck,
//   getPoolStats
// };





















































const { Client, Pool } = require("pg");

// Database configuration optimized for Xata's strict connection limits
const dbConfig = {
  connectionString: "postgresql://ntm0uo:xau_WRxpN60kT7cEqyx22FLMcH7tp7vkmwDr0@us-east-1.sql.xata.sh/webnovelvault:main?sslmode=require",
  ssl: {
    rejectUnauthorized: false,
  },
  // Ultra-conservative pool settings for Xata free tier (likely only 1 connection allowed)
  max: 1, // Only 1 connection - Xata free tier seems to have very low limits
  min: 0, 
  idleTimeoutMillis: 5000, // Close idle connections very quickly
  connectionTimeoutMillis: 15000, // Longer timeout for connection acquisition
  acquireTimeoutMillis: 20000, // Much longer acquire timeout
  allowExitOnIdle: true,
  evictionRunIntervalMillis: 5000, // Run eviction more frequently
  // Additional settings for stability
  query_timeout: 45000,
  statement_timeout: 45000,
};

const pool = new Pool(dbConfig);

// Enhanced error handling
pool.on('error', (err) => {
  console.error('Database pool error:', err);
});

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('Shutting down gracefully...');
  await closeDbConnection();
  process.exit(0);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

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

// Enhanced retry for critical operations with Xata-specific error handling
async function withDbRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable = err.code === 'ECONNRESET' || 
        err.code === 'ETIMEDOUT' ||
        err.code === 'XATA_CONCURRENCY_LIMIT' || // Xata-specific error
        err.message?.includes('Connection terminated') ||
        err.message?.includes('server closed the connection') ||
        err.message?.includes('concurrent connections limit exceeded');

      if (isRetryable && attempt < maxRetries - 1) {
        // Progressive backoff with longer delays for Xata
        const baseDelay = err.code === 'XATA_CONCURRENCY_LIMIT' ? 3000 : 1000;
        const delay = baseDelay * Math.pow(2, attempt);
        console.warn(`DB retry ${attempt + 1}/${maxRetries} in ${delay}ms for ${err.code || 'connection error'}:`, err.message);
        
        // Force close any lingering connections before retry
        if (err.code === 'XATA_CONCURRENCY_LIMIT') {
          console.log('Forcing pool cleanup due to connection limit...');
          await forcePoolCleanup();
        }
        
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
      throw err;
    }
  }
}

// Enhanced query wrapper with connection management
async function executeQuery(queryText, params = []) {
  return withDbRetry(async () => {
    let client;
    try {
      client = await pool.connect();
      const result = await client.query(queryText, params);
      return result;
    } finally {
      if (client) {
        client.release();
        // Add small delay to ensure connection is fully released
        await new Promise(res => setTimeout(res, 10));
      }
    }
  });
}

// Enhanced transaction wrapper with better cleanup
async function executeTransaction(operations) {
  return withDbRetry(async () => {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      let result;
      for (const operation of operations) {
        result = await operation(client);
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('Rollback failed:', rollbackError);
        }
      }
      throw error;
    } finally {
      if (client) {
        client.release();
        // Add small delay to ensure connection is fully released
        await new Promise(res => setTimeout(res, 10));
      }
    }
  });
}

// Force cleanup of pool connections (for Xata connection limit issues)
async function forcePoolCleanup() {
  try {
    // Get all clients and force close them
    const totalCount = pool.totalCount;
    const idleCount = pool.idleCount;
    
    console.log(`Pool stats before cleanup: total=${totalCount}, idle=${idleCount}`);
    
    // Wait for any pending operations to complete
    await new Promise(res => setTimeout(res, 1000));
    
    // The pool should automatically clean up idle connections
    // but we can trigger it manually if needed
    if (pool._evictionManager) {
      pool._evictionManager.schedule();
    }
    
    console.log('Pool cleanup completed');
  } catch (error) {
    console.error('Error during pool cleanup:', error);
  }
}

// **SERIAL OPERATION MANAGER FOR XATA CONNECTION LIMITS**
class SerialOperationManager {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  async execute(operation) {
    return new Promise((resolve, reject) => {
      this.queue.push({ operation, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    
    while (this.queue.length > 0) {
      const { operation, resolve, reject } = this.queue.shift();
      
      try {
        const result = await operation();
        resolve(result);
      } catch (error) {
        reject(error);
      }
      
      // Small delay between operations to ensure connection cleanup
      await new Promise(res => setTimeout(res, 100));
    }
    
    this.processing = false;
  }
}

// Global serial operation manager
const serialOpManager = new SerialOperationManager();
// Basic utility functions - all operations now serialized for Xata
async function checkNovelExists(title, author) {
  return serialOpManager.execute(async () => {
    try {
      const result = await executeQuery(
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
      if (error.code === 'XATA_CONCURRENCY_LIMIT') {
        throw new Error('Database connection limit exceeded. Please try again later.');
      }
      return null;
    }
  });
}

async function getLatestChapterNumber(novelId) {
  return serialOpManager.execute(async () => {
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
  });
}

async function updateTimestamp(tableName, idColumn, idValue) {
  return serialOpManager.execute(async () => {
    try {
      await executeQuery(
        `UPDATE ${tableName} SET updated_at = CURRENT_TIMESTAMP WHERE ${idColumn} = $1`,
        [idValue]
      );
    } catch (error) {
      console.error(`Error updating timestamp for ${tableName}:`, error);
    }
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

async function addOrUpdateRating(novelId, userId, score, review = null) {
  try {
    await executeTransaction([
      async (client) => {
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
      }
    ]);
    return true;
  } catch (error) {
    console.error("Error adding/updating rating:", error);
    return false;
  }
}

// Optimized novel metadata update
async function updateNovelMetadata(novelId, novel) {
  try {
    await executeTransaction([
      async (client) => {
        await client.query(
          `UPDATE novels SET 
            description = $1, 
            cover_image_url = $2, 
            status = $3,
            updated_at = CURRENT_TIMESTAMP
          WHERE novel_id = $4`,
          [novel.description, novel.cover_image_url, novel.status.toLowerCase(), novelId]
        );

        // Handle genres efficiently
        if (novel.genres?.length > 0) {
          await client.query(`DELETE FROM novel_genres WHERE novel_id = $1`, [novelId]);
          
          const genreValues = novel.genres.map((_, i) => `($${i + 1})`).join(',');
          await client.query(
            `INSERT INTO genres (name) VALUES ${genreValues} ON CONFLICT (name) DO NOTHING`,
            novel.genres
          );
          
          const genreResult = await client.query(
            `SELECT genre_id FROM genres WHERE name = ANY($1)`,
            [novel.genres]
          );
          
          if (genreResult.rows.length > 0) {
            const genreInserts = genreResult.rows.map((_, i) => `($1, $${i + 2})`).join(',');
            await client.query(
              `INSERT INTO novel_genres (novel_id, genre_id) VALUES ${genreInserts} ON CONFLICT DO NOTHING`,
              [novelId, ...genreResult.rows.map(row => row.genre_id)]
            );
          }
        }

        // Handle tags efficiently  
        if (novel.tags?.length > 0) {
          await client.query(`DELETE FROM novel_tags WHERE novel_id = $1`, [novelId]);
          
          const tagValues = novel.tags.map((_, i) => `($${i + 1})`).join(',');
          await client.query(
            `INSERT INTO tags (name) VALUES ${tagValues} ON CONFLICT (name) DO NOTHING`,
            novel.tags
          );
          
          const tagResult = await client.query(
            `SELECT tag_id FROM tags WHERE name = ANY($1)`,
            [novel.tags]
          );
          
          if (tagResult.rows.length > 0) {
            const tagInserts = tagResult.rows.map((_, i) => `($1, $${i + 2})`).join(',');
            await client.query(
              `INSERT INTO novel_tags (novel_id, tag_id) VALUES ${tagInserts} ON CONFLICT DO NOTHING`,
              [novelId, ...tagResult.rows.map(row => row.tag_id)]
            );
          }
        }
      }
    ]);
    
    console.log(`Novel metadata updated for ID: ${novelId}`);
    return true;
  } catch (error) {
    console.error("Error updating novel metadata:", error);
    return false;
  }
}

// Optimized novel insertion - serialized for Xata
async function insertNovel(novel) {
  return serialOpManager.execute(async () => {
    try {
      const existingNovel = await checkNovelExists(novel.title, novel.author);
      if (existingNovel) {
        await updateNovelMetadata(existingNovel.novel_id, novel);
        return existingNovel.novel_id;
      }

      const novelId = await executeTransaction([
        async (client) => {
          const novelResult = await client.query(
            `INSERT INTO novels (title, author, description, cover_image_url, status, slug)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING novel_id`,
            [novel.title, novel.author, novel.description, novel.cover_image_url, 
             novel.status.toLowerCase(), slugify(novel.title)]
          );
          
          const novelId = novelResult.rows[0].novel_id;

          // Batch insert genres
          if (novel.genres?.length > 0) {
            const genreValues = novel.genres.map((_, i) => `(${i + 1})`).join(',');
            await client.query(
              `INSERT INTO genres (name) VALUES ${genreValues} ON CONFLICT (name) DO NOTHING`,
              novel.genres
            );
            
            const genreResult = await client.query(
              `SELECT genre_id FROM genres WHERE name = ANY($1)`,
              [novel.genres]
            );
            
            if (genreResult.rows.length > 0) {
              const genreInserts = genreResult.rows.map((_, i) => `($1, ${i + 2})`).join(',');
              await client.query(
                `INSERT INTO novel_genres (novel_id, genre_id) VALUES ${genreInserts}`,
                [novelId, ...genreResult.rows.map(row => row.genre_id)]
              );
            }
          }

          // Batch insert tags
          if (novel.tags?.length > 0) {
            const tagValues = novel.tags.map((_, i) => `(${i + 1})`).join(',');
            await client.query(
              `INSERT INTO tags (name) VALUES ${tagValues} ON CONFLICT (name) DO NOTHING`,
              novel.tags
            );
            
            const tagResult = await client.query(
              `SELECT tag_id FROM tags WHERE name = ANY($1)`,
              [novel.tags]
            );
            
            if (tagResult.rows.length > 0) {
              const tagInserts = tagResult.rows.map((_, i) => `($1, ${i + 2})`).join(',');
              await client.query(
                `INSERT INTO novel_tags (novel_id, tag_id) VALUES ${tagInserts}`,
                [novelId, ...tagResult.rows.map(row => row.tag_id)]
              );
            }
          }
          
          return novelId;
        }
      ]);

      console.log(`Novel inserted with ID: ${novelId}`);
      return novelId;
    } catch (error) {
      console.error("Error inserting novel:", error);
      if (error.code === 'XATA_CONCURRENCY_LIMIT') {
        throw new Error('Database connection limit exceeded. Please try again later.');
      }
      return null;
    }
  });
}

// **IMPROVED CHAPTER INSERTION WITH PROPER ERROR HANDLING AND ORDER GUARANTEE**
async function insertChapters(novelId, chapters) {
  if (!chapters || chapters.length === 0) return { inserted: 0, failed: 0, errors: [] };
  
  console.log(`Starting insertion of ${chapters.length} chapters for novel ${novelId}`);
  
  const startTime = Date.now();
  let totalInserted = 0;
  const errors = [];
  
  // Get the current latest chapter number and lock it for the duration
  const latestChapterNumber = await getLatestChapterNumber(novelId);
  
  // Smaller batch size for better error isolation and recovery
  const batchSize = 25;
  
  for (let i = 0; i < chapters.length; i += batchSize) {
    const batch = chapters.slice(i, i + batchSize);
    const batchStartTime = Date.now();
    const batchNumber = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(chapters.length / batchSize);
    
    try {
      const inserted = await executeTransaction([
        async (client) => {
          // Build bulk insert query with guaranteed sequential chapter numbers
          const values = [];
          const params = [];
          let paramIndex = 1;
          
          for (let j = 0; j < batch.length; j++) {
            const chapter = batch[j];
            // Guarantee sequential chapter numbering based on original array position
            const chapterNumber = latestChapterNumber + i + j + 1;
            
            values.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5})`);
            params.push(
              novelId,
              chapterNumber,
              chapter.title,
              chapter.content,
              new Date(),
              true
            );
            paramIndex += 6;
          }
          
          // Single bulk insert with conflict handling
          const query = `
            INSERT INTO chapters (novel_id, chapter_number, title, content, created_at, is_free)
            VALUES ${values.join(', ')}
            ON CONFLICT (novel_id, chapter_number) DO UPDATE SET
              title = EXCLUDED.title,
              content = EXCLUDED.content,
              updated_at = CURRENT_TIMESTAMP
          `;
          
          const result = await client.query(query, params);
          return result.rowCount;
        }
      ]);
      
      totalInserted += inserted;
      const batchTime = Date.now() - batchStartTime;
      const progress = ((i + batch.length) / chapters.length * 100).toFixed(1);
      
      console.log(`Batch ${batchNumber}/${totalBatches}: ${inserted} chapters inserted in ${batchTime}ms (${progress}% complete)`);
      
      // Short delay to prevent overwhelming the database
      if (i + batchSize < chapters.length) {
        await new Promise(res => setTimeout(res, 100));
      }
      
    } catch (error) {
      const errorInfo = {
        batchNumber,
        batchRange: `${i + 1}-${Math.min(i + batchSize, chapters.length)}`,
        error: error.message,
        timestamp: new Date().toISOString()
      };
      errors.push(errorInfo);
      
      console.error(`CRITICAL ERROR in batch ${batchNumber}/${totalBatches} (chapters ${errorInfo.batchRange}):`, error.message);
      console.error('Stopping insertion process due to batch failure.');
      
      // Stop the entire process on first batch failure
      break;
    }
  }
  
  // Only update novel timestamp if some chapters were successfully inserted
  if (totalInserted > 0) {
    await updateTimestamp('novels', 'novel_id', novelId);
  }
  
  const totalTime = Date.now() - startTime;
  const rate = totalInserted > 0 ? totalInserted / (totalTime / 1000) : 0;
  const result = {
    inserted: totalInserted,
    failed: chapters.length - totalInserted,
    errors: errors,
    totalTime: totalTime,
    rate: rate
  };
  
  if (errors.length > 0) {
    console.error(`Chapter insertion FAILED: ${result.inserted}/${chapters.length} chapters inserted before failure`);
    console.error(`Failure details:`, errors);
  } else {
    console.log(`Chapter insertion COMPLETED: ${result.inserted}/${chapters.length} chapters in ${totalTime}ms (${rate.toFixed(1)} chapters/sec)`);
  }
  
  return result;
}

// **ENHANCED STREAMING CHAPTER PROCESSOR WITH STRICT ORDER AND FAILURE HANDLING**
class ChapterStreamProcessor {
  constructor(novelId, options = {}) {
    this.novelId = novelId;
    this.batchSize = options.batchSize || 50;
    this.delayBetweenBatches = options.delayBetweenBatches || 100;
    this.stopOnError = options.stopOnError !== false; // Default to true
    
    this.buffer = [];
    this.processing = false;
    this.processed = 0;
    this.failed = 0;
    this.errors = [];
    this.stopped = false;
    this.startingChapterNumber = null;
  }

  async initialize() {
    this.startingChapterNumber = await getLatestChapterNumber(this.novelId);
    console.log(`Stream processor initialized. Starting from chapter number: ${this.startingChapterNumber + 1}`);
  }

  async addChapter(chapter) {
    if (this.stopped) {
      throw new Error('Processor stopped due to previous errors. Cannot add more chapters.');
    }
    
    this.buffer.push(chapter);
    
    // Auto-process when buffer is full
    if (this.buffer.length >= this.batchSize && !this.processing) {
      await this.processBatch();
    }
  }

  async addChapters(chapters) {
    if (this.stopped) {
      throw new Error('Processor stopped due to previous errors. Cannot add more chapters.');
    }
    
    this.buffer.push(...chapters);
    if (!this.processing) {
      await this.processAll();
    }
  }

  async processBatch() {
    if (this.buffer.length === 0 || this.stopped) return;
    
    const batch = this.buffer.splice(0, this.batchSize);
    this.processing = true;
    
    try {
      const inserted = await this.insertBatch(batch);
      this.processed += inserted;
      console.log(`Streamed batch: ${inserted} chapters (Total: ${this.processed})`);
    } catch (error) {
      const errorInfo = {
        batchNumber: Math.floor(this.processed / this.batchSize) + 1,
        chapterRange: `${this.processed + 1}-${this.processed + batch.length}`,
        error: error.message,
        timestamp: new Date().toISOString()
      };
      this.errors.push(errorInfo);
      this.failed += batch.length;
      
      console.error(`Stream processing error in batch ${errorInfo.batchNumber}:`, error.message);
      
      if (this.stopOnError) {
        this.stopped = true;
        console.error('Stream processor stopped due to error.');
        // Don't re-add chapters to buffer when stopping on error
      } else {
        // Re-add failed chapters to buffer for retry (only if not stopping on error)
        this.buffer.unshift(...batch);
      }
    }
    
    this.processing = false;
  }

  async processAll() {
    if (this.startingChapterNumber === null) {
      await this.initialize();
    }
    
    this.processing = true;
    
    while (this.buffer.length > 0 && !this.stopped) {
      const batch = this.buffer.splice(0, this.batchSize);
      
      try {
        const inserted = await this.insertBatch(batch);
        this.processed += inserted;
        
        if (this.buffer.length > 0) {
          await new Promise(res => setTimeout(res, this.delayBetweenBatches));
        }
      } catch (error) {
        const errorInfo = {
          batchNumber: Math.floor(this.processed / this.batchSize) + 1,
          chapterRange: `${this.processed + 1}-${this.processed + batch.length}`,
          error: error.message,
          timestamp: new Date().toISOString()
        };
        this.errors.push(errorInfo);
        this.failed += batch.length;
        
        console.error(`Stream processing error in batch ${errorInfo.batchNumber}:`, error.message);
        
        if (this.stopOnError) {
          this.stopped = true;
          console.error('Stream processor stopped due to error.');
          break;
        } else {
          await new Promise(res => setTimeout(res, 2000)); // Wait longer on error
        }
      }
    }
    
    // Only update novel timestamp if some chapters were successfully processed
    if (this.processed > 0) {
      await updateTimestamp('novels', 'novel_id', this.novelId);
    }
    
    this.processing = false;
    
    const status = this.stopped && this.errors.length > 0 ? 'FAILED' : 'COMPLETED';
    console.log(`Stream processing ${status}: ${this.processed} chapters processed, ${this.failed} failed, ${this.errors.length} errors`);
    
    return { 
      processed: this.processed, 
      failed: this.failed, 
      errors: this.errors, 
      stopped: this.stopped,
      remaining: this.buffer.length
    };
  }

  async insertBatch(batch) {
    return executeTransaction([
      async (client) => {
        const values = [];
        const params = [];
        let paramIndex = 1;
        
        for (let i = 0; i < batch.length; i++) {
          const chapter = batch[i];
          // Guarantee sequential chapter numbering
          const chapterNumber = this.startingChapterNumber + this.processed + i + 1;
          
          values.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5})`);
          params.push(
            this.novelId,
            chapterNumber,
            chapter.title,
            chapter.content,
            new Date(),
            true
          );
          paramIndex += 6;
        }
        
        const query = `
          INSERT INTO chapters (novel_id, chapter_number, title, content, created_at, is_free)
          VALUES ${values.join(', ')}
          ON CONFLICT (novel_id, chapter_number) DO UPDATE SET
            title = EXCLUDED.title,
            content = EXCLUDED.content,
            updated_at = CURRENT_TIMESTAMP
        `;
        
        const result = await client.query(query, params);
        return result.rowCount;
      }
    ]);
  }

  getStats() {
    return {
      processed: this.processed,
      failed: this.failed,
      errors: this.errors.length,
      buffered: this.buffer.length,
      processing: this.processing,
      stopped: this.stopped
    };
  }

  reset() {
    this.buffer = [];
    this.processed = 0;
    this.failed = 0;
    this.errors = [];
    this.stopped = false;
    this.processing = false;
    this.startingChapterNumber = null;
  }
}

// Enhanced progress tracker with failure tracking
class ProgressTracker {
  constructor(total, name = 'Operation') {
    this.total = total;
    this.name = name;
    this.processed = 0;
    this.failed = 0;
    this.startTime = Date.now();
    this.lastUpdate = 0;
  }

  update(increment = 1, failures = 0) {
    this.processed += increment;
    this.failed += failures;
    const now = Date.now();
    
    // Update every 5 seconds or at completion
    if (now - this.lastUpdate > 5000 || (this.processed + this.failed) >= this.total) {
      const elapsed = now - this.startTime;
      const rate = this.processed / (elapsed / 1000);
      const completed = this.processed + this.failed;
      const progress = (completed / this.total * 100).toFixed(1);
      const eta = this.processed > 0 ? ((this.total - completed) / rate) : 0;
      
      const failureInfo = this.failed > 0 ? ` (${this.failed} failed)` : '';
      console.log(`${this.name}: ${this.processed}/${this.total}${failureInfo} (${progress}%) - ${rate.toFixed(1)}/sec - ETA: ${Math.round(eta)}s`);
      this.lastUpdate = now;
    }
  }

  getStats() {
    return {
      processed: this.processed,
      failed: this.failed,
      total: this.total,
      successRate: this.total > 0 ? (this.processed / this.total * 100).toFixed(1) : 0
    };
  }
}

async function closeDbConnection() {
  try {
    await pool.end();
    console.log("Database connection pool closed.");
  } catch (error) {
    console.error("Error closing database connection pool:", error);
  }
}

function getPoolStats() {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount
  };
}

async function healthCheck() {
  try {
    const result = await executeQuery('SELECT 1 as health');
    return result.rows[0].health === 1;
  } catch (error) {
    console.error("Database health check failed:", error);
    return false;
  }
}

module.exports = {
  // Core functions
  insertNovel,
  insertChapters,
  checkNovelExists,
  updateNovelMetadata,
  getLatestChapterNumber,
  addOrUpdateRating,
  updateNovelRating,
  
  // Advanced processing for large operations
  ChapterStreamProcessor,
  ProgressTracker,
  SerialOperationManager,
  
  // Utilities
  closeDbConnection,
  healthCheck,
  getPoolStats,
  forcePoolCleanup
};