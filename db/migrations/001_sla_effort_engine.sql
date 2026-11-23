-- 001: stage-driven, effort-driven SLA engine (SQL Server 2017+).
--
-- Purely additive: no existing table or column is altered, so the legacy SLA calculation
-- (lib/sla.js computeSla) keeps working untouched. Idempotent -- safe to re-run.
-- Applied automatically by db/database.js init() (tracked in dbo.schema_migrations);
-- undo with db/migrations/rollback/001_sla_effort_engine.down.sql.
--
-- Rows reference requests by id (cascade-deleted with the request, like request_comments) but
-- reference stages by NAME, because sla_stages / stages are replaced wholesale by the SLA editor.
-- All *_at columns are UTC. "Days" are working days (weekends from sla_settings excluded).

-- ---------------------------------------------------------------------
-- One row per (request, pipeline stage): the planned effort, the current status and the
-- running SLA aggregates. The aggregates are a cache refreshed on every transition;
-- the segment tables below are the source of truth.
-- ---------------------------------------------------------------------
IF OBJECT_ID(N'dbo.request_stages', N'U') IS NULL
CREATE TABLE dbo.request_stages (
  id                    INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_request_stages PRIMARY KEY,
  business_request_id   INT            NOT NULL CONSTRAINT FK_rs_request REFERENCES dbo.business_requests(id) ON DELETE CASCADE,
  stage_name            NVARCHAR(200)  NOT NULL,
  stage_order           INT            NOT NULL,
  status                NVARCHAR(20)   NOT NULL CONSTRAINT DF_rs_status DEFAULT N'Not Started'
                          CONSTRAINT CK_rs_status CHECK (status IN (N'Not Yet Estimated', N'Not Started', N'In Progress', N'On Hold', N'Completed', N'Cancelled')),
  stage_effort_days     DECIMAL(7,2)   NULL CONSTRAINT CK_rs_effort CHECK (stage_effort_days IS NULL OR stage_effort_days >= 0), -- planned man-days; NULL = not yet estimated
  actual_effort_days    DECIMAL(7,2)   NOT NULL CONSTRAINT DF_rs_actual DEFAULT 0,    -- effort recorded (= consumed unless overridden at completion)
  remaining_effort_days DECIMAL(7,2)   NULL,                                          -- planned - actual, floored at 0
  sla_consumed_days     DECIMAL(7,2)   NOT NULL CONSTRAINT DF_rs_consumed DEFAULT 0,  -- working days spent In Progress (holds excluded)
  total_hold_time       DECIMAL(7,2)   NOT NULL CONSTRAINT DF_rs_hold DEFAULT 0,      -- working days spent On Hold, all hold periods
  started_at            DATETIME2(0)   NULL,   -- first time the stage went In Progress
  completed_at          DATETIME2(0)   NULL,   -- NULL again if the stage is reopened
  paused_at             DATETIME2(0)   NULL,   -- start of the current hold; NULL when not on hold
  resume_at             DATETIME2(0)   NULL,   -- last time the stage resumed after a hold
  reopen_count          INT            NOT NULL CONSTRAINT DF_rs_reopen DEFAULT 0,
  is_backfilled         BIT            NOT NULL CONSTRAINT DF_rs_backfilled DEFAULT 0, -- created from legacy data; no real effort history
  created_at            DATETIME2(0)   NOT NULL CONSTRAINT DF_rs_created_at DEFAULT SYSUTCDATETIME(),
  updated_at            DATETIME2(0)   NOT NULL CONSTRAINT DF_rs_updated_at DEFAULT SYSUTCDATETIME(),
  updated_by            NVARCHAR(255)  NULL,
  CONSTRAINT UQ_rs_request_stage UNIQUE (business_request_id, stage_name)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_rs_request' AND object_id = OBJECT_ID(N'dbo.request_stages'))
  CREATE INDEX IX_rs_request ON dbo.request_stages(business_request_id, stage_order);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_rs_status' AND object_id = OBJECT_ID(N'dbo.request_stages'))
  CREATE INDEX IX_rs_status ON dbo.request_stages(status);
GO

-- ---------------------------------------------------------------------
-- Effort tracking: every stretch of time a stage was In Progress. Work segments + hold periods
-- partition the stage's active life, so multiple pause/resume cycles and reopens just add rows.
-- At most one open segment (ended_at IS NULL) per stage.
-- ---------------------------------------------------------------------
IF OBJECT_ID(N'dbo.sla_effort_tracking', N'U') IS NULL
CREATE TABLE dbo.sla_effort_tracking (
  id                  INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_sla_effort_tracking PRIMARY KEY,
  request_stage_id    INT           NOT NULL CONSTRAINT FK_set_stage REFERENCES dbo.request_stages(id) ON DELETE CASCADE,
  business_request_id INT           NOT NULL,  -- denormalised for per-request reads
  started_at          DATETIME2(0)  NOT NULL,
  ended_at            DATETIME2(0)  NULL,
  end_reason          NVARCHAR(20)  NULL,      -- 'Hold' | 'Completed' | 'Cancelled'
  working_days        DECIMAL(7,2)  NULL,      -- snapshot taken when the segment closed
  created_by          NVARCHAR(255) NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_set_open' AND object_id = OBJECT_ID(N'dbo.sla_effort_tracking'))
  CREATE UNIQUE INDEX UX_set_open ON dbo.sla_effort_tracking(request_stage_id) WHERE ended_at IS NULL;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_set_request' AND object_id = OBJECT_ID(N'dbo.sla_effort_tracking'))
  CREATE INDEX IX_set_request ON dbo.sla_effort_tracking(business_request_id);
GO

-- ---------------------------------------------------------------------
-- Pause history: every hold period is retained (never overwritten).
-- ---------------------------------------------------------------------
IF OBJECT_ID(N'dbo.sla_pause_history', N'U') IS NULL
CREATE TABLE dbo.sla_pause_history (
  id                  INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_sla_pause_history PRIMARY KEY,
  request_stage_id    INT           NOT NULL CONSTRAINT FK_sph_stage REFERENCES dbo.request_stages(id) ON DELETE CASCADE,
  business_request_id INT           NOT NULL,
  paused_at           DATETIME2(0)  NOT NULL,
  resumed_at          DATETIME2(0)  NULL,      -- NULL while the hold is still open
  hold_days           DECIMAL(7,2)  NULL,      -- working days held, filled when the hold closes
  reason              NVARCHAR(500) NULL,
  paused_by           NVARCHAR(255) NULL,
  resumed_by          NVARCHAR(255) NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_sph_open' AND object_id = OBJECT_ID(N'dbo.sla_pause_history'))
  CREATE UNIQUE INDEX UX_sph_open ON dbo.sla_pause_history(request_stage_id) WHERE resumed_at IS NULL;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_sph_request' AND object_id = OBJECT_ID(N'dbo.sla_pause_history'))
  CREATE INDEX IX_sph_request ON dbo.sla_pause_history(business_request_id);
GO

-- ---------------------------------------------------------------------
-- Audit: every status change of every stage (who, when, from, to, effort snapshot).
-- Append-only; the application never updates or deletes these rows.
-- ---------------------------------------------------------------------
IF OBJECT_ID(N'dbo.request_stage_status_history', N'U') IS NULL
CREATE TABLE dbo.request_stage_status_history (
  id                    INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_rssh PRIMARY KEY,
  request_stage_id      INT           NOT NULL CONSTRAINT FK_rssh_stage REFERENCES dbo.request_stages(id) ON DELETE CASCADE,
  business_request_id   INT           NOT NULL,
  stage_name            NVARCHAR(200) NOT NULL,
  from_status           NVARCHAR(20)  NULL,      -- NULL for the initial row
  to_status             NVARCHAR(20)  NOT NULL,
  action                NVARCHAR(20)  NOT NULL,  -- init | estimate | unestimate | start | pause | resume | complete | cancel | reopen | reinstate
  source                NVARCHAR(20)  NOT NULL CONSTRAINT DF_rssh_source DEFAULT N'api', -- api | legacy-sync | migration
  planned_effort_days   DECIMAL(7,2)  NULL,
  consumed_days         DECIMAL(7,2)  NULL,      -- snapshot at the time of the change
  remaining_days        DECIMAL(7,2)  NULL,
  note                  NVARCHAR(500) NULL,
  changed_by            NVARCHAR(255) NULL,
  changed_at            DATETIME2(0)  NOT NULL CONSTRAINT DF_rssh_changed_at DEFAULT SYSUTCDATETIME()
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_rssh_request' AND object_id = OBJECT_ID(N'dbo.request_stage_status_history'))
  CREATE INDEX IX_rssh_request ON dbo.request_stage_status_history(business_request_id, changed_at DESC, id DESC);
GO

-- ---------------------------------------------------------------------
-- Audit: movement of a request between stages (e.g. BA -> Development).
-- ---------------------------------------------------------------------
IF OBJECT_ID(N'dbo.request_stage_history', N'U') IS NULL
CREATE TABLE dbo.request_stage_history (
  id                  INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_rsh PRIMARY KEY,
  business_request_id INT           NOT NULL CONSTRAINT FK_rsh_request REFERENCES dbo.business_requests(id) ON DELETE CASCADE,
  from_stage          NVARCHAR(200) NULL,
  to_stage            NVARCHAR(200) NOT NULL,
  reason              NVARCHAR(30)  NOT NULL,   -- initialized | stage-change
  source              NVARCHAR(20)  NOT NULL CONSTRAINT DF_rsh_source DEFAULT N'api',
  changed_by          NVARCHAR(255) NULL,
  changed_at          DATETIME2(0)  NOT NULL CONSTRAINT DF_rsh_changed_at DEFAULT SYSUTCDATETIME()
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_rsh_request' AND object_id = OBJECT_ID(N'dbo.request_stage_history'))
  CREATE INDEX IX_rsh_request ON dbo.request_stage_history(business_request_id, changed_at DESC, id DESC);
GO

-- ---------------------------------------------------------------------
-- Engine settings (live in sla_settings next to weekend_days; thresholds are percentages of the
-- priority-adjusted stage target). Defaults are inserted only when missing.
--   priority_factor_mode: 'multiplier' -> expected = planned x factor   (legacy semantics, Critical 0.4)
--                         'divisor'    -> expected = planned / factor   (Critical 1.5)
-- The mode is detected from existing data: a stored Critical factor above 1 means "higher = faster".
-- ---------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM dbo.sla_settings WHERE setting_key = N'at_risk_threshold_pct')
  INSERT INTO dbo.sla_settings (setting_key, setting_value) VALUES (N'at_risk_threshold_pct', N'80');
IF NOT EXISTS (SELECT 1 FROM dbo.sla_settings WHERE setting_key = N'breach_threshold_pct')
  INSERT INTO dbo.sla_settings (setting_key, setting_value) VALUES (N'breach_threshold_pct', N'100');
IF NOT EXISTS (SELECT 1 FROM dbo.sla_settings WHERE setting_key = N'enforce_stage_order')
  INSERT INTO dbo.sla_settings (setting_key, setting_value) VALUES (N'enforce_stage_order', N'true');
IF NOT EXISTS (SELECT 1 FROM dbo.sla_settings WHERE setting_key = N'auto_start_next_stage')
  INSERT INTO dbo.sla_settings (setting_key, setting_value) VALUES (N'auto_start_next_stage', N'false');
IF NOT EXISTS (SELECT 1 FROM dbo.sla_settings WHERE setting_key = N'priority_factor_mode')
  INSERT INTO dbo.sla_settings (setting_key, setting_value)
  VALUES (N'priority_factor_mode',
          CASE WHEN EXISTS (SELECT 1 FROM dbo.sla_priorities WHERE LOWER(name) IN (N'critical', N'critcal') AND factor > 1)
               THEN N'divisor' ELSE N'multiplier' END);
GO
