const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is not defined.');
}

function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role === 'worker') {
      return res.status(403).json({ error: 'Access denied. Administrator privileges required.' });
    }
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function authenticateWorker(db) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    const token = authHeader.split(' ')[1];

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.role !== 'worker') {
        return res.status(403).json({ error: 'Access denied. Worker privileges required.' });
      }

      // Check if worker is still active
      const result = await db.execute({
        sql: 'SELECT is_active FROM workers WHERE id = ?',
        args: [decoded.id]
      });
      const worker = result.rows[0];
      if (!worker || worker.is_active === 0) {
        return res.status(403).json({ error: 'Access denied. Worker account is deactivated.' });
      }

      req.worker = decoded;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }
  };
}

module.exports = { authenticateAdmin, authenticateWorker, JWT_SECRET };
