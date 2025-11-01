const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
const PORT =  9009;

let config = {};
const visitedUrls = new Set();
const allUrls = new Set();
let browser = null;

async function loadConfig() {
  const data = await fs.readFile('subdomains.json', 'utf8');
  config = JSON.parse(data);
}

function normalizeUrl(url) {
  try {
    const urlObj = new URL(url);
    urlObj.hash = '';
    let normalized = urlObj.href;
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch (e) {
    return null;
  }
}

function isSameDomain(url, baseDomain) {
  try {
    const urlObj = new URL(url);
    const baseObj = new URL(baseDomain);
    return urlObj.hostname === baseObj.hostname;
  } catch (e) {
    return false;
  }
}

async function crawlPage(url, baseDomain, depth = 0) {
  const normalized = normalizeUrl(url);
  
  if (!normalized || visitedUrls.has(normalized) || !isSameDomain(normalized, baseDomain) || depth > 10) {
    return;
  }

  visitedUrls.add(normalized);
  allUrls.add(normalized);
  
  console.log(`Crawling (depth: ${depth}): ${normalized}`);
  
  await saveSitemapIncremental();

  try {
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    await page.goto(normalized, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    const links = await page.evaluate(() => {
      const foundLinks = new Set();
      
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.getAttribute('href');
        if (href) {
          try {
            const absoluteUrl = new URL(href, window.location.href).href;
            foundLinks.add(absoluteUrl);
          } catch (e) {}
        }
      });

      document.querySelectorAll('[data-href], [data-url]').forEach(el => {
        const href = el.getAttribute('data-href') || el.getAttribute('data-url');
        if (href) {
          try {
            const absoluteUrl = new URL(href, window.location.href).href;
            foundLinks.add(absoluteUrl);
          } catch (e) {}
        }
      });

      document.querySelectorAll('button, div').forEach(el => {
        const onclick = el.getAttribute('onclick');
        if (onclick) {
          const urlMatch = onclick.match(/['"]([^'"]*)['"]/);
          if (urlMatch) {
            try {
              const absoluteUrl = new URL(urlMatch[1], window.location.href).href;
              foundLinks.add(absoluteUrl);
            } catch (e) {}
          }
        }
      });

      return Array.from(foundLinks);
    });

    await page.close();

    const validLinks = links.filter(link => {
      const normalizedLink = normalizeUrl(link);
      return normalizedLink && 
             isSameDomain(normalizedLink, baseDomain) && 
             !visitedUrls.has(normalizedLink) &&
             !link.includes('#') &&
             !link.match(/\.(jpg|jpeg|png|gif|pdf|zip|css|js)$/i);
    });

    console.log(`Found ${validLinks.length} new links on ${normalized}`);

    for (const link of validLinks) {
      await crawlPage(link, baseDomain, depth + 1);
    }

  } catch (error) {
    console.error(`Error crawling ${normalized}:`, error.message);
  }
}

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

async function saveSitemapIncremental() {
  const xml = generateSitemap(Array.from(allUrls).sort());
  const publicDir = path.join(__dirname, 'public');
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(path.join(publicDir, 'sitemap.xml'), xml);
  console.log(`Sitemap updated: ${allUrls.size} URLs`);
}

async function generateSitemapFile() {
  console.log('Starting sitemap generation...');
  
  await loadConfig();
  visitedUrls.clear();
  allUrls.clear();

  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-dev-tools'
      ]
    });
  }

  for (const subdomain of config.subdomains) {
    console.log(`\nCrawling subdomain: ${subdomain}`);
    await crawlPage(subdomain, subdomain);
  }

  console.log(`\nSitemap generation complete with ${allUrls.size} URLs`);
  console.log('Saved to: public/sitemap.xml\n');
}

generateSitemapFile().catch(console.error);

setInterval(() => {
  generateSitemapFile().catch(console.error);
}, 60 * 60 * 1000);

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.send('Sitemap generator is running. Access sitemap at /sitemap.xml');
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Sitemap will be regenerated every hour');
});

process.on('SIGINT', async () => {
  if (browser) {
    await browser.close();
  }
  process.exit();
});