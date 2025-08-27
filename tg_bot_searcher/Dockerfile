FROM node:20-slim

WORKDIR /usr/src/app

# 拷贝依赖文件
COPY package*.json ./

# 安装生产依赖
RUN npm install --only=production

# 拷贝项目文件
COPY . .

# 创建必要目录
RUN mkdir -p config logs tmp

# 设置权限
RUN chmod -R 755 logs tmp

# 环境变量
ENV BOT_TOKEN=your_default_bot_token_here
ENV MONGODB_URI=mongodb://username:password@localhost:27017/sehuatang?authSource=sehuatang
ENV EXCLUDE_COLLECTIONS=system.indexes,system.views,admin,local
ENV ALLOWED_TG_IDS=6700617938,123456789
ENV DEFAULT_SAVE_DIR=/tmp

# 启动
CMD ["node", "app.js"]
