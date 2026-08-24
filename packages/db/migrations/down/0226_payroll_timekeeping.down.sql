DROP TABLE IF EXISTS vibetb.time_off_request_day;
DROP TABLE IF EXISTS vibetb.time_off_request;
DROP TABLE IF EXISTS vibetb.pay_period_employee;
DROP TABLE IF EXISTS vibetb.time_off_ledger;
DROP TABLE IF EXISTS vibetb.pay_period;
DROP TABLE IF EXISTS vibetb.accrual_policy_assignment;
DROP TABLE IF EXISTS vibetb.accrual_policy_tier;
DROP TABLE IF EXISTS vibetb.accrual_policy;
DROP FUNCTION IF EXISTS vibetb.time_off_ledger_block_mutation();
ALTER TABLE vibetb.firm_settings
  DROP CONSTRAINT IF EXISTS firm_settings_payroll_workweek_ck,
  DROP CONSTRAINT IF EXISTS firm_settings_payroll_frequency_ck,
  DROP COLUMN IF EXISTS payroll_enabled,
  DROP COLUMN IF EXISTS payroll_workweek_start_day,
  DROP COLUMN IF EXISTS payroll_period_frequency,
  DROP COLUMN IF EXISTS payroll_period_anchor_date,
  DROP COLUMN IF EXISTS payroll_holiday_default_hours,
  DROP COLUMN IF EXISTS payroll_comp_ot_multiplier;
ALTER TABLE vibetb.app_user
  DROP COLUMN IF EXISTS overtime_exempt,
  DROP COLUMN IF EXISTS is_full_time;
ALTER TABLE vibetb.work_code
  DROP CONSTRAINT IF EXISTS work_code_payroll_category_ck,
  DROP COLUMN IF EXISTS payroll_category;
