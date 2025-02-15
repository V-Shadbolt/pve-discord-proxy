ARG NODE=node
ARG NODE_VERSION=18-alpine
FROM ${NODE}:${NODE_VERSION}

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .

# Create logs directory
RUN mkdir -p logs

# Expose port
EXPOSE 80

# Start the application
CMD ["node", "app.js"]