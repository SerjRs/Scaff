-- ==============================================================================
-- Multi-Tenant SaaS Platform Database Schema (PostgreSQL)
-- ==============================================================================
-- Design Principles:
-- 1. Row-level tenant isolation with tenant_id on all data tables
-- 2. UUID primary keys for distributed systems and security
-- 3. Audit timestamps (created_at, updated_at) on all tables
-- 4. Soft deletes where appropriate
-- 5. Optimized indexes for common query patterns
-- ==============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==============================================================================
-- CORE TENANT MANAGEMENT
-- ==============================================================================

CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    subdomain VARCHAR(63) NOT NULL UNIQUE,
    plan VARCHAR(50) NOT NULL CHECK (plan IN ('trial', 'starter', 'professional', 'enterprise')),
    status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'trial', 'cancelled')),
    settings JSONB DEFAULT '{}'::jsonb,
    
    -- Billing & subscription
    stripe_customer_id VARCHAR(255),
    subscription_ends_at TIMESTAMP WITH TIME ZONE,
    trial_ends_at TIMESTAMP WITH TIME ZONE,
    
    -- Resource limits (enforced by application)
    max_users INTEGER,
    max_api_calls_per_hour INTEGER,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_tenants_subdomain ON tenants(subdomain) WHERE deleted_at IS NULL;
CREATE INDEX idx_tenants_status ON tenants(status) WHERE deleted_at IS NULL;

-- ==============================================================================
-- USER MANAGEMENT
-- ==============================================================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255), -- NULL for SSO/invited users
    
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    
    status VARCHAR(50) NOT NULL DEFAULT 'invited' CHECK (status IN ('active', 'inactive', 'invited', 'suspended')),
    
    -- MFA
    mfa_enabled BOOLEAN DEFAULT FALSE,
    mfa_secret VARCHAR(255),
    
    -- Tracking
    last_login_at TIMESTAMP WITH TIME ZONE,
    last_login_ip INET,
    failed_login_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMP WITH TIME ZONE,
    
    -- Invitation
    invite_token VARCHAR(255),
    invite_expires_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE,
    
    CONSTRAINT unique_user_email_per_tenant UNIQUE (tenant_id, email)
);

CREATE INDEX idx_users_tenant_id ON users(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_email ON users(email) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_status ON users(tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_invite_token ON users(invite_token) WHERE invite_token IS NOT NULL;

-- ==============================================================================
-- ROLE-BASED ACCESS CONTROL (RBAC)
-- ==============================================================================

CREATE TABLE roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    -- NULL tenant_id indicates system/platform role
    
    name VARCHAR(100) NOT NULL,
    description TEXT,
    is_system BOOLEAN DEFAULT FALSE, -- Platform-defined roles
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT unique_role_name_per_tenant UNIQUE (tenant_id, name)
);

CREATE INDEX idx_roles_tenant_id ON roles(tenant_id);
CREATE INDEX idx_roles_system ON roles(is_system) WHERE is_system = TRUE;

-- Permissions are defined as resource:action patterns (e.g., "users:write", "resources:read")
CREATE TABLE permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE, -- e.g., "users:write"
    resource VARCHAR(50) NOT NULL, -- e.g., "users"
    action VARCHAR(50) NOT NULL, -- e.g., "write", "read", "delete", "admin"
    description TEXT,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT unique_permission_resource_action UNIQUE (resource, action)
);

CREATE INDEX idx_permissions_resource ON permissions(resource);

-- Many-to-many: roles to permissions
CREATE TABLE role_permissions (
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX idx_role_permissions_role_id ON role_permissions(role_id);
CREATE INDEX idx_role_permissions_permission_id ON role_permissions(permission_id);

-- Many-to-many: users to roles
CREATE TABLE user_roles (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    
    granted_by UUID REFERENCES users(id),
    granted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    PRIMARY KEY (user_id, role_id)
);

CREATE INDEX idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX idx_user_roles_role_id ON user_roles(role_id);

-- ==============================================================================
-- AUTHENTICATION & SESSION MANAGEMENT
-- ==============================================================================

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    -- Token management
    refresh_token_hash VARCHAR(255) NOT NULL UNIQUE,
    access_token_jti UUID NOT NULL, -- JWT ID for revocation
    
    -- Session metadata
    ip_address INET,
    user_agent TEXT,
    
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_refresh_token ON sessions(refresh_token_hash);
CREATE INDEX idx_sessions_access_token_jti ON sessions(access_token_jti);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at) WHERE revoked_at IS NULL;

-- API Keys for service-to-service authentication
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    name VARCHAR(255) NOT NULL,
    key_hash VARCHAR(255) NOT NULL UNIQUE,
    key_prefix VARCHAR(20) NOT NULL, -- For identification (e.g., "pk_live_")
    
    -- Scope & permissions
    scopes JSONB DEFAULT '[]'::jsonb, -- Array of permission names
    
    last_used_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMP WITH TIME ZONE,
    
    CONSTRAINT unique_key_name_per_tenant UNIQUE (tenant_id, name)
);

CREATE INDEX idx_api_keys_tenant_id ON api_keys(tenant_id);
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_api_keys_expires_at ON api_keys(expires_at) WHERE revoked_at IS NULL;

-- ==============================================================================
-- RATE LIMITING
-- ==============================================================================

CREATE TABLE rate_limit_buckets (
    id BIGSERIAL PRIMARY KEY,
    
    -- Identifier (could be user_id, tenant_id, api_key_id, or IP address)
    identifier_type VARCHAR(50) NOT NULL, -- 'user', 'tenant', 'api_key', 'ip'
    identifier_value VARCHAR(255) NOT NULL,
    
    -- Window
    window_type VARCHAR(50) NOT NULL, -- 'minute', 'hour', 'day'
    window_start TIMESTAMP WITH TIME ZONE NOT NULL,
    
    -- Counters
    request_count INTEGER DEFAULT 0,
    
    -- Metadata
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT unique_rate_limit_bucket UNIQUE (identifier_type, identifier_value, window_type, window_start)
);

CREATE INDEX idx_rate_limit_identifier ON rate_limit_buckets(identifier_type, identifier_value, window_type, window_start);
CREATE INDEX idx_rate_limit_cleanup ON rate_limit_buckets(window_start);

-- ==============================================================================
-- WEBHOOK SYSTEM
-- ==============================================================================

CREATE TABLE webhooks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    url TEXT NOT NULL,
    description TEXT,
    
    -- Event subscriptions
    events JSONB NOT NULL DEFAULT '[]'::jsonb, -- Array of event names
    
    -- Security
    secret VARCHAR(255) NOT NULL, -- For HMAC signature
    
    -- Status
    active BOOLEAN DEFAULT TRUE,
    
    -- Failure tracking
    failure_count INTEGER DEFAULT 0, -- Consecutive failures
    last_failure_at TIMESTAMP WITH TIME ZONE,
    disabled_at TIMESTAMP WITH TIME ZONE, -- Auto-disabled after too many failures
    
    -- Delivery stats
    last_delivery_at TIMESTAMP WITH TIME ZONE,
    total_deliveries BIGINT DEFAULT 0,
    successful_deliveries BIGINT DEFAULT 0,
    
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_webhooks_tenant_id ON webhooks(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_webhooks_active ON webhooks(tenant_id, active) WHERE deleted_at IS NULL AND active = TRUE;

-- Webhook delivery queue and history
CREATE TABLE webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    event VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    
    -- Delivery status
    status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'retrying')),
    attempt INTEGER DEFAULT 1,
    max_attempts INTEGER DEFAULT 5,
    
    -- Response tracking
    response_status INTEGER,
    response_headers JSONB,
    response_body TEXT,
    error_message TEXT,
    
    -- Timing
    scheduled_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    next_retry_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id);
CREATE INDEX idx_webhook_deliveries_status ON webhook_deliveries(status, next_retry_at) WHERE status IN ('pending', 'retrying');
CREATE INDEX idx_webhook_deliveries_tenant_id ON webhook_deliveries(tenant_id, created_at DESC);

-- ==============================================================================
-- AUDIT LOGGING
-- ==============================================================================

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    -- Actor (who performed the action)
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_email VARCHAR(255),
    actor_type VARCHAR(50) DEFAULT 'user', -- 'user', 'api_key', 'system'
    
    -- Action details
    action VARCHAR(100) NOT NULL, -- e.g., "user.created", "resource.deleted"
    resource_type VARCHAR(100) NOT NULL,
    resource_id UUID,
    
    -- Change tracking
    changes JSONB, -- { "before": {...}, "after": {...} }
    
    -- Context
    metadata JSONB DEFAULT '{}'::jsonb, -- IP, user agent, request ID, etc.
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Partitioning strategy for audit logs (by month)
-- In production, implement table partitioning for better performance
CREATE INDEX idx_audit_logs_tenant_id ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX idx_audit_logs_actor_id ON audit_logs(actor_id, created_at DESC);
CREATE INDEX idx_audit_logs_resource ON audit_logs(tenant_id, resource_type, resource_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(tenant_id, action, created_at DESC);

-- ==============================================================================
-- EXAMPLE BUSINESS RESOURCES
-- ==============================================================================

CREATE TABLE resources (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    name VARCHAR(255) NOT NULL,
    description TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_resources_tenant_id ON resources(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_resources_created_by ON resources(created_by);

-- ==============================================================================
-- SYSTEM TABLES
-- ==============================================================================

-- Background job queue
CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    
    queue VARCHAR(100) NOT NULL DEFAULT 'default',
    job_type VARCHAR(100) NOT NULL, -- e.g., 'webhook_delivery', 'audit_export'
    payload JSONB NOT NULL,
    
    status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    priority INTEGER DEFAULT 5, -- 1 = highest, 10 = lowest
    
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    
    error_message TEXT,
    result JSONB,
    
    scheduled_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_jobs_queue_status ON jobs(queue, status, priority, scheduled_at) WHERE status IN ('pending', 'processing');
CREATE INDEX idx_jobs_tenant_id ON jobs(tenant_id, created_at DESC);

-- ==============================================================================
-- FUNCTIONS & TRIGGERS
-- ==============================================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tables with updated_at
CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_roles_updated_at BEFORE UPDATE ON roles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_webhooks_updated_at BEFORE UPDATE ON webhooks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_resources_updated_at BEFORE UPDATE ON resources
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ==============================================================================
-- SEED DATA: Default Roles & Permissions
-- ==============================================================================

-- Insert default permissions
INSERT INTO permissions (name, resource, action, description) VALUES
    ('tenants:read', 'tenants', 'read', 'View tenant information'),
    ('tenants:write', 'tenants', 'write', 'Modify tenant settings'),
    ('tenants:admin', 'tenants', 'admin', 'Full tenant administration'),
    
    ('users:read', 'users', 'read', 'View users'),
    ('users:write', 'users', 'write', 'Create and modify users'),
    ('users:delete', 'users', 'delete', 'Delete users'),
    ('users:admin', 'users', 'admin', 'Full user administration'),
    
    ('roles:read', 'roles', 'read', 'View roles'),
    ('roles:write', 'roles', 'write', 'Create and modify roles'),
    ('roles:delete', 'roles', 'delete', 'Delete roles'),
    
    ('webhooks:read', 'webhooks', 'read', 'View webhooks'),
    ('webhooks:write', 'webhooks', 'write', 'Create and modify webhooks'),
    ('webhooks:delete', 'webhooks', 'delete', 'Delete webhooks'),
    
    ('audit:read', 'audit', 'read', 'View audit logs'),
    ('audit:export', 'audit', 'export', 'Export audit logs'),
    
    ('resources:read', 'resources', 'read', 'View resources'),
    ('resources:write', 'resources', 'write', 'Create and modify resources'),
    ('resources:delete', 'resources', 'delete', 'Delete resources')
ON CONFLICT (name) DO NOTHING;

-- Insert system roles (tenant_id is NULL for platform-wide roles)
INSERT INTO roles (id, tenant_id, name, description, is_system) VALUES
    ('00000000-0000-0000-0000-000000000001', NULL, 'Platform Admin', 'Full platform administration', TRUE),
    ('00000000-0000-0000-0000-000000000002', NULL, 'Tenant Owner', 'Owner of a tenant with full permissions', TRUE),
    ('00000000-0000-0000-0000-000000000003', NULL, 'Tenant Admin', 'Administrator within a tenant', TRUE),
    ('00000000-0000-0000-0000-000000000004', NULL, 'Member', 'Standard member with read access', TRUE),
    ('00000000-0000-0000-0000-000000000005', NULL, 'Viewer', 'Read-only access', TRUE)
ON CONFLICT (id) DO NOTHING;

-- Assign permissions to system roles
-- Platform Admin: all permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000001', id FROM permissions
ON CONFLICT DO NOTHING;

-- Tenant Owner: all tenant-level permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000002', id FROM permissions
WHERE resource != 'tenants' OR action = 'read'
ON CONFLICT DO NOTHING;

-- Tenant Admin: admin permissions except tenant management
INSERT INTO role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000003', id FROM permissions
WHERE resource IN ('users', 'roles', 'webhooks', 'audit', 'resources')
ON CONFLICT DO NOTHING;

-- Member: read and write resources
INSERT INTO role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000004', id FROM permissions
WHERE resource = 'resources' AND action IN ('read', 'write')
ON CONFLICT DO NOTHING;

-- Viewer: read-only
INSERT INTO role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000005', id FROM permissions
WHERE action = 'read'
ON CONFLICT DO NOTHING;

-- ==============================================================================
-- ROW LEVEL SECURITY (RLS) - Optional but Recommended
-- ==============================================================================
-- Uncomment to enable RLS for additional security layer

-- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY tenant_isolation_users ON users
--     USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- CREATE POLICY tenant_isolation_resources ON resources
--     USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ==============================================================================
-- VIEWS FOR COMMON QUERIES
-- ==============================================================================

-- User with aggregated roles and permissions
CREATE OR REPLACE VIEW user_permissions AS
SELECT 
    u.id AS user_id,
    u.tenant_id,
    u.email,
    array_agg(DISTINCT r.name) AS role_names,
    array_agg(DISTINCT p.name) AS permission_names
FROM users u
LEFT JOIN user_roles ur ON u.id = ur.user_id
LEFT JOIN roles r ON ur.role_id = r.id
LEFT JOIN role_permissions rp ON r.id = rp.role_id
LEFT JOIN permissions p ON rp.permission_id = p.permission_id
WHERE u.deleted_at IS NULL
GROUP BY u.id, u.tenant_id, u.email;

-- Tenant usage statistics
CREATE OR REPLACE VIEW tenant_stats AS
SELECT 
    t.id AS tenant_id,
    t.name,
    t.plan,
    COUNT(DISTINCT u.id) AS user_count,
    COUNT(DISTINCT w.id) AS webhook_count,
    COUNT(DISTINCT r.id) AS resource_count,
    MAX(al.created_at) AS last_activity_at
FROM tenants t
LEFT JOIN users u ON t.id = u.tenant_id AND u.deleted_at IS NULL
LEFT JOIN webhooks w ON t.id = w.tenant_id AND w.deleted_at IS NULL
LEFT JOIN resources r ON t.id = r.tenant_id AND r.deleted_at IS NULL
LEFT JOIN audit_logs al ON t.id = al.tenant_id
WHERE t.deleted_at IS NULL
GROUP BY t.id, t.name, t.plan;

-- ==============================================================================
-- COMMENTS FOR DOCUMENTATION
-- ==============================================================================

COMMENT ON TABLE tenants IS 'Multi-tenant isolation: each tenant is a separate customer organization';
COMMENT ON TABLE users IS 'Users belong to tenants and can have multiple roles';
COMMENT ON TABLE roles IS 'Roles define sets of permissions; can be system-wide or tenant-specific';
COMMENT ON TABLE permissions IS 'Granular permissions following resource:action pattern';
COMMENT ON TABLE rate_limit_buckets IS 'Token bucket rate limiting implementation';
COMMENT ON TABLE webhooks IS 'Webhook subscriptions for event notifications';
COMMENT ON TABLE webhook_deliveries IS 'Webhook delivery queue and history with retry logic';
COMMENT ON TABLE audit_logs IS 'Immutable audit trail of all system actions';
COMMENT ON TABLE jobs IS 'Background job queue for async processing';
