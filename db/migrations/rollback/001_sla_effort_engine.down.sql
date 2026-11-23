-- Rollback for 001_sla_effort_engine.sql.
-- Removes only objects created by that migration. Legacy tables and the legacy SLA calculation are
-- untouched, so rolling back loses the new per-stage effort history but nothing the old UI uses.
-- Take a backup first if the audit/effort data matters:  BACKUP DATABASE [itrm_tracker] TO DISK = N'...';
-- Run with:  node db/migrate.js down 001     (or paste into SSMS / sqlcmd)

DELETE FROM dbo.sla_settings
 WHERE setting_key IN (N'at_risk_threshold_pct', N'breach_threshold_pct', N'enforce_stage_order', N'auto_start_next_stage', N'priority_factor_mode');
GO

IF OBJECT_ID(N'dbo.request_stage_status_history', N'U') IS NOT NULL DROP TABLE dbo.request_stage_status_history;
IF OBJECT_ID(N'dbo.sla_pause_history', N'U')            IS NOT NULL DROP TABLE dbo.sla_pause_history;
IF OBJECT_ID(N'dbo.sla_effort_tracking', N'U')          IS NOT NULL DROP TABLE dbo.sla_effort_tracking;
IF OBJECT_ID(N'dbo.request_stage_history', N'U')        IS NOT NULL DROP TABLE dbo.request_stage_history;
IF OBJECT_ID(N'dbo.request_stages', N'U')               IS NOT NULL DROP TABLE dbo.request_stages;
GO
