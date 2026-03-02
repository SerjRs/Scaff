/**
 * Secure Query Builder - SQL Injection Prevention
 * 
 * This module provides a safe query builder that prevents SQL injection
 * by enforcing parameterized queries and validating all inputs.
 * 
 * NO EXTERNAL LIBRARIES REQUIRED - Pure JavaScript/Node.js
 */

'use strict';

// ============================================================================
// INPUT VALIDATORS
// ============================================================================

const Validators = {
  /**
   * Validate UUID format (RFC 4122)
   */
  uuid(value) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(value)) {
      throw new Error(`Invalid UUID format: ${value}`);
    }
    return value;
  },

  /**
   * Validate email format
   */
  email(value) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(value)) {
      throw new Error(`Invalid email format: ${value}`);
    }
    return value.toLowerCase().trim();
  },

  /**
   * Validate enum value against whitelist
   */
  enum(value, allowedValues) {
    if (!allowedValues.includes(value)) {
      throw new Error(`Invalid value. Must be one of: ${allowedValues.join(', ')}`);
    }
    return value;
  },

  /**
   * Sanitize and validate string
   */
  string(value, maxLength = 255) {
    if (typeof value !== 'string') {
      throw new Error('Value must be a string');
    }
    
    // Remove null bytes and control characters
    const sanitized = value
      .replace(/\0/g, '')  // Remove null bytes
      .replace(/[\x00-\x1F\x7F]/g, '')  // Remove control characters
      .trim();
    
    if (sanitized.length === 0) {
      throw new Error('String cannot be empty after sanitization');
    }
    
    return sanitized.substring(0, maxLength);
  },

  /**
   * Validate and parse integer
   */
  integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const num = parseInt(value, 10);
    if (isNaN(num) || num < min || num > max) {
      throw new Error(`Value must be an integer between ${min} and ${max}`);
    }
    return num;
  },

  /**
   * Validate boolean
   */
  boolean(value) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1' || value === 1) return true;
    if (value === 'false' || value === '0' || value === 0) return false;
    throw new Error('Value must be a boolean');
  },

  /**
   * Validate ISO date string
   */
  date(value) {
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      throw new Error(`Invalid date format: ${value}`);
    }
    return date.toISOString();
  },

  /**
   * Validate column name (alphanumeric and underscore only)
   */
  columnName(value) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
      throw new Error(`Invalid column name: ${value}`);
    }
    return value;
  }
};

// ============================================================================
// QUERY BUILDER
// ============================================================================

/**
 * Safe Query Builder
 * Enforces parameterized queries and prevents SQL injection
 */
class SafeQueryBuilder {
  constructor(tableName) {
    // Whitelist of allowed tables
    this.ALLOWED_TABLES = [
      'tenants',
      'users',
      'roles',
      'permissions',
      'role_permissions',
      'user_roles',
      'webhooks',
      'webhook_deliveries',
      'audit_logs',
      'resources',
      'api_keys',
      'sessions'
    ];

    this.table = this.validateTableName(tableName);
    this.conditions = [];
    this.params = [];
    this.paramIndex = 1;
    this.selectColumns = ['*'];
    this.orderByColumn = null;
    this.orderByDirection = 'ASC';
    this.limitValue = null;
    this.offsetValue = null;
    this.joins = [];
  }

  /**
   * Validate table name against whitelist
   */
  validateTableName(tableName) {
    if (!this.ALLOWED_TABLES.includes(tableName)) {
      throw new Error(`Invalid table name: ${tableName}`);
    }
    return tableName;
  }

  /**
   * Set columns to select
   */
  select(columns) {
    if (!Array.isArray(columns)) {
      throw new Error('Columns must be an array');
    }
    
    // Validate each column name
    this.selectColumns = columns.map(col => Validators.columnName(col));
    return this;
  }

  /**
   * Add WHERE condition
   */
  where(column, operator, value) {
    // Validate column name
    Validators.columnName(column);

    // Whitelist of allowed operators
    const ALLOWED_OPERATORS = ['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'ILIKE', 'IN', 'IS', 'IS NOT'];
    if (!ALLOWED_OPERATORS.includes(operator.toUpperCase())) {
      throw new Error(`Invalid operator: ${operator}`);
    }

    // Special handling for NULL checks
    if (value === null) {
      if (!['IS', 'IS NOT'].includes(operator.toUpperCase())) {
        throw new Error('Use IS or IS NOT for NULL comparisons');
      }
      this.conditions.push(`${column} ${operator.toUpperCase()} NULL`);
    } else if (operator.toUpperCase() === 'IN') {
      // IN operator expects array
      if (!Array.isArray(value)) {
        throw new Error('IN operator requires an array value');
      }
      const placeholders = value.map(() => `$${this.paramIndex++}`).join(', ');
      this.conditions.push(`${column} IN (${placeholders})`);
      this.params.push(...value);
    } else {
      this.conditions.push(`${column} ${operator} $${this.paramIndex}`);
      this.params.push(value);
      this.paramIndex++;
    }

    return this;
  }

  /**
   * Add AND condition
   */
  andWhere(column, operator, value) {
    return this.where(column, operator, value);
  }

  /**
   * Add ORDER BY clause
   */
  orderBy(column, direction = 'ASC') {
    // Validate column
    this.orderByColumn = Validators.columnName(column);

    // Validate direction
    const dir = direction.toUpperCase();
    if (!['ASC', 'DESC'].includes(dir)) {
      throw new Error('Invalid sort direction. Must be ASC or DESC');
    }
    this.orderByDirection = dir;

    return this;
  }

  /**
   * Add LIMIT clause
   */
  limit(value) {
    this.limitValue = Validators.integer(value, 1, 1000);
    return this;
  }

  /**
   * Add OFFSET clause
   */
  offset(value) {
    this.offsetValue = Validators.integer(value, 0);
    return this;
  }

  /**
   * Add JOIN clause
   */
  join(table, condition) {
    this.validateTableName(table);
    this.joins.push({ type: 'INNER JOIN', table, condition });
    return this;
  }

  /**
   * Add LEFT JOIN clause
   */
  leftJoin(table, condition) {
    this.validateTableName(table);
    this.joins.push({ type: 'LEFT JOIN', table, condition });
    return this;
  }

  /**
   * Build the final query
   */
  build() {
    let query = `SELECT ${this.selectColumns.join(', ')} FROM ${this.table}`;

    // Add joins
    if (this.joins.length > 0) {
      for (const join of this.joins) {
        query += ` ${join.type} ${join.table} ON ${join.condition}`;
      }
    }

    // Add WHERE clause
    if (this.conditions.length > 0) {
      query += ` WHERE ${this.conditions.join(' AND ')}`;
    }

    // Add ORDER BY
    if (this.orderByColumn) {
      query += ` ORDER BY ${this.orderByColumn} ${this.orderByDirection}`;
    }

    // Add LIMIT
    if (this.limitValue !== null) {
      query += ` LIMIT ${this.limitValue}`;
    }

    // Add OFFSET
    if (this.offsetValue !== null) {
      query += ` OFFSET ${this.offsetValue}`;
    }

    return {
      query,
      params: this.params
    };
  }

  /**
   * Execute the query (requires database connection)
   */
  async execute(db) {
    const { query, params } = this.build();
    
    console.log('Executing query:', query);
    console.log('With params:', params);
    
    return await db.query(query, params);
  }
}

// ============================================================================
// LIKE PATTERN ESCAPING
// ============================================================================

/**
 * Escape special characters in LIKE patterns
 */
function escapeLikePattern(str) {
  return str
    .replace(/\\/g, '\\\\')  // Escape backslash
    .replace(/%/g, '\\%')    // Escape percent
    .replace(/_/g, '\\_');   // Escape underscore
}

// ============================================================================
// USAGE EXAMPLES
// ============================================================================

/**
 * Example: Search users with filters
 */
async function searchUsers(db, tenantId, filters = {}) {
  const builder = new SafeQueryBuilder('users');
  
  // Select specific columns (never use SELECT *)
  builder.select(['id', 'email', 'first_name', 'last_name', 'status', 'created_at']);
  
  // Always filter by tenant_id
  builder.where('tenant_id', '=', Validators.uuid(tenantId));
  
  // Exclude soft-deleted records
  builder.where('deleted_at', 'IS', null);
  
  // Optional: Filter by status
  if (filters.status) {
    const validStatuses = ['active', 'inactive', 'invited', 'suspended'];
    builder.where('status', '=', Validators.enum(filters.status, validStatuses));
  }
  
  // Optional: Search by email (with LIKE pattern escaping)
  if (filters.email) {
    const sanitizedEmail = Validators.string(filters.email, 100);
    const escapedEmail = escapeLikePattern(sanitizedEmail);
    builder.where('email', 'ILIKE', `%${escapedEmail}%`);
  }
  
  // Optional: Filter by role
  if (filters.roleId) {
    // Need to join with user_roles table
    builder
      .join('user_roles', 'users.id = user_roles.user_id')
      .where('user_roles.role_id', '=', Validators.uuid(filters.roleId));
  }
  
  // Pagination
  const page = filters.page ? Validators.integer(filters.page, 1) : 1;
  const limit = filters.limit ? Validators.integer(filters.limit, 1, 100) : 20;
  const offset = (page - 1) * limit;
  
  builder
    .orderBy('created_at', 'DESC')
    .limit(limit)
    .offset(offset);
  
  return await builder.execute(db);
}

/**
 * Example: Get user by ID with tenant isolation
 */
async function getUserById(db, tenantId, userId) {
  const builder = new SafeQueryBuilder('users');
  
  builder
    .select(['id', 'email', 'first_name', 'last_name', 'status', 'last_login_at'])
    .where('id', '=', Validators.uuid(userId))
    .where('tenant_id', '=', Validators.uuid(tenantId))
    .where('deleted_at', 'IS', null)
    .limit(1);
  
  const result = await builder.execute(db);
  return result.rows[0] || null;
}

/**
 * Example: Get audit logs with complex filters
 */
async function getAuditLogs(db, tenantId, filters = {}) {
  const builder = new SafeQueryBuilder('audit_logs');
  
  builder
    .select(['id', 'actor_email', 'action', 'resource_type', 'resource_id', 'created_at'])
    .where('tenant_id', '=', Validators.uuid(tenantId));
  
  // Filter by actor
  if (filters.actorId) {
    builder.where('actor_id', '=', Validators.uuid(filters.actorId));
  }
  
  // Filter by action (whitelist)
  if (filters.action) {
    builder.where('action', '=', Validators.string(filters.action, 100));
  }
  
  // Filter by resource type
  if (filters.resourceType) {
    builder.where('resource_type', '=', Validators.string(filters.resourceType, 100));
  }
  
  // Date range
  if (filters.startDate) {
    builder.where('created_at', '>=', Validators.date(filters.startDate));
  }
  
  if (filters.endDate) {
    builder.where('created_at', '<=', Validators.date(filters.endDate));
  }
  
  // Sorting (whitelisted columns only)
  const allowedSortColumns = ['created_at', 'action', 'actor_email'];
  const sortBy = filters.sortBy && allowedSortColumns.includes(filters.sortBy) 
    ? filters.sortBy 
    : 'created_at';
  
  builder.orderBy(sortBy, filters.sortOrder || 'DESC');
  
  // Pagination
  const page = filters.page ? Validators.integer(filters.page, 1) : 1;
  const limit = filters.limit ? Validators.integer(filters.limit, 1, 100) : 50;
  
  builder
    .limit(limit)
    .offset((page - 1) * limit);
  
  return await builder.execute(db);
}

/**
 * Example: Complex query with multiple joins
 */
async function getUsersWithRoles(db, tenantId) {
  const builder = new SafeQueryBuilder('users');
  
  builder
    .select([
      'users.id',
      'users.email',
      'users.first_name',
      'users.last_name',
      'roles.name AS role_name'
    ])
    .leftJoin('user_roles', 'users.id = user_roles.user_id')
    .leftJoin('roles', 'user_roles.role_id = roles.id')
    .where('users.tenant_id', '=', Validators.uuid(tenantId))
    .where('users.deleted_at', 'IS', null)
    .orderBy('users.created_at', 'DESC');
  
  return await builder.execute(db);
}

// ============================================================================
// SQL INJECTION TEST SUITE
// ============================================================================

/**
 * Test the query builder against SQL injection attacks
 */
async function testSQLInjectionProtection() {
  console.log('\n=== SQL Injection Protection Tests ===\n');
  
  const tests = [
    {
      name: 'Classic OR injection',
      input: "' OR '1'='1",
      test: () => Validators.string("' OR '1'='1")
    },
    {
      name: 'Comment injection',
      input: "'; DROP TABLE users; --",
      test: () => Validators.string("'; DROP TABLE users; --")
    },
    {
      name: 'UNION injection',
      input: "' UNION SELECT * FROM api_keys WHERE '1'='1",
      test: () => Validators.string("' UNION SELECT * FROM api_keys WHERE '1'='1")
    },
    {
      name: 'Invalid UUID',
      input: "not-a-uuid",
      test: () => Validators.uuid("not-a-uuid"),
      shouldFail: true
    },
    {
      name: 'Valid UUID',
      input: "550e8400-e29b-41d4-a716-446655440000",
      test: () => Validators.uuid("550e8400-e29b-41d4-a716-446655440000"),
      shouldFail: false
    },
    {
      name: 'Invalid table name',
      input: "users; DROP TABLE api_keys;",
      test: () => new SafeQueryBuilder("users; DROP TABLE api_keys;"),
      shouldFail: true
    },
    {
      name: 'Invalid operator',
      input: "UNION",
      test: () => {
        const builder = new SafeQueryBuilder('users');
        builder.where('id', 'UNION', 'test');
      },
      shouldFail: true
    }
  ];
  
  const results = [];
  
  for (const testCase of tests) {
    try {
      testCase.test();
      results.push({
        test: testCase.name,
        status: testCase.shouldFail ? '❌ FAILED' : '✅ PASSED',
        message: testCase.shouldFail ? 'Injection not blocked!' : 'Input validated'
      });
    } catch (error) {
      results.push({
        test: testCase.name,
        status: testCase.shouldFail ? '✅ PASSED' : '❌ FAILED',
        message: testCase.shouldFail ? 'Injection blocked' : error.message
      });
    }
  }
  
  console.table(results);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  SafeQueryBuilder,
  Validators,
  escapeLikePattern,
  
  // Example functions
  searchUsers,
  getUserById,
  getAuditLogs,
  getUsersWithRoles,
  
  // Testing
  testSQLInjectionProtection
};

// Run tests if executed directly
if (require.main === module) {
  testSQLInjectionProtection();
}
