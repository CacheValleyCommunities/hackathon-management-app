FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Create directories for uploads and database
RUN mkdir -p public/uploads/screenshots db

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]

