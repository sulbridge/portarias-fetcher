const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

// Преобразует дату DD-MM-YYYY в нужный формат для URL
function normalizeDate(raw) {
  if (/^\d{2}-\d{2}-\d{4}$/.test(raw)) {
    return raw; // уже DD-MM-YYYY
  }
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

// Простая парсинга блока naturalização из HTML
function parseNaturalizacao(html) {
  const cleaned = html.replace(/\r?\n/g, ' ');
  const blockMatch = cleaned.match(/CONCEDER a nacionalidade brasileira[\s\S]*?PORTARIA Nº/i);
  const block = blockMatch ? blockMatch[0] : cleaned;
  const personRegex = /([A-ZÀ-Ú\s\-'’]+?)\s*-\s*([A-Z0-9\-\/]+),\s*natural da\s*([^,]+),\s*nascid[oa]\s+em\s+([^,]+),\s*filh[oa]\s+de\s+([^,]+?)\s+e\s+([^,]+?),[\s\S]*?Processo\s+(?:n[ºo]\s*)?([0-9./]+)/gi;
  const results = [];
  let m;
  while ((m = personRegex.exec(block)) !== null) {
    results.push({
      name: m[1].trim(),
      id: m[2].trim(),
      origin: m[3].trim(),
      birthDate: m[4].trim(),
      parent1: m[5].trim(),
      parent2: m[6].trim(),
      process: m[7].trim(),
    });
  }
  return results;
}

app.get('/fetch', async (req, res) => {
  const dateRaw = req.query.date;
  if (!dateRaw) return res.status(400).json({ error: 'Missing ?date=DD-MM-YYYY' });

  const searchDate = normalizeDate(dateRaw);
  const searchUrl = `https://www.in.gov.br/leiturajornal?secao=dou1&data=${searchDate}`;

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  try {
    await page.goto(searchUrl, { waitUntil: 'networkidle' });
    // Ждём немного появления ссылок
    await page.waitForTimeout(1000);

    // Собираем все уникальные detailUrl с "portaria-n-"
    const portarias = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a'))
        .filter(a => /portaria-n-/i.test(a.getAttribute('href') || ''));
      const seen = new Set();
      return anchors
        .map(a => {
          const href = a.href;
          if (seen.has(href)) return null;
          seen.add(href);
          const title = (a.textContent || '').trim();
          return { title, detailUrl: href };
        })
        .filter(Boolean);
    });

    const results = [];

    for (const p of portarias) {
      await page.goto(p.detailUrl, { waitUntil: 'networkidle' });

      // Ищем "Versão certificada"
      let certifiedUrl = await page.evaluate(() => {
        const link = Array.from(document.querySelectorAll('a')).find(a =>
          /vers[aã]o certificada/i.test(a.textContent || '')
        );
        return link ? link.href : null;
      });

      if (!certifiedUrl) {
        // fallback: любую ссылку с 'certificada' в тексте
        certifiedUrl = await page.evaluate(() => {
          const link = Array.from(document.querySelectorAll('a')).find(a =>
            /certificada/i.test(a.textContent || '')
          );
          return link ? link.href : null;
        });
      }

      const entry = {
        portaria: {
          title: p.title,
          detailUrl: p.detailUrl,
          certifiedUrl: certifiedUrl || null,
        },
        naturalizados: [],
      };

      if (certifiedUrl) {
        await page.goto(certifiedUrl, { waitUntil: 'networkidle' });
        const certifiedHtml = await page.content();
        entry.naturalizados = parseNaturalizacao(certifiedHtml);
      } else {
        entry.warning = 'Certified version not found';
      }

      results.push(entry);
    }

    await browser.close();
    res.json({ date: searchDate, results });
  } catch (err) {
    await browser.close();
    res.status(500).json({ error: String(err.message), stack: err.stack });
  }
});

app.listen(PORT, () => {
  console.log(`Fetcher running on port ${PORT}`);
});
