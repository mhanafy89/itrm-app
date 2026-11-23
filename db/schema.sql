-- ITRM Business Request Tracker schema (Microsoft SQL Server 2017+)
-- Mirrors the "Proposed template" + "Lookups" sheets from the original Excel tracker.
--
-- Idempotent: every object is created only if missing, so this file is safe to run
-- repeatedly (the app runs it on startup via db/database.js init(), and it can also be
-- run by hand with sqlcmd / SSMS against an existing, empty database).
-- Batches are separated by GO lines.
--
-- Type mapping from the SQLite schema:
--   INTEGER PRIMARY KEY AUTOINCREMENT -> INT IDENTITY(1,1)
--   TEXT                              -> NVARCHAR(n) / NVARCHAR(MAX) for free text
--   TEXT holding 'YYYY-MM-DD'         -> DATE
--   TEXT default datetime('now')      -> DATETIME2(0) default SYSUTCDATETIME()  (UTC, like SQLite)
--   INTEGER used as 0/1 boolean       -> BIT
--   TEXT UNIQUE (nullable)            -> filtered UNIQUE index (SQL Server would allow only ONE NULL
--                                        in a plain UNIQUE constraint; SQLite allows many)

-- ---------------------------------------------------------------------
-- Lookup tables (editable via the /api/lookups endpoints so the picklists
-- can grow without touching code -- same intent as the Excel "Lookups" sheet).
-- ---------------------------------------------------------------------
IF OBJECT_ID(N'dbo.business_units', N'U') IS NULL
CREATE TABLE dbo.business_units (
  id   INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_business_units PRIMARY KEY,
  name NVARCHAR(200)     NOT NULL CONSTRAINT UQ_business_units_name UNIQUE
);
GO

IF OBJECT_ID(N'dbo.business_categories', N'U') IS NULL
CREATE TABLE dbo.business_categories (
  id   INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_business_categories PRIMARY KEY,
  name NVARCHAR(200)     NOT NULL CONSTRAINT UQ_business_categories_name UNIQUE
);
GO

IF OBJECT_ID(N'dbo.priorities', N'U') IS NULL
CREATE TABLE dbo.priorities (
  id         INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_priorities PRIMARY KEY,
  name       NVARCHAR(200)     NOT NULL CONSTRAINT UQ_priorities_name UNIQUE,
  sort_order INT               NOT NULL CONSTRAINT DF_priorities_sort_order DEFAULT 0
);
GO

IF OBJECT_ID(N'dbo.stages', N'U') IS NULL
CREATE TABLE dbo.stages (
  id         INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_stages PRIMARY KEY,
  name       NVARCHAR(200)     NOT NULL CONSTRAINT UQ_stages_name UNIQUE,
  sort_order INT               NOT NULL CONSTRAINT DF_stages_sort_order DEFAULT 0
);
GO

IF OBJECT_ID(N'dbo.statuses', N'U') IS NULL
CREATE TABLE dbo.statuses (
  id         INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_statuses PRIMARY KEY,
  name       NVARCHAR(200)     NOT NULL CONSTRAINT UQ_statuses_name UNIQUE,
  sort_order INT               NOT NULL CONSTRAINT DF_statuses_sort_order DEFAULT 0
);
GO

IF OBJECT_ID(N'dbo.tech_owners', N'U') IS NULL
CREATE TABLE dbo.tech_owners (
  id   INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_tech_owners PRIMARY KEY,
  name NVARCHAR(200)     NOT NULL CONSTRAINT UQ_tech_owners_name UNIQUE
);
GO

IF OBJECT_ID(N'dbo.regulators', N'U') IS NULL
CREATE TABLE dbo.regulators (
  id   INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_regulators PRIMARY KEY,
  name NVARCHAR(200)     NOT NULL CONSTRAINT UQ_regulators_name UNIQUE
);
GO

IF OBJECT_ID(N'dbo.requesters', N'U') IS NULL
CREATE TABLE dbo.requesters (
  id   INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_requesters PRIMARY KEY,
  name NVARCHAR(200)     NOT NULL CONSTRAINT UQ_requesters_name UNIQUE
);
GO

IF OBJECT_ID(N'dbo.rms', N'U') IS NULL
CREATE TABLE dbo.rms (
  id   INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_rms PRIMARY KEY,
  name NVARCHAR(200)     NOT NULL CONSTRAINT UQ_rms_name UNIQUE
);
GO

-- ---------------------------------------------------------------------
-- Main table
-- ---------------------------------------------------------------------
IF OBJECT_ID(N'dbo.business_requests', N'U') IS NULL
CREATE TABLE dbo.business_requests (
  id                          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_business_requests PRIMARY KEY,
  br_no                       NVARCHAR(255)  NULL,
  cr                          NVARCHAR(255)  NULL,
  submission_date             DATE           NULL,
  business_unit_id            INT            NULL CONSTRAINT FK_br_business_unit     REFERENCES dbo.business_units(id),
  business_category_id        INT            NULL CONSTRAINT FK_br_business_category REFERENCES dbo.business_categories(id),
  requester                   NVARCHAR(255)  NULL,  -- legacy free-text requester (pre requester_id)
  requester_id                INT            NULL CONSTRAINT FK_br_requester         REFERENCES dbo.requesters(id),
  title                       NVARCHAR(1000) NOT NULL,
  description                 NVARCHAR(MAX)  NULL,
  priority_id                 INT            NULL CONSTRAINT FK_br_priority          REFERENCES dbo.priorities(id),
  stage_id                    INT            NULL CONSTRAINT FK_br_stage             REFERENCES dbo.stages(id),
  status_id                   INT            NULL CONSTRAINT FK_br_status            REFERENCES dbo.statuses(id),
  newgen_related              BIT            NOT NULL CONSTRAINT DF_br_newgen_related DEFAULT 0,
  estimated                   BIT            NOT NULL CONSTRAINT DF_br_estimated      DEFAULT 0,
  ba_required                 BIT            NOT NULL CONSTRAINT DF_br_ba_required    DEFAULT 0,
  brd_assigned                BIT            NOT NULL CONSTRAINT DF_br_brd_assigned   DEFAULT 0,
  tech_owner_id               INT            NULL CONSTRAINT FK_br_tech_owner        REFERENCES dbo.tech_owners(id),
  regulatory                  BIT            NOT NULL CONSTRAINT DF_br_regulatory     DEFAULT 0,
  regulator_id                INT            NULL CONSTRAINT FK_br_regulator         REFERENCES dbo.regulators(id),
  regulatory_deadline         DATE           NULL,
  analysis_planned_start_date DATE           NULL,
  analysis_planned_end_date   DATE           NULL,
  dev_planned_start_date      DATE           NULL,
  dev_planned_end_date        DATE           NULL,
  qa_planned_start_date       DATE           NULL,
  qa_planned_end_date         DATE           NULL,
  uat_planned_start_date      DATE           NULL,
  uat_planned_date            DATE           NULL,
  cab_date                    DATE           NULL,
  deployment_planned_end_date DATE           NULL,
  closed_date                 DATE           NULL,
  comments                    NVARCHAR(MAX)  NULL,  -- legacy column, superseded by request_comments
  rm_id                       INT            NULL CONSTRAINT FK_br_rm                REFERENCES dbo.rms(id),
  created_at                  DATETIME2(0)   NOT NULL CONSTRAINT DF_br_created_at DEFAULT SYSUTCDATETIME(),
  updated_at                  DATETIME2(0)   NOT NULL CONSTRAINT DF_br_updated_at DEFAULT SYSUTCDATETIME(),
  created_by                  NVARCHAR(255)  NULL,
  updated_by                  NVARCHAR(255)  NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_business_requests_br_no' AND object_id = OBJECT_ID(N'dbo.business_requests'))
  CREATE UNIQUE INDEX UX_business_requests_br_no ON dbo.business_requests(br_no) WHERE br_no IS NOT NULL;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_business_requests_cr' AND object_id = OBJECT_ID(N'dbo.business_requests'))
  CREATE UNIQUE INDEX UX_business_requests_cr ON dbo.business_requests(cr) WHERE cr IS NOT NULL;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_br_business_unit' AND object_id = OBJECT_ID(N'dbo.business_requests'))
  CREATE INDEX IX_br_business_unit ON dbo.business_requests(business_unit_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_br_business_category' AND object_id = OBJECT_ID(N'dbo.business_requests'))
  CREATE INDEX IX_br_business_category ON dbo.business_requests(business_category_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_br_requester' AND object_id = OBJECT_ID(N'dbo.business_requests'))
  CREATE INDEX IX_br_requester ON dbo.business_requests(requester_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_br_priority' AND object_id = OBJECT_ID(N'dbo.business_requests'))
  CREATE INDEX IX_br_priority ON dbo.business_requests(priority_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_br_stage' AND object_id = OBJECT_ID(N'dbo.business_requests'))
  CREATE INDEX IX_br_stage ON dbo.business_requests(stage_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_br_status' AND object_id = OBJECT_ID(N'dbo.business_requests'))
  CREATE INDEX IX_br_status ON dbo.business_requests(status_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_br_tech_owner' AND object_id = OBJECT_ID(N'dbo.business_requests'))
  CREATE INDEX IX_br_tech_owner ON dbo.business_requests(tech_owner_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_br_regulator' AND object_id = OBJECT_ID(N'dbo.business_requests'))
  CREATE INDEX IX_br_regulator ON dbo.business_requests(regulator_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_br_rm' AND object_id = OBJECT_ID(N'dbo.business_requests'))
  CREATE INDEX IX_br_rm ON dbo.business_requests(rm_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_br_updated_at' AND object_id = OBJECT_ID(N'dbo.business_requests'))
  CREATE INDEX IX_br_updated_at ON dbo.business_requests(updated_at DESC);
GO

-- ---------------------------------------------------------------------
-- Simple audit trail (who changed what, when) -- useful once several
-- people share one tracker.
-- ---------------------------------------------------------------------
IF OBJECT_ID(N'dbo.business_request_history', N'U') IS NULL
CREATE TABLE dbo.business_request_history (
  id                  INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_business_request_history PRIMARY KEY,
  business_request_id INT           NOT NULL CONSTRAINT FK_brh_request REFERENCES dbo.business_requests(id) ON DELETE CASCADE,
  changed_at          DATETIME2(0)  NOT NULL CONSTRAINT DF_brh_changed_at DEFAULT SYSUTCDATETIME(),
  changed_by          NVARCHAR(255) NULL,
  change_type         NVARCHAR(50)  NOT NULL, -- 'create' | 'update' | 'delete' | 'bulk-update'
  snapshot_json       NVARCHAR(MAX) NOT NULL  -- full row as JSON at the time of the change
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_brh_request' AND object_id = OBJECT_ID(N'dbo.business_request_history'))
  CREATE INDEX IX_brh_request ON dbo.business_request_history(business_request_id, changed_at DESC);
GO

-- ---------------------------------------------------------------------
-- Per-request threaded comments
-- ---------------------------------------------------------------------
IF OBJECT_ID(N'dbo.request_comments', N'U') IS NULL
CREATE TABLE dbo.request_comments (
  id                  INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_request_comments PRIMARY KEY,
  business_request_id INT           NOT NULL CONSTRAINT FK_rc_request REFERENCES dbo.business_requests(id) ON DELETE CASCADE,
  body                NVARCHAR(MAX) NOT NULL,
  created_at          DATETIME2(0)  NOT NULL CONSTRAINT DF_rc_created_at DEFAULT SYSUTCDATETIME(),
  created_by          NVARCHAR(255) NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_comments_request' AND object_id = OBJECT_ID(N'dbo.request_comments'))
  CREATE INDEX IX_comments_request ON dbo.request_comments(business_request_id, created_at, id);
GO

-- ---------------------------------------------------------------------
-- Incidents tracker (same lookup tables, fewer fields than BR)
-- ---------------------------------------------------------------------
IF OBJECT_ID(N'dbo.incidents', N'U') IS NULL
CREATE TABLE dbo.incidents (
  id                          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_incidents PRIMARY KEY,
  incident_id                 NVARCHAR(255)  NULL,
  cr                          NVARCHAR(255)  NULL,
  business_unit_id            INT            NULL CONSTRAINT FK_inc_business_unit REFERENCES dbo.business_units(id),
  requester_id                INT            NULL CONSTRAINT FK_inc_requester     REFERENCES dbo.requesters(id),
  title                       NVARCHAR(1000) NOT NULL,
  description                 NVARCHAR(MAX)  NULL,
  priority_id                 INT            NULL CONSTRAINT FK_inc_priority      REFERENCES dbo.priorities(id),
  stage_id                    INT            NULL CONSTRAINT FK_inc_stage         REFERENCES dbo.stages(id),
  status_id                   INT            NULL CONSTRAINT FK_inc_status        REFERENCES dbo.statuses(id),
  newgen_related              BIT            NOT NULL CONSTRAINT DF_inc_newgen_related DEFAULT 0,
  estimated                   BIT            NOT NULL CONSTRAINT DF_inc_estimated      DEFAULT 0,
  tech_owner_id               INT            NULL CONSTRAINT FK_inc_tech_owner    REFERENCES dbo.tech_owners(id),
  dev_planned_start_date      DATE           NULL,
  dev_planned_end_date        DATE           NULL,
  qa_planned_start_date       DATE           NULL,
  qa_planned_end_date         DATE           NULL,
  uat_planned_start_date      DATE           NULL,
  uat_planned_date            DATE           NULL,
  cab_date                    DATE           NULL,
  deployment_planned_end_date DATE           NULL,
  closed_date                 DATE           NULL,
  rm_id                       INT            NULL CONSTRAINT FK_inc_rm            REFERENCES dbo.rms(id),
  created_at                  DATETIME2(0)   NOT NULL CONSTRAINT DF_inc_created_at DEFAULT SYSUTCDATETIME(),
  updated_at                  DATETIME2(0)   NOT NULL CONSTRAINT DF_inc_updated_at DEFAULT SYSUTCDATETIME(),
  created_by                  NVARCHAR(255)  NULL,
  updated_by                  NVARCHAR(255)  NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_incidents_incident_id' AND object_id = OBJECT_ID(N'dbo.incidents'))
  CREATE UNIQUE INDEX UX_incidents_incident_id ON dbo.incidents(incident_id) WHERE incident_id IS NOT NULL;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_incidents_cr' AND object_id = OBJECT_ID(N'dbo.incidents'))
  CREATE UNIQUE INDEX UX_incidents_cr ON dbo.incidents(cr) WHERE cr IS NOT NULL;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inc_business_unit' AND object_id = OBJECT_ID(N'dbo.incidents'))
  CREATE INDEX IX_inc_business_unit ON dbo.incidents(business_unit_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inc_requester' AND object_id = OBJECT_ID(N'dbo.incidents'))
  CREATE INDEX IX_inc_requester ON dbo.incidents(requester_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inc_priority' AND object_id = OBJECT_ID(N'dbo.incidents'))
  CREATE INDEX IX_inc_priority ON dbo.incidents(priority_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inc_stage' AND object_id = OBJECT_ID(N'dbo.incidents'))
  CREATE INDEX IX_inc_stage ON dbo.incidents(stage_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inc_status' AND object_id = OBJECT_ID(N'dbo.incidents'))
  CREATE INDEX IX_inc_status ON dbo.incidents(status_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inc_tech_owner' AND object_id = OBJECT_ID(N'dbo.incidents'))
  CREATE INDEX IX_inc_tech_owner ON dbo.incidents(tech_owner_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inc_rm' AND object_id = OBJECT_ID(N'dbo.incidents'))
  CREATE INDEX IX_inc_rm ON dbo.incidents(rm_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inc_updated_at' AND object_id = OBJECT_ID(N'dbo.incidents'))
  CREATE INDEX IX_inc_updated_at ON dbo.incidents(updated_at DESC);
GO

IF OBJECT_ID(N'dbo.incident_history', N'U') IS NULL
CREATE TABLE dbo.incident_history (
  id            INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_incident_history PRIMARY KEY,
  incident_id   INT           NOT NULL CONSTRAINT FK_inch_incident REFERENCES dbo.incidents(id) ON DELETE CASCADE,
  changed_at    DATETIME2(0)  NOT NULL CONSTRAINT DF_inch_changed_at DEFAULT SYSUTCDATETIME(),
  changed_by    NVARCHAR(255) NULL,
  change_type   NVARCHAR(50)  NOT NULL,
  snapshot_json NVARCHAR(MAX) NOT NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inch_incident' AND object_id = OBJECT_ID(N'dbo.incident_history'))
  CREATE INDEX IX_inch_incident ON dbo.incident_history(incident_id, changed_at DESC);
GO

IF OBJECT_ID(N'dbo.incident_comments', N'U') IS NULL
CREATE TABLE dbo.incident_comments (
  id          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_incident_comments PRIMARY KEY,
  incident_id INT           NOT NULL CONSTRAINT FK_ic_incident REFERENCES dbo.incidents(id) ON DELETE CASCADE,
  body        NVARCHAR(MAX) NOT NULL,
  created_at  DATETIME2(0)  NOT NULL CONSTRAINT DF_ic_created_at DEFAULT SYSUTCDATETIME(),
  created_by  NVARCHAR(255) NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inc_comments' AND object_id = OBJECT_ID(N'dbo.incident_comments'))
  CREATE INDEX IX_inc_comments ON dbo.incident_comments(incident_id, created_at, id);
GO

-- ---------------------------------------------------------------------
-- Import & merge wizard history (one batch per uploaded file, plus a
-- per-row audit of what happened: inserted / updated / duplicate / etc.)
-- ---------------------------------------------------------------------
IF OBJECT_ID(N'dbo.import_batches', N'U') IS NULL
CREATE TABLE dbo.import_batches (
  id              INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_import_batches PRIMARY KEY,
  filename        NVARCHAR(500)  NULL,
  file_type       NVARCHAR(20)   NULL,                 -- 'csv' | 'xlsx'
  target          NVARCHAR(50)   NOT NULL,             -- 'business_requests' | 'incidents'
  created_at      DATETIME2(0)   NOT NULL CONSTRAINT DF_ib_created_at DEFAULT SYSUTCDATETIME(),
  created_by      NVARCHAR(255)  NULL,
  total_rows      INT            NOT NULL CONSTRAINT DF_ib_total_rows      DEFAULT 0,
  new_count       INT            NOT NULL CONSTRAINT DF_ib_new_count       DEFAULT 0,
  updated_count   INT            NOT NULL CONSTRAINT DF_ib_updated_count   DEFAULT 0,
  duplicate_count INT            NOT NULL CONSTRAINT DF_ib_duplicate_count DEFAULT 0,
  skipped_count   INT            NOT NULL CONSTRAINT DF_ib_skipped_count   DEFAULT 0,
  invalid_count   INT            NOT NULL CONSTRAINT DF_ib_invalid_count   DEFAULT 0,
  error_count     INT            NOT NULL CONSTRAINT DF_ib_error_count     DEFAULT 0,
  summary_json    NVARCHAR(MAX)  NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_import_batches_created' AND object_id = OBJECT_ID(N'dbo.import_batches'))
  CREATE INDEX IX_import_batches_created ON dbo.import_batches(created_at DESC, id DESC);
GO

IF OBJECT_ID(N'dbo.import_batch_rows', N'U') IS NULL
CREATE TABLE dbo.import_batch_rows (
  id         INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_import_batch_rows PRIMARY KEY,
  batch_id   INT            NOT NULL CONSTRAINT FK_ibr_batch REFERENCES dbo.import_batches(id) ON DELETE CASCADE,
  row_index  INT            NOT NULL,
  action     NVARCHAR(50)   NOT NULL,   -- user decision: 'insert' | 'update' | 'skip'
  outcome    NVARCHAR(50)   NOT NULL,   -- result: 'new' | 'updated' | 'duplicate' | 'skipped' | 'invalid' | 'error'
  entity_id  INT            NULL,       -- id of the affected business_request / incident (if any)
  key_value  NVARCHAR(MAX)  NULL,       -- br_no / incident_id / cr used to match
  title      NVARCHAR(MAX)  NULL,
  diff_json  NVARCHAR(MAX)  NULL,       -- field-level current -> uploaded changes
  message    NVARCHAR(MAX)  NULL,       -- error / info detail
  raw_json   NVARCHAR(MAX)  NULL        -- the mapped source row as uploaded
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_import_rows_batch' AND object_id = OBJECT_ID(N'dbo.import_batch_rows'))
  CREATE INDEX IX_import_rows_batch ON dbo.import_batch_rows(batch_id);
GO

-- ---------------------------------------------------------------------
-- Multi tech-owner support: a request/incident can now have several tech
-- owners. The tech_owner_id column on the parent table is kept as the
-- "primary" owner (first selected) for backward compatibility with any
-- existing reports/exports that key off it; the junction tables below hold
-- the full set shown and edited in the UI.
-- ---------------------------------------------------------------------
IF OBJECT_ID(N'dbo.business_request_tech_owners', N'U') IS NULL
CREATE TABLE dbo.business_request_tech_owners (
  business_request_id INT NOT NULL CONSTRAINT FK_brto_request    REFERENCES dbo.business_requests(id) ON DELETE CASCADE,
  tech_owner_id        INT NOT NULL CONSTRAINT FK_brto_tech_owner REFERENCES dbo.tech_owners(id),
  CONSTRAINT PK_business_request_tech_owners PRIMARY KEY (business_request_id, tech_owner_id)
);
GO

-- One-time backfill from the legacy single-value column (only runs while the table is empty).
IF OBJECT_ID(N'dbo.business_request_tech_owners', N'U') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM dbo.business_request_tech_owners)
INSERT INTO dbo.business_request_tech_owners (business_request_id, tech_owner_id)
SELECT id, tech_owner_id FROM dbo.business_requests WHERE tech_owner_id IS NOT NULL;
GO

IF OBJECT_ID(N'dbo.incident_tech_owners', N'U') IS NULL
CREATE TABLE dbo.incident_tech_owners (
  incident_id   INT NOT NULL CONSTRAINT FK_incto_incident    REFERENCES dbo.incidents(id) ON DELETE CASCADE,
  tech_owner_id INT NOT NULL CONSTRAINT FK_incto_tech_owner REFERENCES dbo.tech_owners(id),
  CONSTRAINT PK_incident_tech_owners PRIMARY KEY (incident_id, tech_owner_id)
);
GO

IF OBJECT_ID(N'dbo.incident_tech_owners', N'U') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM dbo.incident_tech_owners)
INSERT INTO dbo.incident_tech_owners (incident_id, tech_owner_id)
SELECT id, tech_owner_id FROM dbo.incidents WHERE tech_owner_id IS NOT NULL;
GO

-- ---------------------------------------------------------------------
-- SLA assumptions. Rows are keyed by lookup NAME (not id) so they survive lookup renames/typos;
-- a lookup value with no row here falls back to the defaults in lib/sla.js.
-- ---------------------------------------------------------------------
IF OBJECT_ID(N'dbo.sla_stages', N'U') IS NULL
CREATE TABLE dbo.sla_stages (
  name          NVARCHAR(200) NOT NULL CONSTRAINT PK_sla_stages PRIMARY KEY,
  stage_order   INT           NOT NULL,
  is_pipeline   BIT           NOT NULL CONSTRAINT DF_sla_stages_pipeline DEFAULT 1,
  br_days       INT           NOT NULL CONSTRAINT DF_sla_stages_br DEFAULT 0,
  incident_days INT           NOT NULL CONSTRAINT DF_sla_stages_inc DEFAULT 0,
  effort_days   DECIMAL(6,2)  NOT NULL CONSTRAINT DF_sla_stages_effort DEFAULT 0
);
GO

IF OBJECT_ID(N'dbo.sla_priorities', N'U') IS NULL
CREATE TABLE dbo.sla_priorities (
  name           NVARCHAR(200) NOT NULL CONSTRAINT PK_sla_priorities PRIMARY KEY,
  factor         DECIMAL(5,2)  NOT NULL,
  response_hours DECIMAL(6,1)  NOT NULL CONSTRAINT DF_sla_prio_resp DEFAULT 8,
  update_days    INT           NOT NULL CONSTRAINT DF_sla_prio_upd DEFAULT 7
);
GO

IF OBJECT_ID(N'dbo.sla_categories', N'U') IS NULL
CREATE TABLE dbo.sla_categories (
  name   NVARCHAR(200) NOT NULL CONSTRAINT PK_sla_categories PRIMARY KEY,
  factor DECIMAL(5,2)  NOT NULL
);
GO

IF OBJECT_ID(N'dbo.sla_statuses', N'U') IS NULL
CREATE TABLE dbo.sla_statuses (
  name  NVARCHAR(200) NOT NULL CONSTRAINT PK_sla_statuses PRIMARY KEY,
  state NVARCHAR(10)  NOT NULL CONSTRAINT CK_sla_statuses_state CHECK (state IN (N'Active', N'Paused', N'Done'))
);
GO

IF OBJECT_ID(N'dbo.sla_settings', N'U') IS NULL
CREATE TABLE dbo.sla_settings (
  setting_key   NVARCHAR(50)  NOT NULL CONSTRAINT PK_sla_settings PRIMARY KEY,
  setting_value NVARCHAR(200) NOT NULL
);
GO

-- ---------------------------------------------------------------------
-- Systems lookup: a request/incident can touch several systems (junction tables, like tech owners).
-- ---------------------------------------------------------------------
IF OBJECT_ID(N'dbo.systems', N'U') IS NULL
CREATE TABLE dbo.systems (
  id   INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_systems PRIMARY KEY,
  name NVARCHAR(200)     NOT NULL CONSTRAINT UQ_systems_name UNIQUE
);
GO

IF OBJECT_ID(N'dbo.business_request_systems', N'U') IS NULL
CREATE TABLE dbo.business_request_systems (
  business_request_id INT NOT NULL CONSTRAINT FK_brs_request REFERENCES dbo.business_requests(id) ON DELETE CASCADE,
  system_id           INT NOT NULL CONSTRAINT FK_brs_system  REFERENCES dbo.systems(id),
  CONSTRAINT PK_business_request_systems PRIMARY KEY (business_request_id, system_id)
);
GO

IF OBJECT_ID(N'dbo.incident_systems', N'U') IS NULL
CREATE TABLE dbo.incident_systems (
  incident_id INT NOT NULL CONSTRAINT FK_incs_incident REFERENCES dbo.incidents(id) ON DELETE CASCADE,
  system_id   INT NOT NULL CONSTRAINT FK_incs_system   REFERENCES dbo.systems(id),
  CONSTRAINT PK_incident_systems PRIMARY KEY (incident_id, system_id)
);
GO

-- ---------------------------------------------------------------------
-- Authentication: users (username/password + display name) and a simple
-- privilege level, plus server-side sessions for cookie-based login.
-- Passwords are never stored in plain text -- see lib/auth.js (scrypt).
-- ---------------------------------------------------------------------
IF OBJECT_ID(N'dbo.users', N'U') IS NULL
CREATE TABLE dbo.users (
  id            INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_users PRIMARY KEY,
  username      NVARCHAR(100)  NOT NULL CONSTRAINT UQ_users_username UNIQUE,
  password_hash NVARCHAR(255)  NOT NULL, -- 'scryptSalt$scryptHash', hex-encoded
  name          NVARCHAR(200)  NOT NULL,
  role          NVARCHAR(20)   NOT NULL CONSTRAINT CK_users_role CHECK (role IN (N'read_only', N'read_write')),
  is_active     BIT            NOT NULL CONSTRAINT DF_users_is_active DEFAULT 1,
  created_at    DATETIME2(0)   NOT NULL CONSTRAINT DF_users_created_at DEFAULT SYSUTCDATETIME(),
  updated_at    DATETIME2(0)   NOT NULL CONSTRAINT DF_users_updated_at DEFAULT SYSUTCDATETIME()
);
GO

IF OBJECT_ID(N'dbo.sessions', N'U') IS NULL
CREATE TABLE dbo.sessions (
  token      NVARCHAR(128) NOT NULL CONSTRAINT PK_sessions PRIMARY KEY,
  user_id    INT           NOT NULL CONSTRAINT FK_sessions_user REFERENCES dbo.users(id) ON DELETE CASCADE,
  created_at DATETIME2(0)  NOT NULL CONSTRAINT DF_sessions_created_at DEFAULT SYSUTCDATETIME(),
  expires_at DATETIME2(0)  NOT NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_sessions_user' AND object_id = OBJECT_ID(N'dbo.sessions'))
  CREATE INDEX IX_sessions_user ON dbo.sessions(user_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_sessions_expires' AND object_id = OBJECT_ID(N'dbo.sessions'))
  CREATE INDEX IX_sessions_expires ON dbo.sessions(expires_at);
GO

-- ---------------------------------------------------------------------
-- Personal "My Follow-ups" list: each user can bookmark any business request
-- or incident and unbookmark it later. Independent of the SLA-based
-- Follow-up tab, which is computed on the fly and shared by everyone.
-- ---------------------------------------------------------------------
IF OBJECT_ID(N'dbo.business_request_follows', N'U') IS NULL
CREATE TABLE dbo.business_request_follows (
  user_id              INT NOT NULL CONSTRAINT FK_brf_user    REFERENCES dbo.users(id) ON DELETE CASCADE,
  business_request_id  INT NOT NULL CONSTRAINT FK_brf_request REFERENCES dbo.business_requests(id) ON DELETE CASCADE,
  created_at           DATETIME2(0) NOT NULL CONSTRAINT DF_brf_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_business_request_follows PRIMARY KEY (user_id, business_request_id)
);
GO

IF OBJECT_ID(N'dbo.incident_follows', N'U') IS NULL
CREATE TABLE dbo.incident_follows (
  user_id     INT NOT NULL CONSTRAINT FK_incf_user     REFERENCES dbo.users(id) ON DELETE CASCADE,
  incident_id INT NOT NULL CONSTRAINT FK_incf_incident  REFERENCES dbo.incidents(id) ON DELETE CASCADE,
  created_at  DATETIME2(0) NOT NULL CONSTRAINT DF_incf_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_incident_follows PRIMARY KEY (user_id, incident_id)
);
GO
