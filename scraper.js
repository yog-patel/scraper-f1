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
* Scrapes a single chapter content
* @param {Page} page - Puppeteer page instance
* @returns {Promise<Object>} Chapter title and content
*/
async function scrapeChapterContent(page) {
  return await page.evaluate(() => {
      // Use the correct selector for the chapter title
      const chapterTitle = document.getElementById("span-28-1305853")?.innerText.trim() || "No title found";
      // Collect all paragraphs inside .ct-span
      const paragraphs = Array.from(document.querySelectorAll('.ct-span p')).map(p => p.innerText.trim());
      const chapterText = paragraphs.join("\n\n"); // Preserve paragraph spacing
      return { title: chapterTitle, content: chapterText };
  });
}

/**
* Navigates to the next chapter
* @param {Page} page - Puppeteer page instance
* @returns {Promise<boolean>} Whether navigation was successful
*/
async function navigateToNextChapter(page) {
  try {
      const nextBtn = await page.$("#next-top");
      if (nextBtn) {
          await nextBtn.evaluate(btn => btn.scrollIntoView({ behavior: "smooth", block: "center" }));
          await new Promise(resolve => setTimeout(resolve, 2000)); // Allow scrolling
          await nextBtn.click();
          console.log("Clicked on the next chapter button.");
          return true;
      } else {
          console.log("Next chapter button not found.");
          return false;
      }
  } catch (error) {
      console.error("Error navigating to next chapter:", error);
      return false;
  }
}

/**
* Navigate to the chapters list and click on specific chapter
* @param {Page} page - Puppeteer page instance
* @param {number} startFromChapter - Chapter number to start from (0 for first chapter)
*/
async function navigateToChapter(page, startFromChapter = 0) {
  // Scroll to the button and wait
  await page.evaluate(() => {
      const button = document.getElementById("chapter-listing");
      if (button) {
          button.scrollIntoView({ behavior: "smooth", block: "center" });
      }
  });

  await new Promise(resolve => setTimeout(resolve, 2000));

  // Click the chapter-listing button after scrolling
  await page.evaluate(() => {
      document.getElementById("chapter-listing").click();
  });

  console.log("Clicked on 'Chapters' button successfully.");
  
  // Scroll to the target chapter
  await page.evaluate((startFromChapter) => {
      const chapterItems = document.querySelectorAll(".chapter-item h3");
      const targetIndex = startFromChapter > 0 ? startFromChapter : 0;
      if (chapterItems.length > targetIndex) {
          chapterItems[targetIndex].scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (chapterItems.length > 0) {
          chapterItems[0].scrollIntoView({ behavior: "smooth", block: "center" });
      }
  }, startFromChapter);
  
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Click the targeted chapter
  await page.evaluate((startFromChapter) => {
      const chapterItems = document.querySelectorAll(".chapter-item h3");
      const targetIndex = startFromChapter > 0 ? startFromChapter : 0;
      if (chapterItems.length > targetIndex) {
          chapterItems[targetIndex].click();
      } else if (chapterItems.length > 0) {
          chapterItems[0].click();
      }
  }, startFromChapter);

  console.log(`Clicked on chapter at position ${startFromChapter > 0 ? startFromChapter : 0} successfully.`);
}

/**
* Scrape chapters sequentially from the chapter list
* @param {Page} page
* @param {number} totalChapters
* @param {number} existingChapters
* @returns {Promise<Array<{title: string, content: string}>>}
*/
async function scrapeChapters(page, totalChapters, existingChapters = 0) {
  const scrapedChapters = [];
  const startChapter = existingChapters;
  const chaptersToScrape = totalChapters - existingChapters;

  try {
    // Open chapter list
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

    // Wait for chapter list to load
    await page.waitForSelector('.chapter-item h3, .chapter-item, .chapter-link', { timeout: 7000 });

    // Get all chapter elements
    const chapterElements = await page.$$('.chapter-item h3, .chapter-item, .chapter-link');
    if (chapterElements.length === 0) {
      throw new Error('No chapters found');
    }

    // Click starting chapter
    if (chapterElements[startChapter]) {
      await chapterElements[startChapter].click();
      await page.waitForNavigation({ waitUntil: 'networkidle0' });
    } else {
      throw new Error('Start chapter not found in chapter list');
    }

    // Scrape chapters sequentially
    for (let i = 0; i < chaptersToScrape; i++) {
      console.log(`Scraping chapter ${startChapter + i + 1}/${totalChapters}`);

      const chapterContent = await scrapeChapterContent(page);
      if (chapterContent && chapterContent.content) {
        scrapedChapters.push(chapterContent);
      } else {
        console.warn(`⚠️ Skipping chapter ${startChapter + i + 1}: content missing`);
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