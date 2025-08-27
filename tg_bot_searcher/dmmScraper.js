const axios = require('axios');
const cheerio = require('cheerio');
const config = require('./config');

/**
 * 从DMM获取番号封面图URL
 * @param {string} code - 番号，如 'midv-076'
 * @returns {Promise<string|null>} - 返回封面图URL或null
 */
async function getDmmCoverUrl(code) {
  try {
    console.log(`[DMM] 正在搜索番号: ${code}`);

    // 1. 构建DMM搜索URL
    const searchQuery = code.replace(/-/g, '');
    const searchUrl = `https://www.dmm.co.jp/search/=/searchstr=${encodeURIComponent(searchQuery)}/`;

    // 2. 准备请求配置
    const requestConfig = {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://www.dmm.co.jp/'
      }
    };

    // 3. 根据配置决定是否使用代理
    if (config.useProxy && config.proxyConfig) {
      console.log('[DMM] 使用代理请求');
      requestConfig.proxy = config.proxyConfig;
    } else {
      console.log('[DMM] 使用透明代理（直接请求）');
    }

    // 4. 发送搜索请求
    const response = await axios.get(searchUrl, requestConfig);

    if (response.status !== 200) {
      console.log('[DMM] 请求失败，状态码:', response.status);
      return null;
    }

    const $ = cheerio.load(response.data);

    // 5. 检查是否有"找不到商品"的提示
    if ($('.dmm404').length > 0 || $('#search').text().includes('0件')) {
      console.log('[DMM] 未找到该番号的作品');
      return null;
    }

    // 6. 查找第一个搜索结果的详情页链接
    let detailUrl = null;
    const firstResult = $('.t-box .t-item a').first() || $('.box-searchlist .item a').first();
    
    if (firstResult.length) {
      detailUrl = firstResult.attr('href');
      if (detailUrl && !detailUrl.startsWith('http')) {
        detailUrl = 'https://www.dmm.co.jp' + detailUrl;
      }
    }

    if (!detailUrl) {
      console.log('[DMM] 未找到详情页链接');
      return null;
    }

    console.log('[DMM] 找到详情页:', detailUrl);

    // 7. 请求详情页获取封面图
    const detailResponse = await axios.get(detailUrl, {
      ...requestConfig,
      headers: {
        ...requestConfig.headers,
        'Referer': searchUrl
      }
    });

    const detail$ = cheerio.load(detailResponse.data);

    // 8. 提取封面图URL
    let coverUrl = null;
    
    const selectors = [
      '#sample-video img',
      '.sample-image img',
      '.product-detail img',
      '[class*="image"] img',
      '[class*="cover"] img',
      '[class*="sample"] img'
    ];

    for (const selector of selectors) {
      const imgElement = detail$(selector).first();
      if (imgElement.length) {
        coverUrl = imgElement.attr('src') || imgElement.attr('data-src');
        if (coverUrl) {
          if (coverUrl.startsWith('//')) {
            coverUrl = 'https:' + coverUrl;
          } else if (coverUrl.startsWith('/')) {
            coverUrl = 'https://www.dmm.co.jp' + coverUrl;
          }
          break;
        }
      }
    }

    if (coverUrl) {
      console.log('[DMM] 成功获取封面图:', coverUrl);
      return coverUrl;
    } else {
      console.log('[DMM] 未找到封面图');
      return null;
    }

  } catch (error) {
    console.error('[DMM] 抓取过程中出错:', error.message);
    return null;
  }
}

module.exports = { getDmmCoverUrl };