/**
 * Extracts novel details from the page
 * @param {Page} page - Puppeteer page instance
 * @returns {Promise<Object>} Novel details
 */
async function scrapeNovelDetails(page) {
    // Extract basic book details
    const bookInfo = await page.evaluate(() => {
        return {
            title: document.querySelector("title")?.innerText.split("|")[0].trim(),
            url: document.querySelector('link[rel="canonical"]')?.href,
        };
    });
  
    // Extract structured book info
    const newBookInfo = await page.evaluate(() => {
        const scriptTag = document.querySelector('script[type="application/ld+json"]');
        if (scriptTag) {
            return JSON.parse(scriptTag.innerText);
        }
        return null;
    });
  
    // Extract book tags, synopsis, status
    const tagsAndGenres = await page.evaluate(() => {
        return Array.from(document.querySelectorAll(".collection-item-4 a")).map(tag => tag.innerText.trim());
    });
  
    // Separate genres and tags
    const genres = [];
    const tags = [];
    
    for (const item of tagsAndGenres) {
        // Skip items that start with '#\n'
        if (item.includes('#\\n')) {
            continue;
        }
        // If the item starts with '#', it's a tag
        else if (item.startsWith('#')) {
            // Clean the tag by removing '#' character
            const cleanTag = item.replace(/#/g, '').trim();
            tags.push(cleanTag);
        } else {
            genres.push(item);
        }
    }
  
    const synopsis = await page.evaluate(() => {
        const synopsisElement = document.querySelector(".synopsissection .synopsis");
        return synopsisElement ? synopsisElement.innerText.trim() : "No synopsis found";
    });
  
    const status = await page.evaluate(() => {
        const statusElement = document.querySelector(".novelstatustextlarge");
        if (!statusElement) {
            // Try alternative selectors if the primary one fails
            const altStatusElement = document.querySelector(".novelstatustextmedium");
            if (altStatusElement) {
                return altStatusElement.innerText.trim().toLowerCase();
            }
            return "ongoing"; // Default to ongoing if no status found
        }
        return statusElement.innerText.trim().toLowerCase();
    });
  
    // Extract book image and chapter count
    const imageLink = await page.evaluate(() => {
        return document.querySelector("img.novel-image").src;
    });
  
    // Try to get chapter count from DOM elements
    const domChapterCount = await page.evaluate(() => {
      let el = document.getElementById("chapter-count");
      if (!el) {
          el = document.getElementById("chapter-count2");
      }
      if (el) {
          const text = el.innerText.trim();
          const parsed = parseInt(text);
          return isNaN(parsed) ? 0 : parsed;
      }
      return 0;
    });
  
    // Get chapters from JSON-LD data
    const jsonChapterCount = newBookInfo?.numberOfChapters ? parseInt(newBookInfo.numberOfChapters) : 0;
    
    // Use the larger value or fallback to one if both are zero
    const numOfCh = Math.max(domChapterCount, jsonChapterCount) || 0;
  
    // Combine all info
    return {
        title: bookInfo.title,
        author: newBookInfo?.author,
        chapters: jsonChapterCount,
        numOfCh: numOfCh,
        status: status,
        coverImage: newBookInfo?.image,
        imageLink: imageLink,
        tags: tags,
        genres: genres,
        synopsis: synopsis,
    };
  }

/**
* Navigate to the chapters list and click on specific chapter
* @param {Page} page - Puppeteer page instance
* @param {number} startFromChapter - Chapter number to start from (0 for first chapter)
*/
async function navigateToChapter(page, startFromChapter = 0) {
  try {
    // Click the chapter listing button
    await page.waitForSelector('#chapter-listing', { timeout: 5000 });
    await page.evaluate(() => {
      const button = document.getElementById('chapter-listing');
      if (button) button.click();
    });
    
    // Wait for chapter list to load
    await page.waitForSelector('.chapter-item h3', { timeout: 5000 });
    
    // Click the target chapter
    await page.evaluate((startIndex) => {
      const chapters = document.querySelectorAll('.chapter-item h3');
      const targetIndex = startIndex > 0 ? startIndex : 0;
      if (chapters[targetIndex]) {
        chapters[targetIndex].click();
      }
    }, startFromChapter);

    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 });
    return true;
  } catch (error) {
    console.error('Navigation error:', error.message);
    return false;
  }
}

/**
* Scrapes a single chapter content
* @param {Page} page - Puppeteer page instance
* @returns {Promise<Object>} Chapter title and content
*/
async function scrapeChapterContent(page) {
  try {
    await page.waitForSelector('.ct-span p', { timeout: 5000 });
    
    return await page.evaluate(() => {
      const titleElement = document.querySelector('h1') || document.querySelector('.chapter-title');
      const title = titleElement ? titleElement.innerText.trim() : 'Untitled Chapter';
      
      const paragraphs = Array.from(document.querySelectorAll('.ct-span p'))
        .map(p => p.innerText.trim())
        .filter(text => text.length > 0);
        
      return { 
        title: title,
        content: paragraphs.join('\n\n')
      };
    });
  } catch (error) {
    console.error('Content scraping error:', error.message);
    return null;
  }
}

async function navigateToNextChapter(page) {
  try {
    await page.waitForSelector('#next-top', { timeout: 5000 });
    
    await Promise.all([
      page.click('#next-top'),
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 })
    ]);
    
    return true;
  } catch (error) {
    console.error('Next chapter navigation error:', error.message);
    return false;
  }
}

async function getChapterLinks(page) {
  const maxAttempts = 3;
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Wait for the chapter list button with better selector
      const chapterBtn = await page.waitForSelector('#chapter-listing, .chapter-list-button', {
        timeout: 5000,
        visible: true
      });

      if (!chapterBtn) {
        console.log('Chapter list button not found, retrying...');
        continue;
      }

      // Scroll to button and click
      await page.evaluate((btn) => {
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, chapterBtn);
      
      await page.waitForTimeout(1000);
      await chapterBtn.click();
      console.log('Successfully clicked chapter list button');

      // Wait for chapter items to load with multiple possible selectors
      await page.waitForSelector('.chapter-item a, .chapter-link, .chapter-title-link', {
        timeout: 5000
      });

      // Extract chapter links
      const links = await page.evaluate(() => {
        const selectors = ['.chapter-item a', '.chapter-link', '.chapter-title-link'];
        let elements = [];
        
        for (const selector of selectors) {
          const found = Array.from(document.querySelectorAll(selector));
          if (found.length > 0) {
            elements = found;
            break;
          }
        }

        return elements.map(el => ({
          url: el.href,
          title: el.textContent.trim()
        })).filter(link => link.url && link.title);
      });

      if (links.length > 0) {
        console.log(`Found ${links.length} chapter links`);
        return links;
      }

      console.log('No chapter links found, retrying...');
      await page.waitForTimeout(2000);

    } catch (error) {
      console.log(`Attempt ${attempt + 1} failed:`, error.message);
      if (attempt === maxAttempts - 1) throw error;
      await page.waitForTimeout(2000);
    }
  }

  throw new Error('Failed to get chapter links after multiple attempts');
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function scrapeChapters(page, totalChapters, existingChapters = 0) {
  const scrapedChapters = [];
  const startChapter = existingChapters;
  const chaptersToScrape = totalChapters - existingChapters;
  
  try {
    // Click chapter list button and wait for animation
    await Promise.all([
      page.evaluate(() => {
        const button = document.getElementById("chapter-listing");
        if (button) {
          button.scrollIntoView({ behavior: "smooth", block: "center" });
          button.click();
        }
      }),
      new Promise(r => setTimeout(r, 2000))
    ]);

    // Wait for chapter list to load and get all chapters
    await page.waitForSelector('.chapter-item', { timeout: 5000 });
    
    // Get all chapter links first
    const chapterLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.chapter-item h3'))
        .map((el, index) => ({
          index,
          element: el
        }));
    });

    if (chapterLinks.length === 0) {
      throw new Error('No chapters found');
    }

    // Click starting chapter
    await page.evaluate((startFrom) => {
      const chapters = document.querySelectorAll('.chapter-item h3');
      if (chapters[startFrom]) {
        chapters[startFrom].click();
      }
    }, startChapter);

    await page.waitForNavigation({ waitUntil: 'networkidle0' });

    // Scrape chapters sequentially
    for (let i = 0; i < chaptersToScrape; i++) {
      console.log(`Scraping chapter ${startChapter + i + 1}/${totalChapters}`);

      const chapterContent = await scrapeChapterContent(page);
      if (chapterContent.content) {
        scrapedChapters.push(chapterContent);
      }

      if (i < chaptersToScrape - 1) {
        // Click next chapter button
        const nextButton = await page.$('#next-top');
        if (nextButton) {
          await Promise.all([
            nextButton.click(),
            page.waitForNavigation({ waitUntil: 'networkidle0' })
          ]);
        } else {
          console.log("Next chapter button not found");
          break;
        }
      }

      // Small delay between chapters
      await new Promise(r => setTimeout(r, 1000));
    }

  } catch (error) {
    console.error("Error in chapter scraping:", error.message);
  }

  return scrapedChapters;
}

module.exports = {
  scrapeNovelDetails,
  scrapeChapters,
  navigateToChapter
};