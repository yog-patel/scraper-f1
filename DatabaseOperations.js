// Xata SDK setup
const { getXataClient } = require('./xata');
const xata = getXataClient();

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
          await new Promise(r => setTimeout(r, 200));
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

// Optimized novel existence check with caching
const novelCache = new Map();

async function checkNovelExists(title, author) {
  const cacheKey = `${title}|${author}`;
  if (novelCache.has(cacheKey)) return novelCache.get(cacheKey);

  const novel = await xata.db.novels
    .filter({ title, author })
    .select(['xata_id', 'title', 'author'])
    .getFirst();

  novelCache.set(cacheKey, novel);
  if (novel) {
    console.log(`Novel "${title}" by ${author} already exists with ID: ${novel.xata_id}`);
  }
  return novel;
}

async function getLatestChapterNumber(novelId) {
  const chapters = await xata.db.chapters
    .filter({ novel_id: novelId })
    .sort('chapter_number', 'desc')
    .select(['chapter_number'])
    .getFirst();
  return chapters?.chapter_number || 0;
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
  // Check if novel already exists
  const existingNovel = await checkNovelExists(novel.title, novel.author);
  if (existingNovel) {
    await updateNovelMetadata(existingNovel.xata_id, novel);
    return existingNovel.xata_id;
  }

  // Insert the novel
  const inserted = await xata.db.novels.create({
    title: novel.title,
    author: novel.author,
    description: novel.description,
    cover_image_url: novel.cover_image_url,
    slug: slugify(novel.title),
    status: novel.status?.toLowerCase() || 'ongoing',
    average_rating: 0,
    view_count: 0,
    is_featured: false,
    language: novel.language || 'en'
  });

  const novelId = inserted.xata_id;

  // Process genres in batch
  if (novel.genres && novel.genres.length > 0) {
    await processGenres(novelId, novel.genres);
  }
  // Process tags in batch
  if (novel.tags && novel.tags.length > 0) {
    await processTags(novelId, novel.tags);
  }
  console.log(`Novel inserted with ID: ${novelId}`);
  return novelId;
}

// Optimized genre processing
async function processGenres(novelId, genres) {
  // Insert all genres if not exist
  for (const name of genres) {
    // await xata.db.genres.createOrUpdate({ name }, ['name']);
        try {
      await xata.db.genres.create({ name });
    } catch (err) {
      if (!err.message.includes('is not unique')) throw err;
      // Ignore duplicate error
    }
  }
  // Get all genre IDs
  const genreRows = await xata.db.genres.filter({ name: { $any: genres } }).getAll();
  // Insert novel-genre relationships
  for (const genre of genreRows) {
    await xata.db.novel_genres.createOrUpdate({
      novel_id: novelId,
      genre_id: genre.xata_id
    }, ['novel_id', 'genre_id']);
  }
}

// Optimized tag processing
async function processTags(novelId, tags) {
  for (const name of tags) {
    // await xata.db.tags.createOrUpdate({ name }, ['name']);
    try {
      await xata.db.tags.create({ name });
    } catch (err) {
      if (!err.message.includes('is not unique')) throw err;
      // Ignore duplicate error
    }
  }
  const tagRows = await xata.db.tags.filter({ name: { $any: tags } }).getAll();
  for (const tag of tagRows) {
    await xata.db.novel_tags.createOrUpdate({
      novel_id: novelId,
      tag_id: tag.xata_id
    }, ['novel_id', 'tag_id']);
  }
}

// Batch chapter insertion with conflict handling
async function insertChapters(novelId, chapters) {
  const latestChapterNumber = await getLatestChapterNumber(novelId);
  console.log(`Current latest chapter: ${latestChapterNumber}`);
  let newChaptersCount = 0;
  const batchSize = 1;

  for (let i = 0; i < chapters.length; i += batchSize) {
    const batch = chapters.slice(i, i + batchSize);
    for (let j = 0; j < batch.length; j++) {
      const chapter = batch[j];
      const chapterNumber = latestChapterNumber + i + j + 1;

      // Check if this chapter already exists
      const exists = await xata.db.chapters
        .filter({ novel_id: novelId, chapter_number: chapterNumber })
        .getFirst();
      if (exists) {
        console.log(`Chapter ${chapterNumber} already exists. Skipping.`);
        continue;
      }

      // Safeguard: Only use title/content if they're valid strings
      let chapterTitle = (typeof chapter.title === "string" && chapter.title.trim()) ? chapter.title.trim().substring(0, 500) : null;
      let chapterContent = (typeof chapter.content === "string" && chapter.content.trim()) ? chapter.content.trim().substring(0, 100000) : null;

      if (!chapterContent) {
        console.warn(`⚠️ Skipping chapter ${chapterNumber}: content is missing or empty.`, chapter);
        continue;
      }

      await xata.db.chapters.create({
        novel_id: novelId,
        chapter_number: chapterNumber,
        title: chapterTitle,
        content: chapterContent,
        is_free: true,
        view_count: 0
      });
      newChaptersCount++;
      console.log(`Chapter ${chapterNumber} inserted.`);
    }
    if (i + batchSize < chapters.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  // No need to update updated_at, Xata does this automatically
  console.log(`${newChaptersCount} new chapters inserted successfully.`);
  return newChaptersCount;
}

// Enhanced novel metadata update
async function updateNovelMetadata(novelId, novel) {
  await xata.db.novels.update(novelId, {
    description: novel.description,
    cover_image_url: novel.cover_image_url,
    status: novel.status?.toLowerCase() || 'ongoing'
  });
  // Update genres
  if (novel.genres && novel.genres.length > 0) {
    // Remove existing
    const existing = await xata.db.novel_genres.filter({ novel_id: novelId }).getMany();
    for (const rel of existing) {
      await xata.db.novel_genres.delete(rel.xata_id);
    }
    await processGenres(novelId, novel.genres);
  }
  // Update tags
  if (novel.tags && novel.tags.length > 0) {
    const existing = await xata.db.novel_tags.filter({ novel_id: novelId }).getMany();
    for (const rel of existing) {
      await xata.db.novel_tags.delete(rel.xata_id);
    }
    await processTags(novelId, novel.tags);
  }
  console.log(`Novel metadata updated for ID: ${novelId}`);
  return true;
}

// Rating functions
async function addOrUpdateRating(novelId, userId, score, review = null) {
  // Upsert rating
  const existing = await xata.db.ratings
    .filter({ novel_id: novelId, user_id: userId })
    .getFirst();
  if (existing) {
    await xata.db.ratings.update(existing.xata_id, {
      score,
      review
    });
  } else {
    await xata.db.ratings.create({
      novel_id: novelId,
      user_id: userId,
      score,
      review
    });
  }
  await updateNovelRating(novelId);
  return true;
}

async function updateNovelRating(novelId) {
  // Calculate average rating
  const ratings = await xata.db.ratings.filter({ novel_id: novelId }).getMany();
  const avg = ratings.length
    ? Math.round(ratings.reduce((sum, r) => sum + (r.score || 0), 0) / ratings.length)
    : 0;
  await xata.db.novels.update(novelId, { average_rating: avg });
}

// No-op for Xata
async function closeDbConnection() {
  // No connection to close for Xata
  return;
}

// Health check function
async function healthCheck() {
  try {
    await xata.db.novels.getFirst();
    return true;
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
  batchProcessor
};
