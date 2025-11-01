const express = require('express');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = 3000;

const config = {
  subdomains: [
      "https://games.brimind.pro/games",
    "https://brimind.pro",
    "https://www.brimind.pro",
    "https://games.brimind.pro",
    "https://ai.brimind.pro",
    "https://news.brimind.pro"
  ]
};

// Store visited URLs to avoid duplicates
const visitedUrls = new Set();
const allUrls = new Set();

// Normalize URL (remove trailing slash, fragments, etc.)
function normalizeUrl(url) {
  try {
    const urlObj = new URL(url);
    urlObj.hash = ''; // Remove fragment
    let normalized = urlObj.href;
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch (e) {
    return null;
  }
}

// Check if URL belongs to the subdomain
function isSameDomain(url, baseDomain) {
  try {
    const urlObj = new URL(url);
    const baseObj = new URL(baseDomain);
    return urlObj.hostname === baseObj.hostname;
  } catch (e) {
    return false;
  }
}

// Fetch and parse URLs from a page
async function crawlPage(url, baseDomain, depth = 0) {
  const normalized = normalizeUrl(url);
  
  if (!normalized || visitedUrls.has(normalized) || !isSameDomain(normalized, baseDomain)) {
    return;
  }

  visitedUrls.add(normalized);
  allUrls.add(normalized);
  
  console.log(`Crawling (depth: ${depth}): ${normalized}`);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(normalized, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SitemapBot/1.0)' },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.log(`Skipping ${normalized}: Status ${response.status}`);
      return;
    }

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('text/html')) {
      console.log(`Skipping ${normalized}: Not HTML`);
      return;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Find all links
    const links = new Set();
    
    // Check <a> tags
    $('a[href]').each((i, el) => {
      const href = $(el).attr('href');
      if (href) {
        try {
          const absoluteUrl = new URL(href, normalized).href;
          const normalizedLink = normalizeUrl(absoluteUrl);
          if (normalizedLink && isSameDomain(normalizedLink, baseDomain) && !visitedUrls.has(normalizedLink)) {
            links.add(normalizedLink);
          }
        } catch (e) {
          // Invalid URL, skip
        }
      }
    });

    // Check all elements with href attribute (like area, link, etc)
    $('[href]').each((i, el) => {
      const href = $(el).attr('href');
      if (href && href.startsWith('http')) {
        try {
          const absoluteUrl = new URL(href, normalized).href;
          const normalizedLink = normalizeUrl(absoluteUrl);
          if (normalizedLink && isSameDomain(normalizedLink, baseDomain) && !visitedUrls.has(normalizedLink)) {
            links.add(normalizedLink);
          }
        } catch (e) {}
      }
    });

    // Check data attributes and other attributes that might contain URLs
    $('[data-href], [data-url], [data-link]').each((i, el) => {
      const dataHref = $(el).attr('data-href') || $(el).attr('data-url') || $(el).attr('data-link');
      if (dataHref) {
        try {
          const absoluteUrl = new URL(dataHref, normalized).href;
          const normalizedLink = normalizeUrl(absoluteUrl);
          if (normalizedLink && isSameDomain(normalizedLink, baseDomain) && !visitedUrls.has(normalizedLink)) {
            links.add(normalizedLink);
          }
        } catch (e) {}
      }
    });

    // Extract URLs from inline scripts and HTML content
    const urlRegex = new RegExp(`https?:\/\/(www\.)?${baseDomain.replace('https://', '').replace('http://', '')}[^\s"'\)\]}>]*`, 'gi');
    const matches = html.match(urlRegex);
    if (matches) {
      matches.forEach(url => {
        try {
          const normalizedLink = normalizeUrl(url);
          if (normalizedLink && isSameDomain(normalizedLink, baseDomain) && !visitedUrls.has(normalizedLink)) {
            links.add(normalizedLink);
          }
        } catch (e) {}
      });
    }

    console.log(`Found ${links.size} new links on ${normalized}`);

    // Crawl found links recursively
    for (const link of links) {
      await crawlPage(link, baseDomain, depth + 1);
    }

  } catch (error) {
    if (error.name === 'AbortError') {
      console.error(`Timeout crawling ${normalized}`);
    } else {
      console.error(`Error crawling ${normalized}:`, error.message);
    }
  }
}

// Generate sitemap XML
function generateSitemap(urls) {
  const now = new Date().toISOString();
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  
  urls.forEach(url => {
    xml += '  <url>\n';
    xml += `    <loc>${url}</loc>\n`;
    xml += `    <lastmod>${now}</lastmod>\n`;
    xml += '  </url>\n';
  });
  
  xml += '</urlset>';
  return xml;
}

// Main crawl function
async function generateSitemapFile() {
  console.log('Starting sitemap generation...');
  
  visitedUrls.clear();
  allUrls.clear();

  // Crawl each subdomain
  for (const subdomain of config.subdomains) {
    console.log(`\nCrawling subdomain: ${subdomain}`);
    await crawlPage(subdomain, subdomain);
  }

  // Generate sitemap
  const xml = generateSitemap(Array.from(allUrls).sort());
  
  // Save to public folder
  const publicDir = path.join(__dirname, 'public');
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(path.join(publicDir, 'sitemap.xml'), xml);
  
  console.log(`\nSitemap generated with ${allUrls.size} URLs`);
  console.log('Saved to: public/sitemap.xml\n');
}

// Run immediately on startup
generateSitemapFile().catch(console.error);

// Run every hour
setInterval(() => {
  generateSitemapFile().catch(console.error);
}, 60 * 60 * 1000);

// Serve static files
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.send('Sitemap generator is running. Access sitemap at /sitemap.xml');
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Sitemap will be regenerated every hour');
});