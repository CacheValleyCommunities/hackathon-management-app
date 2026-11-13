FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Create directories for uploads and SQLite data with proper permissions.
# Application code stays in db/; only /app/data is volume-mounted.
RUN mkdir -p public/uploads/screenshots db data && \
    chmod -R 755 db data public/uploads

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]

