# Security Vulnerability Analysis - SQL Injection Focus

## Executive Summary

This document analyzes **SQL injection vulnerabilities** in the multi-tenant SaaS platform architecture and provides mitigation strategies **without relying on external libraries**.

## SQL Injection Risk Areas

### Critical Risk Points

1. **Dynamic tenant isolation queries**
2. **Search and filtering endpoints**
3. **Audit log queries with user-provided filters**
4. **Webhook delivery queries**
5. **Permission checking queries**

---

## Vulnerability Analysis by Component

### 1. Tenant Context Extraction

#### ❌ VULNERABLE CODE

```javascript
// BAD: String concatenation with user input
async function setTenantContext(tenantId) {
  await db.query("SET app.current_tenant_id = '" + tenantId + "'");
}
```

**Attack vector**: If `tenantId` is user-controlled:
```
tenantId = "'; DROP TABLE users; --"
// Executes: SET app.current_tenant_id = ''; DROP TABLE users; --'
```

#### ✅ SECURE FIX

```javascript
// GOOD: Parameterized query
async function setTenantContext(tenantId) {
  // Validate UUID format first
  if (!isValidUUID(tenantId)) {
    throw new Error('Invalid tenant ID format');
  }
  
  // Use parameterized query
  await db.query("SET app.current_tenant_id = $1", [tenantId]);
}

// UUID validation without external libraries
function isValidUUID(str) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}
```

**Mitigation strategies**:
1. ✅ Parameterized queries
2. ✅ Input validation (UUID format)
3. ✅ Type checking

---

### 2. User Search/Filter Queries

#### ❌ VULNERABLE CODE

```javascript
// BAD: Dynamic WHERE clause construction
async function searchUsers(tenantId, filters) {
  let query = `SELECT * FROM users WHERE tenant_id = '${tenantId}'`;
  
  if (filters.email) {
    query += ` AND email LIKE '%${filters.email}%'`;
  }
  
  if (filters.status) {
    query += ` AND status = '${filters.status}'`;
  }
  
  return await db.query(query);
}
```

**Attack vector**:
```
filters.email = "' OR '1'='1"
// Executes: SELECT * FROM users WHERE tenant_id = '...' AND email LIKE '%' OR '1'='1%'
// Returns all users across all tenants!
```

#### ✅ SECURE FIX

```javascript
// GOOD: Parameterized query with safe filter building
async function searchUsers(tenantId, filters) {
  const params = [tenantId];
  const conditions = ['tenant_id = $1', 'deleted_at IS NULL'];
  let paramIndex = 2;
  
  // Email filter
  if (filters.email) {
    conditions.push(`email ILIKE $${paramIndex}`);
    params.push(`%${sanitizeString(filters.email)}%`);
    paramIndex++;
  }
  
  // Status filter with whitelist
  if (filters.status) {
    const validStatuses = ['active', 'inactive', 'invited', 'suspended'];
    if (!validStatuses.includes(filters.status)) {
      throw new Error('Invalid status value');
    }
    conditions.push(`status = $${paramIndex}`);
    params.push(filters.status);
    paramIndex++;
  }
  
  const query = `
    SELECT id, email, first_name, last_name, status, created_at
    FROM users
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT 100
  `;
  
  return await db.query(query, params);
}

// String sanitization without external libraries
function sanitizeString(input) {
  if (typeof input !== 'string') {
    throw new Error('Input must be a string');
  }
  
  // Remove null bytes and control characters
  return input
    .replace(/\0/g, '')  // Remove null bytes
    .replace(/[\x00-\x1F\x7F]/g, '')  // Remove control characters
    .trim()
    .substring(0, 255);  // Limit length
}
```

**Mitigation strategies**:
1. ✅ Parameterized queries only
2. ✅ Whitelist validation for enums
3. ✅ Input sanitization
4. ✅ Length limits
5. ✅ Explicit column selection (not SELECT *)

---

### 3. Audit Log Queries with Dynamic Filters

#### ❌ VULNERABLE CODE

```javascript
// BAD: Dynamic ORDER BY clause
async function getAuditLogs(tenantId, sortBy, sortOrder) {
  const query = `
    SELECT * FROM audit_logs
    WHERE tenant_id = '${tenantId}'
    ORDER BY ${sortBy} ${sortOrder}
  `;
  
  return await db.query(query);
}
```

**Attack vector**:
```
sortBy = "created_at; DROP TABLE audit_logs; --"
sortOrder = "DESC"
// Executes: SELECT * FROM audit_logs WHERE tenant_id = '...' ORDER BY created_at; DROP TABLE audit_logs; -- DESC
```

#### ✅ SECURE FIX

```javascript
// GOOD: Whitelist-based dynamic sorting
async function getAuditLogs(tenantId, options = {}) {
  // Validate tenant_id
  if (!isValidUUID(tenantId)) {
    throw new Error('Invalid tenant ID');
  }
  
  // Whitelist for sortable columns
  const ALLOWED_SORT_COLUMNS = {
    'created_at': 'created_at',
    'action': 'action',
    'actor_email': 'actor_email',
    'resource_type': 'resource_type'
  };
  
  // Whitelist for sort order
  const ALLOWED_SORT_ORDERS = ['ASC', 'DESC'];
  
  // Validate and default sort options
  const sortColumn = ALLOWED_SORT_COLUMNS[options.sortBy] || 'created_at';
  const sortOrder = ALLOWED_SORT_ORDERS.includes(options.sortOrder?.toUpperCase()) 
    ? options.sortOrder.toUpperCase() 
    : 'DESC';
  
  // Build safe query
  const params = [tenantId];
  const conditions = ['tenant_id = $1'];
  let paramIndex = 2;
  
  // Additional filters
  if (options.actorId && isValidUUID(options.actorId)) {
    conditions.push(`actor_id = $${paramIndex}`);
    params.push(options.actorId);
    paramIndex++;
  }
  
  if (options.action) {
    conditions.push(`action = $${paramIndex}`);
    params.push(sanitizeString(options.action));
    paramIndex++;
  }
  
  if (options.startDate) {
    conditions.push(`created_at >= $${paramIndex}`);
    params.push(validateDate(options.startDate));
    paramIndex++;
  }
  
  if (options.endDate) {
    conditions.push(`created_at <= $${paramIndex}`);
    params.push(validateDate(options.endDate));
    paramIndex++;
  }
  
  // Pagination
  const page = Math.max(1, parseInt(options.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 20));
  const offset = (page - 1) * limit;
  
  const query = `
    SELECT 
      id, tenant_id, actor_id, actor_email, action,
      resource_type, resource_id, changes, metadata, created_at
    FROM audit_logs
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${sortColumn} ${sortOrder}
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;
  
  params.push(limit, offset);
  
  return await db.query(query, params);
}

// Date validation without external libraries
function validateDate(dateString) {
  const date = new Date(dateString);
  if (isNaN(date.getTime())) {
    throw new Error('Invalid date format');
  }
  return date.toISOString();
}
```

**Mitigation strategies**:
1. ✅ Whitelist for column names
2. ✅ Whitelist for sort order
3. ✅ Parameterized values
4. ✅ Date validation
5. ✅ Pagination limits

---

### 4. Dynamic Table/Column Access

#### ❌ VULNERABLE CODE

```javascript
// BAD: Dynamic table names
async function getResourcesByType(tenantId, resourceType) {
  const query = `SELECT * FROM ${resourceType} WHERE tenant_id = $1`;
  return await db.query(query, [tenantId]);
}
```

**Attack vector**:
```
resourceType = "users UNION SELECT * FROM api_keys WHERE '1'='1"
// Executes: SELECT * FROM users UNION SELECT * FROM api_keys WHERE '1'='1 WHERE tenant_id = ...
```

#### ✅ SECURE FIX

```javascript
// GOOD: Whitelist mapping for resource types
const RESOURCE_TYPE_TABLES = {
  'user': 'users',
  'resource': 'resources',
  'webhook': 'webhooks',
  'role': 'roles'
};

async function getResourcesByType(tenantId, resourceType) {
  // Validate tenant_id
  if (!isValidUUID(tenantId)) {
    throw new Error('Invalid tenant ID');
  }
  
  // Validate resource type
  const tableName = RESOURCE_TYPE_TABLES[resourceType];
  if (!tableName) {
    throw new Error('Invalid resource type');
  }
  
  // Safe query construction
  const query = `
    SELECT * FROM ${tableName}
    WHERE tenant_id = $1 AND deleted_at IS NULL
    LIMIT 100
  `;
  
  return await db.query(query, [tenantId]);
}
```

**Mitigation strategy**:
✅ Never use user input directly in table/column names
✅ Use whitelist mappings
✅ Fail closed (reject unknown types)

---

### 5. LIKE/ILIKE Pattern Injection

#### ❌ VULNERABLE CODE

```javascript
// BAD: Unescaped LIKE patterns
async function searchByName(tenantId, searchTerm) {
  const query = `
    SELECT * FROM resources
    WHERE tenant_id = $1 AND name LIKE '%${searchTerm}%'
  `;
  return await db.query(query, [tenantId]);
}
```

**Attack vector**:
```
searchTerm = "%' OR tenant_id != tenant_id OR name LIKE '%"
// Matches all records
```

#### ✅ SECURE FIX

```javascript
// GOOD: Escape LIKE special characters
async function searchByName(tenantId, searchTerm) {
  if (!isValidUUID(tenantId)) {
    throw new Error('Invalid tenant ID');
  }
  
  // Escape LIKE wildcards
  const sanitizedTerm = escapeLikePattern(sanitizeString(searchTerm));
  
  const query = `
    SELECT id, name, description, created_at
    FROM resources
    WHERE tenant_id = $1 
      AND deleted_at IS NULL
      AND name ILIKE $2
    LIMIT 50
  `;
  
  return await db.query(query, [tenantId, `%${sanitizedTerm}%`]);
}

// Escape LIKE special characters
function escapeLikePattern(str) {
  return str
    .replace(/\\/g, '\\\\')  // Escape backslash
    .replace(/%/g, '\\%')    // Escape percent
    .replace(/_/g, '\\_');   // Escape underscore
}
```

**Mitigation strategies**:
1. ✅ Escape LIKE wildcards
2. ✅ Use parameterized queries
3. ✅ Limit result sets

---

### 6. JSON/JSONB Query Injection

#### ❌ VULNERABLE CODE

```javascript
// BAD: Dynamic JSON path
async function searchByMetadata(tenantId, jsonPath, value) {
  const query = `
    SELECT * FROM resources
    WHERE tenant_id = $1 AND metadata->'${jsonPath}' = '${value}'
  `;
  return await db.query(query, [tenantId]);
}
```

**Attack vector**:
```
jsonPath = "key' OR '1'='1"
// Bypasses filters
```

#### ✅ SECURE FIX

```javascript
// GOOD: Whitelist JSON paths
const ALLOWED_METADATA_PATHS = {
  'category': ['category'],
  'tags': ['tags'],
  'priority': ['priority']
};

async function searchByMetadata(tenantId, pathKey, value) {
  if (!isValidUUID(tenantId)) {
    throw new Error('Invalid tenant ID');
  }
  
  // Validate path
  const jsonPath = ALLOWED_METADATA_PATHS[pathKey];
  if (!jsonPath) {
    throw new Error('Invalid metadata path');
  }
  
  // Build safe JSONB query
  const pathString = jsonPath.join('->');
  const query = `
    SELECT id, name, metadata, created_at
    FROM resources
    WHERE tenant_id = $1 
      AND deleted_at IS NULL
      AND metadata->$2 = $3
    LIMIT 50
  `;
  
  return await db.query(query, [tenantId, pathKey, sanitizeString(value)]);
}
```

---

## Comprehensive Prevention Strategy

### 1. Input Validation Layer

```javascript
// Validation utilities (no external libraries)
const Validators = {
  uuid: (value) => {
    const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!regex.test(value)) {
      throw new Error('Invalid UUID format');
    }
    return value;
  },
  
  email: (value) => {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!regex.test(value)) {
      throw new Error('Invalid email format');
    }
    return value.toLowerCase().trim();
  },
  
  enum: (value, allowedValues) => {
    if (!allowedValues.includes(value)) {
      throw new Error(`Value must be one of: ${allowedValues.join(', ')}`);
    }
    return value;
  },
  
  string: (value, maxLength = 255) => {
    if (typeof value !== 'string') {
      throw new Error('Value must be a string');
    }
    return sanitizeString(value).substring(0, maxLength);
  },
  
  integer: (value, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const num = parseInt(value, 10);
    if (isNaN(num) || num < min || num > max) {
      throw new Error(`Value must be an integer between ${min} and ${max}`);
    }
    return num;
  },
  
  boolean: (value) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw new Error('Value must be a boolean');
  },
  
  date: (value) => {
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      throw new Error('Invalid date format');
    }
    return date;
  }
};
```

### 2. Query Builder (Parameterized Only)

```javascript
// Safe query builder
class SafeQueryBuilder {
  constructor(table) {
    this.table = this.validateTableName(table);
    this.conditions = [];
    this.params = [];
    this.paramIndex = 1;
    this.selectColumns = ['*'];
    this.orderByColumn = null;
    this.orderByDirection = 'ASC';
    this.limitValue = null;
    this.offsetValue = null;
  }
  
  validateTableName(table) {
    const allowedTables = ['users', 'resources', 'webhooks', 'audit_logs', 'roles'];
    if (!allowedTables.includes(table)) {
      throw new Error('Invalid table name');
    }
    return table;
  }
  
  select(columns) {
    if (!Array.isArray(columns)) {
      throw new Error('Columns must be an array');
    }
    this.selectColumns = columns;
    return this;
  }
  
  where(column, operator, value) {
    // Validate column name (alphanumeric and underscore only)
    if (!/^[a-z_]+$/.test(column)) {
      throw new Error('Invalid column name');
    }
    
    // Validate operator
    const allowedOperators = ['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'ILIKE', 'IN'];
    if (!allowedOperators.includes(operator)) {
      throw new Error('Invalid operator');
    }
    
    this.conditions.push(`${column} ${operator} $${this.paramIndex}`);
    this.params.push(value);
    this.paramIndex++;
    return this;
  }
  
  orderBy(column, direction = 'ASC') {
    if (!/^[a-z_]+$/.test(column)) {
      throw new Error('Invalid column name');
    }
    if (!['ASC', 'DESC'].includes(direction.toUpperCase())) {
      throw new Error('Invalid sort direction');
    }
    this.orderByColumn = column;
    this.orderByDirection = direction.toUpperCase();
    return this;
  }
  
  limit(value) {
    this.limitValue = Validators.integer(value, 1, 1000);
    return this;
  }
  
  offset(value) {
    this.offsetValue = Validators.integer(value, 0);
    return this;
  }
  
  build() {
    let query = `SELECT ${this.selectColumns.join(', ')} FROM ${this.table}`;
    
    if (this.conditions.length > 0) {
      query += ` WHERE ${this.conditions.join(' AND ')}`;
    }
    
    if (this.orderByColumn) {
      query += ` ORDER BY ${this.orderByColumn} ${this.orderByDirection}`;
    }
    
    if (this.limitValue !== null) {
      query += ` LIMIT ${this.limitValue}`;
    }
    
    if (this.offsetValue !== null) {
      query += ` OFFSET ${this.offsetValue}`;
    }
    
    return { query, params: this.params };
  }
}

// Usage example
async function getUsers(tenantId, filters) {
  const builder = new SafeQueryBuilder('users')
    .select(['id', 'email', 'first_name', 'last_name', 'status'])
    .where('tenant_id', '=', Validators.uuid(tenantId))
    .where('deleted_at', '=', null);
  
  if (filters.status) {
    builder.where('status', '=', Validators.enum(filters.status, ['active', 'inactive']));
  }
  
  if (filters.email) {
    builder.where('email', 'ILIKE', `%${Validators.string(filters.email, 100)}%`);
  }
  
  builder.orderBy('created_at', 'DESC').limit(50);
  
  const { query, params } = builder.build();
  return await db.query(query, params);
}
```

### 3. Database Access Layer with Built-in Protection

```javascript
// Secure database wrapper
class SecureDatabase {
  constructor(dbConnection) {
    this.db = dbConnection;
  }
  
  // Force parameterized queries
  async query(sql, params = []) {
    // Detect potential SQL injection patterns
    if (this.containsSQLInjectionPattern(sql)) {
      throw new Error('Potential SQL injection detected');
    }
    
    // Ensure parameterized query
    if (sql.includes("'") && params.length === 0) {
      throw new Error('Unparameterized query detected');
    }
    
    try {
      return await this.db.query(sql, params);
    } catch (error) {
      console.error('Database error:', {
        query: sql,
        params: params.map(p => typeof p),
        error: error.message
      });
      throw error;
    }
  }
  
  containsSQLInjectionPattern(sql) {
    // Basic detection of common SQL injection patterns
    const dangerousPatterns = [
      /;.*DROP/i,
      /;.*DELETE.*FROM/i,
      /;.*INSERT.*INTO/i,
      /;.*UPDATE.*SET/i,
      /UNION.*SELECT/i,
      /--.*$/m,
      /\/\*.*\*\//,
      /;.*EXEC/i,
      /;.*EXECUTE/i
    ];
    
    return dangerousPatterns.some(pattern => pattern.test(sql));
  }
}
```

---

## Testing for SQL Injection

### Test Cases

```javascript
// SQL injection test suite
const SQLInjectionTests = [
  {
    name: 'Classic OR injection',
    input: "' OR '1'='1",
    shouldFail: true
  },
  {
    name: 'Comment injection',
    input: "'; DROP TABLE users; --",
    shouldFail: true
  },
  {
    name: 'UNION injection',
    input: "' UNION SELECT * FROM api_keys WHERE '1'='1",
    shouldFail: true
  },
  {
    name: 'Stacked queries',
    input: "'; DELETE FROM users WHERE tenant_id = '",
    shouldFail: true
  },
  {
    name: 'Blind SQL injection',
    input: "' AND SLEEP(5) AND '1'='1",
    shouldFail: true
  },
  {
    name: 'Valid UUID',
    input: "550e8400-e29b-41d4-a716-446655440000",
    shouldFail: false
  },
  {
    name: 'Valid email',
    input: "user@example.com",
    shouldFail: false
  }
];

// Test runner
async function testSQLInjectionProtection() {
  const results = [];
  
  for (const test of SQLInjectionTests) {
    try {
      await searchUsers('550e8400-e29b-41d4-a716-446655440000', {
        email: test.input
      });
      
      results.push({
        test: test.name,
        passed: !test.shouldFail,
        message: test.shouldFail ? 'FAILED: Injection not blocked' : 'PASSED'
      });
    } catch (error) {
      results.push({
        test: test.name,
        passed: test.shouldFail,
        message: test.shouldFail ? 'PASSED: Injection blocked' : `FAILED: ${error.message}`
      });
    }
  }
  
  console.table(results);
}
```

---

## Deployment Checklist

### Pre-Production Security Review

- [ ] All database queries use parameterized statements
- [ ] No string concatenation in SQL queries
- [ ] Input validation on all user-provided data
- [ ] Whitelist validation for enums, table names, column names
- [ ] LIKE pattern escaping implemented
- [ ] UUID format validation
- [ ] SQL injection test suite passing
- [ ] Static analysis tools run (no SQL injection warnings)
- [ ] Code review by security-focused engineer
- [ ] Penetration testing completed
- [ ] Database user has minimum required privileges
- [ ] Prepared statements enabled (where applicable)
- [ ] Query logging enabled for audit
- [ ] Error messages don't leak schema information
- [ ] Database backups tested and working

---

## Conclusion

**Key Principles**:
1. **Never trust user input** - Always validate and sanitize
2. **Use parameterized queries exclusively** - No exceptions
3. **Fail closed** - Reject invalid input, don't try to "fix" it
4. **Whitelist over blacklist** - Define what's allowed, not what's forbidden
5. **Defense in depth** - Multiple layers of protection

By following these practices, the multi-tenant SaaS platform will be protected against SQL injection attacks without relying on external validation libraries.

**Remember**: Security is not a feature you add at the end - it must be built in from the start.
