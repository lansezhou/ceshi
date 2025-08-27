const requiredEnvVars = ['BOT_TOKEN', 'MONGODB_URI'];

requiredEnvVars.forEach(envVar => {
  if (!process.env[envVar] || process.env[envVar].includes('your_default_')) {
    console.error(`错误：缺少必需的环境变量 ${envVar}。请在运行容器或环境中设置。`);
    process.exit(1);
  }
});

const excludeCollections = process.env.EXCLUDE_COLLECTIONS
  ? process.env.EXCLUDE_COLLECTIONS.split(',').map(item => item.trim())
  : ['system.indexes', 'system.views', 'admin', 'local'];

const allowedTgIds = process.env.ALLOWED_TG_IDS
  ? process.env.ALLOWED_TG_IDS.split(',').map(id => id.trim())
  : [];

module.exports = {
  botToken: process.env.BOT_TOKEN,
  mongodbUri: process.env.MONGODB_URI,
  excludeCollections,
  allowedTgIds,
  defaultSaveDir: process.env.DEFAULT_SAVE_DIR || '/tmp',
};
