// app.js (Part 1)
const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// ========== runtime.json 持久化 ==========
const runtimeFile = path.join(__dirname, 'config', 'runtime.json');
let runtimeConfig = { defaultSaveDir: config.defaultSaveDir };

if (fs.existsSync(runtimeFile)) {
  try {
    const data = JSON.parse(fs.readFileSync(runtimeFile, 'utf-8'));
    runtimeConfig = { ...runtimeConfig, ...data };
    console.log('✅ runtime.json 已加载');
  } catch (err) {
    console.error('❌ 读取 runtime.json 失败:', err.message);
  }
}

function saveRuntimeConfig() {
  fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
  fs.writeFileSync(runtimeFile, JSON.stringify(runtimeConfig, null, 2));
}

// ========== 日志 ==========
const logFile = path.join(__dirname, 'logs', 'app.log');
fs.mkdirSync(path.dirname(logFile), { recursive: true });
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function log(...args) {
  const msg = `[${new Date().toISOString()}] ${args.join(' ')}`;
  logStream.write(msg + '\n');
  console.log(...args);
}

function logErr(...args) {
  const msg = `[${new Date().toISOString()}] ${args.join(' ')}`;
  logStream.write(msg + '\n');
  console.error(...args);
}

// ========== MongoDB & Bot ==========
const client = new MongoClient(config.mongodbUri);
const bot = new Telegraf(config.botToken);
let db;

async function connectDB() {
  if (!db) {
    await client.connect();
    db = client.db();
    log('✅ MongoDB 已连接');
  }
  return db;
}

async function getAllCollections() {
  const collections = await db.listCollections().toArray();
  return collections.map(c => c.name).filter(n => !config.excludeCollections.includes(n));
}

async function searchAllCollections(number) {
  const collections = await getAllCollections();
  const query = { $or: [{ number }, { code: number }, { serial: number }, { id: number }] };
  log(`🔍 搜索番号: ${number}, 集合数量: ${collections.length}`);
  const results = await Promise.all(
    collections.map(async name => {
      try {
        const docs = await db.collection(name).find(query).toArray();
        if (docs.length) log(`✅ 集合 ${name} 找到 ${docs.length} 条`);
        return docs.map(doc => ({ doc, name }));
      } catch (err) {
        logErr(`❌ 搜索集合 ${name} 出错:`, err.message);
        return [];
      }
    })
  );
  return results.flat();
}

// ========== 工具函数 ==========
function isAllowed(userId) {
  return config.allowedTgIds.includes(String(userId));
}

function escapeHtml(text) {
  if (!text) return 'N/A';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// app.js (Part 2)

// ========== 封面缓存 ==========
const CACHE_FILE = './coverCache.json';
const COVER_TTL = 24 * 60 * 60 * 1000; // 1天
let coverCache = new Map();

if (fs.existsSync(CACHE_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    coverCache = new Map(Object.entries(data));
    log(`✅ 封面缓存已加载 (${coverCache.size} 条)`);
  } catch (err) {
    logErr('❌ 读取封面缓存失败:', err.message);
  }
}

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(coverCache), null, 2));
}

function cleanExpiredCache() {
  const now = Date.now();
  let changed = false;
  for (const [key, { time }] of coverCache) {
    if (now - time > COVER_TTL) {
      coverCache.delete(key);
      changed = true;
    }
  }
  if (changed) saveCache();
}

// ========== 封面抓取函数 ==========
async function validateImageUrl(url) {
  try {
    const resp = await axios.head(url, { timeout: 5000 });
    return (resp.headers['content-type'] || '').startsWith('image/');
  } catch {
    return false;
  }
}

async function getWorkerCover(number) {
  try {
    const url = `https://tuymawvla.allixogiqs79.workers.dev/${encodeURIComponent(number)}`;
    const resp = await axios.get(url, { timeout: 5000 });
    if (resp.data && typeof resp.data === 'string' && resp.data.startsWith('http')) return resp.data;
    return null;
  } catch {
    return null;
  }
}

async function getJavDbCover(number) {
  try {
    const url = `https://www.javdb.com/search?q=${encodeURIComponent(number)}&f=all`;
    const resp = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
    const $ = cheerio.load(resp.data);
    let cover = $('img.video-cover').first().attr('src') || $('meta[property="og:image"]').attr('content');
    if (cover && cover.startsWith('/')) cover = 'https://www.javdb.com' + cover;
    return cover || null;
  } catch {
    return null;
  }
}

async function getSehuatangCover(number) {
  try {
    const searchUrl = `https://sehuatang.org/search.php?mod=forum&srchtxt=${encodeURIComponent(number)}`;
    const resp = await axios.get(searchUrl, { timeout: 5000 });
    const $ = cheerio.load(resp.data);
    const firstPost = $('.xs3 a').first().attr('href');
    if (!firstPost) return null;
    const postUrl = firstPost.startsWith('http') ? firstPost : `https://sehuatang.org/${firstPost}`;
    const postResp = await axios.get(postUrl, { timeout: 5000 });
    const $$ = cheerio.load(postResp.data);
    const firstImg = $$('#postlist .t_f img').first().attr('file') || $$('#postlist .t_f img').first().attr('src');
    if (firstImg) return firstImg.startsWith('http') ? firstImg : `https:${firstImg}`;
    return null;
  } catch {
    return null;
  }
}

async function getDmmCover(number) {
  try {
    const url = `https://www.dmm.co.jp/digital/videoa/-/search/=/searchstr=${encodeURIComponent(number)}/`;
    const resp = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
    const $ = cheerio.load(resp.data);
    const cover = $('.tmb img').first().attr('src');
    return cover || null;
  } catch {
    return null;
  }
}

// ========== 封面抓取带缓存 & 多源优选 ==========
async function getCoverWithCache(number) {
  cleanExpiredCache();
  const cached = coverCache.get(number);
  if (cached && Date.now() - cached.time < COVER_TTL) return cached.url;

  const sources = [getWorkerCover, getDmmCover, getJavDbCover, getSehuatangCover];
  const results = await Promise.all(sources.map(fn => fn(number)));
  const cover = results.find(url => url);
  if (cover && await validateImageUrl(cover)) {
    coverCache.set(number, { url: cover, time: Date.now() });
    saveCache();
    return cover;
  }

  log(`❌ 未获取到有效封面: ${number}`);
  return null;
}

// ========== 本地发送封面 ==========
const tmpDir = path.join(__dirname, 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });

async function sendPhotoFromUrl(ctx, url, caption) {
  try {
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': url } });
    const ext = (url.match(/\.(jpg|jpeg|png|gif)/i) || ['.jpg'])[0];
    const tmpPath = path.join(tmpDir, `cover_${Date.now()}${ext}`);
    fs.writeFileSync(tmpPath, resp.data);
    await ctx.replyWithPhoto({ source: tmpPath }, { caption, parse_mode: 'HTML' });
    fs.unlinkSync(tmpPath);
    log(`📸 已发送本地封面: ${url}`);
  } catch (err) {
    logErr('⚠️ 本地发送封面失败:', err.message);
    await ctx.reply(caption, { parse_mode: 'HTML' });
  }
                     }

// app.js (Part 3)

// ========== 启动命令 ==========
bot.start(ctx => {
  if (!isAllowed(ctx.from.id)) return ctx.reply('❌ 无权限');

  ctx.reply(
    '欢迎使用全库搜索机器人！发送番号即可搜索，/start 开始。',
    Markup.keyboard([
      ['/a 高清中文字幕', '/a 韩国主播'],
      ['/a 素人有码系列', '/a 亚洲有码原创'],
      ['/a 亚洲无码原创', '/a 动漫原创'],
      ['/a VR', '/a 4K'],
      ['/a 国产原创', '/a 欧美无码'],
      ['/a 三级写真', '/a 其他']
    ]).resize()
  );
});

// ========== 设置命令菜单 ==========
bot.telegram.setMyCommands([
  { command: 'start', description: '开始使用' },
  { command: 'help', description: '帮助说明' },
  { command: 'fuzzy', description: '模糊搜索（多关键词+分页）' }
]);

// ========== 推荐内容的数据库映射 ==========
const databaseMappings = {
  '高清中文字幕': 'hd_chinese_subtitles',
  '素人有码系列': 'EU_US_no_mosaic',
  '亚洲有码原创': 'asia_codeless_originate',
  '亚洲无码原创': 'asia_mosaic_originate',
  '动漫原创': 'online_originate',
  'VR': 'vr_video',
  '4K': '4k_video',
  '国产原创': 'domestic_original',
  '欧美无码': 'asia_codeless_originate',
  '三级写真': 'three_levels_photo',
  '韩国主播': 'vegan_with_mosaic',
};

// ========== 随机推荐内容 ==========
bot.command('a', async ctx => {
  if (!isAllowed(ctx.from.id)) return ctx.reply('❌ 无权限');

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length !== 1) return ctx.reply('用法: /a <内容>，例如: /a 韩国主播');

  const contentName = args[0];
  const recommendedCollection = Object.keys(databaseMappings).find(key => key.includes(contentName));
  if (!recommendedCollection) return ctx.reply('❌ 无效的内容，请使用以下内容之一：' + Object.keys(databaseMappings).join(', '));

  try {
    await connectDB();
    const results = await db.collection(databaseMappings[recommendedCollection]).aggregate([{ $sample: { size: 10 } }]).toArray();

    if (!results.length) return ctx.reply(`❌ ${recommendedCollection} 内容为空`);

    for (const doc of results) {
      const number = escapeHtml(doc.number || 'N/A');
      const magnet = escapeHtml(doc.magnet || 'N/A');
      const imageUrl = await getCoverWithCache(number); 
      const message = `<b>番号:</b> ${number}\n<b>磁力链接:</b> <code>${magnet}</code>\n\n`;

      if (imageUrl) await sendPhotoFromUrl(ctx, imageUrl, message);
      else await ctx.reply(message, { parse_mode: 'HTML' });
    }

  } catch (err) {
    logErr('推荐错误:', err);
    ctx.reply('⚠️ 推荐内容出错，请稍后再试');
  }
});

function buildMessage(doc, collectionName) {
  const number = doc.number || 'N/A';
  const title = doc.title || 'N/A';
  const actress = doc.actress ? doc.actress.join(', ') : '未知';
  const release = doc.release || '未知';
  const magnet = doc.magnet || '';

  let message = `<b>${escapeHtml(title)}</b>\n`;
  message += `番号: <code>${escapeHtml(number)}</code>\n`;
  message += `女优: ${escapeHtml(actress)}\n`;
  message += `发行日期: ${escapeHtml(release)}\n`;
  message += `数据来源: ${escapeHtml(collectionName)}\n`;
  if (magnet) {
    message += `\n<a href="${escapeHtml(magnet)}">磁力链接</a>`;
  }

  return message;
}

// ========== 普通搜索 ==========
bot.on('text', async ctx => {
  const userId = ctx.from.id;
  if (!isAllowed(userId)) return;
  const text = ctx.message.text.trim();
  if (!text || text.startsWith('/') || text.length > 50) return;

  log(`🔎 用户 ${userId} 搜索: ${text}`);
  try {
    await connectDB();
    ctx.sendChatAction('typing');

    const results = await searchAllCollections(text);
    if (!results.length) {
      const fallbackMsg = `<b>ℹ️ 找到番号: ${escapeHtml(text)}</b>\n❌ 本地未找到`;
      const imageUrl = await getCoverWithCache(text);
      if (imageUrl) await sendPhotoFromUrl(ctx, imageUrl, fallbackMsg);
      else await ctx.reply(fallbackMsg, { parse_mode: 'HTML' });
      return;
    }

    for (const { doc, name } of results) {
      const message = buildMessage(doc, name);
      const imageUrl = doc.img?.[0] || doc.cover || await getCoverWithCache(text);
      if (imageUrl) {
        if (await validateImageUrl(imageUrl)) {
          try { await ctx.replyWithPhoto(imageUrl, { caption: message, parse_mode: 'HTML' }); }
          catch { await sendPhotoFromUrl(ctx, imageUrl, message); }
        } else {
          await sendPhotoFromUrl(ctx, imageUrl, message);
        }
      } else {
        await ctx.reply(message, { parse_mode: 'HTML' });
      }
    }

  } catch (err) {
    logErr('搜索错误:', err);
    ctx.reply('⚠️ 搜索出错，请稍后再试');
  }
});

// ========== 多关键词模糊搜索 + 分页 ==========
const { nanoid } = require('nanoid');
const searchSessions = new Map();
const PAGE_SIZE = 5;

function buildPage(session) {
  const start = (session.page - 1) * PAGE_SIZE;
  const pageItems = session.results.slice(start, start + PAGE_SIZE);
  let text = `ℹ️ 共 ${session.results.length} 条结果，当前第 ${session.page} 页\n\n`;
  pageItems.forEach((item, i) => {
    const number = item.doc.number || 'N/A';
    const title = item.doc.title || 'N/A';
    text += `${i + 1}. ${title} (${number})\n`;
  });
  return text;
}

bot.command('fuzzy', async ctx => {
  if (!isAllowed(ctx.from.id)) return ctx.reply('❌ 无权限');

  const keyword = ctx.message.text.replace('/fuzzy', '').trim();
  if (!keyword) return ctx.reply('用法: /fuzzy <关键词>, 支持空格分隔多个关键词');

  try {
    await connectDB();
    ctx.sendChatAction('typing');

    const keywords = keyword.split(/\s+/).filter(Boolean);
    const regexConditions = keywords.map(k => ({ title: { $regex: k, $options: 'i' } }));
    const collections = await getAllCollections();

    let results = [];
    for (const name of collections) {
      try {
        const docs = await db.collection(name).find({ $and: regexConditions }).toArray();
        results.push(...docs.map(doc => ({ doc, name })));
      } catch (err) { logErr(`❌ 搜索集合 ${name} 出错:`, err.message); }
    }

    if (!results.length) return ctx.reply('❌ 未找到匹配结果');

    // 分页处理
    const sessionId = nanoid();
    searchSessions.set(sessionId, { results, page: 1 });
    const session = searchSessions.get(sessionId);

    await ctx.reply(buildPage(session), {
      reply_markup: {
        inline_keyboard: [
          session.results.slice(0, PAGE_SIZE).map((_, i) => ({ text: `${i+1}`, callback_data: `detail:${sessionId}:${i}` })),
          [
            { text: '上一页', callback_data: `prev:${sessionId}` },
            { text: '下一页', callback_data: `next:${sessionId}` }
          ]
        ]
      }
    });

  } catch (err) {
    logErr('模糊搜索错误:', err);
    ctx.reply('⚠️ 搜索出错，请稍后再试');
  }
});

// ========== 分页与详情回调 ==========
bot.action(/detail:(.+):(\d+)/, async ctx => {
  const [ , sessionId, indexStr ] = ctx.match;
  const session = searchSessions.get(sessionId);
  if (!session) return ctx.answerCbQuery('⚠️ 会话已过期');

  const index = parseInt(indexStr);
  const item = session.results[(session.page -1)* PAGE_SIZE + index];
  if (!item) return ctx.answerCbQuery('⚠️ 无效索引');

  const { doc, name } = item;
  const message = buildMessage(doc, name);
  const imageUrl = doc.img?.[0] || doc.cover || await getCoverWithCache(doc.number);
  if (imageUrl) await sendPhotoFromUrl(ctx, imageUrl, message);
  else await ctx.reply(message, { parse_mode: 'HTML' });

  await ctx.answerCbQuery();
});

bot.action(/prev:(.+)/, async ctx => {
  const sessionId = ctx.match[1];
  const session = searchSessions.get(sessionId);
  if (!session) return ctx.answerCbQuery('⚠️ 会话已过期');
  if (session.page <= 1) return ctx.answerCbQuery('⚠️ 已经是第一页');
  session.page--;
  await ctx.editMessageText(buildPage(session), {
    reply_markup: {
      inline_keyboard: [
// ========================= 构建消息 =========================
function buildMessage(doc, collectionName) {
  const number = doc.number || 'N/A';
  const title = doc.title || 'N/A';
  const actress = doc.actress ? doc.actress.join(', ') : '未知';
  const release = doc.release || '未知';
  const magnet = doc.magnet || doc.magnet_link || ''; // 支持多种磁链字段

  let message = `<b>${escapeHtml(title)}</b>\n`;
  message += `番号: <code>${escapeHtml(number)}</code>\n`;
  message += `女优: ${escapeHtml(actress)}\n`;
  message += `发行日期: ${escapeHtml(release)}\n`;
  message += `数据来源: ${escapeHtml(collectionName)}\n`;
  if (magnet) {
    message += `\n<a href="${escapeHtml(magnet)}">磁力链接</a>`;
  }
  return message;
}

// ========================= 普通搜索 =========================
bot.on('text', async ctx => {
  const userId = ctx.from.id;
  if (!isAllowed(userId)) return;
  const text = ctx.message.text.trim();
  if (!text || text.startsWith('/') || text.length > 50) return;

  log(`🔎 用户 ${userId} 搜索: ${text}`);
  try {
    await connectDB();
    ctx.sendChatAction('typing');

    const results = await searchAllCollections(text);
    if (!results.length) {
      const fallbackMsg = `<b>ℹ️ 找到番号: ${escapeHtml(text)}</b>\n❌ 本地未找到`;
      const imageUrl = await getCoverWithCache(text);
      if (imageUrl) await sendPhotoFromUrl(ctx, imageUrl, fallbackMsg);
      else await ctx.reply(fallbackMsg, { parse_mode: 'HTML' });
      return;
    }

    for (const { doc, name } of results) {
      const message = buildMessage(doc, name);
      const imageUrl = doc.img?.[0] || doc.cover || await getCoverWithCache(text);
      if (imageUrl) {
        if (await validateImageUrl(imageUrl)) {
          try { await ctx.replyWithPhoto(imageUrl, { caption: message, parse_mode: 'HTML' }); }
          catch { await sendPhotoFromUrl(ctx, imageUrl, message); }
        } else {
          await sendPhotoFromUrl(ctx, imageUrl, message);
        }
      } else {
        await ctx.reply(message, { parse_mode: 'HTML' });
      }
    }

  } catch (err) {
    logErr('搜索错误:', err);
    ctx.reply('⚠️ 搜索出错，请稍后再试');
  }
});

// ========================= 多关键词模糊搜索 + 分页 =========================
const { nanoid } = require('nanoid');
const searchSessions = new Map();
const PAGE_SIZE = 5;

function buildPage(session) {
  const start = (session.page - 1) * PAGE_SIZE;
  const pageItems = session.results.slice(start, start + PAGE_SIZE);
  let text = `ℹ️ 共 ${session.results.length} 条结果，当前第 ${session.page} 页\n\n`;
  pageItems.forEach((item, i) => {
    const number = item.doc.number || 'N/A';
    const title = item.doc.title || 'N/A';
    text += `${i + 1}. ${title} (${number})\n`;
  });
  return text;
}

bot.command('fuzzy', async ctx => {
  if (!isAllowed(ctx.from.id)) return ctx.reply('❌ 无权限');

  const keyword = ctx.message.text.replace('/fuzzy', '').trim();
  if (!keyword) return ctx.reply('用法: /fuzzy <关键词>, 支持空格分隔多个关键词');

  try {
    await connectDB();
    ctx.sendChatAction('typing');

    const keywords = keyword.split(/\s+/).filter(Boolean);
    const regexConditions = keywords.map(k => ({
      $or: [
        { title: { $regex: k, $options: 'i' } },
        { number: { $regex: k, $options: 'i' } } // 支持番号模糊搜索
      ]
    }));

    const collections = await getAllCollections();
    let results = [];
    for (const name of collections) {
      try {
        const docs = await db.collection(name).find({ $and: regexConditions }).toArray();
        results.push(...docs.map(doc => ({ doc, name })));
      } catch (err) { logErr(`❌ 搜索集合 ${name} 出错:`, err.message); }
    }

    if (!results.length) return ctx.reply('❌ 未找到匹配结果');

    // 分页处理
    const sessionId = nanoid();
    searchSessions.set(sessionId, { results, page: 1 });
    const session = searchSessions.get(sessionId);

    await ctx.reply(buildPage(session), {
      reply_markup: {
        inline_keyboard: [
          session.results.slice(0, PAGE_SIZE).map((_, i) => ({ text: `${i+1}`, callback_data: `detail:${sessionId}:${i}` })),
          [
            { text: '上一页', callback_data: `prev:${sessionId}` },
            { text: '下一页', callback_data: `next:${sessionId}` }
          ]
        ]
      }
    });

  } catch (err) {
    logErr('模糊搜索错误:', err);
    ctx.reply('⚠️ 搜索出错，请稍后再试');
  }
});

// ========================= 分页与详情回调 =========================
bot.action(/detail:(.+):(\d+)/, async ctx => {
  const [ , sessionId, indexStr ] = ctx.match;
  const session = searchSessions.get(sessionId);
  if (!session) return ctx.answerCbQuery('⚠️ 会话已过期');

  const index = parseInt(indexStr);
  const item = session.results[(session.page -1)* PAGE_SIZE + index];
  if (!item) return ctx.answerCbQuery('⚠️ 无效索引');

  const { doc, name } = item;
  const message = buildMessage(doc, name);
  const imageUrl = doc.img?.[0] || doc.cover || await getCoverWithCache(doc.number);
  if (imageUrl) await sendPhotoFromUrl(ctx, imageUrl, message);
  else await ctx.reply(message, { parse_mode: 'HTML' });

  await ctx.answerCbQuery();
});

bot.action(/prev:(.+)/, async ctx => {
  const sessionId = ctx.match[1];
  const session = searchSessions.get(sessionId);
  if (!session) return ctx.answerCbQuery('⚠️ 会话已过期');
  if (session.page <= 1) return ctx.answerCbQuery('⚠️ 已经是第一页');
  session.page--;
  await ctx.editMessageText(buildPage(session), {
    reply_markup: {
      inline_keyboard: [
        session.results.slice((session.page-1)*PAGE_SIZE, session.page*PAGE_SIZE).map((_, i) => ({ text: `${i+1}`, callback_data: `detail:${sessionId}:${i}` })),
        [
          { text: '上一页', callback_data: `prev:${sessionId}` },
          { text: '下一页', callback_data: `next:${sessionId}` }
        ]
      ]
    }
  });
  await ctx.answerCbQuery();
});

bot.action(/next:(.+)/, async ctx => {
  const sessionId = ctx.match[1];
  const session = searchSessions.get(sessionId);
  if (!session) return ctx.answerCbQuery('⚠️ 会话已过期');
  const totalPages = Math.ceil(session.results.length / PAGE_SIZE);
  if (session.page >= totalPages) return ctx.answerCbQuery('⚠️ 已经是最后一页');
  session.page++;
  await ctx.editMessageText(buildPage(session), {
    reply_markup: {
      inline_keyboard: [
        session.results.slice((session.page-1)*PAGE_SIZE, session.page*PAGE_SIZE).map((_, i) => ({ text: `${i+1}`, callback_data: `detail:${sessionId}:${i}` })),
        [
          { text: '上一页', callback_data: `prev:${sessionId}` },
          { text: '下一页', callback_data: `next:${sessionId}` }
        ]
      ]
    }
  });
  await ctx.answerCbQuery();
});

// ========== 启动 ==========
bot.launch().then(() => log('✅ Bot 已启动'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));





































