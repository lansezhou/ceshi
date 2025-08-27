# Telegram 番号搜索机器人

基于Node.js + Telegraf + MongoDB的番号搜索机器人，支持全库搜索和DMM封面获取。

## 功能特性

- 🔍 全数据库集合搜索
- 🖼️ DMM高质量封面获取
- 🔄 透明代理/程序代理双模式
- 🐳 Docker容器化部署
- 📊 多字段名兼容搜索

## 部署步骤


 构建Docker镜像：`docker build -t tg-bot-searcher .`
 运行容器：`docker run -d --name tg-bot-searcher tg-bot-searcher`

## 配置说明
MONGODB_URI =  数据库地址
BOT_TOKEN = TG机器人token
ALLOWED_TG_IDS = TG id  白名单用的
USE_PROXY = false  默认代理关闭
/logs:/usr/src/app/logs   日志映射
