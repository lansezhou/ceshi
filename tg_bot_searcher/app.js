// app.js
const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// ========== 环境变量配置 ==========
const COVER_WORKER_URL = process.env.COVER_WORKER_URL || null;

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
  const MAX_CACHE_SIZE = 1000;
  if (coverCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(coverCache.entries());
    entries.sort((a, b) => a[1].time - b[1].time);
    for (let i = 0; i < entries.length - MAX_CACHE_SIZE; i++) {
      coverCache.delete(entries[i][0]);
    }
  }
  
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

// ========== 工具 ==========
function isAllowed(userId) {
  return config.allowedTgIds.includes(String(userId));
}

function escapeHtml(text) {
  if (!text) return 'N/A';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitizeInput(text) {
  return text.trim().substring(0, 50).replace(/[^a-zA-Z0-9\-_]/g, '');
}

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

// ========== 构建消息 ==========
function buildMessage(doc, collection) {
  const number = escapeHtml(doc.number || 'N/A');
  const title = escapeHtml(doc.title || 'N/A');
  const date = escapeHtml(doc.date || 'N/A');
  const postTime = escapeHtml(doc.post_time || 'N/A');
  const tid = escapeHtml(doc.tid || 'N/A');
  const magnet = doc.magnet || 'N/A';

  return `<b>★结果 ：${number} ★</b>\n<b>标题:</b> ${title}\n<b>番号:</b> ${number}\n<b>日期:</b> ${date}\n<b>发布时间:</b> ${postTime}\n<b>tid:</b> ${tid}\n<b>来源集合:</b> ${collection}\n<b>磁力链接:</b> <code>${magnet}</code>`;
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
  if (!COVER_WORKER_URL) return null;
  try {
    let url = COVER_WORKER_URL.includes('{number}') 
      ? COVER_WORKER_URL.replace('{number}', encodeURIComponent(number)) 
      : `${COVER_WORKER_URL}/${encodeURIComponent(number)}`;

    const resp = await axios.get(url, { 
      timeout: 5000, 
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': COVER_WORKER_URL
      }
    });

    if (resp.data) {
      if (typeof resp.data === 'string' && resp.data.startsWith('http')) return resp.data;
      if (typeof resp.data === 'object' && resp.data.url) return resp.data.url;
      if (typeof resp.data === 'object' && resp.data.imageUrl) return resp.data.imageUrl;
    }
    return null;
  } catch (error) {
    logErr('Worker封面获取失败:', error.message);
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
  } catch { return null; }
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
  } catch { return null; }
}

async function getDmmCover(number) {
  try {
    const url = `https://www.dmm.co.jp/digital/videoa/-/search/=/searchstr=${encodeURIComponent(number)}/`;
    const resp = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
    const $ = cheerio.load(resp.data);
    const cover = $('.tmb img').first().attr('src');
    return cover || null;
  } catch { return null; }
}

async function getCoverWithCache(number, retries = 2) {
  cleanExpiredCache();
  const cached = coverCache.get(number);
  if (cached && Date.now() - cached.time < COVER_TTL) return cached.url;

  const sources = [];
  if (COVER_WORKER_URL) sources.push(getWorkerCover);
  sources.push(getDmmCover, getJavDbCover, getSehuatangCover);
  if (!COVER_WORKER_URL) sources.unshift(getJavDbCover);

  const results = await Promise.all(sources.map(fn => fn(number)));
  const cover = results.find(url => url && url !== '');
  
  if (cover && await validateImageUrl(cover)) {
    coverCache.set(number, { url: cover, time: Date.now() });
    saveCache();
    return cover;
  }

  if (!cover && retries > 0) {
    log(`🔄 封面获取失败，重试中: ${number} (${retries}次剩余)`);
    return getCoverWithCache(number, retries - 1);
  }

  log(`❌ 未获取到有效封面: ${number}`);
  return null;
}

// ========== 本地发送封面 ==========
const tmpDir = path.join(__dirname, 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });

async function sendPhotoFromUrl(ctx, url, caption) {
  try {
    const resp = await axios.get(url, { 
      responseType: 'arraybuffer', 
      timeout: 10000, 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': COVER_WORKER_URL || url
      }
    });

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

// ========== 分类命令映射 ==========
const databaseMappings = {
  'a_hd_chinese': 'hd_chinese_subtitles',
  'a_amateur': 'EU_US_no_mosaic',
  'a_asia_censored': 'asia_codeless_originate',
  'a_asia_uncensored': 'asia_mosaic_originate',
  'a_anime': 'online_originate',
  'a_vr': 'vr_video',
  'a_4k': '4k_video',
  'a_domestic': 'domestic_original',
  'a_eu_us': 'european_american_no_mosaic',
  'a_three_level': 'three_levels_photo',
  'a_korean': 'korean_anchor',
  'a_other': 'other_collections'
};

const commandHandlers = {
  'a_hd_chinese': '高清中文字幕',
  'a_amateur': '素人有码系列',
  'a_asia_censored': '亚洲有码原创',
  'a_asia_uncensored': '亚洲无码原创',
  'a_anime': '动漫原创',
  'a_vr': 'VR',
  'a_4k': '4K',
  'a_domestic': '国产原创',
  'a_eu_us': '欧美无码',
  'a_three_level': '三级写真',
  'a_korean': '韩国主播',
  'a_other': '其他'
};

// ========== 分类推荐处理 ==========
async function handleCategoryRecommendation(ctx, category) {
  try {
    await connectDB();
    const commandKey = Object.keys(commandHandlers).find(key => commandHandlers[key] === category);
    if (!commandKey) return ctx.reply('❌ 无效的分类');
    const collectionName = databaseMappings[commandKey];
    if (!collectionName) return ctx.reply('❌ 未找到对应的数据集合');

    const loadingMsg = await ctx.reply(`🔄 正在获取【${category}】推荐...`);
    const results = await db.collection(collectionName).aggregate([{ $sample: { size: 10 } }]).toArray();
    if (results.length > 0) {
      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
      await ctx.reply(`🎉 为您推荐【${category}】内容（${results.length}条）：`);
      for (const doc of results) {
        const number = escapeHtml(doc.number || 'N/A');
        const title = escapeHtml(doc.title || '无标题');
        const magnet = escapeHtml(doc.magnet || 'N/A');
        const imageUrl = await getCoverWithCache(number);
        const message = `<b>${category}推荐</b>\n\n<b>标题:</b> ${title}\n<b>番号:</b> ${number}\n<b>磁力链接:</b> <code>${magnet}</code>`;
        if (imageUrl) await sendPhotoFromUrl(ctx, imageUrl, message);
        else await ctx.reply(message, { parse_mode: 'HTML' });
        await new Promise(r => setTimeout(r, 500));
      }
    } else {
      await ctx.reply(`❌ 【${category}】内容为空或未找到数据`);
    }
  } catch (err) {
    logErr('推荐错误:', err);
    ctx.reply('⚠️ 获取推荐内容出错，请稍后再试');
  }
}

// ========== 启动命令 ==========
bot.start(ctx => {
  if (!isAllowed(ctx.from.id)) return ctx.reply('❌ 无权限');

  const menuCommands = Object.keys(commandHandlers).map(key => ({
    command: key,
    description: commandHandlers[key]
  }));

  bot.telegram.setMyCommands(menuCommands).catch(err => logErr('⚠️ 设置菜单命令失败:', err.description || err.message));

  ctx.reply('欢迎使用全库搜索机器人！\n\n使用说明：\n• 发送番号即可搜索\n• 使用左侧菜单选择分类推荐\n• 点击"/"查看所有可用命令',
    Markup.keyboard([['📋 查看所有命令'], ['🔍 搜索帮助']]).resize()
  );
});

// ========== 帮助命令 ==========
bot.command('help', ctx => {
  if (!isAllowed(ctx.from.id)) return ctx.reply('❌ 无权限');

  let helpText = '📋 <b>可用命令：</b>\n\n';
  helpText += '• 直接发送番号 - 搜索资源\n';
  helpText += '• /start - 开始使用\n';
  helpText += '• /help - 显示帮助\n\n';

  helpText += '🎯 <b>分类推荐命令：</b>\n';
  Object.entries(commandHandlers).forEach(([command, description]) => {
    helpText += `• /${command} - ${description}推荐\n`;
  });

  helpText += '\nℹ️ <b>使用说明：</b>\n';
  helpText += '• 发送番号即可搜索，例如：ABP-123\n';
  helpText += '• 使用左侧菜单选择分类推荐\n';
  helpText += '• 点击"/"查看所有可用命令\n';
  helpText += '• 每次搜索最多显示前5条结果\n';
  helpText += '• 封面将优先使用Worker封面服务，如未配置，将使用备用源获取\n';
  helpText += '• 本地未找到番号时，会尝试抓取封面作为参考\n';

  ctx.reply(helpText, { parse_mode: 'HTML' });
});

// ========== 处理菜单命令 ==========
Object.keys(commandHandlers).forEach(command => {
  bot.command(command, async ctx => {
    if (!isAllowed(ctx.from.id)) return ctx.reply('❌ 无权限');
    await handleCategoryRecommendation(ctx, commandHandlers[command]);
  });
});

// ========== 处理文本消息 ==========
bot.on('text', async ctx => {
  const userId = ctx.from.id;
  if (!isAllowed(userId)) return;
  const text = ctx.message.text.trim();

  if (text === '📋 查看所有命令') {
    return ctx.reply('请输入 /help 查看所有可用命令');
  }
  if (text === '🔍 搜索帮助') {
    return ctx.reply('直接在聊天框中输入番号即可搜索，例如：ABP-123');
  }

  if (!text || text.startsWith('/') || text.length > 50) return;

  log(`🔎 用户 ${userId} 搜索: ${text}`);

  try {
    await connectDB();
    ctx.sendChatAction('typing');
    let results = await searchAllCollections(text);

    if (results.length > 0) {
      if (results.length > 5) {
        await ctx.reply(`找到 ${results.length} 条结果，只显示前5条...`);
        results = results.slice(0, 5);
      }

      for (const { doc, name } of results) {
        const message = buildMessage(doc, name);
        const imageUrl = doc.img?.[0] || doc.cover || await getCoverWithCache(text);
        if (imageUrl) {
          if (await validateImageUrl(imageUrl)) {
            try {
              await ctx.replyWithPhoto(imageUrl, { caption: message, parse_mode: 'HTML' });
              log(`📸 已发送远程封面: ${imageUrl}`);
            } catch {
              await sendPhotoFromUrl(ctx, imageUrl, message);
            }
          } else {
            await sendPhotoFromUrl(ctx, imageUrl, message);
          }
        } else {
          await ctx.reply(message, { parse_mode: 'HTML' });
        }
      }
    } else {
      const fallbackMsg = `<b>ℹ️ 找到番号: ${escapeHtml(text)}</b>\n❌ 本地未找到`;
      const imageUrl = await getCoverWithCache(text);
      if (imageUrl) await sendPhotoFromUrl(ctx, imageUrl, fallbackMsg);
      else await ctx.reply(fallbackMsg, { parse_mode: 'HTML' });
    }
  } catch (err) {
    logErr('搜索错误:', err);
    ctx.reply('⚠️ 搜索出错，请稍后再试');
  }
});

// ========== 错误处理 ==========
bot.catch((err, ctx) => {
  logErr('Bot 错误:', err);
  ctx.reply('❌ 发生错误，请稍后再试');
});

// ========== 优雅关闭 ==========
process.once('SIGINT', async () => {
  await bot.stop('SIGINT');
  await client.close();
  logStream.end();
  process.exit(0);
});

process.once('SIGTERM', async () => {
  await bot.stop('SIGTERM');
  await client.close();
  logStream.end();
  process.exit(0);
});

// ========== 启动 ==========
bot.launch().then(() => {
  log('✅ Bot 已启动');
  if (COVER_WORKER_URL) {
    log(`✅ 已配置Worker封面服务: ${COVER_WORKER_URL}`);
  } else {
    log('ℹ️ 未配置Worker封面服务，将使用备用源获取封面');
  }
});










