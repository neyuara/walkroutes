const { Pool } = require('pg');

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgres://walk:walk@localhost:5432/walkroutes',
});

module.exports = pool;
