# Multi-Tenant SaaS Platform - Complete Architecture

## 📋 Overview

This repository contains a **production-ready architecture** for a multi-tenant SaaS platform with:

- ✅ **Multi-tenancy** with row-level tenant isolation
- ✅ **Role-Based Access Control (RBAC)** with fine-grained permissions
- ✅ **Rate Limiting** using token bucket algorithm
- ✅ **Webhook Delivery System** with automatic retries
- ✅ **Comprehensive Audit Logging** for compliance
- ✅ **Security-first design** with SQL injection protection

---

## 📁 Documentation Structure

| File | Description |
|------|-------------|
| **[openapi-spec.yaml](./openapi-spec.yaml)** | Complete OpenAPI 3.0 specification for all API endpoints |
| **[database-schema.sql](./database-schema.sql)** | PostgreSQL database schema with indexes, triggers, and seed data |
| **[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)** | 14-week implementation roadmap with trade-off analysis |
| **[SECURITY_ANALYSIS.md](./SECURITY_ANALYSIS.md)** | SQL injection vulnerability analysis and mitigation strategies |

---

## 🏗️ Architecture Highlights

### Multi-Tenancy Design

- **Approach**: Shared database with row-level tenant isolation
- **Tenant Identification**: UUID-based tenant_id on all data tables
- **Security**: PostgreSQL Row-Level Security (RLS) ready
- **Scalability**: Supports 10,000+ tenants on single database

### RBAC Implementation

```
Platform Admin
    ├─ Tenant Owner
    │   ├─ Tenant Admin
    │   │   ├─ Member
    │   │   └─ Viewer
```

**Permissions**: `resource:action` pattern (e.g., `users:write`, `webhooks:delete`)

**Features**:
- System-wide and tenant-specific roles
- Custom role creation
- Permission caching (Redis)
- Audit trail for role changes

### Rate Limiting Strategy

| Plan | Rate Limit |
|------|------------|
| Trial | 100 req/hour |
| Starter | 1,000 req/hour |
| Professional | 10,000 req/hour |
| Enterprise | 100,000 req/hour |

**Implementation**: Token bucket algorithm with Redis

**Scopes**:
- Per user
- Per tenant
- Per API key
- Per IP address

### Webhook Delivery

**Features**:
- HMAC-SHA256 signature verification
- Automatic retry with exponential backoff
- Delivery history and monitoring
- Manual retry capability
- Auto-disable after consecutive failures

**Retry Schedule**:
1. Immediate
2. 1 minute
3. 10 minutes
4. 1 hour
5. 6 hours

### Audit Logging

**Captures**:
- Who: User/API key/system
- What: Action performed
- When: Timestamp
- Where: IP address, user agent
- Changes: Before/after state

**Compliance**: SOC 2, GDPR, HIPAA ready

---

## 🚀 Quick Start

### 1. Database Setup

```bash
# Create PostgreSQL database
createdb saas_platform

# Run migrations
psql -d saas_platform -f database-schema.sql

# Verify installation
psql -d saas_platform -c "SELECT COUNT(*) FROM permissions;"
# Should return 17 default permissions
```

### 2. Environment Configuration

```bash
# .env
DATABASE_URL=postgresql://user:pass@localhost:5432/saas_platform
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-secret-key-change-this
JWT_EXPIRY=900  # 15 minutes
REFRESH_TOKEN_EXPIRY=604800  # 7 days

# Rate limiting
RATE_LIMIT_TRIAL=100
RATE_LIMIT_STARTER=1000
RATE_LIMIT_PROFESSIONAL=10000
RATE_LIMIT_ENTERPRISE=100000

# Webhooks
WEBHOOK_TIMEOUT_MS=5000
WEBHOOK_MAX_RETRIES=5

# Queue
RABBITMQ_URL=amqp://localhost:5672
```

### 3. API Server (Node.js Example)

```javascript
const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');

const app = express();
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);

// Middleware
app.use(express.json());
app.use(require('./middleware/request-id'));
app.use(require('./middleware/rate-limit'));
app.use(require('./middleware/tenant-context'));
app.use(require('./middleware/audit-log'));

// Routes
app.use('/v1/auth', require('./routes/auth'));
app.use('/v1/tenants', require('./routes/tenants'));
app.use('/v1/tenants/:tenant_id/users', require('./routes/users'));
app.use('/v1/tenants/:tenant_id/roles', require('./routes/roles'));
app.use('/v1/tenants/:tenant_id/webhooks', require('./routes/webhooks'));
app.use('/v1/tenants/:tenant_id/audit-logs', require('./routes/audit-logs'));
app.use('/v1/tenants/:tenant_id/resources', require('./routes/resources'));

// Error handling
app.use(require('./middleware/error-handler'));

app.listen(3000, () => {
  console.log('API server running on port 3000');
});
```

### 4. Webhook Worker

```javascript
const amqp = require('amqplib');
const axios = require('axios');
const crypto = require('crypto');

async function startWebhookWorker() {
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  const channel = await connection.createChannel();
  
  await channel.assertQueue('webhook_deliveries', { durable: true });
  
  channel.consume('webhook_deliveries', async (msg) => {
    const job = JSON.parse(msg.content.toString());
    
    try {
      await deliverWebhook(job);
      channel.ack(msg);
    } catch (error) {
      console.error('Webhook delivery failed:', error);
      
      if (job.attempt < 5) {
        // Retry with backoff
        await scheduleRetry(job);
      }
      
      channel.ack(msg);
    }
  });
}

async function deliverWebhook(job) {
  const webhook = await getWebhook(job.webhookId);
  const signature = crypto
    .createHmac('sha256', webhook.secret)
    .update(JSON.stringify(job.payload))
    .digest('hex');
  
  const response = await axios.post(webhook.url, job.payload, {
    headers: {
      'X-Webhook-Signature': `sha256=${signature}`,
      'X-Webhook-Event': job.event,
      'Content-Type': 'application/json'
    },
    timeout: 5000
  });
  
  await recordDelivery(job.id, 'success', response);
}

startWebhookWorker();
```

---

## 📊 API Examples

### Authentication

```bash
# Login
curl -X POST https://api.example.com/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "admin@acme.com",
    "password": "secure-password",
    "tenant_id": "550e8400-e29b-41d4-a716-446655440000"
  }'

# Response
{
  "access_token": "eyJhbGc...",
  "refresh_token": "eyJhbGc...",
  "expires_in": 900,
  "token_type": "Bearer"
}
```

### Create User with Role

```bash
curl -X POST https://api.example.com/v1/tenants/550e8400-e29b-41d4-a716-446655440000/users \
  -H 'Authorization: Bearer eyJhbGc...' \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "john@acme.com",
    "first_name": "John",
    "last_name": "Doe",
    "role_ids": ["00000000-0000-0000-0000-000000000004"],
    "send_invite": true
  }'
```

### Create Webhook Subscription

```bash
curl -X POST https://api.example.com/v1/tenants/550e8400-e29b-41d4-a716-446655440000/webhooks \
  -H 'Authorization: Bearer eyJhbGc...' \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://example.com/webhooks",
    "events": ["user.created", "resource.updated"],
    "description": "Production webhook"
  }'

# Response
{
  "id": "webhook-uuid",
  "url": "https://example.com/webhooks",
  "events": ["user.created", "resource.updated"],
  "secret": "whsec_abc123...",
  "active": true
}
```

### Query Audit Logs

```bash
curl -X GET 'https://api.example.com/v1/tenants/550e8400-e29b-41d4-a716-446655440000/audit-logs?action=user.created&start_date=2024-01-01T00:00:00Z' \
  -H 'Authorization: Bearer eyJhbGc...'
```

---

## 🛡️ Security Best Practices

### SQL Injection Prevention

✅ **Always use parameterized queries**:
```javascript
// GOOD
db.query('SELECT * FROM users WHERE id = $1', [userId]);

// BAD - NEVER DO THIS
db.query(`SELECT * FROM users WHERE id = '${userId}'`);
```

✅ **Validate all input**:
```javascript
function validateUUID(id) {
  const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!regex.test(id)) {
    throw new Error('Invalid UUID');
  }
}
```

✅ **Whitelist enums**:
```javascript
const VALID_STATUSES = ['active', 'inactive', 'invited'];
if (!VALID_STATUSES.includes(status)) {
  throw new Error('Invalid status');
}
```

### Authentication Security

- Store passwords with bcrypt (cost factor 12+)
- Use RS256 for JWT signing (not HS256)
- Rotate refresh tokens on use
- Implement token revocation list
- Rate limit authentication endpoints (10 req/min)
- Add CAPTCHA after failed login attempts

### Webhook Security

- Sign payloads with HMAC-SHA256
- Verify signatures on delivery
- Use HTTPS only
- Implement timeout (5s default)
- Limit payload size (1MB max)

---

## 📈 Performance Optimization

### Database Optimization

```sql
-- Add indexes for common queries
CREATE INDEX CONCURRENTLY idx_users_tenant_email 
  ON users(tenant_id, email) WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY idx_audit_logs_tenant_created 
  ON audit_logs(tenant_id, created_at DESC);

-- Partition audit logs by month
CREATE TABLE audit_logs_2024_01 PARTITION OF audit_logs
  FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
```

### Caching Strategy

```javascript
// Cache user permissions (5 minutes TTL)
async function getUserPermissions(userId) {
  const cacheKey = `permissions:${userId}`;
  const cached = await redis.get(cacheKey);
  
  if (cached) {
    return JSON.parse(cached);
  }
  
  const permissions = await db.query(`
    SELECT DISTINCT p.name
    FROM user_roles ur
    JOIN role_permissions rp ON ur.role_id = rp.role_id
    JOIN permissions p ON rp.permission_id = p.id
    WHERE ur.user_id = $1
  `, [userId]);
  
  await redis.setex(cacheKey, 300, JSON.stringify(permissions.rows));
  return permissions.rows;
}
```

### Horizontal Scaling

- Run multiple API server instances (behind load balancer)
- Use session-less authentication (JWT)
- Implement distributed rate limiting (Redis)
- Use message queue for async processing
- Database read replicas for reporting

---

## 🧪 Testing

### Unit Tests

```javascript
describe('User Service', () => {
  it('should prevent SQL injection in email search', async () => {
    const maliciousInput = "' OR '1'='1";
    
    await expect(
      userService.searchUsers(validTenantId, { email: maliciousInput })
    ).rejects.toThrow('Invalid input');
  });
  
  it('should enforce tenant isolation', async () => {
    const userInTenant1 = await createUser(tenant1Id);
    const userInTenant2 = await createUser(tenant2Id);
    
    const results = await userService.getUsers(tenant1Id);
    
    expect(results).toContain(userInTenant1);
    expect(results).not.toContain(userInTenant2);
  });
});
```

### Load Testing (k6)

```javascript
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 100,
  duration: '5m',
};

export default function () {
  const res = http.get('https://api.example.com/v1/tenants/550e8400-e29b-41d4-a716-446655440000/resources', {
    headers: { 'Authorization': 'Bearer ...' }
  });
  
  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 200ms': (r) => r.timings.duration < 200,
  });
}
```

---

## 📦 Deployment

### Docker Compose (Development)

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: saas_platform
      POSTGRES_USER: admin
      POSTGRES_PASSWORD: password
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./database-schema.sql:/docker-entrypoint-initdb.d/01-schema.sql
    ports:
      - "5432:5432"
  
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
  
  rabbitmq:
    image: rabbitmq:3-management-alpine
    ports:
      - "5672:5672"
      - "15672:15672"
  
  api:
    build: .
    environment:
      DATABASE_URL: postgresql://admin:password@postgres:5432/saas_platform
      REDIS_URL: redis://redis:6379
      RABBITMQ_URL: amqp://rabbitmq:5672
    ports:
      - "3000:3000"
    depends_on:
      - postgres
      - redis
      - rabbitmq
  
  webhook_worker:
    build: .
    command: node workers/webhook-worker.js
    environment:
      DATABASE_URL: postgresql://admin:password@postgres:5432/saas_platform
      RABBITMQ_URL: amqp://rabbitmq:5672
    depends_on:
      - postgres
      - rabbitmq

volumes:
  postgres_data:
```

### Kubernetes (Production)

See `k8s/` directory for full manifests.

---

## 📝 Trade-Off Summary

| Decision | Choice | Alternative | Rationale |
|----------|--------|-------------|-----------|
| **Multi-tenancy** | Shared DB + row isolation | DB per tenant | Cost-effective, easier ops |
| **Authentication** | JWT | Session-based | Stateless, scales horizontally |
| **Rate Limiting** | Redis token bucket | API Gateway | Flexible, application-aware |
| **Webhooks** | Async + queue | Synchronous | Non-blocking, reliable |
| **Audit Storage** | PostgreSQL + S3 | Elasticsearch | Simple, cost-effective |
| **RBAC** | Resource:action | ABAC | Easy to understand, sufficient |

---

## 🎯 Success Metrics

- **Uptime**: 99.9% (43 min/month downtime)
- **API Latency (p95)**: < 200ms
- **Webhook Success Rate**: > 98%
- **Test Coverage**: > 80%
- **Security**: Zero SQL injection vulnerabilities

---

## 🤝 Contributing

1. Review the architecture documents
2. Follow security best practices (see SECURITY_ANALYSIS.md)
3. Write tests for all new features
4. Run static analysis before committing
5. Update OpenAPI spec for API changes

---

## 📄 License

MIT License - see LICENSE file

---

## 📞 Support

- **Documentation**: [docs.example.com](https://docs.example.com)
- **API Status**: [status.example.com](https://status.example.com)
- **Issues**: GitHub Issues
- **Email**: support@example.com

---

## 🗺️ Roadmap

### Phase 1 (Weeks 1-3) ✅
- Database schema
- Authentication system
- Core API structure

### Phase 2 (Weeks 4-6) ⏳
- Multi-tenancy
- RBAC implementation
- User management

### Phase 3 (Week 7)
- Rate limiting

### Phase 4 (Weeks 8-10)
- Webhook system

### Phase 5 (Week 11)
- Audit logging

### Phase 6 (Week 12)
- Security hardening

### Phase 7 (Week 13)
- Monitoring & operations

### Phase 8 (Week 14)
- Documentation & launch

---

**Built with ❤️ for scalable, secure, multi-tenant SaaS platforms**
