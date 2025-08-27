FROM node:20-slim

WORKDIR /usr/src/app

# 先拷贝 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖（production）
RUN npm install --only=production

# 再拷贝整个项目
COPY . .

# 创建必要的目录
RUN mkdir -p config logs tmp

# 设置环境变量
ENV BOT_TOKEN=your_default_bot_token_here
ENV MONGODB_URI=mongodb://username:password@localhost:27017/sehuatang?authSource=sehuatang
ENV EXCLUDE_COLLECTIONS=system.indexes,system.views,admin,local
ENV ALLOWED_TG_IDS=6700617938,123456789
ENV DEFAULT_SAVE_DIR=/tmp

# 设置正确的文件权限
RUN chmod -R 755 logs tmp

# 强制刷新 npm 缓存并确认 nanoid 安装成功
RUN npm install nanoid --production

# 启动
CMD ["node", "app.js"]
