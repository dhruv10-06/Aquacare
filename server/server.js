require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { getDatabase } = require('./db/setup');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database client
const db = getDatabase();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded images (local only)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve frontend (local only, Vercel handles static files via vercel.json)
app.use(express.static(path.join(__dirname, '..', 'public')));

// API Routes
const complaintsRouter = require('./routes/complaints')(db);
const adminRouter = require('./routes/admin')(db);

app.use('/api/complaints', complaintsRouter);
app.use('/api/admin', adminRouter);

// Health check (preserved from original)
app.get('/api/health', (req, res) => {
  res.json({ message: 'AquaCare server is running!' });
});

// Serve frontend for all non-API routes (SPA-style)
app.get('{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Start server locally if not in serverless environment
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`AquaCare server is running at http://localhost:${PORT}`);
  });
}

// Export for Vercel
module.exports = app;
