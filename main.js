require('dotenv').config();
// main.js - Synchronized with DatabaseOperations.js
const { launchBrowser } = require("./browser");
const { scrapeNovelDetails, scrapeChapters } = require("./scraper");
const { 
  insertNovel, 
  insertChapters, 
  getLatestChapterNumber,
  healthCheck,
  closeDbConnection,
  checkNovelExists,
  batchProcessor
} = require("./DatabaseOperations");
const fs = require('fs');
const path = require('path');

// Read URLs from a file and split into batches
function getBatchUrls(batchIndex, batchSize = 50) { // Changed default from 1 to 50
    const urlsPath = path.join(__dirname, 'urls.txt');
    const allUrls = fs.readFileSync(urlsPath, 'utf-8')
        .split('\n')
        .map(line => line.trim())
        .filter(line =>
            line &&
            !line.startsWith('//') &&
            !line.startsWith('#')
        )
        .map(line => {
            // Remove leading/trailing quotes and trailing commas
            let url = line.replace(/^['"]+|['",]+$/g, '').trim();
            return url;
        })
        .filter(url => url.startsWith('http'));
    const start = batchIndex * batchSize;
    const end = start + batchSize;
    return allUrls.slice(start, end);
}

// Progress tracking utility
function logProgress(current, total, operation) {
  const percentage = ((current / total) * 100).toFixed(2);
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${operation}: ${current}/${total} (${percentage}%)`);
}

// Enhanced monitoring that works with the actual DatabaseOperations
function startDatabaseMonitoring() {
  const monitor = setInterval(async () => {
    try {
      const isHealthy = await healthCheck();
      if (!isHealthy) {
        console.log('⚠️ Database health check failed - connection issues detected');
      }
    } catch (error) {
      console.log('⚠️ Database monitoring error:', error.message);
    }
  }, 30000); // Every 30 seconds
  
  return monitor;
}

// Timeout wrapper for operations
async function withTimeout(promise, timeoutMs = 60000, operationName = 'Operation') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)), timeoutMs)
        )
    ]);
}

// Wait utility
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Enhanced novel processing function
async function processNovel(url, page) {
    console.log(`🔍 Processing novel from URL: ${url}`);
    
    try {
        // Increase navigation timeout to 60 seconds
        await page.goto(url, { 
            waitUntil: "networkidle2",
            timeout: 60000 // was 30000
        });

        // Scrape novel details
        console.log('📚 Scraping novel details...');
        const novelData = await scrapeNovelDetails(page);
        
        if (!novelData.title || !novelData.author) {
            console.log("❌ Missing essential novel data (title or author). Skipping.");
            return { status: 'skipped', reason: 'missing_data' };
        }

        console.log("📖 Novel information:", {
            title: novelData.title,
            author: novelData.author,
            chapters: novelData.numOfCh || novelData.chapters,
            status: novelData.status,
            genres: novelData.genres?.length || 0,
            tags: novelData.tags?.length || 0
        });

        // Check if novel already exists
        console.log('🔍 Checking if novel exists...');
        const existingNovel = await withTimeout(
            checkNovelExists(novelData.title, novelData.author),
            30000,
            'Novel existence check'
        );

        let novelId;
        
        if (existingNovel) {
            console.log(`✅ Novel already exists with ID: ${existingNovel.xata_id}`);
            novelId = existingNovel.xata_id;
        } else {
            // Insert new novel
            console.log('💾 Inserting new novel into database...');
            try {
                novelId = await withTimeout(
                    insertNovel({
                        title: novelData.title,
                        author: novelData.author,
                        description: novelData.synopsis,
                        cover_image_url: novelData.imageLink,
                        tags: novelData.tags,
                        genres: novelData.genres,
                        status: novelData.status,
                    }),
                    60000,
                    'Novel insertion'
                );
                console.log(`✅ Novel inserted with ID: ${novelId}`);
            } catch (insertError) {
                console.error(`❌ Failed to insert novel: ${insertError.message}`);
                return { status: 'failed', reason: 'insertion_failed', error: insertError.message };
            }
        }

        // Get latest chapter number from database
        console.log('🔢 Checking existing chapters in database...');
        const latestChapterNumber = await withTimeout(
            getLatestChapterNumber(novelId),
            30000,
            'Getting latest chapter number'
        );

        const totalChapters = novelData.numOfCh || parseInt(novelData.chapters) || 0;
        
        console.log(`📊 Chapter Status:
          - Current chapters in database: ${latestChapterNumber}
          - Total chapters on site: ${totalChapters}`);

        if (latestChapterNumber >= totalChapters || totalChapters === 0) {
            console.log("✅ Novel is already up to date or no chapters found.");
            return { 
                status: 'completed', 
                novelId, 
                newChapters: 0,
                reason: 'up_to_date'
            };
        }

        // Calculate chapters to scrape, but limit to 50 at most
        const chaptersToScrape = Math.min(totalChapters - latestChapterNumber, 500);
        console.log(`📝 Need to scrape ${chaptersToScrape} new chapters (max 500 per run).`);

        // Scrape new chapters (limit to 50)
        console.log('🕷️ Starting chapter scraping...');
        // Pass the correct end chapter number: latestChapterNumber + chaptersToScrape
        const scrapedChapters = await scrapeChapters(
            page, 
            latestChapterNumber + chaptersToScrape, // End at latest + 50 max
            latestChapterNumber // Start from latest
        );
        console.log(`📚 Successfully scraped ${scrapedChapters.length} chapters`);

        // Insert chapters into database
        let insertedChapters = 0;
        if (scrapedChapters.length > 0) {
            console.log('💾 Storing chapters in database...');
            try {
                insertedChapters = await withTimeout(
                    insertChapters(novelId, scrapedChapters),
                    600000, // 10 minute timeout for chapter insertion
                    'Chapter insertion'
                );
                console.log(`✅ Successfully stored ${insertedChapters} chapters`);
            } catch (chapterError) {
                console.error(`❌ Failed to insert chapters: ${chapterError.message}`);
                return { 
                    status: 'partial_success', 
                    novelId, 
                    newChapters: 0,
                    error: chapterError.message 
                };
            }
        }

        return { 
            status: 'completed', 
            novelId, 
            newChapters: insertedChapters,
            title: novelData.title 
        };

    } catch (error) {
        console.error(`❌ Error processing novel from ${url}:`, error.message);
        return { status: 'failed', error: error.message };
    }
}

// Main execution function
async function main() {
    // Fix parameter parsing
    const batchIndex = parseInt(process.argv[2] || '0'); // Remove the second parameter from parseInt
    const batchSize = parseInt(process.argv[3] || '50'); // Default to 50 if not specified
    
    console.log(`Processing batch index: ${batchIndex}, size: ${batchSize}`);
    
    const urls = getBatchUrls(batchIndex, batchSize);
    
    console.log(`🚀 Starting batch ${batchIndex} with ${urls.length} URLs (batch size: ${batchSize})`);

    if (urls.length === 0) {
        console.log("❌ No URLs to process in this batch.");
        return;
    }

    // Perform initial health check
    console.log('🏥 Performing initial database health check...');
    try {
        const isHealthy = await withTimeout(healthCheck(), 30000, 'Health check');
        if (!isHealthy) {
            console.error('❌ Database health check failed. Exiting...');
            process.exit(1);
        }
        console.log('✅ Database is healthy, proceeding with scraping...');
    } catch (error) {
        console.error('❌ Database health check failed:', error.message);
        process.exit(1);
    }

    // Start database monitoring
    const monitor = startDatabaseMonitoring();

    // Launch browser
    console.log('🌐 Launching browser...');
    const browser = await launchBrowser();

    // Statistics tracking
    const stats = {
        total: urls.length,
        completed: 0,
        failed: 0,
        skipped: 0,
        totalChapters: 0,
        startTime: Date.now()
    };

    try {
        // Process each URL
        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            logProgress(i + 1, urls.length, '🎯 Processing novels');
            
            console.log(`\n${'='.repeat(80)}`);
            console.log(`📖 Novel ${i + 1}/${urls.length}: ${url}`);
            console.log(`${'='.repeat(80)}`);

            const page = await browser.newPage();

            try {
                // Set up the page
                await page.setUserAgent(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                );
                await page.setDefaultTimeout(60000); // was 30000

                // Process the novel
                const result = await processNovel(url, page);

                // Update statistics
                switch (result.status) {
                    case 'completed':
                    case 'partial_success':
                        stats.completed++;
                        stats.totalChapters += result.newChapters || 0;
                        console.log(`🎉 SUCCESS: ${result.title || 'Novel'} processed (${result.newChapters || 0} new chapters)`);
                        break;
                    case 'failed':
                        stats.failed++;
                        console.log(`❌ FAILED: ${result.error || 'Unknown error'}`);
                        break;
                    case 'skipped':
                        stats.skipped++;
                        console.log(`⏭️ SKIPPED: ${result.reason || 'Unknown reason'}`);
                        break;
                }

            } catch (error) {
                stats.failed++;
                console.error(`💥 Unexpected error processing ${url}:`, error.message);
            } finally {
                // Always close the page
                try {
                    await page.close();
                } catch (closeError) {
                    console.error('Error closing page:', closeError.message);
                }

                // Add delay between novels to be respectful
                if (i < urls.length - 1) {
                    console.log('⏳ Waiting before next novel...');
                    await wait(2000); // 2 second delay
                }
            }
        }

    } catch (error) {
        console.error("💥 Critical error during scraping process:", error.message);
    } finally {
        // Stop monitoring
        if (monitor) {
            clearInterval(monitor);
            console.log('📊 Database monitoring stopped');
        }

        // Close browser
        console.log('🌐 Closing browser...');
        try {
            await browser.close();
        } catch (browserError) {
            console.error('Error closing browser:', browserError.message);
        }
        
        // Close database connections
        console.log('💾 Closing database connections...');
        try {
            await closeDbConnection();
        } catch (dbError) {
            console.error('Error closing database connections:', dbError.message);
        }
        
        // Final statistics
        const totalTime = Date.now() - stats.startTime;
        const successRate = ((stats.completed / stats.total) * 100).toFixed(1);
        
        console.log(`\n${'='.repeat(80)}`);
        console.log('📈 FINAL STATISTICS');
        console.log(`${'='.repeat(80)}`);
        console.log(`📊 Total novels processed: ${stats.total}`);
        console.log(`✅ Successfully completed: ${stats.completed}`);
        console.log(`❌ Failed: ${stats.failed}`);
        console.log(`⏭️ Skipped: ${stats.skipped}`);
        console.log(`📚 Total new chapters added: ${stats.totalChapters}`);
        console.log(`📈 Success rate: ${successRate}%`);
        console.log(`⏱️ Total time: ${Math.round(totalTime / 1000 / 60)} minutes`);
        console.log(`⚡ Average time per novel: ${Math.round(totalTime / stats.total / 1000)} seconds`);
        console.log(`${'='.repeat(80)}`);
        
        console.log("🏁 Scraping process completed successfully");
    }
}

// Graceful shutdown handlers
process.on('SIGINT', async () => {
    console.log('\n🛑 Received SIGINT. Shutting down gracefully...');
    await closeDbConnection();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM. Shutting down gracefully...');
    await closeDbConnection();
    process.exit(0);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    await closeDbConnection();
    process.exit(1);
});

process.on('uncaughtException', async (error) => {
    console.error('💥 Uncaught Exception:', error);
    await closeDbConnection();
    process.exit(1);
});

// Execute the main function
main().catch(async (error) => {
    console.error('💥 Unhandled error in main:', error);
    await closeDbConnection();
    process.exit(1);
});
