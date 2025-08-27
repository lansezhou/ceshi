FROM node:20-slim

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --only=production

COPY . .

# 创建必要的目录
RUN mkdir -p config logs tmp

# 设置环境变量（可选，用于初始化）
ENV BOT_TOKEN=your_default_bot_token_here
ENV MONGODB_URI=mongodb://username:password@localhost:27017/sehuatang?authSource=sehuatang
ENV EXCLUDE_COLLECTIONS=system.indexes,system.views,admin,local
ENV ALLOWED_TG_IDS=6700617938,123456789
ENV DEFAULT_SAVE_DIR=/tmp

# 设置正确的文件权限
RUN chmod -R 755 logs tmp

CMD ["node", "app.js"]
