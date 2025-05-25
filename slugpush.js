// 1. Import Xata client
const { getXataClient } = require('./xata');
const xata = getXataClient();

// 2. Slugify function
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

async function updateSlugs() {
  try {
    // Fetch all novels
    const { data: novels, error } = await xata.db.novels.getAll();
    if (error) throw error;

    console.log(`Found ${novels.length} novels.`);

    // Loop through novels
    for (const novel of novels) {
      const slug = slugify(novel.title);

      // Update slug
      await xata.db.novels.update(novel.id, { slug });
      console.log(`Updated novel id=${novel.id}, slug=${slug}`);
    }

    console.log('✅ All slugs updated!');
  } catch (err) {
    console.error('❌ Error updating slugs:', err);
  }
}

// Run the function
updateSlugs();
