// // db-operations.js
// const client = require("./db");

// function slugify(str) {
//   return str
//     .toLowerCase()
//     .normalize('NFD')                 // Normalize accented letters
//     .replace(/[\u0300-\u036f]/g, '')   // Remove accents
//     .replace(/[^a-z0-9\s-]/g, '')      // Remove special characters
//     .trim()
//     .replace(/\s+/g, '-')              // Replace spaces with hyphens
//     .replace(/-+/g, '-');              // Collapse multiple hyphens
// }

// // Function to check if novel exists
// async function checkNovelExists(title, author) {
//   try {
//     const result = await client.query(
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

// // Function to get the latest chapter number for a novel
// async function getLatestChapterNumber(novelId) {
//   try {
//     const result = await client.query(
//       `SELECT MAX(chapter_number) as latest_chapter FROM chapters WHERE novel_id = $1`,
//       [novelId]
//     );
    
//     return result.rows[0].latest_chapter || 0;
//   } catch (error) {
//     console.error("Error getting latest chapter number:", error);
//     return 0;
//   }
// }

// // Function to update timestamps (replaces update_modified_column trigger)
// async function updateTimestamp(tableName, idColumn, idValue) {
//   try {
//     await client.query(
//       `UPDATE ${tableName} SET updated_at = CURRENT_TIMESTAMP WHERE ${idColumn} = $1`,
//       [idValue]
//     );
//   } catch (error) {
//     console.error(`Error updating timestamp for ${tableName}:`, error);
//   }
// }

// // Function to update novel rating (replaces update_novel_rating trigger)
// async function updateNovelRating(novelId) {
//   try {
//     await client.query(
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

// // Function to add or update a rating
// async function addOrUpdateRating(novelId, userId, score, review = null) {
//   try {
//     await client.query('BEGIN');

//     // Insert or update the rating
//     await client.query(
//       `INSERT INTO ratings (novel_id, user_id, score, review)
//        VALUES ($1, $2, $3, $4)
//        ON CONFLICT (novel_id, user_id) 
//        DO UPDATE SET 
//          score = $3,
//          review = $4,
//          updated_at = CURRENT_TIMESTAMP`,
//       [novelId, userId, score, review]
//     );

//     // Update the novel's average rating
//     await updateNovelRating(novelId);

//     await client.query('COMMIT');
//     return true;
//   } catch (error) {
//     await client.query('ROLLBACK');
//     console.error("Error adding/updating rating:", error);
//     return false;
//   }
// }

// // Function to update novel metadata
// async function updateNovelMetadata(novelId, novel) {
//   try {
//     await client.query('BEGIN');
    
//     // Update novel basic info
//     await client.query(
//       `UPDATE novels SET 
//         description = $1, 
//         cover_image_url = $2, 
//         status = $3
//       WHERE novel_id = $4`,
//       [
//         novel.description,
//         novel.cover_image_url,
//         novel.status.toLowerCase(),
//         novelId
//       ]
//     );
    
//     // Update timestamp
//     await updateTimestamp('novels', 'novel_id', novelId);
    
//     // Update genres - First remove existing
//     if (novel.genres && novel.genres.length > 0) {
//       // Clear existing genres
//       await client.query(
//         `DELETE FROM novel_genres WHERE novel_id = $1`,
//         [novelId]
//       );
      
//       // Add new genres
//       for (const genreName of novel.genres) {
//         // Insert genre if it doesn't exist
//         await client.query(
//           `INSERT INTO genres (name) 
//            VALUES ($1) 
//            ON CONFLICT (name) DO NOTHING`,
//           [genreName]
//         );
        
//         // Get genre_id
//         const genreResult = await client.query(
//           `SELECT genre_id FROM genres WHERE name = $1`,
//           [genreName]
//         );
        
//         // Link novel to genre
//         if (genreResult.rows.length > 0) {
//           await client.query(
//             `INSERT INTO novel_genres (novel_id, genre_id)
//              VALUES ($1, $2)
//              ON CONFLICT DO NOTHING`,
//             [novelId, genreResult.rows[0].genre_id]
//           );
//         }
//       }
//     }
    
//     // Update tags - First remove existing
//     if (novel.tags && novel.tags.length > 0) {
//       // Clear existing tags
//       await client.query(
//         `DELETE FROM novel_tags WHERE novel_id = $1`,
//         [novelId]
//       );
      
//       // Add new tags
//       for (const tagName of novel.tags) {
//         // Insert tag if it doesn't exist
//         await client.query(
//           `INSERT INTO tags (name) 
//            VALUES ($1) 
//            ON CONFLICT (name) DO NOTHING`,
//           [tagName]
//         );
        
//         // Get tag_id
//         const tagResult = await client.query(
//           `SELECT tag_id FROM tags WHERE name = $1`,
//           [tagName]
//         );
        
//         // Link novel to tag
//         if (tagResult.rows.length > 0) {
//           await client.query(
//             `INSERT INTO novel_tags (novel_id, tag_id)
//              VALUES ($1, $2)
//              ON CONFLICT DO NOTHING`,
//             [novelId, tagResult.rows[0].tag_id]
//           );
//         }
//       }
//     }
    
//     await client.query('COMMIT');
//     console.log(`Novel metadata updated for ID: ${novelId}`);
//     return true;
//   } catch (error) {
//     await client.query('ROLLBACK');
//     console.error("Error updating novel metadata:", error);
//     return false;
//   }
// }

// // Function to insert novel data
// async function insertNovel(novel) {
//   try {
//     // Check if novel already exists
//     const existingNovel = await checkNovelExists(novel.title, novel.author);
//     if (existingNovel) {
//       // Update metadata if novel exists
//       await updateNovelMetadata(existingNovel.novel_id, novel);
//       return existingNovel.novel_id;
//     }
    
//     // If novel doesn't exist, insert it
//     // Begin transaction
//     await client.query('BEGIN');
    
//     // 1. Insert the novel
//     const novelResult = await client.query(
//       `INSERT INTO novels (
//         title, 
//         author, 
//         description, 
//         cover_image_url, 
//         status,
//         slug
//       ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING novel_id`,
//       [
//         novel.title,
//         novel.author,
//         novel.description,
//         novel.cover_image_url,
//         novel.status.toLowerCase(), // Convert to lowercase to match CHECK constraint
//         slugify(novel.title),
//       ]
//     );
    
//     const novelId = novelResult.rows[0].novel_id;
    
//     // 2. Process genres
//     if (novel.genres && novel.genres.length > 0) {
//       for (const genreName of novel.genres) {
//         // Insert genre if it doesn't exist
//         await client.query(
//           `INSERT INTO genres (name) 
//            VALUES ($1) 
//            ON CONFLICT (name) DO NOTHING`,
//           [genreName]
//         );
        
//         // Get genre_id
//         const genreResult = await client.query(
//           `SELECT genre_id FROM genres WHERE name = $1`,
//           [genreName]
//         );
        
//         // Link novel to genre
//         if (genreResult.rows.length > 0) {
//           await client.query(
//             `INSERT INTO novel_genres (novel_id, genre_id)
//              VALUES ($1, $2)
//              ON CONFLICT DO NOTHING`,
//             [novelId, genreResult.rows[0].genre_id]
//           );
//         }
//       }
//     }

//     // 3. Process tags separately
//     if (novel.tags && novel.tags.length > 0) {
//       for (const tagName of novel.tags) {
//         // Insert tag if it doesn't exist
//         await client.query(
//           `INSERT INTO tags (name) 
//            VALUES ($1) 
//            ON CONFLICT (name) DO NOTHING`,
//           [tagName]
//         );
        
//         // Get tag_id
//         const tagResult = await client.query(
//           `SELECT tag_id FROM tags WHERE name = $1`,
//           [tagName]
//         );
        
//         // Link novel to tag
//         if (tagResult.rows.length > 0) {
//           await client.query(
//             `INSERT INTO novel_tags (novel_id, tag_id)
//              VALUES ($1, $2)
//              ON CONFLICT DO NOTHING`,
//             [novelId, tagResult.rows[0].tag_id]
//           );
//         }
//       }
//     }
    
//     // Commit transaction
//     await client.query('COMMIT');
    
//     console.log(`Novel inserted with ID: ${novelId}`);
//     return novelId;
//   } catch (error) {
//     // Rollback transaction in case of error
//     await client.query('ROLLBACK');
//     console.error("Error inserting novel:", error);
//     return null;
//   }
// }

// // Function to insert chapter data
// async function insertChapters(novelId, chapters) {
//   try {
//     // Get the latest chapter number for this novel
//     const latestChapterNumber = await getLatestChapterNumber(novelId);
//     console.log(`Current latest chapter: ${latestChapterNumber}`);
    
//     // Begin transaction
//     await client.query('BEGIN');
    
//     let newChaptersCount = 0;
    
//     for (let i = 0; i < chapters.length; i++) {
//       const chapter = chapters[i];
//       const chapterNumber = latestChapterNumber + i + 1;
      
//       // Check if this chapter already exists
//       const chapterExists = await client.query(
//         `SELECT chapter_id FROM chapters WHERE novel_id = $1 AND chapter_number = $2`,
//         [novelId, chapterNumber]
//       );
      
//       if (chapterExists.rows.length > 0) {
//         console.log(`Chapter ${chapterNumber} already exists. Skipping.`);
//         continue;
//       }
      
//       await client.query(
//         `INSERT INTO chapters (
//           novel_id, 
//           chapter_number, 
//           title, 
//           content, 
//           created_at,
//           is_free
//         ) VALUES ($1, $2, $3, $4, $5, $6)`,
//         [
//           novelId, 
//           chapterNumber, 
//           chapter.title, 
//           chapter.content, 
//           new Date(),
//           true // Assuming all scraped chapters are free
//         ]
//       );
      
//       newChaptersCount++;
//       console.log(`Chapter ${chapterNumber} inserted.`);
//     }
    
//     // Update the novel's updated_at timestamp
//     await updateTimestamp('novels', 'novel_id', novelId);
    
//     // Commit transaction
//     await client.query('COMMIT');
    
//     console.log(`${newChaptersCount} new chapters inserted successfully.`);
//     return newChaptersCount;
//   } catch (error) {
//     // Rollback transaction in case of error
//     await client.query('ROLLBACK');
//     console.error("Error inserting chapters:", error);
//     return 0;
//   }
// }

// // Close the database connection function
// async function closeDbConnection() {
//   await client.end();
//   console.log("Database connection closed.");
// }

// // Export the functions
// module.exports = {
//   insertNovel,
//   insertChapters,
//   checkNovelExists,
//   updateNovelMetadata,
//   getLatestChapterNumber,
//   closeDbConnection,
//   addOrUpdateRating,
//   updateNovelRating
// };


// db-operations.js
const { Client } = require("pg");

// Database configuration
const dbConfig = {
  connectionString: "postgresql://ntm0uo:xau_WRxpN60kT7cEqyx22FLMcH7tp7vkmwDr0@us-east-1.sql.xata.sh/webnovelvault:main?sslmode=require",
  ssl: {
    rejectUnauthorized: false,
  },
};

// Maximum number of retries for database operations
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

// Helper function to wait between retries
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to create a new client
async function createClient() {
  const client = new Client(dbConfig);
  await client.connect();
  return client;
}

// Helper function to execute query with a fresh connection
async function executeQuery(query, params = []) {
  let client = null;
  let retries = 0;
  
  while (retries < MAX_RETRIES) {
    try {
      client = await createClient();
      const result = await client.query(query, params);
      await client.end();
      return result;
    } catch (error) {
      if (client) {
        try {
          await client.end();
        } catch (endError) {
          console.error("Error closing client:", endError);
        }
      }
      
      retries++;
      if (retries === MAX_RETRIES) {
        throw error;
      }
      console.log(`Query failed. Retrying... (${retries}/${MAX_RETRIES})`);
      await wait(RETRY_DELAY);
    }
  }
}

// Helper function to execute transaction with a fresh connection
async function executeTransaction(callback) {
  let client = null;
  let retries = 0;
  
  while (retries < MAX_RETRIES) {
    try {
      client = await createClient();
      await client.query('BEGIN');
      
      const result = await callback(client);
      
      await client.query('COMMIT');
      await client.end();
      return result;
    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
          await client.end();
        } catch (endError) {
          console.error("Error rolling back transaction:", endError);
        }
      }
      
      retries++;
      if (retries === MAX_RETRIES) {
        throw error;
      }
      console.log(`Transaction failed. Retrying... (${retries}/${MAX_RETRIES})`);
      await wait(RETRY_DELAY);
    }
  }
}

function slugify(str) {
  return str
    .toLowerCase()
    .normalize('NFD')                 // Normalize accented letters
    .replace(/[\u0300-\u036f]/g, '')   // Remove accents
    .replace(/[^a-z0-9\s-]/g, '')      // Remove special characters
    .trim()
    .replace(/\s+/g, '-')              // Replace spaces with hyphens
    .replace(/-+/g, '-');              // Collapse multiple hyphens
}

// Function to check if novel exists
async function checkNovelExists(title, author) {
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
    return null;
  }
}

// Function to get the latest chapter number for a novel
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

// Function to update timestamps
async function updateTimestamp(tableName, idColumn, idValue) {
  try {
    await executeQuery(
      `UPDATE ${tableName} SET updated_at = CURRENT_TIMESTAMP WHERE ${idColumn} = $1`,
      [idValue]
    );
  } catch (error) {
    console.error(`Error updating timestamp for ${tableName}:`, error);
  }
}

// Function to update novel rating
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

// Function to add or update a rating
async function addOrUpdateRating(novelId, userId, score, review = null) {
  return executeTransaction(async (client) => {
    // Insert or update the rating
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

    // Update the novel's average rating
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

// Function to update novel metadata
async function updateNovelMetadata(novelId, novel) {
  return executeTransaction(async (client) => {
    // Update novel basic info
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
    
    // Update timestamp
    await client.query(
      `UPDATE novels SET updated_at = CURRENT_TIMESTAMP WHERE novel_id = $1`,
      [novelId]
    );
    
    // Update genres
    if (novel.genres && novel.genres.length > 0) {
      await client.query(
        `DELETE FROM novel_genres WHERE novel_id = $1`,
        [novelId]
      );
      
      for (const genreName of novel.genres) {
        await client.query(
          `INSERT INTO genres (name) 
           VALUES ($1) 
           ON CONFLICT (name) DO NOTHING`,
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
    
    // Update tags
    if (novel.tags && novel.tags.length > 0) {
      await client.query(
        `DELETE FROM novel_tags WHERE novel_id = $1`,
        [novelId]
      );
      
      for (const tagName of novel.tags) {
        await client.query(
          `INSERT INTO tags (name) 
           VALUES ($1) 
           ON CONFLICT (name) DO NOTHING`,
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
    
    console.log(`Novel metadata updated for ID: ${novelId}`);
    return true;
  });
}

// Function to insert novel data
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
        novel.status.toLowerCase(),
        slugify(novel.title),
      ]
    );
    
    const novelId = novelResult.rows[0].novel_id;
    
    // Process genres
    if (novel.genres && novel.genres.length > 0) {
      for (const genreName of novel.genres) {
        await client.query(
          `INSERT INTO genres (name) 
           VALUES ($1) 
           ON CONFLICT (name) DO NOTHING`,
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

    // Process tags
    if (novel.tags && novel.tags.length > 0) {
      for (const tagName of novel.tags) {
        await client.query(
          `INSERT INTO tags (name) 
           VALUES ($1) 
           ON CONFLICT (name) DO NOTHING`,
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
    
    console.log(`Novel inserted with ID: ${novelId}`);
    return novelId;
  });
}

// Function to insert chapter data
async function insertChapters(novelId, chapters) {
  return executeTransaction(async (client) => {
    // Get the latest chapter number for this novel
    const latestChapterNumber = await getLatestChapterNumber(novelId);
    console.log(`Current latest chapter: ${latestChapterNumber}`);
    
    let newChaptersCount = 0;
    
    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];
      const chapterNumber = latestChapterNumber + i + 1;
      
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
          chapter.title, 
          chapter.content, 
          new Date(),
          true
        ]
      );
      
      newChaptersCount++;
      console.log(`Chapter ${chapterNumber} inserted.`);
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

// Export the functions
module.exports = {
  insertNovel,
  insertChapters,
  checkNovelExists,
  updateNovelMetadata,
  getLatestChapterNumber,
  addOrUpdateRating,
  updateNovelRating
};
