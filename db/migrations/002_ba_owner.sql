IF OBJECT_ID(N'dbo.ba_owners', N'U') IS NULL
CREATE TABLE dbo.ba_owners (
  id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ba_owners PRIMARY KEY,
  name NVARCHAR(200) NOT NULL CONSTRAINT UQ_ba_owners_name UNIQUE
);
GO

IF COL_LENGTH(N'dbo.business_requests', N'ba_owner_id') IS NULL
  ALTER TABLE dbo.business_requests ADD ba_owner_id INT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_br_ba_owner')
  ALTER TABLE dbo.business_requests ADD CONSTRAINT FK_br_ba_owner FOREIGN KEY (ba_owner_id) REFERENCES dbo.ba_owners(id);
GO
