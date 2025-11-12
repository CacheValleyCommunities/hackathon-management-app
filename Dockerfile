FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Create directories for uploads and database with proper permissions
RUN mkdir -p public/uploads/screenshots db && \
    chmod -R 755 db public/uploads

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]

